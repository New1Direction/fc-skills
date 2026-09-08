#!/usr/bin/env python3
"""Bounded, read-only evidence for one standard Uniswap V2 30-bps route.

All state and call simulation use EIP-1898 canonical block-hash selectors.
Optional gas estimation is height-anchored and explicitly weaker. Complete
means complete requested quote capture, never independent wallet-net proof.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE = 8 * 1024 * 1024
UINT256 = 2 ** 256 - 1
ADDRESSES = ("router", "factory", "pair", "token_in", "token_out")
ALLOWED = {"eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call",
           "eth_getBalance", "eth_estimateGas"}


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def reject_constant(value):
    raise ValueError("nonfinite JSON number")


def finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("nonfinite JSON number")
    return result


def strict_json(raw):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, parse_constant=reject_constant, parse_float=finite_float,
                      object_pairs_hook=object_pairs)


def fixed_hex(value, size):
    return isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{%d}" % (2 * size), value) is not None


def quantity(value):
    if not isinstance(value, str) or re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value) is None:
        raise ValueError("invalid RPC quantity")
    if len(value) > 66:
        raise ValueError("quantity exceeds uint256")
    return int(value, 16)


def uint_word(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= UINT256:
        raise ValueError("invalid uint256")
    return "%064x" % value


def address_word(value):
    if not fixed_hex(value, 20):
        raise ValueError("invalid address")
    return "0" * 24 + value[2:].lower()


def words(value, count):
    if not fixed_hex(value, 32 * count):
        raise ValueError("invalid ABI return shape")
    return [int(value[2 + n * 64:2 + (n + 1) * 64], 16) for n in range(count)]


def decode_uint(value):
    return words(value, 1)[0]


def decode_address(value):
    number = decode_uint(value)
    if number >= 2 ** 160:
        raise ValueError("invalid ABI address padding")
    return "0x%040x" % number


def decode_amounts(value, amount_in):
    offset, length, first, last = words(value, 4)
    if offset != 32 or length != 2 or first != amount_in:
        raise ValueError("invalid two-token amounts result")
    return last


def quote_calldata(amount, token_in, token_out):
    return "0xd06ca61f" + uint_word(amount) + uint_word(64) + uint_word(2) + address_word(token_in) + address_word(token_out)


def swap_calldata(amount, minimum, token_in, token_out, wallet, deadline):
    return ("0x38ed1739" + uint_word(amount) + uint_word(minimum) + uint_word(160)
            + address_word(wallet) + uint_word(deadline) + uint_word(2)
            + address_word(token_in) + address_word(token_out))


def model_output(amount, reserve_in, reserve_out):
    # V2 Library uses checked uint256 arithmetic, including intermediate values.
    if not 0 < amount <= UINT256 or not 0 < reserve_in < 2 ** 112 or not 0 < reserve_out < 2 ** 112:
        raise ValueError("unsupported amount or reserves")
    with_fee = amount * 997
    numerator = with_fee * reserve_out
    denominator = reserve_in * 1000 + with_fee
    if max(with_fee, numerator, denominator) > UINT256:
        raise ValueError("V2 checked arithmetic overflow")
    return numerator // denominator


def validate_config(config):
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    required = {"chain_id", "block_number", *ADDRESSES, "amounts_in_raw", "deployment_evidence"}
    optional = {"wallet", "slippage_bps", "expected_code_sha256"}
    if not required <= config.keys() or config.keys() - required - optional:
        raise ValueError("missing or unknown config fields")
    result = dict(config)
    for field in ("chain_id", "block_number"):
        if isinstance(result[field], bool) or not isinstance(result[field], int) or not 0 <= result[field] <= UINT256:
            raise ValueError("chain and block must be nonnegative integers")
    for field in ADDRESSES:
        if not fixed_hex(result[field], 20) or int(result[field], 16) == 0:
            raise ValueError("route requires nonzero EVM addresses")
        result[field] = result[field].lower()
    if result["token_in"] == result["token_out"]:
        raise ValueError("tokens must differ")
    amounts = result["amounts_in_raw"]
    if not isinstance(amounts, list) or not 1 <= len(amounts) <= 20:
        raise ValueError("provide between 1 and 20 amounts")
    for amount in amounts:
        if not isinstance(amount, str) or len(amount) > 78 or re.fullmatch(r"[1-9][0-9]*", amount) is None or int(amount) > UINT256:
            raise ValueError("amounts must be positive canonical uint256 decimal strings")
    if len(set(amounts)) != len(amounts):
        raise ValueError("duplicate amounts")
    wallet = result.setdefault("wallet", None)
    if wallet is not None:
        if not fixed_hex(wallet, 20) or int(wallet, 16) == 0:
            raise ValueError("invalid wallet")
        result["wallet"] = wallet.lower()
    slippage = result.setdefault("slippage_bps", 100)
    if isinstance(slippage, bool) or not isinstance(slippage, int) or not 0 <= slippage < 10000:
        raise ValueError("slippage_bps must be an integer from 0 to 9999")
    source = result["deployment_evidence"]
    if not isinstance(source, str) or not source.strip() or len(source) > 2048:
        raise ValueError("provide a deployment source description, at most 2048 characters")
    fingerprints = result.setdefault("expected_code_sha256", {})
    if not isinstance(fingerprints, dict) or fingerprints.keys() - set(ADDRESSES):
        raise ValueError("invalid expected_code_sha256 roles")
    for role, fingerprint in fingerprints.items():
        if not isinstance(fingerprint, str) or re.fullmatch("[0-9a-fA-F]{64}", fingerprint) is None:
            raise ValueError("code fingerprints must be SHA256 hex without 0x")
    result["expected_code_sha256"] = {key: value.lower() for key, value in fingerprints.items()}
    return result


class RpcFailure(Exception):
    def __init__(self, kind, code=None):
        self.kind = kind
        self.code = code if isinstance(code, int) and not isinstance(code, bool) else None
        super().__init__(kind)


class BudgetExceeded(Exception):
    pass


class InvalidEvidence(Exception):
    pass


class HttpTransport:
    def __init__(self, url):
        if urllib.parse.urlsplit(url).scheme not in {"http", "https"}:
            raise ValueError("RPC requires HTTP or HTTPS")
        self.url, self.sequence = url, 0

    def __call__(self, method, params, timeout):
        completed = queue.Queue(maxsize=1)
        def work():
            try:
                completed.put((True, self.request(method, params, timeout)))
            except Exception as error:
                completed.put((False, error))
        threading.Thread(target=work, daemon=True).start()
        try:
            success, value = completed.get(timeout=timeout)
        except queue.Empty:
            raise RpcFailure("RequestDeadlineExceeded") from None
        if not success:
            raise value
        return value

    def request(self, method, params, timeout):
        self.sequence += 1
        request_id = self.sequence
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        request = urllib.request.Request(self.url, data=json.dumps(payload, allow_nan=False).encode(),
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise RpcFailure("ResponseTooLarge")
            reply = strict_json(raw)
        except RpcFailure:
            raise
        except (OSError, urllib.error.URLError, ValueError, RecursionError):
            raise RpcFailure("TransportError") from None
        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0" or type(reply.get("id")) is not int or reply["id"] != request_id:
            raise RpcFailure("MalformedRpcResponse")
        if "error" in reply:
            error = reply["error"]
            raise RpcFailure("RpcError", error.get("code") if isinstance(error, dict) else None)
        if "result" not in reply:
            raise RpcFailure("MalformedRpcResponse")
        return reply["result"]


def clean_result(method, value):
    """Retain only expected RPC data; arbitrary text could echo endpoint secrets."""
    if method == "eth_getBlockByNumber":
        if not isinstance(value, dict) or not fixed_hex(value.get("hash"), 32):
            raise ValueError("invalid header")
        quantity(value.get("number"))
        quantity(value.get("timestamp"))
        return {key: value[key].lower() for key in ("number", "hash", "timestamp")}
    if method in {"eth_chainId", "eth_getBalance", "eth_estimateGas"}:
        quantity(value)
    elif not isinstance(value, str) or re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", value) is None:
        raise ValueError("invalid byte data")
    return value.lower()


class Rpc:
    def __init__(self, transport, records, max_calls, max_seconds, clock):
        self.transport, self.records, self.max_calls, self.clock = transport, records, max_calls, clock
        self.deadline = clock() + max_seconds
        self.work_deadline = self.deadline - min(10, max_seconds / 4)

    def call(self, method, params, post=False):
        if method not in ALLOWED:
            raise ValueError("RPC method not permitted")
        remaining = (self.deadline if post else self.work_deadline) - self.clock()
        if len(self.records) >= self.max_calls - (0 if post else 1) or remaining <= 0:
            raise BudgetExceeded()
        record = {"id": "rpc-%06d" % (len(self.records) + 1), "method": method,
                  "params": params, "observed_at_utc": utc()}
        self.records.append(record)
        try:
            result = clean_result(method, self.transport(method, params, min(remaining, 20)))
        except RpcFailure as error:
            record["error"] = {"type": error.kind, "code": error.code}
            raise
        except Exception:
            record["error"] = {"type": "MalformedOrUnavailableRpcData", "code": None}
            raise RpcFailure("MalformedOrUnavailableRpcData") from None
        record["result"] = result
        return result, record["id"]


def collect(transport, config, max_calls=160, max_seconds=120, clock=time.monotonic):
    cfg = validate_config(config)
    if isinstance(max_calls, bool) or not isinstance(max_calls, int) or not 3 <= max_calls <= 1000:
        raise ValueError("max_calls must be between 3 and 1000")
    if isinstance(max_seconds, bool) or not isinstance(max_seconds, (int, float)) or not 0 < max_seconds <= 3600:
        raise ValueError("max_seconds must be finite and between 0 and 3600")
    route = {key: cfg[key] for key in ADDRESSES}
    route.update({"fee_bps": 30, "deployment_verification": "unverified", "identity_verified": False,
                  "supported_math": False, "reserve_balance_match": None, "code_sha256": {},
                  "deployment_evidence": cfg["deployment_evidence"], "expected_code_sha256": cfg["expected_code_sha256"]})
    packet = {"schema_version": "exit-doctor.v2-evidence.v1", "source_kind": "rpc", "status": "unavailable", "chain_id": cfg["chain_id"],
              "block": {"number": cfg["block_number"], "hash": None, "timestamp": None, "after_hash": None},
              "route": route, "state": dict.fromkeys(("reserve_in_raw", "reserve_out_raw", "decimals_in", "decimals_out", "balance_in_raw", "balance_out_raw")),
              "wallet_state": {"address": cfg["wallet"], "balance_in_raw": None, "allowance_raw": None, "native_balance_raw": None},
              "slippage_bps": cfg["slippage_bps"], "quotes": [], "records": [], "captured_at_utc": utc(), "diagnostics": [],
              "status_reason": "Complete means scoped requested quote/state capture with consistent anchors, not independent net wallet execution proof, deployment authenticity, finality, or future sellability.",
              "gas_anchor_mode": "numeric_height_with_boundary_recheck"}
    for amount in cfg["amounts_in_raw"]:
        packet["quotes"].append({"amount_in_raw": amount, "amount_out_raw": None, "model_amount_out_raw": None,
            "quote_evidence_id": None, "min_output_raw": None,
            "simulation": {"status": "not_requested" if cfg["wallet"] is None else "unavailable", "amount_out_raw": None,
                "evidence_id": None, "gas_estimate_units": None, "gas_evidence_id": None}})
    rpc = Rpc(transport, packet["records"], max_calls, max_seconds, clock)
    state, wallet_state, diagnostics = packet["state"], packet["wallet_state"], packet["diagnostics"]
    invalidated, partial, correct_chain, anchor_ok = False, False, False, False
    def diagnose(kind, **details):
        diagnostics.append({"type": kind, **details})
    def invalid(kind):
        diagnose(kind)
        raise InvalidEvidence()
    try:
        actual, _ = rpc.call("eth_chainId", [])
        if quantity(actual) != cfg["chain_id"]:
            invalid("ChainIdMismatch")
        correct_chain = True
        before, anchor_id = rpc.call("eth_getBlockByNumber", [hex(cfg["block_number"]), False])
        if quantity(before["number"]) != cfg["block_number"]:
            invalid("BlockNumberMismatch")
        packet["block"].update(hash=before["hash"], timestamp=quantity(before["timestamp"]), evidence_id=anchor_id)
        anchor = {"blockHash": before["hash"], "requireCanonical": True}
        def call_to(address, data):
            return rpc.call("eth_call", [{"to": address, "data": data}, dict(anchor)])
        for role in ADDRESSES:
            code, evidence_id = rpc.call("eth_getCode", [cfg[role], dict(anchor)])
            if code == "0x":
                invalid("EmptyCode:" + role)
            fingerprint = hashlib.sha256(bytes.fromhex(code[2:])).hexdigest()
            route["code_sha256"][role] = fingerprint
            expected = cfg["expected_code_sha256"].get(role)
            if expected is not None and expected != fingerprint:
                route["deployment_verification"] = "mismatch"
                invalid("CodeFingerprintMismatch:" + role)
        if len(cfg["expected_code_sha256"]) == 5:
            route["deployment_verification"] = "matched_config"
        else:
            diagnose("DeploymentUnverified", detail="Address relationships and caller-supplied code hashes do not authenticate audited bytecode, proxy implementation, or protocol provenance.")
        for address, data, expected in (
            (cfg["router"], "0xc45a0155", cfg["factory"]),
            (cfg["pair"], "0xc45a0155", cfg["factory"]),
            (cfg["factory"], "0xe6a43905" + address_word(cfg["token_in"]) + address_word(cfg["token_out"]), cfg["pair"]),
        ):
            value, _ = call_to(address, data)
            if decode_address(value) != expected:
                invalid("RouteIdentityMismatch")
        token0 = decode_address(call_to(cfg["pair"], "0x0dfe1681")[0])
        token1 = decode_address(call_to(cfg["pair"], "0xd21220a7")[0])
        if {token0, token1} != {cfg["token_in"], cfg["token_out"]} or int(token0, 16) >= int(token1, 16):
            invalid("PairTokenIdentityMismatch")
        route.update(token0=token0, token1=token1, identity_verified=True)
        reserves, reserve_id = call_to(cfg["pair"], "0x0902f1ac")
        reserve0, reserve1, reserve_time = words(reserves, 3)
        if reserve0 >= 2 ** 112 or reserve1 >= 2 ** 112 or reserve_time >= 2 ** 32:
            invalid("MalformedReserves")
        reserve_in, reserve_out = (reserve0, reserve1) if cfg["token_in"] == token0 else (reserve1, reserve0)
        state.update(reserve_in_raw=str(reserve_in), reserve_out_raw=str(reserve_out), reserves_evidence_id=reserve_id)
        for side in ("in", "out"):
            try:
                value, evidence_id = call_to(cfg["token_" + side], "0x313ce567")
                decimals = decode_uint(value)
                if decimals > 255:
                    raise ValueError("invalid decimals")
                state["decimals_" + side] = decimals
                state["decimals_" + side + "_evidence_id"] = evidence_id
            except (RpcFailure, ValueError):
                partial = True
                diagnose("DecimalsUnavailable", side=side)
            value, evidence_id = call_to(cfg["token_" + side], "0x70a08231" + address_word(cfg["pair"]))
            state["balance_" + side + "_raw"] = str(decode_uint(value))
            state["balance_" + side + "_evidence_id"] = evidence_id
        route["reserve_balance_match"] = state["balance_in_raw"] == str(reserve_in) and state["balance_out_raw"] == str(reserve_out)
        if not route["reserve_balance_match"]:
            partial = True
            diagnose("ReserveBalanceMismatch", detail="Unsupported state: quotes are retained as observations; no simulation or executable proceeds inferred.")
        if reserve_in == 0 or reserve_out == 0:
            partial = True
            diagnose("EmptyLiquidity")
        if cfg["wallet"]:
            for field, method, params in (
                ("balance_in_raw", "eth_call", [{"to": cfg["token_in"], "data": "0x70a08231" + address_word(cfg["wallet"])}, dict(anchor)]),
                ("allowance_raw", "eth_call", [{"to": cfg["token_in"], "data": "0xdd62ed3e" + address_word(cfg["wallet"]) + address_word(cfg["router"])}, dict(anchor)]),
                ("native_balance_raw", "eth_getBalance", [cfg["wallet"], dict(anchor)]),
            ):
                try:
                    value, evidence_id = rpc.call(method, params)
                    wallet_state[field] = str(quantity(value) if method == "eth_getBalance" else decode_uint(value))
                    wallet_state[field + "_evidence_id"] = evidence_id
                except (RpcFailure, ValueError):
                    partial = True
                    diagnose("WalletPrerequisiteUnavailable", field=field)
        all_models_match = reserve_in > 0 and reserve_out > 0
        for quote in packet["quotes"]:
            amount = int(quote["amount_in_raw"])
            try:
                value, evidence_id = call_to(cfg["router"], quote_calldata(amount, cfg["token_in"], cfg["token_out"]))
                output = decode_amounts(value, amount)
                quote.update(amount_out_raw=str(output), quote_evidence_id=evidence_id,
                             min_output_raw=str(output * (10000 - cfg["slippage_bps"]) // 10000))
                expected = model_output(amount, reserve_in, reserve_out)
                quote["model_amount_out_raw"] = str(expected)
                if output != expected:
                    invalid("QuoteModelDisagreement")
            except (RpcFailure, ValueError):
                partial, all_models_match = True, False
                diagnose("QuoteUnavailableOrUnsupported", amount_in_raw=str(amount))
                continue
            if cfg["wallet"] is None:
                continue
            simulation = quote["simulation"]
            balance, allowance = wallet_state["balance_in_raw"], wallet_state["allowance_raw"]
            if balance is None or allowance is None:
                simulation["status"] = "prerequisite_missing"
                diagnose("SimulationPrerequisiteUnknown", amount_in_raw=str(amount))
                continue
            if int(balance) < amount or int(allowance) < amount:
                simulation["status"] = "prerequisite_missing"
                diagnose("SimulationPrerequisiteMissing", amount_in_raw=str(amount),
                         balance_sufficient=int(balance) >= amount, allowance_sufficient=int(allowance) >= amount)
                continue
            if not route["reserve_balance_match"] or output == 0:
                simulation["status"] = "unavailable"
                diagnose("SimulationUnsupportedState", amount_in_raw=str(amount))
                continue
            transaction = {"from": cfg["wallet"], "to": cfg["router"], "value": "0x0",
                "data": swap_calldata(amount, int(quote["min_output_raw"]), cfg["token_in"], cfg["token_out"],
                                      cfg["wallet"], packet["block"]["timestamp"] + 300)}
            try:
                value, evidence_id = rpc.call("eth_call", [transaction, dict(anchor)])
                actual_output = decode_amounts(value, amount)
                simulation.update(status="succeeded", amount_out_raw=str(actual_output), evidence_id=evidence_id)
                if actual_output != output:
                    invalid("SimulationQuoteDisagreement")
            except RpcFailure as error:
                # Only standard explicit execution-reverted code establishes a revert.
                simulation["status"] = "reverted" if error.kind == "RpcError" and error.code == 3 else "unavailable"
                simulation["evidence_id"] = packet["records"][-1]["id"]
                diagnose("SimulationCallFailed", amount_in_raw=str(amount), status=simulation["status"])
                continue
            except ValueError:
                simulation["status"] = "unavailable"
                partial = True
                diagnose("MalformedSimulationResult", amount_in_raw=str(amount))
                continue
            try:
                value, evidence_id = rpc.call("eth_estimateGas", [transaction, hex(cfg["block_number"])])
                gas = quantity(value)
                if gas == 0:
                    raise ValueError("invalid zero gas estimate")
                simulation.update(gas_estimate_units=str(gas), gas_evidence_id=evidence_id)
            except (RpcFailure, ValueError):
                diagnose("GasEstimateUnavailable", amount_in_raw=str(amount))
        route["supported_math"] = all_models_match and route["reserve_balance_match"]
    except InvalidEvidence:
        invalidated = True
    except BudgetExceeded:
        partial = True
        diagnose("BudgetExhausted")
    except (RpcFailure, ValueError):
        partial = True
        diagnose("RequiredEvidenceUnavailable")
    finally:
        if correct_chain:
            try:
                after, evidence_id = rpc.call("eth_getBlockByNumber", [hex(cfg["block_number"]), False], post=True)
                packet["block"].update(after_hash=after["hash"], after_evidence_id=evidence_id)
                if quantity(after["number"]) != cfg["block_number"]:
                    invalidated = True
                    diagnose("PostBlockNumberMismatch")
                elif packet["block"]["hash"] is not None:
                    if after["hash"] != packet["block"]["hash"] or quantity(after["timestamp"]) != packet["block"]["timestamp"]:
                        invalidated = True
                        diagnose("BlockAnchorChanged")
                    else:
                        anchor_ok = True
            except (RpcFailure, ValueError, BudgetExceeded):
                partial = True
                diagnose("PostAnchorUnavailable")
    any_quote = any(quote["amount_out_raw"] is not None for quote in packet["quotes"])
    packet["status"] = ("invalidated" if invalidated else "complete" if not partial and anchor_ok and route["supported_math"]
                        else "partial" if any_quote or state["reserve_in_raw"] is not None else "unavailable")
    if invalidated:
        route["supported_math"] = False
        diagnose("CanonicalFindingsInvalidated", detail="Retained observations may be inspected, but must not support canonical proceeds findings.")
    return packet


def write_packet(path, packet):
    path = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".exit-doctor-", suffix=".tmp", delete=False) as output:
            temporary = output.name
            json.dump(packet, output, indent=2, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--rpc-env", default="EXIT_DOCTOR_RPC_URL")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-calls", type=int, default=160)
    parser.add_argument("--max-seconds", type=float, default=120)
    args = parser.parse_args(argv)
    if args.out.exists():
        parser.error("output already exists; choose a new path")
    try:
        if args.config.stat().st_size > 128 * 1024:
            raise ValueError("config too large")
        config = validate_config(strict_json(args.config.read_text()))
    except (OSError, ValueError, RecursionError):
        parser.error("invalid config; check documented fields and raw integer amounts")
    try:
        endpoint = os.environ.get(args.rpc_env)
        if not endpoint:
            raise ValueError("missing RPC")
        transport = HttpTransport(endpoint)
    except ValueError:
        def transport(method, params, timeout):
            raise RpcFailure("RpcConfigurationUnavailable")
    try:
        packet = collect(transport, config, args.max_calls, args.max_seconds)
        write_packet(args.out, packet)
    except (OSError, ValueError):
        parser.exit(2, "Could not collect or write evidence; check budgets and choose an unused output path.\n")
    print(json.dumps({"status": packet["status"], "rpc_calls": len(packet["records"]), "quote_count": len(packet["quotes"])}))
    return 0 if packet["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
