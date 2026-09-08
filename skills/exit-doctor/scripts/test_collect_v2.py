"""Synthetic RPC tests; never connect to a network or move funds."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import collect_v2 as c


def addr(n):
    return "0x%040x" % n


def abi(*values):
    return "0x" + "".join("%064x" % value for value in values)


def config(wallet=None):
    return {"chain_id": 1, "block_number": 100, "router": addr(1), "factory": addr(2),
            "pair": addr(3), "token_in": addr(4), "token_out": addr(5), "wallet": wallet,
            "amounts_in_raw": ["1000", "10000"], "deployment_evidence": "Synthetic fixture only"}


class Fixture:
    def __init__(self, cfg=None):
        self.cfg = cfg or config()
        self.calls = []
        self.header_count = 0
        self.chain = 1
        self.reorg = False
        self.reverse = self.cfg["token_in"] > self.cfg["token_out"]
        self.code = "0x6001600055"
        self.empty_role = None
        self.identity_bad = False
        self.balance_mismatch = False
        self.quote_bad = False
        self.sim_bad = False
        self.sim_error = None
        self.gas_error = False
        self.metadata_error = False
        self.wallet_balance = 1000000
        self.allowance = 1000000
        self.hash_unsupported = False
        self.after_error = False

    def __call__(self, method, params, timeout):
        self.calls.append((method, copy.deepcopy(params)))
        assert 0 < timeout <= 20
        if method == "eth_chainId":
            return hex(self.chain)
        if method == "eth_getBlockByNumber":
            self.header_count += 1
            if self.after_error and self.header_count > 1:
                raise c.RpcFailure("RpcError", -32001)
            changed = self.reorg and self.header_count > 1
            return {"number": "0x64", "hash": "0x" + ("b" if changed else "a") * 64, "timestamp": "0x3e8", "extra": "not retained"}
        if method == "eth_estimateGas":
            assert params[1] == "0x64"
            if self.gas_error:
                raise c.RpcFailure("RpcError", -32602)
            return hex(90000)
        assert params[-1] == {"blockHash": "0x" + "a" * 64, "requireCanonical": True}
        if self.hash_unsupported:
            raise c.RpcFailure("RpcError", -32602)
        if method == "eth_getCode":
            return "0x" if self.empty_role and params[0] == self.cfg[self.empty_role] else self.code
        if method == "eth_getBalance":
            return "0xde0b6b3a7640000"
        assert method == "eth_call"
        tx = params[0]
        address, data = tx["to"], tx["data"]
        selector = data[:10]
        if selector == "0xc45a0155":
            return abi(int(addr(9) if self.identity_bad else self.cfg["factory"], 16))
        if selector == "0xe6a43905":
            assert len(data) == 10 + 128
            assert data[10:74] == c.address_word(self.cfg["token_in"])
            assert data[74:] == c.address_word(self.cfg["token_out"])
            return abi(int(self.cfg["pair"], 16))
        if selector == "0x0dfe1681":
            return abi(int(min(self.cfg["token_in"], self.cfg["token_out"]), 16))
        if selector == "0xd21220a7":
            return abi(int(max(self.cfg["token_in"], self.cfg["token_out"]), 16))
        if selector == "0x0902f1ac":
            return abi(2000000, 1000000, 999) if self.reverse else abi(1000000, 2000000, 999)
        if selector == "0x313ce567":
            if self.metadata_error:
                raise c.RpcFailure("RpcError", -32000)
            return abi(6 if address == self.cfg["token_in"] else 18)
        if selector == "0x70a08231":
            if data[10:] == c.address_word(self.cfg["pair"]):
                return abi((1000000 if address == self.cfg["token_in"] else 2000000) + int(self.balance_mismatch))
            return abi(self.wallet_balance)
        if selector == "0xdd62ed3e":
            return abi(self.allowance)
        if selector in {"0xd06ca61f", "0x38ed1739"}:
            amount = int(data[10:74], 16)
            output = amount * 997 * 2000000 // (1000000 * 1000 + amount * 997)
            if selector == "0x38ed1739":
                assert tx["from"] == self.cfg["wallet"]
                assert tx["value"] == "0x0"
                if self.sim_error:
                    raise c.RpcFailure("RpcError", self.sim_error)
                return abi(32, 2, amount, output + int(self.sim_bad))
            return abi(32, 2, amount, output + int(self.quote_bad))
        raise AssertionError("unexpected selector: " + selector)


class AbiTests(unittest.TestCase):
    def test_quote_encoding(self):
        data = c.quote_calldata(123, addr(4), addr(5))
        self.assertEqual(data[:10], "0xd06ca61f")
        values = [int(data[i:i + 64], 16) for i in range(10, len(data), 64)]
        self.assertEqual(values, [123, 64, 2, 4, 5])

    def test_swap_encoding_offsets_deadline_recipient(self):
        data = c.swap_calldata(123, 99, addr(4), addr(5), addr(6), 1300)
        self.assertEqual(data[:10], "0x38ed1739")
        values = [int(data[i:i + 64], 16) for i in range(10, len(data), 64)]
        self.assertEqual(values, [123, 99, 160, 6, 1300, 2, 4, 5])

    def test_strict_return_shape(self):
        self.assertEqual(c.decode_amounts(abi(32, 2, 100, 199), 100), 199)
        for bad in [abi(64, 2, 100, 199), abi(32, 1, 100, 199), abi(32, 2, 101, 199), abi(32, 2, 100, 199, 0), "0x"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                c.decode_amounts(bad, 100)

    def test_address_padding(self):
        self.assertEqual(c.decode_address(abi(4)), addr(4))
        with self.assertRaises(ValueError):
            c.decode_address(abi(2 ** 160))

    def test_model_overflow_and_zero(self):
        self.assertEqual(c.model_output(1000, 1000000, 2000000), 1992)
        for args in [(0, 1, 1), (100, 0, 1), (c.UINT256, 2 ** 112 - 1, 2 ** 112 - 1)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                c.model_output(*args)


class CollectTests(unittest.TestCase):
    def run_fixture(self, fixture=None, cfg=None, **kwargs):
        fixture = fixture or Fixture(cfg)
        return c.collect(fixture, cfg or fixture.cfg, **kwargs)

    def test_complete_quotes_and_pins(self):
        fixture = Fixture()
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "complete")
        self.assertEqual(packet["quotes"][0]["amount_out_raw"], "1992")
        self.assertEqual(packet["quotes"][0]["min_output_raw"], "1972")
        self.assertEqual(packet["quotes"][0]["simulation"]["status"], "not_requested")
        self.assertTrue(packet["route"]["supported_math"])
        self.assertEqual(packet["route"]["deployment_verification"], "unverified")
        self.assertEqual(fixture.header_count, 2)
        self.assertEqual(set(method for method, _ in fixture.calls) - c.ALLOWED, set())
        self.assertNotIn("extra", json.dumps(packet))

    def test_token_orientation(self):
        cfg = config()
        cfg["token_in"], cfg["token_out"] = cfg["token_out"], cfg["token_in"]
        packet = self.run_fixture(cfg=cfg)
        self.assertEqual(packet["status"], "complete")
        self.assertEqual(packet["state"]["reserve_in_raw"], "1000000")
        self.assertEqual(packet["state"]["reserve_out_raw"], "2000000")
        self.assertEqual(packet["quotes"][0]["amount_out_raw"], "1992")

    def test_wrong_chain_stops(self):
        fixture = Fixture()
        fixture.chain = 2
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "invalidated")
        self.assertEqual(len(fixture.calls), 1)

    def test_identity_mismatch_invalidates(self):
        fixture = Fixture()
        fixture.identity_bad = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "invalidated")
        self.assertFalse(packet["route"]["identity_verified"])
        self.assertEqual(fixture.header_count, 2)

    def test_empty_code_invalidates(self):
        fixture = Fixture()
        fixture.empty_role = "router"
        self.assertEqual(self.run_fixture(fixture)["status"], "invalidated")

    def test_matched_hashes_only_all_five(self):
        cfg = config()
        fingerprint = hashlib.sha256(bytes.fromhex(Fixture().code[2:])).hexdigest()
        cfg["expected_code_sha256"] = {role: fingerprint for role in c.ADDRESSES}
        self.assertEqual(self.run_fixture(cfg=cfg)["route"]["deployment_verification"], "matched_config")
        del cfg["expected_code_sha256"]["token_out"]
        self.assertEqual(self.run_fixture(cfg=cfg)["route"]["deployment_verification"], "unverified")

    def test_hash_mismatch_invalidates(self):
        cfg = config()
        cfg["expected_code_sha256"] = {"pair": "0" * 64}
        packet = self.run_fixture(cfg=cfg)
        self.assertEqual(packet["status"], "invalidated")
        self.assertEqual(packet["route"]["deployment_verification"], "mismatch")

    def test_quote_model_disagreement(self):
        fixture = Fixture()
        fixture.quote_bad = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "invalidated")
        self.assertEqual(packet["quotes"][0]["amount_out_raw"], "1993")
        self.assertFalse(packet["route"]["supported_math"])

    def test_reserve_balance_mismatch_no_simulation(self):
        fixture = Fixture(config(addr(6)))
        fixture.balance_mismatch = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "partial")
        self.assertFalse(packet["route"]["reserve_balance_match"])
        self.assertFalse(packet["route"]["supported_math"])
        self.assertFalse(any(method == "eth_call" and params[0]["data"].startswith("0x38ed1739") for method, params in fixture.calls))

    def test_missing_decimals_remain_unknown(self):
        fixture = Fixture()
        fixture.metadata_error = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "partial")
        self.assertIsNone(packet["state"]["decimals_in"])
        self.assertEqual(packet["quotes"][0]["amount_out_raw"], "1992")

    def test_wallet_success_and_gas_height_anchor(self):
        fixture = Fixture(config(addr(6)))
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "complete")
        simulation = packet["quotes"][0]["simulation"]
        self.assertEqual(simulation["status"], "succeeded")
        self.assertEqual(simulation["gas_estimate_units"], "90000")
        self.assertEqual(simulation["amount_out_raw"], "1992")
        self.assertEqual(packet["wallet_state"]["native_balance_raw"], "1000000000000000000")
        self.assertIn("numeric_height", packet["gas_anchor_mode"])

    def test_balance_and_allowance_shortages(self):
        for field in ("wallet_balance", "allowance"):
            with self.subTest(field=field):
                fixture = Fixture(config(addr(6)))
                setattr(fixture, field, 999)
                packet = self.run_fixture(fixture)
                self.assertEqual(packet["quotes"][0]["simulation"]["status"], "prerequisite_missing")
                self.assertFalse(any(method == "eth_estimateGas" for method, _ in fixture.calls))

    def test_revert_vs_provider_error(self):
        for code, expected in ((3, "reverted"), (-32602, "unavailable")):
            with self.subTest(code=code):
                fixture = Fixture(config(addr(6)))
                fixture.sim_error = code
                packet = self.run_fixture(fixture)
                self.assertEqual(packet["quotes"][0]["simulation"]["status"], expected)
                self.assertIsNotNone(packet["quotes"][0]["simulation"]["evidence_id"])

    def test_simulation_quote_disagreement(self):
        fixture = Fixture(config(addr(6)))
        fixture.sim_bad = True
        self.assertEqual(self.run_fixture(fixture)["status"], "invalidated")

    def test_gas_failure_unknown_no_fallback(self):
        fixture = Fixture(config(addr(6)))
        fixture.gas_error = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["quotes"][0]["simulation"]["status"], "succeeded")
        self.assertIsNone(packet["quotes"][0]["simulation"]["gas_estimate_units"])
        self.assertEqual(sum(method == "eth_estimateGas" for method, _ in fixture.calls), 2)

    def test_reorg_invalidates(self):
        fixture = Fixture()
        fixture.reorg = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "invalidated")
        self.assertNotEqual(packet["block"]["hash"], packet["block"]["after_hash"])

    def test_no_hash_selector_fallback(self):
        fixture = Fixture()
        fixture.hash_unsupported = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "unavailable")
        self.assertEqual(sum(method == "eth_getCode" for method, _ in fixture.calls), 1)

    def test_call_budget_reserves_postanchor(self):
        fixture = Fixture()
        packet = self.run_fixture(fixture, max_calls=5)
        self.assertEqual(len(fixture.calls), 5)
        self.assertEqual(fixture.calls[-1][0], "eth_getBlockByNumber")
        self.assertEqual(packet["status"], "unavailable")
        self.assertTrue(any(d["type"] == "BudgetExhausted" for d in packet["diagnostics"]))

    def test_wall_budget_reserves_postanchor(self):
        fixture = Fixture()
        elapsed = [0]
        def transport(method, params, timeout):
            value = fixture(method, params, timeout)
            elapsed[0] += 1
            return value
        packet = c.collect(transport, fixture.cfg, max_seconds=4, clock=lambda: elapsed[0])
        self.assertEqual(packet["status"], "unavailable")
        self.assertEqual(fixture.calls[-1][0], "eth_getBlockByNumber")
        self.assertLessEqual(len(fixture.calls), 4)

    def test_missing_postanchor_cannot_complete(self):
        fixture = Fixture()
        fixture.after_error = True
        packet = self.run_fixture(fixture)
        self.assertEqual(packet["status"], "partial")
        self.assertIsNone(packet["block"]["after_hash"])

    def test_errors_and_malformed_text_sanitized(self):
        secret = "https://user:password@host/rpc?key=secret"
        def malformed(method, params, timeout):
            return secret
        packet = self.run_fixture(malformed, config())
        self.assertNotIn(secret, json.dumps(packet))
        def error(method, params, timeout):
            raise RuntimeError(secret)
        packet = self.run_fixture(error, config())
        self.assertNotIn(secret, json.dumps(packet))


class InputAndTransportTests(unittest.TestCase):
    def test_nonfinite_duplicate_json_rejected(self):
        for raw in ('{"x":NaN}', '{"x":Infinity}', '{"x":1e999}', '{"x":1,"x":2}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                c.strict_json(raw)

    def test_config_caps_types_and_amounts(self):
        for field, value in [("chain_id", True), ("block_number", -1), ("amounts_in_raw", ["0"]),
                             ("amounts_in_raw", ["01"]), ("amounts_in_raw", ["1", "1"]),
                             ("amounts_in_raw", [str(x) for x in range(1, 22)]),
                             ("slippage_bps", 10000), ("slippage_bps", True), ("wallet", "bad")]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                cfg = config()
                cfg[field] = value
                c.validate_config(cfg)

    def test_forbidden_methods(self):
        rpc = c.Rpc(lambda *args: None, [], 100, 120, lambda: 0)
        for method in ("eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "evm_mine"):
            with self.subTest(method=method), self.assertRaises(ValueError):
                rpc.call(method, [])

    def test_no_overwrite_and_atomic_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "evidence.json"
            c.write_packet(path, {"first": True})
            with self.assertRaises(FileExistsError):
                c.write_packet(path, {"first": False})
            self.assertEqual(json.loads(path.read_text()), {"first": True})
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["evidence.json"])
            with self.assertRaises(ValueError):
                c.write_packet(Path(tmp) / "bad.json", {"x": float("nan")})
            self.assertFalse((Path(tmp) / "bad.json").exists())

    def test_transport_response_limits_and_errors(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.close()
        for raw, expected in [(b"x" * (c.MAX_RESPONSE + 1), "ResponseTooLarge"),
                              (b'{"jsonrpc":"2.0","id":1,"result":NaN}', "TransportError"),
                              (b'{"jsonrpc":"2.0","id":true,"result":"0x1"}', "MalformedRpcResponse"),
                              (b'{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"secret"}}', "RpcError")]:
            with self.subTest(expected=expected), patch("urllib.request.urlopen", return_value=Response(raw)):
                transport = c.HttpTransport("https://example.invalid/private-key")
                with self.assertRaises(c.RpcFailure) as caught:
                    transport.request("eth_chainId", [], 1)
                self.assertEqual(caught.exception.kind, expected)
                self.assertNotIn("secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
