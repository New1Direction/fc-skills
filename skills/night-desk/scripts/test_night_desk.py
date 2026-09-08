import copy
from decimal import Decimal
import json
from pathlib import Path
import unittest

from night_desk import analyze, strict_json


def example():
    return json.loads((Path(__file__).resolve().parents[1] / 'assets/example-input.json').read_text())


class ValuationTests(unittest.TestCase):
    def test_multiplier_and_exit_are_separate_measurements(self):
        r = analyze(example())
        self.assertEqual(r['reference']['raw_equity_bid_usd'], '99')
        self.assertEqual(r['reference']['token_mid_usd'], '200')
        self.assertEqual(r['reference']['underlying_shares'], '20')
        self.assertEqual(r['reference']['position_mid_usd'], '2000')
        self.assertEqual(r['onchain']['position_mark_usd'], '2100')
        self.assertEqual(r['onchain']['premium_mid_pct'], '5')
        self.assertEqual(r['execution']['net_exit_usd'], '2045.95')
        self.assertFalse(r['execution']['independently_verified'])
        self.assertFalse(r['execution']['live_executable_established'])

    def adjusted(self):
        x = example()
        x['reference'].pop('multiplier')
        x['reference'].update(basis='ADJUSTED_TOKEN_USD', bid='198', ask='202', time_basis='ORACLE_UPDATED',
                              oracle_status='HEALTHY', block_number=123456, block_hash='0x'+'a'*64,
                              block_timestamp='2026-09-08T15:59:56Z', observed_at='2026-09-08T15:59:57Z', canonical=True)
        return x

    def test_adjusted_oracle_no_second_multiplier(self):
        r = analyze(self.adjusted())
        self.assertEqual(r['reference']['token_mid_usd'], '200')
        self.assertIsNone(r['reference']['underlying_shares'])
        self.assertEqual(r['reference']['position_mid_usd'], '2000')

    def test_double_multiplier_is_rejected(self):
        x = self.adjusted()
        x['reference']['multiplier'] = {'value': '2'}
        self.assertEqual(analyze(x)['reference']['status'], 'INVALID')

    def test_old_oracle_updated_time_remains_stale_when_fetched_now(self):
        x = self.adjusted()
        x['reference']['source_at'] = '2026-09-08T14:00:00Z'
        r = analyze(x)
        self.assertEqual(r['reference']['status'], 'STALE')
        self.assertIsNone(r['onchain']['premium_mid_pct'])
        self.assertEqual(r['onchain']['comparison_status'], 'TIMESTAMP_MISMATCH')

    def test_paused_oracle_is_visible(self):
        x = self.adjusted()
        x['reference']['oracle_status'] = 'PAUSED'
        self.assertEqual(analyze(x)['reference']['status'], 'PAUSED_ORACLE')

    def test_future_or_timezone_missing_evidence(self):
        for date in ('2026-09-08T16:00:01Z', '2026-09-08T15:59:55'):
            x = example()
            x['reference']['source_at'] = date
            self.assertEqual(analyze(x)['reference']['status'], 'INVALID')

    def test_observation_after_cutoff_rejected(self):
        x = example()
        x['reference']['observed_at'] = '2026-09-08T16:00:01Z'
        self.assertEqual(analyze(x)['reference']['status'], 'INVALID')

    def test_closed_unknown_halted_states_separate(self):
        for market, halted, expected in (('CLOSED', False, 'CLOSED'), ('UNKNOWN', False, 'SESSION_UNKNOWN'), ('OPEN', True, 'HALTED')):
            x = example()
            x['reference'].update(market_state=market, halted=halted)
            self.assertEqual(analyze(x)['reference']['status'], expected)

    def test_pending_effective_multiplier_rejected(self):
        x = example()
        x['reference']['multiplier']['pending'] = {'value':'3', 'effective_at': x['as_of']}
        self.assertEqual(analyze(x)['reference']['status'], 'INVALID')

    def test_pending_future_preserved(self):
        x = example()
        x['reference']['multiplier']['pending'] = {'value':'3', 'effective_at':'2026-09-09T16:00:00Z'}
        r = analyze(x)
        self.assertEqual(r['reference']['token_mid_usd'], '200')
        self.assertEqual(r['reference']['pending_multiplier']['value'], '3')

    def test_one_raw_wei_precision(self):
        x = example()
        x['position']['amount_raw'] = x['execution']['amount_in_raw'] = '1'
        r = analyze(x)
        self.assertEqual(r['whole_raw_tokens'], '0.000000000000000001')
        self.assertEqual(r['reference']['position_mid_usd'], '0.0000000000000002')

    def test_invalid_numbers_and_units(self):
        for value in (1.0, '-1', 'NaN', 'Infinity', '1e9', '0'):
            x = example()
            x['reference']['bid'] = value
            self.assertEqual(analyze(x)['reference']['status'], 'INVALID')
        x = example()
        x['asset']['decimals'] = 6
        with self.assertRaises(ValueError):
            analyze(x)

    def test_output_zero_is_valid_and_cost_can_make_net_negative(self):
        x = example()
        x['execution']['output']['amount_raw'] = '0'
        self.assertEqual(analyze(x)['execution']['net_exit_usd'], '-2')

    def test_identity_and_wallet_size_route_reject(self):
        for key, replacement in (('token','0x'+'4'*40), ('wallet','0x'+'4'*40), ('amount_in_raw','1'),
                                 ('route_id','other-route'), ('chain_id',1)):
            x = example()
            x['execution'][key] = replacement
            self.assertEqual(analyze(x)['execution']['status'], 'INVALID')

    def test_wrong_fx_token_does_not_value_output(self):
        x = example()
        x['execution']['output_fx']['token'] = '0x'+'4'*40
        self.assertEqual(analyze(x)['execution']['status'], 'INVALID')

    def test_fx_missing_does_not_assume_stablecoin_peg(self):
        x = example()
        x['execution'].pop('output_fx')
        r = analyze(x)['execution']
        self.assertIsNone(r['net_exit_usd'])
        self.assertIn('OUTPUT_USD_CONVERSION_MISSING', r['gaps'])

    def test_missing_gas_is_not_zero(self):
        x = example()
        x['execution']['additional_costs_usd']['gas'] = None
        r = analyze(x)['execution']
        self.assertEqual(r['output_usd_before_additional_costs'], '2047.95')
        self.assertIsNone(r['net_exit_usd'])

    def test_stale_fx_and_stale_costs_withhold_net(self):
        for key in ('output_fx', 'additional_costs_usd'):
            x = example()
            x['execution'][key]['source_at'] = '2026-09-08T15:58:00Z'
            self.assertIsNone(analyze(x)['execution']['net_exit_usd'])

    def test_quote_and_simulation_are_not_equated(self):
        x = example()
        self.assertEqual(analyze(x)['execution']['status'], 'RETAINED_QUOTE')
        x['execution'].update(kind='WALLET_CALL_SIMULATION', success=True, call_evidence_id='fixture-call-1')
        r = analyze(x)['execution']
        self.assertEqual(r['status'], 'RETAINED_WALLET_CALL_SIMULATION')
        self.assertFalse(r['independently_verified'])

    def test_reverted_simulation_has_no_exit_value(self):
        x = example()
        x['execution'].update(kind='WALLET_CALL_SIMULATION', success=False)
        r = analyze(x)['execution']
        self.assertEqual(r['status'], 'SIMULATION_FAILED')
        self.assertIsNone(r['net_exit_usd'])

    def test_expired_retained_quote_only_historical_net(self):
        x = example()
        x['execution']['expires_at'] = '2026-09-08T15:59:59Z'
        r = analyze(x)['execution']
        self.assertEqual(r['status'], 'EXPIRED')
        self.assertIsNone(r['net_exit_usd'])
        self.assertEqual(r['historical_net_exit_usd'], '2045.95')

    def test_reorg_or_mismatched_block_invalidates_execution(self):
        for key, replacement in (('canonical',False), ('block_hash','0x'+'b'*64), ('block_number',123457)):
            x = example()
            x['execution'][key] = replacement
            self.assertEqual(analyze(x)['execution']['status'], 'INVALID')

    def test_old_block_fetched_now_is_stale(self):
        x = example()
        x['onchain']['block_timestamp'] = x['execution']['block_timestamp'] = '2026-09-08T14:00:00Z'
        r = analyze(x)
        self.assertEqual(r['onchain']['status'], 'STALE')
        self.assertEqual(r['execution']['status'], 'STALE')
        self.assertIsNone(r['execution']['net_exit_usd'])

    def test_missing_evidence_is_not_zero(self):
        x = example()
        for key in ('reference','onchain','execution'):
            x.pop(key)
        r = analyze(x)
        self.assertEqual(r['status'], 'PARTIAL')
        self.assertEqual(r['execution']['status'], 'MISSING')
        self.assertNotIn('net_exit_usd', r['execution'])

    def test_malformed_nested_evidence_is_component_invalid(self):
        x = example()
        x['reference']['multiplier'] = []
        self.assertEqual(analyze(x)['reference']['status'], 'INVALID')

    def test_input_remains_unchanged_and_hash_is_deterministic(self):
        x = example()
        before = copy.deepcopy(x)
        self.assertEqual(analyze(x), analyze(x))
        self.assertEqual(x, before)

    def test_duplicate_json_rejected(self):
        with self.assertRaises(ValueError):
            strict_json('{"bid":"1","bid":"2"}')


if __name__ == '__main__':
    unittest.main()
