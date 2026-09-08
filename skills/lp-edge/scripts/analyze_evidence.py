#!/usr/bin/env python3
"""Verify retained V3 RPC evidence, then perform native NFT accounting without retyping."""
import argparse
import copy
import hashlib
import json
from analyze_position import analyze, analyze_snapshot
from collect_v3 import read_json as read_evidence, verify_evidence
from lp_math import integer, read_json, write_json


def analyze_packet(packet, assumptions=None):
    verify_evidence(packet)
    digest = hashlib.sha256(json.dumps(packet, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    reference = 'verified-transcript-sha256:' + digest
    if assumptions is None:
        assumptions = {'schema': 'lp-edge.evidence-assumptions.v1', 'quote_token': 1}
    required = {'schema', 'quote_token'}
    allowed = required | {'continuity', 'costs', 'incentives'}
    if not isinstance(assumptions, dict) or not required <= assumptions.keys() or assumptions.keys() - allowed:
        raise ValueError('invalid evidence assumptions fields')
    if assumptions['schema'] != 'lp-edge.evidence-assumptions.v1':
        raise ValueError('invalid evidence assumptions schema')
    quote = integer(assumptions['quote_token'], 'quote_token', 0, 1)
    snapshots = copy.deepcopy(packet['snapshots'])
    if not 1 <= len(snapshots) <= 2:
        raise ValueError('analysis bridge accepts one or two snapshots; collect a bounded interval separately')
    if any(s['position'] is None for s in snapshots):
        raise ValueError('NFT token_id collection is required for native position accounting')
    for snap in snapshots:
        snap['chain_id'] = 'eip155:' + str(packet['chain_id'])
    first = snapshots[0]
    ident = {'chain_id': first['chain_id'], 'pool': first['pool']['address'],
             'token0': first['pool']['token0'], 'token1': first['pool']['token1'],
             'decimals0': first['tokens'][0]['decimals'], 'decimals1': first['tokens'][1]['decimals'],
             'quote_token': quote}
    for s in snapshots:
        for i in (0, 1):
            if s['tokens'][i]['address'] != ident['token' + str(i)] or s['tokens'][i]['decimals'] != ident['decimals' + str(i)]:
                raise ValueError('token metadata changed between snapshots')
    result = {'schema': 'lp-edge.evidence-analysis.v1', 'source_kind': packet['source_kind'],
              'evidence_sha256': digest, 'transcript_reconciliation': 'passed',
              'verification_scope': 'Internal RPC request/response and normalized-state binding; provider honesty remains unverified.',
              'identity': ident,
              'snapshots': [{'block': s['block'], 'accounting': analyze_snapshot(s),
                             'wallet_simulations': s['simulations']} for s in snapshots],
              'interval': None, 'interval_status': 'single_snapshot_only',
              'provider_interval_activity': packet['interval_activity']}
    if len(snapshots) == 2:
        activity = packet['interval_activity'][0]
        continuity = assumptions.get('continuity')
        if continuity is None:
            continuity = {'complete': False, 'from_block': snapshots[0]['block']['number'] + 1,
                          'to_block': snapshots[1]['block']['number'], 'events': [],
                          'evidence_ids': [reference], 'fee_growth_wrap_bound_confirmed': False}
        if activity['status'] == 'position_events_present':
            if continuity.get('complete') is True:
                raise ValueError('continuity certificate contradicts retained position events')
            result['interval_status'] = 'position_changes_require_separate_intervals'
            return result
        if continuity.get('complete') is True and activity['status'] != 'provider_returned_no_events':
            raise ValueError('native interval log collection unavailable; cannot certify through this bridge')
        normalized = {'schema': 'lp-edge.position-input.v1',
                      'source_kind': 'observed' if packet['source_kind'] == 'live_rpc' else 'synthetic',
                      'provenance': [reference], 'identity': ident, 'snapshots': snapshots,
                      'continuity': continuity, 'costs': assumptions.get('costs'),
                      'incentives': assumptions.get('incentives')}
        result['interval'] = analyze(normalized)
        result['interval_status'] = result['interval']['status']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--assumptions')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        assumptions = read_json(args.assumptions) if args.assumptions else None
        write_json(args.output, analyze_packet(read_evidence(args.input), assumptions))
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(2, f'error: {exc}\n')


if __name__ == '__main__':
    main()
