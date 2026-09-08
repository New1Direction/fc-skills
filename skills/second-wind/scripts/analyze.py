#!/usr/bin/env python3
"""Deterministic analysis of declared retained observations; no network or signing."""
import argparse
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import sys

MAX_BYTES = 2_000_000
KINDS = {'observed', 'synthetic', 'unknown'}
COVERAGE = {'complete', 'partial', 'unknown'}
IDENTITY = {'chain', 'token', 'token_unit', 'quote_unit', 'pool_scope'}
DEFAULTS = {'max_dormant_trades_per_day': '10', 'max_dormant_active_fraction': '0.1',
            'min_current_trades_per_day': '20', 'min_resurgence_multiple': '3',
            'min_new_buyers': 3, 'min_new_groups': 3, 'max_group_capital_share': '0.5',
            'min_new_capital_share': '0.25'}
METRICS = {'trades', 'quote_volume'}
LIQUIDITY = {'quote_reserve_start', 'quote_reserve_end', 'depth_quote_start',
             'depth_quote_end', 'token_units_start', 'token_units_end', 'slippage_bps'}
WINDOW_KEYS = {'id', 'role', 'start', 'end', 'available_at', 'identity', 'evidence_refs',
               'activity_coverage', 'buyer_coverage', 'history_coverage',
               'relationship_coverage', 'comparability_events', 'metrics', 'buyers',
               'incumbents', 'liquidity'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def obj(value, allowed, required=()):
    require(type(value) is dict, 'expected object')
    require(not set(value) - allowed, 'unknown keys: ' + ', '.join(sorted(set(value) - allowed)))
    require(not set(required) - set(value), 'missing required keys: ' + ', '.join(sorted(set(required) - set(value))))


def text_value(value):
    require(type(value) is str and bool(value.strip()) and len(value) <= 2048, 'invalid string')


def stamp(value):
    require(type(value) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value),
            'timestamps require UTC seconds YYYY-MM-DDTHH:MM:SSZ')
    return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ')


def elapsed(w):
    delta = stamp(w['end']) - stamp(w['start'])
    return delta.days * 86400 + delta.seconds


def decimal(value):
    require(type(value) is str and re.fullmatch(r'(?:0|[1-9]\d{0,39})(?:\.\d{1,18})?', value),
            'amounts must be nonnegative bounded decimal strings')
    return Fraction(Decimal(value))


def count(value):
    require(type(value) is int and 0 <= value <= 10**12, 'invalid integer count')
    return value


def identity(value):
    obj(value, IDENTITY, IDENTITY)
    for field in value.values():
        text_value(field)


def refs(value, evidence):
    require(type(value) is list and 0 < len(value) <= 1000, 'evidence_refs must be nonempty')
    require(all(type(ref) is str and ref in evidence for ref in value), 'unknown evidence reference')
    require(len(set(value)) == len(value), 'duplicate evidence reference')


def bounded(value, depth=0, counter=None):
    counter = [0] if counter is None else counter
    counter[0] += 1
    require(depth <= 16 and counter[0] <= 100000, 'JSON structure limit exceeded')
    if isinstance(value, dict):
        require(len(value) <= 1000, 'object too large')
        for key, item in value.items():
            text_value(key)
            bounded(item, depth + 1, counter)
    elif isinstance(value, list):
        require(len(value) <= 10000, 'array too large')
        for item in value:
            bounded(item, depth + 1, counter)
    elif isinstance(value, str):
        require(len(value) <= 2048, 'string too long')
    else:
        require(value is None or type(value) in (bool, int), 'invalid JSON scalar')


def reject_number(_):
    raise ValueError('JSON decimals must be strings; nonfinite numbers forbidden')


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key: ' + key)
        result[key] = value
    return result


def load(path):
    with Path(path).open('rb') as handle:
        raw = handle.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, 'input exceeds 2 MB')
    document = json.loads(raw, object_pairs_hook=unique_pairs,
                          parse_float=reject_number, parse_constant=reject_number)
    bounded(document)
    return document, hashlib.sha256(raw).hexdigest()


def validate(doc):
    bounded(doc)
    obj(doc, {'schema_version', 'source_kind', 'cutoff', 'identity', 'evidence', 'windows', 'thresholds'},
        {'schema_version', 'source_kind', 'cutoff', 'identity', 'evidence', 'windows'})
    require(type(doc['schema_version']) is int and doc['schema_version'] == 1, 'schema_version must be 1')
    require(doc['source_kind'] in KINDS, 'invalid source_kind')
    cutoff = stamp(doc['cutoff'])
    identity(doc['identity'])
    require(type(doc['evidence']) is list and len(doc['evidence']) <= 1000, 'invalid evidence list')
    evidence = {}
    for row in doc['evidence']:
        obj(row, {'id', 'source_kind', 'available_at', 'reference', 'sha256'},
            {'id', 'source_kind', 'available_at', 'reference'})
        text_value(row['id']); text_value(row['reference'])
        require(row['id'] not in evidence and row['source_kind'] in KINDS, 'invalid evidence identity/kind')
        if row['available_at'] is not None:
            stamp(row['available_at'])
        if 'sha256' in row:
            require(type(row['sha256']) is str and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'invalid evidence hash')
        evidence[row['id']] = row
    kinds = {row['source_kind'] for row in evidence.values()}
    derived = 'synthetic' if 'synthetic' in kinds else ('unknown' if 'unknown' in kinds or not kinds else 'observed')
    require(doc['source_kind'] == derived, 'source_kind must match conservative aggregate of evidence kinds')
    thresholds = dict(DEFAULTS)
    obj(doc.get('thresholds', {}), set(DEFAULTS))
    thresholds.update(doc.get('thresholds', {}))
    for key, value in thresholds.items():
        if key in {'min_new_buyers', 'min_new_groups'}:
            require(count(value) > 0, 'buyer/group minimum must be positive')
        else:
            require(decimal(value) > 0, 'thresholds must be positive')
    require(decimal(thresholds['max_dormant_active_fraction']) < 1, 'dormant fraction must be below one')
    require(decimal(thresholds['max_group_capital_share']) <= 1, 'share must be at most one')
    require(decimal(thresholds['min_new_capital_share']) <= 1, 'share must be at most one')
    require(decimal(thresholds['min_resurgence_multiple']) > 1, 'resurgence multiple must exceed one')
    require(type(doc['windows']) is list and 1 <= len(doc['windows']) <= 256, 'invalid windows list')
    ids = set()
    buyer_history = defaultdict(list)
    for w in doc['windows']:
        obj(w, WINDOW_KEYS, WINDOW_KEYS - {'buyers', 'incumbents', 'liquidity'})
        text_value(w['id']); require(w['id'] not in ids, 'duplicate window id'); ids.add(w['id'])
        require(w['role'] in {'active_history', 'dormancy', 'current'}, 'invalid window role')
        start, end = stamp(w['start']), stamp(w['end'])
        require(start < end, 'empty/reversed window')
        if w['available_at'] is not None:
            require(stamp(w['available_at']) >= end, 'window available before its end')
        identity(w['identity']); refs(w['evidence_refs'], evidence)
        for field in ('activity_coverage', 'buyer_coverage', 'history_coverage', 'relationship_coverage'):
            require(w[field] in COVERAGE, 'invalid coverage')
        events = w['comparability_events']
        require(type(events) is list and all(e in {'rebase', 'migration', 'new_pool', 'quote_asset_change', 'unit_change', 'unknown'} for e in events), 'invalid comparability events')
        obj(w['metrics'], METRICS)
        for key, value in w['metrics'].items():
            if value is not None:
                count(value) if key == 'trades' else decimal(value)
        buyers = w.get('buyers', [])
        require(type(buyers) is list and len(buyers) <= 5000, 'invalid buyers')
        wallets = set()
        for buyer in buyers:
            obj(buyer, {'wallet', 'buy_quote', 'first_buy_at', 'dependency_group'},
                {'wallet', 'buy_quote', 'first_buy_at', 'dependency_group'})
            text_value(buyer['wallet']); require(buyer['wallet'] not in wallets, 'duplicate buyer wallet')
            wallets.add(buyer['wallet']); require(decimal(buyer['buy_quote']) > 0, 'buyer capital must be positive')
            if buyer['first_buy_at'] is not None:
                require(stamp(buyer['first_buy_at']) < end, 'first purchase must precede window end')
            if buyer['dependency_group'] is not None:
                text_value(buyer['dependency_group'])
            key = (w['identity']['chain'], w['identity']['token'], buyer['wallet'])
            buyer_history[key].append((end, buyer['first_buy_at']))
        if w['buyer_coverage'] == 'complete':
            require('buyers' in w, 'complete buyer coverage requires buyers')
        if w['metrics'].get('trades') is not None:
            require(len(buyers) <= w['metrics']['trades'], 'more buyers than trades')
        if w['metrics'].get('quote_volume') is not None:
            require(sum((decimal(b['buy_quote']) for b in buyers), Fraction()) <= decimal(w['metrics']['quote_volume']), 'buyer capital exceeds total volume')
        if w.get('incumbents') is not None:
            inc = w['incumbents']
            obj(inc, {'snapshot_at', 'buy_quote', 'sell_quote'}, {'snapshot_at', 'buy_quote', 'sell_quote'})
            stamp(inc['snapshot_at']); decimal(inc['buy_quote']); decimal(inc['sell_quote'])
            if w['metrics'].get('quote_volume') is not None:
                require(decimal(inc['buy_quote']) + decimal(inc['sell_quote']) <= decimal(w['metrics']['quote_volume']), 'incumbent flows exceed total volume')
        if w.get('liquidity') is not None:
            obj(w['liquidity'], LIQUIDITY)
            for key, value in w['liquidity'].items():
                if value is not None:
                    if key == 'slippage_bps':
                        require(0 < count(value) <= 10000, 'invalid slippage')
                    else:
                        decimal(value)
    for records in buyer_history.values():
        known_first_buys = {first for _, first in records if first is not None}
        require(len(known_first_buys) <= 1, 'conflicting first purchase dates across windows')
        if known_first_buys:
            first = stamp(next(iter(known_first_buys)))
            require(first < min(end for end, _ in records),
                    'first purchase date contradicts an earlier recorded buying window')
    require(sum(w['role'] == 'current' for w in doc['windows']) == 1, 'exactly one current window required')
    return cutoff, evidence, thresholds


def number(value):
    value = Fraction(value)
    with localcontext() as context:
        context.prec = 80
        display = format(Decimal(value.numerator) / Decimal(value.denominator), '.12f').rstrip('0').rstrip('.')
    return {'exact': str(value), 'decimal': display or '0'}


def ratio(current, baseline):
    if baseline == 0:
        return {'state': 'positive_from_zero' if current > 0 else 'both_zero', 'multiple': None}
    return {'state': 'finite', 'multiple': number(current / baseline)}


def rate(w, metric):
    seconds = elapsed(w)
    value = w['metrics'][metric]
    return Fraction(value if metric == 'trades' else decimal(value)) * 86400 / seconds


def cohort_report(w, thresholds):
    counts, capital, groups = defaultdict(int), defaultdict(Fraction), defaultdict(Fraction)
    start = stamp(w['start'])
    for buyer in w.get('buyers', []):
        first = buyer['first_buy_at']
        cohort = 'unknown'
        if first is not None and w['history_coverage'] == 'complete':
            cohort = 'new' if stamp(first) >= start else 'returning'
        amount = decimal(buyer['buy_quote'])
        counts[cohort] += 1; capital[cohort] += amount
        if cohort == 'new':
            # Prefix namespaces prevent group IDs colliding with wallet IDs.
            key = ('group', buyer['dependency_group']) if buyer['dependency_group'] else ('wallet', buyer['wallet'])
            groups[key] += amount
    relationship_known = w['relationship_coverage'] == 'complete'
    share = max(groups.values()) / capital['new'] if groups else None
    total_capital = sum(capital.values(), Fraction())
    new_share = capital['new'] / total_capital if total_capital else None
    complete = w['buyer_coverage'] == 'complete' and w['history_coverage'] == 'complete' and relationship_known and counts['unknown'] == 0
    supported = complete and counts['new'] >= thresholds['min_new_buyers'] and len(groups) >= thresholds['min_new_groups'] and share is not None and share <= decimal(thresholds['max_group_capital_share']) and new_share is not None and new_share >= decimal(thresholds['min_new_capital_share'])
    return {'coverage': {k: w[k] for k in ('buyer_coverage', 'history_coverage', 'relationship_coverage')},
            'counts': {k: counts[k] for k in ('new', 'returning', 'unknown')},
            'buy_quote': {k: number(capital[k]) for k in ('new', 'returning', 'unknown')},
            'new_capital_share_of_observed_buys': number(new_share) if new_share is not None else None,
            'group_scenario_count': len(groups) if relationship_known else None,
            'largest_new_group_capital_share': number(share) if relationship_known and share is not None else None,
            'new_participation_supported': supported,
            'caveat': 'Grouping is supplied suspected dependency, not proof of independent people; gross buys may recycle capital.'}


def liquidity_report(w):
    liq = w.get('liquidity') or {}
    pairs = {'quote_reserve': ('quote_reserve_start', 'quote_reserve_end'),
             'fixed_slippage_quote_depth': ('depth_quote_start', 'depth_quote_end'),
             'token_units': ('token_units_start', 'token_units_end')}
    out = {'slippage_bps': liq.get('slippage_bps'), 'improving': None}
    deltas = {}
    for label, (left, right) in pairs.items():
        known = liq.get(left) is not None and liq.get(right) is not None
        deltas[label] = decimal(liq[right]) - decimal(liq[left]) if known else None
        out[label + '_change'] = number(deltas[label]) if known else None
    if deltas['quote_reserve'] is not None and deltas['fixed_slippage_quote_depth'] is not None and liq.get('slippage_bps') is not None:
        out['improving'] = deltas['quote_reserve'] > 0 and deltas['fixed_slippage_quote_depth'] > 0
    return out


def analyze(doc, input_hash=None):
    cutoff, evidence, thresholds = validate(doc)
    if input_hash is None:
        input_hash = hashlib.sha256(json.dumps(doc, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    out = {'schema_version': 1, 'source_kind': doc['source_kind'], 'cutoff': doc['cutoff'],
           'input_sha256': input_hash, 'input_hash_scope': 'supplied bytes via CLI; canonical JSON for Python API',
           'identity': doc['identity'], 'thresholds': thresholds, 'threshold_status': 'uncalibrated_engineering_defaults_or_user_overrides',
           'evidence': doc['evidence'], 'classification': 'evidence_insufficient', 'exclusions': [],
           'coverage': [], 'documented_dormancy': None, 'activity_resurgence': None,
           'cohorts': None, 'incumbent_distribution': None, 'liquidity': None,
           'limitations': ['Supplied normalized observations and provenance declarations are not independently authenticated.',
                           'Window selection, wash trading, relationship completeness, and raw source completeness require upstream review.',
                           'No predictive probability, profit guarantee, execution simulation, or trade recommendation.']}
    eligible = []
    for w in sorted(doc['windows'], key=lambda row: (row['start'], row['id'])):
        reasons = []
        if stamp(w['end']) > cutoff:
            reasons.append('window_ends_after_cutoff')
        if w['available_at'] is None or stamp(w['available_at']) > cutoff:
            reasons.append('window_unavailable_at_cutoff')
        if any(evidence[r]['available_at'] is None or stamp(evidence[r]['available_at']) > cutoff for r in w['evidence_refs']):
            reasons.append('evidence_unavailable_at_cutoff')
        if w['identity'] != doc['identity']:
            reasons.append('identity_mismatch')
        if w['comparability_events']:
            reasons.append('comparability_event:' + ','.join(w['comparability_events']))
        if w['activity_coverage'] != 'complete':
            reasons.append('incomplete_activity_coverage')
        if any(w['metrics'].get(metric) is None for metric in METRICS):
            reasons.append('missing_activity_metrics')
        out['coverage'].append({'window': w['id'], 'role': w['role'], 'start': w['start'], 'end': w['end'],
                                'activity': w['activity_coverage'], 'evidence_refs': w['evidence_refs'], 'included': not reasons})
        if reasons:
            out['exclusions'].append({'window': w['id'], 'reasons': reasons})
        else:
            eligible.append(w)
    current = next((w for w in eligible if w['role'] == 'current'), None)
    if current:
        out['cohorts'] = cohort_report(current, thresholds)
        out['liquidity'] = liquidity_report(current)
        inc = current.get('incumbents')
        if inc and stamp(inc['snapshot_at']) <= stamp(current['start']):
            net = decimal(inc['sell_quote']) - decimal(inc['buy_quote'])
            out['incumbent_distribution'] = dict(inc, net_sell_quote=number(net), pressure=net > 0)
        elif inc:
            out['exclusions'].append({'window': current['id'], 'reasons': ['incumbent_snapshot_after_current_start']})
    active = [w for w in eligible if w['role'] == 'active_history']
    dormant = [w for w in eligible if w['role'] == 'dormancy']
    ordered = active + dormant + ([current] if current else [])
    sequence_ok = bool(active) and len(dormant) >= 2 and current is not None and len(eligible) == len(doc['windows'])
    sequence_ok = sequence_ok and ordered == eligible
    durations = {elapsed(w) for w in eligible}
    sequence_ok = sequence_ok and len(durations) == 1
    sequence_ok = sequence_ok and all(a['end'] == b['start'] for a, b in zip(ordered, ordered[1:]))
    if not sequence_ok:
        out['exclusions'].append({'window': None, 'reasons': ['requires_complete_equal_duration_contiguous_active_then_dormant_then_current_sequence']})
        return out
    out['window_duration_seconds'] = durations.pop()
    means = {role: {metric: sum((rate(w, metric) for w in windows), Fraction()) / len(windows)
                    for metric in METRICS} for role, windows in [('active', active), ('dormant', dormant)]}
    if any(means['active'][metric] <= 0 for metric in METRICS):
        out['exclusions'].append({'window': None, 'reasons': ['active_history_must_show_positive_activity']})
        return out
    out['rates_per_day'] = {role: {metric: number(value) for metric, value in rates.items()} for role, rates in means.items()}
    out['rates_per_day']['current'] = {metric: number(rate(current, metric)) for metric in METRICS}
    quiet = all(rate(w, 'trades') <= decimal(thresholds['max_dormant_trades_per_day']) and
                all(rate(w, metric) <= means['active'][metric] * decimal(thresholds['max_dormant_active_fraction']) for metric in METRICS) for w in dormant)
    out['documented_dormancy'] = quiet
    if not quiet:
        out['classification'] = 'dormancy_not_demonstrated'
        return out
    out['resurgence_comparison'] = {metric: ratio(rate(current, metric), means['dormant'][metric]) for metric in METRICS}
    resurgence = rate(current, 'trades') >= decimal(thresholds['min_current_trades_per_day']) and rate(current, 'quote_volume') > 0 and all(rate(current, metric) >= means['dormant'][metric] * decimal(thresholds['min_resurgence_multiple']) for metric in METRICS)
    out['activity_resurgence'] = resurgence
    out['classification'] = 'documented_dormancy_no_resurgence'
    if resurgence:
        out['classification'] = 'activity_resurgence_unconfirmed'
        if out['cohorts']['new_participation_supported']:
            out['classification'] = 'resurgence_with_new_participation'
            if out['incumbent_distribution'] and out['incumbent_distribution']['pressure']:
                out['classification'] = 'resurgence_with_distribution_pressure'
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True, help='Fresh output path; never overwrites')
    args = parser.parse_args()
    try:
        doc, digest = load(args.input)
        result = analyze(doc, digest)
        payload = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + '\n'
        with Path(args.output).open('x', encoding='utf-8') as handle:
            handle.write(payload)
    except (ValueError, OSError, RecursionError, UnicodeError, TypeError) as error:
        print('second-wind: ' + str(error), file=sys.stderr)
        return 2
    print(result['classification'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
