import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("scout_evaluate", ROOT / "scripts/evaluate.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EvaluateTests(unittest.TestCase):
    def setUp(self):
        self.raw = (ROOT / "examples/synthetic.json").read_bytes()
        self.data = MODULE.parse_bytes(self.raw)

    def report(self):
        return MODULE.evaluate(self.data)

    def case_status(self):
        return self.report()["cases"][0]["status"]

    def test_exact_baseline_and_loss_denominator(self):
        result = self.report()
        wallet = result["wallets"][0]
        self.assertEqual(wallet["visible_picks"], 4)
        self.assertEqual((wallet["profit_count"], wallet["loss_count"]), (3, 1))
        self.assertEqual(wallet["completed_cases_net"], {"numerator": "72", "denominator": "1"})
        self.assertEqual(wallet["completed_cases_return_fraction"], {"numerator": "18", "denominator": "101"})
        self.assertTrue(wallet["ranking_eligible"])
        self.assertEqual(result["result_kind"], "hypothetical_simulated_follow_scenario")
        self.assertEqual(result["source_kind"], "synthetic")

    def test_missing_cost_does_not_become_zero(self):
        self.data["cases"][0]["entry"]["fees"] = None
        result = self.report()
        self.assertEqual(result["cases"][0]["status"], "unknown_entry_amount_or_cost")
        self.assertIsNone(result["cases"][0]["net"])
        self.assertEqual(result["wallets"][0]["visible_picks"], 4)
        self.assertFalse(result["wallets"][0]["ranking_eligible"])

    def test_explicit_zero_cost_accepted(self):
        self.data["cases"][0]["entry"]["fees"] = "0"
        self.assertEqual(self.case_status(), "evaluated")

    def test_gross_gain_is_net_loss(self):
        self.data["cases"][0]["exit"].update(quote_amount="101", fees="1")
        row = self.report()["cases"][0]
        self.assertEqual(row["net"], {"numerator": "-1", "denominator": "1"})

    def test_unavailable_exit_is_censored(self):
        self.data["cases"][0]["exit"]["available_at"] = "2026-01-11T00:00:00Z"
        self.assertEqual(self.case_status(), "exit_unavailable_at_cutoff")
        self.assertFalse(self.report()["wallets"][0]["ranking_eligible"])

    def test_future_exit_cannot_become_historical_peak(self):
        self.data["cases"][0]["exit"].update(event_at="2026-01-12T00:00:00Z", available_at="2026-01-12T00:00:00Z", quote_amount="99999999")
        self.assertIsNone(self.report()["cases"][0]["net"])

    def test_future_discovery_does_not_change_wallet_score(self):
        before = self.report()["wallets"]
        extra = copy.deepcopy(self.data["cases"][0])
        extra.update(id="future", token="future-token")
        extra["discovery"].update(event_at="2026-01-12T00:00:00Z", available_at="2026-01-12T00:00:00Z")
        self.data["cases"].append(extra)
        self.assertEqual(self.report()["wallets"], before)

    def test_late_discovery_does_not_enter_cutoff_denominator(self):
        self.data["cases"][0]["discovery"]["available_at"] = "2026-01-11T00:00:00Z"
        result = self.report()
        self.assertEqual(result["coverage"]["visible_picks"], 3)
        self.assertIn("cohort_count_unknown_or_mismatch", result["wallets"][0]["gate_failures"])

    def test_partial_exit_and_failed_entry_remain_visible(self):
        self.data["cases"][0]["exit"]["token_quantity"] = "600"
        self.data["cases"][1]["entry"]["status"] = "failed"
        result = self.report()
        self.assertEqual(result["wallets"][0]["visible_picks"], 4)
        self.assertEqual(result["wallets"][0]["evaluated_cases"], 2)
        self.assertEqual(result["cases"][0]["status"], "incomplete_or_mismatched_exit")
        self.assertEqual(result["cases"][1]["status"], "failed_entry")

    def test_missing_exit_is_not_marked_to_market(self):
        self.data["cases"][0]["exit"] = None
        self.assertEqual(self.case_status(), "missing_exit")

    def test_immature_case_remains_visible(self):
        self.data["cohort"]["window_end"] = "2026-01-10T00:00:00Z"
        self.data["cohort"]["coverage_available_at"] = "2026-01-10T00:00:00Z"
        self.data["cases"][0]["discovery"].update(event_at="2026-01-10T00:00:00Z", available_at="2026-01-10T00:00:00Z")
        self.assertEqual(self.case_status(), "immature")

    def test_privilege_and_unknown_classification_are_not_followable(self):
        self.data["cases"][0]["access"]["kind"] = "privileged_allocation"
        self.assertEqual(self.case_status(), "unfollowable_privileged_allocation")
        self.data["cases"][0]["access"]["available_at"] = "2026-01-11T00:00:00Z"
        self.assertEqual(self.case_status(), "unknown_access")

    def test_retroactive_selection_and_omitted_loser_block_rank(self):
        self.data["wallets"][0]["selected_at"] = "2026-01-09T00:00:00Z"
        self.data["wallets"][0]["selection_available_at"] = "2026-01-09T00:00:00Z"
        self.assertFalse(self.report()["wallets"][0]["ranking_eligible"])
        self.setUp()
        self.data["cases"].pop(2)
        self.assertIn("cohort_count_unknown_or_mismatch", self.report()["wallets"][0]["gate_failures"])

    def test_backdated_freeze_first_available_after_window_blocks_rank(self):
        self.data["cohort"]["available_at"] = "2026-01-09T00:00:00Z"
        self.assertFalse(self.report()["wallets"][0]["ranking_eligible"])

    def test_later_completeness_assertion_cannot_enable_past_rank(self):
        self.data["cohort"]["coverage_available_at"] = "2026-01-11T00:00:00Z"
        self.assertIn("cohort_coverage_unavailable_at_cutoff", self.report()["wallets"][0]["gate_failures"])

    def test_quotes_and_wrong_mode_do_not_establish_execution(self):
        for kind in ("quote", "executed", "unknown"):
            self.data["cases"][0]["exit"]["evidence_kind"] = kind
            self.assertEqual(self.case_status(), "unsupported_exit_evidence")

    def test_scenario_delay_and_size_are_enforced(self):
        self.data["cases"][0]["entry"]["event_at"] = self.data["cases"][0]["discovery"]["event_at"]
        self.assertEqual(self.case_status(), "entry_outside_scenario")
        self.setUp()
        self.data["cases"][0]["entry"]["quote_amount"] = "50"
        self.assertEqual(self.case_status(), "entry_size_mismatch")

    def test_currency_mixing_and_duplicate_discovery_rejected(self):
        self.data["cases"][0]["exit"]["currency"] = "ethereum:ETH"
        with self.assertRaises(MODULE.Invalid):
            self.report()
        self.setUp()
        duplicate = copy.deepcopy(self.data["cases"][0])
        duplicate["id"] = "alias"
        self.data["cases"].append(duplicate)
        with self.assertRaises(MODULE.Invalid):
            self.report()

    def test_one_lucky_token_profit_concentration_blocks_rank(self):
        self.data["cases"][0]["exit"]["quote_amount"] = "10000"
        self.assertIn("positive_profit_concentration_above_gate", self.report()["wallets"][0]["gate_failures"])

    def test_related_wallets_and_overlap_are_not_independent_proof(self):
        original = self.data["wallets"][0]
        original.update(relation_group="group-a", relation_available_at="2026-01-01T00:00:00Z", relation_source_refs=["synthetic:relationship"])
        second = dict(original, id="fictional-scout-b")
        self.data["wallets"].append(second)
        duplicates = copy.deepcopy(self.data["cases"])
        for case in duplicates:
            case.update(id=case["id"]+"-b", wallet_id=second["id"])
        self.data["cases"].extend(duplicates)
        self.data["cohort"]["expected_case_count"] = 8
        result = self.report()
        self.assertEqual(result["dependence"]["declared_known_groups"], 1)
        self.assertIsNone(result["dependence"]["independent_confirmation_count"])
        self.assertEqual(result["overlap"][0]["shared_token_count"], 4)

    def test_unknown_provenance_blocks_rank_and_observed_cannot_hide_synthetic(self):
        self.data["source_kind"] = "unknown"
        self.assertEqual(self.case_status(), "unknown_provenance")
        self.data["source_kind"] = "observed"
        with self.assertRaises(MODULE.Invalid):
            self.report()

    def test_strict_json_bounded_work_and_unknown_fields(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":1.5}', b' '*(MODULE.MAX_BYTES+1)):
            with self.assertRaises(MODULE.Invalid):
                MODULE.parse_bytes(raw)
        self.data["cases"][0]["max_future_price"] = "99999"
        with self.assertRaises(MODULE.Invalid):
            self.report()

    def test_input_order_and_input_object_unchanged(self):
        before = copy.deepcopy(self.data)
        report = self.report()
        self.assertEqual(self.data, before)
        self.data["cases"].reverse()
        self.assertEqual(self.report(), report)

    def test_cli_hash_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)/"report.json"
            cmd = [sys.executable, str(ROOT/"scripts/evaluate.py"), str(ROOT/"examples/synthetic.json"), "--output", str(output)]
            first = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            before = output.read_bytes()
            self.assertEqual(json.loads(before)["input_sha256"], hashlib.sha256(self.raw).hexdigest())
            second = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(second.returncode, 2)
            self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
