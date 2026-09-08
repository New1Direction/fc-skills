#!/usr/bin/env python3
"""Deterministic analysis of supplied Robinhood Chain swap observations.

No RPC, identity inference, signing, price discovery, or live collection.
"""
import argparse
import json
import re
from collections import defaultdict
from decimal import localcontext
from pathlib import Path

ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
INTEGER = re.compile(r"-?(0|[1-9][0-9]*)\Z")
ATTRIBUTION_METHODS = {"verified_trace", "verified_wallet_effects"}


def need(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, name, minimum=0, maximum=2**63 - 1):
    need(type(value) is int and minimum <= value <= maximum, name + " must be a bounded integer")
    return value


def hex_value(value, regex, name):
    need(isinstance(value, str) and regex.fullmatch(value), name + " has invalid hex identity")
    return value.lower()


def address(value, name="address"):
    return hex_value(value, ADDRESS, name)


def hash_value(value, name="hash"):
    return hex_value(value, HASH, name)


def evidence(value, name="evidence"):
    need(isinstance(value, str) and 0 < len(value.strip()) <= 4096, name + " must be a nonempty reference")
    return value


def raw(value, name="raw amount"):
    need(isinstance(value, str) and len(value) <= 79 and INTEGER.fullmatch(value), name + " must be an integer string")
    result = int(value)
    need(abs(result) < 2**256, name + " exceeds uint256 magnitude")
    return result


def units(value, decimals):
    # String construction avoids Decimal context rounding on uint256 amounts.
    sign = "-" if value < 0 else ""
    digits = str(abs(value)).rjust(decimals + 1, "0")
    if decimals == 0:
        return sign + digits
    return sign + (digits[:-decimals] + "." + digits[-decimals:]).rstrip("0").rstrip(".")


def span(value, name, cutoff):
    need(isinstance(value, dict), name + " must be an object")
    start = integer(value.get("start"), name + ".start")
    end = integer(value.get("end"), name + ".end")
    need(start < end <= cutoff, name + " must be nonempty and end by knowledge_cutoff")
    return start, end


def _analyze(payload):
    need(isinstance(payload, dict), "payload must be an object")
    need(type(payload.get("chain_id")) is int and payload["chain_id"] == 4663, "chain_id must be 4663")
    cutoff = integer(payload.get("knowledge_cutoff"), "knowledge_cutoff")
    dataset_label = payload.get("dataset_label", "Unclassified supplied evidence")
    evidence(dataset_label, "dataset_label")
    window = span(payload.get("window"), "window", cutoff)
    baseline = span(payload["baseline"], "baseline", cutoff) if payload.get("baseline") is not None else None
    if baseline:
        need(baseline[1] <= window[0], "baseline must end before window starts")
    horizon = integer(payload.get("rotation_horizon_seconds", 3600), "rotation_horizon_seconds", 1, 86400 * 30)
    need(isinstance(payload.get("assets"), dict) and payload["assets"], "assets must be a nonempty address-keyed object")
    assets = {}
    for token, asset in payload["assets"].items():
        token = address(token, "asset")
        need(token not in assets, "duplicate asset identity")
        need(isinstance(asset, dict), "asset metadata must be an object")
        decimals = integer(asset.get("decimals"), "decimals", 0, 255)
        need(asset.get("kind") in {"meme", "stock", "cash", "other"}, "unknown asset kind")
        known = integer(asset.get("known_at"), "asset.known_at")
        evidence(asset.get("evidence"), "asset.evidence")
        need(type(asset.get("standard_token")) is bool, "asset.standard_token must be boolean")
        assets[token] = dict(asset, decimals=decimals, known_at=known)
    pools = {}
    need(isinstance(payload.get("pools"), list), "pools must be a list")
    for pool in payload["pools"]:
        need(isinstance(pool, dict), "pool must be an object")
        manager = address(pool.get("manager"), "pool.manager")
        pool_id = hash_value(pool.get("pool_id"), "pool.pool_id")
        key = manager, pool_id
        need(key not in pools, "duplicate pool registry identity")
        c0, c1 = address(pool.get("currency0")), address(pool.get("currency1"))
        need(c0 < c1 and c0 in assets and c1 in assets, "pool currencies must be sorted, distinct, and registered")
        hooks = address(pool.get("hooks"), "pool.hooks")
        fee = integer(pool.get("fee"), "pool.fee", 0, 2**24 - 1)
        need(fee <= 1_000_000 or fee == 0x800000, "V4 pool fee must be at most 1000000 or the dynamic-fee flag 0x800000")
        spacing = integer(pool.get("tick_spacing"), "pool.tick_spacing", 1, 32767)
        need(pool.get("adapter_status") in {"verified", "unsupported"}, "pool.adapter_status must be verified or unsupported")
        known = integer(pool.get("known_at"), "pool.known_at")
        evidence(pool.get("evidence"), "pool.evidence")
        if pool["adapter_status"] == "verified":
            evidence(pool.get("normalization_evidence"), "pool.normalization_evidence")
        pools[key] = dict(pool, manager=manager, pool_id=pool_id, currency0=c0, currency1=c1, hooks=hooks,
                          fee=fee, tick_spacing=spacing, known_at=known)
    visible_assets = {k: v for k, v in assets.items() if v["known_at"] <= cutoff}
    visible_pools = {k: v for k, v in pools.items() if v["known_at"] <= cutoff and v["currency0"] in visible_assets and v["currency1"] in visible_assets}
    coverage = {}
    need(isinstance(payload.get("coverage", []), list), "coverage must be a list")
    for row in payload.get("coverage", []):
        need(isinstance(row, dict), "coverage row must be an object")
        key = address(row.get("manager")), hash_value(row.get("pool_id"))
        need(key in pools, "coverage references an unknown pool")
        known = integer(row.get("known_at"), "coverage.known_at")
        begin = integer(row.get("start"), "coverage.start")
        end = integer(row.get("end"), "coverage.end")
        need(begin < end, "coverage interval must be nonempty")
        need(row.get("status") in {"complete", "partial", "unknown"}, "invalid coverage status")
        need(row["status"] != "complete" or known >= end, "complete coverage cannot be known before its interval ends")
        evidence(row.get("evidence"), "coverage.evidence")
        fullkey = key, begin, end
        if known <= cutoff:
            need(fullkey not in coverage or coverage[fullkey] == row, "conflicting coverage statements")
            coverage[fullkey] = row

    duplicate_count = 0
    seen = {}
    accepted = []
    excluded = defaultdict(int)
    block_hashes = {}
    block_times = {}
    transaction_slots = {}
    log_slots = {}
    tx_meta = {}
    need(isinstance(payload.get("swaps"), list), "swaps must be a list")
    for event in payload["swaps"]:
        need(isinstance(event, dict) and event.get("event_type") == "swap", "swaps accepts only swap records; transfers are not swaps")
        need(type(event.get("chain_id")) is int and event["chain_id"] == 4663, "event chain_id must be 4663")
        block_hash = hash_value(event.get("block_hash"), "block_hash")
        tx_hash = hash_value(event.get("tx_hash"), "tx_hash")
        index = integer(event.get("log_index"), "log_index")
        key = (4663, block_hash, tx_hash, index)
        canonical_json = json.dumps(event, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if key in seen:
            need(seen[key] == canonical_json, "conflicting duplicate event identity")
            duplicate_count += 1
            continue
        seen[key] = canonical_json
        timestamp = integer(event.get("timestamp"), "event.timestamp")
        known = integer(event.get("known_at"), "event.known_at")
        need(known >= timestamp, "event cannot be known before its timestamp")
        block_number = integer(event.get("block_number"), "block_number")
        tx_index = integer(event.get("transaction_index"), "transaction_index")
        need(type(event.get("canonical")) is bool, "canonical must be boolean")
        need(type(event.get("suspected_activity")) is bool, "suspected_activity must be boolean")
        need(type(event.get("transaction_complete")) is bool, "transaction_complete must be boolean")
        evidence(event.get("evidence"), "event.evidence")
        poolkey = address(event.get("manager")), hash_value(event.get("pool_id"))
        need(poolkey in pools, "swap references unknown pool")
        a0, a1 = raw(event.get("amount0_raw")), raw(event.get("amount1_raw"))
        need(a0 * a1 < 0, "normalized standard-token swap deltas must have opposite nonzero signs")
        attribution = event.get("attribution")
        need(isinstance(attribution, dict), "attribution must be an object")
        method = attribution.get("method")
        need(method in ATTRIBUTION_METHODS | {"router_sender", "unknown"}, "unknown attribution method")
        wallet = address(attribution["wallet"]) if attribution.get("wallet") is not None else None
        if method in ATTRIBUTION_METHODS:
            need(wallet is not None, "verified attribution requires wallet")
            evidence(attribution.get("evidence"), "attribution.evidence")
        if known > cutoff:
            excluded["not_known_at_cutoff"] += 1
            continue
        if not event["canonical"]:
            excluded["noncanonical"] += 1
            continue
        label = "window" if window[0] <= timestamp < window[1] else "baseline" if baseline and baseline[0] <= timestamp < baseline[1] else None
        if label is None:
            excluded["outside_windows"] += 1
            continue
        need(block_number not in block_hashes or block_hashes[block_number] == block_hash, "conflicting canonical block hashes")
        block_hashes[block_number] = block_hash
        need(block_number not in block_times or block_times[block_number] == timestamp, "inconsistent block timestamps")
        block_times[block_number] = timestamp
        slot = block_number, tx_index
        need(slot not in transaction_slots or transaction_slots[slot] == tx_hash, "conflicting transaction index")
        transaction_slots[slot] = tx_hash
        log_slot = block_hash, index
        need(log_slot not in log_slots or log_slots[log_slot] == tx_hash,
             "canonical block log_index cannot belong to multiple transactions")
        log_slots[log_slot] = tx_hash
        meta = block_number, block_hash, tx_index, timestamp
        need(tx_hash not in tx_meta or tx_meta[tx_hash] == meta, "inconsistent transaction metadata")
        tx_meta[tx_hash] = meta
        pool = pools[poolkey]
        reason = None
        if poolkey not in visible_pools:
            reason = "registry_not_known_at_cutoff"
        elif pool["adapter_status"] != "verified":
            reason = "unsupported_adapter"
        elif not all(assets[t]["standard_token"] for t in (pool["currency0"], pool["currency1"])):
            reason = "unsupported_token_effects"
        elif not event["transaction_complete"]:
            reason = "incomplete_transaction"
        elif method not in ATTRIBUTION_METHODS:
            reason = "unknown_or_router_attribution"
        elif event["suspected_activity"]:
            reason = "suspected_activity"
        accepted.append(dict(event, tx_hash=tx_hash, wallet=wallet, poolkey=poolkey, pool=pool,
                             a0=a0, a1=a1, label=label, exclusion=reason))
    # A partially attributed/filtered transaction cannot leave a manufactured
    # endpoint after dropping one routing leg. Quarantine its entire transaction.
    bad_transactions = defaultdict(set)
    for event in accepted:
        if event["exclusion"]:
            bad_transactions[event["tx_hash"]].add(event["exclusion"])
    included = []
    for event in accepted:
        reasons = bad_transactions.get(event["tx_hash"])
        if reasons:
            excluded["quarantined_transaction_records"] += 1
            if event["exclusion"]:
                excluded[event["exclusion"]] += 1
        else:
            included.append(event)

    gross = defaultdict(lambda: defaultdict(int))
    net = defaultdict(int)
    contributing_pools = defaultdict(set)
    for event in included:
        for token, amount in ((event["pool"]["currency0"], event["a0"]), (event["pool"]["currency1"], event["a1"])):
            group = event["label"], event["wallet"], event["tx_hash"], token
            gross[(event["label"], token)]["buy_swaps" if amount > 0 else "sell_swaps"] += 1
            net[group] += amount
            contributing_pools[group].add(event["poolkey"])

    def coverage_state(token, period):
        relevant = [(key, pool) for key, pool in visible_pools.items() if token in (pool["currency0"], pool["currency1"])]
        if period is None or not relevant:
            return "unknown"
        rows = [coverage.get((key, period[0], period[1])) for key, _ in relevant]
        if any(pool["adapter_status"] != "verified" for _, pool in relevant):
            return "incomplete"
        if not all(assets[t]["standard_token"] for _, p in relevant for t in (p["currency0"], p["currency1"])):
            return "incomplete"
        if any(row and row["status"] == "partial" for row in rows):
            return "incomplete"
        if not all(row and row["status"] == "complete" for row in rows):
            return "unknown"
        label = "window" if period == window else "baseline"
        if any(e["label"] == label and e["tx_hash"] in bad_transactions and token in (e["pool"]["currency0"], e["pool"]["currency1"]) for e in accepted):
            return "incomplete"
        return "reported_complete"

    rows = []
    endpoints = []
    for token, asset in sorted(visible_assets.items()):
        buys, sells, baseline_wallets = set(), set(), set()
        buy_count = sell_count = zero_count = 0
        positive = negative = 0
        for (label, wallet, tx_hash, net_token), amount in sorted(net.items()):
            if net_token != token:
                continue
            if label == "baseline":
                if amount:
                    baseline_wallets.add(wallet)
                continue
            if amount > 0:
                buys.add(wallet)
                buy_count += 1
                positive += amount
            elif amount < 0:
                sells.add(wallet)
                sell_count += 1
                negative -= amount
            else:
                zero_count += 1
            if asset["kind"] == "meme" and amount:
                families = set()
                ambiguous = False
                for poolkey in contributing_pools[(label, wallet, tx_hash, token)]:
                    pool = visible_pools[poolkey]
                    other = pool["currency1"] if pool["currency0"] == token else pool["currency0"]
                    if visible_assets[other]["kind"] == "stock":
                        families.add(other)
                    else:
                        ambiguous = True
                if len(families) == 1 and not ambiguous:
                    block, block_hash, tx_index, timestamp = tx_meta[tx_hash]
                    endpoints.append({"wallet": wallet, "tx_hash": tx_hash, "asset": token,
                                      "family": next(iter(families)), "amount_raw": str(abs(amount)),
                                      "direction": "buy" if amount > 0 else "sell", "timestamp": timestamp,
                                      "order": [block, tx_index], "block_hash": block_hash})
        current_status = coverage_state(token, window)
        baseline_status = coverage_state(token, baseline)
        comparable = current_status == baseline_status == "reported_complete"
        rows.append({"asset": token, "kind": asset["kind"], "decimals": asset["decimals"],
                     "window_coverage": current_status, "baseline_coverage": baseline_status,
                     "gross_buy_swaps": gross[("window", token)]["buy_swaps"],
                     "gross_sell_swaps": gross[("window", token)]["sell_swaps"],
                     "net_buy_wallet_transactions": buy_count, "net_sell_wallet_transactions": sell_count,
                     "zero_net_wallet_transactions": zero_count,
                     "net_buy_wallets": len(buys), "net_sell_wallets": len(sells),
                     "positive_delta_raw": str(positive), "negative_delta_raw": str(negative),
                     "net_delta_raw": str(positive - negative), "net_delta_units": units(positive - negative, asset["decimals"]),
                     "newly_observed_buyers_vs_baseline": len(buys - baseline_wallets) if comparable else None,
                     "new_buyer_status": "reported_complete_scoped_comparison" if comparable else "unknown"})

    valuations = {}
    need(isinstance(payload.get("valuations", []), list), "valuations must be a list")
    for value in payload.get("valuations", []):
        need(isinstance(value, dict), "valuation must be an object")
        wallet, tx_hash, token = address(value.get("wallet")), hash_value(value.get("tx_hash")), address(value.get("asset"))
        numeraire = address(value.get("numeraire"))
        known = integer(value.get("known_at"), "valuation.known_at")
        need(token in assets and numeraire in assets, "valuation assets must be registered")
        need(assets[numeraire]["kind"] == "cash", "comparable valuations require an explicit cash numeraire")
        need(value.get("basis") == "verified_tx_net_cashflow", "valuation basis must be verified_tx_net_cashflow")
        evidence(value.get("evidence"), "valuation.evidence")
        quantity = raw(value.get("asset_amount_raw"))
        cashflow = raw(value.get("cashflow_raw"))
        need(quantity > 0 and cashflow != 0, "valuation quantities must be positive and cashflow nonzero")
        key = wallet, tx_hash, token
        if known > cutoff:
            continue
        need(key not in valuations, "duplicate scoped valuation")
        token_delta = net.get(("window", wallet, tx_hash, token), 0)
        cash_delta = net.get(("window", wallet, tx_hash, numeraire), 0)
        need(abs(token_delta) == quantity and cash_delta == cashflow and token_delta * cashflow < 0,
             "valuation does not reconcile to complete normalized transaction net deltas")
        # More than one meme endpoint makes allocating the shared cashflow arbitrary.
        memes = [(t, a) for (l, w, tx, t), a in net.items() if l == "window" and w == wallet and tx == tx_hash and a and assets[t]["kind"] == "meme"]
        need(len(memes) == 1, "valuation cannot allocate shared cashflow across multiple meme endpoints")
        net_endpoints = {t for (l, w, tx, t), a in net.items() if l == "window" and w == wallet and tx == tx_hash and a}
        need(net_endpoints == {token, numeraire}, "valuation cannot attribute unrelated transaction endpoints to the meme")
        # Two net endpoints still permit an unrelated cycle to add cash profit.
        # For this narrow v1, require one directed simple swap path; split,
        # branched, and cyclic executions need a separate scoped attribution.
        outgoing, incoming = {}, {}
        edges = []
        for event in included:
            if event["label"] != "window" or event["wallet"] != wallet or event["tx_hash"] != tx_hash:
                continue
            c0, c1 = event["pool"]["currency0"], event["pool"]["currency1"]
            source, destination = (c0, c1) if event["a0"] < 0 else (c1, c0)
            need(source not in outgoing and destination not in incoming,
                 "valuation requires a single simple route without branches or parallel legs")
            outgoing[source], incoming[destination] = destination, source
            edges.append((source, destination))
        source, destination = (token, numeraire) if token_delta < 0 else (numeraire, token)
        visited = set()
        current = source
        while current in outgoing:
            need(current not in visited, "valuation route contains a cycle")
            visited.add(current)
            current = outgoing[current]
        need(current == destination and len(visited) == len(edges) and source not in incoming and destination not in outgoing,
             "valuation requires a connected simple route with no unrelated cycles")
        need(known >= tx_meta[tx_hash][3], "valuation cannot predate transaction")
        valuations[key] = dict(value, numeraire=numeraire, cashflow=cashflow)

    # Link one-to-one endpoints in observed chain order. The heuristic never
    # asserts that a sale financed the subsequent purchase.
    by_wallet = defaultdict(list)
    for endpoint in endpoints:
        by_wallet[endpoint["wallet"]].append(endpoint)
    links = []
    for wallet, candidates in sorted(by_wallet.items()):
        tx_endpoint_count = defaultdict(int)
        for (label, net_wallet, tx_hash, token), amount in net.items():
            if label == "window" and net_wallet == wallet and amount and assets[token]["kind"] == "meme":
                tx_endpoint_count[tx_hash] += 1
        available_sells = []
        for endpoint in sorted(candidates, key=lambda row: (row["order"], row["asset"])):
            if tx_endpoint_count[endpoint["tx_hash"]] != 1:
                continue
            if endpoint["direction"] == "sell":
                available_sells.append(endpoint)
                continue
            matches = [sale for sale in available_sells if sale["family"] != endpoint["family"]
                       and sale["order"] < endpoint["order"] and 0 <= endpoint["timestamp"] - sale["timestamp"] <= horizon]
            if not matches:
                continue
            sale = matches[-1]
            available_sells.remove(sale)
            sell_value = valuations.get((wallet, sale["tx_hash"], sale["asset"]))
            buy_value = valuations.get((wallet, endpoint["tx_hash"], endpoint["asset"]))
            matched = None
            if sell_value and buy_value and sell_value["numeraire"] == buy_value["numeraire"]:
                coin = sell_value["numeraire"]
                quantity = min(sell_value["cashflow"], -buy_value["cashflow"])
                matched = {"numeraire": coin, "amount_raw": str(quantity), "amount_units": units(quantity, assets[coin]["decimals"]),
                           "basis": "minimum_of_reconciled_supplied_transaction_cashflows"}
            links.append({"wallet": wallet, "sell": sale, "buy": endpoint,
                          "elapsed_seconds": endpoint["timestamp"] - sale["timestamp"],
                          "status": "heuristic_same_wallet_sequence", "comparable_notional": matched,
                          "proceeds_funding_proven": False})

    topology = []
    for quote, asset in sorted(visible_assets.items()):
        if asset["kind"] not in {"stock", "cash"}:
            continue
        members, pool_ids, unsupported = set(), [], 0
        for key, pool in sorted(visible_pools.items()):
            if quote not in (pool["currency0"], pool["currency1"]):
                continue
            other = pool["currency1"] if pool["currency0"] == quote else pool["currency0"]
            if visible_assets[other]["kind"] != "meme":
                continue
            members.add(other)
            pool_ids.append({"manager": key[0], "pool_id": key[1]})
            unsupported += pool["adapter_status"] != "verified"
        if members:
            topology.append({"quote_asset": quote, "quote_kind": asset["kind"], "meme_assets": sorted(members),
                             "meme_count": len(members), "pool_count": len(pool_ids), "pools": pool_ids,
                             "unsupported_pool_count": unsupported, "measured_exit_capacity": None})
    return {"schema": "undertow.flows.report.v1", "chain_id": 4663, "knowledge_cutoff": cutoff, "dataset_label": dataset_label,
            "window": {"start": window[0], "end": window[1]},
            "baseline": {"start": baseline[0], "end": baseline[1]} if baseline else None,
            "rotation_horizon_seconds": horizon,
            "knowledge_mode": "point_in_time" if cutoff == window[1] else "retrospective_as_of_cutoff",
            "input_counts": {"swap_records": len(payload["swaps"]), "exact_duplicates_skipped": duplicate_count,
                             "included_swap_records": len(included), "quarantined_transactions": len(bad_transactions),
                             "excluded_records_by_reason": dict(sorted(excluded.items())),
                             "registered_assets_at_cutoff": len(visible_assets), "registered_pools_at_cutoff": len(visible_pools)},
            "assets": rows,
            "wallet_transaction_deltas": [
                {"window": label, "wallet": wallet, "tx_hash": tx_hash, "block_hash": tx_meta[tx_hash][1],
                 "asset": token, "amount_raw": str(amount), "amount_units": units(amount, assets[token]["decimals"]),
                 "pools": [{"manager": p[0], "pool_id": p[1]} for p in sorted(contributing_pools[(label, wallet, tx_hash, token)])]}
                for (label, wallet, tx_hash, token), amount in sorted(net.items())],
            "quote_cashflows": [{"asset": r["asset"], "kind": r["kind"], "net_delta_raw": r["net_delta_raw"],
                                 "net_delta_units": r["net_delta_units"]} for r in rows if r["kind"] in {"cash", "stock"}],
            "rotation_links": links, "shared_quote_topology": topology,
            "limitations": ["All source, attribution, normalization, valuation and coverage evidence is supplied externally; this analyzer does not independently verify chain state.",
                            "Net deltas cover included normalized swaps only; they are not wallet balances, chain inflows, invested capital, or profit.",
                            "Wallet addresses are not independent people; suspected-activity exclusions do not prove bots or Sybil identities.",
                            "Gross swap counts include routing legs; wallet-transaction-token netting removes zero-net intermediate churn only within the supplied coverage.",
                            "Rotation links are one-to-one latest-prior-sale heuristics; fungible sale proceeds cannot be proven to fund the purchase.",
                            "Newly observed buyers are new only versus the supplied baseline and registered pool scope; reported completeness is a provider assertion.",
                            "Shared quote topology measures registry relationships, not covariance, holdings, pool reserves, TVL, or executable liquidity.",
                            "Every asset known at the cutoff remains in the output; no ranking or profitability score is inferred."]}


def analyze_flows(payload):
    """Return JSON-compatible deterministic descriptive flow analysis."""
    with localcontext() as ctx:
        ctx.prec = 180
        return _analyze(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        result = analyze_flows(json.loads(Path(args.input).read_text()))
        rendered = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if args.output:
            Path(args.output).write_text(rendered)
        else:
            print(rendered, end="")
    except (ValueError, TypeError, KeyError) as error:
        parser.exit(2, "Invalid flow evidence: " + str(error) + "\n")


if __name__ == "__main__":
    main()
