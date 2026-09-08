#!/usr/bin/env python3
"""Bounded, exact, point-in-time evaluation of normalized scout cases. Files only."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import sys

MAX_BYTES = 8_000_000
MAX_CASES = 10_000
KINDS = {"observed", "synthetic", "unknown"}
DEFAULTS = {"origin": "engineering_default_uncalibrated", "min_evaluated_cases": 3,
            "min_distinct_tokens": 3, "max_unresolved_fraction": "0",
            "max_token_concentration_fraction": "0.5"}


class Invalid(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Invalid(message)


def obj(value, keys, where):
    require(isinstance(value, dict) and set(value) == set(keys.split()),
            f"{where}: expected exactly {keys}")
    return value


def string(value, where):
    require(isinstance(value, str) and 0 < len(value) <= 2048, f"{where}: nonempty string required")
    return value


def integer(value, where, low=0, high=MAX_CASES):
    require(type(value) is int and low <= value <= high, f"{where}: integer out of bounds")
    return value


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value),
            "timestamps must be whole-second UTC YYYY-MM-DDTHH:MM:SSZ")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise Invalid("invalid timestamp") from exc


def amount(value, where):
    require(isinstance(value, str) and len(value) <= 100 and
            re.fullmatch(r"(?:0|[1-9]\d*)(?:\.\d+)?", value), f"{where}: nonnegative decimal string required")
    return Fraction(Decimal(value))


def ratio(value):
    return {"numerator": str(value.numerator), "denominator": str(value.denominator)}


def refs(value):
    require(isinstance(value, list) and len(value) <= 50, "source_refs: expected at most 50 strings")
    for ref in value:
        string(ref, "source reference")


def evidence(value):
    event, available = timestamp(value["event_at"]), timestamp(value["available_at"])
    require(available >= event, "availability cannot precede event")
    refs(value["source_refs"])
    return event, available


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_bytes(raw):
    require(len(raw) <= MAX_BYTES, "input exceeds byte limit")
    def reject_number(value):
        raise Invalid("noninteger JSON numbers are forbidden; use decimal strings")
    try:
        return json.loads(raw, object_pairs_hook=unique_pairs,
                          parse_float=reject_number, parse_constant=reject_number)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Invalid(f"invalid strict JSON: {exc}") from exc


def validate(data):
    obj(data, "schema_version decision_cutoff source_kind cohort scenario wallets cases", "input")
    require(type(data["schema_version"]) is int and data["schema_version"] == 1, "unsupported schema")
    require(data["source_kind"] in KINDS, "invalid source kind")
    cutoff = timestamp(data["decision_cutoff"])
    cohort = obj(data["cohort"], "rule frozen_at available_at window_start window_end coverage_status coverage_available_at expected_case_count exclusions source_refs", "cohort")
    for key in ("frozen_at", "available_at", "window_start", "window_end", "coverage_available_at"):
        timestamp(cohort[key])
    require(timestamp(cohort["frozen_at"]) <= timestamp(cohort["available_at"]), "cohort availability before freeze")
    require(timestamp(cohort["window_start"]) <= timestamp(cohort["window_end"]) <= cutoff, "invalid observation window")
    require(timestamp(cohort["coverage_available_at"]) >= timestamp(cohort["window_end"]), "final coverage cannot precede window end")
    string(cohort["rule"], "cohort.rule")
    refs(cohort["source_refs"])
    require(cohort["coverage_status"] in {"complete", "partial", "unknown"}, "invalid coverage_status")
    if cohort["expected_case_count"] is not None:
        integer(cohort["expected_case_count"], "expected_case_count")
    require(isinstance(cohort["exclusions"], list) and len(cohort["exclusions"]) <= 100, "invalid exclusions")
    for exclusion in cohort["exclusions"]:
        obj(exclusion, "reason count source_refs", "exclusion")
        string(exclusion["reason"], "exclusion.reason")
        integer(exclusion["count"], "exclusion.count")
        refs(exclusion["source_refs"])
    scenario = obj(data["scenario"], "currency follower_delay_seconds entry_budget hold_seconds max_execution_lag_seconds execution_mode thresholds", "scenario")
    string(scenario["currency"], "currency")
    require(amount(scenario["entry_budget"], "entry_budget") > 0, "entry budget must be positive")
    for key in ("follower_delay_seconds", "hold_seconds", "max_execution_lag_seconds"):
        integer(scenario[key], key, 0, 31_536_000)
    require(scenario["execution_mode"] in {"executed", "simulated"}, "invalid execution_mode")
    gates = DEFAULTS if scenario["thresholds"] is None else obj(scenario["thresholds"], "origin min_evaluated_cases min_distinct_tokens max_unresolved_fraction max_token_concentration_fraction", "thresholds")
    require(gates["origin"] in {"user_explicit", "engineering_default_uncalibrated"}, "invalid threshold origin")
    integer(gates["min_evaluated_cases"], "min_evaluated_cases", 1)
    integer(gates["min_distinct_tokens"], "min_distinct_tokens", 1)
    for key in ("max_unresolved_fraction", "max_token_concentration_fraction"):
        require(amount(gates[key], key) <= 1, "threshold fraction must be <= 1")
    require(isinstance(data["wallets"], list) and 0 < len(data["wallets"]) <= 200, "1..200 wallets required")
    wallet_ids = set()
    for wallet in data["wallets"]:
        obj(wallet, "id selected_at selection_available_at selection_rule source_refs relation_group relation_available_at relation_source_refs", "wallet")
        string(wallet["id"], "wallet id")
        require(wallet["id"] not in wallet_ids, "duplicate wallet id")
        wallet_ids.add(wallet["id"])
        require(timestamp(wallet["selected_at"]) <= timestamp(wallet["selection_available_at"]), "selection availability before selection")
        string(wallet["selection_rule"], "selection rule")
        refs(wallet["source_refs"])
        refs(wallet["relation_source_refs"])
        if wallet["relation_group"] is None:
            require(wallet["relation_available_at"] is None, "unknown relationship needs null availability")
        else:
            string(wallet["relation_group"], "relation_group")
            timestamp(wallet["relation_available_at"])
    require(isinstance(data["cases"], list) and len(data["cases"]) <= MAX_CASES, "too many cases")
    ids, discoveries = set(), set()
    for case in data["cases"]:
        obj(case, "id wallet_id chain token source_kind discovery access entry exit", "case")
        for key in ("id", "wallet_id", "chain", "token"):
            string(case[key], key)
        require(case["id"] not in ids, "duplicate case id")
        ids.add(case["id"])
        require(case["wallet_id"] in wallet_ids, "case references unknown wallet")
        require(case["source_kind"] in KINDS, "invalid case source_kind")
        require(data["source_kind"] != "observed" or case["source_kind"] == "observed", "observed input contains non-observed case")
        obj(case["discovery"], "event_at available_at source_refs", "discovery")
        evidence(case["discovery"])
        discovery_key = (case["wallet_id"], case["chain"], case["token"])
        require(discovery_key not in discoveries, "one discovery per wallet/chain/token required")
        discoveries.add(discovery_key)
        obj(case["access"], "kind event_at available_at source_refs", "access")
        evidence(case["access"])
        require(case["access"]["kind"] in {"ordinary_buy", "privileged_allocation", "insider", "unknown"}, "invalid access kind")
        for side in ("entry", "exit"):
            fill = case[side]
            if fill is None:
                continue
            obj(fill, "status event_at available_at source_refs evidence_kind currency quote_amount token_quantity fees assumptions", side)
            evidence(fill)
            require(fill["status"] in {"filled", "failed", "unknown"}, "invalid fill status")
            require(fill["evidence_kind"] in {"executed", "simulated", "quote", "unknown"}, "invalid execution evidence")
            string(fill["currency"], "fill currency")
            require(fill["currency"] == scenario["currency"], "currency mismatch; supply separate evaluation")
            for key in ("quote_amount", "token_quantity", "fees"):
                if fill[key] is not None:
                    amount(fill[key], key)
            string(fill["assumptions"], "fill assumptions")
    return cutoff, gates


def evaluate(data, input_hash="not_provided"):
    cutoff, gates = validate(data)
    scenario, cohort = data["scenario"], data["cohort"]
    start, end = timestamp(cohort["window_start"]), timestamp(cohort["window_end"])
    delay = timedelta(seconds=scenario["follower_delay_seconds"])
    hold = timedelta(seconds=scenario["hold_seconds"])
    lag = timedelta(seconds=scenario["max_execution_lag_seconds"])
    budget = amount(scenario["entry_budget"], "budget")
    rows, grouped, excluded = [], defaultdict(list), Counter()
    for case in sorted(data["cases"], key=lambda c: c["id"]):
        d_event, d_available = evidence(case["discovery"])
        row = {"id": case["id"], "wallet_id": case["wallet_id"], "chain": case["chain"],
               "token": case["token"], "source_kind": case["source_kind"], "evidence": case,
               "status": None, "net": None, "return_fraction": None}
        rows.append(row)
        if not start <= d_event <= end or d_available > cutoff:
            row["status"] = "outside_window" if not start <= d_event <= end else "discovery_unavailable_at_cutoff"
            excluded[row["status"]] += 1
            continue
        grouped[case["wallet_id"]].append(row)
        access = case["access"]
        status = None
        if not case["discovery"]["source_refs"]:
            status = "missing_discovery_evidence"
        elif data["source_kind"] == "unknown" or case["source_kind"] == "unknown":
            status = "unknown_provenance"
        elif timestamp(access["available_at"]) > cutoff or access["kind"] == "unknown" or not access["source_refs"]:
            status = "unknown_access"
        elif access["kind"] != "ordinary_buy":
            status = "unfollowable_" + access["kind"]
        target_entry = d_available + delay
        if status is None and target_entry + lag + hold + lag > cutoff:
            status = "immature"
        entry, sell = case["entry"], case["exit"]
        for side, fill in (("entry", entry), ("exit", sell)):
            if status is not None:
                break
            if fill is None:
                status = "missing_" + side
            elif timestamp(fill["available_at"]) > cutoff:
                status = side + "_unavailable_at_cutoff"
            elif fill["status"] != "filled":
                status = fill["status"] + "_" + side
            elif fill["evidence_kind"] != scenario["execution_mode"]:
                status = "unsupported_" + side + "_evidence"
            elif not fill["source_refs"]:
                status = "missing_" + side + "_evidence"
            elif any(fill[k] is None for k in ("quote_amount", "token_quantity", "fees")):
                status = "unknown_" + side + "_amount_or_cost"
        if status is None:
            entry_time, exit_time = timestamp(entry["event_at"]), timestamp(sell["event_at"])
            if not target_entry <= entry_time <= target_entry + lag:
                status = "entry_outside_scenario"
            elif not entry_time + hold <= exit_time <= entry_time + hold + lag:
                status = "exit_outside_scenario"
            elif amount(entry["quote_amount"], "entry") != budget:
                status = "entry_size_mismatch"
            elif amount(entry["token_quantity"], "quantity") <= 0:
                status = "invalid_entry_quantity"
            elif amount(entry["token_quantity"], "quantity") != amount(sell["token_quantity"], "quantity"):
                status = "incomplete_or_mismatched_exit"
            else:
                spent = budget + amount(entry["fees"], "entry fees")
                received = amount(sell["quote_amount"], "exit") - amount(sell["fees"], "exit fees")
                row["_spent"], row["_net"] = spent, received - spent
                row["net"] = ratio(received - spent)
                row["return_fraction"] = ratio((received - spent) / spent)
                status = "evaluated"
        row["status"] = status
    visible_count = sum(len(v) for v in grouped.values())
    coverage_reasons = []
    if cohort["coverage_status"] != "complete":
        coverage_reasons.append("cohort_coverage_not_complete")
    if timestamp(cohort["coverage_available_at"]) > cutoff:
        coverage_reasons.append("cohort_coverage_unavailable_at_cutoff")
    if cohort["expected_case_count"] != visible_count:
        coverage_reasons.append("cohort_count_unknown_or_mismatch")
    if any(e["count"] for e in cohort["exclusions"]):
        coverage_reasons.append("cohort_has_omitted_cases")
    if timestamp(cohort["frozen_at"]) > start or timestamp(cohort["available_at"]) > start:
        coverage_reasons.append("cohort_not_frozen_before_window_or_unavailable")
    if not cohort["source_refs"]:
        coverage_reasons.append("cohort_evidence_missing")
    summaries, eligible = [], []
    for wallet in sorted(data["wallets"], key=lambda w: w["id"]):
        cases = grouped[wallet["id"]]
        good = [c for c in cases if c["status"] == "evaluated"]
        counts = Counter(c["status"] for c in cases)
        tokens = Counter((c["chain"], c["token"]) for c in good)
        unresolved = Fraction(len(cases) - len(good), len(cases)) if cases else Fraction(1)
        concentration = Fraction(max(tokens.values()), len(good)) if good else None
        positives = [c["_net"] for c in good if c["_net"] > 0]
        profit_concentration = max(positives) / sum(positives) if positives else None
        reasons = list(coverage_reasons)
        if timestamp(wallet["selected_at"]) > start or timestamp(wallet["selection_available_at"]) > start:
            reasons.append("wallet_selected_after_window_start_or_unavailable")
        if not wallet["source_refs"]:
            reasons.append("wallet_selection_evidence_missing")
        if len(good) < gates["min_evaluated_cases"]:
            reasons.append("insufficient_evaluated_cases")
        if len(tokens) < gates["min_distinct_tokens"]:
            reasons.append("insufficient_distinct_tokens")
        if unresolved > amount(gates["max_unresolved_fraction"], "gate"):
            reasons.append("too_many_unresolved_or_unfollowable_cases")
        if concentration is not None and concentration > amount(gates["max_token_concentration_fraction"], "gate"):
            reasons.append("token_concentration_above_gate")
        if profit_concentration is not None and profit_concentration > amount(gates["max_token_concentration_fraction"], "gate"):
            reasons.append("positive_profit_concentration_above_gate")
        net = sum((c["_net"] for c in good), Fraction(0))
        spent = sum((c["_spent"] for c in good), Fraction(0))
        returns = sorted(c["_net"] / c["_spent"] for c in good)
        median = (returns[(len(returns)-1)//2] + returns[len(returns)//2])/2 if returns else None
        relation_known = wallet["relation_group"] is not None and timestamp(wallet["relation_available_at"]) <= cutoff and bool(wallet["relation_source_refs"])
        summary = {"wallet_id": wallet["id"], "selection_and_relationship_evidence": wallet,
                   "relation_group_as_of_cutoff": wallet["relation_group"] if relation_known else None,
                   "visible_picks": len(cases), "evaluated_cases": len(good), "status_counts": dict(sorted(counts.items())),
                   "unresolved_or_unfollowable_fraction": ratio(unresolved), "distinct_evaluated_tokens": len(tokens),
                   "largest_token_fraction": ratio(concentration) if concentration is not None else None,
                   "largest_positive_profit_fraction": ratio(profit_concentration) if profit_concentration is not None else None,
                   "profit_count": sum(c["_net"] > 0 for c in good), "loss_count": sum(c["_net"] < 0 for c in good),
                   "flat_count": sum(c["_net"] == 0 for c in good),
                   "completed_cases_net": ratio(net) if good else None, "completed_cases_spent": ratio(spent) if good else None,
                   "completed_cases_return_fraction": ratio(net/spent) if good else None,
                   "median_return_fraction": ratio(median) if median is not None else None,
                   "ranking_eligible": not reasons, "gate_failures": reasons, "rank": None}
        summaries.append(summary)
        if not reasons:
            eligible.append((net/spent, wallet["id"], summary))
    for rank, (_, _, summary) in enumerate(sorted(eligible, key=lambda x: (-x[0], x[1])), 1):
        summary["rank"] = rank
    token_sets = {w["id"]: {(c["chain"], c["token"]) for c in grouped[w["id"]]} for w in data["wallets"]}
    overlap = []
    wallet_ids = sorted(token_sets)
    for i, a in enumerate(wallet_ids):
        for b in wallet_ids[i+1:]:
            common = token_sets[a] & token_sets[b]
            if common:
                overlap.append({"wallet_a": a, "wallet_b": b, "shared_token_count": len(common),
                                "union_token_count": len(token_sets[a] | token_sets[b])})
    for row in rows:
        row.pop("_spent", None)
        row.pop("_net", None)
    known_groups = {w["relation_group_as_of_cutoff"] for w in summaries if w["relation_group_as_of_cutoff"] is not None}
    return {"schema_version": 1, "evaluator_version": "1.0.0", "input_sha256": input_hash,
            "decision_cutoff": data["decision_cutoff"], "source_kind": data["source_kind"], "cohort": cohort,
            "scenario": scenario, "effective_thresholds": gates,
            "result_kind": "realized_executed_follow_scenario" if scenario["execution_mode"] == "executed" else "hypothetical_simulated_follow_scenario",
            "coverage": {"supplied_cases": len(rows), "visible_picks": visible_count, "excluded_from_point_in_time_denominator": dict(sorted(excluded.items())), "ranking_gate_failures": coverage_reasons},
            "wallets": summaries, "cases": rows, "overlap": overlap,
            "dependence": {"declared_known_groups": len(known_groups), "wallets_with_unknown_relationships": sum(w["relation_group_as_of_cutoff"] is None for w in summaries),
                           "independent_confirmation_count": None},
            "limitations": ["Source references do not authenticate inputs or verify normalization, cohort completeness, relationship assertions, or executable simulation assumptions.",
                            "Ranks describe completed-case returns within the frozen supplied cohort and scenario; no probability of future success or calibrated confidence is estimated.",
                            "Scenario and threshold predeclaration is a workflow requirement; this helper does not verify when those choices were made.",
                            "Related wallets and overlapping tokens are dependent evidence; group counts are not independently verified confirmations.",
                            "Excluded future/unavailable records do not affect point-in-time wallet scores; unresolved visible picks stay in denominators.",
                            "Net totals cover completed cases only, excluding unresolved cases and failed-attempt costs; default gates prohibit ranking with any such cases.",
                            "Fixed-horizon full-position exits only; partial exits, unknown costs, quotes, and balance changes do not produce PnL."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        with args.input.open("rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
        result = evaluate(parse_bytes(raw), hashlib.sha256(raw).hexdigest())
        serialized = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n"
        with args.output.open("x", encoding="utf-8") as handle:
            handle.write(serialized)
    except (Invalid, OSError, OverflowError, TypeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"Wrote {args.output}; {sum(w['ranking_eligible'] for w in result['wallets'])} eligible wallets; {result['source_kind']} inputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
