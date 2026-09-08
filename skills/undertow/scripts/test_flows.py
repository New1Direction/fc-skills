import copy
import json
import unittest
from pathlib import Path

from flows import analyze_flows, units


def addr(n):
    return "0x" + f"{n:040x}"


def h(n):
    return "0x" + f"{n:064x}"


MEME_A, STOCK_A, STOCK_B, MEME_B, CASH = [addr(x) for x in (16, 32, 48, 64, 80)]
WALLET, OTHER_WALLET, MANAGER = addr(200), addr(201), addr(250)


def fixture():
    assets = {token: {"decimals": 2, "kind": kind, "known_at": 50, "standard_token": True,
                      "evidence": "synthetic:asset-registry"}
              for token, kind in ((MEME_A, "meme"), (STOCK_A, "stock"), (STOCK_B, "stock"), (MEME_B, "meme"), (CASH, "cash"))}
    pairs = [(MEME_A, STOCK_A), (STOCK_A, CASH), (STOCK_B, MEME_B), (STOCK_B, CASH)]
    pools = [{"manager": MANAGER, "pool_id": h(i + 1), "currency0": c0, "currency1": c1,
              "hooks": addr(0), "fee": 3000, "tick_spacing": 60, "adapter_status": "verified",
              "known_at": 50, "evidence": "synthetic:pool-registry", "normalization_evidence": "synthetic:adapter-validation"}
             for i, (c0, c1) in enumerate(pairs)]
    coverage = [{"manager": MANAGER, "pool_id": p["pool_id"], "start": start, "end": end,
                 "known_at": end, "status": "complete", "evidence": "synthetic:coverage"}
                for p in pools for start, end in ((100, 200), (200, 300))]
    return {"chain_id": 4663, "knowledge_cutoff": 300, "window": {"start": 200, "end": 300},
            "baseline": {"start": 100, "end": 200}, "assets": assets, "pools": pools,
            "coverage": coverage, "swaps": [], "dataset_label": "Synthetic demonstration, not market evidence"}


def swap(pool=1, tx=21, log=0, amount0="100", amount1="-200", wallet=WALLET, timestamp=210):
    return {"event_type": "swap", "chain_id": 4663, "manager": MANAGER, "pool_id": h(pool),
            "block_number": tx, "block_hash": h(1000 + tx), "tx_hash": h(2000 + tx), "log_index": log,
            "transaction_index": 0, "timestamp": timestamp, "known_at": timestamp + 1,
            "canonical": True, "transaction_complete": True, "suspected_activity": False,
            "amount0_raw": amount0, "amount1_raw": amount1,
            "attribution": {"wallet": wallet, "method": "verified_trace", "evidence": "synthetic:wallet-trace"},
            "evidence": "synthetic:retained-normalized-swap"}


def asset(report, token):
    return next(row for row in report["assets"] if row["asset"] == token)


def rotation_fixture():
    data = fixture()
    data["swaps"] = [
        swap(amount0="-100", amount1="120"),
        swap(pool=2, log=1, amount0="-120", amount1="10000"),
        swap(pool=3, tx=22, amount0="-300", amount1="100", timestamp=220),
        swap(pool=4, tx=22, log=1, amount0="300", amount1="-8000", timestamp=220),
    ]
    data["valuations"] = [
        {"wallet": WALLET, "tx_hash": h(2021), "asset": MEME_A, "asset_amount_raw": "100",
         "numeraire": CASH, "cashflow_raw": "10000", "known_at": 211,
         "basis": "verified_tx_net_cashflow", "evidence": "synthetic:reconciled-cashflow"},
        {"wallet": WALLET, "tx_hash": h(2022), "asset": MEME_B, "asset_amount_raw": "100",
         "numeraire": CASH, "cashflow_raw": "-8000", "known_at": 221,
         "basis": "verified_tx_net_cashflow", "evidence": "synthetic:reconciled-cashflow"},
    ]
    return data


class FlowTests(unittest.TestCase):
    def test_multiplicative_route_intermediate_is_not_buyer(self):
        data = fixture()
        data["swaps"] = [swap(), swap(pool=2, log=1, amount0="200", amount1="-300")]
        report = analyze_flows(data)
        stock = asset(report, STOCK_A)
        self.assertEqual((stock["gross_buy_swaps"], stock["gross_sell_swaps"]), (1, 1))
        self.assertEqual(stock["net_delta_raw"], "0")
        self.assertEqual(stock["net_buy_wallets"], 0)
        self.assertEqual(stock["net_sell_wallets"], 0)
        self.assertEqual(stock["zero_net_wallet_transactions"], 1)
        self.assertEqual(asset(report, MEME_A)["net_delta_units"], "1")

    def test_cancel_does_not_cross_wallets_or_transactions(self):
        data = fixture()
        data["swaps"] = [swap(), swap(tx=22, wallet=OTHER_WALLET, amount0="-100", amount1="200", timestamp=220)]
        row = asset(analyze_flows(data), MEME_A)
        self.assertEqual(row["net_delta_raw"], "0")
        self.assertEqual((row["net_buy_wallets"], row["net_sell_wallets"]), (1, 1))

    def test_exact_duplicate_skipped_conflict_rejected(self):
        data = fixture()
        event = swap()
        data["swaps"] = [event, copy.deepcopy(event)]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["exact_duplicates_skipped"], 1)
        self.assertEqual(asset(report, MEME_A)["gross_buy_swaps"], 1)
        data["swaps"][1]["amount0_raw"] = "101"
        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            analyze_flows(data)

    def test_transfers_cannot_be_counted_as_swaps(self):
        data = fixture()
        event = swap()
        event["event_type"] = "transfer"
        data["swaps"] = [event]
        with self.assertRaisesRegex(ValueError, "only swap"):
            analyze_flows(data)

    def test_router_sender_is_not_a_buyer(self):
        data = fixture()
        event = swap()
        event["attribution"] = {"wallet": WALLET, "method": "router_sender"}
        data["swaps"] = [event]
        report = analyze_flows(data)
        self.assertEqual(asset(report, MEME_A)["net_buy_wallets"], 0)
        self.assertEqual(report["input_counts"]["excluded_records_by_reason"]["unknown_or_router_attribution"], 1)

    def test_unknown_route_leg_quarantines_known_leg(self):
        data = fixture()
        unknown = swap(pool=2, log=1, amount0="200", amount1="-300")
        unknown["attribution"] = {"wallet": None, "method": "unknown"}
        data["swaps"] = [swap(), unknown]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["included_swap_records"], 0)
        self.assertEqual(report["input_counts"]["excluded_records_by_reason"]["quarantined_transaction_records"], 2)
        self.assertIsNone(asset(report, MEME_A)["newly_observed_buyers_vs_baseline"])

    def test_suspected_activity_is_excluded_and_quarantines_transaction(self):
        data = fixture()
        event = swap()
        event["suspected_activity"] = True
        data["swaps"] = [event]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["excluded_records_by_reason"]["suspected_activity"], 1)
        self.assertEqual(asset(report, MEME_A)["net_delta_raw"], "0")

    def test_incomplete_transaction_has_no_endpoint(self):
        data = fixture()
        event = swap()
        event["transaction_complete"] = False
        data["swaps"] = [event]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["excluded_records_by_reason"]["incomplete_transaction"], 1)

    def test_baseline_cohort_known_and_new(self):
        data = fixture()
        data["swaps"] = [swap(tx=15, timestamp=150), swap(), swap(tx=22, timestamp=220, wallet=OTHER_WALLET)]
        row = asset(analyze_flows(data), MEME_A)
        self.assertEqual(row["net_buy_wallets"], 2)
        self.assertEqual(row["newly_observed_buyers_vs_baseline"], 1)

    def test_missing_baseline_not_zero_cohort(self):
        data = fixture()
        data.pop("baseline")
        data["swaps"] = [swap()]
        self.assertIsNone(asset(analyze_flows(data), MEME_A)["newly_observed_buyers_vs_baseline"])

    def test_partial_and_missing_coverage_do_not_claim_new_buyers(self):
        for mode in ("partial", "missing"):
            with self.subTest(mode=mode):
                data = fixture()
                data["swaps"] = [swap()]
                if mode == "missing":
                    data["coverage"] = []
                else:
                    data["coverage"][0]["status"] = "partial"
                self.assertIsNone(asset(analyze_flows(data), MEME_A)["newly_observed_buyers_vs_baseline"])

    def test_backfilled_and_future_events_excluded(self):
        data = fixture()
        late = swap()
        late["known_at"] = 301
        data["swaps"] = [late, swap(tx=40, timestamp=400)]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["included_swap_records"], 0)
        self.assertEqual(report["input_counts"]["excluded_records_by_reason"]["not_known_at_cutoff"], 2)

    def test_retrospective_mode_explicit(self):
        data = fixture()
        data["knowledge_cutoff"] = 301
        self.assertEqual(analyze_flows(data)["knowledge_mode"], "retrospective_as_of_cutoff")

    def test_pool_not_known_at_cutoff_cannot_create_flow(self):
        data = fixture()
        data["pools"][0]["known_at"] = 301
        data["swaps"] = [swap()]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["included_swap_records"], 0)
        self.assertEqual(report["input_counts"]["registered_pools_at_cutoff"], 3)

    def test_unsupported_hook_adapter_excluded(self):
        data = fixture()
        data["pools"][0]["hooks"] = addr(999)
        data["pools"][0]["adapter_status"] = "unsupported"
        data["swaps"] = [swap()]
        report = analyze_flows(data)
        self.assertEqual(report["input_counts"]["excluded_records_by_reason"]["unsupported_adapter"], 1)
        self.assertEqual(report["shared_quote_topology"][0]["unsupported_pool_count"], 1)

    def test_nonstandard_token_effects_excluded(self):
        data = fixture()
        data["assets"][MEME_A]["standard_token"] = False
        data["swaps"] = [swap()]
        self.assertEqual(analyze_flows(data)["input_counts"]["included_swap_records"], 0)

    def test_rotation_requires_order_and_different_families(self):
        data = rotation_fixture()
        report = analyze_flows(data)
        self.assertEqual(len(report["rotation_links"]), 1)
        link = report["rotation_links"][0]
        self.assertEqual((link["sell"]["family"], link["buy"]["family"]), (STOCK_A, STOCK_B))
        self.assertFalse(link["proceeds_funding_proven"])
        self.assertEqual(link["comparable_notional"]["amount_units"], "80")
        self.assertEqual(link["comparable_notional"]["amount_raw"], "8000")

    def test_rotation_without_valuations_is_link_only(self):
        data = rotation_fixture()
        data.pop("valuations")
        link = analyze_flows(data)["rotation_links"][0]
        self.assertIsNone(link["comparable_notional"])

    def test_reverse_order_is_not_rotation(self):
        data = fixture()
        data["swaps"] = [swap(pool=3, amount0="-100", amount1="100"), swap(tx=22, timestamp=220, amount0="-100", amount1="200")]
        self.assertEqual(analyze_flows(data)["rotation_links"], [])

    def test_different_wallets_do_not_imply_rotation(self):
        data = rotation_fixture()
        data.pop("valuations")
        for event in data["swaps"][2:]:
            event["attribution"]["wallet"] = OTHER_WALLET
        self.assertEqual(analyze_flows(data)["rotation_links"], [])

    def test_rotation_horizon_is_explicit(self):
        data = rotation_fixture()
        data["rotation_horizon_seconds"] = 5
        self.assertEqual(analyze_flows(data)["rotation_links"], [])

    def test_same_stock_family_is_not_cross_family_rotation(self):
        data = fixture()
        data["pools"][2]["currency0"] = STOCK_A
        data["swaps"] = [swap(amount0="-100", amount1="200"),
                         swap(pool=3, tx=22, timestamp=220, amount0="-100", amount1="100")]
        self.assertEqual(analyze_flows(data)["rotation_links"], [])

    def test_multiple_meme_endpoints_make_link_ambiguous(self):
        data = rotation_fixture()
        data.pop("valuations")
        # Sale of meme A and buy of meme B in one transaction cannot count as
        # an isolated earlier sale, even if only one family were identifiable.
        data["swaps"].append(swap(pool=3, log=2, amount0="-50", amount1="50"))
        self.assertEqual(analyze_flows(data)["rotation_links"], [])

    def test_sale_endpoint_cannot_be_reused(self):
        data = rotation_fixture()
        data.pop("valuations")
        data["swaps"].append(swap(pool=3, tx=23, timestamp=230, amount0="-100", amount1="100"))
        self.assertEqual(len(analyze_flows(data)["rotation_links"]), 1)

    def test_valuation_wrong_units_or_raw_amount_rejected(self):
        data = rotation_fixture()
        data["valuations"][0]["cashflow_raw"] = "100"
        with self.assertRaisesRegex(ValueError, "does not reconcile"):
            analyze_flows(data)
        data = rotation_fixture()
        data["valuations"][0]["numeraire"] = STOCK_A
        with self.assertRaisesRegex(ValueError, "cash numeraire"):
            analyze_flows(data)

    def test_different_cash_numeraires_are_not_compared(self):
        data = rotation_fixture()
        cash2 = addr(81)
        data["assets"][cash2] = copy.deepcopy(data["assets"][CASH])
        data["pools"][3]["currency1"] = cash2
        data["valuations"][1]["numeraire"] = cash2
        self.assertIsNone(analyze_flows(data)["rotation_links"][0]["comparable_notional"])

    def test_unrelated_stock_sale_cannot_enlarge_meme_valuation(self):
        data = rotation_fixture()
        data["swaps"].append(swap(pool=4, log=2, amount0="-999", amount1="90000"))
        data["valuations"][0]["cashflow_raw"] = "100000"
        data["swaps"][3]["amount1_raw"] = "-80000"
        data["valuations"][1]["cashflow_raw"] = "-80000"
        with self.assertRaisesRegex(ValueError, "unrelated transaction endpoints"):
            analyze_flows(data)

    def test_unrelated_roundtrip_cannot_enlarge_meme_valuation(self):
        data = rotation_fixture()
        # Other stock nets to zero, but its unrelated roundtrip makes 9000 cash.
        data["swaps"].extend([swap(pool=4, log=2, amount0="-100", amount1="10000"),
                              swap(pool=4, log=3, amount0="100", amount1="-1000")])
        data["valuations"][0]["cashflow_raw"] = "19000"
        with self.assertRaisesRegex(ValueError, "simple route"):
            analyze_flows(data)

    def test_late_valuation_does_not_leak(self):
        data = rotation_fixture()
        data["valuations"][1]["known_at"] = 301
        self.assertIsNone(analyze_flows(data)["rotation_links"][0]["comparable_notional"])

    def test_shared_quote_topology_is_unweighted(self):
        report = analyze_flows(fixture())
        self.assertEqual(len(report["assets"]), 5)
        self.assertEqual(len(report["shared_quote_topology"]), 2)
        self.assertTrue(all(row["measured_exit_capacity"] is None for row in report["shared_quote_topology"]))

    def test_canonical_reorg_conflict_rejected(self):
        data = fixture()
        event = swap(log=1)
        event["block_hash"] = h(999)
        data["swaps"] = [swap(), event]
        with self.assertRaisesRegex(ValueError, "conflicting canonical block"):
            analyze_flows(data)

    def test_noncanonical_removed(self):
        data = fixture()
        event = swap()
        event["canonical"] = False
        data["swaps"] = [event]
        self.assertEqual(analyze_flows(data)["input_counts"]["excluded_records_by_reason"]["noncanonical"], 1)

    def test_v4_fee_encoding_rejects_arbitrary_uint24(self):
        data = fixture()
        data["pools"][0]["fee"] = 1_000_001
        with self.assertRaisesRegex(ValueError, "dynamic-fee"):
            analyze_flows(data)
        data["pools"][0]["fee"] = 0x800000
        self.assertEqual(analyze_flows(data)["chain_id"], 4663)

    def test_complete_coverage_cannot_predate_interval_end(self):
        data = fixture()
        data["coverage"][0]["known_at"] = 150
        with self.assertRaisesRegex(ValueError, "cannot be known"):
            analyze_flows(data)

    def test_transaction_index_conflict_rejected(self):
        data = fixture()
        event = swap(log=1)
        event["tx_hash"] = h(99999)
        data["swaps"] = [swap(), event]
        with self.assertRaisesRegex(ValueError, "conflicting transaction index"):
            analyze_flows(data)

    def test_block_log_slot_cannot_have_multiple_transaction_hashes(self):
        data = fixture()
        a = swap()
        b = swap(tx=22, wallet=OTHER_WALLET)
        b.update(block_number=a["block_number"], block_hash=a["block_hash"], timestamp=a["timestamp"],
                 known_at=a["known_at"], transaction_index=1)
        data["swaps"] = [a, b]
        with self.assertRaisesRegex(ValueError, "log_index cannot belong"):
            analyze_flows(data)

    def test_strict_integers_and_signed_strings(self):
        for value in (True, 4663.0, "4663"):
            data = fixture()
            data["chain_id"] = value
            with self.assertRaises(ValueError):
                analyze_flows(data)
        for value in (100, 1.2, "1.2", "01", "1e3", "NaN", "9" * 90):
            data = fixture()
            event = swap()
            event["amount0_raw"] = value
            data["swaps"] = [event]
            with self.assertRaises(ValueError):
                analyze_flows(data)

    def test_decimal_rendering_preserves_large_values(self):
        amount = 2**255 + 123456789
        self.assertEqual(units(amount, 18).replace(".", ""), str(amount))
        self.assertEqual(units(1000, 0), "1000")
        self.assertEqual(units(1000, 2), "10")
        self.assertEqual(units(-1, 2), "-0.01")
        self.assertEqual(units(0, 2), "0")

    def test_input_order_does_not_change_economic_output(self):
        data = rotation_fixture()
        before = analyze_flows(data)
        data["swaps"].reverse()
        self.assertEqual(analyze_flows(data), before)

    def test_fixture_is_runnable(self):
        path = Path(__file__).resolve().parents[1] / "examples" / "flows.json"
        if path.exists():
            report = analyze_flows(json.loads(path.read_text()))
            self.assertEqual(report["chain_id"], 4663)


if __name__ == "__main__":
    unittest.main()
