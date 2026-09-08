#!/usr/bin/env python3
"""Deterministic, read-only Robinhood Chain price-mark attribution.

All provenance and chain assertions are supplied evidence. This module neither
collects chain data nor verifies a provider, and never produces an alpha score.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, localcontext
import hashlib
import json
import re
from pathlib import Path


INPUT_SCHEMA = "undertow.attribution.v1"
OUTPUT_SCHEMA = "undertow.attribution.report.v1"
ZERO = "0x" + "0" * 40
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")


class EvidenceError(ValueError):
    def __init__(self, path, code, detail):
        super().__init__(detail)
        self.issue = {"path": path, "code": code, "detail": detail}


def fail(path, code, detail):
    raise EvidenceError(path, code, detail)


def obj(value, path):
    if not isinstance(value, dict):
        fail(path, "OBJECT_REQUIRED", "Expected an object.")
    return value


def string(value, path):
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        fail(path, "STRING_REQUIRED", "Expected a nonempty string of at most 2048 characters.")
    return value


def integer(value, path, lower=0, upper=2**256 - 1):
    if type(value) is not int or not lower <= value <= upper:
        fail(path, "INTEGER_RANGE", f"Expected an integer in [{lower}, {upper}].")
    return value


def number(value, path):
    if not isinstance(value, str) or len(value) > 160 or not DECIMAL.fullmatch(value):
        fail(path, "DECIMAL_STRING_REQUIRED", "Use a positive plain decimal string, never a JSON float.")
    result = Decimal(value)
    if result <= 0:
        fail(path, "NONPOSITIVE_VALUE", "A price, ratio, or multiplier must be strictly positive.")
    return result


def raw_integer(value, path, bits=256):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*", value) or len(value) > 100:
        fail(path, "RAW_INTEGER_REQUIRED", "Expected a positive base-10 integer string.")
    result = int(value)
    if result >= 2**bits:
        fail(path, "RAW_INTEGER_RANGE", f"Value does not fit uint{bits}.")
    return result


def address(value, path, allow_zero=False):
    if not isinstance(value, str) or not ADDRESS.fullmatch(value):
        fail(path, "ADDRESS_REQUIRED", "Expected a full 20-byte EVM address.")
    value = value.lower()
    if value == ZERO and not allow_zero:
        fail(path, "ZERO_ADDRESS", "This field requires a nonzero ERC-20 address.")
    return value


def hash32(value, path):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        fail(path, "HASH_REQUIRED", "Expected a full 32-byte hex hash.")
    return value.lower()


def moment(value, path):
    if not isinstance(value, str):
        fail(path, "TIMESTAMP_REQUIRED", "Expected an ISO-8601 timestamp with a timezone.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(path, "TIMESTAMP_REQUIRED", "Expected an ISO-8601 timestamp with a timezone.")
    if result.tzinfo is None:
        fail(path, "TIMEZONE_REQUIRED", "Naive timestamps are not accepted.")
    return result.astimezone(timezone.utc)


def stamp(value):
    return value.isoformat().replace("+00:00", "Z")


def text_decimal(value):
    if value == 0:
        return "0"
    rendered = format(value, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def pct(factor):
    return text_decimal((factor - Decimal(1)) * 100)


def same_address(value, expected, path):
    if address(value, path) != expected:
        fail(path, "TOKEN_IDENTITY_MISMATCH", "Address disagrees with the declared asset or pool orientation.")


def block_binding(value, snapshot, path):
    if integer(value.get("block_number"), path + ".block_number") != snapshot["block_number"]:
        fail(path, "BLOCK_MISMATCH", "Evidence must refer to this exact snapshot block.")
    if hash32(value.get("block_hash"), path + ".block_hash") != snapshot["block_hash"]:
        fail(path, "BLOCK_MISMATCH", "Evidence must refer to this exact snapshot block hash.")


def source(value, snapshot, ctx, path, *, block_source=False):
    value = obj(value, path)
    at = snapshot["timestamp"] if block_source else moment(value.get("timestamp"), path + ".timestamp")
    observed = moment(value.get("observed_at"), path + ".observed_at")
    if at > snapshot["timestamp"]:
        fail(path, "FUTURE_SOURCE", "Source timestamp is later than the snapshot being explained.")
    if observed < at:
        fail(path, "OBSERVED_BEFORE_SOURCE", "Observation time cannot precede the source timestamp.")
    if observed > ctx["as_of"]:
        fail(path, "KNOWLEDGE_CUTOFF", "Evidence was observed after as_of.")
    if observed > snapshot["observed_at"]:
        fail(path, "SNAPSHOT_CAPTURE_ORDER", "Source evidence was observed after the snapshot capture envelope.")
    age = (snapshot["timestamp"] - at).total_seconds()
    if age > ctx["max_age_seconds"]:
        fail(path, "STALE_SOURCE", "Source age exceeds the explicit historical freshness policy.")
    source_id = string(value.get("source_id"), path + ".source_id")
    evidence_ref = string(value.get("evidence_ref"), path + ".evidence_ref")
    quality = value.get("quality")
    if quality not in ("verified", "unverified"):
        fail(path, "QUALITY_REQUIRED", "Supply quality='verified' or 'unverified'; this is a caller assertion.")
    if quality != "verified":
        ctx["qualification_issues"].append({"path": path, "code": "UNVERIFIED_SOURCE"})
    ctx["provenance"].append({
        "path": path, "source_id": source_id, "evidence_ref": evidence_ref,
        "source_timestamp": stamp(at), "observed_at": stamp(observed),
        "quality_assertion": quality, "authentication": "not_independently_verified",
    })
    return at


def bid_ask(value, path):
    bid = number(value.get("bid"), path + ".bid")
    ask = number(value.get("ask"), path + ".ask")
    if ask < bid:
        fail(path, "CROSSED_MARK", "Ask must be greater than or equal to bid.")
    return bid, ask, (bid + ask) / 2


def aligned(times, ctx, path):
    if (max(times) - min(times)).total_seconds() > ctx["max_alignment_seconds"]:
        fail(path, "MISALIGNED_SOURCES", "Source timestamps exceed the explicit alignment policy.")


def pool_definition(payload, ctx):
    assets = obj(payload.get("assets"), "assets")
    for name in ("meme", "quote"):
        asset = obj(assets.get(name), "assets." + name)
        ctx[name] = {
            "address": address(asset.get("address"), f"assets.{name}.address"),
            "decimals": integer(asset.get("decimals"), f"assets.{name}.decimals", 0, 36),
        }
    if ctx["meme"]["address"] == ctx["quote"]["address"]:
        fail("assets", "IDENTICAL_ASSETS", "Meme and quote must be distinct assets.")
    quote = assets["quote"]
    if quote.get("kind") != "stock_token":
        fail("assets.quote.kind", "UNSUPPORTED_QUOTE", "This module attributes stock-token-quoted meme marks.")
    ctx["underlying_id"] = string(quote.get("underlying_id"), "assets.quote.underlying_id")
    p = obj(payload.get("pool"), "pool")
    if p.get("protocol") != "uniswap_v4":
        fail("pool.protocol", "UNSUPPORTED_PROTOCOL", "Only declared canonical V4 state-price semantics are supported.")
    ctx["pool"] = {
        "protocol": "uniswap_v4", "manager": address(p.get("manager"), "pool.manager"),
        "pool_id": hash32(p.get("pool_id"), "pool.pool_id"),
        "token0": address(p.get("token0"), "pool.token0"),
        "token1": address(p.get("token1"), "pool.token1"),
        "fee": integer(p.get("fee"), "pool.fee", 0, 2**24 - 1),
        "tick_spacing": integer(p.get("tick_spacing"), "pool.tick_spacing", 1, 32767),
        "hook": address(p.get("hook"), "pool.hook", allow_zero=True),
    }
    pool = ctx["pool"]
    if pool["fee"] > 1000000 and pool["fee"] != 0x800000:
        fail("pool.fee", "FEE_RANGE", "V4 static fees must not exceed 1000000; dynamic fee marker is exactly 0x800000.")
    if int(pool["token0"], 16) >= int(pool["token1"], 16):
        fail("pool", "POOL_ORIENTATION", "Canonical V4 token0 must sort before token1 by address.")
    if {pool["token0"], pool["token1"]} != {ctx["meme"]["address"], ctx["quote"]["address"]}:
        fail("pool", "TOKEN_IDENTITY_MISMATCH", "Pool currencies do not match the declared meme and quote.")
    ctx["identity_evidence_ref"] = string(p.get("identity_evidence_ref"), "pool.identity_evidence_ref")
    if p.get("identity_status") not in ("verified", "unverified"):
        fail("pool.identity_status", "IDENTITY_STATUS_REQUIRED", "Declare the status of supplied pool identity evidence.")
    if p["identity_status"] != "verified":
        ctx["qualification_issues"].append({"path": "pool", "code": "UNVERIFIED_POOL_IDENTITY"})
    if p.get("hook_status") not in ("zero_hook", "verified", "unknown"):
        fail("pool.hook_status", "HOOK_STATUS_REQUIRED", "Declare zero_hook, verified, or unknown.")
    if p["hook_status"] == "zero_hook" and pool["hook"] != ZERO:
        fail("pool.hook", "HOOK_IDENTITY_MISMATCH", "zero_hook requires the zero hook address.")
    if p["hook_status"] == "verified":
        string(p.get("hook_evidence_ref"), "pool.hook_evidence_ref")
    if p["hook_status"] == "unknown":
        ctx["qualification_issues"].append({"path": "pool.hook", "code": "UNKNOWN_HOOK"})
    ctx["hook_status"] = p["hook_status"]
    if payload.get("asset_continuity") not in ("verified", "unverified", "broken"):
        fail("asset_continuity", "CONTINUITY_REQUIRED", "Declare interval token/unit continuity.")
    if payload["asset_continuity"] == "broken":
        fail("asset_continuity", "BROKEN_CONTINUITY", "Migration, rebase, or remapping requires a separately verified adapter.")
    if payload["asset_continuity"] != "verified":
        ctx["qualification_issues"].append({"path": "asset_continuity", "code": "UNVERIFIED_CONTINUITY"})


def local_snapshot(value, index, ctx):
    path = f"snapshots[{index}]"
    value = obj(value, path)
    s = {
        "timestamp": moment(value.get("timestamp"), path + ".timestamp"),
        "observed_at": moment(value.get("observed_at"), path + ".observed_at"),
        "block_number": integer(value.get("block_number"), path + ".block_number"),
        "block_hash": hash32(value.get("block_hash"), path + ".block_hash"),
    }
    if s["timestamp"] > ctx["as_of"] or s["observed_at"] > ctx["as_of"]:
        fail(path, "KNOWLEDGE_CUTOFF", "Snapshot timestamp and capture must not exceed as_of.")
    if s["observed_at"] < s["timestamp"]:
        fail(path, "OBSERVED_BEFORE_SOURCE", "Snapshot capture cannot precede its block time.")
    if value.get("canonical") is not True:
        fail(path + ".canonical", "NONCANONICAL_OR_UNKNOWN", "Canonical block status must be explicitly true in supplied evidence.")
    mark = obj(value.get("pool_mark"), path + ".pool_mark")
    pool = ctx["pool"]
    for key in ("token0", "token1", "manager"):
        same_address(mark.get(key), pool[key], path + ".pool_mark." + key)
    if hash32(mark.get("pool_id"), path + ".pool_mark.pool_id") != pool["pool_id"]:
        fail(path + ".pool_mark", "POOL_ID_MISMATCH", "Pool mark belongs to a different pool identifier.")
    block_binding(mark, s, path + ".pool_mark")
    pool_at = source(mark, s, ctx, path + ".pool_mark")
    if pool_at != s["timestamp"]:
        fail(path + ".pool_mark", "BLOCK_TIME_MISMATCH", "A block-pinned state mark must use that block's timestamp.")
    if mark.get("kind") == "sqrt_price_x96":
        sqrt_price = raw_integer(mark.get("sqrt_price_x96"), path + ".pool_mark.sqrt_price_x96", 160)
        if not 4295128739 <= sqrt_price < 1461446703485210103287273052203988822378723970342:
            fail(path + ".pool_mark.sqrt_price_x96", "SQRT_PRICE_RANGE", "State price is outside canonical V4 TickMath bounds.")
        ratio_raw = Decimal(sqrt_price * sqrt_price) / Decimal(2**192)
    elif mark.get("kind") == "raw_ratio":
        numerator = raw_integer(mark.get("token1_raw"), path + ".pool_mark.token1_raw")
        denominator = raw_integer(mark.get("token0_raw"), path + ".pool_mark.token0_raw")
        ratio_raw = Decimal(numerator) / Decimal(denominator)
    else:
        fail(path + ".pool_mark.kind", "UNSUPPORTED_MARK", "Use sqrt_price_x96 or a retained state-price raw_ratio; not balances or reserves.")
    decimal_map = {ctx[x]["address"]: ctx[x]["decimals"] for x in ("meme", "quote")}
    ratio_token1_token0 = ratio_raw * Decimal(10) ** (decimal_map[pool["token0"]] - decimal_map[pool["token1"]])
    s["meme_quote"] = ratio_token1_token0 if ctx["meme"]["address"] == pool["token0"] else 1 / ratio_token1_token0
    quote = obj(value.get("quote_usd"), path + ".quote_usd")
    same_address(quote.get("quote_token"), ctx["quote"]["address"], path + ".quote_usd.quote_token")
    if quote.get("currency") != "USD" or quote.get("unit") != "USD_per_quote_token":
        fail(path + ".quote_usd", "QUOTE_UNIT_MISMATCH", "Supply local-market USD per whole quote token; USDG is not assumed to equal USD.")
    if quote.get("basis") != "local_market":
        fail(path + ".quote_usd.basis", "LOCAL_MARK_REQUIRED", "An equity/oracle reference cannot substitute for an observed local quote-token market mark.")
    string(quote.get("venue"), path + ".quote_usd.venue")
    quote_at = source(quote, s, ctx, path + ".quote_usd")
    bid, ask, mid = bid_ask(quote, path + ".quote_usd")
    aligned([pool_at, quote_at], ctx, path)
    s.update({"quote_usd": mid, "quote_bid": bid, "quote_ask": ask,
              "local_times": [pool_at, quote_at], "meme_usd": s["meme_quote"] * mid})
    return s


def reference_snapshot(value, snapshot, index, ctx):
    path = f"snapshots[{index}].reference"
    reference = obj(value.get("reference"), path)
    if value.get("token_paused") is not False:
        fail(path, "PAUSED_OR_UNKNOWN", "Quote token pause status must be explicitly false at the snapshot block.")
    same_address(reference.get("quote_token"), ctx["quote"]["address"], path + ".quote_token")
    if reference.get("underlying_id") != ctx["underlying_id"]:
        fail(path, "UNDERLYING_MISMATCH", "Reference underlying identity does not match the quote token mapping.")
    if reference.get("asset_status") != "active":
        fail(path, "INACTIVE_OR_UNKNOWN", "Reference asset status must be explicitly active.")
    if reference.get("session") not in ("regular", "extended", "overnight"):
        fail(path, "CLOSED_OR_UNKNOWN_SESSION", "Reference decomposition requires an explicitly open underlying session.")
    if reference.get("tradability") != "tradable":
        fail(path, "TRADABILITY_RESTRICTED_OR_UNKNOWN", "Closing-only, opening-only, and unknown states do not qualify.")
    if reference.get("halted") is not False:
        fail(path, "HALTED_OR_UNKNOWN", "Underlying halt status must be explicitly false.")
    if reference.get("currency") != "USD":
        fail(path, "REFERENCE_UNIT_MISMATCH", "Reference must be explicitly USD denominated.")
    ref_at = source(reference, snapshot, ctx, path)
    aligned(snapshot["local_times"] + [ref_at], ctx, path)
    bid, ask, midpoint = bid_ask(reference, path)
    result = {"underlying_usd": None, "multiplier": None, "basis": reference.get("basis")}
    if reference.get("basis") == "raw_equity":
        if reference.get("unit") != "USD_per_share":
            fail(path, "REFERENCE_UNIT_MISMATCH", "Raw equity prices must be USD per underlying share.")
        multiplier = obj(reference.get("multiplier"), path + ".multiplier")
        if multiplier.get("basis") != "block_state":
            fail(path + ".multiplier", "HISTORICAL_MULTIPLIER_REQUIRED", "Use a retained multiplier read at this exact block; latest metadata cannot explain a historical snapshot.")
        block_binding(multiplier, snapshot, path + ".multiplier")
        source(multiplier, snapshot, ctx, path + ".multiplier", block_source=True)
        multiple = number(multiplier.get("value"), path + ".multiplier.value")
        result.update({"underlying_usd": midpoint, "multiplier": multiple,
                       "adjusted_reference_usd": midpoint * multiple,
                       "adjusted_reference_bid": bid * multiple, "adjusted_reference_ask": ask * multiple})
    elif reference.get("basis") == "adjusted_oracle":
        if reference.get("unit") != "USD_per_quote_token":
            fail(path, "REFERENCE_UNIT_MISMATCH", "Adjusted oracle prices must be USD per whole quote token.")
        if any(key in reference for key in ("multiplier", "currentMultiplier", "current_multiplier")):
            fail(path, "DOUBLE_MULTIPLIER", "Already-adjusted oracle prices must not carry another multiplier.")
        if reference.get("round_valid") is not True:
            fail(path, "INVALID_ORACLE_ROUND", "Oracle round validity must be explicitly asserted from retained evidence.")
        block_binding(reference, snapshot, path)
        result.update({"adjusted_reference_usd": midpoint,
                       "adjusted_reference_bid": bid, "adjusted_reference_ask": ask})
    else:
        fail(path + ".basis", "REFERENCE_BASIS_REQUIRED", "Choose raw_equity or adjusted_oracle explicitly.")
    result["local_premium_ratio"] = snapshot["quote_usd"] / result["adjusted_reference_usd"]
    result["local_premium_lower"] = snapshot["quote_bid"] / result["adjusted_reference_ask"]
    result["local_premium_upper"] = snapshot["quote_ask"] / result["adjusted_reference_bid"]
    return result


def analyze_attribution(payload):
    """Return a deterministic report; invalid local inputs suppress every return.

    Invalid/missing references suppress reference factors while retaining valid
    two-factor local arithmetic. Decimal output strings are not execution quotes.
    """
    report = {
        "schema_version": OUTPUT_SCHEMA, "status": "INSUFFICIENT_DATA",
        "chain_id": 4663, "local_attribution": None, "reference_attribution": None,
        "issues": [], "qualification_issues": [], "provenance": [],
        "qualifies_as_signal": False, "executable_proceeds": None,
        "interpretation": "Multiplicative price-mark accounting only. Relative appreciation does not establish buying demand, causality, sellability, or profit.",
        "verification": "Supplied evidence only; no chain, source-authenticity, deployment, pool-key-hash, or oracle verification is performed by this module.",
        "precision": "80 significant decimal digits; repeating ratios are rounded, factors are not additive contributions.",
    }
    try:
        obj(payload, "payload")
        try:
            serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
            report["input_sha256"] = hashlib.sha256(serialized.encode()).hexdigest()
        except (TypeError, ValueError):
            fail("payload", "JSON_REQUIRED", "Input must be finite JSON data.")
        if payload.get("schema_version") != INPUT_SCHEMA:
            fail("schema_version", "SCHEMA_MISMATCH", "Expected " + INPUT_SCHEMA)
        if type(payload.get("chain_id")) is not int or payload["chain_id"] != 4663:
            fail("chain_id", "CHAIN_MISMATCH", "This adapter is scoped to Robinhood Chain 4663.")
        if payload.get("evidence_mode") not in ("synthetic", "retained"):
            fail("evidence_mode", "EVIDENCE_MODE_REQUIRED", "Declare synthetic or retained evidence; this module does not collect live data.")
        report["evidence_mode"] = payload["evidence_mode"]
        policy = obj(payload.get("policy"), "policy")
        ctx = {
            "as_of": moment(payload.get("as_of"), "as_of"),
            "max_age_seconds": integer(policy.get("max_age_seconds"), "policy.max_age_seconds", 0, 604800),
            "max_alignment_seconds": integer(policy.get("max_alignment_seconds"), "policy.max_alignment_seconds", 0, 86400),
            "provenance": report["provenance"], "qualification_issues": report["qualification_issues"],
        }
        report["as_of"] = stamp(ctx["as_of"])
        report["policy"] = {k: ctx[k] for k in ("max_age_seconds", "max_alignment_seconds")}
        with localcontext() as decimal_context:
            decimal_context.prec = 80
            pool_definition(payload, ctx)
            snapshots = payload.get("snapshots")
            if not isinstance(snapshots, list) or len(snapshots) != 2:
                fail("snapshots", "TWO_SNAPSHOTS_REQUIRED", "Supply exactly two ordered snapshots.")
            a, b = [local_snapshot(s, i, ctx) for i, s in enumerate(snapshots)]
            if b["timestamp"] <= a["timestamp"] or b["block_number"] <= a["block_number"] or b["block_hash"] == a["block_hash"]:
                fail("snapshots", "SNAPSHOT_ORDER", "Snapshots must advance in both block number and timestamp and use distinct block hashes.")
            report["identity"] = {"meme": ctx["meme"], "quote": ctx["quote"],
                                  "underlying_id": ctx["underlying_id"], "pool": ctx["pool"],
                                  "identity_evidence_ref": ctx["identity_evidence_ref"], "hook_status": ctx["hook_status"]}
            relative, quote_factor, total = b["meme_quote"] / a["meme_quote"], b["quote_usd"] / a["quote_usd"], b["meme_usd"] / a["meme_usd"]
            report["local_attribution"] = {
                "price_basis": "pool_state_and_local_bid_ask_midpoint_marks",
                "meme_quote_factor": text_decimal(relative), "meme_quote_return_pct": pct(relative),
                "quote_usd_factor": text_decimal(quote_factor), "quote_usd_return_pct": pct(quote_factor),
                "meme_usd_factor": text_decimal(total), "meme_usd_return_pct": pct(total),
                "factor_product": text_decimal(relative * quote_factor),
                "reconciliation_residual": text_decimal(total - relative * quote_factor),
                "snapshots": [{"timestamp": stamp(s["timestamp"]), "observed_at": stamp(s["observed_at"]),
                               "block_number": s["block_number"], "block_hash": s["block_hash"],
                               "meme_quote": text_decimal(s["meme_quote"]), "quote_usd_mid": text_decimal(s["quote_usd"]),
                               "meme_usd_mark": text_decimal(s["meme_usd"])} for s in (a, b)],
            }
            report["status"] = "PARTIAL_REFERENCE"
            refs = []
            for i, s in enumerate((a, b)):
                try:
                    refs.append(reference_snapshot(snapshots[i], s, i, ctx))
                except EvidenceError as error:
                    report["issues"].append(error.issue)
            if len(refs) == 2:
                r0, r1 = refs
                adjusted = r1["adjusted_reference_usd"] / r0["adjusted_reference_usd"]
                premium = r1["local_premium_ratio"] / r0["local_premium_ratio"]
                attribution = {
                    "meme_quote_factor": text_decimal(relative),
                    "local_premium_factor": text_decimal(premium), "local_premium_change_pct": pct(premium),
                    "adjusted_stock_reference_factor": text_decimal(adjusted), "adjusted_stock_reference_return_pct": pct(adjusted),
                    "underlying_equity_factor": None, "corporate_action_multiplier_factor": None,
                    "factor_product": text_decimal(relative * premium * adjusted),
                    "reconciliation_residual": text_decimal(total - relative * premium * adjusted),
                    "snapshots": [{key: (text_decimal(v) if isinstance(v, Decimal) else v)
                                   for key, v in r.items()} for r in refs],
                    "premium_interval_meaning": "Local bid/reference ask to local ask/reference bid; arithmetic mark bounds, not realizable arbitrage bounds.",
                }
                if all(r["underlying_usd"] is not None for r in refs):
                    attribution["underlying_equity_factor"] = text_decimal(r1["underlying_usd"] / r0["underlying_usd"])
                    attribution["corporate_action_multiplier_factor"] = text_decimal(r1["multiplier"] / r0["multiplier"])
                report["reference_attribution"] = attribution
                report["status"] = "COMPLETE_MARK_ATTRIBUTION"
            report["mark_quality"] = "UNQUALIFIED" if report["qualification_issues"] else "SUPPLIED_CHECKS_PASSED"
            report["historical_evidence_note"] = "as_of is the knowledge cutoff. Snapshot observed_at records retention time; retrospective imports do not prove an earlier alert existed."
    except EvidenceError as error:
        report["issues"].append(error.issue)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    payload = json.loads(args.input.read_text())
    report = analyze_attribution(payload)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
    return 0 if report["status"] != "INSUFFICIENT_DATA" else 2


if __name__ == "__main__":
    raise SystemExit(main())
