import copy
import hashlib
import json
import unittest

from collector import BASE, BODY_LIMIT, collect, normalize, normalize_actions

TOKEN = '0x'+'1'*40


def records():
    deployments = [{'chainId':4663,'contractAddress':TOKEN}]
    asset = {'id':'synthetic-asset-1','tokenSymbol':'DEMO','deployments':deployments,
             'currentMultiplier':'2','pendingMultiplier':'','status':'ASSET_STATUS_ACTIVE'}
    quote = {'tokenSymbol':'DEMO','deployments':deployments,'bid':'99','ask':'101','currency':'USD',
             'isTradingHalt':False,'generatedAt':'2026-09-08T15:59:50Z'}
    action = {'id':'synthetic-action-1','tokenSymbol':'DEMO','deployments':deployments,
              'type':'CORPORATE_ACTION_TYPE_FORWARD_SPLIT','status':'CORPORATE_ACTION_STATUS_COMPLETED',
              'details':{'forwardSplit':{'oldRate':'1','newRate':'2'}}}
    out = []
    for i, (url, body) in enumerate(((BASE+'assets',{'assets':[asset]}), (BASE+'prices/DEMO',{'quotes':[quote]}),
                                     (BASE+'assets',{'assets':[asset]}), (BASE+'corporate-actions',{'corpActions':[action]}))):
        raw = json.dumps(body)
        out.append({'url':url,'http_status':200,'requested_at':f'2026-09-08T15:59:{51+i*2:02d}Z',
                    'received_at':f'2026-09-08T15:59:{52+i*2:02d}Z','body_utf8':raw,
                    'body_sha256':hashlib.sha256(raw.encode()).hexdigest(),'truncated':False})
    return out


def edit(record, fn):
    value = json.loads(record['body_utf8'])
    fn(value)
    record['body_utf8'] = json.dumps(value)
    record['body_sha256'] = hashlib.sha256(record['body_utf8'].encode()).hexdigest()


class CollectorTests(unittest.TestCase):
    def capture(self, rows=None):
        rs = iter(rows if rows is not None else records())
        return collect('DEMO', TOKEN, lambda url: next(rs))

    def test_bounded_exact_urls_and_actions(self):
        rs = iter(records())
        seen = []
        def fetch(url):
            seen.append(url)
            return next(rs)
        b = collect('DEMO', TOKEN, fetch)
        self.assertEqual(seen,[BASE+'assets',BASE+'prices/DEMO',BASE+'assets',BASE+'corporate-actions'])
        self.assertEqual(b['status'], 'REFERENCE_CAPTURED')
        self.assertEqual(b['normalized_input']['reference']['market_state'], 'UNKNOWN')
        self.assertEqual(len(b['corporate_actions']['actions']),1)

    def test_metadata_change_does_not_adjust_price(self):
        rs = records()
        edit(rs[2], lambda x:x['assets'][0].update(currentMultiplier='3'))
        b = self.capture(rs)
        self.assertIsNone(b['normalized_input'])
        self.assertEqual(len(b['responses']),4)

    def test_wrong_price_contract_rejected(self):
        rs = records()
        edit(rs[1], lambda x:x['quotes'][0]['deployments'][0].update(contractAddress='0x'+'4'*40))
        self.assertIsNone(self.capture(rs)['normalized_input'])

    def test_duplicate_matching_quote_rejected(self):
        rs = records()
        edit(rs[1], lambda x:x['quotes'].append(copy.deepcopy(x['quotes'][0])))
        self.assertIsNone(self.capture(rs)['normalized_input'])

    def test_hash_tampering_detected(self):
        b = self.capture()
        b['responses'][1]['body_utf8'] += ' '
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            normalize(b)

    def test_wrong_endpoint_and_time_order_detected(self):
        for key, value in (('url',BASE+'prices/AAPL'), ('received_at','2026-09-08T15:59:49Z')):
            rs = records()
            rs[1][key] = value
            self.assertIsNone(self.capture(rs)['normalized_input'])

    def test_http_failure_retains_partial_raw_evidence(self):
        rs = records()
        rs[1]['http_status'] = 429
        b = self.capture(rs)
        self.assertEqual(len(b['responses']),2)
        self.assertIsNone(b['normalized_input'])
        self.assertIn('body_utf8',b['responses'][1])

    def test_network_failure_returns_reviewable_capture(self):
        calls = []
        def fetch(url):
            calls.append(url)
            raise OSError('fixture connection refused')
        b = collect('DEMO',TOKEN,fetch)
        self.assertEqual(calls,[BASE+'assets'])
        self.assertEqual(b['status'],'REFERENCE_UNAVAILABLE')
        self.assertEqual(b['responses'],[])
        self.assertIn('fixture connection refused', b['error'])
        self.assertEqual(b['capture_errors'][0]['url'], BASE+'assets')

    def test_corporate_action_failure_preserves_valid_reference(self):
        rs = records()
        rs[3]['http_status'] = 503
        b = self.capture(rs)
        self.assertEqual(b['status'],'REFERENCE_CAPTURED')
        self.assertEqual(b['corporate_actions']['status'],'UNAVAILABLE')

    def test_pending_multiplier_crossing_cutoff_rejected(self):
        rs = records()
        for index in (0,2):
            edit(rs[index], lambda x:x['assets'][0].update(pendingMultiplier='3',pendingMultiplierEffectiveTime='2026-09-08T15:59:55Z'))
        self.assertIsNone(self.capture(rs)['normalized_input'])

    def test_crossed_bid_ask_and_non_usd_rejected(self):
        for change in ({'bid':'102'},{'currency':'CAD'},{'isTradingHalt':None}):
            rs = records()
            edit(rs[1],lambda x:x['quotes'][0].update(change))
            self.assertIsNone(self.capture(rs)['normalized_input'])

    def test_unsafe_symbol_not_sent(self):
        with self.assertRaises(ValueError):
            collect('../assets',TOKEN,lambda url:self.fail('unexpected network'))

    def test_truncated_body_not_parsed(self):
        rs = records()
        rs[0]['truncated'] = True
        b = self.capture(rs)
        self.assertIsNone(b['normalized_input'])
        self.assertEqual(len(b['responses']),1)


if __name__ == '__main__':
    unittest.main()
