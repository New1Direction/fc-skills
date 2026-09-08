#!/usr/bin/env python3
"""Analyze one unchanged canonical V3 NFT interval from normalized evidence."""
import argparse
import hashlib
import json
from lp_math import (MAX_U128, MIN_TICK, MAX_TICK, accrued_fees, amounts_for_liquidity,
                     costs_total, fee_growth_inside, fraction_json, identity, integer,
                     quote_value, read_json, refs, source_kind, sqrt_ratio_at_tick,
                     text, uint, validate_tick_price, write_json)


def analyze_snapshot(snapshot):
    p, r, nft = snapshot['pool'], snapshot['range'], snapshot['position']
    lower, upper = r['tick_lower'], r['tick_upper']
    uint(nft['token_id'], 'NFT token_id')
    text(nft['owner'], 'NFT owner')
    integer(p['fee'], 'pool fee', 0, 999999)
    integer(nft['fee'], 'NFT fee', 0, 999999)
    active_liquidity = uint(p['liquidity'], 'pool active liquidity', 128)
    integer(lower, 'lower', MIN_TICK, MAX_TICK)
    integer(upper, 'upper', lower + 1, MAX_TICK)
    spacing = integer(p['tick_spacing'], 'tick spacing', 1, 32767)
    if lower % spacing or upper % spacing:
        raise ValueError('range ticks must match pool tick spacing')
    if nft['tick_lower'] != lower or nft['tick_upper'] != upper:
        raise ValueError('NFT range does not match tick snapshots')
    liquidity = uint(nft['liquidity'], 'NFT liquidity', 128)
    sqrt_price = uint(p['sqrt_price_x96'], 'sqrt price', 160)
    validate_tick_price(p['tick'], sqrt_price)
    for side in ('lower', 'upper'):
        gross = uint(r[side]['liquidity_gross'], 'tick gross liquidity', 128)
        if liquidity and (r[side].get('initialized') is not True or gross < liquidity):
            raise ValueError('live position requires initialized boundaries with enough liquidity')
    if lower <= p['tick'] < upper and active_liquidity < liquidity:
        raise ValueError('active pool liquidity cannot be smaller than active position')
    principal = amounts_for_liquidity(sqrt_price, sqrt_ratio_at_tick(lower), sqrt_ratio_at_tick(upper), liquidity)
    inside, pending, owed = [], [], []
    for token in (0, 1):
        growth = fee_growth_inside(uint(p[f'fee_growth_global{token}_x128'], 'global growth'),
                                  uint(r['lower'][f'fee_growth_outside{token}_x128'], 'lower growth'),
                                  uint(r['upper'][f'fee_growth_outside{token}_x128'], 'upper growth'),
                                  p['tick'], lower, upper)
        inside.append(growth)
        fee = accrued_fees(liquidity, growth, uint(nft[f'fee_growth_inside{token}_last_x128'], 'last growth'))
        debt = uint(nft[f'tokens_owed{token}'], 'owed', 128)
        if fee > MAX_U128 or fee + debt > MAX_U128:
            raise ValueError('fee/debt overflow exceeds supported NFT accounting')
        pending.append(fee)
        owed.append(debt)
    return {'principal_raw': list(map(str, principal)), 'fee_growth_inside_x128': list(map(str, inside)),
            'pending_fee_accrual_since_checkpoint_raw': list(map(str, pending)),
            'stored_tokens_owed_raw': list(map(str, owed)),
            'accounting_collectable_raw': [str(a + b) for a, b in zip(pending, owed)],
            'active_at_snapshot': lower <= p['tick'] < upper,
            'owed_interpretation': 'Stored debt can include previously removed principal; not labeled earned fees.',
            'collectability': 'Accounting only; actual wallet collect and withdrawal require separate verified simulation.'}


def analyze(data):
    if data.get('schema') != 'lp-edge.position-input.v1':
        raise ValueError('unsupported position input schema')
    source = source_kind(data.get('source_kind'))
    provenance = refs(data.get('provenance'))
    ident = identity(data['identity'])
    snapshots = data['snapshots']
    if not isinstance(snapshots, list) or len(snapshots) != 2:
        raise ValueError('exactly two snapshots required')
    start, end = snapshots
    for s in snapshots:
        b, p = s['block'], s['pool']
        integer(b['number'], 'block number')
        integer(b['timestamp'], 'block timestamp')
        text(b['hash'], 'block hash')
        for k in ('address', 'token0', 'token1'):
            if p[k] != ident['pool' if k == 'address' else k]:
                raise ValueError('snapshot pool/token identity mismatch')
        if s.get('chain_id') != ident['chain_id']:
            raise ValueError('snapshot chain_id mismatch')
        if s['position'].get('token0') != ident['token0'] or s['position'].get('token1') != ident['token1']:
            raise ValueError('NFT tokens mismatch')
        if s['position'].get('fee') != p.get('fee'):
            raise ValueError('NFT fee mismatch')
    if end['block']['number'] <= start['block']['number'] or end['block']['timestamp'] <= start['block']['timestamp']:
        raise ValueError('blocks and timestamps must increase strictly')
    if end['block']['hash'] == start['block']['hash']:
        raise ValueError('different block heights cannot share a block hash')
    for k in ('factory', 'fee', 'tick_spacing'):
        if start['pool'][k] != end['pool'][k]:
            raise ValueError('pool implementation identity changed')
    for k in ('token_id', 'liquidity', 'tick_lower', 'tick_upper', 'owner',
              'fee_growth_inside0_last_x128', 'fee_growth_inside1_last_x128', 'tokens_owed0', 'tokens_owed1'):
        if k not in start['position'] or start['position'][k] != end['position'].get(k):
            raise ValueError('position changed or missing field: ' + k)
    if uint(start['position']['liquidity'], 'liquidity', 128) == 0:
        raise ValueError('interval requires positive continuous liquidity')
    continuity = data.get('continuity', {})
    covered = (continuity.get('complete') is True and continuity.get('events') == []
               and continuity.get('from_block') == start['block']['number'] + 1
               and continuity.get('to_block') == end['block']['number']
               and continuity.get('fee_growth_wrap_bound_confirmed') is True
               and source != 'unknown')
    if not isinstance(continuity.get('complete'), bool):
        raise ValueError('continuity.complete boolean required')
    evidence = refs(continuity.get('evidence_ids'), 'continuity evidence_ids')
    if continuity.get('events') and continuity.get('complete') is True:
        raise ValueError('position changes unsupported; split into unchanged intervals')
    a, b = map(analyze_snapshot, snapshots)
    earned = [int(y) - int(x) for x, y in zip(a['pending_fee_accrual_since_checkpoint_raw'], b['pending_fee_accrual_since_checkpoint_raw'])]
    if covered and any(x < 0 for x in earned):
        raise ValueError('fee accrual decreased; counter wrap/continuity assumptions invalid')
    quote = ident['quote_token']
    start_price, end_price = [int(s['pool']['sqrt_price_x96']) for s in snapshots]
    principal_start = list(map(int, a['principal_raw']))
    principal_end = list(map(int, b['principal_raw']))
    initial_value = quote_value(*principal_start, start_price, quote)
    hold = quote_value(*principal_start, end_price, quote)
    lp = quote_value(*principal_end, end_price, quote)
    fees = quote_value(*earned, end_price, quote) if covered else None
    cost = costs_total(data.get('costs'), quote)
    net = lp + fees - cost if fees is not None and cost is not None else None
    hurdle = max(0, hold - lp + cost) if cost is not None else None
    incentive = data.get('incentives')
    if incentive is not None:
        if not isinstance(incentive, list) or len(incentive) > 100:
            raise ValueError('incentives must be null or list of <=100 items')
        for item in incentive:
            text(item['token_id'], 'incentive token')
            uint(item['amount_raw'], 'incentive raw amount')
            refs(item['evidence_ids'], 'incentive evidence')
            if item.get('net_realizable_quote_raw') is not None:
                uint(item['net_realizable_quote_raw'], 'incentive quoted proceeds')
                if item.get('quote_token') != quote:
                    raise ValueError('incentive quote unit mismatch')
                refs(item.get('realization_evidence_ids'), 'incentive realization evidence')
    return {'schema': 'lp-edge.position-report.v1', 'source_kind': source,
            'provenance': provenance, 'provenance_authentication': 'Declared normalized evidence; use collector verifier for raw binding.',
            'input_sha256': hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'identity': ident, 'snapshots': [a, b], 'continuity_qualified': covered,
            'continuity_evidence_ids': evidence,
            'earned_fees_interval_raw': list(map(str, earned)) if covered else None,
            'comparison_basis': 'Starting withdrawable principal only, retained as tokens in hold comparator. Starting debt excluded from both.',
            'quote_unit': 'raw token' + str(quote) + ' units',
            'valuation_basis': 'Pool marginal spot mark; excludes liquidation price impact; quote token is not assumed USD.',
            'initial_principal_quote': fraction_json(initial_value),
            'hold_end_quote': fraction_json(hold), 'lp_principal_end_quote': fraction_json(lp),
            'inventory_difference_vs_hold_quote': fraction_json(lp - hold),
            'hold_price_change_quote': fraction_json(hold - initial_value),
            'earned_fees_end_spot_quote': fraction_json(fees),
            'incremental_costs_vs_hold_quote': fraction_json(cost),
            'fees_required_to_match_hold_quote': fraction_json(hurdle),
            'lp_end_net_costs_quote': fraction_json(net),
            'net_difference_vs_hold_quote': fraction_json(net - hold) if net is not None else None,
            'incentives_separate_not_included': incentive,
            'status': 'unknown_source' if source == 'unknown' else ('insufficient_continuity' if not covered else ('incomplete_costs' if cost is None else 'historical_spot_accounting')),
            'limitations': ['No forecast, annualization, execution proof, or reward-token value assumption.',
                            'Fee growth accounting presumes less than one full counter cycle since each unchanged NFT checkpoint.',
                            'Endpoint accounting does not establish exact time in range or interim drawdown.']}


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
