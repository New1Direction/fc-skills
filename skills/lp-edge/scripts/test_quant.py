#!/usr/bin/env python3
"""Offline arithmetic and failure-state checks; no performance claim."""
import copy
import json
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from lp_math import *
from analyze_position import analyze as position, analyze_snapshot
from analyze_ranges import analyze as ranges

ASSETS = Path(__file__).resolve().parents[1] / 'assets'

def fixture(name):
    return json.loads((ASSETS / name).read_text())

def rational(value):
    return Fraction(int(value['numerator']), int(value['denominator']))


class Arithmetic(unittest.TestCase):
    def test_tick_extremes_and_zero(self):
        self.assertEqual(sqrt_ratio_at_tick(MIN_TICK), MIN_SQRT_RATIO)
        self.assertEqual(sqrt_ratio_at_tick(MAX_TICK), MAX_SQRT_RATIO)
        self.assertEqual(sqrt_ratio_at_tick(0), Q96)
        self.assertEqual(sqrt_ratio_at_tick(1), 79232123823359799118286999568)
        self.assertEqual(sqrt_ratio_at_tick(-1), 79224201403219477170569942574)

    def test_tick_roundtrip_and_order(self):
        ticks = [MIN_TICK, -800000, -192180, -6000, -1, 0, 1, 6000, 193380, 800000, MAX_TICK-1]
        prices = [sqrt_ratio_at_tick(t) for t in ticks]
        self.assertEqual(prices, sorted(prices))
        for tick, price in zip(ticks, prices):
            self.assertEqual(tick_at_sqrt_ratio(price), tick)
            self.assertEqual(tick_at_sqrt_ratio(sqrt_ratio_at_tick(tick+1)-1), tick)

    def test_invalid_math_inputs(self):
        for tick in (True, 1.0, MAX_TICK+1, MIN_TICK-1):
            with self.assertRaises(ValueError):
                sqrt_ratio_at_tick(tick)
        with self.assertRaises(ValueError):
            tick_at_sqrt_ratio(MAX_SQRT_RATIO)

    def test_slot_tick_downward_boundary(self):
        validate_tick_price(-1, Q96)
        with self.assertRaises(ValueError):
            validate_tick_price(-2, Q96)
        with self.assertRaises(ValueError):
            validate_tick_price(-1, Q96+1)

    def test_amounts_against_independent_fraction_equations(self):
        low, high, L = sqrt_ratio_at_tick(-6000), sqrt_ratio_at_tick(6000), 10**12
        for t in (-12000,-6000,-3000,0,3000,6000,12000):
            price = sqrt_ratio_at_tick(t)
            bounded = min(max(price, low), high)
            exact = (Fraction(L*Q96, bounded)-Fraction(L*Q96, high), Fraction(L*(bounded-low), Q96))
            floor = amounts_for_liquidity(price, low, high, L)
            ceil = amounts_for_liquidity(price, low, high, L, True)
            for actual, upper, value in zip(floor, ceil, exact):
                self.assertEqual(actual, value.numerator//value.denominator)
                self.assertEqual(upper, -(-value.numerator//value.denominator))
                self.assertIn(upper-actual, (0,1))

    def test_single_asset_boundaries_and_zero_liquidity(self):
        low, high = sqrt_ratio_at_tick(-60), sqrt_ratio_at_tick(60)
        self.assertEqual(amounts_for_liquidity(low,low,high,10000)[1],0)
        self.assertEqual(amounts_for_liquidity(high,low,high,10000)[0],0)
        self.assertEqual(amounts_for_liquidity(Q96,low,high,0),(0,0))

    def test_fee_growth_all_tick_regions(self):
        self.assertEqual(fee_growth_inside(100,20,30,0,-60,60),50)
        self.assertEqual(fee_growth_inside(100,20,10,-61,-60,60),10)
        self.assertEqual(fee_growth_inside(100,20,80,60,-60,60),60)

    def test_modular_growth(self):
        self.assertEqual(accrued_fees(Q128-1,5,U256-5),9)
        self.assertEqual(fee_growth_inside(3,U256-5,2,0,-60,60),6)

    def test_quote_units_no_float(self):
        self.assertEqual(quote_value(3,4,2*Q96,1),16)
        self.assertEqual(quote_value(3,4,2*Q96,0),4)
        self.assertEqual(fraction_json(Fraction(2,6)),{'numerator':'1','denominator':'3'})

    def test_noncanonical_raw_integer(self):
        for value in (0,True,'00','01','-1','1e6','1.0',str(U256)):
            with self.assertRaises(ValueError):
                uint(value,'test')


class Positions(unittest.TestCase):
    def setUp(self):
        self.data=fixture('synthetic-position.json')

    def test_positive_fees_underperform_hold(self):
        r=position(self.data)
        self.assertEqual(r['earned_fees_interval_raw'],['0','50000000000'])
        self.assertLess(rational(r['net_difference_vs_hold_quote']),0)
        self.assertGreater(rational(r['fees_required_to_match_hold_quote']),rational(r['earned_fees_end_spot_quote']))

    def test_owed_principal_not_labeled_earned(self):
        r=position(self.data)
        self.assertEqual(r['snapshots'][0]['stored_tokens_owed_raw'][0],'10000000000')
        self.assertEqual(r['earned_fees_interval_raw'][0],'0')
        changed=copy.deepcopy(self.data)
        for s in changed['snapshots']:
            s['position']['tokens_owed0']='20000000000'
        self.assertEqual(position(changed)['net_difference_vs_hold_quote'],r['net_difference_vs_hold_quote'])

    def test_missing_cost_and_missing_category_are_unknown(self):
        for costs in (None,dict(self.data['costs'],conversion=None),dict(self.data['costs'],complete=False)):
            self.data['costs']=costs
            r=position(self.data)
            self.assertIsNone(r['lp_end_net_costs_quote'])
            self.assertIsNone(r['fees_required_to_match_hold_quote'])

    def test_explicit_zero_cost_is_known(self):
        for key in ('entry','rebalance','collect','withdrawal','conversion'):
            self.data['costs'][key]='0'
        self.assertEqual(position(self.data)['incremental_costs_vs_hold_quote'],fraction_json(0))

    def test_missing_coverage_suppresses_earned_fees(self):
        self.data['continuity']['complete']=False
        r=position(self.data)
        self.assertIsNone(r['earned_fees_interval_raw'])
        self.assertIsNone(r['lp_end_net_costs_quote'])

    def test_mutation_and_collection_rejected(self):
        for key in ('liquidity','fee_growth_inside0_last_x128','tokens_owed1','owner'):
            d=copy.deepcopy(self.data)
            d['snapshots'][1]['position'][key]='1'
            with self.assertRaises(ValueError):position(d)
        self.data['continuity']['events']=[{'event':'Collect'}]
        with self.assertRaises(ValueError):position(self.data)

    def test_wrong_continuity_interval_is_unqualified(self):
        self.data['continuity']['from_block']=100
        self.assertFalse(position(self.data)['continuity_qualified'])

    def test_counter_bound_required(self):
        self.data['continuity']['fee_growth_wrap_bound_confirmed']=False
        self.assertIsNone(position(self.data)['earned_fees_interval_raw'])

    def test_mixed_identity_rejected(self):
        self.data['snapshots'][1]['pool']['address']='another-pool'
        with self.assertRaises(ValueError):position(self.data)

    def test_nonincreasing_time_rejected(self):
        self.data['snapshots'][1]['block']['timestamp']=self.data['snapshots'][0]['block']['timestamp']
        with self.assertRaises(ValueError):position(self.data)

    def test_uninitialized_live_position_rejected(self):
        self.data['snapshots'][0]['range']['lower']['initialized']=False
        with self.assertRaises(ValueError):position(self.data)

    def test_debt_overflow_rejected(self):
        s=self.data['snapshots'][1]
        s['position']['tokens_owed1']=str(MAX_U128)
        with self.assertRaises(ValueError):analyze_snapshot(s)

    def test_accumulated_rounding_carry(self):
        # Constant checkpoint: integer differences preserve an accrued fractional carry.
        L=3
        s0,s1=self.data['snapshots']
        for s,g in ((s0,Q128//2),(s1,Q128)):
            s['position']['liquidity']=str(L)
            s['pool']['fee_growth_global0_x128']=str(g)
            s['range']['upper']['fee_growth_outside0_x128']=str(g if s is s1 else 0)
        self.assertEqual(position(self.data)['earned_fees_interval_raw'][0],'2')
        self.assertEqual(accrued_fees(L,Q128,Q128//2),1)

    def test_negative_pending_delta_rejected(self):
        self.data['snapshots'][0]['pool']['fee_growth_global1_x128']=str(Q128)
        with self.assertRaises(ValueError):position(self.data)

    def test_unknown_source_suppresses_qualified_fees(self):
        self.data['source_kind']='unknown'
        self.assertIsNone(position(self.data)['earned_fees_interval_raw'])
        self.assertEqual(position(self.data)['status'],'unknown_source')

    def test_cost_quote_mismatch_rejected(self):
        self.data['costs']['quote_token']=0
        with self.assertRaises(ValueError):position(self.data)


class Ranges(unittest.TestCase):
    def setUp(self):
        self.data=fixture('synthetic-ranges.json')

    def test_sparse_samples_never_exact_duration(self):
        r=ranges(self.data)
        narrow=r['ranges'][0]
        self.assertEqual(narrow['active_sample_count'],2)
        self.assertEqual(narrow['active_sample_fraction'],fraction_json(Fraction(1,2)))
        self.assertIsNone(narrow['exact_time_in_range_seconds'])
        self.assertEqual(r['maximum_sample_gap_seconds'],100)

    def test_unknown_fees_stay_unknown(self):
        wide=ranges(self.data)['ranges'][1]
        self.assertIsNone(wide['scenario_fees_end_spot_quote'])
        self.assertIsNone(wide['modeled_net_difference_vs_hold_quote'])

    def test_unknown_provenance_fees_stay_unknown(self):
        self.data['ranges'][0]['scenario_fees']['source_kind']='unknown'
        self.assertIsNone(ranges(self.data)['ranges'][0]['modeled_end_net_costs_quote'])

    def test_late_declaration_rejected(self):
        self.data['predeclared_at']=100101
        with self.assertRaises(ValueError):ranges(self.data)

    def test_future_availability_rejected(self):
        self.data['samples'][-1]['available_at']=100501
        with self.assertRaises(ValueError):ranges(self.data)

    def test_duplicate_timestamp_rejected(self):
        self.data['samples'][1]['timestamp']=self.data['samples'][0]['timestamp']
        with self.assertRaises(ValueError):ranges(self.data)

    def test_bad_tick_alignment_rejected(self):
        self.data['ranges'][0]['tick_lower']=-5999
        with self.assertRaises(ValueError):ranges(self.data)

    def test_duplicate_id_rejected(self):
        self.data['ranges'][1]['id']=self.data['ranges'][0]['id']
        with self.assertRaises(ValueError):ranges(self.data)

    def test_stress_hurdle_and_entry_rounding(self):
        r=ranges(self.data)['ranges'][0]
        self.assertGreater(rational(r['stress'][1]['fees_required_to_match_hold_quote']),0)
        self.assertLess(rational(r['modeled_net_difference_vs_hold_quote']),0)
        low,high=map(sqrt_ratio_at_tick,(-6000,6000))
        floor=amounts_for_liquidity(Q96,low,high,10**12)
        self.assertTrue(all(int(up)>=down for up,down in zip(r['entry_required_raw_round_up'],floor)))



class Bridge(unittest.TestCase):
    def packet(self, blocks=None, event_present=False):
        from test_adapter import SyntheticTransport, config, event
        from collect_v3 import collect
        cfg=config(blocks=blocks)
        transport=SyntheticTransport(cfg)
        if event_present: transport.events=[event()]
        return collect(transport,cfg,source_kind='synthetic')

    def test_one_snapshot_direct_accounting(self):
        from analyze_evidence import analyze_packet
        r=analyze_packet(self.packet([100]))
        self.assertEqual(r['interval_status'],'single_snapshot_only')
        self.assertEqual(r['snapshots'][0]['accounting']['pending_fee_accrual_since_checkpoint_raw'],['17000','27000'])
        self.assertEqual(r['source_kind'],'synthetic')

    def test_provider_no_events_not_complete(self):
        from analyze_evidence import analyze_packet
        r=analyze_packet(self.packet())
        self.assertEqual(r['transcript_reconciliation'],'passed')
        self.assertFalse(r['interval']['continuity_qualified'])
        self.assertIsNone(r['interval']['earned_fees_interval_raw'])

    def test_tampered_native_packet_rejected_before_accounting(self):
        from analyze_evidence import analyze_packet
        packet=self.packet()
        packet['snapshots'][0]['position']['tokens_owed0']='999'
        with self.assertRaises(ValueError):analyze_packet(packet)

    def test_explicit_certificate_qualifies_zero_fees_not_costs(self):
        from analyze_evidence import analyze_packet
        assumptions={'schema':'lp-edge.evidence-assumptions.v1','quote_token':1,
                     'continuity':{'complete':True,'from_block':101,'to_block':101,'events':[],
                                   'evidence_ids':['synthetic:independent-review'],
                                   'fee_growth_wrap_bound_confirmed':True}}
        r=analyze_packet(self.packet(),assumptions)
        self.assertEqual(r['interval']['earned_fees_interval_raw'],['0','0'])
        self.assertIsNone(r['interval']['lp_end_net_costs_quote'])

    def test_position_events_preserve_snapshot_only(self):
        from analyze_evidence import analyze_packet
        r=analyze_packet(self.packet(event_present=True))
        self.assertIsNone(r['interval'])
        self.assertEqual(r['interval_status'],'position_changes_require_separate_intervals')
        self.assertEqual(len(r['snapshots']),2)


class InputHandling(unittest.TestCase):
    def test_duplicate_float_and_nonfinite_json_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'case.json'
            for raw in ('{"a":1,"a":2}','{"a":1.2}','{"a":NaN}','[]'):
                p.write_text(raw)
                with self.assertRaises(ValueError):read_json(p)

    def test_output_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'report.json'
            write_json(p,{'a':1})
            with self.assertRaises(FileExistsError):write_json(p,{'a':2})
            self.assertEqual(read_json(p),{'a':1})


if __name__=='__main__':
    unittest.main()
