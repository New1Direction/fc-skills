#!/usr/bin/env python3
"""Compare predeclared fixed V3 ranges on supplied historical price samples."""
import argparse
import hashlib
import json
from fractions import Fraction
from lp_math import (MIN_TICK, MAX_TICK, amounts_for_liquidity, costs_total, fraction_json,
                     identity, integer, quote_value, read_json, refs, source_kind,
                     sqrt_ratio_at_tick, text, tick_at_sqrt_ratio, uint, validate_tick_price, write_json)


def analyze(data):
    if data.get('schema') != 'lp-edge.ranges-input.v1':
        raise ValueError('unsupported ranges input schema')
    source = source_kind(data.get('source_kind'))
    ident = identity(data['identity'])
    provenance = refs(data.get('provenance'))
    integer(data['predeclared_at'], 'predeclared_at')
    refs(data.get('declaration_evidence_ids'), 'declaration evidence')
    integer(data['knowledge_cutoff'], 'knowledge_cutoff')
    spacing = integer(data['tick_spacing'], 'tick spacing', 1, 32767)
    samples = data['samples']
    if not isinstance(samples, list) or not 2 <= len(samples) <= 10000:
        raise ValueError('need 2..10000 price samples')
    prior = -1
    for item in samples:
        integer(item['timestamp'], 'sample timestamp')
        integer(item['available_at'], 'sample available_at')
        if item['timestamp'] <= prior or not item['timestamp'] <= item['available_at'] <= data['knowledge_cutoff']:
            raise ValueError('samples must have increasing event times and valid availability before cutoff')
        prior = item['timestamp']
        sqrt_price = uint(item['sqrt_price_x96'], 'sample sqrt price', 160)
        validate_tick_price(item['tick'], sqrt_price)
        refs(item['evidence_ids'], 'sample evidence')
    if data['predeclared_at'] > samples[0]['timestamp']:
        raise ValueError('range declaration must precede the first evaluated sample')
    ranges = data['ranges']
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 50:
        raise ValueError('need 1..50 ranges')
    stresses = data.get('stress_prices', [])
    if not isinstance(stresses, list) or len(stresses) > 50:
        raise ValueError('at most 50 stress prices')
    stress_ids = set()
    for stress in stresses:
        sid = text(stress['id'], 'stress id')
        if sid in stress_ids:
            raise ValueError('duplicate stress id')
        stress_ids.add(sid)
        tick_at_sqrt_ratio(uint(stress['sqrt_price_x96'], 'stress sqrt price', 160))
    quote, results, ids = ident['quote_token'], [], set()
    first_price, last_price = [int(s['sqrt_price_x96']) for s in (samples[0], samples[-1])]
    for item in ranges:
        rid = text(item['id'], 'range id')
        if rid in ids:
            raise ValueError('duplicate range id')
        ids.add(rid)
        lower = integer(item['tick_lower'], 'lower tick', MIN_TICK, MAX_TICK)
        upper = integer(item['tick_upper'], 'upper tick', lower + 1, MAX_TICK)
        if lower % spacing or upper % spacing:
            raise ValueError('range does not align with tick spacing')
        liquidity = uint(item['liquidity'], 'liquidity', 128)
        if liquidity == 0:
            raise ValueError('positive range liquidity required')
        a, b = sqrt_ratio_at_tick(lower), sqrt_ratio_at_tick(upper)
        # Entry requires ceil amounts. Hold has the same starting token budget.
        entry = amounts_for_liquidity(first_price, a, b, liquidity, round_up=True)
        inventory = [amounts_for_liquidity(int(s['sqrt_price_x96']), a, b, liquidity) for s in samples]
        first_value = quote_value(*entry, first_price, quote)
        end_value = quote_value(*inventory[-1], last_price, quote)
        hold_value = quote_value(*entry, last_price, quote)
        active = [lower <= s['tick'] < upper for s in samples]
        cost = costs_total(item.get('costs'), quote)
        fees = item.get('scenario_fees')
        fee_value = None
        if fees is not None:
            if not isinstance(fees, dict):
                raise ValueError('scenario_fees must be an object or null')
            source_kind(fees['source_kind'])
            text(fees['basis'], 'fee basis')
            refs(fees['evidence_ids'], 'fee evidence')
            text(fees['assumptions'], 'fee assumptions')
            amount0 = uint(fees['amount0_raw'], 'scenario fee0')
            amount1 = uint(fees['amount1_raw'], 'scenario fee1')
            if fees['source_kind'] != 'unknown':
                fee_value = quote_value(amount0, amount1, last_price, quote)
        net = end_value + fee_value - cost if fee_value is not None and cost is not None else None
        stress_results = []
        for stress in stresses:
            price = int(stress['sqrt_price_x96'])
            amounts = amounts_for_liquidity(price, a, b, liquidity)
            value = quote_value(*amounts, price, quote)
            hold = quote_value(*entry, price, quote)
            stress_results.append({'id': stress['id'], 'sqrt_price_x96': str(price),
                                   'principal_raw': list(map(str, amounts)),
                                   'principal_quote': fraction_json(value), 'hold_quote': fraction_json(hold),
                                   'principal_difference_vs_hold_quote': fraction_json(value - hold),
                                   'fees_required_to_match_hold_quote': fraction_json(max(0, hold - value + cost)) if cost is not None else None,
                                   'assumption': 'Terminal inventory stress; no path, fee, timing, or exit-fill forecast.'})
        results.append({'id': rid, 'tick_lower': lower, 'tick_upper': upper, 'liquidity': str(liquidity),
                        'entry_required_raw_round_up': list(map(str, entry)),
                        'end_principal_raw_round_down': list(map(str, inventory[-1])),
                        'observed_sample_count': len(samples), 'active_sample_count': sum(active),
                        'active_sample_fraction': fraction_json(Fraction(sum(active), len(active))),
                        'exact_time_in_range_seconds': None,
                        'initial_capital_quote': fraction_json(first_value),
                        'end_principal_quote': fraction_json(end_value), 'hold_end_quote': fraction_json(hold_value),
                        'inventory_difference_vs_hold_quote': fraction_json(end_value - hold_value),
                        'hold_price_change_quote': fraction_json(hold_value - first_value),
                        'scenario_fee_inputs': fees, 'scenario_fees_end_spot_quote': fraction_json(fee_value),
                        'incremental_costs_vs_hold_quote': fraction_json(cost),
                        'fees_required_to_match_hold_quote': fraction_json(max(0, hold_value - end_value + cost)) if cost is not None else None,
                        'modeled_end_net_costs_quote': fraction_json(net),
                        'modeled_net_difference_vs_hold_quote': fraction_json(net - hold_value) if net is not None else None,
                        'incentives': 'Excluded; no reward-token realizable value supplied by this range schema.',
                        'stress': stress_results,
                        'status': 'missing_fee_assumption' if fee_value is None else ('incomplete_costs' if cost is None else 'conditional_scenario')})
    return {'schema': 'lp-edge.ranges-report.v1', 'source_kind': source,
            'input_sha256': hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'identity': ident, 'provenance': provenance, 'predeclared_at': data['predeclared_at'],
            'declaration_evidence_ids': data['declaration_evidence_ids'],
            'declaration_authentication': 'Supplied assertion; helper does not authenticate historical declaration time.',
            'knowledge_cutoff': data['knowledge_cutoff'], 'sample_start': samples[0]['timestamp'],
            'sample_end': samples[-1]['timestamp'],
            'maximum_sample_gap_seconds': max(y['timestamp'] - x['timestamp'] for x, y in zip(samples, samples[1:])),
            'quote_unit': 'raw token' + str(quote) + ' units', 'ranges': results,
            'limitations': ['Fixed-liquidity terminal inventory scenarios, not a transaction replay or profitability backtest.',
                            'Sample occupancy is not exact time in range; between-sample crossings are unknown.',
                            'Fees are supplied scenarios, never inferred from volume, TVL, or samples.',
                            'No fee-growth replay for hypothetical ticks; initialization and liquidity competition are not reconstructed.',
                            'Marginal pool spot marks are not executable conversion or liquidation proceeds.',
                            'Ranges can require different starting token budgets; no automatic investment ranking.',
                            'Quote-token repricing against USD or a stock underlying is not measured.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        write_json(args.output, analyze(read_json(args.input)))
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(2, f'error: {exc}\n')


if __name__ == '__main__':
    main()
