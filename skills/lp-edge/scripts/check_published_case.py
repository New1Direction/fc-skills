#!/usr/bin/env python3
"""Reconcile published numeric inputs, retaining missing chain/fee fields.

This command checks arithmetic, not RPC access or a block-pinned position.
"""
import argparse
from decimal import Decimal, localcontext
from pathlib import Path
from lp_math import (read_json, write_json, sqrt_ratio_at_tick,
                     amounts_for_liquidity, fee_growth_inside, accrued_fees,
                     tick_at_sqrt_ratio)


def check(case):
    if case.get('schema') != 'lp-edge.published-case.v1' or case.get('source_kind') != 'published_case':
        raise ValueError('expected the published-case fixture')
    p = case['position']
    liquidity = int(p['liquidity'])
    lower, upper = p['tick_lower'], p['tick_upper']
    sqrt_price = int(p['sqrt_price_x96'])
    principal = amounts_for_liquidity(sqrt_price, sqrt_ratio_at_tick(lower),
                                      sqrt_ratio_at_tick(upper), liquidity)
    inside = fee_growth_inside(int(p['fee_growth_global0_x128']),
                               int(p['fee_growth_outside0_lower_x128']),
                               int(p['fee_growth_outside0_upper_x128']),
                               p['tick_current'], lower, upper)
    fees = accrued_fees(liquidity, inside, int(p['fee_growth_inside0_last_x128']))
    # An independent high-precision formula is applicable to this above-range case.
    with localcontext() as context:
        context.prec = 110
        principal1_decimal = int(Decimal(liquidity) *
            (Decimal('1.0001') ** (Decimal(upper) / 2) -
             Decimal('1.0001') ** (Decimal(lower) / 2)))
    calculated_tick = tick_at_sqrt_ratio(sqrt_price)
    checks = {
        'above_range': calculated_tick >= upper,
        'principal0_zero': principal[0] == 0,
        'principal1_independent_precision_matches': principal[1] == principal1_decimal,
        'published_principal_magnitude_matches': abs(principal[1] - int(case['published_outputs']['principal1_approximate_raw'])) < 100_000_000,
        'published_fee_integer_part_matches': fees == int(Decimal(case['published_outputs']['incremental_fee0_approximate_raw'])),
    }
    return {
        'schema': 'lp-edge.published-check.v1',
        'source_kind': 'published_case', 'source_url': case['source_url'],
        'validation_level': 'published_arithmetic_only',
        'checks': checks, 'passed': all(checks.values()),
        'principal0_raw': str(principal[0]), 'principal1_raw': str(principal[1]),
        'incremental_fee0_raw': str(fees), 'incremental_fee1_raw': None,
        'full_collectible_balances': None,
        'block_number': case['block_number'], 'block_hash': case['block_hash'],
        'live_rpc_verified': False, 'historical_chain_replay_verified': False,
        'limitations': case['limitations'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', default=str(Path(__file__).resolve().parents[1] / 'assets/published-position37.json'))
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        report = check(read_json(args.input))
        write_json(args.output, report)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(2, f'published-case check failed: {exc}\n')
    if not report['passed']:
        parser.exit(1, 'published-case arithmetic discrepancy\n')


if __name__ == '__main__':
    main()
