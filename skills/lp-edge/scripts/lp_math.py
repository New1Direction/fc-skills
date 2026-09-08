#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Exact V3 arithmetic. TickMath constants adapted from Uniswap/v3-core.
https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol
No RPC, signing, prices from floats, or token transfer assumptions in this module.
"""
import json
import re
from fractions import Fraction
from pathlib import Path

Q96 = 1 << 96
Q128 = 1 << 128
U256 = 1 << 256
MAX_U128 = (1 << 128) - 1
MIN_TICK, MAX_TICK = -887272, 887272
MIN_SQRT_RATIO = 4295128739
MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342
_FACTORS = tuple(int(x, 16) for x in (
    'fffcb933bd6fad37aa2d162d1a594001', 'fff97272373d413259a46990580e213a',
    'fff2e50f5f656932ef12357cf3c7fdcc', 'ffe5caca7e10e4e61c3624eaa0941cd0',
    'ffcb9843d60f6159c9db58835c926644', 'ff973b41fa98c081472e6896dfb254c0',
    'ff2ea16466c96a3843ec78b326b52861', 'fe5dee046a99a2a811c461f1969c3053',
    'fcbe86c7900a88aedcffc83b479aa3a4', 'f987a7253ac413176f2b074cf7815e54',
    'f3392b0822b70005940c7a398e4b70f3', 'e7159475a2c29b7443b29c7fa6e889d9',
    'd097f3bdfd2022b8845ad8f792aa5825', 'a9f746462d870fdf8a65dc1f90e061e5',
    '70d869a156d2a1b890bb3df62baf32f7', '31be135f97d08fd981231505542fcfa6',
    '9aa508b5b7a84e1c677de54f3e99bc9', '5d6af8dedb81196699c329225ee604',
    '2216e584f5fa1ea926041bedfe98', '48a170391f7dc42444e8fa2'))


def integer(value, name, low=0, high=U256 - 1):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{name}: integer outside [{low}, {high}]')
    return value


def uint(value, name, bits=256):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,77}', value):
        raise ValueError(f'{name}: expected canonical unsigned decimal string')
    return integer(int(value), name, 0, (1 << bits) - 1)


def text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError(f'{name}: expected nonempty bounded text')
    return value


def refs(value, name='provenance'):
    if not isinstance(value, list) or not 1 <= len(value) <= 100:
        raise ValueError(f'{name}: expected 1..100 evidence references')
    return [text(x, name) for x in value]


def fraction_json(value):
    if value is None:
        return None
    value = Fraction(value)
    return {'numerator': str(value.numerator), 'denominator': str(value.denominator)}


def sqrt_ratio_at_tick(tick):
    integer(tick, 'tick', MIN_TICK, MAX_TICK)
    absolute = abs(tick)
    ratio = Q128
    for bit, factor in enumerate(_FACTORS):
        if absolute & (1 << bit):
            ratio = ratio * factor >> 128
    if tick > 0:
        ratio = (U256 - 1) // ratio
    return (ratio + (1 << 32) - 1) >> 32


def tick_at_sqrt_ratio(sqrt_price_x96):
    integer(sqrt_price_x96, 'sqrt price', MIN_SQRT_RATIO, MAX_SQRT_RATIO - 1)
    lower, upper = MIN_TICK, MAX_TICK
    while lower < upper:
        middle = (lower + upper + 1) // 2
        if sqrt_ratio_at_tick(middle) <= sqrt_price_x96:
            lower = middle
        else:
            upper = middle - 1
    return lower


def validate_tick_price(tick, sqrt_price_x96):
    """slot0.tick can be one below mathematical tick at a downward crossing."""
    integer(tick, 'tick', MIN_TICK, MAX_TICK - 1)
    actual = tick_at_sqrt_ratio(sqrt_price_x96)
    if tick != actual and not (tick == actual - 1 and sqrt_price_x96 == sqrt_ratio_at_tick(actual)):
        raise ValueError('slot0 tick and sqrt price disagree')


def amounts_for_liquidity(sqrt_price_x96, sqrt_lower_x96, sqrt_upper_x96, liquidity, round_up=False):
    integer(sqrt_price_x96, 'sqrt price', MIN_SQRT_RATIO, MAX_SQRT_RATIO)
    integer(sqrt_lower_x96, 'sqrt lower', MIN_SQRT_RATIO, MAX_SQRT_RATIO)
    integer(sqrt_upper_x96, 'sqrt upper', sqrt_lower_x96 + 1, MAX_SQRT_RATIO)
    integer(liquidity, 'liquidity', 0, MAX_U128)
    if type(round_up) is not bool:
        raise ValueError('round_up must be boolean')
    price = min(max(sqrt_price_x96, sqrt_lower_x96), sqrt_upper_x96)
    n0 = liquidity * Q96 * (sqrt_upper_x96 - price)
    d0 = price * sqrt_upper_x96
    n1 = liquidity * (price - sqrt_lower_x96)
    return ((n0 + d0 - 1) // d0, (n1 + Q96 - 1) // Q96) if round_up else (n0 // d0, n1 // Q96)


def fee_growth_inside(global_x128, lower_outside_x128, upper_outside_x128, tick, tick_lower, tick_upper):
    for value in (global_x128, lower_outside_x128, upper_outside_x128):
        integer(value, 'fee growth')
    integer(tick_lower, 'lower tick', MIN_TICK, MAX_TICK)
    integer(tick_upper, 'upper tick', tick_lower + 1, MAX_TICK)
    integer(tick, 'current tick', MIN_TICK, MAX_TICK)
    below = lower_outside_x128 if tick >= tick_lower else (global_x128 - lower_outside_x128) % U256
    above = upper_outside_x128 if tick < tick_upper else (global_x128 - upper_outside_x128) % U256
    return (global_x128 - below - above) % U256


def accrued_fees(liquidity, inside_now_x128, inside_last_x128):
    integer(liquidity, 'liquidity', 0, MAX_U128)
    integer(inside_now_x128, 'inside now')
    integer(inside_last_x128, 'inside last')
    return liquidity * ((inside_now_x128 - inside_last_x128) % U256) // Q128


def quote_value(amount0, amount1, sqrt_price_x96, quote_token):
    """Marginal spot mark in raw quote units; never an executable proceeds quote."""
    integer(sqrt_price_x96, 'sqrt price', MIN_SQRT_RATIO, MAX_SQRT_RATIO)
    integer(quote_token, 'quote_token', 0, 1)
    p = Fraction(sqrt_price_x96 * sqrt_price_x96, Q96 * Q96)
    return Fraction(amount1) + Fraction(amount0) * p if quote_token == 1 else Fraction(amount0) + Fraction(amount1) / p


def read_json(path):
    with Path(path).open('rb') as handle:
        raw = handle.read(5_000_001)
    if len(raw) > 5_000_000:
        raise ValueError('input exceeds 5 MB')
    def object_pairs(pairs):
        result = {}
        for k, v in pairs:
            if k in result:
                raise ValueError(f'duplicate JSON key: {k}')
            result[k] = v
        return result
    def reject_float(value):
        raise ValueError('floats and nonfinite values are forbidden; use raw integer strings')
    try:
        result = json.loads(raw, object_pairs_hook=object_pairs, parse_float=reject_float, parse_constant=reject_float)
    except RecursionError as exc:
        raise ValueError('JSON nesting too deep') from exc
    if not isinstance(result, dict):
        raise ValueError('root must be an object')
    return result


def write_json(path, report):
    encoded = json.dumps(report, sort_keys=True, indent=2, allow_nan=False) + '\n'
    with open(path, 'x', encoding='utf-8') as handle:
        handle.write(encoded)


def costs_total(costs, quote_token):
    """LP incremental costs versus holding; all five categories must be supplied."""
    if costs is None:
        return None
    if not isinstance(costs, dict) or type(costs.get('complete')) is not bool:
        raise ValueError('costs must contain explicit boolean complete')
    if costs.get('quote_token') != quote_token or type(costs.get('quote_token')) is not int:
        raise ValueError('cost quote token must match report quote token')
    refs(costs.get('evidence_ids'), 'cost evidence_ids')
    if costs['complete'] is False:
        return None
    total = 0
    for key in ('entry', 'rebalance', 'collect', 'withdrawal', 'conversion'):
        item = costs.get(key)
        if item is None:
            return None
        total += uint(item, f'costs.{key}')
    return Fraction(total)


def identity(value):
    if not isinstance(value, dict):
        raise ValueError('identity must be object')
    for name in ('chain_id', 'pool', 'token0', 'token1'):
        text(value.get(name), 'identity.' + name)
    if value['token0'] == value['token1']:
        raise ValueError('pool tokens must differ')
    for name in ('decimals0', 'decimals1'):
        integer(value.get(name), 'identity.' + name, 0, 255)
    integer(value.get('quote_token'), 'quote_token', 0, 1)
    return value


def source_kind(value):
    if value not in ('observed', 'synthetic', 'unknown'):
        raise ValueError('source_kind must be observed, synthetic, or unknown')
    return value
