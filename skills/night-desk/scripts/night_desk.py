#!/usr/bin/env python3
"""Timestamped Robinhood stock-token valuations; read-only, no trading adapters."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
from pathlib import Path
import re
import sys

CHAIN = 4663
MAX_INPUT = 20_000_000


def strict_json(raw):
    def pairs(rows):
        out = {}
        for k, v in rows:
            if k in out:
                raise ValueError("duplicate JSON key: " + k)
            out[k] = v
        return out
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def timestamp(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("timestamp must be an ISO-8601 string with timezone")
    d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if d.tzinfo is None:
        raise ValueError("timestamp requires timezone")
    return d.astimezone(timezone.utc)


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value) or int(value, 16) == 0:
        raise ValueError("nonzero exact EVM address required")
    return value.lower()


def text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise ValueError(name + " must be a nonempty bounded string")
    return value


def dec(value, *, zero=False):
    if not isinstance(value, str) or len(value) > 120 or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
        raise ValueError("amount must be a bounded unsigned decimal string")
    try:
        n = Decimal(value)
    except InvalidOperation:
        raise ValueError("invalid decimal") from None
    if not n.is_finite() or n < 0 or (not zero and n == 0) or n.adjusted() > 100:
        raise ValueError("amount must be positive and finite")
    return n


def raw_amount(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,77}", value) or int(value) >= 2**256:
        raise ValueError("raw amount must be a uint256 integer string")
    return Decimal(value)


def fmt(value):
    if value is None:
        return None
    s = format(value, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def identity(row, expected=None, stock=False):
    if not isinstance(row, dict) or type(row.get("chain_id")) is not int or row["chain_id"] != CHAIN:
        raise ValueError("exact Robinhood chain 4663 identity required")
    result = {"chain_id": CHAIN, "token": address(row["token"])}
    if expected is not None and result != {k: expected[k] for k in ("chain_id", "token")}:
        raise ValueError("asset identity mismatch")
    if stock and (type(row.get("decimals")) is not int or row["decimals"] != 18):
        raise ValueError("stock token requires 18 raw ERC-20 decimals")
    return result


def timing(row, as_of, limit):
    source = text(row.get("source"), "source")
    observed = timestamp(row["observed_at"])
    source_at = timestamp(row["source_at"])
    if source_at > observed or observed > as_of:
        raise ValueError("future source or observation after valuation cutoff")
    age = (as_of - source_at).total_seconds()
    return {"source": source, "source_at": row["source_at"], "observed_at": row["observed_at"],
            "age_seconds": age, "freshness": "STALE" if age > limit else "FRESH"}


def block(row):
    if type(row.get("block_number")) is not int or row["block_number"] < 0:
        raise ValueError("block_number required")
    if not isinstance(row.get("block_hash"), str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", row["block_hash"]):
        raise ValueError("exact block_hash required")
    if row.get("canonical") is not True:
        raise ValueError("observation not asserted canonical in retained evidence")
    bt = timestamp(row["block_timestamp"])
    if bt > timestamp(row["observed_at"]):
        raise ValueError("block timestamp is later than observation")
    return {"block_number": row["block_number"], "block_hash": row["block_hash"].lower(),
            "block_timestamp": row["block_timestamp"],
            "canonicality": "CALLER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED"}


def failure(kind, exc=None):
    return {"status": kind, "reason": str(exc) if exc is not None else "No evidence supplied"}


def reference(row, asset, as_of, policy, quantity):
    identity(row, asset)
    t = timing(row, as_of, policy["reference_max_age_seconds"])
    bid, ask = dec(row["bid"]), dec(row["ask"])
    if bid > ask:
        raise ValueError("crossed reference bid/ask")
    if row.get("currency") != "USD":
        raise ValueError("reference currency must be explicit USD")
    if type(row.get("halted")) is not bool:
        raise ValueError("explicit halted boolean required")
    market = row.get("market_state")
    if market not in ("OPEN", "CLOSED", "UNKNOWN"):
        raise ValueError("market_state must be OPEN, CLOSED or UNKNOWN")
    if row.get("time_basis") not in ("SERVER_GENERATED", "MARKET_OBSERVATION", "ORACLE_UPDATED"):
        raise ValueError("explicit reference time_basis required")
    out = {**t, "basis": row.get("basis"), "market_state": market, "halted": row["halted"],
           "time_basis": row["time_basis"], "raw_equity_bid_usd": None, "raw_equity_ask_usd": None,
           "multiplier": None, "multiplier_basis": None,
           "token_bid_usd": None, "token_ask_usd": None, "token_mid_usd": None,
           "position_mid_usd": None, "underlying_shares": None,
           "historical_attribution_qualified": False, "executable": False}
    basis = row.get("basis")
    if basis == "RAW_EQUITY_USD":
        m = row["multiplier"]
        mult = dec(m["value"])
        mt = timing(m, as_of, policy["reference_max_age_seconds"])
        identity(m, asset)
        if mt["freshness"] == "STALE":
            raise ValueError("stale multiplier: adjusted reference unavailable")
        if abs((timestamp(m["source_at"]) - timestamp(row["source_at"])).total_seconds()) > policy["max_evidence_skew_seconds"]:
            raise ValueError("reference and multiplier timestamps too far apart")
        if m.get("basis") not in ("CURRENT_REST_METADATA", "BLOCK_STATE"):
            raise ValueError("explicit multiplier basis required")
        if m["basis"] == "BLOCK_STATE":
            out["multiplier_block"] = block(m)
            if (as_of - timestamp(m["block_timestamp"])).total_seconds() > policy["reference_max_age_seconds"]:
                raise ValueError("stale multiplier block")
        pending = m.get("pending")
        if pending is not None:
            dec(pending["value"])
            effective = timestamp(pending["effective_at"])
            if effective <= as_of:
                raise ValueError("pending multiplier became effective; refresh/reconcile before valuation")
            out["pending_multiplier"] = pending
        out.update(raw_equity_bid_usd=fmt(bid), raw_equity_ask_usd=fmt(ask), multiplier=fmt(mult),
                   multiplier_basis=m["basis"], underlying_shares=fmt(quantity * mult) if quantity is not None else None)
        bid, ask = bid * mult, ask * mult
    elif basis == "ADJUSTED_TOKEN_USD":
        if any(k in row for k in ("multiplier", "currentMultiplier", "current_multiplier")):
            raise ValueError("already-adjusted reference must not include another multiplier")
        out["oracle_block"] = block(row)
        if (as_of - timestamp(row["block_timestamp"])).total_seconds() > policy["reference_max_age_seconds"]:
            t["freshness"] = "STALE"
            out["freshness"] = "STALE"
        if row["time_basis"] != "ORACLE_UPDATED":
            raise ValueError("adjusted oracle reference requires ORACLE_UPDATED time_basis")
        if row.get("oracle_status") not in ("HEALTHY", "UNKNOWN", "PAUSED"):
            raise ValueError("explicit oracle_status required")
        out["oracle_status"] = row["oracle_status"]
    else:
        raise ValueError("unsupported reference price basis")
    mid = (bid + ask) / 2
    out.update(token_bid_usd=fmt(bid), token_ask_usd=fmt(ask), token_mid_usd=fmt(mid),
               position_mid_usd=fmt(quantity * mid) if quantity is not None else None)
    out["status"] = ("HALTED" if row["halted"] else "PAUSED_ORACLE" if row.get("oracle_status") == "PAUSED"
                     else "STALE" if t["freshness"] == "STALE" else "CLOSED" if market == "CLOSED"
                     else "SESSION_UNKNOWN" if market == "UNKNOWN" else "AVAILABLE_REFERENCE")
    return out


def onchain(row, asset, as_of, policy, quantity, ref):
    identity(row, asset)
    t, b = timing(row, as_of, policy["onchain_max_age_seconds"]), block(row)
    block_age = (as_of - timestamp(row["block_timestamp"])).total_seconds()
    if block_age > policy["onchain_max_age_seconds"]:
        t["freshness"] = "STALE"
    if row.get("unit") != "USD_PER_RAW_TOKEN":
        raise ValueError("onchain price must use USD_PER_RAW_TOKEN (one whole raw ERC-20 token)")
    price = dec(row["price_usd_per_token"])
    text(row.get("venue_id"), "venue_id")
    if row.get("usd_conversion_basis") not in ("DIRECT_USD", "RETAINED_FX"):
        raise ValueError("onchain mark USD conversion basis required")
    if row["usd_conversion_basis"] == "RETAINED_FX":
        fx = row["fx"]
        ft = timing(fx, as_of, policy["onchain_max_age_seconds"])
        identity(fx)
        dec(fx["usd_per_token"])
        if ft["freshness"] == "STALE":
            raise ValueError("stale onchain USD conversion evidence")
    out = {**t, **b, "status": "STALE" if t["freshness"] == "STALE" else "AVAILABLE_MARK",
           "block_age_seconds": block_age, "venue_id": row["venue_id"], "price_usd_per_token": fmt(price),
           "position_mark_usd": fmt(price * quantity) if quantity is not None else None,
           "usd_conversion_basis": row["usd_conversion_basis"],
           "premium_mid_pct": None, "premium_bid_pct": None, "premium_ask_pct": None,
           "comparison_status": "REFERENCE_UNAVAILABLE", "executable": False,
           "normalization": "ADAPTER_SUPPLIED_NOT_INDEPENDENTLY_REPRODUCED"}
    if ref.get("token_mid_usd") is not None:
        skew = abs((timestamp(row["source_at"]) - timestamp(ref["source_at"])).total_seconds())
        out["reference_skew_seconds"] = skew
        if skew > policy["max_evidence_skew_seconds"]:
            out["comparison_status"] = "TIMESTAMP_MISMATCH"
        else:
            out.update(premium_mid_pct=fmt((price / dec(ref["token_mid_usd"]) - 1) * 100),
                       premium_bid_pct=fmt((price / dec(ref["token_bid_usd"]) - 1) * 100),
                       premium_ask_pct=fmt((price / dec(ref["token_ask_usd"]) - 1) * 100))
            out["comparison_status"] = "INDICATIVE_" + ref["status"]
            if t["freshness"] == "STALE":
                out["comparison_status"] = "INDICATIVE_STALE_ONCHAIN"
    return out


def execution(row, asset, position, as_of, policy, mark, ref):
    if position is None:
        raise ValueError("position with wallet, amount and route required for exit comparison")
    identity(row, asset)
    if address(row["wallet"]) != address(position["wallet"]):
        raise ValueError("execution wallet mismatch")
    if raw_amount(row["amount_in_raw"]) != raw_amount(position["amount_raw"]):
        raise ValueError("execution raw input size mismatch")
    if text(row["route_id"], "route_id") != text(position["route_id"], "position route_id"):
        raise ValueError("execution route mismatch")
    t, b = timing(row, as_of, policy["execution_max_age_seconds"]), block(row)
    if (as_of - timestamp(row["block_timestamp"])).total_seconds() > policy["execution_max_age_seconds"]:
        t["freshness"] = "STALE"
    if mark.get("block_hash") is not None and (b["block_hash"] != mark["block_hash"] or b["block_number"] != mark["block_number"]):
        raise ValueError("execution block differs from supplied onchain mark")
    kind = row.get("kind")
    if kind not in ("QUOTE", "WALLET_CALL_SIMULATION"):
        raise ValueError("execution kind must be QUOTE or WALLET_CALL_SIMULATION")
    if timestamp(row["expires_at"]) < timestamp(row["source_at"]):
        raise ValueError("execution expires before source time")
    if kind == "WALLET_CALL_SIMULATION":
        if row.get("success") is not True:
            return {**t, **b, "status": "SIMULATION_FAILED", "kind": kind,
                    "reason": text(row.get("failure_reason", "Retained simulation did not succeed"), "failure_reason"),
                    "net_exit_usd": None, "independently_verified": False}
        text(row.get("call_evidence_id"), "call_evidence_id")
    if row.get("output_semantics") != "NET_OF_ROUTE_FEES":
        raise ValueError("output must explicitly include route fees; additional costs are separate")
    output = row["output"]
    identity(output)
    if type(output.get("decimals")) is not int or not 0 <= output["decimals"] <= 36:
        raise ValueError("output decimals must be an integer between 0 and 36")
    qty = raw_amount(output["amount_raw"]) / (Decimal(10) ** output["decimals"])
    gross, net, fx_t = None, None, None
    gaps = []
    fx = row.get("output_fx")
    if fx is None:
        gaps.append("OUTPUT_USD_CONVERSION_MISSING")
    else:
        identity(fx, identity(output))
        fx_t = timing(fx, as_of, policy["execution_max_age_seconds"])
        rate = dec(fx["usd_per_token"])
        skew = abs((timestamp(fx["source_at"]) - timestamp(row["source_at"])).total_seconds())
        if fx_t["freshness"] != "FRESH" or skew > policy["max_evidence_skew_seconds"]:
            gaps.append("OUTPUT_USD_CONVERSION_STALE_OR_MISALIGNED")
        else:
            gross = qty * rate
    costs = row.get("additional_costs_usd")
    total = None
    if not isinstance(costs, dict) or any(costs.get(k) is None for k in ("gas", "approval", "other")):
        gaps.append("ADDITIONAL_COSTS_INCOMPLETE")
    else:
        ct = timing(costs, as_of, policy["execution_max_age_seconds"])
        if ct["freshness"] != "FRESH":
            gaps.append("ADDITIONAL_COSTS_STALE")
        else:
            total = sum((dec(costs[k], zero=True) for k in ("gas", "approval", "other")), Decimal(0))
    if gross is not None and total is not None:
        net = gross - total
    expired = timestamp(row["expires_at"]) < as_of
    state = "EXPIRED" if expired else "STALE" if t["freshness"] == "STALE" else "RETAINED_" + kind
    out = {**t, **b, "status": state, "kind": kind, "wallet": address(row["wallet"]),
           "route_id": row["route_id"], "amount_in_raw": row["amount_in_raw"], "expires_at": row["expires_at"],
           "output": {**identity(output), "amount_raw": output["amount_raw"], "decimals": output["decimals"], "whole_tokens": fmt(qty)},
           "output_usd_before_additional_costs": fmt(gross), "additional_costs_usd": fmt(total),
           "net_exit_usd": fmt(net), "net_vs_reference_pct": None,
           "independently_verified": False, "live_executable_established": False,
           "gaps": gaps, "output_fx": fx_t}
    if expired or t["freshness"] == "STALE":
        out["historical_net_exit_usd"] = out["net_exit_usd"]
        out["net_exit_usd"] = None
    elif net is not None and ref.get("position_mid_usd") is not None and dec(ref["position_mid_usd"]) > 0:
        skew = abs((timestamp(row["source_at"]) - timestamp(ref["source_at"])).total_seconds())
        if skew > policy["max_evidence_skew_seconds"]:
            out["comparison_status"] = "TIMESTAMP_MISMATCH"
        else:
            out["net_vs_reference_pct"] = fmt((net / dec(ref["position_mid_usd"]) - 1) * 100)
            out["comparison_status"] = "INDICATIVE_" + ref["status"]
    return out


def analyze(value):
    if not isinstance(value, dict) or value.get("schema") != "NightDeskInput@1":
        raise ValueError("NightDeskInput@1 required")
    as_of = timestamp(value["as_of"])
    asset = identity(value["asset"], stock=True)
    asset.update(decimals=18, symbol=text(value["asset"].get("symbol"), "symbol"))
    policy = {"reference_max_age_seconds": 60, "onchain_max_age_seconds": 30,
              "execution_max_age_seconds": 15, "max_evidence_skew_seconds": 30}
    supplied = value.get("policy", {})
    if not isinstance(supplied, dict) or set(supplied) - set(policy):
        raise ValueError("unknown freshness policy fields")
    policy.update(supplied)
    if any(type(x) is not int or not 1 <= x <= 86400 for x in policy.values()):
        raise ValueError("freshness policy values must be integer seconds in [1,86400]")
    position = value.get("position")
    quantity = None
    with localcontext() as ctx:
        ctx.prec = 400
        if position is not None:
            address(position["wallet"])
            text(position["route_id"], "position route_id")
            n = raw_amount(position["amount_raw"])
            if n <= 0:
                raise ValueError("position raw size must be positive")
            quantity = n / Decimal(10)**18
        refs = {}
        for name, fn in (("reference", lambda r: reference(r, asset, as_of, policy, quantity)),
                         ("onchain", lambda r: onchain(r, asset, as_of, policy, quantity, refs["reference"])),
                         ("execution", lambda r: execution(r, asset, position, as_of, policy, refs["onchain"], refs["reference"]))):
            if value.get(name) is None:
                refs[name] = failure("MISSING")
            else:
                try:
                    refs[name] = fn(value[name])
                except (ValueError, KeyError, TypeError, AttributeError, InvalidOperation, OverflowError) as exc:
                    refs[name] = failure("INVALID", exc)
        return {"schema": "NightDeskReport@1", "as_of": value["as_of"], "asset": asset,
                "input_sha256": sha(value), "synthetic": value.get("synthetic") is True,
                "position": position, "whole_raw_tokens": fmt(quantity), "policy": policy, **refs,
                "status": "PARTIAL" if any(r["status"] in ("MISSING", "INVALID") for r in refs.values()) else "RETAINED_EVIDENCE",
                "limits": ["Reference, onchain mark and retained exit evidence are separate measurements.",
                           "Source assertions, canonicality, route quotes and simulations are not independently verified here.",
                           "Current metadata is not historical block-specific multiplier evidence.",
                           "No profitability, redeemability or live execution has been established.",
                           "A content hash establishes content equality, not authenticity."]}


def write_json(path, value):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--input", required=True)
    a.add_argument("--out", required=True)
    d = sub.add_parser("demo")
    d.add_argument("--out", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--symbol", required=True)
    c.add_argument("--token", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--report-out")
    args = p.parse_args()
    try:
        if args.command == "collect":
            from collector import collect
            result = collect(args.symbol, args.token)
            write_json(args.out, result)
            if args.report_out:
                write_json(args.report_out, analyze(result["normalized_input"]) if result.get("normalized_input") else
                           {"schema": "NightDeskReport@1", "status": "REFERENCE_UNAVAILABLE", "reason": result.get("error")})
            print(json.dumps({"status": result["status"], "responses_retained": len(result["responses"])}))
            return 0 if result.get("normalized_input") else 2
        path = Path(args.input) if args.command == "analyze" else Path(__file__).resolve().parents[1] / "assets" / "example-input.json"
        if path.stat().st_size > MAX_INPUT:
            raise ValueError("input exceeds 20 MB limit")
        result = analyze(strict_json(path.read_text()))
        write_json(args.out, result)
        print(json.dumps({"status": result["status"], "synthetic": result["synthetic"]}))
        return 0
    except (ValueError, KeyError, TypeError, OSError, InvalidOperation) as exc:
        p.exit(2, f"Night Desk unavailable: {type(exc).__name__}: {exc}\n")


if __name__ == "__main__":
    sys.exit(main())
