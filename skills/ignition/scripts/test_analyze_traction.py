#!/usr/bin/env python3
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import analyze_traction as engine


FIXTURE = Path(__file__).resolve().parents[1] / "assets" / "synthetic-traction.json"


class TractionTests(unittest.TestCase):
    def setUp(self):
        self.data, self.digest = engine.load_input(FIXTURE)

    def report(self):
        return engine.analyze(self.data, self.digest)

    def test_exact_deterministic_comparison_and_universe(self):
        report = self.report()
        self.assertEqual(report, self.report())
        self.assertEqual(report["input_sha256"], hashlib.sha256(FIXTURE.read_bytes()).hexdigest())
        self.assertEqual(report["source_kind"], "synthetic")
        self.assertEqual(len(report["candidates"]), 3)
        alpha, gap, unknown = report["candidates"]
        self.assertEqual(alpha["state"], "heuristic_candidate")
        self.assertEqual(alpha["comparison"]["strict_wallets"]["buy_quote_growth"], "2")
        self.assertEqual(alpha["windows"]["current"]["eligible"]["strict_wallets"]["buyer_hhi"], "1/6")
        self.assertEqual(gap["state"], "insufficient_data")
        self.assertIn("token_age_unknown", unknown["insufficient_data_reasons"])
        self.assertEqual(alpha["persistence"]["state"], "unknown")

    def test_suspected_cohorts_and_overlap_denominators(self):
        current = self.report()["candidates"][0]["windows"]["current"]
        self.assertEqual(current["raw"]["strict_wallets"]["buy_quote"], "1560")
        self.assertEqual(current["eligible"]["strict_wallets"]["buy_quote"], "60")
        excluded = current["exclusions"]
        self.assertEqual(excluded["denominator_events"], 9)
        self.assertEqual(excluded["denominator_buyer_wallets"], 8)
        self.assertEqual(excluded["union_event_count"], 3)
        self.assertEqual(excluded["excluded_buy_quote"], "1500")
        self.data["suspected_bots"][0]["wallet_id"] = "rapid-trader"
        overlap = self.report()["candidates"][0]["windows"]["current"]["exclusions"]
        self.assertEqual(overlap["union_wallet_count"], 1)
        self.assertEqual(overlap["union_event_count"], 2)

    def test_supplied_cluster_is_sensitivity_not_owner_identity(self):
        alpha = self.report()["candidates"][0]
        self.assertTrue(alpha["comparison"]["strict_wallets"]["passes_rule"])
        self.assertFalse(alpha["comparison"]["supplied_cluster_sensitivity"]["passes_rule"])
        self.assertIn("supplied_cluster_sensitive", alpha["flags"])
        self.assertEqual(alpha["windows"]["current"]["eligible"]["supplied_cluster_sensitivity"]["buyer_count"], 4)

    def test_late_swap_and_unknown_source_gate(self):
        self.data["swaps"][0]["available_at"] = "2026-09-08T03:00:00Z"
        alpha = self.report()["candidates"][0]
        self.assertEqual(alpha["observation_counts"]["unavailable_at_cutoff"], 1)
        self.assertIn("observations_not_available_at_cutoff", alpha["insufficient_data_reasons"])
        self.data["source_kind"] = "unknown"
        self.assertIn("observation_source_unknown", self.report()["candidates"][0]["insufficient_data_reasons"])

    def test_window_boundaries(self):
        self.data["swaps"][0]["event_time"] = self.data["window_start"]
        self.data["swaps"][3]["event_time"] = "2026-09-08T01:00:00Z"
        row = copy.deepcopy(self.data["swaps"][-1])
        row.update(tx_id="boundary", event_time=self.data["window_end"], available_at=self.data["window_end"])
        self.data["swaps"].append(row)
        alpha = self.report()["candidates"][0]
        self.assertEqual(alpha["observation_counts"]["outside_lookback"], 1)
        self.assertEqual(alpha["windows"]["prior"]["raw"]["strict_wallets"]["buy_event_count"], 3)
        self.assertEqual(alpha["windows"]["current"]["raw"]["strict_wallets"]["buy_event_count"], 8)

    def test_exact_amount_and_reject_rounding(self):
        self.data["swaps"][0]["quote_amount"] = "999999999999999999999999.000001"
        prior = self.report()["candidates"][0]["windows"]["prior"]["raw"]["strict_wallets"]
        self.assertEqual(prior["buy_quote"], "1000000000000000000000019.000001")
        for value in (1.1, "1e3", "NaN", "-1", "0", "1.0000001"):
            with self.subTest(value=value):
                self.data["swaps"][0]["quote_amount"] = value
                with self.assertRaises(engine.ValidationError):
                    self.report()

    def test_conflicting_identity_metadata_and_order(self):
        mutations = [
            lambda d: d["swaps"].insert(0, copy.deepcopy(d["swaps"][0])),
            lambda d: d["candidates"][1].update(quote_decimals=8),
            lambda d: d["candidates"][1].update(candidate_id=d["candidates"][0]["candidate_id"]),
            lambda d: d["swaps"].reverse(),
            lambda d: d["swaps"][0].update(log_index=True),
            lambda d: d["swaps"][0].update(unrecognized="ignored?"),
            lambda d: d.update(window_end="2026-09-08T02:00:01Z"),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                fresh = copy.deepcopy(self.data)
                mutate(fresh)
                with self.assertRaises(engine.ValidationError):
                    engine.analyze(fresh, self.digest)

    def test_future_metadata_is_rejected(self):
        for field in ("suspected_bots", "supplied_clusters"):
            data = copy.deepcopy(self.data)
            data[field][0]["available_at"] = "2026-09-08T03:00:00Z"
            with self.assertRaises(engine.ValidationError):
                engine.analyze(data, self.digest)

    def test_coverage_evidence_cannot_predate_coverage(self):
        for end, available in (("2026-09-09T00:00:00Z", self.data["cutoff"]),
                               (self.data["cutoff"], "2026-09-07T00:00:00Z")):
            data = copy.deepcopy(self.data)
            data["candidates"][0]["coverage"].update(window_end=end, available_at=available)
            with self.assertRaises(engine.ValidationError):
                engine.analyze(data, self.digest)

    def test_realistic_capture_latency_and_knowledge_cutoff(self):
        self.data["window_end"] = "2026-09-08T02:00:00Z"
        self.data["cutoff"] = "2026-09-08T02:01:00Z"
        self.data["candidates"][0]["coverage"].update(window_end=self.data["window_end"], available_at="2026-09-08T02:00:20Z")
        self.data["swaps"][0]["available_at"] = "2026-09-08T02:00:50Z"
        alpha = self.report()["candidates"][0]
        self.assertEqual(alpha["state"], "heuristic_candidate")
        self.data["swaps"][0]["available_at"] = "2026-09-08T02:01:01Z"
        alpha = self.report()["candidates"][0]
        self.assertEqual(alpha["state"], "insufficient_data")
        self.assertEqual(alpha["observation_counts"]["unavailable_at_cutoff"], 1)

    def test_transaction_logs_cannot_disagree_on_event_time(self):
        self.data["swaps"][3].update(tx_id=self.data["swaps"][0]["tx_id"], log_index=1)
        with self.assertRaises(engine.ValidationError):
            self.report()

    def test_roundtrip_crossing_midpoint_is_excluded_in_both_windows(self):
        for side, time in (("buy", "2026-09-08T00:59:50Z"), ("sell", "2026-09-08T01:00:10Z")):
            row = copy.deepcopy(self.data["swaps"][0])
            row.update(tx_id="boundary-" + side, wallet_id="boundary-wallet", side=side, event_time=time, available_at=time)
            self.data["swaps"].append(row)
        self.data["swaps"].sort(key=lambda row: row["event_time"])
        windows = self.report()["candidates"][0]["windows"]
        for name in ("prior", "current"):
            self.assertIn("boundary-wallet", windows[name]["exclusions"]["suspected_roundtrip_wallets"])

    def test_creation_and_coverage_gates(self):
        self.data["candidates"][0]["created_at"] = "2026-09-08T00:01:00Z"
        self.data["candidates"][0]["creation_available_at"] = "2026-09-08T00:01:00Z"
        self.assertIn("token_did_not_exist_for_full_lookback", self.report()["candidates"][0]["insufficient_data_reasons"])
        self.data["candidates"][0]["coverage"]["window_end"] = "2026-09-08T01:30:00Z"
        self.assertIn("coverage_does_not_span_lookback", self.report()["candidates"][0]["insufficient_data_reasons"])

    def test_strict_json_and_input_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.json"
            for payload in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '\ufeff{}'):
                path.write_text(payload)
                with self.assertRaises(engine.ValidationError):
                    engine.load_input(path)
            path.write_bytes(b" " * (engine.MAX_BYTES + 1))
            with self.assertRaises(engine.ValidationError):
                engine.load_input(path)

    def test_cli_immutable_output_and_no_partial_on_bad_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "report.json"
            self.assertEqual(engine.main([str(FIXTURE), "--output", str(output)]), 0)
            original = output.read_bytes()
            self.assertEqual(engine.main([str(FIXTURE), "--output", str(output)]), 2)
            self.assertEqual(output.read_bytes(), original)
            bad = Path(tmp) / "bad.json"
            bad.write_text('{"schema_version":"bad"}')
            missing = Path(tmp) / "missing.json"
            self.assertEqual(engine.main([str(bad), "--output", str(missing)]), 2)
            self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
