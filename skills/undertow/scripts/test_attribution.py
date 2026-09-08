"""Independent arithmetic vectors and evidence-failure tests for attribution."""
import copy
from decimal import Decimal, localcontext
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from attribution import analyze_attribution


ROOT = Path(__file__).resolve().parents[1]


def sample():
    return json.loads((ROOT / "examples" / "attribution.json").read_text())


def analyze(value):
    return analyze_attribution(value)


class AttributionTests(unittest.TestCase):
    def assertClose(self, actual, expected):
        self.assertLess(abs(Decimal(actual) - Decimal(expected)), Decimal("1e-65"))

    def test_thirty_usd_twenty_quote_is_eight_and_one_third_relative(self):
        result = analyze(sample())
        self.assertEqual(result["status"], "COMPLETE_MARK_ATTRIBUTION")
        local = result["local_attribution"]
        self.assertEqual(local["meme_usd_return_pct"], "30")
        self.assertEqual(local["quote_usd_return_pct"], "20")
        with localcontext() as context:
            context.prec = 80
            self.assertClose(local["meme_quote_return_pct"], Decimal(25) / 3)
        self.assertFalse(result["qualifies_as_signal"])
        self.assertIsNone(result["executable_proceeds"])

    def test_local_premium_is_separate_from_stock(self):
        result = analyze(sample())["reference_attribution"]
        self.assertEqual(result["adjusted_stock_reference_factor"], "1.1")
        self.assertEqual(result["underlying_equity_factor"], "1.1")
        self.assertEqual(result["corporate_action_multiplier_factor"], "1")
        with localcontext() as context:
            context.prec = 80
            self.assertClose(result["local_premium_factor"], Decimal(12) / 11)
        self.assertClose(result["factor_product"], "1.3")

    def test_forward_split_offsets_underlying_price_drop(self):
        value = sample()
        a, b = value["snapshots"]
        b["reference"].update(bid="25", ask="25")
        b["reference"]["multiplier"]["value"] = "4"
        b["quote_usd"].update(bid="100", ask="100")
        b["pool_mark"].update(token0_raw="1000000000000000000", token1_raw="1000000000000000000")
        ref = analyze(value)["reference_attribution"]
        self.assertEqual(ref["underlying_equity_factor"], "0.25")
        self.assertEqual(ref["corporate_action_multiplier_factor"], "4")
        self.assertEqual(ref["adjusted_stock_reference_factor"], "1")
        self.assertEqual(ref["factor_product"], "1")

    def test_multiplier_change_is_not_assumed_to_be_an_underlying_gain(self):
        value = sample()
        b = value["snapshots"][1]
        b["reference"].update(bid="100", ask="100")
        b["reference"]["multiplier"]["value"] = "1.02"
        ref = analyze(value)["reference_attribution"]
        self.assertEqual(ref["underlying_equity_factor"], "1")
        self.assertEqual(ref["corporate_action_multiplier_factor"], "1.02")
        self.assertEqual(ref["adjusted_stock_reference_factor"], "1.02")

    def test_adjusted_oracle_never_multiplied_again(self):
        value = sample()
        for snapshot in value["snapshots"]:
            ref = snapshot["reference"]
            ref.pop("multiplier")
            ref.update(basis="adjusted_oracle", unit="USD_per_quote_token", round_valid=True,
                       block_number=snapshot["block_number"], block_hash=snapshot["block_hash"])
        result = analyze(value)
        self.assertEqual(result["status"], "COMPLETE_MARK_ATTRIBUTION")
        self.assertIsNone(result["reference_attribution"]["underlying_equity_factor"])
        self.assertEqual(result["reference_attribution"]["adjusted_stock_reference_factor"], "1.1")
        value["snapshots"][0]["reference"]["multiplier"] = {"value": "2"}
        self.assertReferenceBlocked(value, "DOUBLE_MULTIPLIER")

    def test_different_decimals_and_inverse_orientation(self):
        value = sample()
        value["assets"]["meme"]["decimals"] = 6
        for s in value["snapshots"]:
            s["pool_mark"].update(token0_raw="1000000", token1_raw="2000000000000000000")
        result = analyze(value)
        self.assertEqual(result["local_attribution"]["snapshots"][0]["meme_quote"], "2")
        meme, quote = value["assets"]["meme"], value["assets"]["quote"]
        meme["address"], quote["address"] = quote["address"], meme["address"]
        for s in value["snapshots"]:
            s["pool_mark"].update(token0_raw="2000000000000000000", token1_raw="1000000")
            s["quote_usd"]["quote_token"] = quote["address"]
            s["reference"]["quote_token"] = quote["address"]
        result = analyze(value)
        self.assertEqual(result["status"], "COMPLETE_MARK_ATTRIBUTION")
        self.assertEqual(result["local_attribution"]["snapshots"][0]["meme_quote"], "2")

    def test_sqrt_q96_exact_unit_ratio(self):
        value = sample()
        for s in value["snapshots"]:
            s["pool_mark"].update(kind="sqrt_price_x96", sqrt_price_x96=str(2**96))
        result = analyze(value)
        self.assertEqual(result["local_attribution"]["meme_quote_factor"], "1")
        self.assertEqual(result["local_attribution"]["snapshots"][0]["meme_quote"], "1")

    def test_wide_bid_ask_premium_bounds_are_not_executable_arbitrage(self):
        value = sample()
        s = value["snapshots"][0]
        s["quote_usd"].update(bid="90", ask="110")
        s["reference"].update(bid="80", ask="120")
        result = analyze(value)["reference_attribution"]["snapshots"][0]
        self.assertEqual(result["local_premium_ratio"], "1")
        self.assertEqual(result["local_premium_lower"], "0.75")
        self.assertEqual(result["local_premium_upper"], "1.375")

    def assertReferenceBlocked(self, value, code):
        result = analyze(value)
        self.assertEqual(result["status"], "PARTIAL_REFERENCE")
        self.assertIsNotNone(result["local_attribution"])
        self.assertIsNone(result["reference_attribution"])
        self.assertIn(code, [issue["code"] for issue in result["issues"]])
        return result

    def assertLocalBlocked(self, value, code):
        result = analyze(value)
        self.assertEqual(result["status"], "INSUFFICIENT_DATA")
        self.assertIsNone(result["local_attribution"])
        self.assertIsNone(result["reference_attribution"])
        self.assertIn(code, [issue["code"] for issue in result["issues"]])

    def test_missing_reference_preserves_only_two_factor_decomposition(self):
        value = sample()
        value["snapshots"][0].pop("reference")
        self.assertReferenceBlocked(value, "OBJECT_REQUIRED")

    def test_stale_reference(self):
        value = sample()
        value["snapshots"][0]["reference"]["timestamp"] = "2026-09-08T13:59:00Z"
        self.assertReferenceBlocked(value, "STALE_SOURCE")

    def test_reference_future_timestamp(self):
        value = sample()
        value["snapshots"][0]["reference"]["timestamp"] = "2026-09-08T14:00:01Z"
        self.assertReferenceBlocked(value, "FUTURE_SOURCE")

    def test_reference_observed_after_knowledge_cutoff(self):
        value = sample()
        value["snapshots"][1]["reference"]["observed_at"] = "2026-09-08T14:06:00Z"
        self.assertReferenceBlocked(value, "KNOWLEDGE_CUTOFF")

    def test_reference_observed_before_quote_generated(self):
        value = sample()
        value["snapshots"][0]["reference"]["observed_at"] = "2026-09-08T13:59:59Z"
        self.assertReferenceBlocked(value, "OBSERVED_BEFORE_SOURCE")

    def test_historical_multiplier_requires_exact_block(self):
        for field, changed in [("block_number", 102), ("block_hash", "0x" + "9" * 64), ("basis", "latest_metadata")]:
            with self.subTest(field=field):
                value = sample()
                value["snapshots"][0]["reference"]["multiplier"][field] = changed
                self.assertReferenceBlocked(value, "HISTORICAL_MULTIPLIER_REQUIRED" if field == "basis" else "BLOCK_MISMATCH")

    def test_multiplier_retained_after_cutoff_is_unusable(self):
        value = sample()
        value["snapshots"][0]["reference"]["multiplier"]["observed_at"] = "2026-09-09T14:00:00Z"
        self.assertReferenceBlocked(value, "KNOWLEDGE_CUTOFF")

    def test_market_session_halt_tradability_and_pause_fail_closed(self):
        variants = [("session", "closed", "CLOSED_OR_UNKNOWN_SESSION"),
                    ("session", "unknown", "CLOSED_OR_UNKNOWN_SESSION"),
                    ("halted", True, "HALTED_OR_UNKNOWN"),
                    ("halted", None, "HALTED_OR_UNKNOWN"),
                    ("tradability", "position_closing_only", "TRADABILITY_RESTRICTED_OR_UNKNOWN"),
                    ("asset_status", "inactive", "INACTIVE_OR_UNKNOWN")]
        for key, changed, code in variants:
            with self.subTest(key=key, changed=changed):
                value = sample()
                value["snapshots"][0]["reference"][key] = changed
                self.assertReferenceBlocked(value, code)
        for changed in [True, None, 0]:
            value = sample()
            value["snapshots"][0]["token_paused"] = changed
            self.assertReferenceBlocked(value, "PAUSED_OR_UNKNOWN")

    def test_reference_alignment_even_when_within_age_policy(self):
        value = sample()
        value["snapshots"][0]["reference"]["timestamp"] = "2026-09-08T13:59:45Z"
        self.assertReferenceBlocked(value, "MISALIGNED_SOURCES")

    def test_quote_and_pool_alignment_required(self):
        value = sample()
        value["snapshots"][0]["quote_usd"]["timestamp"] = "2026-09-08T13:59:45Z"
        self.assertLocalBlocked(value, "MISALIGNED_SOURCES")

    def test_usdg_not_assumed_usd(self):
        value = sample()
        value["snapshots"][0]["quote_usd"]["currency"] = "USDG"
        self.assertLocalBlocked(value, "QUOTE_UNIT_MISMATCH")

    def test_reference_cannot_supply_local_market_mark(self):
        value = sample()
        value["snapshots"][0]["quote_usd"]["basis"] = "adjusted_oracle"
        self.assertLocalBlocked(value, "LOCAL_MARK_REQUIRED")

    def test_wrong_chain_and_bool_rejected(self):
        for chain in (1, True, "4663", 4663.0):
            value = sample()
            value["chain_id"] = chain
            self.assertLocalBlocked(value, "CHAIN_MISMATCH")

    def test_canonical_tick_spacing_and_fee_bounds(self):
        value = sample()
        value["pool"]["tick_spacing"] = 32768
        self.assertLocalBlocked(value, "INTEGER_RANGE")
        value = sample()
        value["pool"]["fee"] = 1000001
        self.assertLocalBlocked(value, "FEE_RANGE")
        value["pool"]["fee"] = 0x800000
        self.assertEqual(analyze(value)["status"], "COMPLETE_MARK_ATTRIBUTION")

    def test_zero_negative_float_and_nonfinite_reference_prices(self):
        for invalid, code in [("0", "NONPOSITIVE_VALUE"), ("-1", "DECIMAL_STRING_REQUIRED"),
                              (1.1, "DECIMAL_STRING_REQUIRED"), (True, "DECIMAL_STRING_REQUIRED"),
                              ("NaN", "DECIMAL_STRING_REQUIRED"), ("Infinity", "DECIMAL_STRING_REQUIRED"),
                              ("1e3", "DECIMAL_STRING_REQUIRED")]:
            with self.subTest(invalid=invalid):
                value = sample()
                value["snapshots"][0]["reference"]["bid"] = invalid
                self.assertReferenceBlocked(value, code)

    def test_zero_local_quote_never_flat_return(self):
        value = sample()
        value["snapshots"][0]["quote_usd"]["bid"] = "0"
        self.assertLocalBlocked(value, "NONPOSITIVE_VALUE")

    def test_crossed_reference_and_local_bid_ask(self):
        value = sample()
        value["snapshots"][0]["reference"]["bid"] = "101"
        self.assertReferenceBlocked(value, "CROSSED_MARK")
        value = sample()
        value["snapshots"][0]["quote_usd"]["bid"] = "101"
        self.assertLocalBlocked(value, "CROSSED_MARK")

    def test_pool_orientation_and_currency_binding(self):
        value = sample()
        value["pool"]["token0"], value["pool"]["token1"] = value["pool"]["token1"], value["pool"]["token0"]
        self.assertLocalBlocked(value, "POOL_ORIENTATION")
        value = sample()
        value["snapshots"][0]["pool_mark"]["token0"] = value["pool"]["token1"]
        self.assertLocalBlocked(value, "TOKEN_IDENTITY_MISMATCH")

    def test_pool_id_and_block_binding(self):
        for field, changed, code in [("pool_id", "0x" + "7" * 64, "POOL_ID_MISMATCH"),
                                     ("block_hash", "0x" + "7" * 64, "BLOCK_MISMATCH"),
                                     ("block_number", 9, "BLOCK_MISMATCH")]:
            value = sample()
            value["snapshots"][0]["pool_mark"][field] = changed
            self.assertLocalBlocked(value, code)

    def test_missing_and_reorged_local_evidence(self):
        value = sample()
        value["snapshots"][0]["canonical"] = False
        self.assertLocalBlocked(value, "NONCANONICAL_OR_UNKNOWN")
        value = sample()
        value["snapshots"][0].pop("quote_usd")
        self.assertLocalBlocked(value, "OBJECT_REQUIRED")

    def test_unknown_hook_never_qualifies_as_signal(self):
        value = sample()
        value["pool"].update(hook="0x" + "9" * 40, hook_status="unknown")
        result = analyze(value)
        self.assertEqual(result["status"], "COMPLETE_MARK_ATTRIBUTION")
        self.assertEqual(result["mark_quality"], "UNQUALIFIED")
        self.assertFalse(result["qualifies_as_signal"])
        self.assertIn("UNKNOWN_HOOK", [i["code"] for i in result["qualification_issues"]])

    def test_unverified_source_is_visible(self):
        value = sample()
        value["snapshots"][0]["quote_usd"]["quality"] = "unverified"
        result = analyze(value)
        self.assertEqual(result["mark_quality"], "UNQUALIFIED")
        self.assertTrue(any(p["quality_assertion"] == "unverified" for p in result["provenance"]))

    def test_asset_migration_cannot_be_treated_as_continuous_return(self):
        value = sample()
        value["asset_continuity"] = "broken"
        self.assertLocalBlocked(value, "BROKEN_CONTINUITY")

    def test_snapshot_future_and_nonascending(self):
        value = sample()
        value["as_of"] = "2026-09-08T14:00:03Z"
        self.assertLocalBlocked(value, "KNOWLEDGE_CUTOFF")
        value = sample()
        value["snapshots"].reverse()
        self.assertLocalBlocked(value, "SNAPSHOT_ORDER")

    def test_raw_integer_and_q96_range(self):
        for invalid in ("0", "1.0", 1, True, "-2", str(2**256)):
            value = sample()
            value["snapshots"][0]["pool_mark"]["token0_raw"] = invalid
            self.assertLocalBlocked(value, "RAW_INTEGER_RANGE" if invalid == str(2**256) else "RAW_INTEGER_REQUIRED")
        value = sample()
        value["snapshots"][0]["pool_mark"].update(kind="sqrt_price_x96", sqrt_price_x96="1")
        self.assertLocalBlocked(value, "SQRT_PRICE_RANGE")

    def test_inputs_not_mutated_and_output_deterministic(self):
        value = sample()
        original = copy.deepcopy(value)
        a, b = analyze(value), analyze(value)
        self.assertEqual(value, original)
        self.assertEqual(a, b)
        self.assertEqual(a["evidence_mode"], "synthetic")

    def test_nonfinite_json_and_wrong_root(self):
        value = sample()
        value["unexpected"] = float("nan")
        self.assertLocalBlocked(value, "JSON_REQUIRED")
        self.assertLocalBlocked([], "OBJECT_REQUIRED")

    def test_cli_writes_report_and_nonzero_for_invalid_local_data(self):
        with tempfile.TemporaryDirectory() as temp:
            src, dest = Path(temp) / "in.json", Path(temp) / "out.json"
            value = sample()
            src.write_text(json.dumps(value))
            command = [sys.executable, str(ROOT / "scripts" / "attribution.py"), "--input", str(src), "--output", str(dest)]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(dest.read_text())["status"], "COMPLETE_MARK_ATTRIBUTION")
            value["chain_id"] = 1
            src.write_text(json.dumps(value))
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 2)
            self.assertEqual(json.loads(dest.read_text())["status"], "INSUFFICIENT_DATA")


if __name__ == "__main__":
    unittest.main()
