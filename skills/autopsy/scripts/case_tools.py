#!/usr/bin/env python3
"""Deterministic evidence hashing, ERC-20 flow ledgers, and report-contract checks.

These checks establish structural consistency, not provider truth or ownership.
"""
import argparse
from collections import defaultdict
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys

from collect_evm import decode_log, fixed_hex, quantity, TRANSFER, reject_constant, finite_float, write_packet


class CaseError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise CaseError(message)


def read_json(path):
    raw = Path(path).read_bytes()
    return json.loads(raw, parse_constant=reject_constant, parse_float=finite_float), hashlib.sha256(raw).hexdigest()


def text(value):
    return isinstance(value, str) and bool(value.strip())


def timestamp(value):
    if not text(value):
        return False
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.utcoffset() == dt.timedelta(0)
    except ValueError:
        return False


def ledger(packet, source_hash):
    require(packet.get('schema_version') == 'autopsy.evm-evidence.v1', 'Expected native EVM evidence packet')
    coverage = packet['coverage']
    require(coverage['status'] in {'complete', 'partial'}, 'Cannot derive canonical ledger from unavailable or invalidated evidence')
    require(coverage['anchor_status'] == 'verified', 'Boundary anchors must be verified before ledger derivation')
    token = packet['token'].lower()
    require(fixed_hex(token, 20), 'Invalid token address')
    require(type(packet['chain_id']) is int and packet['chain_id'] >= 0, 'Invalid chain ID')
    lo, hi = packet['requested_range']['from_block'], packet['requested_range']['to_block']
    require(type(lo) is int and type(hi) is int and 0 <= lo <= hi, 'Invalid block interval')
    records = {}
    valid_raw, raw_by_record = {}, {}
    for record in packet['records']:
        require(text(record.get('id')) and record['id'] not in records, 'Duplicate or missing evidence ID')
        records[record['id']] = record
        if record.get('method') != 'eth_getLogs' or 'result' not in record:
            continue
        params = record['params'][0]
        require(params['address'].lower() == token and params['topics'] == [TRANSFER], 'Log query does not match target')
        rlo, rhi = quantity(params['fromBlock']), quantity(params['toBlock'])
        require(lo <= rlo <= rhi <= hi, 'Log query lies outside requested interval')
        if not isinstance(record['result'], list):
            continue
        raw_by_record[record['id']] = {}
        for raw in record['result']:
            try:
                row = decode_log(raw, token, rlo, rhi, record['id'])
            except (ValueError, TypeError):
                continue
            key = (row['block_hash'], row['transaction_hash'], row['log_index'])
            comparable = {k: v for k, v in row.items() if k != 'evidence_id'}
            require(key not in valid_raw or valid_raw[key] == comparable, 'Conflicting raw logs')
            valid_raw[key] = comparable
            raw_by_record[record['id']][key] = row
    seen, positions = {}, {}
    balances = defaultdict(lambda: {'received_raw': 0, 'sent_raw': 0, 'evidence_ids': set()})
    zero = '0x' + '0' * 40
    minted, burned = 0, 0
    for row in packet['transfers']:
        key = (row['block_hash'], row['transaction_hash'], row['log_index'])
        comparable = {k: v for k, v in row.items() if k != 'evidence_id'}
        require(key in valid_raw and valid_raw[key] == comparable, 'Normalized transfer differs from raw evidence')
        source = records.get(row['evidence_id'])
        require(source is not None and source.get('method') == 'eth_getLogs', 'Missing transfer evidence')
        require(raw_by_record.get(row['evidence_id'], {}).get(key) == row, 'Transfer citation does not match its evidence record')
        position = (row['block_number'], row['log_index'])
        require(position not in positions or positions[position] == comparable, 'Conflicting event position')
        positions[position] = comparable
        require(key not in seen, 'Duplicate normalized transfer')
        seen[key] = comparable
        amount = int(row['value_raw'])
        sender, recipient = row['from'], row['to']
        if sender == zero:
            minted += amount
        else:
            balances[sender]['sent_raw'] += amount
            balances[sender]['evidence_ids'].add(row['evidence_id'])
        if recipient == zero:
            burned += amount
        else:
            balances[recipient]['received_raw'] += amount
            balances[recipient]['evidence_ids'].add(row['evidence_id'])
    require(seen == valid_raw, 'Normalized transfers omit valid raw observations')
    rows = []
    for address, values in sorted(balances.items()):
        rows.append({'address': address, 'received_raw': str(values['received_raw']),
                     'sent_raw': str(values['sent_raw']),
                     'net_transfer_delta_raw': str(values['received_raw'] - values['sent_raw']),
                     'evidence_ids': sorted(values['evidence_ids'])})
    require(sum(int(r['net_transfer_delta_raw']) for r in rows) == minted - burned, 'Flow conservation failed')
    return {'schema_version': 'autopsy.transfer-ledger.v1', 'source_sha256': source_hash,
            'chain_id': packet['chain_id'], 'token': token, 'requested_range': packet['requested_range'],
            'coverage': coverage, 'transfer_count': len(seen), 'mint_event_units_raw': str(minted),
            'burn_event_units_raw': str(burned), 'addresses': rows,
            'limitations': ['Observed event flows only. Opening balances are unknown; deltas are not holdings, cost basis, sales, or profit.',
                            'Zero-address event conventions require implementation and supply reconciliation.',
                            'Coverage and provider limitations are inherited from the evidence packet.']}


def json_pointer(document, pointer):
    require(isinstance(pointer, str) and (pointer == '' or pointer.startswith('/')), 'Invalid JSON pointer')
    current = document
    for part in pointer.split('/')[1:] if pointer else []:
        part = part.replace('~1', '/').replace('~0', '~')
        if isinstance(current, list):
            require(re.fullmatch(r'0|[1-9][0-9]*', part) is not None, 'Invalid array index in pointer')
            current = current[int(part)]
        elif isinstance(current, dict):
            current = current[part]
        else:
            raise CaseError('Pointer traverses a scalar')
    return current


def check_report(report, evidence_root=None):
    require(report.get('schema_version') == 'autopsy.report.v1', 'Expected autopsy.report.v1')
    require(text(report.get('case_id')), 'Missing case ID')
    target = report['target']
    require(target['chain_family'] in {'evm', 'solana'}, 'Unsupported chain family')
    require(text(target['chain_id']), 'Report chain_id must be a descriptive string')
    require(text(target['address']), 'Missing token/mint address')
    if target['chain_family'] == 'evm':
        require(fixed_hex(target['address'], 20), 'Invalid EVM token address')
    scope = report['scope']
    for key in ('launch_definition', 'start', 'end', 'finality'):
        require(text(scope.get(key)), 'Missing scope.' + key)
    require(timestamp(scope.get('as_of_utc')), 'as_of_utc must be a UTC timestamp')
    evidence = report['evidence']
    require(isinstance(evidence, list) and evidence, 'Need an evidence index')
    ids, local_verified = set(), 0
    for item in evidence:
        require(text(item.get('id')) and item['id'] not in ids, 'Evidence IDs must be unique')
        ids.add(item['id'])
        for key in ('source', 'locator', 'anchor'):
            require(text(item.get(key)), 'Missing evidence.' + key)
        require(timestamp(item.get('captured_at_utc')), 'Evidence capture must use UTC')
        if 'file' in item:
            require(text(item['file']) and re.fullmatch(r'[0-9a-f]{64}', item.get('sha256', '')) is not None, 'Local evidence needs file and SHA-256')
            if evidence_root is not None:
                root = Path(evidence_root).resolve()
                path = (root / item['file']).resolve()
                require(path.is_relative_to(root), 'Evidence path escapes evidence root')
                raw = path.read_bytes()
                require(hashlib.sha256(raw).hexdigest() == item['sha256'], 'Evidence file hash mismatch')
                if 'pointer' in item:
                    json_pointer(json.loads(raw, parse_constant=reject_constant, parse_float=finite_float), item['pointer'])
                local_verified += 1
        elif evidence_root is not None:
            require('sha256' not in item and 'pointer' not in item, 'Hash/pointer requires a local file')
    def references(items, needed=True):
        require(isinstance(items, list) and (bool(items) or not needed), 'Evidence references must be a list')
        require(all(isinstance(i, str) and i in ids for i in items), 'Dangling evidence reference')
    coverage = report['coverage']
    require(isinstance(coverage, list) and coverage, 'Coverage must be explicit')
    areas = set()
    for area in coverage:
        require(text(area.get('area')) and area['area'] not in areas, 'Coverage areas must be unique')
        areas.add(area['area'])
        require(area['status'] in {'complete', 'partial', 'unavailable', 'not_applicable'}, 'Invalid coverage status')
        require(isinstance(area['limitations'], list) and all(text(x) for x in area['limitations']), 'Invalid limitations')
        if area['status'] != 'complete':
            require(area['limitations'], 'Incomplete/inapplicable coverage needs explanation')
        references(area['evidence_ids'], needed=area['status'] == 'complete')
    claims = report['claims']
    require(isinstance(claims, list) and claims, 'Need at least one supported claim')
    claim_ids = set()
    for claim in claims:
        require(text(claim.get('id')) and claim['id'] not in claim_ids, 'Claim IDs must be unique')
        claim_ids.add(claim['id'])
        require(claim['kind'] in {'fact', 'derived', 'hypothesis'} and text(claim['statement']), 'Invalid claim')
        references(claim['evidence_ids'])
        if claim['kind'] == 'derived':
            require(text(claim.get('method')) and text(claim.get('denominator')), 'Derived claims need method and denominator (or not applicable)')
        if claim['kind'] == 'hypothesis':
            require(isinstance(claim.get('alternatives'), list) and claim['alternatives'] and all(text(x) for x in claim['alternatives']), 'Hypothesis needs alternatives')
            require(text(claim.get('falsifier')), 'Hypothesis needs a falsifier')
            require(claim.get('confidence') in {'low', 'medium', 'high'} and text(claim.get('confidence_reason')), 'Hypothesis needs explained qualitative confidence')
    return {'status': 'structurally_valid', 'claims': len(claims), 'evidence_items': len(evidence),
            'local_evidence_verified': local_verified,
            'limitation': 'Checks structure, citation resolution, and requested file integrity. Does not certify factual truth, calculation correctness, source completeness, or ownership.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    h = sub.add_parser('hash'); h.add_argument('file', type=Path)
    l = sub.add_parser('ledger'); l.add_argument('file', type=Path); l.add_argument('--out', type=Path)
    c = sub.add_parser('check-report'); c.add_argument('file', type=Path); c.add_argument('--evidence-root', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'hash':
            output = {'sha256': hashlib.sha256(args.file.read_bytes()).hexdigest(), 'meaning': 'Byte integrity only; not source authenticity.'}
        else:
            document, digest = read_json(args.file)
            output = ledger(document, digest) if args.command == 'ledger' else check_report(document, args.evidence_root)
        if getattr(args, 'out', None):
            write_packet(args.out, output)
        else:
            print(json.dumps(output, indent=2, allow_nan=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
        # Do not dump untrusted evidence or filesystem contents in a traceback.
        message = str(error) if isinstance(error, CaseError) else type(error).__name__
        print(json.dumps({'status': 'failed', 'reason': message}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
