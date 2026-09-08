"""Behavioral checks for exact flow accounting and evidence-bound report structure."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from case_tools import CaseError, check_report, ledger, read_json

ROOT = Path(__file__).resolve().parent.parent


def report():
    return {'schema_version': 'autopsy.report.v1', 'case_id': 'synthetic-test',
            'target': {'chain_family': 'evm', 'chain_id': '31337 synthetic', 'address': '0x' + '1' * 40},
            'scope': {'launch_definition': 'first observed mint', 'start': 'block 100', 'end': 'block 110', 'as_of_utc': '2026-09-08T00:00:00Z', 'finality': 'synthetic'},
            'coverage': [{'area': 'transfer window', 'status': 'partial', 'limitations': ['Fixture only'], 'evidence_ids': ['e1']}],
            'evidence': [{'id': 'e1', 'source': 'synthetic fixture', 'locator': 'record one', 'captured_at_utc': '2026-09-08T00:00:00Z', 'anchor': 'synthetic block 100'}],
            'claims': [{'id': 'c1', 'kind': 'fact', 'statement': 'A transfer was observed.', 'evidence_ids': ['e1']}]}


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.packet = json.loads((ROOT / 'assets/training-case.json').read_text())

    def test_exact_supply_flow_and_internal_transfers(self):
        result = ledger(self.packet, 'a' * 64)
        addresses = {r['address']: r for r in result['addresses']}
        labels = self.packet['fixture_labels']
        self.assertEqual(result['mint_event_units_raw'], '1000000')
        self.assertEqual(result['burn_event_units_raw'], '10000')
        self.assertEqual(addresses[labels['recipient_A']]['net_transfer_delta_raw'], '60000')
        self.assertEqual(addresses[labels['recipient_B']]['net_transfer_delta_raw'], '100000')
        self.assertEqual(addresses[labels['router']]['net_transfer_delta_raw'], '0')
        self.assertEqual(sum(int(r['net_transfer_delta_raw']) for r in result['addresses']), 990000)
        self.assertNotIn('holdings', result)

    def test_large_integer_precision(self):
        amount = 2 ** 200 + 12345
        row = self.packet['transfers'][0]
        row['value_raw'] = str(amount)
        record = next(r for r in self.packet['records'] if r['id'] == row['evidence_id'])
        record['result'][0]['data'] = '0x' + format(amount, '064x')
        result = ledger(self.packet, 'b' * 64)
        self.assertEqual(result['mint_event_units_raw'], str(amount))

    def test_partial_coverage_is_carried_forward(self):
        self.packet['coverage']['status'] = 'partial'
        self.packet['coverage']['missing_ranges'] = [[109, 110]]
        self.assertEqual(ledger(self.packet, 'b' * 64)['coverage']['status'], 'partial')

    def test_normalized_omission_is_rejected(self):
        self.packet['transfers'].pop()
        with self.assertRaises(CaseError): ledger(self.packet, 'a' * 64)

    def test_mutated_quantity_is_rejected(self):
        self.packet['transfers'][0]['value_raw'] = '1'
        with self.assertRaises(CaseError): ledger(self.packet, 'a' * 64)

    def test_duplicate_is_rejected(self):
        self.packet['transfers'].append(copy.deepcopy(self.packet['transfers'][0]))
        with self.assertRaises(CaseError): ledger(self.packet, 'a' * 64)

    def test_invalidated_or_unverified_is_rejected(self):
        self.packet['coverage']['status'] = 'invalidated'
        with self.assertRaises(CaseError): ledger(self.packet, 'a' * 64)
        self.packet['coverage']['status'] = 'partial'
        self.packet['coverage']['anchor_status'] = 'unverified'
        with self.assertRaises(CaseError): ledger(self.packet, 'a' * 64)


class ReportTests(unittest.TestCase):
    def test_valid_report_and_unknown_coverage(self):
        self.assertEqual(check_report(report())['status'], 'structurally_valid')

    def test_dangling_citation_and_empty_complete_coverage(self):
        r = report(); r['claims'][0]['evidence_ids'] = ['missing']
        with self.assertRaises(CaseError): check_report(r)
        r = report(); r['coverage'][0].update(status='complete', evidence_ids=[])
        with self.assertRaises(CaseError): check_report(r)

    def test_derivation_needs_denominator(self):
        r = report(); r['claims'][0].update(kind='derived', method='1/2')
        with self.assertRaises(CaseError): check_report(r)
        r['claims'][0]['denominator'] = '2 units of supply at block 100'
        self.assertEqual(check_report(r)['claims'], 1)

    def test_hypothesis_needs_alternative_falsifier_and_rationale(self):
        r = report(); r['claims'][0].update(kind='hypothesis', confidence='high')
        with self.assertRaises(CaseError): check_report(r)
        r['claims'][0].update(alternatives=['Shared service'], falsifier='Service-level records establish independent users', confidence_reason='Two independent observations support the link')
        self.assertEqual(check_report(r)['claims'], 1)

    def test_local_hash_pointer_and_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source.json'; raw = b'{"events":[{"amount":"9007199254740993"}]}'
            source.write_bytes(raw)
            r = report(); r['evidence'][0].update(file='source.json', sha256=hashlib.sha256(raw).hexdigest(), pointer='/events/0/amount')
            self.assertEqual(check_report(r, tmp)['local_evidence_verified'], 1)
            source.write_bytes(b'{}')
            with self.assertRaises(CaseError): check_report(r, tmp)

    def test_path_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = report(); r['evidence'][0].update(file='../outside.json', sha256='0' * 64)
            with self.assertRaises(CaseError): check_report(r, tmp)

    def test_nonfinite_input_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.json'; path.write_text('{"value": NaN}')
            with self.assertRaises(ValueError): read_json(path)

    def test_non_utc_timestamp_rejected(self):
        r = report(); r['scope']['as_of_utc'] = '2026-09-08T00:00:00'
        with self.assertRaises(CaseError): check_report(r)


if __name__ == '__main__':
    unittest.main()
