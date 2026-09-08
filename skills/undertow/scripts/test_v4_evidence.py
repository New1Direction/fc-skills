"""Offline adversarial evidence fixtures; none are historical chain observations."""
import copy
from decimal import Decimal
import hashlib
import unittest

import v4_evidence as v


def h(n):
    return '0x' + format(n, '064x')


def addr(n):
    return '0x' + format(n, '040x')


def encoded(*args):
    return '0x' + b''.join(v.word(x) for x in args).hex()


def fixture(hook=0, lo=10, hi=21):
    pool = {'currency0':addr(1),'currency1':addr(2),'decimals0':18,'decimals1':6,
            'base_currency':addr(1),'fee':3000,'tick_spacing':60,'hooks':addr(hook),
            'initialize_transaction':h(100),'initialize_log_index':0}
    pool['pool_id'] = v.pool_id(pool)
    req = {'schema':'undertow.v4-request.v1','chain_id':4663,'from_block':lo,'to_block':hi,
           'manager':{'address':v.MANAGER,'expected_code_sha256':hashlib.sha256(b'fixture runtime').hexdigest(),
                      'deployment_source':'SYNTHETIC: deployment fixture', 'code_source':'SYNTHETIC: independent test manifest'},
           'pools':[pool]}
    def log(number, tx, index, topics, data):
        return {'address':v.MANAGER,'blockNumber':hex(number),'blockHash':h(number),
                'transactionHash':h(tx),'transactionIndex':'0x0','logIndex':hex(index),
                'removed':False,'topics':topics,'data':data}
    initial = log(9,100,0,[v.INIT_TOPIC,pool['pool_id'],h(1),h(2)],encoded(3000,60,hook,1<<96,0))
    swap = log(lo,101,1,[v.SWAP_TOPIC,pool['pool_id'],h(99)],encoded(10**18,-10**6,1<<96,10**21,0,3000))
    def receipt(logs):
        x=logs[0]
        return {k:x[k] for k in ('transactionHash','transactionIndex','blockHash','blockNumber')} | {'status':'0x1','logs':logs}
    class FakeRPC:
        def __init__(self):
            self.calls=[]
            self.logs=[swap]
            self.receipts={h(100):receipt([initial]),h(101):receipt([swap])}
        def __call__(self,method,params):
            self.calls.append((method,copy.deepcopy(params)))
            if method=='eth_chainId': return '0x1237'
            if method=='eth_getBlockByNumber':
                n=int(params[0],16)
                return {'number':hex(n),'hash':h(n),'parentHash':h(n-1),'timestamp':hex(n*2)}
            if method=='eth_getCode': return '0x'+b'fixture runtime'.hex()
            if method=='eth_call': return encoded(18 if params[0]['to']==addr(1) else 6)
            if method=='eth_getLogs':
                a,b=int(params[0]['fromBlock'],16),int(params[0]['toBlock'],16)
                return copy.deepcopy([x for x in self.logs if a<=int(x['blockNumber'],16)<=b])
            if method=='eth_getTransactionReceipt': return copy.deepcopy(self.receipts.get(params[0]))
            raise AssertionError(method)
    return req,FakeRPC(),swap


class V4EvidenceTests(unittest.TestCase):
    def test_keccak_independent_published_vectors(self):
        self.assertEqual(v.keccak256(b'').hex(),'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
        self.assertEqual(v.keccak256(b'abc').hex(),'4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
        self.assertEqual(v.keccak256(b'Transfer(address,address,uint256)').hex(),'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')

    def test_roundtrip_receipts_hashes_and_shards(self):
        req,rpc,_=fixture()
        bundle=v.collect(req,rpc)
        report=v.verify(bundle,req)
        self.assertEqual(len(report['swaps']),1)
        self.assertEqual(report['coverage']['requested_blocks'],12)
        self.assertFalse(report['coverage']['independently_complete'])
        filters=[p[0] for m,p in rpc.calls if m=='eth_getLogs']
        self.assertEqual([(int(f['fromBlock'],16),int(f['toBlock'],16)) for f in filters],[(10,19),(20,21)])
        state_pins=[p[-1] for m,p in rpc.calls if m in ('eth_getCode','eth_call')]
        self.assertTrue(all(set(p)=={'blockHash','requireCanonical'} and p['requireCanonical'] is True for p in state_pins))

    def test_single_block_range(self):
        req,rpc,_=fixture(lo=10,hi=10)
        self.assertEqual(v.verify(v.collect(req,rpc),req)['coverage']['requested_blocks'],1)

    def test_mark_direction_and_no_trader_attribution(self):
        req,_,log=fixture()
        row=v.decode_swap(log,req['pools'][0])
        self.assertEqual(Decimal(row['quote_per_base_mark']),Decimal(10)**12)
        self.assertEqual(row['core_direction'],'BUY_BASE')
        self.assertIsNone(row['trader'])
        self.assertIsNone(row['wallet_cash_flow'])
        self.assertIsNone(row['pool_inventory'])
        self.assertEqual(row['sender'],addr(99))

    def test_currency_inversion(self):
        req,_,log=fixture()
        p=req['pools'][0];p['base_currency']=p['currency1']
        row=v.decode_swap(log,p)
        self.assertEqual(Decimal(row['quote_per_base_mark']),Decimal(10)**-12)
        self.assertEqual(row['core_direction'],'SELL_BASE')

    def test_unknown_hook_keeps_raw_and_unqualified(self):
        req,rpc,_=fixture(hook=0x80)
        row=v.verify(v.collect(req,rpc),req)['swaps'][0]
        self.assertEqual(row['hook_status'],'UNKNOWN_HOOK_UNQUALIFIED')
        self.assertIsNone(row['executable_proceeds'])
        self.assertEqual(row['amount0_raw'],str(10**18))

    def test_invalid_hook_fee_combinations_rejected(self):
        for hook, fee in [(0,0x800000),(1 << 14,3000),(8,3000),(4,3000),(2,3000),(1,3000),
                          ((1<<7)|4,3000),((1<<6)|8,0x800000)]:
            req,_,_=fixture(hook=hook)
            req['pools'][0]['fee']=fee
            req['pools'][0]['pool_id']=v.pool_id(req['pools'][0])
            with self.subTest(hook=hook,fee=fee),self.assertRaisesRegex(v.EvidenceError,'hook address/fee'):
                v.validate_request(req)

    def test_valid_hook_permissions_remain_unqualified(self):
        for hook,fee in [(0,3000),(1<<14,0x800000),(8|128,3000),(4|64,3000),
                         (2|1024,3000),(1|256,3000),(0x3fff,0x800000)]:
            req,_,_=fixture(hook=hook)
            req['pools'][0]['fee']=fee
            req['pools'][0]['pool_id']=v.pool_id(req['pools'][0])
            with self.subTest(hook=hook,fee=fee):v.validate_request(req)

    def test_integer_widths_and_sign_extension(self):
        req,_,log=fixture()
        cases=[(0,1<<127),(0,(1<<128)-1),(1,(1<<128)-1),(2,1<<160),
               (3,1<<128),(4,1<<23),(4,(1<<24)-1),(5,1<<24)]
        for index,value in cases:
            with self.subTest(index=index,value=value):
                w=v.words(log['data'],6);w[index]=value
                changed=copy.deepcopy(log);changed['data']=encoded(*w)
                with self.assertRaises(v.EvidenceError):v.decode_swap(changed,req['pools'][0])

    def test_valid_negative_int128_edge(self):
        req,_,log=fixture()
        w=v.words(log['data'],6);w[0]=-(1<<127)
        log['data']=encoded(*w)
        self.assertEqual(v.decode_swap(log,req['pools'][0])['amount0_raw'],str(-(1<<127)))

    def test_core_price_and_fee_bounds(self):
        req,_,log=fixture()
        for index,value in [(2,0),(2,v.MAX_SQRT),(4,887273),(4,-887273),(5,1000001)]:
            with self.subTest(index=index,value=value):
                w=v.words(log['data'],6);w[index]=value
                x=copy.deepcopy(log);x['data']=encoded(*w)
                with self.assertRaises(v.EvidenceError):v.decode_swap(x,req['pools'][0])

    def test_nonstandard_deltas_never_buy(self):
        req,_,log=fixture()
        w=v.words(log['data'],6);w[1]=100
        log['data']=encoded(*w)
        self.assertEqual(v.decode_swap(log,req['pools'][0])['core_direction'],'NONSTANDARD_OR_ZERO')

    def test_malformed_sender_address(self):
        req,_,log=fixture();log['topics'][2]=h(1<<200)
        with self.assertRaises(v.EvidenceError):v.decode_swap(log,req['pools'][0])

    def test_removed_and_missing_removed_rejected(self):
        req,_,log=fixture()
        for value in (True,0,None):
            x=copy.deepcopy(log);x['removed']=value
            with self.assertRaises(v.EvidenceError):v.decode_swap(x,req['pools'][0])
        del log['removed']
        with self.assertRaises(v.EvidenceError):v.decode_swap(log,req['pools'][0])

    def test_failed_receipt(self):
        req,rpc,_=fixture();rpc.receipts[h(101)]['status']='0x0'
        with self.assertRaisesRegex(v.EvidenceError,'failed receipt'):v.collect(req,rpc)

    def test_mismatching_receipt_log(self):
        req,rpc,_=fixture();rpc.receipts[h(101)]['logs']=[]
        with self.assertRaisesRegex(v.EvidenceError,'absent'):v.collect(req,rpc)

    def test_conflicting_receipt_context(self):
        req,rpc,_=fixture();rpc.receipts[h(101)]['transactionIndex']='0x1'
        with self.assertRaisesRegex(v.EvidenceError,'context'):v.collect(req,rpc)

    def test_duplicate_returned_log(self):
        req,rpc,log=fixture();rpc.logs.append(copy.deepcopy(log))
        with self.assertRaisesRegex(v.EvidenceError,'duplicate'):v.collect(req,rpc)

    def test_provider_omits_swap_visible_in_receipt(self):
        req,rpc,log=fixture()
        extra=copy.deepcopy(log);extra['logIndex']='0x2'
        rpc.receipts[h(101)]['logs'].append(extra)
        with self.assertRaisesRegex(v.EvidenceError,'omitted'):v.collect(req,rpc)

    def test_wholly_empty_provider_remains_unproven(self):
        req,rpc,_=fixture();rpc.logs=[]
        report=v.verify(v.collect(req,rpc),req)
        self.assertEqual(report['swaps'],[])
        self.assertFalse(report['coverage']['independently_complete'])

    def test_initialization_key_identity(self):
        req,rpc,_=fixture()
        init=rpc.receipts[h(100)]['logs'][0]
        init['data']=encoded(3001,60,0,1<<96,0)
        with self.assertRaisesRegex(v.EvidenceError,'key mismatch'):v.collect(req,rpc)

    def test_initialization_late(self):
        req,rpc,_=fixture();req['from_block']=8
        with self.assertRaisesRegex(v.EvidenceError,'after range start'):v.collect(req,rpc)

    def test_wrong_chain(self):
        req,rpc,_=fixture()
        def wrong(m,p):return '0xb626' if m=='eth_chainId' else rpc(m,p)
        with self.assertRaisesRegex(v.EvidenceError,'wrong RPC chain'):v.collect(req,wrong)

    def test_code_fingerprint_mismatch(self):
        req,rpc,_=fixture();req['manager']['expected_code_sha256']='0'*64
        with self.assertRaisesRegex(v.EvidenceError,'runtime code'):v.collect(req,rpc)

    def test_wrong_decimals(self):
        req,rpc,_=fixture();req['pools'][0]['decimals0']=9
        with self.assertRaisesRegex(v.EvidenceError,'decimals mismatch'):v.collect(req,rpc)

    def test_block_reorg_after_reads(self):
        req,rpc,_=fixture();counts={}
        def changed(m,p):
            value=rpc(m,p)
            if m=='eth_getBlockByNumber':
                counts[p[0]]=counts.get(p[0],0)+1
                if counts[p[0]]>1 and p[0]==hex(10):value['hash']=h(999)
            return value
        with self.assertRaisesRegex(v.EvidenceError,'block changed'):v.collect(req,changed)

    def test_noncontiguous_headers(self):
        req,rpc,_=fixture()
        def changed(m,p):
            value=rpc(m,p)
            if m=='eth_getBlockByNumber' and p[0]==hex(11):value['parentHash']=h(999)
            return value
        with self.assertRaisesRegex(v.EvidenceError,'noncontiguous'):v.collect(req,changed)

    def test_offline_derived_tamper(self):
        req,rpc,_=fixture();bundle=v.collect(req,rpc)
        bundle['report']['swaps'][0]['trader']=addr(99)
        with self.assertRaisesRegex(v.EvidenceError,'normalized report'):v.verify(bundle,req)

    def test_json_type_tamper(self):
        req,rpc,_=fixture();bundle=v.collect(req,rpc)
        bundle['report']['coverage']['independently_complete']=0
        with self.assertRaisesRegex(v.EvidenceError,'normalized report'):v.verify(bundle,req)

    def test_offline_raw_tamper_with_rehashed_transcript(self):
        req,rpc,_=fixture();bundle=v.collect(req,rpc)
        call=next(x for x in bundle['rpc_transcript'] if x['method']=='eth_getLogs')
        call['result'][0]['data']=encoded(99,-10**6,1<<96,10**21,0,3000)
        bundle['transcript_sha256']=v.digest(bundle['rpc_transcript'])
        with self.assertRaisesRegex(v.EvidenceError,'absent'):v.verify(bundle,req)

    def test_untrusted_manifest_replacement(self):
        req,rpc,_=fixture();bundle=v.collect(req,rpc)
        bundle['request']['manager']['code_source']='untrusted replacement'
        with self.assertRaisesRegex(v.EvidenceError,'independent manifest'):v.verify(bundle,req)

    def test_rpc_order_tamper(self):
        req,rpc,_=fixture();bundle=v.collect(req,rpc)
        bundle['rpc_transcript'][0],bundle['rpc_transcript'][1]=bundle['rpc_transcript'][1],bundle['rpc_transcript'][0]
        bundle['transcript_sha256']=v.digest(bundle['rpc_transcript'])
        with self.assertRaisesRegex(v.EvidenceError,'call mismatch'):v.verify(bundle,req)

    def test_call_limits_and_truncated_tail(self):
        req,rpc,_=fixture();bundle=v.collect(req,rpc)
        bundle['rpc_transcript'].pop();bundle['transcript_sha256']=v.digest(bundle['rpc_transcript'])
        with self.assertRaisesRegex(v.EvidenceError,'truncated'):v.verify(bundle,req)

    def test_requests_are_bounded_and_strict(self):
        for key,value in [('chain_id',True),('chain_id',46630),('from_block',10.0),('to_block',211),('from_block',22)]:
            req,_,_=fixture();req[key]=value
            with self.subTest(key=key,value=value),self.assertRaises(v.EvidenceError):v.validate_request(req)
        req,_,_=fixture();req['pools'][0]['pool_id']=h(123)
        with self.assertRaisesRegex(v.EvidenceError,'key hash'):v.validate_request(req)

    def test_no_nonread_rpc(self):
        rpc=v.HTTPRPC('https://example.com')
        with self.assertRaisesRegex(v.EvidenceError,'read-only'):rpc('eth_sendRawTransaction',[])

    def test_http_endpoint_rejected(self):
        with self.assertRaisesRegex(v.EvidenceError,'HTTPS'):v.HTTPRPC('http://example.com')
        with self.assertRaisesRegex(v.EvidenceError,'HTTPS'):v.HTTPRPC('https://user:password@example.com')


if __name__=='__main__':unittest.main()
