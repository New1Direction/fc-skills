import copy
import unittest
from compose_research import compose

TOKEN = '0x' + 'a' * 40
NOW = '2026-09-08T16:00:00Z'


class ComposeTests(unittest.TestCase):
    def setUp(self):
        self.event = {'id': 'sec:example', 'firstObservedAt': '2026-09-08T15:00:00Z',
                      'associations': [{'chainId': 4663, 'stockTokenAddress': TOKEN,
                                        'poolIds': ['synthetic:pool'], 'mappingKnownAt': '2026-09-08T14:00:00Z'}]}
        self.events = {'schemaVersion': 'CatalystEvents@1', 'events': [self.event], 'coverage': {'complete': False}}
        self.report = {'schema': 'NightDeskReport@1', 'as_of': NOW,
                       'asset': {'chain_id': 4663, 'token': TOKEN.upper().replace('0X', '0x')},
                       'exit': {'state': 'UNAVAILABLE'}}

    def test_exact_identity_preserves_missing_evidence(self):
        result = compose(self.events, [self.report], NOW)
        link = result['events'][0]['links'][0]
        self.assertEqual(result['valuations'][link['valuation_sha256']]['exit']['state'], 'UNAVAILABLE')
        self.assertEqual(result['source_coverage'], {'complete': False})
        self.assertFalse(any(result['claims'].values()))

    def test_unrelated_asset_does_not_match_symbol_or_pool(self):
        self.report['asset']['token'] = '0x' + 'b' * 40
        result = compose(self.events, [self.report], NOW)
        self.assertEqual(result['events'][0]['links'], [])
        self.assertEqual(result['events'][0]['unavailable'][0]['reason'], 'VALUATION_NOT_SUPPLIED')

    def test_future_mapping_is_unavailable(self):
        self.event['associations'][0]['mappingKnownAt'] = '2026-09-08T17:00:00Z'
        result = compose(self.events, [self.report], NOW)
        self.assertEqual(result['events'][0]['unavailable'][0]['reason'], 'MAPPING_NOT_YET_KNOWN')

    def test_retrospective_and_pre_event_evidence_stays_labelled(self):
        self.event['associations'][0]['mappingKnownAt'] = '2026-09-08T15:30:00Z'
        self.report['as_of'] = '2026-09-08T14:59:00Z'
        link = compose(self.events, [self.report], NOW)['events'][0]['links'][0]
        self.assertEqual(link['mapping_timing'], 'RETROSPECTIVE')
        self.assertEqual(link['valuation_timing'], 'PRE_DISCLOSURE_OBSERVATION')

    def test_future_event_and_valuation_excluded(self):
        self.event['firstObservedAt'] = self.report['as_of'] = '2026-09-08T16:01:00Z'
        result = compose(self.events, [self.report], NOW)
        self.assertEqual(len(result['excluded']), 2)
        self.assertEqual(result['events'], [])
        self.assertEqual(result['valuations'], {})

    def test_later_download_cannot_supply_earlier_filing_details(self):
        self.event['collectedAt'] = '2026-09-08T16:02:00Z'
        result = compose(self.events, [self.report], NOW)
        self.assertEqual(result['events'], [])
        self.assertEqual(result['excluded'][0]['reason'], 'DETAILS_COLLECTED_AFTER_VIEW')

    def test_later_parse_cannot_supply_earlier_filing_details(self):
        self.event['collectedAt'] = '2026-09-08T15:59:00Z'
        self.event['detailsAvailableAt'] = '2026-09-08T16:02:00Z'
        result = compose(self.events, [self.report], NOW)
        self.assertEqual(result['events'], [])
        self.assertEqual(result['excluded'][0]['reason'], 'DETAILS_PARSED_AFTER_VIEW')

    def test_duplicate_idempotence_and_conflict(self):
        self.events['events'].append(copy.deepcopy(self.event))
        self.assertEqual(len(compose(self.events, [self.report, self.report], NOW)['events']), 1)
        self.events['events'][1]['firstObservedAt'] = NOW
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            compose(self.events, [self.report], NOW)

    def test_wrong_chain_and_naive_time_rejected(self):
        self.report['asset']['chain_id'] = 1
        with self.assertRaises(ValueError):
            compose(self.events, [self.report], NOW)
        with self.assertRaises(ValueError):
            compose(self.events, [], '2026-09-08T16:00:00')


if __name__ == '__main__':
    unittest.main()
