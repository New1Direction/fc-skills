#!/usr/bin/env python3
"""Deterministic, offline analysis of retained normalized swap observations."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re
import sys

RULE_VERSION = "ignition.traction.v1"
MAX_BYTES = 16 * 1024 * 1024
MAX_SWAPS = 50000
MAX_CANDIDATES = 1000
RULES = {
    "maximum_token_age_seconds": 604800,
    "suspected_roundtrip_seconds": 60,
    "minimum_prior_buyers": 3,
    "minimum_current_buyers": 5,
    "minimum_current_buy_events": 5,
    "minimum_buyer_growth": "3/2",
    "minimum_buy_quote_growth": "3/2",
    "maximum_top_buyer_share": "1/2",
    "maximum_buyer_hhi": "1/4",
}


class ValidationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def fields(value, names, where):
    require(isinstance(value, dict), f"{where}: expected object")
    require(set(value) == set(names.split()), f"{where}: unexpected or missing fields")


def string(value, where):
    require(isinstance(value, str) and 0 < len(value) <= 1024 and value.strip() == value,
            f"{where}: expected nonempty bounded string without outer whitespace")
    require(not any(ord(c) < 32 for c in value), f"{where}: control character")
    return value


def strings(value, where, nonempty=False):
    require(isinstance(value, list), f"{where}: expected array")
    for v in value:
        string(v, where)
    require(len(value) == len(set(value)), f"{where}: duplicate entries")
    require(not nonempty or bool(value), f"{where}: evidence or entries required")
    return value


def stamp(value, where):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value),
            f"{where}: expected UTC timestamp YYYY-MM-DDTHH:MM:SSZ")
    try:
        return int(datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except ValueError as exc:
        raise ValidationError(f"{where}: invalid timestamp") from exc


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def amount(value, decimals):
    require(isinstance(value, str) and len(value) <= 128 and
            re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value),
            "quote_amount: expected unsigned fixed-point decimal string")
    whole, _, fraction = value.partition(".")
    require(len(fraction) <= decimals, "quote_amount: exceeds quote_decimals")
    units = int(whole) * 10 ** decimals + int((fraction + "0" * decimals)[:decimals] or "0")
    require(units > 0, "quote_amount: must be positive")
    return units


def decimal(units, decimals):
    sign = "-" if units < 0 else ""
    units = abs(units)
    if not decimals:
        return sign + str(units)
    whole, part = divmod(units, 10 ** decimals)
    tail = str(part).zfill(decimals).rstrip("0")
    return sign + str(whole) + ("." + tail if tail else "")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_input(path):
    with open(path, "rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "input exceeds 16 MiB")
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=lambda v: (_ for _ in ()).throw(ValidationError(f"invalid JSON number {v}")))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValidationError("invalid strict UTF-8 JSON") from exc
    return data, hashlib.sha256(raw).hexdigest()


def validate(data):
    fields(data, "schema_version source_kind window_start window_end cutoff covered_venues candidates swaps suspected_bots supplied_clusters", "input")
    require(data["schema_version"] == "ignition.observations.v1", "unsupported input schema")
    require(data["source_kind"] in ("observed", "synthetic", "unknown"), "invalid source_kind")
    start, end, cutoff = (stamp(data[key], key) for key in ("window_start", "window_end", "cutoff"))
    require(end > start and (end - start) % 2 == 0, "lookback must contain two equal positive whole-second windows")
    require(cutoff >= end, "decision cutoff must be at or after observation window_end")
    venues = set(strings(data["covered_venues"], "covered_venues", True))
    require(isinstance(data["candidates"], list) and 0 < len(data["candidates"]) <= MAX_CANDIDATES, "candidate count must be 1..1000")
    candidates, identities, quote_decimals = {}, set(), {}
    for row in data["candidates"]:
        fields(row, "candidate_id chain_id token_id quote_unit quote_decimals created_at creation_available_at creation_evidence_refs coverage", "candidate")
        for key in ("candidate_id", "chain_id", "token_id", "quote_unit"):
            string(row[key], key)
        cid = row["candidate_id"]
        identity = (row["chain_id"], row["token_id"], row["quote_unit"])
        require(cid not in candidates and identity not in identities, "duplicate candidate or exact market identity")
        d = row["quote_decimals"]
        require(type(d) is int and 0 <= d <= 36, "quote_decimals must be integer 0..36")
        require(row["quote_unit"] not in quote_decimals or quote_decimals[row["quote_unit"]] == d,
                "conflicting decimal metadata for quote_unit")
        quote_decimals[row["quote_unit"]] = d
        strings(row["creation_evidence_refs"], "creation_evidence_refs", row["created_at"] is not None)
        if row["created_at"] is not None:
            ct = stamp(row["created_at"], "created_at")
            require(ct <= stamp(row["creation_available_at"], "creation_available_at") <= cutoff, "creation evidence unavailable at cutoff or precedes creation")
        else:
            require(row["creation_available_at"] is None, "unknown creation requires null creation_available_at")
        cov = row["coverage"]
        fields(cov, "status window_start window_end venue_ids gaps evidence_refs available_at", "coverage")
        ca = stamp(cov["available_at"], "coverage.available_at")
        require(ca <= cutoff, "coverage evidence unavailable at cutoff")
        require(cov["status"] in ("complete", "partial", "unknown"), "invalid coverage status")
        cs, ce = stamp(cov["window_start"], "coverage.window_start"), stamp(cov["window_end"], "coverage.window_end")
        require(ce > cs, "coverage must have positive duration")
        require(cov["status"] != "complete" or ce <= ca, "complete coverage evidence predates covered interval end")
        cv = set(strings(cov["venue_ids"], "coverage.venue_ids"))
        require(cv <= venues, "candidate coverage references undeclared venue")
        strings(cov["gaps"], "coverage.gaps")
        strings(cov["evidence_refs"], "coverage.evidence_refs", cov["status"] == "complete")
        require(cov["status"] != "complete" or (not cov["gaps"] and bool(cv)), "complete coverage conflicts with gaps or empty venue scope")
        candidates[cid] = row
        identities.add(identity)
    # Creation time is token metadata even when several quote markets are retained.
    creation = {}
    for row in candidates.values():
        key = (row["chain_id"], row["token_id"])
        meta = (row["created_at"], row["creation_available_at"])
        require(key not in creation or creation[key] == meta, "conflicting token creation metadata")
        creation[key] = meta
    for key in ("swaps", "suspected_bots", "supplied_clusters"):
        require(isinstance(data[key], list), f"{key}: expected array")
    require(len(data["swaps"]) <= MAX_SWAPS, "swap count exceeds 50000")
    bots, clusters, cluster_ids = set(), {}, set()
    chains = {c["chain_id"] for c in candidates.values()}
    for row in data["suspected_bots"]:
        fields(row, "chain_id wallet_id reason evidence_refs available_at", "suspected_bot")
        require(stamp(row["available_at"], "bot.available_at") <= cutoff, "bot label unavailable at cutoff")
        for key in ("chain_id", "wallet_id", "reason"):
            string(row[key], key)
        strings(row["evidence_refs"], "bot.evidence_refs", True)
        key = (row["chain_id"], row["wallet_id"])
        require(row["chain_id"] in chains and key not in bots, "unknown chain or duplicate bot label")
        bots.add(key)
    for row in data["supplied_clusters"]:
        fields(row, "cluster_id chain_id wallet_ids basis evidence_refs available_at", "cluster")
        require(stamp(row["available_at"], "cluster.available_at") <= cutoff, "cluster label unavailable at cutoff")
        for key in ("cluster_id", "chain_id", "basis"):
            string(row[key], key)
        require(row["cluster_id"] not in cluster_ids and row["chain_id"] in chains, "duplicate cluster or unknown chain")
        require(row["basis"] in ("claimed_common_control", "behavioral_similarity", "shared_infrastructure_funding", "unknown"), "invalid cluster basis")
        strings(row["evidence_refs"], "cluster.evidence_refs", True)
        strings(row["wallet_ids"], "cluster.wallet_ids", True)
        require(len(row["wallet_ids"]) >= 2, "cluster requires at least two wallets")
        cluster_ids.add(row["cluster_id"])
        for wallet in row["wallet_ids"]:
            key = (row["chain_id"], wallet)
            require(key not in clusters, "wallet belongs to conflicting supplied clusters")
            clusters[key] = row["cluster_id"]
    seen, rows, previous_time, transaction_times = set(), defaultdict(list), None, {}
    for row in data["swaps"]:
        fields(row, "candidate_id venue_id tx_id log_index wallet_id side quote_amount event_time available_at evidence_refs", "swap")
        for key in ("candidate_id", "venue_id", "tx_id", "wallet_id"):
            string(row[key], key)
        require(row["candidate_id"] in candidates, "swap references unknown candidate")
        candidate = candidates[row["candidate_id"]]
        require(row["venue_id"] in candidate["coverage"]["venue_ids"], "swap outside candidate venue scope")
        require(type(row["log_index"]) is int and 0 <= row["log_index"] <= 2147483647, "invalid log_index")
        ident = (candidate["chain_id"], row["tx_id"], row["log_index"])
        require(ident not in seen, "duplicate or conflicting venue/transaction/log observation")
        seen.add(ident)
        require(row["side"] in ("buy", "sell"), "invalid swap side")
        event, available = stamp(row["event_time"], "event_time"), stamp(row["available_at"], "available_at")
        tx = (candidate["chain_id"], row["tx_id"])
        require(tx not in transaction_times or transaction_times[tx] == event, "conflicting event_time for one transaction")
        transaction_times[tx] = event
        require(available >= event, "available_at precedes event_time")
        require(candidate["created_at"] is None or event >= stamp(candidate["created_at"], "created_at"), "swap event precedes token creation")
        require(previous_time is None or event >= previous_time, "swaps must be ordered by event_time")
        previous_time = event
        strings(row["evidence_refs"], "swap.evidence_refs", True)
        units = amount(row["quote_amount"], candidate["quote_decimals"])
        rows[row["candidate_id"]].append(dict(row, _event=event, _available=available, _units=units))
    return start, end, cutoff, candidates, rows, bots, clusters


def metrics(rows, decimals, grouping):
    buys, sellers = defaultdict(int), set()
    buy_count = sell_count = sold = 0
    for row in rows:
        group = grouping(row["wallet_id"])
        if row["side"] == "buy":
            buys[group] += row["_units"]
            buy_count += 1
        else:
            sellers.add(group)
            sold += row["_units"]
            sell_count += 1
    spent = sum(buys.values())
    return {
        "buyer_count": len(buys), "seller_count": len(sellers),
        "buy_event_count": buy_count, "sell_event_count": sell_count,
        "buy_quote": decimal(spent, decimals), "sell_quote": decimal(sold, decimals),
        "buy_minus_sell_quote": decimal(spent - sold, decimals),
        "top_buyer_share": str(Fraction(max(buys.values()), spent)) if spent else None,
        "buyer_hhi": str(Fraction(sum(v * v for v in buys.values()), spent * spent)) if spent else None,
    }


def roundtrip_wallets(rows):
    last, roundtrips = {}, set()
    for row in rows:
        wallet, side = row["wallet_id"], row["side"]
        other = last.get((wallet, "sell" if side == "buy" else "buy"))
        if other is not None and row["_event"] - other <= RULES["suspected_roundtrip_seconds"]:
            roundtrips.add(wallet)
        last[(wallet, side)] = row["_event"]
    return roundtrips


def window_metrics(rows, candidate, bots, clusters, suspected_roundtrips):
    chain, d = candidate["chain_id"], candidate["quote_decimals"]
    roundtrips = suspected_roundtrips & {r["wallet_id"] for r in rows}
    bot_wallets = {r["wallet_id"] for r in rows if (chain, r["wallet_id"]) in bots}
    excluded = bot_wallets | roundtrips
    eligible = [r for r in rows if r["wallet_id"] not in excluded]
    grouping = lambda w: ("cluster", clusters[(chain, w)]) if (chain, w) in clusters else ("wallet", w)
    by_mode = lambda rs: {"strict_wallets": metrics(rs, d, lambda w: w),
                          "supplied_cluster_sensitivity": metrics(rs, d, grouping)}
    buyers = {r["wallet_id"] for r in rows if r["side"] == "buy"}
    return {
        "raw": by_mode(rows), "eligible": by_mode(eligible),
        "exclusions": {
            "denominator_events": len(rows), "denominator_wallets": len({r["wallet_id"] for r in rows}),
            "denominator_buyer_wallets": len(buyers), "suspected_bot_wallets": sorted(bot_wallets),
            "suspected_roundtrip_wallets": sorted(roundtrips), "union_wallet_count": len(excluded),
            "union_event_count": len(rows) - len(eligible), "union_buyer_wallet_count": len(buyers & excluded),
            "excluded_buy_quote": decimal(sum(r["_units"] for r in rows if r["side"] == "buy" and r["wallet_id"] in excluded), d),
        },
    }


def comparison(prior, current):
    p, c = prior["buyer_count"], current["buyer_count"]
    spend_p, spend_c = Fraction(prior["buy_quote"]), Fraction(current["buy_quote"])
    buyer_growth = Fraction(c, p) if p else None
    quote_growth = spend_c / spend_p if spend_p else None
    checks = {
        "minimum_sample": p >= RULES["minimum_prior_buyers"] and c >= RULES["minimum_current_buyers"] and current["buy_event_count"] >= RULES["minimum_current_buy_events"],
        "buyer_breadth_accelerating": buyer_growth is not None and buyer_growth >= Fraction(RULES["minimum_buyer_growth"]),
        "buy_quote_accelerating": quote_growth is not None and quote_growth >= Fraction(RULES["minimum_buy_quote_growth"]),
        "concentration_within_rule": current["top_buyer_share"] is not None and Fraction(current["top_buyer_share"]) <= Fraction(RULES["maximum_top_buyer_share"]) and Fraction(current["buyer_hhi"]) <= Fraction(RULES["maximum_buyer_hhi"]),
    }
    return {"buyer_growth": str(buyer_growth) if buyer_growth is not None else None,
            "buy_quote_growth": str(quote_growth) if quote_growth is not None else None,
            "checks": checks, "passes_rule": all(checks.values())}


def analyze(data, input_sha256):
    require(isinstance(input_sha256, str) and re.fullmatch(r"[0-9a-f]{64}", input_sha256), "invalid input_sha256")
    start, end, cutoff, candidates, observations, bots, clusters = validate(data)
    midpoint = (start + end) // 2
    report = {
        "schema_version": "ignition.report.v1", "rule_version": RULE_VERSION,
        "source_kind": data["source_kind"], "input_sha256": input_sha256,
        "window_start": data["window_start"], "window_end": data["window_end"], "midpoint": iso(midpoint), "cutoff": data["cutoff"],
        "rules": RULES, "covered_venues": data["covered_venues"],
        "cohort_evidence": {"suspected_bots": data["suspected_bots"], "supplied_clusters": data["supplied_clusters"]},
        "limitations": [
            "Retained normalized observations are not independently decoded or authenticated.",
            "Coverage is supplied for named venues only; this is not live or all-chain coverage.",
            "Buyer counts measure supplied canonical wallet IDs, not authenticated chain addresses or verified owners.",
            "Supplied clusters are sensitivity hypotheses; chain-specific canonicalization is required upstream.",
            "Shared infrastructure funding does not establish owner identity; absent labels do not establish bot-free activity.",
            "Quote spend and buy-minus-sell quote are swap flow, not net external capital or profit.",
            "Rapid opposite-side activity is a suspected-roundtrip heuristic, not proof of closed inventory.",
            "Suspect classifications use evidence available at report cutoff across the lookback, not previously emitted alerts.",
            "Current inventory, matured retention, holder growth and benchmark repricing are unknown and not computed.",
            "Flags are deterministic review heuristics, not profit probabilities or trading recommendations.",
            "Evidence and cohort label availability are supplied assertions as of cutoff; this engine cannot verify them.",
        ], "candidates": [],
    }
    for cid, candidate in candidates.items():
        rows = observations[cid]
        in_interval = [r for r in rows if start <= r["_event"] < end]
        usable = [r for r in in_interval if r["_available"] <= cutoff]
        before, after = [r for r in usable if r["_event"] < midpoint], [r for r in usable if r["_event"] >= midpoint]
        suspected_roundtrips = roundtrip_wallets(usable)
        prior = window_metrics(before, candidate, bots, clusters, suspected_roundtrips)
        current = window_metrics(after, candidate, bots, clusters, suspected_roundtrips)
        comparisons = {mode: comparison(prior["eligible"][mode], current["eligible"][mode])
                       for mode in ("strict_wallets", "supplied_cluster_sensitivity")}
        cov, reasons = candidate["coverage"], []
        if data["source_kind"] == "unknown":
            reasons.append("observation_source_unknown")
        if cov["status"] != "complete":
            reasons.append("coverage_" + cov["status"])
        if cov["gaps"]:
            reasons.append("declared_coverage_gaps")
        if stamp(cov["window_start"], "coverage.window_start") > start or stamp(cov["window_end"], "coverage.window_end") < end:
            reasons.append("coverage_does_not_span_lookback")
        if len(usable) != len(in_interval):
            reasons.append("observations_not_available_at_cutoff")
        created = stamp(candidate["created_at"], "created_at") if candidate["created_at"] else None
        if created is None:
            reasons.append("token_age_unknown")
        elif created > start:
            reasons.append("token_did_not_exist_for_full_lookback")
        strict = comparisons["strict_wallets"]
        if not strict["checks"]["minimum_sample"]:
            reasons.append("minimum_buyer_sample_not_met")
        age = cutoff - created if created is not None else None
        state = ("insufficient_data" if reasons else "outside_early_window" if age > RULES["maximum_token_age_seconds"]
                 else "heuristic_candidate" if strict["passes_rule"] else "no_acceleration")
        flags = [key for key, value in strict["checks"].items() if value and key != "minimum_sample"]
        if strict["passes_rule"] != comparisons["supplied_cluster_sensitivity"]["passes_rule"]:
            flags.append("supplied_cluster_sensitive")
        report["candidates"].append({
            **{k: candidate[k] for k in ("candidate_id", "chain_id", "token_id", "quote_unit", "quote_decimals", "created_at", "creation_available_at", "creation_evidence_refs", "coverage")},
            "token_age_seconds": age, "state": state, "insufficient_data_reasons": reasons, "flags": flags,
            "windows": {"prior": prior, "current": current}, "comparison": comparisons,
            "observation_counts": {"retained": len(rows), "outside_lookback": len(rows) - len(in_interval),
                                   "unavailable_at_cutoff": len(in_interval) - len(usable), "used": len(usable)},
            "provenance": {"kind": "retained_normalized_observations", "authentication": "not_performed",
                           "evidence_refs": sorted({ref for r in rows for ref in r["evidence_refs"]})},
            "persistence": {"state": "unknown", "reason": "No matured balance observations are accepted by this schema."},
        })
    return report


def write_report(path, report):
    payload = (json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    # O_EXCL also rejects existing symlinks. Never truncate an existing artifact.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        data, digest = load_input(args.input)
        report = analyze(data, digest)
        write_report(args.output, report)
    except (OSError, ValidationError, ValueError) as exc:
        print(f"ignition: {exc}", file=sys.stderr)
        return 2
    print(f"Wrote {args.output}: {len(report['candidates'])} candidates; source_kind={report['source_kind']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
