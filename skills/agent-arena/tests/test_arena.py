import copy
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("arena", ROOT / "scripts/arena.py")
arena = importlib.util.module_from_spec(spec)
spec.loader.exec_module(arena)


class AccountingTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "assets/example.json").read_text())

    def event(self, identity):
        return next(e for e in self.data["events"] if e["id"] == identity)

    def report(self):
        return arena.analyze(self.data)

    def test_funding_is_not_profit_and_fees_not_double_counted(self):
        report = self.report()
        self.assertEqual(report["performance"]["cashflowAdjustedPnl"], "-18")
        self.assertEqual(report["funding"]["netExternalFlow"], "600")
        self.assertEqual(report["costs"]["observedTerminalFees"], "3")
        self.assertEqual(report["opening"]["positionCount"], 1)
        self.assertEqual(report["closing"]["positionCount"], 1)

    def test_exact_twr_and_observed_drawdown(self):
        report = self.report()
        expected = Decimal(998) / 1000 * Decimal(1978) / 1998 * Decimal(1582) / 1578 - 1
        actual = Decimal(report["performance"]["timeWeightedReturnFraction"])
        self.assertLess(abs(actual - expected), Decimal("1e-70"))
        expected_dd = 1 - Decimal(998) / 1000 * Decimal(1978) / 1998
        self.assertLess(abs(Decimal(report["performance"]["observedSnapshotDrawdownFraction"]) - expected_dd), Decimal("1e-70"))

    def test_missing_flow_bracket_withholds_return_preserves_absolute_pnl(self):
        del self.event("deposit")["beforeSnapshotId"]
        p = self.report()["performance"]
        self.assertEqual(p["cashflowAdjustedPnl"], "-18")
        self.assertIsNone(p["timeWeightedReturnFraction"])
        self.assertTrue(any("MISSING_EXACT_FLOW_BRACKETS" in s for s in p["returnIssues"]))

    def test_gas_hidden_inside_flow_bracket_is_not_ignored(self):
        self.event("after-deposit")["cash"] = "1897"
        p = self.report()["performance"]
        self.assertIsNone(p["timeWeightedReturnFraction"])
        self.assertIn("deposit:FLOW_BRACKET_NAV_MISMATCH", p["returnIssues"])

    def test_unpriced_open_position_withholds_pnl(self):
        self.event("closing")["positions"][0]["mark"] = None
        report = self.report()
        self.assertIsNone(report["closing"]["nav"])
        self.assertEqual(report["closing"]["knownComponentSubtotal"], "1497")
        self.assertIsNone(report["performance"]["cashflowAdjustedPnl"])

    def test_unpriced_liability_never_becomes_zero(self):
        self.event("closing")["liabilities"][0]["value"] = None
        self.assertIsNone(self.report()["closing"]["nav"])

    def test_priced_debt_reduces_nav(self):
        self.event("closing")["liabilities"][0]["value"] = "20"
        self.assertEqual(self.report()["performance"]["cashflowAdjustedPnl"], "-38")

    def test_stale_future_and_late_observed_marks(self):
        mark = self.event("closing")["positions"][0]["mark"]
        for field, value, issue in (
            ("at", "2026-09-07T05:58:59Z", "STALE_MARK"),
            ("at", "2026-09-07T06:00:01Z", "FUTURE_MARK"),
            ("observedAt", "2026-09-07T06:01:01Z", "MARK_NOT_AVAILABLE"),
        ):
            with self.subTest(issue=issue):
                original = mark[field]
                mark[field] = value
                report = self.report()
                self.assertIsNone(report["closing"]["nav"])
                self.assertTrue(any(issue in item for item in report["closing"]["issues"]))
                mark[field] = original

    def test_late_evidence_excluded_asof(self):
        self.event("closing")["observedAt"] = "2026-09-07T06:02:00Z"
        report = self.report()
        self.assertEqual(report["excludedNotKnownAsOf"], 1)
        self.assertIsNone(report["performance"]["cashflowAdjustedPnl"])

    def test_future_window_withholds_metrics(self):
        self.data["window"]["asOf"] = "2026-09-07T05:00:00Z"
        self.assertIn("WINDOW_NOT_FINISHED_AS_OF", self.report()["performance"]["pnlIssues"])

    def test_incomplete_coverage_cannot_publish_complete_pnl(self):
        for key in arena.COVERAGE[:-1]:
            with self.subTest(key=key):
                self.data["coverage"][key] = False
                self.assertIsNone(self.report()["performance"]["cashflowAdjustedPnl"])
                self.data["coverage"][key] = True
        self.data["coverage"]["end"] = "2026-09-07T05:59:59Z"
        self.assertIsNone(self.report()["performance"]["cashflowAdjustedPnl"])

    def test_unknown_attempt_breakdown_is_explicit_without_invalidating_reconciled_nav(self):
        self.data["coverage"]["attemptsComplete"] = False
        self.event("attempt-1-failed")["feeAmount"] = None
        report = self.report()
        self.assertFalse(report["costs"]["coverageComplete"])
        self.assertEqual(report["costs"]["terminalAttemptsWithoutPricedFee"], 1)
        self.assertEqual(report["performance"]["cashflowAdjustedPnl"], "-18")

    def test_fees_explicitly_excluded_from_nav_block_pnl(self):
        self.event("attempt-1-failed")["feesIncludedInNAV"] = False
        self.assertIsNone(self.report()["performance"]["cashflowAdjustedPnl"])

    def test_pending_failed_and_unattributed_are_retained(self):
        report = self.report()
        self.assertEqual(report["attempts"]["counts"], {"failed": 1, "succeeded": 1, "pending": 1})
        self.assertEqual(report["attribution"]["attemptsWithPriorDecisionEvidence"], 1)
        self.assertFalse(report["attribution"]["authorshipVerified"])

    def test_receipt_after_window_does_not_erase_pending_at_window_end(self):
        self.data["window"]["asOf"] = "2026-09-07T08:00:00Z"
        receipt = copy.deepcopy(self.event("still-pending"))
        receipt.update(id="late-receipt", status="succeeded", at="2026-09-07T07:00:00Z",
                       observedAt="2026-09-07T07:00:00Z", feeAmount="100")
        self.data["events"].append(receipt)
        report = self.report()
        self.assertEqual(report["attempts"]["counts"]["pending"], 1)
        self.assertEqual(report["costs"]["observedTerminalFees"], "3")

    def test_unresolved_attempt_from_before_window_is_visible(self):
        pending = self.event("still-pending")
        pending["at"] = pending["observedAt"] = "2026-09-06T23:00:00Z"
        row = next(r for r in self.report()["attempts"]["rows"] if r["attemptId"] == "route-3")
        self.assertEqual(row["status"], "pending")
        self.assertTrue(row["pendingCarriedIntoWindow"])

    def test_hindsight_decision_does_not_claim_attribution(self):
        self.event("decision-1")["observedAt"] = "2026-09-07T01:00:01Z"
        self.assertEqual(self.report()["attribution"]["attemptsWithPriorDecisionEvidence"], 0)

    def test_duplicate_event_id_is_idempotent_conflicting_id_rejected(self):
        self.data["events"].append(copy.deepcopy(self.event("closing")))
        self.assertEqual(self.report()["performance"]["cashflowAdjustedPnl"], "-18")
        self.data["events"][-1]["cash"] = "999999"
        with self.assertRaises(arena.EvidenceError):
            self.report()

    def test_multiple_attempts_same_transaction_rejected(self):
        self.event("unattributed-success")["txHash"] = "0x" + "a" * 64
        with self.assertRaises(arena.EvidenceError):
            self.report()

    def test_terminal_status_conflict_and_regression_rejected(self):
        final = copy.deepcopy(self.event("attempt-1-failed"))
        final.update(id="conflict", status="succeeded", at="2026-09-07T03:00:00Z", observedAt="2026-09-07T03:00:00Z")
        self.data["events"].append(final)
        with self.assertRaises(arena.EvidenceError):
            self.report()
        final["status"] = "pending"
        with self.assertRaises(arena.EvidenceError):
            self.report()

    def test_zero_equity_denominator_is_unavailable(self):
        self.event("opening")["cash"] = "-100"
        p = self.report()["performance"]
        self.assertIsNone(p["timeWeightedReturnFraction"])
        self.assertIn("NONPOSITIVE_RETURN_DENOMINATOR_OR_NEGATIVE_EQUITY", p["returnIssues"])

    def test_terminal_zero_is_complete_loss_and_negative_equity_is_unavailable(self):
        self.event("closing")["cash"] = "-85"
        self.assertEqual(self.report()["performance"]["timeWeightedReturnFraction"], "-1")
        self.event("closing")["cash"] = "-86"
        self.assertIsNone(self.report()["performance"]["timeWeightedReturnFraction"])

    def test_incomplete_intermediate_snapshot_preserves_boundary_pnl_only(self):
        self.event("market-loss")["complete"] = False
        p = self.report()["performance"]
        self.assertEqual(p["cashflowAdjustedPnl"], "-18")
        self.assertIsNone(p["observedSnapshotDrawdownFraction"])

    def test_ambiguous_boundary_snapshot_is_unavailable(self):
        duplicate = copy.deepcopy(self.event("closing"))
        duplicate["id"] = "another-closing"
        self.data["events"].append(duplicate)
        self.assertIsNone(self.report()["performance"]["cashflowAdjustedPnl"])

    def test_simultaneous_flows_not_arbitrarily_ordered(self):
        flow = copy.deepcopy(self.event("deposit"))
        flow["id"] = "second-deposit"
        self.data["events"].append(flow)
        self.assertIsNone(self.report()["performance"]["timeWeightedReturnFraction"])

    def test_flow_sign_must_match_classification(self):
        self.event("withdrawal")["amount"] = "400"
        with self.assertRaises(arena.EvidenceError):
            self.report()

    def test_decimal_strings_and_timezone_required(self):
        for bad in (1.1, "NaN", "Infinity", "1e10000"):
            self.event("closing")["cash"] = bad
            with self.assertRaises(arena.EvidenceError):
                self.report()
        self.event("closing")["cash"] = "1497"
        self.event("closing")["at"] = "2026-09-07T06:00:00"
        with self.assertRaises(arena.EvidenceError):
            self.report()

    def test_sub_atomic_decimal_products_do_not_round_to_zero(self):
        position = self.event("closing")["positions"][0]
        position["quantity"] = "0.000000000000000000000000000001"
        position["mark"]["price"] = "0.000000000000000000000000000001"
        nav = Decimal(self.report()["closing"]["nav"])
        self.assertEqual(nav - 1497, Decimal("1e-60"))


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "review.sqlite")
        self.data = json.loads((ROOT / "assets/example.json").read_text())
        self.info = arena.journal_import(self.path, self.data, initialize=True)

    def read(self, expected=None):
        con = arena.connect(self.path)
        try:
            return arena.verify_journal(con, expected)
        finally:
            con.close()

    def test_restart_export_and_analysis_match(self):
        exported, info = self.read(self.info["headHash"])
        self.assertEqual(exported, self.data)
        self.assertEqual(arena.analyze(exported), arena.analyze(self.data))
        self.assertTrue(info["externalHeadMatched"])

    def test_repeat_import_does_not_change_head(self):
        info = arena.journal_import(self.path, self.data)
        self.assertEqual(info["insertedEvents"], 0)
        self.assertEqual(info["headHash"], self.info["headHash"])

    def test_conflicting_batch_rolls_back_all_events(self):
        batch = copy.deepcopy(self.data)
        new = copy.deepcopy(batch["events"][1])
        new["id"] = "new-decision"
        existing = copy.deepcopy(batch["events"][0])
        existing["cash"] = "100000"
        batch["events"] = [new, existing]
        with self.assertRaises(arena.EvidenceError):
            arena.journal_import(self.path, batch)
        exported, info = self.read()
        self.assertEqual(info["headHash"], self.info["headHash"])
        self.assertNotIn("new-decision", [e["id"] for e in exported["events"]])

    def test_frozen_scope_and_window_rejected(self):
        for key in ("scope", "window", "coverage"):
            batch = copy.deepcopy(self.data)
            if key == "scope":
                batch[key]["currency"] = "USDG"
            elif key == "window":
                batch[key]["asOf"] = "2026-09-07T06:02:00Z"
            else:
                batch[key]["attemptsComplete"] = False
            with self.assertRaises(arena.EvidenceError):
                arena.journal_import(self.path, batch)

    def test_concurrent_identical_writers_are_idempotent(self):
        batch = copy.deepcopy(self.data)
        record = copy.deepcopy(batch["events"][1])
        record["id"] = "concurrent-decision"
        batch["events"] = [record]
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: arena.journal_import(self.path, batch), range(4)))
        self.assertEqual(sum(r["insertedEvents"] for r in results), 1)
        self.assertEqual(self.read()[1]["eventCount"], len(self.data["events"]) + 1)

    def test_append_only_triggers_and_payload_corruption(self):
        con = sqlite3.connect(self.path)
        with self.assertRaises(sqlite3.IntegrityError):
            con.execute("UPDATE entries SET payload='{}' WHERE seq=2")
        con.rollback()
        con.execute("DROP TRIGGER prevent_update")
        con.execute("UPDATE entries SET payload='{}' WHERE seq=2")
        con.commit()
        con.close()
        with self.assertRaises(arena.EvidenceError):
            self.read()

    def test_unanchored_suffix_removal_limit_and_external_anchor(self):
        con = sqlite3.connect(self.path)
        con.execute("DROP TRIGGER prevent_delete")
        con.execute("DELETE FROM entries WHERE seq=(SELECT MAX(seq) FROM entries)")
        con.commit()
        con.close()
        self.assertEqual(self.read()[1]["status"], "HASH_CHAIN_CONSISTENT")
        with self.assertRaises(arena.EvidenceError):
            self.read(self.info["headHash"])

    def test_semantic_attempt_conflict_across_imports_is_atomic(self):
        batch = copy.deepcopy(self.data)
        duplicate = copy.deepcopy(next(e for e in batch["events"] if e["id"] == "attempt-1-failed"))
        duplicate["id"] = "different-terminal-id"
        batch["events"] = [duplicate]
        with self.assertRaises(arena.EvidenceError):
            arena.journal_import(self.path, batch)
        self.assertEqual(self.read()[1]["headHash"], self.info["headHash"])

    def test_cli_errors_nonzero_and_duplicate_json_keys_rejected(self):
        bad = Path(self.temp.name) / "bad.json"
        bad.write_text('{"schema":"arena-input@1","schema":"arena-input@1"}')
        run = subprocess.run([sys.executable, str(ROOT / "scripts/arena.py"), "analyze", "--input", str(bad)], text=True, capture_output=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn("duplicate JSON key", run.stderr)
        run = subprocess.run([sys.executable, str(ROOT / "scripts/arena.py"), "journal-verify", "--db", str(Path(self.temp.name) / "missing.sqlite")], text=True, capture_output=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn("does not exist", run.stderr)


if __name__ == "__main__":
    unittest.main()
