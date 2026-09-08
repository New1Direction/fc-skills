#!/usr/bin/env python3
"""Retain immutable signal snapshots and attributed outcomes in a local SQLite journal."""
import argparse
import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

MAX_BYTES = 10 * 1024 * 1024
SOURCES = {'observed', 'synthetic', 'unknown'}
BASES = {'executed', 'simulated', 'modeled'}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp must be an ISO-8601 UTC string')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None or result.utcoffset().total_seconds() != 0:
        raise ValueError('timestamps must explicitly use UTC')
    return result


def label(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ValueError(name + ' must be a nonempty bounded string')
    return value


def amount(value):
    if not isinstance(value, str) or len(value) > 128 or not re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', value):
        raise ValueError('amounts must be bounded decimal strings')
    return Fraction(Decimal(value))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def load(path):
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('input exceeds 10 MiB')
    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise ValueError('duplicate JSON key')
            out[k] = v
        return out
    value = json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
    if not isinstance(value, dict):
        raise ValueError('input must be an object')
    return value, hashlib.sha256(data).hexdigest()


def connect(path):
    connection = sqlite3.connect(path, timeout=5)
    connection.execute('PRAGMA foreign_keys=ON')
    connection.executescript('''
        CREATE TABLE IF NOT EXISTS reports (
          sha256 TEXT PRIMARY KEY, recorded_at TEXT NOT NULL,
          cutoff TEXT NOT NULL, source_kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outcomes (
          id TEXT PRIMARY KEY, report_sha256 TEXT NOT NULL REFERENCES reports(sha256),
          candidate_id TEXT NOT NULL, horizon_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL, available_at TEXT NOT NULL,
          supersedes_id TEXT UNIQUE REFERENCES outcomes(id), payload TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_initial_outcome ON outcomes
          (report_sha256,candidate_id,horizon_at) WHERE supersedes_id IS NULL;
        CREATE TRIGGER IF NOT EXISTS reports_no_update BEFORE UPDATE ON reports
          BEGIN SELECT RAISE(ABORT, 'reports are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS reports_no_delete BEFORE DELETE ON reports
          BEGIN SELECT RAISE(ABORT, 'reports are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS outcomes_no_update BEFORE UPDATE ON outcomes
          BEGIN SELECT RAISE(ABORT, 'outcomes are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS outcomes_no_delete BEFORE DELETE ON outcomes
          BEGIN SELECT RAISE(ABORT, 'outcomes are append-only'); END;
    ''')
    return connection


def budget(connection, payload):
    size = connection.execute('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM reports').fetchone()[0]
    size += connection.execute('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM outcomes').fetchone()[0]
    if size + len(payload.encode()) > 50 * 1024 * 1024:
        raise ValueError('journal payload budget exceeded; start a new journal')


def candidates(report):
    values = report.get('candidates')
    if not isinstance(values, list) or len(values) > 10000:
        raise ValueError('report candidates must be a bounded list')
    result = {}
    for row in values:
        key = label(row.get('candidate_id'), 'candidate_id')
        if key in result:
            raise ValueError('duplicate candidate_id')
        label(row.get('quote_unit'), 'quote_unit')
        result[key] = row
    return result


def record(connection, report, digest, now=None):
    now = now or datetime.now(timezone.utc)
    if report.get('schema_version') != 'ignition.report.v1' or report.get('source_kind') not in SOURCES:
        raise ValueError('unsupported report or source kind')
    if not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('invalid report digest')
    if timestamp(report.get('cutoff')) > now:
        raise ValueError('report cutoff is in the future')
    candidates(report)
    budget(connection, canonical(report))
    with connection:
        connection.execute('INSERT INTO reports VALUES (?, ?, ?, ?, ?)',
                           (digest, now.isoformat(), report['cutoff'], report['source_kind'], canonical(report)))
    return {'report_sha256': digest, 'recorded_at': now.isoformat(), 'report_cutoff': report['cutoff'],
            'note': 'Recording time is actual ingestion time; importing a historical report does not establish a historical alert.'}


def add_outcome(connection, value, now=None):
    now = now or datetime.now(timezone.utc)
    if value.get('schema_version') != 'ignition.outcome.v1':
        raise ValueError('unsupported outcome schema')
    oid = label(value.get('id'), 'id')
    digest = label(value.get('report_sha256'), 'report_sha256')
    row = connection.execute('SELECT payload, recorded_at FROM reports WHERE sha256=?', (digest,)).fetchone()
    if row is None:
        raise ValueError('unknown report hash')
    report = json.loads(row[0])
    key = label(value.get('candidate_id'), 'candidate_id')
    candidate = candidates(report).get(key)
    if candidate is None or value.get('quote_unit') != candidate['quote_unit']:
        raise ValueError('candidate or quote unit differs from recorded report')
    horizon = timestamp(value.get('horizon_at'))
    available = timestamp(value.get('available_at'))
    if not timestamp(report['cutoff']) < horizon <= available <= now:
        raise ValueError('outcome horizon/availability must follow signal cutoff and precede recording')
    if now < timestamp(row[1]):
        raise ValueError('outcome recording predates signal ingestion')
    if value.get('source_kind') != report['source_kind']:
        raise ValueError('outcome source kind must match report')
    status = value.get('status')
    if status not in {'resolved', 'unavailable', 'censored', 'execution_failed'}:
        raise ValueError('invalid outcome status')
    if value.get('basis') not in BASES:
        raise ValueError('explicit executed/simulated/modeled basis required')
    label(value.get('method'), 'method')
    evidence = value.get('evidence')
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 100:
        raise ValueError('attributed outcome evidence required')
    ids = set()
    for item in evidence:
        eid = label(item.get('id'), 'evidence id')
        if eid in ids:
            raise ValueError('duplicate evidence id')
        ids.add(eid)
        label(item.get('source'), 'evidence source')
        if timestamp(item.get('available_at')) > available:
            raise ValueError('outcome uses evidence unavailable at its stated availability')
    if status == 'resolved':
        if value.get('cost_coverage') != 'complete':
            raise ValueError('resolved return requires complete additional-cost accounting')
        if amount(value.get('entry_all_in_quote')) <= 0:
            raise ValueError('entry all-in cost must be positive')
        amount(value.get('exit_net_quote'))
    elif value.get('entry_all_in_quote') is not None or value.get('exit_net_quote') is not None:
        raise ValueError('unresolved outcome amounts must remain null')
    previous = value.get('supersedes_id')
    existing = connection.execute('SELECT id,payload FROM outcomes WHERE report_sha256=? AND candidate_id=?', (digest,key)).fetchall()
    same_horizon = [(i,json.loads(p)) for i,p in existing if timestamp(json.loads(p)['horizon_at']) == horizon]
    if previous is not None:
        prior = next((p for i,p in same_horizon if i == previous), None)
        if prior is None or timestamp(prior['available_at']) > available:
            raise ValueError('revision must reference the same candidate/horizon and move availability forward')
        if connection.execute('SELECT 1 FROM outcomes WHERE supersedes_id=?', (previous,)).fetchone():
            raise ValueError('revision must supersede the latest outcome')
    elif same_horizon:
        raise ValueError('existing outcome requires an explicit append-only revision')
    budget(connection, canonical(value))
    with connection:
        connection.execute('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                           (oid,digest,key,horizon.isoformat(),now.isoformat(),available.isoformat(),previous,canonical(value)))
    return {'outcome_id': oid, 'recorded_at': now.isoformat(), 'supersedes_id': previous}


def summarize(connection, as_of):
    cutoff = timestamp(as_of)
    reports = {r[0]: json.loads(r[2]) for r in connection.execute('SELECT sha256,recorded_at,payload FROM reports')
               if timestamp(r[1]) <= cutoff}
    visible = []
    for row in connection.execute('SELECT recorded_at,payload FROM outcomes'):
        item = json.loads(row[1])
        if item['report_sha256'] in reports and timestamp(row[0]) <= cutoff and timestamp(item['available_at']) <= cutoff:
            visible.append(item)
    superseded = {v['supersedes_id'] for v in visible if v.get('supersedes_id')}
    latest = [v for v in visible if v['id'] not in superseded]
    groups = {}
    for value in latest:
        report = reports[value['report_sha256']]
        horizon_seconds = int((timestamp(value['horizon_at']) - timestamp(report['cutoff'])).total_seconds())
        key = (value['source_kind'],value['basis'],value['quote_unit'],horizon_seconds,value['method'])
        group = groups.setdefault(key, {'source_kind':key[0], 'basis':key[1], 'quote_unit':key[2],
             'horizon_seconds':key[3], 'method':key[4], 'resolved':0,'unavailable':0,'censored':0,'execution_failed':0,
             'positive_return_count':0,'return_fractions':[]})
        group[value['status']] += 1
        if value['status'] == 'resolved':
            ret = amount(value['exit_net_quote']) / amount(value['entry_all_in_quote']) - 1
            group['positive_return_count'] += int(ret > 0)
            group['return_fractions'].append({'outcome_id':value['id'],'numerator':str(ret.numerator),'denominator':str(ret.denominator)})
    return {'schema_version':'ignition.journal-summary.v1','as_of':as_of,
        'recorded_reports':len(reports), 'recorded_candidate_snapshots':sum(len(p['candidates']) for p in reports.values()),
        'candidate_snapshots_with_any_outcome':len({(v['report_sha256'],v['candidate_id']) for v in latest}),
        'latest_outcomes':len(latest),'groups':list(groups.values()),
        'limitations':['Groups separate source kind, outcome basis, quote unit, horizon and method.',
                      'Snapshots may overlap; outcomes are not independent portfolio trades.',
                      'Unknown, censored and failed outcomes remain in counts; positive rate alone is not profitability.',
                      'Journal protects against accidental updates, not a malicious database owner.',
                      'Supplied outcome economics and sources require independent reconciliation.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('record').add_argument('report')
    sub.add_parser('outcome').add_argument('input')
    sub.add_parser('summary').add_argument('--as-of', required=True)
    args = parser.parse_args()
    try:
        with connect(args.db) as connection:
            if args.command == 'record':
                report,digest = load(args.report)
                result = record(connection,report,digest)
            elif args.command == 'outcome':
                result = add_outcome(connection,load(args.input)[0])
            else:
                result = summarize(connection,args.as_of)
        print(json.dumps(result,indent=2,allow_nan=False))
    except (ValueError,KeyError,TypeError,OSError,sqlite3.Error,OverflowError) as error:
        print('signal-journal: ' + str(error),file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
