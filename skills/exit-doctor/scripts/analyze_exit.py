#!/usr/bin/env python3
"""Audit a retained V2 evidence packet and calculate exact static exit economics."""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path

from v2_math import UINT112_MAX, UINT256_MAX, amount_out, apply_sell, impact, integer, remove_liquidity

SCHEMA = "exit-doctor.v2-evidence.v1"
LIMIT_BYTES = 20 * 1024 * 1024
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")


def raw(value, name, minimum=0):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value):
        raise ValueError(f"{name} must be a canonical raw integer string")
    return integer(int(value), name, minimum)


def fraction(value):
    value = Fraction(value)
    with localcontext() as context:
        context.prec = 40
        rendered = str(Decimal(value.numerator) / Decimal(value.denominator))
    return {"numerator": str(value.numerator), "denominator": str(value.denominator), "decimal": rendered}


def human(value, decimals):
    if decimals is None:
        return None
    integer(decimals, "decimals", 0, 255)
    sign = "-" if value < 0 else ""
    digits = str(abs(value)).zfill(decimals + 1)
    return sign + (digits if decimals == 0 else digits[:-decimals] + "." + digits[-decimals:])


def address(value, name):
    if not isinstance(value, str) or not ADDRESS.fullmatch(value):
        raise ValueError(f"invalid {name} address")
    return value.lower()


def ref(value, records, name):
    if not isinstance(value, str) or value not in records:
        raise ValueError(f"{name} must reference a retained record")
    return records[value]


def abi_amounts(result):
    """Decode exact ABI uint256[dynamic] return for a two-token route."""
    if not isinstance(result, str) or not re.fullmatch(r"0x[0-9a-fA-F]{256}", result):
        raise ValueError("quote record must contain ABI uint256[] for two amounts")
    words = [int(result[i:i + 64], 16) for i in range(2, len(result), 64)]
    if words[0] != 32 or words[1] != 2:
        raise ValueError("quote record must contain a two-token amount array")
    return words[2:]


def bind_call(record, packet, quote, simulated=False):
    params = record.get("params")
    if not isinstance(params, list) or len(params) != 2 or not isinstance(params[0], dict):
        raise ValueError("eth_call must have one transaction and one canonical block-hash selector")
    tx, anchor = params
    if not isinstance(anchor, dict) or anchor.get("requireCanonical") is not True or str(anchor.get("blockHash")).lower() != packet["block"]["hash"].lower():
        raise ValueError("eth_call must bind to the packet's canonical block hash")
    if set(anchor) != {"blockHash", "requireCanonical"}:
        raise ValueError("unexpected anchor fields")
    route = packet["route"]
    if address(tx.get("to"), "call recipient") != route["router"].lower():
        raise ValueError("eth_call recipient differs from configured router")
    amount = raw(quote["amount_in_raw"], "call amount", 1)
    tin, tout = int(route["token_in"], 16), int(route["token_out"], 16)
    data = tx.get("data")
    if not isinstance(data, str):
        raise ValueError("eth_call calldata missing")
    if not simulated:
        expected = "0xd06ca61f" + "".join(f"{w:064x}" for w in [amount, 64, 2, tin, tout])
        if data.lower() != expected:
            raise ValueError("quote calldata does not match getAmountsOut for the configured amount and path")
    else:
        wallet = address(packet.get("wallet_state", {}).get("address"), "simulation wallet")
        if int(wallet, 16) == 0 or address(tx.get("from"), "simulation sender") != wallet:
            raise ValueError("simulation sender differs from nonzero packet wallet")
        if tx.get("value", "0x0") != "0x0":
            raise ValueError("token-to-token simulation must send zero native value")
        if not re.fullmatch(r"0x38ed1739[0-9a-fA-F]{512}", data):
            raise ValueError("simulation must call swapExactTokensForTokens with a two-token path")
        words = [int(data[i:i + 64], 16) for i in range(10, len(data), 64)]
        minimum = raw(quote.get("min_output_raw"), "simulation minimum")
        if words[:4] != [amount, minimum, 160, int(wallet, 16)] or words[5:] != [2, tin, tout]:
            raise ValueError("simulation calldata amount, minimum, recipient or route differs from packet")
        if words[4] < packet["block"]["timestamp"]:
            raise ValueError("simulation deadline predates pinned block")
    return tx


def words(value, count):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{" + str(64 * count) + r"}", value):
        raise ValueError("invalid fixed-width ABI evidence")
    return [int(value[i:i + 64], 16) for i in range(2, len(value), 64)]


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value):
        raise ValueError("invalid RPC quantity")
    return integer(int(value, 16), "RPC quantity")


def bind_state(packet, records):
    """Recompute normalized provenance fields from retained RPC requests/results."""
    block, route, state = packet["block"], packet["route"], packet["state"]
    anchor = {"blockHash": block["hash"], "requireCanonical": True}

    def get(method, params, evidence_id=None):
        if evidence_id is not None:
            record = ref(evidence_id, records, "state evidence_id")
            candidates = [record]
        else:
            candidates = [r for r in records.values() if r.get("method") == method and r.get("params") == params and "error" not in r]
        if not candidates:
            raise ValueError("required raw state/identity evidence is missing")
        results = []
        for record in candidates:
            if record.get("method") != method or record.get("params") != params or "error" in record or "result" not in record:
                raise ValueError("state evidence is bound to a different method, target or anchor")
            results.append(record["result"])
        if any(value != results[0] for value in results[1:]):
            raise ValueError("conflicting retained results for the same anchored request")
        return results[0]

    def call(to, data, evidence_id=None):
        return get("eth_call", [{"to": to, "data": data}, anchor], evidence_id)

    def referenced_id(container, key):
        eid = container.get(key)
        if not isinstance(eid, str):
            raise ValueError(f"required {key} is missing")
        return eid

    if quantity(get("eth_chainId", [])) != packet["chain_id"]:
        raise ValueError("normalized chain_id disagrees with raw evidence")
    for field in ("evidence_id", "after_evidence_id"):
        result = get("eth_getBlockByNumber", [hex(block["number"]), False], referenced_id(block, field))
        if not isinstance(result, dict) or quantity(result.get("number")) != block["number"] or str(result.get("hash")).lower() != block["hash"].lower() or quantity(result.get("timestamp")) != block["timestamp"]:
            raise ValueError("normalized block anchor disagrees with retained block evidence")
    if block["evidence_id"] == block["after_evidence_id"]:
        raise ValueError("before and after anchors require distinct retained observations")

    roles = ("router", "factory", "pair", "token_in", "token_out")
    fingerprints = route.get("code_sha256")
    expected = route.get("expected_code_sha256")
    if not isinstance(fingerprints, dict) or set(fingerprints) != set(roles) or not isinstance(expected, dict) or set(expected) - set(roles):
        raise ValueError("code fingerprints or expected configuration are malformed")
    for role in roles:
        code = get("eth_getCode", [route[role], anchor])
        if not isinstance(code, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", code):
            raise ValueError("required nonempty runtime bytecode evidence is missing")
        actual = hashlib.sha256(bytes.fromhex(code[2:])).hexdigest()
        if fingerprints.get(role) != actual:
            raise ValueError("normalized code fingerprint disagrees with retained bytecode")
        if role in expected and expected[role] != actual:
            raise ValueError("retained bytecode differs from supplied expected fingerprint")
    verification = "matched_config" if set(expected) == set(roles) else "unverified"
    if route["deployment_verification"] != verification:
        raise ValueError("deployment verification label disagrees with retained code/configuration")

    def addrword(text):
        return f"{int(text, 16):064x}"

    for to, data, expected_address in [
        (route["router"], "0xc45a0155", route["factory"]),
        (route["pair"], "0xc45a0155", route["factory"]),
        (route["factory"], "0xe6a43905" + addrword(route["token_in"]) + addrword(route["token_out"]), route["pair"]),
    ]:
        if words(call(to, data), 1)[0] != int(expected_address, 16):
            raise ValueError("route relationship disagrees with retained call")
    token0 = words(call(route["pair"], "0x0dfe1681"), 1)[0]
    token1 = words(call(route["pair"], "0xd21220a7"), 1)[0]
    if not 0 < token0 < token1 < 2**160 or {token0, token1} != {int(route["token_in"], 16), int(route["token_out"], 16)}:
        raise ValueError("retained pair token identities are inconsistent")
    if int(address(route.get("token0"), "token0"), 16) != token0 or int(address(route.get("token1"), "token1"), 16) != token1:
        raise ValueError("normalized token0/token1 disagree with raw evidence")
    reserve0, reserve1, reserve_time = words(call(route["pair"], "0x0902f1ac", referenced_id(state, "reserves_evidence_id")), 3)
    integer(reserve0, "raw reserve0", 1, UINT112_MAX)
    integer(reserve1, "raw reserve1", 1, UINT112_MAX)
    integer(reserve_time, "reserve timestamp", 0, 2**32 - 1)
    expected_reserves = (reserve0, reserve1) if int(route["token_in"], 16) == token0 else (reserve1, reserve0)
    if expected_reserves != (raw(state["reserve_in_raw"], "reserve in", 1), raw(state["reserve_out_raw"], "reserve out", 1)):
        raise ValueError("normalized reserves disagree with retained reserve evidence")
    for side in ("in", "out"):
        balance = words(call(route["token_" + side], "0x70a08231" + addrword(route["pair"]), referenced_id(state, "balance_" + side + "_evidence_id")), 1)[0]
        if raw(state.get("balance_" + side + "_raw"), "pool token balance") != balance:
            raise ValueError("normalized pool balance disagrees with retained token balance")
        dec = state.get("decimals_" + side)
        if dec is not None:
            observed = words(call(route["token_" + side], "0x313ce567", referenced_id(state, "decimals_" + side + "_evidence_id")), 1)[0]
            if dec != observed:
                raise ValueError("normalized decimals disagree with retained metadata")

    wallet = packet.get("wallet_state", {})
    if wallet.get("address") is not None:
        account = address(wallet["address"], "wallet")
        for field, method, params in (
            ("balance_in_raw", "eth_call", [{"to": route["token_in"], "data": "0x70a08231" + addrword(account)}, anchor]),
            ("allowance_raw", "eth_call", [{"to": route["token_in"], "data": "0xdd62ed3e" + addrword(account) + addrword(route["router"])}, anchor]),
            ("native_balance_raw", "eth_getBalance", [account, anchor]),
        ):
            if wallet.get(field) is not None:
                result = get(method, params, referenced_id(wallet, field + "_evidence_id"))
                observed = quantity(result) if method == "eth_getBalance" else words(result, 1)[0]
                if raw(wallet[field], "wallet state") != observed:
                    raise ValueError("normalized wallet state disagrees with retained evidence")


def bind_simulation_status(packet, quote, records):
    """Failure states are evidence-bearing too; never erase a retained revert."""
    sim = quote["simulation"]
    status = sim["status"]
    wallet = packet.get("wallet_state", {})
    configured = wallet.get("address") is not None
    amount = raw(quote["amount_in_raw"], "simulation size", 1)
    candidates = []
    for record in records.values():
        params = record.get("params")
        if record.get("method") != "eth_call" or not isinstance(params, list) or not params or not isinstance(params[0], dict):
            continue
        tx = params[0]
        data = tx.get("data")
        if str(tx.get("to")).lower() != packet["route"]["router"].lower() or not isinstance(data, str) or not re.match(r"0x38ed1739[0-9a-fA-F]{64}", data):
            continue
        if int(data[10:74], 16) != amount:
            continue
        if not configured:
            raise ValueError("retained swap attempt contradicts absent simulation wallet")
        bind_call(record, packet, quote, simulated=True)
        candidates.append(record)
    if status != "succeeded":
        if any(sim.get(key) is not None for key in ("amount_out_raw", "gas_estimate_units", "gas_evidence_id")):
            raise ValueError("non-successful simulation cannot carry output or gas evidence")
    elif sim.get("gas_estimate_units") is None and sim.get("gas_evidence_id") is not None:
        raise ValueError("gas evidence id without normalized estimate")

    def explicit_revert(record):
        error = record.get("error")
        return isinstance(error, dict) and error.get("type") == "RpcError" and type(error.get("code")) is int and error["code"] == 3

    if any(explicit_revert(record) for record in candidates) and status != "reverted":
        raise ValueError("retained explicit swap revert cannot be relabeled as another simulation status")
    if status == "not_requested":
        if configured or candidates or sim.get("evidence_id") is not None:
            raise ValueError("not_requested requires no configured wallet and no simulation evidence")
        return
    if not configured:
        raise ValueError("simulation status requires a configured wallet")
    if status == "prerequisite_missing":
        if sim.get("evidence_id") is not None or candidates:
            raise ValueError("missing prerequisite state contradicts retained swap attempt")
        balance, allowance = wallet.get("balance_in_raw"), wallet.get("allowance_raw")
        if balance is not None and allowance is not None and raw(balance, "wallet balance") >= amount and raw(allowance, "wallet allowance") >= amount:
            raise ValueError("prerequisite_missing contradicts sufficient anchored balance and allowance")
        return
    evidence_id = sim.get("evidence_id")
    record = ref(evidence_id, records, "simulation evidence_id") if evidence_id is not None else None
    if record is not None:
        if record.get("method") != "eth_call":
            raise ValueError("simulation state must reference an eth_call")
        bind_call(record, packet, quote, simulated=True)
    if status == "reverted":
        if record is None or not explicit_revert(record) or "result" in record:
            raise ValueError("reverted requires the exact bound swap's RpcError code 3")
        if any(not explicit_revert(other) for other in candidates):
            raise ValueError("conflicting retained simulation outcomes")
    elif status == "unavailable":
        checks = candidates if record is None else [record, *candidates]
        for other in checks:
            if "error" in other:
                if "result" in other or not isinstance(other["error"], dict):
                    raise ValueError("contradictory simulation error/result")
            elif "result" in other:
                try:
                    abi_amounts(other["result"])
                except ValueError:
                    continue  # Raw bytes retained, but not a valid router result.
                raise ValueError("valid router return cannot be relabeled unavailable")
            else:
                raise ValueError("simulation record lacks result or error")
    elif status == "succeeded":
        if record is None or "error" in record or "result" not in record:
            raise ValueError("succeeded requires a successful exact swap record")
        if any("error" in other or other.get("result") != record["result"] for other in candidates):
            raise ValueError("conflicting retained simulation outcomes")


def validate_packet(packet):
    if packet.get("schema_version") != SCHEMA:
        raise ValueError("unsupported evidence schema")
    if packet.get("status") not in ("complete", "partial"):
        raise ValueError("unavailable or invalidated packet cannot establish an anchored model")
    integer(packet.get("chain_id"), "chain_id", 1)
    block = packet["block"]
    integer(block.get("number"), "block number")
    integer(block.get("timestamp"), "block timestamp")
    if not isinstance(block.get("hash"), str) or not HASH.fullmatch(block["hash"]):
        raise ValueError("missing valid block hash")
    if block["hash"].lower() != str(block.get("after_hash")).lower():
        raise ValueError("anchor changed or was not rechecked")
    route = packet["route"]
    for field in ("identity_verified", "reserve_balance_match", "supported_math"):
        if route.get(field) is not True:
            raise ValueError(f"route {field} is not established")
    for field in ("router", "factory", "pair", "token_in", "token_out"):
        address(route.get(field), field)
    if route["token_in"].lower() == route["token_out"].lower():
        raise ValueError("input and output token must differ")
    if type(route.get("fee_bps")) is not int or route["fee_bps"] != 30:
        raise ValueError("only canonical V2 30 bps fee is supported")
    if route.get("deployment_verification") not in ("matched_config", "unverified"):
        raise ValueError("deployment mismatch or missing verification state")
    state = packet["state"]
    rin = raw(state.get("reserve_in_raw"), "reserve_in", 1)
    rout = raw(state.get("reserve_out_raw"), "reserve_out", 1)
    integer(rin, "reserve_in", 1, UINT112_MAX)
    integer(rout, "reserve_out", 1, UINT112_MAX)
    for side in ("in", "out"):
        dec = state.get(f"decimals_{side}")
        if dec is not None:
            integer(dec, f"decimals_{side}", 0, 255)
        bal = state.get(f"balance_{side}_raw")
        if bal is not None and raw(bal, f"balance_{side}") != (rin if side == "in" else rout):
            raise ValueError("token balance differs from reserve; static standard-token model is not sufficient")
    records = {}
    for record in packet.get("records", []):
        key = record.get("id")
        if not isinstance(key, str) or not key or key in records:
            raise ValueError("record ids must be unique nonempty strings")
        records[key] = record
    bind_state(packet, records)
    quotes = packet.get("quotes")
    if not isinstance(quotes, list) or not 1 <= len(quotes) <= 20:
        raise ValueError("require between 1 and 20 independent sizes")
    seen = set()
    for quote in quotes:
        amount = raw(quote.get("amount_in_raw"), "amount_in", 1)
        if amount in seen:
            raise ValueError("duplicate quote size")
        seen.add(amount)
        modeled = amount_out(amount, rin, rout)
        quoted = quote.get("amount_out_raw")
        if quoted is not None:
            if raw(quoted, "quoted amount_out") != modeled:
                raise ValueError("router quote disagrees with canonical V2 model")
            evidence = ref(quote.get("quote_evidence_id"), records, "quote_evidence_id")
            if evidence.get("method") != "eth_call" or "error" in evidence:
                raise ValueError("quote record is not a successful eth_call")
            bind_call(evidence, packet, quote)
            if abi_amounts(evidence.get("result")) != [amount, modeled]:
                raise ValueError("normalized quote disagrees with retained raw RPC return")
        minimum = quote.get("min_output_raw")
        if minimum is not None and raw(minimum, "min_output_raw") > modeled:
            raise ValueError("minimum output exceeds modeled quote")
        sim = quote.get("simulation", {})
        if sim.get("status") not in ("not_requested", "succeeded", "reverted", "unavailable", "prerequisite_missing"):
            raise ValueError("invalid simulation status")
        bind_simulation_status(packet, quote, records)
        if sim["status"] == "succeeded":
            wallet = packet.get("wallet_state", {})
            if raw(wallet.get("balance_in_raw"), "wallet balance") < amount or raw(wallet.get("allowance_raw"), "wallet allowance") < amount:
                raise ValueError("simulation success contradicts anchored wallet prerequisites")
            if quoted is None or raw(sim.get("amount_out_raw"), "simulation amount_out") != modeled:
                raise ValueError("simulation return must agree with retained router quote")
            evidence = ref(sim.get("evidence_id"), records, "simulation evidence_id")
            if evidence.get("method") != "eth_call" or "error" in evidence:
                raise ValueError("simulation record is not a successful eth_call")
            bind_call(evidence, packet, quote, simulated=True)
            if abi_amounts(evidence.get("result")) != [amount, modeled]:
                raise ValueError("normalized simulation disagrees with retained RPC return")
        elif sim.get("amount_out_raw") is not None:
            raise ValueError("non-successful simulation cannot carry an output amount")
        if sim.get("gas_estimate_units") is not None:
            if sim["status"] != "succeeded":
                raise ValueError("gas estimate must correspond to a successful retained simulation")
            gas = raw(sim["gas_estimate_units"], "gas_estimate_units", 1)
            evidence = ref(sim.get("gas_evidence_id"), records, "gas_evidence_id")
            if evidence.get("method") != "eth_estimateGas" or "error" in evidence:
                raise ValueError("gas record is not a successful eth_estimateGas")
            simulation_tx = records[sim["evidence_id"]]["params"][0]
            if evidence.get("params") != [simulation_tx, hex(block["number"])]:
                raise ValueError("gas estimation must bind to the simulated transaction and pinned block height")
            if not isinstance(evidence.get("result"), str) or not re.fullmatch(r"0x[0-9a-fA-F]+", evidence["result"]):
                raise ValueError("gas record result must be a hexadecimal quantity")
            if int(evidence["result"], 16) != gas:
                raise ValueError("gas estimate disagrees with retained RPC return")
    return rin, rout, records


def costs_by_size(costs, packet, records):
    if costs is None:
        return {}
    if costs.get("schema_version") != "exit-doctor.costs.v1":
        raise ValueError("unsupported cost schema")
    if type(costs.get("chain_id")) is not int or costs["chain_id"] != packet["chain_id"]:
        raise ValueError("cost chain differs from packet")
    if address(costs.get("token_out"), "cost token_out") != packet["route"]["token_out"].lower():
        raise ValueError("cost output token differs from packet")
    entries = costs.get("entries")
    if not isinstance(entries, list) or len(entries) > 20:
        raise ValueError("cost entries must be a list of at most 20 sizes")
    known_sizes = {q["amount_in_raw"] for q in packet["quotes"]}
    result = {}
    for entry in entries:
        amount = str(raw(entry.get("amount_in_raw"), "cost amount_in", 1))
        if amount in result or amount not in known_sizes:
            raise ValueError("duplicate or unquoted cost size")
        if entry.get("unit") != "output_token_raw" or entry.get("includes_pool_fee") is not False:
            raise ValueError("additional costs require output_token_raw units and includes_pool_fee:false")
        if entry.get("status") not in ("known", "unknown"):
            raise ValueError("invalid cost status")
        if not isinstance(entry.get("source"), str) or not entry["source"].strip():
            raise ValueError("cost source/assumption is required")
        ids = entry.get("evidence_ids", [])
        if not isinstance(ids, list):
            raise ValueError("cost evidence_ids must be a list")
        for key in ids:
            ref(key, records, "cost evidence_id")
        if entry["status"] == "known":
            raw(entry.get("amount_out_cost_raw"), "additional cost")
            if entry.get("coverage") != "all_additional_costs":
                raise ValueError("known net costs require explicit coverage of all additional costs including gas")
        elif entry.get("amount_out_cost_raw") is not None:
            raise ValueError("unknown complete cost must have null amount_out_cost_raw")
        result[amount] = entry
    return result


def metrics(amount, rin, rout, din, dout):
    data = impact(amount, rin, rout)
    output = data["amount_out"]
    executable_model = True
    limitation = None
    try:
        apply_sell(amount, rin, rout)
    except ValueError as error:
        executable_model = False
        limitation = str(error)
    return {
        "amount_in_raw": str(amount), "amount_out_modeled_raw": str(output),
        "amount_in_tokens": human(amount, din), "amount_out_modeled_tokens": human(output, dout),
        "model_pair_constraints_satisfied": executable_model, "model_constraint_failure": limitation,
        "average_output_tokens_per_input_token": None if din is None or dout is None else fraction(Fraction(output * 10 ** din, amount * 10 ** dout)),
        "fee_adjusted_price_impact_bps": fraction(data["fee_adjusted_price_impact"] * 10000),
        "gross_spot_execution_shortfall_bps": fraction(data["gross_spot_execution_shortfall"] * 10000),
        "pool_fee_bps_already_embedded": 30,
    }


def model_scenarios(scenarios, packet, rin, rout):
    if scenarios is None:
        return []
    if scenarios.get("schema_version") != "exit-doctor.scenarios.v1":
        raise ValueError("unsupported scenario schema")
    entries = scenarios.get("entries")
    if not isinstance(entries, list) or len(entries) > 30:
        raise ValueError("scenario entries must be a list of at most 30")
    outputs, ids = [], set()
    state = packet["state"]
    for entry in entries:
        sid = entry.get("id")
        if not isinstance(sid, str) or not sid or sid in ids:
            raise ValueError("scenario ids must be unique nonempty strings")
        ids.add(sid)
        result = {"id": sid, "type": entry.get("type"), "model_only": True, "assumptions": entry,
                  "estimated_net_proceeds_raw": None, "additional_costs": "unknown; not applied to hypothetical scenarios"}
        kind = entry.get("type")
        if kind == "prior_sell":
            preceding = raw(entry.get("amount_in_raw"), "prior sell", 1)
            received, next_in, next_out = apply_sell(preceding, rin, rout)
            result["prior_action_output_raw"] = str(received)
        elif kind == "proportional_liquidity_removal":
            next_in, next_out = remove_liquidity(rin, rout, entry.get("removal_bps"))
        elif kind == "buy_then_sell":
            spent = raw(entry.get("quote_spend_raw"), "quote spend", 1)
            acquired, quote_after_buy, token_after_buy = apply_sell(spent, rout, rin)
            returned, _, _ = apply_sell(acquired, token_after_buy, quote_after_buy)
            result.update({"quote_spend_raw": str(spent), "acquired_token_raw": str(acquired),
                           "quote_returned_before_additional_costs_raw": str(returned),
                           "round_trip_quote_change_before_additional_costs_raw": str(returned - spent),
                           "post_buy_reserve_in_raw": str(token_after_buy), "post_buy_reserve_out_raw": str(quote_after_buy)})
            outputs.append(result)
            continue
        else:
            raise ValueError("unsupported scenario type")
        result["post_action_reserve_in_raw"] = str(next_in)
        result["post_action_reserve_out_raw"] = str(next_out)
        result["independent_user_sales"] = [metrics(raw(q["amount_in_raw"], "size", 1), next_in, next_out,
                                                   state.get("decimals_in"), state.get("decimals_out")) for q in packet["quotes"]]
        outputs.append(result)
    return outputs


def analyze(packet, source_sha256, costs=None, scenarios=None, max_impact_bps=None):
    rin, rout, records = validate_packet(packet)
    costs_lookup = costs_by_size(costs, packet, records)
    if max_impact_bps is not None:
        max_impact_bps = Fraction(str(max_impact_bps))
        if not 0 <= max_impact_bps <= 10000:
            raise ValueError("max impact bps must be between 0 and 10000")
    state = packet["state"]
    curve, eligible = [], []
    for quote in packet["quotes"]:
        amount = raw(quote["amount_in_raw"], "size", 1)
        row = metrics(amount, rin, rout, state.get("decimals_in"), state.get("decimals_out"))
        output = int(row["amount_out_modeled_raw"])
        sim = quote["simulation"]
        quoted = quote.get("amount_out_raw")
        estimate = costs_lookup.get(str(amount))
        net = output - int(estimate["amount_out_cost_raw"]) if estimate and estimate["status"] == "known" else None
        if not row["model_pair_constraints_satisfied"]:
            net = None
        if sim["status"] in ("reverted", "prerequisite_missing"):
            net = None
        row.update({
            "amount_out_router_quoted_raw": quoted,
            "amount_out_router_call_simulated_raw": sim.get("amount_out_raw"),
            "evidence_level": "router_call_simulated" if sim["status"] == "succeeded" else "router_quoted" if quoted is not None else "modeled",
            "proceeds_before_additional_costs_raw": str(output),
            "estimated_net_proceeds_raw": None if net is None else str(net),
            "estimated_net_proceeds_tokens": None if net is None else human(net, state.get("decimals_out")),
            "cost_assumption": estimate,
            "cost_status": "unknown" if estimate is None else estimate["status"],
            "net_estimate_basis": "conditional on standard-token model, successful execution, and supplied complete additional costs; not an executable value",
            "min_output_raw": quote.get("min_output_raw"),
            "minimum_output_is_guaranteed": False,
            "simulation": sim, "quote_evidence_id": quote.get("quote_evidence_id"),
            "wallet_balance_delta_independently_measured": False,
        })
        if max_impact_bps is not None:
            observed = row["fee_adjusted_price_impact_bps"]
            passes = Fraction(int(observed["numerator"]), int(observed["denominator"])) <= max_impact_bps and row["model_pair_constraints_satisfied"]
            row["within_tested_impact_threshold"] = passes
            if passes:
                eligible.append(amount)
        curve.append(row)
    warnings = [
        "Model assumes canonical V2 30 bps, standard ERC-20 transfers, unchanged reserves, and no extra token tax or hook.",
        "Each size starts from the same anchored reserves; outputs are alternatives and cannot be added as independent liquidity.",
        "Router eth_call return values are not independently measured recipient balance changes or future sellability guarantees.",
        "Both shortfall metrics include integer-output rounding; fee-adjusted impact excludes the embedded 30 bps fee.",
        "Known costs are supplied complete estimates, not independently verified costs. Gas units or wei alone cannot be subtracted from token amounts.",
        "Minimum output is a transaction condition, not a fill guarantee; this tool does not broadcast trades.",
        "Packet hashes establish byte integrity, not RPC truth. Use trusted deployment configuration and provider verification.",
    ]
    if packet["route"]["deployment_verification"] != "matched_config":
        warnings.append("Deployment is unverified; matching numeric quotes does not authenticate router or token behavior.")
    if any(state.get(f"balance_{side}_raw") is None for side in ("in", "out")):
        warnings.append("One or both token balances were not collected; reserve/balance consistency is unverified.")
    return {
        "schema_version": "exit-doctor.report.v1", "source_sha256": source_sha256,
        "source_kind": packet.get("source_kind") if packet.get("source_kind") in ("rpc", "synthetic", "unknown") else "unknown",
        "source_fixture_notice_untrusted_text": packet.get("fixture_notice"),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(), "captured_at_utc": packet.get("captured_at_utc"),
        "source_status": packet["status"], "chain_id": packet["chain_id"], "block": packet["block"],
        "route": packet["route"], "state": state,
        "spot_output_tokens_per_input_token": None if state.get("decimals_in") is None or state.get("decimals_out") is None else fraction(Fraction(rout * 10 ** state["decimals_in"], rin * 10 ** state["decimals_out"])),
        "independent_size_curve": curve,
        "threshold": None if max_impact_bps is None else {"metric": "fee_adjusted_price_impact_bps", "max_bps": fraction(max_impact_bps), "largest_tested_amount_in_raw": str(max(eligible)) if eligible else None, "is_global_optimum": False},
        "scenarios": model_scenarios(scenarios, packet, rin, rout),
        "diagnostics": packet.get("diagnostics", []), "limitations": warnings,
    }


def read_json(path):
    with open(path, "rb") as stream:
        data = stream.read(LIMIT_BYTES + 1)
    if len(data) > LIMIT_BYTES:
        raise ValueError("input exceeds 20 MiB")
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError("duplicate JSON key")
            obj[key] = value
        return obj
    document = json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON number")))
    if not isinstance(document, dict):
        raise ValueError("input document must be an object")
    return document, hashlib.sha256(data).hexdigest()


def write_new_json(path, document):
    """Publish complete bytes atomically, failing if the destination exists."""
    path = Path(path).absolute()
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".exit-doctor-", delete=False) as stream:
            temp = stream.name
            json.dump(document, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temp, path)
    finally:
        if temp is not None:
            os.unlink(temp)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence")
    parser.add_argument("--out", required=True)
    parser.add_argument("--costs")
    parser.add_argument("--scenarios")
    parser.add_argument("--max-impact-bps")
    args = parser.parse_args(argv)
    try:
        packet, digest = read_json(args.evidence)
        costs, cost_hash = read_json(args.costs) if args.costs else (None, None)
        scenarios, scenario_hash = read_json(args.scenarios) if args.scenarios else (None, None)
        report = analyze(packet, digest, costs, scenarios, args.max_impact_bps)
        report["costs_source_sha256"] = cost_hash
        report["scenarios_source_sha256"] = scenario_hash
        write_new_json(args.out, report)
    except (ValueError, KeyError, TypeError, OSError, OverflowError, ZeroDivisionError) as error:
        print(f"exit-doctor: {error}", file=sys.stderr)
        return 2
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
