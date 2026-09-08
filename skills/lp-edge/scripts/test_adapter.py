#!/usr/bin/env python3
"""Offline adversarial V3 adapter checks. Synthetic transport is never live validation."""
import copy
import hashlib
import json
import unittest
import collect_v3 as c


def abi(*values):
    return '0x'+''.join(c.word(v & c.U256) for v in values)


def addr(n):
    return '0x%040x'%n


def config(nft=True,sim=False,blocks=None):
    roles={'factory':addr(11),'pool':addr(12),'token0':addr(1),'token1':addr(2)}
    if nft:
        roles['position_manager']=addr(13)
    out={'chain_id':1,'block_numbers':blocks or [100,101],**roles,'fee':3000,'tick_lower':-60,'tick_upper':60,
         'expected_code_sha256':{role:hashlib.sha256(bytes.fromhex('6000')).hexdigest() for role in roles},
         'deployment_evidence':'SYNTHETIC fixture; not a real deployment verification.',
         'standard_token_evidence':'SYNTHETIC fixture; no observed token verification.'}
    if nft:
        out['token_id']='7'
    if sim:
        out['wallet']=addr(20)
        out['simulate']={
            'mint':{'amount0_desired_raw':'100','amount1_desired_raw':'100','amount0_min_raw':'1','amount1_min_raw':'1','deadline_seconds':300},
            'collect':True,
            'withdraw':{'liquidity':'100','amount0_min_raw':'1','amount1_min_raw':'1','deadline_seconds':300}}
    return out


class SyntheticTransport:
    def __init__(self,cfg=None):
        self.cfg=c.validate_config(cfg or config())
        self.balance=1000
        self.allowance=1000
        self.owner=20
        self.tick=0
        self.price=2**96
        self.revert=set()
        self.events=[]
        self.transfers=[]
        self.calls=[]
        self.mutate=None
        self.after_reorg=False
        self.headers={}

    def __call__(self,method,params,timeout):
        self.calls.append((method,copy.deepcopy(params)))
        result=self.response(method,params)
        return self.mutate(method,params,result) if self.mutate else result

    def response(self,method,params):
        if method=='eth_chainId':
            return hex(self.cfg['chain_id'])
        if method=='eth_getBlockByNumber':
            n=101 if params[0]=='latest' else int(params[0],16)
            self.headers[n]=self.headers.get(n,0)+1
            h=n+(1 if self.after_reorg and self.headers[n]>1 else 0)
            return {'number':hex(n),'hash':'0x%064x'%h,'timestamp':hex(100000+n)}
        if method=='eth_getCode':
            return '0x6000'
        if method=='eth_getLogs':
            return copy.deepcopy(self.transfers if params[0]['topics'][0]==c.TRANSFER else self.events)
        if method!='eth_call':
            raise AssertionError('unexpected method')
        tx=params[0]
        data=tx['data']
        sig=data[:10]
        if sig in self.revert:
            raise c.RpcFailure('RpcError',3)
        lookup={
            'factory()':abi(int(self.cfg['factory'],16)),
            'token0()':abi(int(self.cfg['token0'],16)),
            'token1()':abi(int(self.cfg['token1'],16)),
            'getPool(address,address,uint24)':abi(int(self.cfg['pool'],16)),
            'fee()':abi(3000),'tickSpacing()':abi(60),'feeAmountTickSpacing(uint24)':abi(60),
            'slot0()':abi(self.price,self.tick,0,1,1,0,1),'liquidity()':abi(10000),
            'feeGrowthGlobal0X128()':abi(20*2**128),'feeGrowthGlobal1X128()':abi(30*2**128),
            'decimals()':abi(18),'ticks(int24)':abi(10000,10000,2**128,2**128,0,0,1,1),
            'positions(uint256)':abi(0,0,1,2,3000,-60,60,1000,2**128,2**128,10,20),
            'ownerOf(uint256)':abi(self.owner),'balanceOf(address)':abi(self.balance),
            'allowance(address,address)':abi(self.allowance),
            'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))':abi(8,1000,50,60),
            'collect((uint256,address,uint128,uint128))':abi(500,600),
            'multicall(bytes[])':c.encode_bytes_array([abi(3,4),abi(503,604)])}
        for key,value in lookup.items():
            if sig==c.selector(key):
                return value
        raise AssertionError('unexpected selector '+sig)


def event(transfer=False,index=1):
    return {'address':addr(13),'blockNumber':hex(101),'blockHash':'0x%064x'%101,
            'transactionHash':'0x%064x'%31,'transactionIndex':'0x0','logIndex':hex(index),'removed':False,
            'topics':[c.TRANSFER,'0x'+c.address_word(addr(20)),'0x'+c.address_word(addr(21)),'0x'+c.word(7)] if transfer else [next(iter(c.EVENTS)),'0x'+c.word(7)],
            'data':'0x' if transfer else abi(10,20,30)}


class TestAdapter(unittest.TestCase):
    def collect(self,cfg=None,transport=None):
        cfg=cfg or config()
        return c.collect(transport or SyntheticTransport(cfg),cfg,source_kind='synthetic')

    def test_keccak_independent_known_vectors(self):
        self.assertEqual(c.keccak256(b'').hex(),'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
        self.assertEqual(c.selector('transfer(address,uint256)'),'0xa9059cbb')
        self.assertEqual(c.selector('multicall(bytes[])'),'0xac9650d8')
        self.assertEqual(c.TRANSFER,'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')

    def test_snapshot_and_history_reconcile(self):
        packet=self.collect()
        self.assertEqual(packet['status'],'complete',packet['diagnostics'])
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['snapshots'][0]['position']['tick_lower'],-60)
        self.assertEqual(packet['interval_activity'][0]['status'],'provider_returned_no_events')
        self.assertTrue(packet['interval_activity'][0]['provider_completeness_unverified'])

    def test_no_nft_pool_collection(self):
        packet=self.collect(config(nft=False))
        self.assertTrue(c.verify_evidence(packet))
        self.assertIsNone(packet['snapshots'][0]['position'])
        self.assertEqual(packet['interval_activity'][0]['status'],'not_requested')

    def test_every_state_read_hash_pinned(self):
        packet=self.collect()
        for r in packet['records']:
            if r['method'] in ('eth_call','eth_getCode'):
                self.assertEqual(set(r['params'][1]),{'blockHash','requireCanonical'})
                self.assertIs(r['params'][1]['requireCanonical'],True)

    def test_hashes_mandatory_for_all_roles(self):
        cfg=config(); del cfg['expected_code_sha256']['token0']
        with self.assertRaises(ValueError): c.validate_config(cfg)

    def test_unknown_config_fields_and_bool_chain_rejected(self):
        for key,value in [('rpc_url','secret'),('chain_id',True)]:
            cfg=config(); cfg[key]=value
            with self.assertRaises(ValueError): c.validate_config(cfg)

    def test_reject_noncanonical_raw_amounts(self):
        for value in ['01','-1',1,True,'1e5','9'*79]:
            cfg=config(sim=True); cfg['simulate']['mint']['amount0_desired_raw']=value
            with self.assertRaises(ValueError): c.validate_config(cfg)

    def test_identity_mismatch(self):
        t=SyntheticTransport()
        t.mutate=lambda m,p,r:abi(99) if m=='eth_call' and p[0]['data'].startswith(c.selector('getPool(address,address,uint24)')) else r
        self.assertEqual(self.collect(transport=t)['status'],'invalid')

    def test_code_mismatch(self):
        t=SyntheticTransport(); t.mutate=lambda m,p,r:'0x6001' if m=='eth_getCode' else r
        self.assertEqual(self.collect(transport=t)['status'],'invalid')

    def test_wrong_chain(self):
        t=SyntheticTransport(); t.mutate=lambda m,p,r:'0x2' if m=='eth_chainId' else r
        self.assertEqual(self.collect(transport=t)['status'],'invalid')

    def test_wrong_header_number(self):
        t=SyntheticTransport(); t.mutate=lambda m,p,r:{**r,'number':'0x99'} if m=='eth_getBlockByNumber' else r
        self.assertEqual(self.collect(transport=t)['status'],'invalid')

    def test_reorg_discards_unanchored_snapshot(self):
        t=SyntheticTransport(); t.after_reorg=True
        packet=self.collect(transport=t)
        self.assertEqual(packet['status'],'invalid'); self.assertEqual(packet['snapshots'],[])
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_rpc_failure_does_not_imply_zero(self):
        t=SyntheticTransport(); t.revert.add(c.selector('liquidity()'))
        packet=self.collect(transport=t)
        self.assertEqual(packet['status'],'incomplete'); self.assertEqual(packet['snapshots'],[])

    def test_budget_stops_collection(self):
        cfg=config(); t=SyntheticTransport(cfg)
        packet=c.collect(t,cfg,source_kind='synthetic',max_calls=3)
        self.assertEqual(packet['status'],'incomplete'); self.assertEqual(len(t.calls),3)

    def test_normalized_tamper_rejected(self):
        packet=self.collect(); packet['snapshots'][0]['pool']['liquidity']='10001'
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_raw_result_tamper_rejected(self):
        packet=self.collect()
        r=next(r for r in packet['records'] if r['method']=='eth_call' and r['params'][0]['data']==c.selector('liquidity()'))
        r['result']=abi(20000)
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_raw_request_tamper_rejected(self):
        packet=self.collect()
        r=next(r for r in packet['records'] if r['method']=='eth_call')
        r['params'][1]['requireCanonical']=False
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_json_bool_int_float_type_substitutions_rejected(self):
        for value in (1,1.0):
            packet=self.collect()
            r=next(r for r in packet['records'] if r['method']=='eth_getCode')
            r['params'][1]['requireCanonical']=value
            with self.assertRaises(ValueError): c.verify_evidence(packet)
        for value in (True,1.0):
            packet=self.collect(); packet['chain_id']=value
            with self.assertRaises(ValueError): c.verify_evidence(packet)
        for value in (False,0.0):
            packet=self.collect(); packet['snapshots'][0]['pool']['tick']=value
            with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_unused_raw_record_rejected(self):
        packet=self.collect(); packet['records'].append(copy.deepcopy(packet['records'][-1]))
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_source_label_preserved_but_not_authenticated(self):
        packet=self.collect()
        self.assertEqual(packet['source_kind'],'synthetic')
        self.assertTrue(c.verify_evidence(packet))
        packet['source_kind']='unknown'
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_tick_price_mismatch_rejected(self):
        t=SyntheticTransport(); t.tick=30
        self.assertEqual(self.collect(transport=t)['status'],'invalid')

    def test_tick_boundary_convention_accepted(self):
        t=SyntheticTransport(); t.tick=-1
        self.assertEqual(self.collect(transport=t)['status'],'complete')

    def test_signed_padding_rejected(self):
        for bad in [2**24-60,2**128-60]:
            with self.assertRaises(ValueError): c.signed(bad,24)
        self.assertEqual(c.signed((-60)&c.U256,24),-60)

    def test_static_trailing_bytes_and_uint_padding_rejected(self):
        with self.assertRaises(ValueError): c.words(abi(1,2),1)
        with self.assertRaises(ValueError): c.decode_address(abi(2**160))

    def test_mint_collect_atomic_withdraw_are_read_only(self):
        cfg=config(sim=True); packet=self.collect(cfg)
        self.assertTrue(c.verify_evidence(packet))
        for s in packet['snapshots'][0]['simulations'].values():
            self.assertEqual(s['status'],'call_succeeded')
        self.assertFalse(any('send' in r['method'].lower() for r in packet['records']))
        calls=[r for r in packet['records'] if r['method']=='eth_call' and 'from' in r['params'][0]]
        self.assertEqual(len(calls),6)
        withdraw=next(r for r in calls if r['params'][0]['data'].startswith(c.selector('multicall(bytes[])')))
        inner=c.decode_bytes_array('0x'+withdraw['params'][0]['data'][10:],2)
        self.assertTrue(inner[0].startswith('0x0c49ccbe')); self.assertTrue(inner[1].startswith('0xfc6f7865'))

    def test_desired_cap_shortfall_does_not_block_valid_mint(self):
        cfg=config(sim=True); t=SyntheticTransport(cfg); t.allowance=99
        packet=self.collect(cfg,t)
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['snapshots'][0]['simulations']['mint']['status'],'call_succeeded')
        self.assertEqual(packet['snapshots'][0]['simulations']['mint']['desired_cap_shortfall_token_indices'],[0,1])
        self.assertTrue(any(m=='eth_call' and p[0]['data'].startswith('0x88316456') for m,p in t.calls))

    def test_mint_return_cannot_exceed_actual_wallet_prerequisites(self):
        cfg=config(sim=True); t=SyntheticTransport(cfg); t.allowance=49
        packet=self.collect(cfg,t)
        self.assertEqual(packet['status'],'invalid')

    def test_one_sided_mint_can_succeed_without_unused_token(self):
        cfg=config(sim=True,blocks=[100]); cfg.pop('token_id'); cfg['tick_lower']=60; cfg['tick_upper']=120
        cfg['simulate']={'mint':dict(cfg['simulate']['mint'],amount1_min_raw='0')}
        t=SyntheticTransport(cfg)
        def mutate(m,p,r):
            if m=='eth_call':
                sig=p[0]['data'][:10]
                if p[0]['to']==addr(2) and sig in (c.selector('balanceOf(address)'),c.selector('allowance(address,address)')):
                    return abi(0)
                if sig=='0x88316456':
                    return abi(8,1000,50,0)
            return r
        t.mutate=mutate
        packet=self.collect(cfg,t)
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['snapshots'][0]['simulations']['mint']['status'],'call_succeeded')

    def test_nonowner_blocks_position_calls(self):
        cfg=config(sim=True); t=SyntheticTransport(cfg); t.owner=21
        packet=self.collect(cfg,t)
        self.assertTrue(c.verify_evidence(packet))
        for name in ('collect','withdraw'):
            self.assertEqual(packet['snapshots'][0]['simulations'][name]['status'],'missing_prerequisites')

    def test_revert_simulation_is_not_success(self):
        cfg=config(sim=True); t=SyntheticTransport(cfg); t.revert.add(c.selector('collect((uint256,address,uint128,uint128))'))
        packet=self.collect(cfg,t)
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['snapshots'][0]['simulations']['collect']['status'],'rpc_error')
        packet['snapshots'][0]['simulations']['collect']['status']='call_succeeded'
        with self.assertRaises(ValueError): c.verify_evidence(packet)

    def test_dynamic_bad_offset_and_padding_rejected(self):
        encoded=c.encode_bytes_array(['0x1234','0xab'])
        self.assertEqual(c.decode_bytes_array(encoded,2),['0x1234','0xab'])
        for changed in [encoded[:-1]+'1',encoded[:130]+c.word(96)+encoded[194:]]:
            with self.assertRaises(ValueError): c.decode_bytes_array(changed,2)

    def test_position_events_prevent_no_activity_status(self):
        t=SyntheticTransport(); t.events=[event()]
        packet=self.collect(transport=t)
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['interval_activity'][0]['status'],'position_events_present')

    def test_transfer_out_back_visible_with_same_endpoint_owner(self):
        t=SyntheticTransport(); out=event(True,1); back=event(True,2)
        back['topics'][1],back['topics'][2]=back['topics'][2],back['topics'][1]
        t.transfers=[out,back]
        packet=self.collect(transport=t)
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['interval_activity'][0]['status'],'position_events_present')
        self.assertEqual(len(packet['interval_activity'][0]['events']),2)

    def test_duplicate_or_foreign_position_log_rejected(self):
        for events in [[event(),event()],[{**event(),'address':addr(14)}],[{**event(),'blockNumber':'0x64'}]]:
            t=SyntheticTransport(); t.events=events
            self.assertEqual(self.collect(transport=t)['status'],'invalid')

    def test_unavailable_event_coverage_remains_unknown(self):
        cfg=config(); cfg['max_log_block_span']=1; cfg['block_numbers']=[100,102]
        packet=self.collect(cfg)
        self.assertTrue(c.verify_evidence(packet))
        self.assertEqual(packet['interval_activity'][0]['status'],'unavailable')

    def test_strict_json_duplicate_and_nonfinite(self):
        for raw in ['{"a":1,"a":2}','{"a":NaN}','{"a":1e999}']:
            with self.assertRaises(ValueError): c.strict_json(raw)


if __name__=='__main__':
    unittest.main()
