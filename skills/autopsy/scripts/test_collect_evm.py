#!/usr/bin/env python3
"""Offline adversarial tests: python -m unittest discover -s scripts -p 'test_*.py'."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import collect_evm as c

TOKEN = "0x" + "12" * 20
SENDER = "0x" + "34" * 20
RECEIVER = "0x" + "56" * 20
BIG = 2 ** 200 + 123


def block_hash(number):
    return "0x" + format(number + 100, "064x")


def log(number=10, value=BIG, index=0):
    return {"address": TOKEN, "topics": [c.TRANSFER, "0x" + "0" * 24 + SENDER[2:], "0x" + "0" * 24 + RECEIVER[2:]],
            "data": "0x" + format(value, "064x"), "blockNumber": hex(number), "blockHash": block_hash(number),
            "transactionHash": "0x" + format(number + 1000, "064x"), "transactionIndex": "0x0", "logIndex": hex(index), "removed": False}


class FakeRpc:
    def __init__(self, logs=None):
        self.logs = logs or []
        self.calls = []
        self.log_handler = None
        self.header_calls = {}
        self.change_anchor = False
        self.fail_post = False
        self.chain = 1

    def __call__(self, method, params, timeout):
        self.calls.append((method, params, timeout))
        if method == "eth_chainId":
            return hex(self.chain)
        if method == "eth_getBlockByNumber":
            number = int(params[0], 16)
            self.header_calls[number] = self.header_calls.get(number, 0) + 1
            if self.fail_post and self.header_calls[number] > 1:
                raise c.RpcFailure("RpcError", -32000)
            changed = self.change_anchor and self.header_calls[number] > 1
            return {"number": hex(number), "hash": block_hash(number + int(changed)), "parentHash": block_hash(number - 1)}
        if method == "eth_getCode":
            return "0x60006000"
        if method == "eth_call":
            return "0x" + format(18 if params[0]["data"] == "0x313ce567" else BIG * 10, "064x")
        if method == "eth_getLogs":
            lo, hi = int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)
            if self.log_handler:
                return self.log_handler(lo, hi)
            return [copy.deepcopy(item) for item in self.logs if lo <= int(item["blockNumber"], 16) <= hi]
        raise AssertionError("unexpected method")


class CollectionTests(unittest.TestCase):
    def run_collector(self, rpc, **kwargs):
        return c.collect(rpc, 1, TOKEN, 10, 13, **kwargs)

    def test_exact_large_integers_metadata_and_evidence_links(self):
        rpc = FakeRpc([log()])
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "complete")
        self.assertEqual(result["coverage"]["scanned_ranges"], [[10, 13]])
        self.assertEqual(result["coverage"]["missing_ranges"], [])
        self.assertEqual(result["metadata"]["total_supply_raw"], str(BIG * 10))
        self.assertEqual(result["transfers"][0]["value_raw"], str(BIG))
        self.assertEqual(result["transfers"][0]["from"], SENDER)
        evidence = {record["id"]: record for record in result["records"]}
        self.assertEqual(evidence[result["transfers"][0]["evidence_id"]]["method"], "eth_getLogs")
        self.assertTrue(set(method for method, _, _ in rpc.calls) <= c.ALLOWED)
        self.assertIn("Silent provider truncation", result["diagnostics"][0]["detail"])

    def test_adaptive_split_recovers_provider_range_limit(self):
        rpc = FakeRpc()
        def limited(lo, hi):
            if hi - lo + 1 > 2:
                raise c.RpcFailure("RpcError", -32005)
            return [log(lo)]
        rpc.log_handler = limited
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "complete")
        self.assertEqual([x["block_number"] for x in result["transfers"]], [10, 12])
        self.assertEqual([x["error"] for x in result["records"] if "error" in x], [{"type": "RpcError", "code": -32005}])

    def test_wrong_chain_stops_before_token_requests(self):
        rpc = FakeRpc()
        rpc.chain = 2
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "invalidated")
        self.assertEqual(len(rpc.calls), 1)
        self.assertEqual(result["transfers"], [])

    def test_changed_anchor_invalidates_retained_transfers(self):
        rpc = FakeRpc([log()])
        rpc.change_anchor = True
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "invalidated")
        self.assertEqual(result["coverage"]["anchor_status"], "changed")
        self.assertEqual(len(result["transfers"]), 1)

    def test_partial_when_post_anchor_unavailable(self):
        rpc = FakeRpc()
        rpc.fail_post = True
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "partial")
        self.assertEqual(result["coverage"]["anchor_status"], "unverified")

    def test_malformed_logs_never_silently_count_as_scanned(self):
        mutations = [lambda x: x.update(removed=True), lambda x: x.update(address=SENDER),
                     lambda x: x.update(data="0x01"), lambda x: x.update(blockNumber="0x010"),
                     lambda x: x["topics"].append("0x" + "00" * 32),
                     lambda x: x.update(transactionHash="0x12"), lambda x: x.pop("removed")]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                bad = log()
                mutate(bad)
                rpc = FakeRpc()
                rpc.log_handler = lambda lo, hi: [bad]
                result = self.run_collector(rpc)
                self.assertEqual(result["coverage"]["status"], "partial")
                self.assertEqual(result["coverage"]["missing_ranges"], [[10, 13]])
                self.assertEqual(result["transfers"], [])

    def test_wrong_response_type_and_out_of_range_log(self):
        for response in ({"logs": []}, [log(20)]):
            rpc = FakeRpc()
            rpc.log_handler = lambda lo, hi: response
            result = self.run_collector(rpc)
            self.assertEqual(result["coverage"]["status"], "partial")
            self.assertEqual(result["coverage"]["scanned_ranges"], [])

    def test_duplicate_logs_deduplicate_and_conflicts_invalidate(self):
        rpc = FakeRpc([log(), log()])
        result = self.run_collector(rpc)
        self.assertEqual(len(result["transfers"]), 1)
        self.assertEqual(result["coverage"]["status"], "complete")
        rpc = FakeRpc([log(), log(value=BIG + 1)])
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "invalidated")

    def test_log_anchor_mismatch_invalidates(self):
        bad = log()
        bad["blockHash"] = block_hash(999)
        result = self.run_collector(FakeRpc([bad]))
        self.assertEqual(result["coverage"]["status"], "invalidated")

    def test_cross_log_block_and_transaction_contradictions_invalidate(self):
        variants = []
        a, b = log(11), log(11, index=1)
        b["blockHash"] = block_hash(999)
        variants.append([a, b])
        a, b = log(11), log(12)
        b["transactionHash"] = a["transactionHash"]
        variants.append([a, b])
        a, b = log(11), log(11, index=1)
        b["transactionIndex"] = "0x1"
        variants.append([a, b])
        a, b = log(11), log(11, index=1)
        b["transactionHash"] = block_hash(999)
        variants.append([a, b])
        for rows in variants:
            with self.subTest(rows=rows):
                result = self.run_collector(FakeRpc(rows))
                self.assertEqual(result["coverage"]["status"], "invalidated")

    def test_single_block_flapping_boundaries_cannot_verify(self):
        class FlappingRpc(FakeRpc):
            def __call__(self, method, params, timeout):
                result = super().__call__(method, params, timeout)
                if method == "eth_getBlockByNumber" and self.header_calls[10] % 2 == 0:
                    result["hash"] = block_hash(999)
                return result
        result = c.collect(FlappingRpc(), 1, TOKEN, 10, 10)
        self.assertEqual(result["coverage"]["status"], "invalidated")
        self.assertEqual(result["coverage"]["anchor_status"], "changed")

    def test_decode_budget_and_repeated_diagnostics_are_bounded(self):
        rpc, now = FakeRpc(), [0.0]
        rpc.log_handler = lambda lo, hi: [None] * 200_000
        def ticking_clock():
            now[0] += 0.001
            return now[0]
        with patch.object(c, "decode_log", wraps=c.decode_log) as decode:
            result = self.run_collector(rpc, max_seconds=0.05, clock=ticking_clock)
        self.assertLess(decode.call_count, 100)
        self.assertLess(len(result["diagnostics"]), 10)
        self.assertTrue(any(x["type"] == "MalformedLog" and x["count"] > 1 for x in result["diagnostics"]))
        self.assertTrue(any(x["type"] == "LogDecodeBudgetExhausted" for x in result["diagnostics"]))
        self.assertEqual(result["coverage"]["missing_ranges"], [[10, 13]])
        self.assertEqual(result["coverage"]["anchor_status"], "verified")
        self.assertEqual(result["coverage"]["status"], "partial")

    def test_nonfinite_rpc_json_numbers_are_rejected(self):
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return self.body
        for literal in ("NaN", "Infinity", "-Infinity", "1e999"):
            transport = c.HttpTransport("https://offline.invalid")
            response = Response(('{"jsonrpc":"2.0","id":1,"result":' + literal + '}').encode())
            with self.subTest(literal=literal), patch("urllib.request.urlopen", return_value=response):
                with self.assertRaises(c.RpcFailure):
                    transport.request("eth_chainId", [], 1)

    def test_atomic_write_failure_leaves_no_output_or_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "packet.json"
            with self.assertRaises(ValueError):
                c.write_packet(output, {"begins_valid": [1, 2], "invalid": float("nan")})
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_atomic_write_never_replaces_racing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "packet.json"
            output.write_text("original")
            with self.assertRaises(FileExistsError):
                c.write_packet(output, {"replacement": True})
            self.assertEqual(output.read_text(), "original")
            self.assertEqual(list(Path(directory).iterdir()), [output])

    def test_per_block_failure_leaves_exact_missing_range(self):
        rpc = FakeRpc()
        def unavailable_middle(lo, hi):
            if lo <= 11 <= hi:
                raise c.RpcFailure("RpcError", -32000)
            return []
        rpc.log_handler = unavailable_middle
        result = self.run_collector(rpc)
        self.assertEqual(result["coverage"]["status"], "partial")
        self.assertEqual(result["coverage"]["scanned_ranges"], [[10, 10], [12, 13]])
        self.assertEqual(result["coverage"]["missing_ranges"], [[11, 11]])

    def test_call_budget_reserves_post_anchor_verification(self):
        rpc = FakeRpc()
        def fail(lo, hi):
            raise c.RpcFailure("RpcError", -32005)
        rpc.log_handler = fail
        result = self.run_collector(rpc, max_calls=10)
        self.assertEqual(len(rpc.calls), 10)
        self.assertEqual([x[0] for x in rpc.calls[-2:]], ["eth_getBlockByNumber"] * 2)
        self.assertEqual(result["coverage"]["anchor_status"], "verified")
        self.assertEqual(result["coverage"]["status"], "unavailable")

    def test_time_budget_reserves_time_and_stops_work(self):
        rpc = FakeRpc()
        now = [0.0]
        def transport(method, params, timeout):
            now[0] += min(1, timeout)
            return rpc(method, params, timeout)
        result = self.run_collector(transport, max_seconds=7, clock=lambda: now[0])
        self.assertLessEqual(now[0], 7)
        self.assertEqual(result["coverage"]["anchor_status"], "verified")
        self.assertEqual(result["coverage"]["status"], "unavailable")

    def test_transport_exception_does_not_expose_secrets(self):
        def failure(method, params, timeout):
            raise RuntimeError("https://username:SECRET@provider.invalid?key=SECRET")
        result = self.run_collector(failure)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(result["coverage"]["status"], "unavailable")
        self.assertEqual(result["records"][0]["error"], {"type": "TransportError", "code": None})

    def test_http_transport_has_overall_request_deadline(self):
        transport = c.HttpTransport("https://example.invalid")
        def delayed(*args):
            time.sleep(0.15)
            return 1
        with patch.object(transport, "request", side_effect=delayed):
            with self.assertRaises(c.RpcFailure) as caught:
                transport("eth_chainId", [], 0.01)
        self.assertEqual(caught.exception.kind, "RequestDeadlineExceeded")

    def test_missing_rpc_writes_failure_packet_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "evidence.json"
            args = ["--chain-id", "1", "--token", TOKEN, "--from-block", "10", "--to-block", "13", "--out", str(output), "--rpc-env", "AUTOPSY_OFFLINE_TEST_MISSING"]
            with patch.dict("os.environ", {}, clear=True), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(c.main(args), 2)
            original = output.read_bytes()
            self.assertEqual(json.loads(original)["coverage"]["status"], "unavailable")
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                c.main(args)
            self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
