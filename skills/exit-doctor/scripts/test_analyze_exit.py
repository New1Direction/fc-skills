import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from fractions import Fraction

from analyze_exit import analyze, human, main, read_json, write_new_json
from v2_math import amount_out, apply_sell


def encoded(a, b):
    return "0x" + "".join(f"{x:064x}" for x in [32, 2, a, b])


def calldata(selector, values):
    return selector + "".join(f"{x:064x}" for x in values)


def add_simulation(packet, index=0):
    q, route = packet["quotes"][index], packet["route"]
    wallet = "0x" + "06" * 20
    packet["wallet_state"] = {"address": wallet, "balance_in_raw": str(10**30), "allowance_raw": str(10**30)}
    for other in packet["quotes"]:
        if other is not q:
            other["simulation"]["status"] = "unavailable"
    anchor = {"blockHash": packet["block"]["hash"], "requireCanonical": True}
    for field, data in [("balance_in_raw", calldata("0x70a08231", [int(wallet, 16)])),
                        ("allowance_raw", calldata("0xdd62ed3e", [int(wallet, 16), int(route["router"], 16)]))]:
        rid = "wallet-" + field
        packet["records"].append({"id": rid, "method": "eth_call", "params": [{"to": route["token_in"], "data": data}, anchor], "result": calldata("0x", [10**30])})
        packet["wallet_state"][field + "_evidence_id"] = rid
    tx = {"from": wallet, "to": route["router"], "value": "0x0", "data": calldata("0x38ed1739", [int(q["amount_in_raw"]), int(q["min_output_raw"]), 160,
          int(wallet, 16), packet["block"]["timestamp"] + 300, 2, int(route["token_in"], 16), int(route["token_out"], 16)])}
    record = {"id": "sim", "method": "eth_call", "params": [tx, {"blockHash": packet["block"]["hash"], "requireCanonical": True}],
              "result": encoded(int(q["amount_in_raw"]), int(q["amount_out_raw"]))}
    packet["records"].append(record)
    q["simulation"] = {"status": "succeeded", "amount_out_raw": q["amount_out_raw"], "evidence_id": "sim"}
    return tx


def state_evidence(packet):
    block, route, state = packet["block"], packet["route"], packet["state"]
    anchor = {"blockHash": block["hash"], "requireCanonical": True}
    def record(rid, method, params, result):
        packet["records"].append({"id": rid, "method": method, "params": params, "result": result})
    def call(rid, recipient, data, values):
        record(rid, "eth_call", [{"to": recipient, "data": data}, anchor], calldata("0x", values))
    record("chain", "eth_chainId", [], hex(packet["chain_id"]))
    for rid in ["before", "after"]:
        record(rid, "eth_getBlockByNumber", [hex(block["number"]), False], {"number": hex(block["number"]), "hash": block["hash"], "timestamp": hex(block["timestamp"])})
    block.update(evidence_id="before", after_evidence_id="after")
    code = "0x6001600055"
    digest = hashlib.sha256(bytes.fromhex(code[2:])).hexdigest()
    roles = ["router", "factory", "pair", "token_in", "token_out"]
    route["code_sha256"] = {role: digest for role in roles}
    route["expected_code_sha256"] = dict(route["code_sha256"])
    for role in roles:
        record("code-" + role, "eth_getCode", [route[role], anchor], code)
    for role in ["router", "pair"]:
        call(role + "-factory", route[role], "0xc45a0155", [int(route["factory"], 16)])
    call("get-pair", route["factory"], calldata("0xe6a43905", [int(route["token_in"], 16), int(route["token_out"], 16)]), [int(route["pair"], 16)])
    route["token0"], route["token1"] = route["token_in"], route["token_out"]
    call("token0", route["pair"], "0x0dfe1681", [int(route["token0"], 16)])
    call("token1", route["pair"], "0xd21220a7", [int(route["token1"], 16)])
    call("reserves", route["pair"], "0x0902f1ac", [int(state["reserve_in_raw"]), int(state["reserve_out_raw"]), 999])
    state["reserves_evidence_id"] = "reserves"
    for side in ["in", "out"]:
        call("dec-" + side, route["token_" + side], "0x313ce567", [state["decimals_" + side]])
        state["decimals_" + side + "_evidence_id"] = "dec-" + side
        call("balance-" + side, route["token_" + side], calldata("0x70a08231", [int(route["pair"], 16)]), [int(state["balance_" + side + "_raw"])])
        state["balance_" + side + "_evidence_id"] = "balance-" + side
    return packet


def fixture():
    ri, ro = 10**24, 2 * 10**12
    quotes, records = [], []
    for i, amount in enumerate([10**20, 10**22, 10**23]):
        out = amount_out(amount, ri, ro)
        eid = f"quote-{i}"
        records.append({"id": eid, "method": "eth_call", "params": [{"to": "0x" + "01" * 20,
                        "data": calldata("0xd06ca61f", [amount, 64, 2, int("04" * 20, 16), int("05" * 20, 16)])},
                        {"blockHash": "0x" + "ab" * 32, "requireCanonical": True}], "result": encoded(amount, out)})
        quotes.append({"amount_in_raw": str(amount), "amount_out_raw": str(out), "quote_evidence_id": eid,
                       "min_output_raw": str(out * 99 // 100), "simulation": {"status": "not_requested", "amount_out_raw": None}})
    return state_evidence({"schema_version": "exit-doctor.v2-evidence.v1", "status": "complete", "chain_id": 1,
            "block": {"number": 100, "hash": "0x" + "ab" * 32, "timestamp": 1780000000, "after_hash": "0x" + "ab" * 32},
            "route": {"router": "0x" + "01" * 20, "factory": "0x" + "02" * 20, "pair": "0x" + "03" * 20,
                      "token_in": "0x" + "04" * 20, "token_out": "0x" + "05" * 20, "fee_bps": 30,
                      "deployment_verification": "matched_config", "identity_verified": True,
                      "reserve_balance_match": True, "supported_math": True},
            "state": {"reserve_in_raw": str(ri), "reserve_out_raw": str(ro), "balance_in_raw": str(ri),
                      "balance_out_raw": str(ro), "decimals_in": 18, "decimals_out": 6},
            "quotes": quotes, "records": records, "captured_at_utc": "2026-06-01T00:00:00Z", "diagnostics": []})


def costs(packet):
    return {"schema_version": "exit-doctor.costs.v1", "chain_id": 1, "token_out": packet["route"]["token_out"],
            "entries": [{"amount_in_raw": q["amount_in_raw"], "amount_out_cost_raw": "2000000", "status": "known",
                         "unit": "output_token_raw", "includes_pool_fee": False, "source": "assumed $2 total gas and extra charges; output token dollar peg assumed",
                         "coverage": "all_additional_costs", "evidence_ids": []} for q in packet["quotes"]]}


class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.packet = fixture()

    def report(self, **kwargs):
        return analyze(self.packet, "a" * 64, **kwargs)

    def test_missing_costs_do_not_become_zero(self):
        row = self.report()["independent_size_curve"][0]
        self.assertIsNone(row["estimated_net_proceeds_raw"])
        self.assertEqual(row["cost_status"], "unknown")
        self.assertEqual(row["evidence_level"], "router_quoted")

    def test_costs_never_resubtract_embedded_fee(self):
        row = self.report(costs=costs(self.packet))["independent_size_curve"][0]
        self.assertEqual(int(row["estimated_net_proceeds_raw"]), int(row["amount_out_router_quoted_raw"]) - 2000000)
        self.assertEqual(row["pool_fee_bps_already_embedded"], 30)

    def test_mixed_decimal_units_exact(self):
        report = self.report()
        spot = report["spot_output_tokens_per_input_token"]
        self.assertEqual(Fraction(int(spot["numerator"]), int(spot["denominator"])), 2)
        self.assertEqual(report["independent_size_curve"][0]["amount_in_tokens"], "100.000000000000000000")
        self.assertEqual(human(9007199254740993, 6), "9007199254.740993")

    def test_missing_decimals_do_not_guess(self):
        self.packet["state"]["decimals_out"] = None
        report = self.report()
        self.assertIsNone(report["spot_output_tokens_per_input_token"])
        self.assertIsNone(report["independent_size_curve"][0]["amount_out_modeled_tokens"])

    def test_cost_dimensions_and_completeness(self):
        for key, value in [("unit", "wei"), ("includes_pool_fee", True), ("coverage", "gas_only")]:
            c = costs(self.packet)
            c["entries"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.report(costs=c)
        c = costs(self.packet)
        c["token_out"] = self.packet["route"]["token_in"]
        with self.assertRaises(ValueError):
            self.report(costs=c)

    def test_unknown_cost_remains_unknown(self):
        c = costs(self.packet)
        c["entries"][0].update(status="unknown", amount_out_cost_raw=None)
        self.assertIsNone(self.report(costs=c)["independent_size_curve"][0]["estimated_net_proceeds_raw"])

    def test_uncovered_size_unknown(self):
        c = costs(self.packet)
        c["entries"] = c["entries"][:1]
        self.assertIsNone(self.report(costs=c)["independent_size_curve"][1]["estimated_net_proceeds_raw"])

    def test_invalidated_unavailable_and_changed_anchor(self):
        for status in ["invalidated", "unavailable"]:
            self.packet["status"] = status
            with self.assertRaises(ValueError):
                self.report()
        self.packet["status"] = "partial"
        self.packet["block"]["after_hash"] = "0x" + "cd" * 32
        with self.assertRaises(ValueError):
            self.report()

    def test_mismatch_and_unverified_route(self):
        self.packet["route"]["deployment_verification"] = "mismatch"
        with self.assertRaises(ValueError):
            self.report()
        self.packet["route"]["deployment_verification"] = "unverified"
        self.packet["route"]["expected_code_sha256"] = {}
        self.assertTrue(any("unverified" in text for text in self.report()["limitations"]))
        self.packet["route"]["identity_verified"] = False
        with self.assertRaises(ValueError):
            self.report()

    def test_balance_reserve_difference_rejected(self):
        self.packet["state"]["balance_out_raw"] = "1"
        with self.assertRaises(ValueError):
            self.report()

    def test_model_quote_disagreement(self):
        self.packet["quotes"][0]["amount_out_raw"] = "1"
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.report()

    def test_raw_evidence_binding(self):
        self.packet["records"][0]["result"] = encoded(10**20, 1)
        with self.assertRaisesRegex(ValueError, "retained raw"):
            self.report()

    def test_missing_evidence_id(self):
        self.packet["quotes"][0]["quote_evidence_id"] = "missing"
        with self.assertRaises(ValueError):
            self.report()

    def test_router_simulation_is_not_balance_delta(self):
        add_simulation(self.packet)
        row = self.report()["independent_size_curve"][0]
        self.assertEqual(row["evidence_level"], "router_call_simulated")
        self.assertFalse(row["wallet_balance_delta_independently_measured"])
        self.assertIsNone(row["estimated_net_proceeds_raw"])

    def test_reverted_simulation_has_no_net(self):
        from collect_v2 import collect
        from test_collect_v2 import Fixture, config, addr
        cfg = config(addr(6))
        provider = Fixture(cfg)
        provider.sim_error = 3
        self.packet = collect(provider, cfg)
        row = self.report(costs=costs(self.packet))["independent_size_curve"][0]
        self.assertEqual(row["evidence_level"], "router_quoted")
        self.assertIsNone(row["estimated_net_proceeds_raw"])

    def test_revert_cannot_be_relabelled_or_hidden(self):
        from collect_v2 import collect
        from test_collect_v2 import Fixture, config, addr
        cfg = config(addr(6))
        provider = Fixture(cfg)
        provider.sim_error = 3
        original = collect(provider, cfg)
        for status in ["not_requested", "unavailable", "prerequisite_missing", "succeeded"]:
            for remove_reference in [False, True]:
                self.packet = copy.deepcopy(original)
                sim = self.packet["quotes"][0]["simulation"]
                sim["status"] = status
                if remove_reference:
                    sim["evidence_id"] = None
                with self.subTest(status=status, remove_reference=remove_reference), self.assertRaises(ValueError):
                    self.report(costs=costs(self.packet))

    def test_native_prerequisite_and_unavailable_statuses(self):
        from collect_v2 import collect
        from test_collect_v2 import Fixture, config, addr
        for reason in ["allowance", "rpc_unavailable", "malformed_result"]:
            cfg = config(addr(6))
            provider = Fixture(cfg)
            if reason == "allowance":
                provider.allowance = 0
            elif reason == "rpc_unavailable":
                provider.sim_error = -32000
            else:
                base = provider
                def provider(method, params, timeout):
                    if method == "eth_call" and params[0]["data"].startswith("0x38ed1739"):
                        return "0x1234"
                    return base(method, params, timeout)
            self.packet = collect(provider, cfg)
            with self.subTest(reason=reason):
                report = self.report()
                self.assertIsNone(report["independent_size_curve"][0]["estimated_net_proceeds_raw"])
        self.packet = fixture()
        add_simulation(self.packet)
        self.packet["quotes"][0]["simulation"] = {"status": "prerequisite_missing", "amount_out_raw": None}
        with self.assertRaises(ValueError):
            self.report()

    def test_gas_units_not_costs(self):
        tx = add_simulation(self.packet)
        sim = self.packet["quotes"][0]["simulation"]
        sim.update(gas_estimate_units="100000", gas_evidence_id="gas")
        self.packet["records"].append({"id": "gas", "method": "eth_estimateGas", "params": [tx, hex(100)], "result": hex(100000)})
        self.assertIsNone(self.report()["independent_size_curve"][0]["estimated_net_proceeds_raw"])

    def test_quote_cannot_be_relabelled_as_simulation(self):
        q = self.packet["quotes"][0]
        self.packet["wallet_state"] = {"address": "0x" + "06" * 20}
        q["simulation"] = {"status": "succeeded", "amount_out_raw": q["amount_out_raw"], "evidence_id": q["quote_evidence_id"]}
        with self.assertRaises(ValueError):
            self.report()

    def test_call_request_binds_route_amount_and_block(self):
        for change in ["router", "block", "canonical", "data"]:
            original = copy.deepcopy(self.packet)
            params = self.packet["records"][0]["params"]
            if change == "router":
                params[0]["to"] = self.packet["route"]["pair"]
            elif change == "block":
                params[1]["blockHash"] = "0x" + "ff" * 32
            elif change == "canonical":
                params[1]["requireCanonical"] = False
            else:
                params[0]["data"] = params[0]["data"][:-1] + "0"
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.report()
            self.packet = original

    def test_synthetic_provenance_survives(self):
        self.packet.update(source_kind="synthetic", fixture_notice="Offline synthetic data; no live capture.")
        report = self.report()
        self.assertEqual(report["source_kind"], "synthetic")
        self.assertEqual(report["source_fixture_notice_untrusted_text"], self.packet["fixture_notice"])

    def test_forged_decimals_rejected(self):
        self.packet["state"]["decimals_out"] = 18
        with self.assertRaisesRegex(ValueError, "decimals"):
            self.report()

    def test_deleted_underlying_state_records_rejected(self):
        self.packet["records"] = self.packet["records"][:3]
        with self.assertRaises(ValueError):
            self.report()

    def test_code_hash_and_config_claims_bound(self):
        self.packet["route"]["code_sha256"]["router"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.report()

    def test_block_observations_must_be_distinct(self):
        self.packet["block"]["after_evidence_id"] = self.packet["block"]["evidence_id"]
        with self.assertRaisesRegex(ValueError, "distinct"):
            self.report()

    def test_native_collector_packet_integration(self):
        from collect_v2 import collect
        from test_collect_v2 import Fixture, config, addr
        for wallet in [None, addr(6)]:
            cfg = config(wallet)
            data = collect(Fixture(cfg), cfg)
            report = analyze(data, "0" * 64)
            self.assertEqual(report["source_status"], "complete")
            self.assertEqual(report["independent_size_curve"][0]["amount_out_router_quoted_raw"], "1992")

    def test_threshold_is_largest_tested_not_global(self):
        report = self.report(max_impact_bps="150")
        self.assertEqual(report["threshold"]["largest_tested_amount_in_raw"], str(10**22))
        self.assertFalse(report["threshold"]["is_global_optimum"])

    def test_each_curve_size_uses_fresh_pool(self):
        a = self.report()["independent_size_curve"][-1]
        self.packet["quotes"] = self.packet["quotes"][-1:]
        b = self.report()["independent_size_curve"][0]
        self.assertEqual(a, b)

    def test_prior_sale_applied_before_user_sale(self):
        scenario = {"schema_version": "exit-doctor.scenarios.v1", "entries": [{"id": "whale", "type": "prior_sell", "amount_in_raw": str(10**23)}]}
        report = self.report(scenarios=scenario)
        sc = report["scenarios"][0]
        _, ni, no = apply_sell(10**23, 10**24, 2 * 10**12)
        actual = int(sc["independent_user_sales"][0]["amount_out_modeled_raw"])
        self.assertEqual(actual, amount_out(10**20, ni, no))
        self.assertLess(actual, int(report["independent_size_curve"][0]["amount_out_modeled_raw"]))
        self.assertTrue(sc["model_only"])

    def test_removal_applies_to_both_reserves(self):
        scenario = {"schema_version": "exit-doctor.scenarios.v1", "entries": [{"id": "lp", "type": "proportional_liquidity_removal", "removal_bps": 5000}]}
        sc = self.report(scenarios=scenario)["scenarios"][0]
        self.assertEqual(int(sc["post_action_reserve_in_raw"]), 5 * 10**23)
        self.assertEqual(int(sc["post_action_reserve_out_raw"]), 10**12)

    def test_round_trip_uses_post_buy_state(self):
        spent = 10000000000
        scenario = {"schema_version": "exit-doctor.scenarios.v1", "entries": [{"id": "round", "type": "buy_then_sell", "quote_spend_raw": str(spent)}]}
        sc = self.report(scenarios=scenario)["scenarios"][0]
        bought = amount_out(spent, 2 * 10**12, 10**24)
        correct = amount_out(bought, 10**24 - bought, 2 * 10**12 + spent)
        incorrect = amount_out(bought, 10**24, 2 * 10**12)
        self.assertEqual(int(sc["quote_returned_before_additional_costs_raw"]), correct)
        self.assertNotEqual(correct, incorrect)
        self.assertLess(correct, spent)

    def test_duplicate_sizes_rejected(self):
        self.packet["quotes"].append(copy.deepcopy(self.packet["quotes"][0]))
        with self.assertRaises(ValueError):
            self.report()

    def test_slippage_minimum_is_separate(self):
        q = self.packet["quotes"][0]
        row = self.report()["independent_size_curve"][0]
        self.assertEqual(row["proceeds_before_additional_costs_raw"], q["amount_out_raw"])
        self.assertLess(int(row["min_output_raw"]), int(q["amount_out_raw"]))

    def test_atomic_no_overwrite_and_cli_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.json", Path(directory) / "output.json"
            source.write_text(json.dumps(self.packet))
            self.assertEqual(main([str(source), "--out", str(output)]), 0)
            report, _ = read_json(output)
            _, digest = read_json(source)
            self.assertEqual(report["source_sha256"], digest)
            original = output.read_bytes()
            with self.assertRaises(FileExistsError):
                write_new_json(output, {"changed": True})
            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(list(Path(directory).glob(".exit-doctor-*")))

    def test_duplicate_json_keys_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_text('{"x":1,"x":2}')
            with self.assertRaises(ValueError):
                read_json(path)


if __name__ == "__main__":
    unittest.main()
