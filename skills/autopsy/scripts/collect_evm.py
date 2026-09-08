#!/usr/bin/env python3
"""Collect bounded, read-only ERC-20 Transfer evidence using Python's stdlib.

Coverage concerns only the explicitly requested block interval. A provider can
silently truncate or fabricate responses; anchor checks do not prove authenticity.
"""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import queue
import threading
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ALLOWED = {"eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getLogs"}


def reject_constant(value):
    raise ValueError("nonfinite JSON number")


def finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("nonfinite JSON number")
    return result


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def fixed_hex(value, size):
    return isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{%d}" % (size * 2), value) is not None


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value):
        raise ValueError("invalid quantity")
    return int(value, 16)


class RpcFailure(Exception):
    def __init__(self, kind, code=None):
        self.kind = kind
        self.code = code if isinstance(code, int) and not isinstance(code, bool) else None
        super().__init__(kind)


class BudgetExceeded(Exception):
    pass


class HttpTransport:
    def __init__(self, url):
        if urllib.parse.urlsplit(url).scheme not in {"http", "https"}:
            raise ValueError("RPC endpoint must use HTTP or HTTPS")
        self.url = url
        self.sequence = 0

    def __call__(self, method, params, timeout):
        # Socket timeouts alone permit a peer to drip-feed bytes indefinitely.
        # A daemon worker also bounds the caller's total wall time per request.
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
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                # Bound the response size as well as calls and time.
                raw = response.read(32 * 1024 * 1024 + 1)
            if len(raw) > 32 * 1024 * 1024:
                raise RpcFailure("ResponseTooLarge")
            reply = json.loads(raw, parse_constant=reject_constant, parse_float=finite_float)
        except RpcFailure:
            raise
        except (OSError, urllib.error.URLError, ValueError):
            raise RpcFailure("TransportError") from None
        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0" or reply.get("id") != request_id:
            raise RpcFailure("MalformedRpcResponse")
        if "error" in reply:
            error = reply["error"]
            raise RpcFailure("RpcError", error.get("code") if isinstance(error, dict) else None)
        if "result" not in reply:
            raise RpcFailure("MalformedRpcResponse")
        return reply["result"]


class Rpc:
    def __init__(self, transport, records, max_calls, max_seconds, clock=time.monotonic):
        self.transport, self.records, self.max_calls = transport, records, max_calls
        self.clock = clock
        self.started = clock()
        self.deadline = self.started + max_seconds
        self.work_deadline = self.deadline - min(10, max_seconds / 4)

    def call(self, method, params, post=False):
        if method not in ALLOWED:
            raise ValueError("RPC method not permitted")
        remaining = (self.deadline if post else self.work_deadline) - self.clock()
        if len(self.records) >= self.max_calls - (0 if post else 2) or remaining <= 0:
            raise BudgetExceeded()
        record = {"id": "rpc-%06d" % (len(self.records) + 1), "method": method, "params": params, "observed_at_utc": utc()}
        self.records.append(record)
        try:
            result = self.transport(method, params, min(remaining, 20))
        except RpcFailure as error:
            record["error"] = {"type": error.kind, "code": error.code}
            raise
        except Exception:
            record["error"] = {"type": "TransportError", "code": None}
            raise RpcFailure("TransportError") from None
        record["result"] = result
        return result, record["id"]


def merge_ranges(ranges):
    result = []
    for lo, hi in sorted(ranges):
        if result and lo <= result[-1][1] + 1:
            result[-1][1] = max(hi, result[-1][1])
        else:
            result.append([lo, hi])
    return result


def missing_ranges(lo, hi, scanned):
    result, cursor = [], lo
    for start, stop in scanned:
        if cursor < start:
            result.append([cursor, start - 1])
        cursor = stop + 1
    if cursor <= hi:
        result.append([cursor, hi])
    return result


def header(value, number):
    if not isinstance(value, dict) or quantity(value.get("number")) != number:
        raise ValueError("invalid header")
    if not fixed_hex(value.get("hash"), 32) or not fixed_hex(value.get("parentHash"), 32):
        raise ValueError("invalid header hashes")
    return value


def decode_log(log, token, lo, hi, evidence_id):
    if not isinstance(log, dict) or not fixed_hex(log.get("address"), 20) or log["address"].lower() != token:
        raise ValueError("wrong emitter")
    topics = log.get("topics")
    if not isinstance(topics, list) or len(topics) != 3 or not all(fixed_hex(x, 32) for x in topics):
        raise ValueError("invalid topics")
    if topics[0].lower() != TRANSFER or any(x[2:26] != "0" * 24 for x in topics[1:]):
        raise ValueError("invalid transfer topics")
    if log.get("removed") is not False or not fixed_hex(log.get("data"), 32):
        raise ValueError("invalid transfer data")
    block = quantity(log.get("blockNumber"))
    if not lo <= block <= hi or not fixed_hex(log.get("blockHash"), 32) or not fixed_hex(log.get("transactionHash"), 32):
        raise ValueError("invalid log position")
    return {"evidence_id": evidence_id, "block_number": block, "block_hash": log["blockHash"].lower(),
            "transaction_hash": log["transactionHash"].lower(), "transaction_index": quantity(log.get("transactionIndex")),
            "log_index": quantity(log.get("logIndex")), "from": "0x" + topics[1][-40:].lower(),
            "to": "0x" + topics[2][-40:].lower(), "value_raw": str(int(log["data"], 16))}


def collect(transport, chain_id, token, from_block, to_block, chunk_size=1000, max_calls=300, max_seconds=120, clock=time.monotonic):
    if not fixed_hex(token, 20) or chain_id < 0 or from_block < 0 or to_block < from_block:
        raise ValueError("invalid chain, token, or range")
    if chunk_size < 1 or max_calls < 5 or max_seconds <= 0 or not math.isfinite(max_seconds):
        raise ValueError("chunk size and seconds must be positive; max calls must be at least 5")
    token = token.lower()
    packet = {"schema_version": "autopsy.evm-evidence.v1", "chain_id": chain_id, "token": token,
              "captured_at_utc": utc(), "requested_range": {"from_block": from_block, "to_block": to_block},
              "anchors": {"before": {"from": None, "to": None}, "after": {"from": None, "to": None}},
              "metadata": {"decimals": None, "total_supply_raw": None, "code": None},
              "coverage": {}, "records": [], "transfers": [], "diagnostics": []}
    rpc = Rpc(transport, packet["records"], max_calls, max_seconds, clock)
    scanned, seen, coordinates = [], {}, {}
    block_hashes, transactions, transaction_positions = {}, {}, {}
    anchor_conflict = False
    invalidated, anchor_status, correct_chain, received_log_response = False, "unverified", False, False
    diagnostics = packet["diagnostics"]
    diagnostic_index, suppressed = {}, None
    def diagnose(event):
        nonlocal suppressed
        key = json.dumps(event, sort_keys=True)
        if key in diagnostic_index:
            prior = diagnostic_index[key]
            prior["count"] = prior.get("count", 1) + 1
        elif len(diagnostic_index) < 100:
            diagnostic_index[key] = event
            diagnostics.append(event)
        else:
            if suppressed is None:
                suppressed = {"type": "AdditionalDiagnosticsSuppressed", "count": 0}
                diagnostics.append(suppressed)
            suppressed["count"] += 1

    def observe_block(number, block_hash, evidence_id):
        nonlocal invalidated
        block_hash = block_hash.lower()
        if number in block_hashes and block_hashes[number] != block_hash:
            invalidated = True
            diagnose({"type": "ConflictingBlockHash", "block_number": number, "evidence_id": evidence_id})
            return False
        block_hashes[number] = block_hash
        return True
    diagnose({"type": "ProviderLimitations", "detail": "Coverage describes RPC-returned standard ERC-20 Transfer logs in the selected interval only, not full launch or holder coverage. Silent provider truncation is not detectable in general. Two boundary header checks establish finite provider consistency, not cryptographic authenticity or finality. Metadata is queried at to_block; nonstandard tokens may require reconciliation."})
    try:
        actual, _ = rpc.call("eth_chainId", [])
        if quantity(actual) != chain_id:
            invalidated = True
            diagnose({"type": "ChainIdMismatch"})
        else:
            correct_chain = True
            for label, number in (("from", from_block), ("to", to_block)):
                result, evidence_id = rpc.call("eth_getBlockByNumber", [hex(number), False])
                packet["anchors"]["before"][label] = header(result, number)
                if not observe_block(number, result["hash"], evidence_id):
                    anchor_conflict = True
            for name, method, params in (
                ("code", "eth_getCode", [token, hex(to_block)]),
                ("decimals", "eth_call", [{"to": token, "data": "0x313ce567"}, hex(to_block)]),
                ("total_supply_raw", "eth_call", [{"to": token, "data": "0x18160ddd"}, hex(to_block)]),
            ):
                try:
                    value, _ = rpc.call(method, params)
                    if name == "code":
                        if not isinstance(value, str) or re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", value) is None:
                            raise ValueError("invalid code")
                        packet["metadata"][name] = value.lower()
                        if value == "0x":
                            diagnose({"type": "NoCodeAtEndBlock"})
                    else:
                        if not fixed_hex(value, 32) or (name == "decimals" and int(value, 16) > 255):
                            raise ValueError("invalid metadata")
                        packet["metadata"][name] = int(value, 16) if name == "decimals" else str(int(value, 16))
                except (RpcFailure, ValueError):
                    diagnose({"type": "MetadataUnavailable", "field": name})
                except BudgetExceeded:
                    diagnose({"type": "MetadataBudgetExhausted", "field": name})
                    break
            cursor, stack = from_block, []
            while stack or cursor <= to_block:
                if stack:
                    lo, hi = stack.pop()
                else:
                    lo, hi = cursor, min(to_block, cursor + chunk_size - 1)
                    cursor = hi + 1
                try:
                    logs, evidence_id = rpc.call("eth_getLogs", [{"address": token, "fromBlock": hex(lo), "toBlock": hex(hi), "topics": [TRANSFER]}])
                except RpcFailure:
                    if lo < hi:
                        middle = (lo + hi) // 2
                        stack.extend(((middle + 1, hi), (lo, middle)))
                    else:
                        diagnose({"type": "LogRangeUnavailable", "range": [lo, hi]})
                    continue
                except BudgetExceeded:
                    diagnose({"type": "LogBudgetExhausted"})
                    break
                received_log_response = True
                if not isinstance(logs, list):
                    diagnose({"type": "MalformedLogResponse", "evidence_id": evidence_id, "range": [lo, hi]})
                    continue
                valid, interrupted = True, False
                for item in logs:
                    if rpc.clock() >= rpc.work_deadline:
                        valid, interrupted = False, True
                        diagnose({"type": "LogDecodeBudgetExhausted", "evidence_id": evidence_id, "range": [lo, hi]})
                        break
                    try:
                        transfer = decode_log(item, token, lo, hi, evidence_id)
                    except (ValueError, TypeError):
                        valid = False
                        diagnose({"type": "MalformedLog", "evidence_id": evidence_id, "range": [lo, hi]})
                        continue
                    if not observe_block(transfer["block_number"], transfer["block_hash"], evidence_id):
                        valid = False
                    transaction = transfer["transaction_hash"]
                    tx_location = (transfer["block_number"], transfer["block_hash"], transfer["transaction_index"])
                    tx_position = (transfer["block_number"], transfer["transaction_index"])
                    if (transaction in transactions and transactions[transaction] != tx_location) or (tx_position in transaction_positions and transaction_positions[tx_position] != transaction):
                        invalidated, valid = True, False
                        diagnose({"type": "ConflictingTransactionPosition", "evidence_id": evidence_id})
                    else:
                        transactions[transaction] = tx_location
                        transaction_positions[tx_position] = transaction
                    identity = (transfer["block_hash"], transfer["transaction_hash"], transfer["log_index"])
                    position = (transfer["block_number"], transfer["log_index"])
                    comparable = {k: v for k, v in transfer.items() if k != "evidence_id"}
                    if (identity in seen and seen[identity] != comparable) or (position in coordinates and coordinates[position] != comparable):
                        invalidated, valid = True, False
                        diagnose({"type": "ConflictingDuplicateLog", "evidence_id": evidence_id})
                    elif identity not in seen:
                        seen[identity] = comparable
                        coordinates[position] = comparable
                        packet["transfers"].append(transfer)
                if valid:
                    scanned.append([lo, hi])
                if interrupted:
                    break
    except (RpcFailure, ValueError, BudgetExceeded):
        diagnose({"type": "PreflightUnavailable"})
    finally:
        if correct_chain:
            for label, number in (("from", from_block), ("to", to_block)):
                try:
                    result, evidence_id = rpc.call("eth_getBlockByNumber", [hex(number), False], post=True)
                    packet["anchors"]["after"][label] = header(result, number)
                    if not observe_block(number, result["hash"], evidence_id):
                        anchor_conflict = True
                except (RpcFailure, ValueError, BudgetExceeded):
                    diagnose({"type": "PostAnchorUnavailable", "boundary": label})
            before, after = packet["anchors"]["before"], packet["anchors"]["after"]
            comparable = [label for label in ("from", "to") if before[label] is not None and after[label] is not None]
            if anchor_conflict or any(before[label]["hash"].lower() != after[label]["hash"].lower() for label in comparable):
                invalidated, anchor_status = True, "changed"
                diagnose({"type": "AnchorChanged"})
            elif len(comparable) == 2:
                anchor_status = "verified"
    scanned = merge_ranges(scanned)
    missing = missing_ranges(from_block, to_block, scanned)
    status = "invalidated" if invalidated else ("complete" if not missing and anchor_status == "verified" else ("partial" if scanned or received_log_response else "unavailable"))
    packet["coverage"] = {"status": status, "scanned_ranges": scanned, "missing_ranges": missing, "anchor_status": anchor_status,
                          "reason": "Selected-range RPC retrieval only; inspect diagnostics and missing ranges. Complete does not prove an entire launch, finality, accurate balances, or absence of silent provider truncation. Invalidated packets must not support canonical findings."}
    packet["transfers"].sort(key=lambda row: (row["block_number"], row["transaction_index"], row["log_index"]))
    return packet


def write_packet(path, packet):
    """Publish a fully serialized packet atomically, without replacing any path."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".autopsy-", suffix=".tmp", delete=False) as output:
            temporary = output.name
            json.dump(packet, output, indent=2, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        # Same-filesystem hard link atomically creates the destination or fails
        # with FileExistsError; unlike rename(), it never overwrites a racer.
        os.link(temporary, path)
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-env", default="AUTOPSY_RPC_URL", help="Environment variable containing the RPC URL; the URL is never written to evidence")
    parser.add_argument("--chain-id", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--from-block", type=int, required=True)
    parser.add_argument("--to-block", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--chunk-size", type=int, default=1000)
    parser.add_argument("--max-calls", type=int, default=300)
    parser.add_argument("--max-seconds", type=float, default=120)
    args = parser.parse_args(argv)
    if args.out.exists():
        parser.error("output already exists; choose a new path")
    if not fixed_hex(args.token, 20) or args.chain_id < 0 or args.from_block < 0 or args.to_block < args.from_block:
        parser.error("provide a valid token address, nonnegative chain and blocks, and an ordered numeric range")
    if args.chunk_size < 1 or args.max_calls < 5 or not 0 < args.max_seconds < float("inf"):
        parser.error("chunk size and seconds must be positive; max calls must be at least 5")
    url = os.environ.get(args.rpc_env)
    try:
        if not url:
            raise ValueError("missing RPC environment variable")
        transport = HttpTransport(url)
    except ValueError:
        def transport(method, params, timeout):
            raise RpcFailure("RpcConfigurationUnavailable")
    packet = collect(transport, args.chain_id, args.token, args.from_block, args.to_block,
                     args.chunk_size, args.max_calls, args.max_seconds)
    try:
        write_packet(args.out, packet)
    except (OSError, ValueError):
        parser.exit(2, "Could not write evidence packet; check output directory and choose an unused path.\n")
    print(json.dumps({"status": packet["coverage"]["status"], "rpc_calls": len(packet["records"]), "transfer_count": len(packet["transfers"])}))
    return 0 if packet["coverage"]["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
