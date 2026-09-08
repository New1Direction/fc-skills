#!/usr/bin/env python3
"""Join retained CATALYST events to Night Desk valuations by exact asset identity.

This is an offline interchange format for application consumers. It does not
run a collector, mutate WATCHTOWER, or publish into FYNCH or Ape.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp must be an ISO string with timezone')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timezone is required')
    return result.astimezone(timezone.utc)


def identity(chain, token):
    if type(chain) is not int or chain != 4663:
        raise ValueError('only chain 4663 is supported')
    if not isinstance(token, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', token):
        raise ValueError('exact token address is required')
    return chain, token.lower()


def digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def compose(events, valuations, as_of):
    cutoff = timestamp(as_of)
    if events.get('schemaVersion') != 'CatalystEvents@1' or not isinstance(events.get('events'), list):
        raise ValueError('expected CatalystEvents@1')
    if len(events['events']) > 10000 or len(valuations) > 10000:
        raise ValueError('bounded composition allows at most 10000 events and valuations')
    by_asset, retained, excluded = {}, {}, []
    for report in valuations:
        if report.get('schema') != 'NightDeskReport@1':
            raise ValueError('expected NightDeskReport@1')
        key = identity(report['asset']['chain_id'], report['asset']['token'])
        report_time = timestamp(report['as_of'])
        report_id = digest(report)
        if report_time > cutoff:
            excluded.append({'kind': 'valuation', 'id': report_id, 'reason': 'AFTER_VIEW_AS_OF'})
            continue
        if report_id not in retained:
            retained[report_id] = report
            by_asset.setdefault(key, []).append((report_id, report_time))
    joined, seen = [], {}
    for event in events['events']:
        event_id = event.get('id')
        if not isinstance(event_id, str) or not event_id:
            raise ValueError('event id is required')
        event_digest = digest(event)
        if event_id in seen:
            if seen[event_id] != event_digest:
                raise ValueError('conflicting event id: ' + event_id)
            continue
        seen[event_id] = event_digest
        observed = timestamp(event['firstObservedAt'])
        if observed > cutoff:
            excluded.append({'kind': 'event', 'id': event_id, 'reason': 'AFTER_VIEW_AS_OF'})
            continue
        collected = timestamp(event['collectedAt']) if event.get('collectedAt') else None
        if collected is not None and collected > cutoff:
            excluded.append({'kind': 'event', 'id': event_id, 'reason': 'DETAILS_COLLECTED_AFTER_VIEW'})
            continue
        if collected is not None and collected < observed:
            raise ValueError('event detail collection precedes first observation')
        ready = timestamp(event['detailsAvailableAt']) if event.get('detailsAvailableAt') else None
        if ready is not None and ready > cutoff:
            excluded.append({'kind': 'event', 'id': event_id, 'reason': 'DETAILS_PARSED_AFTER_VIEW'})
            continue
        if ready is not None and ready < (collected or observed):
            raise ValueError('parsed detail readiness precedes collection')
        links, unavailable = [], []
        for association in event.get('associations', []):
            key = identity(association['chainId'], association['stockTokenAddress'])
            known_at = timestamp(association['mappingKnownAt'])
            if known_at > cutoff:
                unavailable.append({'asset': list(key), 'reason': 'MAPPING_NOT_YET_KNOWN'})
                continue
            matches = by_asset.get(key, [])
            if not matches:
                unavailable.append({'asset': list(key), 'reason': 'VALUATION_NOT_SUPPLIED'})
            for report_id, report_time in matches:
                links.append({'valuation_sha256': report_id,
                              'chain_id': key[0], 'token': key[1],
                              'pool_ids': association.get('poolIds', []),
                              'mapping_timing': 'KNOWN_AT_OBSERVATION' if known_at <= observed else 'RETROSPECTIVE',
                              'valuation_timing': 'AT_OR_AFTER_DISCLOSURE_OBSERVATION' if report_time >= observed else 'PRE_DISCLOSURE_OBSERVATION'})
        joined.append({'event': event, 'event_sha256': event_digest,
                       'links': links, 'unavailable': unavailable,
                       'detail_time_state': 'PARSED_BY_VIEW' if ready is not None else 'DETAIL_READINESS_TIME_UNAVAILABLE',
                       'association_state': 'SUPPLIED' if event.get('associations') else 'NO_VERIFIED_ASSOCIATION_SUPPLIED'})
    return {'schema': 'MSKResearchBundle@1', 'as_of': as_of,
            'events': joined, 'valuations': retained, 'excluded': excluded,
            'source_coverage': events.get('coverage'),
            'source_events_sha256': digest(events),
            'claims': {'production_application_wired': False,
                       'causal_event_attribution': False,
                       'profitable_execution_established': False,
                       'source_authenticity_verified': False},
            'limitations': ['Valuation reports and their missing/stale states are retained unchanged.',
                            'Exact-address association is supplied evidence, not independent issuer verification.',
                            'Retrospective mappings must not become point-in-time strategy signals.',
                            'Missing detail-collection times do not establish when parsed filing facts became known.',
                            'Original event payloads retain source mappings; historical displays must use qualified links and unavailable states.',
                            'Content hashes identify retained inputs; they do not prove completeness or origin.']}


def read_json(path):
    raw = Path(path).read_bytes()
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError('input exceeds 16 MiB')
    def no_constant(value):
        raise ValueError('non-finite JSON number: ' + value)
    return json.loads(raw, parse_constant=no_constant)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', required=True)
    parser.add_argument('--valuation', action='append', required=True)
    parser.add_argument('--as-of', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        result = compose(read_json(args.events), [read_json(p) for p in args.valuation], args.as_of)
        with Path(args.out).open('x') as output:
            json.dump(result, output, indent=2, allow_nan=False)
            output.write('\n')
        print(json.dumps({'schema': result['schema'], 'events': len(result['events']),
                          'valuations': len(result['valuations']), 'excluded': len(result['excluded'])}))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, 'Composition failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
