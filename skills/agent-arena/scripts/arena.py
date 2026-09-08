#!/usr/bin/env python3
"""Retained-evidence agent performance analysis; no network or transaction submission."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, getcontext
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

getcontext().prec = 160
SCHEMA = "arena-input@1"
ZERO = Decimal(0)
ONE = Decimal(1)
KINDS = {"snapshot", "flow", "decision", "attempt"}
COVERAGE = ("transactionsComplete", "externalFlowsComplete", "positionsComplete",
            "liabilitiesComplete", "costsIncludedInNAV", "attemptsComplete")


class EvidenceError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise EvidenceError(message)


def text(value, label):
    require(isinstance(value, str) and 0 < len(value) <= 4096, f"{label}: expected nonempty string")
    return value


def dec(value, label):
    require(isinstance(value, str) and re.fullmatch(r"-?\d{1,40}(?:\.\d{1,30})?", value),
            f"{label}: expected finite plain decimal string (40 integer / 30 fractional digits maximum)")
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise EvidenceError(f"{label}: invalid decimal") from exc
    require(result.is_finite(), f"{label}: non-finite amount")
    return result


def num(value):
    if value is None:
        return None
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return "0" if result in ("-0", "") else result


def stamp(value, label):
    require(isinstance(value, str) and len(value) <= 40, f"{label}: expected ISO timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError(f"{label}: invalid timestamp") from exc
    require(result.tzinfo is not None, f"{label}: explicit timezone required")
    return result.astimezone(timezone.utc)


def flag(obj, key):
    require(type(obj.get(key)) is bool, f"{key}: explicit boolean required")


def validate_event(e):
    require(isinstance(e, dict), "event must be an object")
    text(e.get("id"), "event.id")
    require(e["id"] != "@header", "reserved event id")
    require(e.get("type") in KINDS, "unsupported event type")
    at, observed = stamp(e.get("at"), "event.at"), stamp(e.get("observedAt"), "event.observedAt")
    require(observed >= at, "observedAt cannot precede the event time")
    text(e.get("evidenceRef"), "event.evidenceRef")
    kind = e["type"]
    if kind == "snapshot":
        require(e.get("phase") in ("regular", "before-flow", "after-flow"), "invalid snapshot phase")
        flag(e, "complete")
        dec(e.get("cash"), "snapshot.cash")
        require(isinstance(e.get("positions"), list), "snapshot.positions list required")
        require(isinstance(e.get("liabilities"), list), "snapshot.liabilities list required")
        require(len(e["positions"]) <= 10000 and len(e["liabilities"]) <= 10000, "snapshot component limit")
        ids = set()
        for p in e["positions"]:
            require(isinstance(p, dict), "position object required")
            asset = text(p.get("assetId"), "position.assetId")
            require(asset not in ids, "duplicate position asset identity")
            ids.add(asset)
            require(dec(p.get("quantity"), "position.quantity") >= 0, "negative position quantity; represent debts as liabilities")
            mark = p.get("mark")
            if mark is not None:
                require(isinstance(mark, dict), "mark object required")
                require(dec(mark.get("price"), "mark.price") >= 0, "negative price")
                stamp(mark.get("at"), "mark.at")
                stamp(mark.get("observedAt"), "mark.observedAt")
                text(mark.get("sourceRef"), "mark.sourceRef")
        ids = set()
        for p in e["liabilities"]:
            require(isinstance(p, dict), "liability object required")
            identity = text(p.get("id"), "liability.id")
            require(identity not in ids, "duplicate liability identity")
            ids.add(identity)
            if p.get("value") is not None:
                require(dec(p["value"], "liability.value") >= 0, "negative liability")
                stamp(p.get("at"), "liability.at")
                stamp(p.get("observedAt"), "liability.observedAt")
                text(p.get("sourceRef"), "liability.sourceRef")
    elif kind == "flow":
        amount = dec(e.get("amount"), "flow.amount")
        require(e.get("kind") in ("deposit", "withdrawal"), "invalid external flow kind")
        require(amount > 0 if e["kind"] == "deposit" else amount < 0, "flow sign conflicts with kind")
        for key in ("beforeSnapshotId", "afterSnapshotId"):
            if e.get(key) is not None:
                text(e[key], key)
    elif kind == "decision":
        text(e.get("agentId"), "decision.agentId")
        text(e.get("action"), "decision.action")
    elif kind == "attempt":
        text(e.get("attemptId"), "attempt.attemptId")
        require(e.get("status") in ("pending", "succeeded", "failed"), "invalid attempt status")
        if e.get("txHash") is not None:
            require(re.fullmatch(r"0x[0-9a-fA-F]{64}", e["txHash"]), "invalid attempt txHash")
        if e.get("decisionId") is not None:
            text(e["decisionId"], "attempt.decisionId")
        if e.get("feeAmount") is not None:
            require(dec(e["feeAmount"], "attempt.feeAmount") >= 0, "negative fee")
        flag(e, "feesIncludedInNAV")


def validate(data):
    require(isinstance(data, dict) and data.get("schema") == SCHEMA, "expected arena-input@1")
    scope, window, coverage = data.get("scope"), data.get("window"), data.get("coverage")
    require(all(isinstance(o, dict) for o in (scope, window, coverage)), "scope/window/coverage objects required")
    require(type(scope.get("chainId")) is int and scope["chainId"] > 0, "positive integer chainId required")
    wallets = scope.get("wallets")
    require(isinstance(wallets, list) and len(wallets) > 0, "wallet scope required")
    require(all(isinstance(w, str) and re.fullmatch(r"0x[0-9a-f]{40}", w) for w in wallets), "wallets must be exact lowercase EVM addresses")
    require(len(set(wallets)) == len(wallets), "duplicate scope wallet")
    text(scope.get("currency"), "scope.currency")
    start, end, asof = (stamp(window.get(k), f"window.{k}") for k in ("start", "end", "asOf"))
    require(start < end, "window start must precede end")
    require(type(window.get("maxMarkAgeSeconds")) is int and 0 <= window["maxMarkAgeSeconds"] <= 31536000, "invalid mark age limit")
    cstart, cend = (stamp(coverage.get(k), f"coverage.{k}") for k in ("start", "end"))
    require(cstart <= cend, "invalid coverage interval")
    for key in COVERAGE:
        flag(coverage, key)
    require(isinstance(coverage.get("sourceRefs"), list) and coverage["sourceRefs"], "coverage sourceRefs required")
    for ref in coverage["sourceRefs"]:
        text(ref, "coverage.sourceRef")
    events = data.get("events")
    require(isinstance(events, list) and len(events) <= 200000, "events list required; maximum 200000 per review")
    seen, unique = {}, []
    for e in events:
        validate_event(e)
        content = canonical(e)
        require(e["id"] not in seen or seen[e["id"]] == content, f"conflicting event id: {e['id']}")
        if e["id"] not in seen:
            unique.append(e)
            seen[e["id"]] = content
    return unique


def valuation(e, asof, max_age):
    at = stamp(e["at"], "snapshot.at")
    issues, assets, debts = [], ZERO, ZERO
    if not e["complete"]:
        issues.append("SNAPSHOT_COMPONENTS_INCOMPLETE")

    def check_mark(mark, prefix):
        marked, observed = stamp(mark["at"], "mark.at"), stamp(mark["observedAt"], "mark.observedAt")
        if marked > at:
            issues.append(f"{prefix}:FUTURE_MARK")
        if observed < marked or observed > asof or observed > stamp(e["observedAt"], "snapshot.observedAt"):
            issues.append(f"{prefix}:MARK_NOT_AVAILABLE")
        if (at - marked).total_seconds() > max_age:
            issues.append(f"{prefix}:STALE_MARK")

    for p in e["positions"]:
        quantity = dec(p["quantity"], "quantity")
        if not quantity:
            continue
        if p.get("mark") is None:
            issues.append(f"{p['assetId']}:UNPRICED_POSITION")
            continue
        check_mark(p["mark"], p["assetId"])
        assets += quantity * dec(p["mark"]["price"], "price")
    for p in e["liabilities"]:
        if p.get("value") is None:
            issues.append(f"{p['id']}:UNPRICED_LIABILITY")
            continue
        check_mark(p, p["id"])
        debts += dec(p["value"], "liability")
    partial = dec(e["cash"], "cash") + assets - debts
    return {"id": e["id"], "at": e["at"], "phase": e["phase"], "nav": num(partial) if not issues else None,
            "knownComponentSubtotal": num(partial), "positionCount": sum(dec(p["quantity"], "quantity") != 0 for p in e["positions"]),
            "issues": issues, "valuationBasis": "RETAINED_MARKS_NOT_EXECUTABLE_EXIT"}


def analyze(data):
    all_events = validate(data)
    scope, window, coverage = data["scope"], data["window"], data["coverage"]
    start, end, asof = (stamp(window[k], k) for k in ("start", "end", "asOf"))
    visible = [e for e in all_events if stamp(e["at"], "at") <= asof and stamp(e["observedAt"], "observedAt") <= asof]
    bounded = [e for e in visible if start <= stamp(e["at"], "at") <= end]
    snapshots = [e for e in bounded if e["type"] == "snapshot"]
    flow_events = [e for e in bounded if e["type"] == "flow" and stamp(e["at"], "at") > start]
    snapshots.sort(key=lambda e: (stamp(e["at"], "at"), {"before-flow": 0, "regular": 1, "after-flow": 2}[e["phase"]], e["id"]))
    values = {e["id"]: valuation(e, asof, window["maxMarkAgeSeconds"]) for e in snapshots}
    by_id = {e["id"]: e for e in visible}
    issues = []
    if end > asof:
        issues.append("WINDOW_NOT_FINISHED_AS_OF")
    if stamp(coverage["start"], "coverage.start") > start or stamp(coverage["end"], "coverage.end") < end:
        issues.append("COVERAGE_DOES_NOT_SPAN_WINDOW")
    for key in COVERAGE[:-1]:
        if not coverage[key]:
            issues.append(f"COVERAGE_{key}_FALSE")
    boundary = {}
    for name, instant in (("opening", start), ("closing", end)):
        candidates = [e for e in snapshots if stamp(e["at"], "at") == instant and e["phase"] in ("regular", "after-flow")]
        if len(candidates) != 1:
            issues.append(f"{name.upper()}_SNAPSHOT_MISSING_OR_AMBIGUOUS")
            boundary[name] = None
        else:
            boundary[name] = values[candidates[0]["id"]]
            if boundary[name]["nav"] is None:
                issues.append(f"{name.upper()}_NAV_UNAVAILABLE")
    funding = sum((dec(e["amount"], "amount") for e in flow_events), ZERO)
    deposits = sum((dec(e["amount"], "amount") for e in flow_events if e["kind"] == "deposit"), ZERO)
    withdrawals = -sum((dec(e["amount"], "amount") for e in flow_events if e["kind"] == "withdrawal"), ZERO)
    attempts = defaultdict(list)
    for e in visible:
        if e["type"] == "attempt" and stamp(e["at"], "attempt.at") <= end:
            attempts[e["attemptId"]].append(e)
    attempt_rows, fee_sum, fee_missing = [], ZERO, 0
    seen_tx = {}
    for attempt_id, rows in sorted(attempts.items()):
        rows.sort(key=lambda e: (stamp(e["at"], "at"), stamp(e["observedAt"], "observedAt"), e["id"]))
        first, final = rows[0], rows[-1]
        hashes = {e["txHash"].lower() for e in rows if e.get("txHash")}
        require(len(hashes) <= 1, f"attempt {attempt_id}: conflicting transaction hashes")
        decision_ids = {e["decisionId"] for e in rows if e.get("decisionId")}
        require(len(decision_ids) <= 1, f"attempt {attempt_id}: conflicting decision links")
        terminal = [e for e in rows if e["status"] != "pending"]
        require(len(terminal) <= 1, f"attempt {attempt_id}: duplicate or conflicting terminal evidence")
        require(not terminal or terminal[0] is final, f"attempt {attempt_id}: status regression")
        if hashes:
            tx = next(iter(hashes))
            require(tx not in seen_tx, f"transaction counted under multiple attempts: {tx}")
            seen_tx[tx] = attempt_id
        # Preserve an unresolved carry-in attempt. A receipt after the window must
        # not replace the pending state that was known at the window boundary.
        if final["status"] != "pending" and not (start < stamp(final["at"], "at") <= end):
            continue
        # Costs use only the terminal record, not all lifecycle observations.
        fee = dec(final["feeAmount"], "feeAmount") if final.get("feeAmount") is not None else None
        if final["status"] != "pending":
            if fee is None:
                fee_missing += 1
            else:
                fee_sum += fee
            if not final["feesIncludedInNAV"]:
                issues.append(f"{attempt_id}:COST_NOT_INCLUDED_IN_NAV")
        decision = by_id.get(next(iter(decision_ids), None))
        eligible = (decision is not None and decision["type"] == "decision"
                    and stamp(decision["at"], "decision.at") <= stamp(first["at"], "attempt.at")
                    and stamp(decision["observedAt"], "decision.observedAt") <= stamp(first["observedAt"], "attempt.observedAt"))
        attempt_rows.append({"attemptId": attempt_id, "status": final["status"], "txHash": next(iter(hashes), None),
                             "pendingCarriedIntoWindow": final["status"] == "pending" and stamp(first["at"], "at") <= start,
                             "feeAmount": num(fee), "decisionId": next(iter(decision_ids), None),
                             "agentId": decision["agentId"] if eligible else None,
                             "attribution": "RETAINED_PRE_ATTEMPT_DECISION" if eligible else "UNATTRIBUTED_OR_LATE_DECISION",
                             "evidenceIds": [e["id"] for e in rows]})
    pnl = None
    if not issues:
        pnl = Decimal(boundary["closing"]["nav"]) - Decimal(boundary["opening"]["nav"]) - funding

    return_issues = list(issues)
    if any(v["nav"] is None for v in values.values()):
        return_issues.append("INTERMEDIATE_NAV_UNAVAILABLE")
    flows_by_at = defaultdict(list)
    for e in flow_events:
        flows_by_at[stamp(e["at"], "flow.at")].append(e)
    bracket_pairs = {}
    used = set()
    for instant, rows in flows_by_at.items():
        if len(rows) != 1:
            return_issues.append("SIMULTANEOUS_FLOWS_REQUIRE_EXPLICIT_AGGREGATED_EVIDENCE")
            continue
        flow = rows[0]
        before, after = by_id.get(flow.get("beforeSnapshotId")), by_id.get(flow.get("afterSnapshotId"))
        good = (before is not None and after is not None and before["type"] == after["type"] == "snapshot"
                and before["phase"] == "before-flow" and after["phase"] == "after-flow"
                and stamp(before["at"], "before.at") == stamp(after["at"], "after.at") == instant
                and before["id"] in values and after["id"] in values)
        if not good:
            return_issues.append(f"{flow['id']}:MISSING_EXACT_FLOW_BRACKETS")
            continue
        ids = {before["id"], after["id"]}
        if used & ids:
            return_issues.append(f"{flow['id']}:FLOW_BRACKET_REUSED")
        used |= ids
        b, a = values[before["id"]]["nav"], values[after["id"]]["nav"]
        if b is None or a is None or Decimal(a) - Decimal(b) != dec(flow["amount"], "flow"):
            return_issues.append(f"{flow['id']}:FLOW_BRACKET_NAV_MISMATCH")
        bracket_pairs[(before["id"], after["id"])] = flow["id"]
    # No orphan flow phases or ambiguous same-time valuations in the evaluated path.
    path = []
    if boundary["opening"] is not None and boundary["closing"] is not None:
        open_id, close_id = boundary["opening"]["id"], boundary["closing"]["id"]
        started = False
        for e in snapshots:
            if e["id"] == open_id:
                started = True
            if started:
                path.append(e)
            if e["id"] == close_id:
                break
        for e in path[1:]:
            if e["phase"] != "regular" and e["id"] not in used:
                return_issues.append(f"{e['id']}:ORPHAN_FLOW_PHASE")
        for left, right in zip(path, path[1:]):
            if stamp(left["at"], "at") == stamp(right["at"], "at") and (left["id"], right["id"]) not in bracket_pairs:
                return_issues.append("AMBIGUOUS_SAME_TIME_SNAPSHOTS")
    twr, observed_drawdown, series = None, None, []
    if not return_issues and path:
        index, peak, maximum = ONE, ONE, ZERO
        for i, e in enumerate(path):
            nav = Decimal(values[e["id"]]["nav"])
            if nav < 0 or (i < len(path) - 1 and nav == 0):
                return_issues.append("NONPOSITIVE_RETURN_DENOMINATOR_OR_NEGATIVE_EQUITY")
                break
            if i and (path[i - 1]["id"], e["id"]) not in bracket_pairs:
                previous = Decimal(values[path[i - 1]["id"]]["nav"])
                index *= nav / previous
            peak = max(peak, index)
            drawdown = ONE - index / peak
            maximum = max(maximum, drawdown)
            series.append({"snapshotId": e["id"], "at": e["at"], "growthIndex": num(index), "drawdownFraction": num(drawdown)})
        if not return_issues:
            twr, observed_drawdown = index - ONE, maximum
        else:
            series = []
    statuses = dict(Counter(e["status"] for e in attempt_rows))
    attributed = sum(e["agentId"] is not None for e in attempt_rows)
    return {"schema": "arena-report@1", "scope": scope, "window": window, "inputDigest": digest(data),
            "status": "AVAILABLE_FROM_DECLARED_RETAINED_EVIDENCE" if pnl is not None else "INCOMPLETE_EVIDENCE",
            "coverage": {**coverage, "assurance": "DECLARED_NOT_INDEPENDENTLY_PROVEN"},
            "opening": boundary["opening"], "closing": boundary["closing"],
            "funding": {"deposits": num(deposits), "withdrawals": num(withdrawals), "netExternalFlow": num(funding),
                        "flowIds": [e["id"] for e in flow_events], "interval": "(start,end]"},
            "performance": {"cashflowAdjustedPnl": num(pnl), "timeWeightedReturnFraction": num(twr),
                            "observedSnapshotDrawdownFraction": num(observed_drawdown),
                            "pnlIssues": sorted(set(issues)), "returnIssues": sorted(set(return_issues)),
                            "method": "EXACT_FLOW_BRACKETED_GEOMETRIC_LINKING", "growthSeries": series,
                            "annualized": False, "realizedVsUnrealizedSplit": "UNAVAILABLE_WITHOUT_COST_BASIS_LEDGER"},
            "costs": {"observedTerminalFees": num(fee_sum), "terminalAttemptsWithoutPricedFee": fee_missing,
                      "coverageComplete": coverage["attemptsComplete"] and fee_missing == 0,
                      "treatment": "ALREADY_IN_NAV_NOT_SUBTRACTED_AGAIN"},
            "attempts": {"counts": statuses, "rows": attempt_rows, "coverageComplete": coverage["attemptsComplete"]},
            "attribution": {"attemptsWithPriorDecisionEvidence": attributed, "attemptsWithoutPriorDecisionEvidence": len(attempt_rows) - attributed,
                            "authorshipVerified": False, "causalProfitAttribution": "NOT_ESTABLISHED"},
            "snapshots": list(values.values()), "excludedNotKnownAsOf": len(all_events) - len(visible),
            "limitations": ["Evidence completeness is an input assertion, not a native chain audit.",
                            "Drawdown is measured only at retained snapshots.",
                            "Marked NAV does not establish executable exit value or future profitability."]}


def load_json(path):
    def no_dupes(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj, f"duplicate JSON key: {key}")
            obj[key] = value
        return obj
    require(Path(path).stat().st_size <= 128 * 1024 * 1024, "input exceeds 128 MiB")
    return json.loads(Path(path).read_text(), object_pairs_hook=no_dupes,
                      parse_constant=lambda x: (_ for _ in ()).throw(EvidenceError(f"invalid JSON number {x}")))


def connect(path, create=False):
    if not create:
        require(Path(path).is_file(), "journal does not exist")
    con = sqlite3.connect(path, timeout=15)
    con.execute("PRAGMA busy_timeout=15000")
    con.execute("PRAGMA synchronous=FULL")
    if create:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript("""
          CREATE TABLE IF NOT EXISTS entries (
            seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL, previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
          CREATE TRIGGER IF NOT EXISTS prevent_update BEFORE UPDATE ON entries
            BEGIN SELECT RAISE(ABORT, 'append-only journal'); END;
          CREATE TRIGGER IF NOT EXISTS prevent_delete BEFORE DELETE ON entries
            BEGIN SELECT RAISE(ABORT, 'append-only journal'); END;
        """)
    return con


def entry_hash(seq, event_id, payload, previous):
    return digest({"seq": seq, "eventId": event_id, "payload": payload, "previousHash": previous})


def verify_journal(con, expected_head=None):
    previous, expected_seq, entries = "0" * 64, 1, []
    for seq, event_id, payload, prior, recorded in con.execute("SELECT seq,event_id,payload,previous_hash,entry_hash FROM entries ORDER BY seq"):
        require(seq == expected_seq and prior == previous, "journal sequence/hash linkage is corrupt")
        require(recorded == entry_hash(seq, event_id, payload, prior), "journal payload/hash mismatch")
        value = json.loads(payload)
        require(canonical(value) == payload, "journal payload is not canonical")
        require((seq == 1 and event_id == "@header") or (seq > 1 and isinstance(value, dict) and value.get("id") == event_id), "journal event identity mismatch")
        entries.append(value)
        previous, expected_seq = recorded, seq + 1
    require(entries, "empty journal")
    header = entries[0]
    data = {**header, "events": entries[1:]}
    validate(data)
    if expected_head is not None:
        require(previous == expected_head, "journal differs from the supplied external head anchor")
    return data, {"schema": "arena-journal-verification@1", "status": "HASH_CHAIN_CONSISTENT",
                  "entryCount": len(entries), "eventCount": len(entries) - 1, "headHash": previous,
                  "externalHeadMatched": expected_head is not None, "historyCompletenessProven": False,
                  "agentAuthorshipProven": False}


def journal_import(path, data, initialize=False):
    events = validate(data)
    header = {k: v for k, v in data.items() if k != "events"}
    con = connect(path, create=initialize)
    try:
        con.execute("BEGIN IMMEDIATE")
        count = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        pending = []
        if count:
            retained, info = verify_journal(con)
            require(canonical({k: v for k, v in retained.items() if k != "events"}) == canonical(header), "frozen journal header differs; create a new review journal")
            pending = events
            # Validate semantic conflicts across imports before committing any row.
            analyze({**header, "events": retained["events"] + events})
            previous, seq = info["headHash"], info["entryCount"] + 1
        else:
            require(initialize, "initialize journal first")
            analyze(data)
            previous, seq = "0" * 64, 1
            pending = [header] + events
        inserted = 0
        for e in pending:
            event_id = "@header" if seq == 1 else e["id"]
            payload = canonical(e)
            existing = con.execute("SELECT payload FROM entries WHERE event_id=?", (event_id,)).fetchone()
            if existing:
                require(existing[0] == payload, f"conflicting event id: {event_id}")
                continue
            hashed = entry_hash(seq, event_id, payload, previous)
            con.execute("INSERT INTO entries VALUES (?,?,?,?,?)", (seq, event_id, payload, previous, hashed))
            previous, seq = hashed, seq + 1
            if event_id != "@header":
                inserted += 1
        con.commit()
        _, info = verify_journal(con)
        return {**info, "insertedEvents": inserted, "duplicateEvents": len(events) - inserted}
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def output(result, path=None):
    encoded = json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    if path:
        Path(path).write_text(encoded)
    else:
        print(encoded, end="")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    p = subs.add_parser("analyze", help="Analyze normalized retained evidence")
    p.add_argument("--input", required=True)
    p.add_argument("--out")
    for command in ("journal-init", "journal-import", "journal-verify", "journal-export", "journal-report"):
        p = subs.add_parser(command)
        p.add_argument("--db", required=True)
        p.add_argument("--out")
        if command in ("journal-init", "journal-import"):
            p.add_argument("--input", required=True)
        else:
            p.add_argument("--expected-head", help="Optional separately retained journal head hash")
    args = parser.parse_args(argv)
    try:
        if args.command == "analyze":
            result = analyze(load_json(args.input))
        elif args.command in ("journal-init", "journal-import"):
            result = journal_import(args.db, load_json(args.input), initialize=args.command == "journal-init")
        else:
            con = connect(args.db)
            try:
                data, info = verify_journal(con, args.expected_head)
                result = info if args.command == "journal-verify" else data if args.command == "journal-export" else {**analyze(data), "journal": info}
            finally:
                con.close()
        output(result, args.out)
        return 0
    except (EvidenceError, OSError, json.JSONDecodeError, sqlite3.Error, KeyError, TypeError) as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
