import copy
import hashlib
import json
import unittest
from stock_reference import BASE, collect, normalize, verify

TOKEN = '0x'+'1'*40


def fixture():
    deployment = [{'chainId':4663,'contractAddress':TOKEN}]
    asset = {'id':'asset-nvda','tokenSymbol':'NVDA','deployments':deployment,
             'currentMultiplier':'2','pendingMultiplier':'','status':'ASSET_STATUS_ACTIVE',
             'tradingCapabilities':{'allDayTradability':None}}
    quote = {'tokenSymbol':'NVDA','deployments':deployment,'bid':'100.25','ask':'100.75',
             'currency':'USD','isTradingHalt':False,'generatedAt':'2026-09-08T14:00:00+00:00'}
    bodies = [{'assets':[asset]}, {'quotes':[quote]}, {'assets':[copy.deepcopy(asset)]}]
    rows = []
    for i, body in enumerate(bodies):
        raw = json.dumps(body)
        rows.append({'url':BASE+('prices/NVDA' if i==1 else 'assets'),'http_status':200,
                     'requested_at':f'2026-09-08T14:00:0{i*2}+00:00',
                     'received_at':f'2026-09-08T14:00:0{i*2+1}+00:00',
                     'body_utf8':raw,'body_sha256':hashlib.sha256(raw.encode()).hexdigest()})
    return {'schema':'undertow.stock-reference.v1','chain_id':4663,'symbol':'NVDA','token':TOKEN,
            'max_server_age_seconds':60,'responses':rows}


def edit(bundle, index, fn):
    record = bundle['responses'][index]
    body = json.loads(record['body_utf8'])
    fn(body)
    record['body_utf8']=json.dumps(body)
    record['body_sha256']=hashlib.sha256(record['body_utf8'].encode()).hexdigest()


class ReferenceTests(unittest.TestCase):
    def test_units_and_boundary(self):
        r = normalize(fixture())
        self.assertEqual(r['indicative_token_bid_usd'],'200.50')
        self.assertEqual(r['indicative_token_ask_usd'],'201.50')
        self.assertFalse(r['historical_attribution_qualified'])
        self.assertEqual(r['trading_capabilities']['allDayTradability'],None)

    def test_collect_replays_order(self):
        b = fixture()
        rows = iter(b['responses'])
        seen = []
        def fetch(url):
            seen.append(url)
            return next(rows)
        r = collect('NVDA',TOKEN,fetcher=fetch)
        self.assertEqual(seen,[BASE+'assets',BASE+'prices/NVDA',BASE+'assets'])
        self.assertEqual(verify(r),r['normalized'])

    def test_false_vs_zero_tamper(self):
        b=fixture();b['normalized']=normalize(b)
        b['normalized']['historical_attribution_qualified']=0
        with self.assertRaises(ValueError): verify(b)

    def test_hash_tamper(self):
        b=fixture();b['responses'][0]['body_utf8']+=' '
        with self.assertRaises(ValueError): verify(b)

    def test_multiplier_race(self):
        b=fixture();edit(b,2,lambda x:x['assets'][0].update(currentMultiplier='3'))
        with self.assertRaises(ValueError): normalize(b)

    def test_deployment_identity(self):
        b=fixture();edit(b,1,lambda x:x['quotes'][0]['deployments'][0].update(contractAddress='0x'+'2'*40))
        with self.assertRaises(ValueError): normalize(b)

    def test_ambiguous_quote(self):
        b=fixture();edit(b,1,lambda x:x['quotes'].append(copy.deepcopy(x['quotes'][0])))
        with self.assertRaises(ValueError): normalize(b)

    def test_quote_values(self):
        for value in ('0','-1','NaN','Infinity',True,1.2,'1e9000'):
            with self.subTest(value=value):
                b=fixture();edit(b,1,lambda x:x['quotes'][0].update(bid=value))
                with self.assertRaises(ValueError): normalize(b)

    def test_crossed_quotes(self):
        b=fixture();edit(b,1,lambda x:x['quotes'][0].update(bid='200'))
        with self.assertRaises(ValueError): normalize(b)

    def test_halt_unknown_and_confirmed(self):
        b=fixture();edit(b,1,lambda x:x['quotes'][0].update(isTradingHalt=None))
        with self.assertRaises(ValueError): normalize(b)
        b=fixture();edit(b,1,lambda x:x['quotes'][0].update(isTradingHalt=True))
        self.assertEqual(normalize(b)['status'],'HALTED_REFERENCE')

    def test_future_or_stale_server_time(self):
        for value in ('2026-09-08T14:00:04Z','2026-09-08T13:00:00Z'):
            b=fixture();edit(b,1,lambda x:x['quotes'][0].update(generatedAt=value))
            with self.assertRaises(ValueError): normalize(b)

    def test_effective_pending_multiplier(self):
        b=fixture()
        for i in (0,2):
            edit(b,i,lambda x:x['assets'][0].update(pendingMultiplier='4',pendingMultiplierEffectiveTime='2026-09-08T14:00:04Z'))
        with self.assertRaises(ValueError): normalize(b)

    def test_unknown_pending_multiplier(self):
        for value in (None,False,0,[],{}):
            with self.subTest(value=value):
                b=fixture()
                for i in (0,2): edit(b,i,lambda x:x['assets'][0].update(pendingMultiplier=value))
                with self.assertRaises(ValueError): normalize(b)

    def test_capture_time_order(self):
        b=fixture();b['responses'][1]['requested_at']='2026-09-08T13:59:00Z'
        with self.assertRaises(ValueError): normalize(b)

    def test_freshness_through_capture_end(self):
        b=fixture()
        b['responses'][2]['requested_at']='2026-09-09T14:00:00Z'
        b['responses'][2]['received_at']='2026-09-09T14:00:01Z'
        with self.assertRaises(ValueError): normalize(b)

    def test_inactive_asset(self):
        b=fixture()
        for i in (0,2): edit(b,i,lambda x:x['assets'][0].update(status='ASSET_STATUS_INACTIVE'))
        with self.assertRaises(ValueError): normalize(b)

    def test_endpoint_binding(self):
        b=fixture();b['responses'][1]['url']=BASE+'prices/AAPL'
        with self.assertRaises(ValueError): normalize(b)


if __name__ == '__main__': unittest.main()
