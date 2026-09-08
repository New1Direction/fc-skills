import copy
from datetime import datetime, timedelta
from fractions import Fraction
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('second_wind', ROOT / 'scripts/analyze.py')
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class SecondWindTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((ROOT / 'assets/synthetic-example.json').read_text())
        self.current = self.doc['windows'][-1]

    def test_synthetic_example_distribution_and_liquidity(self):
        out = mod.analyze(self.doc)
        self.assertEqual(out['classification'], 'resurgence_with_distribution_pressure')
        self.assertEqual(out['source_kind'], 'synthetic')
        self.assertEqual(out['cohorts']['counts'], {'new': 4, 'returning': 1, 'unknown': 0})
        self.assertEqual(out['cohorts']['largest_new_group_capital_share']['exact'], '1/4')
        self.assertEqual(out['incumbent_distribution']['net_sell_quote']['exact'], '50')
        self.assertTrue(out['liquidity']['improving'])

    def test_zero_baseline_has_no_infinite_ratio(self):
        for w in self.doc['windows'][1:3]:
            w['metrics'] = {'trades': 0, 'quote_volume': '0'}
        out = mod.analyze(self.doc)
        self.assertTrue(out['documented_dormancy'])
        self.assertEqual(out['resurgence_comparison']['trades'], {'state': 'positive_from_zero', 'multiple': None})

    def test_zero_baseline_still_requires_absolute_activity(self):
        for w in self.doc['windows'][1:3]:
            w['metrics'] = {'trades': 0, 'quote_volume': '0'}
        self.current['metrics']['trades'] = 5
        self.assertFalse(mod.analyze(self.doc)['activity_resurgence'])

    def test_partial_coverage_is_not_dormancy(self):
        self.doc['windows'][1]['activity_coverage'] = 'partial'
        out = mod.analyze(self.doc)
        self.assertIsNone(out['documented_dormancy'])
        self.assertEqual(out['classification'], 'evidence_insufficient')

    def test_future_window_or_evidence_cannot_enter_features(self):
        for target in ('window', 'evidence'):
            with self.subTest(target=target):
                d = copy.deepcopy(self.doc)
                row = d['windows'][-1] if target == 'window' else d['evidence'][0]
                row['available_at'] = '2026-01-06T00:00:00Z'
                out = mod.analyze(d)
                self.assertIsNone(out['cohorts'])
                self.assertIsNone(out['liquidity'])
                self.assertIsNone(out['documented_dormancy'])

    def test_unknown_availability_excludes(self):
        self.doc['evidence'][0]['available_at'] = None
        self.assertEqual(mod.analyze(self.doc)['classification'], 'evidence_insufficient')

    def test_current_ending_after_cutoff_excluded(self):
        self.doc['cutoff'] = '2026-01-04T12:00:00Z'
        self.assertIsNone(mod.analyze(self.doc)['activity_resurgence'])

    def test_dormancy_does_not_depend_on_current_outcome(self):
        before = mod.analyze(self.doc)['documented_dormancy']
        self.current['metrics'] = {'trades': 100000, 'quote_volume': '100000000000000000000.1'}
        self.assertEqual(mod.analyze(self.doc)['documented_dormancy'], before)

    def test_new_pool_rebase_migration_or_quote_change_rejected(self):
        for event in ('new_pool', 'rebase', 'migration', 'quote_asset_change', 'unit_change', 'unknown'):
            with self.subTest(event=event):
                self.current['comparability_events'] = [event]
                out = mod.analyze(self.doc)
                self.assertIsNone(out['activity_resurgence'])
                self.assertIsNone(out['liquidity'])

    def test_exact_identity_must_match(self):
        for field in ('chain', 'token', 'quote_unit', 'token_unit', 'pool_scope'):
            with self.subTest(field=field):
                d = copy.deepcopy(self.doc)
                d['windows'][1]['identity'][field] += '-changed'
                self.assertIsNone(mod.analyze(d)['documented_dormancy'])

    def test_gaps_overlaps_unequal_duration_and_reordered_roles(self):
        for changed in ('gap', 'overlap', 'unequal', 'role'):
            with self.subTest(changed=changed):
                d = copy.deepcopy(self.doc)
                if changed == 'role':
                    d['windows'][0]['role'], d['windows'][1]['role'] = 'dormancy', 'active_history'
                else:
                    d['windows'][1]['start'] = {'gap': '2026-01-02T01:00:00Z', 'overlap': '2026-01-01T23:00:00Z', 'unequal': '2026-01-02T00:00:01Z'}[changed]
                self.assertIsNone(mod.analyze(d)['documented_dormancy'])

    def test_rates_use_seconds_not_nominal_window_count(self):
        origin = datetime(2026, 1, 1)
        for n, w in enumerate(self.doc['windows']):
            w['start'] = (origin + timedelta(hours=n * 12)).strftime('%Y-%m-%dT%H:%M:%SZ')
            w['end'] = (origin + timedelta(hours=(n + 1) * 12)).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.current.pop('buyers'); self.current['buyer_coverage'] = 'unknown'
        self.current.pop('incumbents')
        out = mod.analyze(self.doc)
        self.assertEqual(out['rates_per_day']['current']['trades']['exact'], '100')
        self.assertEqual(out['window_duration_seconds'], 43200)

    def test_returning_buyers_are_not_new(self):
        for buyer in self.current['buyers']:
            buyer['first_buy_at'] = '2026-01-01T01:00:00Z'
        out = mod.analyze(self.doc)
        self.assertEqual(out['cohorts']['counts']['new'], 0)
        self.assertEqual(out['classification'], 'activity_resurgence_unconfirmed')

    def test_prior_recorded_buyers_cannot_claim_current_first_purchase(self):
        self.doc['windows'][0]['buyers'] = [dict(buyer, first_buy_at=None)
                                            for buyer in self.current['buyers'][:3]]
        with self.assertRaisesRegex(ValueError, 'earlier recorded buying window'):
            mod.analyze(self.doc)
        self.doc['windows'].reverse()
        with self.assertRaisesRegex(ValueError, 'earlier recorded buying window'):
            mod.analyze(self.doc)

    def test_conflicting_known_first_purchase_dates_rejected(self):
        buyer = self.current['buyers'][0]
        buyer['first_buy_at'] = '2026-01-01T02:00:00Z'
        self.doc['windows'][0]['buyers'] = [dict(buyer, first_buy_at='2026-01-01T01:00:00Z')]
        with self.assertRaisesRegex(ValueError, 'conflicting first purchase dates'):
            mod.analyze(self.doc)

    def test_consistent_history_with_unknown_prior_date_is_returning(self):
        self.doc['windows'][0]['buyers'] = [dict(buyer, first_buy_at=None)
                                            for buyer in self.current['buyers'][:3]]
        for buyer in self.current['buyers'][:3]:
            buyer['first_buy_at'] = '2026-01-01T01:00:00Z'
        out = mod.analyze(self.doc)
        self.assertEqual(out['cohorts']['counts']['new'], 1)
        self.assertFalse(out['cohorts']['new_participation_supported'])

    def test_incomplete_histories_cannot_identify_new_buyers(self):
        self.current['history_coverage'] = 'partial'
        out = mod.analyze(self.doc)
        self.assertEqual(out['cohorts']['counts']['unknown'], 5)
        self.assertFalse(out['cohorts']['new_participation_supported'])

    def test_group_dependence_and_missing_relationships_limit_breadth(self):
        for buyer in self.current['buyers']:
            buyer['dependency_group'] = 'one-suspected-funder'
        out = mod.analyze(self.doc)
        self.assertEqual(out['cohorts']['group_scenario_count'], 1)
        self.assertFalse(out['cohorts']['new_participation_supported'])
        self.current['relationship_coverage'] = 'unknown'
        self.assertIsNone(mod.analyze(self.doc)['cohorts']['group_scenario_count'])

    def test_capital_concentration_not_just_wallet_count(self):
        self.current['buyers'][0]['buy_quote'] = '180'
        for buyer in self.current['buyers'][1:4]:
            buyer['buy_quote'] = '1'
        out = mod.analyze(self.doc)
        self.assertEqual(out['cohorts']['group_scenario_count'], 4)
        self.assertFalse(out['cohorts']['new_participation_supported'])

    def test_tiny_new_capital_cannot_confirm_large_returning_flow(self):
        for buyer in self.current['buyers'][:4]:
            buyer['buy_quote'] = '0.001'
        out = mod.analyze(self.doc)
        self.assertEqual(out['cohorts']['counts']['new'], 4)
        self.assertEqual(out['classification'], 'activity_resurgence_unconfirmed')

    def test_token_units_alone_do_not_show_better_liquidity(self):
        self.current['liquidity']['quote_reserve_end'] = '1000'
        self.current['liquidity']['depth_quote_end'] = '50'
        self.assertFalse(mod.analyze(self.doc)['liquidity']['improving'])
        del self.current['liquidity']['depth_quote_start']
        self.assertIsNone(mod.analyze(self.doc)['liquidity']['improving'])

    def test_late_incumbent_snapshot_not_used(self):
        self.current['incumbents']['snapshot_at'] = '2026-01-04T01:00:00Z'
        out = mod.analyze(self.doc)
        self.assertIsNone(out['incumbent_distribution'])
        self.assertEqual(out['classification'], 'resurgence_with_new_participation')

    def test_strict_invalid_data(self):
        mutations = [lambda d: d.update(source_kind='observed'),
                     lambda d: d.update(thresholds={'max_group_capital_share': '2'}),
                     lambda d: d['windows'][-1]['metrics'].update(quote_volume='NaN'),
                     lambda d: d['windows'][-1]['metrics'].update(trades=True),
                     lambda d: d['windows'][-1]['buyers'].append(dict(d['windows'][-1]['buyers'][0])),
                     lambda d: d['windows'][-1]['metrics'].update(quote_volume='1'),
                     lambda d: d['windows'][-1]['buyers'][0].update(first_buy_at='2026-01-06T00:00:00Z'),
                     lambda d: d.update(unexpected='x')]
        for mutate in mutations:
            d = copy.deepcopy(self.doc); mutate(d)
            with self.assertRaises(ValueError):
                mod.analyze(d)

    def test_exact_decimal_arithmetic(self):
        self.assertEqual(mod.decimal('0.1') + mod.decimal('0.2'), Fraction(3, 10))
        self.assertEqual(mod.number(Fraction(1, 3))['exact'], '1/3')

    def test_strict_json_bounds_and_duplicates(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'bad.json'
            for payload in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":1.2}', '[' * 18 + '0' + ']' * 18, ' ' * (mod.MAX_BYTES + 1)):
                p.write_text(payload)
                with self.assertRaises(ValueError):
                    mod.load(p)

    def test_cli_hash_determinism_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'report.json'
            source = ROOT / 'assets/synthetic-example.json'
            cmd = [sys.executable, str(ROOT / 'scripts/analyze.py'), '--input', str(source), '--output', str(path)]
            first = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            before = path.read_bytes()
            self.assertEqual(json.loads(before)['input_sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
            second = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(second.returncode, 2)
            self.assertEqual(path.read_bytes(), before)
            d, digest = mod.load(source)
            self.assertEqual(json.loads(before), mod.analyze(d, digest))


if __name__ == '__main__':
    unittest.main()
