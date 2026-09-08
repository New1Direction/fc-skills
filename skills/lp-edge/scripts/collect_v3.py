#!/usr/bin/env python3
"""Bounded canonical V3 read-only collection and offline transcript reconciliation.

Only standard tokens and independently verified canonical deployments are in scope.
No signing, approvals, transactions, state overrides, retries, or background service.
"""
import argparse
import datetime as dt
import functools
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

SCHEMA = 'lp-edge.v3-evidence.v1'
MAX_RESPONSE = 8 * 1024 * 1024
MAX_INPUT = 32 * 1024 * 1024
MAX_TRANSCRIPT = 24 * 1024 * 1024
U256 = 2**256 - 1
U128 = 2**128 - 1
ALLOWED = {'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getLogs'}
BASE_ROLES = {'factory', 'pool', 'token0', 'token1'}


def strict_json(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError('duplicate JSON key')
            out[key] = value
        return out
    def bad(_):
        raise ValueError('nonfinite JSON number')
    def finite(value):
        v = float(value)
        if not math.isfinite(v):
            bad(value)
        return v
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=bad, parse_float=finite)


def canonical(value):
    """Type-strict JSON comparison: true, 1, and 1.0 must remain distinct."""
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)


def fixed_hex(value, size):
    return isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]{%d}' % (2 * size), value) is not None


def quantity(value):
    if not isinstance(value, str) or len(value) > 66 or re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)', value) is None:
        raise ValueError('invalid RPC quantity')
    return int(value, 16)


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('integer outside supported bounds')
    return value


def decimal_uint(value, bits=256, positive=False):
    if not isinstance(value, str) or len(value) > 78 or not re.fullmatch(r'0|[1-9][0-9]*', value):
        raise ValueError('raw integers must be canonical decimal strings')
    n = int(value)
    return integer(n, int(positive), 2**bits - 1)


def address(value, nonzero=True):
    if not fixed_hex(value, 20) or (nonzero and int(value, 16) == 0):
        raise ValueError('invalid EVM address')
    return value.lower()


def word(value):
    return '%064x' % integer(value, 0, U256)


def signed_word(value, bits=24):
    integer(value, -(2**(bits-1)), 2**(bits-1)-1)
    return word(value & U256)


def address_word(value):
    return '0' * 24 + address(value, nonzero=False)[2:]


def words(value, count):
    if not fixed_hex(value, 32 * count):
        raise ValueError('invalid static ABI return shape')
    return [int(value[2+i*64:66+i*64], 16) for i in range(count)]


def narrow(value, bits):
    return integer(value, 0, 2**bits-1)


def signed(value, bits):
    low = value & (2**bits-1)
    result = low if low < 2**(bits-1) else low - 2**bits
    if value != (result & U256):
        raise ValueError('invalid ABI signed padding')
    return result


def decode_address(value):
    return '0x%040x' % narrow(words(value, 1)[0], 160)


# Keccak-256 (Ethereum padding, not NIST SHA3) solely for ABI identifiers.
def keccak256(raw):
    mask = 2**64-1
    rot = ((0,36,3,41,18),(1,44,10,45,2),(62,6,43,15,61),(28,55,25,21,56),(27,20,39,8,14))
    rc = (0x1,0x8082,0x800000000000808a,0x8000000080008000,0x808b,0x80000001,
          0x8000000080008081,0x8000000000008009,0x8a,0x88,0x80008009,0x8000000a,
          0x8000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,
          0x8000000000008002,0x8000000000000080,0x800a,0x800000008000000a,
          0x8000000080008081,0x8000000000008080,0x80000001,0x8000000080008008)
    def rol(x,n):
        return ((x << n) | (x >> ((64-n) % 64))) & mask
    data = bytearray(raw)
    data.append(1)
    data.extend(b'\0' * ((-len(data)) % 136))
    data[-1] |= 128
    a = [0]*25
    for off in range(0,len(data),136):
        for i in range(17):
            a[i] ^= int.from_bytes(data[off+8*i:off+8*i+8], 'little')
        for r in rc:
            c = [a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20] for x in range(5)]
            d = [c[(x-1)%5]^rol(c[(x+1)%5],1) for x in range(5)]
            b = [0]*25
            for x in range(5):
                for y in range(5):
                    a[x+5*y] ^= d[x]
                    b[y+5*((2*x+3*y)%5)] = rol(a[x+5*y],rot[x][y])
            for x in range(5):
                for y in range(5):
                    a[x+5*y] = b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y])
            a[0] ^= r
    return b''.join(v.to_bytes(8,'little') for v in a)[:32]


@functools.lru_cache(maxsize=64)
def selector(signature):
    return '0x' + keccak256(signature.encode()).hex()[:8]


EVENTS = { '0x'+keccak256(sig.encode()).hex(): name for name,sig in (
    ('IncreaseLiquidity','IncreaseLiquidity(uint256,uint128,uint256,uint256)'),
    ('DecreaseLiquidity','DecreaseLiquidity(uint256,uint128,uint256,uint256)'),
    ('Collect','Collect(uint256,address,uint256,uint256)'))}
TRANSFER = '0x'+keccak256(b'Transfer(address,address,uint256)').hex()


def encode_bytes_array(items):
    chunks = []
    for item in items:
        if not isinstance(item,str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',item):
            raise ValueError('invalid bytes')
        data = item[2:]
        chunks.append(word(len(data)//2)+data+'0'*((-len(data))%64))
    offset = 32*len(items)
    offsets = []
    for chunk in chunks:
        offsets.append(word(offset))
        offset += len(chunk)//2
    return '0x'+word(32)+word(len(items))+''.join(offsets)+''.join(chunks)


def decode_bytes_array(value, count):
    if not isinstance(value,str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{64})*',value):
        raise ValueError('invalid dynamic ABI result')
    raw = bytes.fromhex(value[2:])
    def n(offset):
        if offset+32 > len(raw):
            raise ValueError('truncated dynamic ABI result')
        return int.from_bytes(raw[offset:offset+32],'big')
    if n(0)!=32 or n(32)!=count:
        raise ValueError('invalid dynamic ABI header')
    out=[]
    for i in range(count):
        start=64+n(64+i*32)
        length=n(start)
        if length > 4096 or start+32+length > len(raw):
            raise ValueError('invalid dynamic ABI length')
        out.append('0x'+raw[start+32:start+32+length].hex())
    if encode_bytes_array(out) != value.lower():
        raise ValueError('noncanonical dynamic ABI offsets or padding')
    return out


def validate_config(config):
    required={'chain_id','block_numbers','factory','pool','token0','token1','fee','tick_lower','tick_upper',
              'expected_code_sha256','deployment_evidence','standard_token_evidence'}
    optional={'position_manager','token_id','wallet','simulate','max_log_block_span'}
    if not isinstance(config,dict) or not required <= config.keys() or config.keys()-required-optional:
        raise ValueError('missing or unknown request fields')
    cfg=dict(config)
    integer(cfg['chain_id'],1,U256)
    blocks=cfg['block_numbers']
    if not isinstance(blocks,list) or not 1<=len(blocks)<=16:
        raise ValueError('provide 1 to 16 ordered block numbers')
    prev=-1
    for i,b in enumerate(blocks):
        if b=='latest' and i==len(blocks)-1:
            continue
        integer(b,0,2**64-1)
        if b<=prev:
            raise ValueError('block numbers must be strictly increasing')
        prev=b
    roles=set(BASE_ROLES)
    manager=cfg.setdefault('position_manager',None)
    if manager is not None:
        roles.add('position_manager')
    for role in roles:
        cfg[role]=address(cfg[role])
    if int(cfg['token0'],16)>=int(cfg['token1'],16):
        raise ValueError('token0 must sort strictly below token1')
    if len({cfg[x] for x in roles})!=len(roles):
        raise ValueError('contract roles must have distinct addresses')
    integer(cfg['fee'],1,999999)
    integer(cfg['tick_lower'],-887272,887271)
    integer(cfg['tick_upper'],-887271,887272)
    if cfg['tick_lower']>=cfg['tick_upper']:
        raise ValueError('range must have increasing bounds')
    fingerprints=cfg['expected_code_sha256']
    if not isinstance(fingerprints,dict) or set(fingerprints)!=roles:
        raise ValueError('independently sourced expected bytecode hashes required for every contract role')
    for v in fingerprints.values():
        if not isinstance(v,str) or not re.fullmatch(r'[0-9a-fA-F]{64}',v):
            raise ValueError('invalid expected SHA256 fingerprint')
    cfg['expected_code_sha256']={k:v.lower() for k,v in fingerprints.items()}
    for name in ('deployment_evidence','standard_token_evidence'):
        if not isinstance(cfg[name],str) or not cfg[name].strip() or len(cfg[name])>4096:
            raise ValueError('provide bounded independent verification source descriptions')
    token_id=cfg.setdefault('token_id',None)
    if token_id is not None:
        decimal_uint(token_id,positive=True)
        if manager is None:
            raise ValueError('NFT position requires its verified position manager')
    wallet=cfg.setdefault('wallet',None)
    if wallet is not None:
        cfg['wallet']=address(wallet)
    integer(cfg.setdefault('max_log_block_span',100000),1,100000)
    sim=cfg.setdefault('simulate',{})
    if not isinstance(sim,dict) or sim.keys()-{'mint','collect','withdraw'}:
        raise ValueError('unsupported simulation request')
    if sim and (manager is None or wallet is None):
        raise ValueError('simulations require an actual wallet and verified position manager')
    if 'collect' in sim and sim['collect'] is not True:
        raise ValueError('collect must be true when requested')
    if ('collect' in sim or 'withdraw' in sim) and token_id is None:
        raise ValueError('collect and withdraw require a position token_id')
    for name in ('mint','withdraw'):
        if name not in sim:
            continue
        p=sim[name]
        keys={'amount0_min_raw','amount1_min_raw','deadline_seconds'}
        keys |= {'amount0_desired_raw','amount1_desired_raw'} if name=='mint' else {'liquidity'}
        if not isinstance(p,dict) or set(p)!=keys:
            raise ValueError('missing or unknown simulation parameters')
        integer(p['deadline_seconds'],1,3600)
        for key in keys-{'deadline_seconds'}:
            decimal_uint(p[key],128 if key=='liquidity' else 256,positive=(key=='liquidity'))
        if name=='mint':
            if int(p['amount0_desired_raw'])+int(p['amount1_desired_raw'])==0:
                raise ValueError('mint requires a nonzero desired amount')
            if any(int(p['amount%d_min_raw'%i])>int(p['amount%d_desired_raw'%i]) for i in (0,1)):
                raise ValueError('mint minimum exceeds desired amount')
    return cfg


class RpcFailure(Exception):
    def __init__(self,kind,code=None):
        self.kind=kind
        self.code=code if type(code) is int else None
        super().__init__(kind)


class BudgetExceeded(Exception):
    pass


class HttpTransport:
    def __init__(self,url):
        if urllib.parse.urlsplit(url).scheme not in {'http','https'}:
            raise ValueError('RPC URL requires HTTP or HTTPS')
        self.url=url
        self.sequence=0

    def __call__(self,method,params,timeout):
        completed=queue.Queue(maxsize=1)
        def work():
            try:
                completed.put((True,self.request(method,params,timeout)))
            except Exception as error:
                completed.put((False,error))
        threading.Thread(target=work,daemon=True).start()
        try:
            ok,result=completed.get(timeout=timeout)
        except queue.Empty:
            raise RpcFailure('RequestDeadlineExceeded') from None
        if not ok:
            raise result
        return result

    def request(self,method,params,timeout):
        self.sequence+=1
        request_id=self.sequence
        payload={'jsonrpc':'2.0','id':request_id,'method':method,'params':params}
        request=urllib.request.Request(self.url,data=json.dumps(payload,allow_nan=False).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=timeout) as response:
                raw=response.read(MAX_RESPONSE+1)
            if len(raw)>MAX_RESPONSE:
                raise RpcFailure('ResponseTooLarge')
            reply=strict_json(raw)
        except RpcFailure:
            raise
        except (OSError,urllib.error.URLError,ValueError,RecursionError):
            raise RpcFailure('TransportError') from None
        if not isinstance(reply,dict) or reply.get('jsonrpc')!='2.0' or type(reply.get('id')) is not int or reply['id']!=request_id:
            raise RpcFailure('MalformedRpcResponse')
        if ('error' in reply)==('result' in reply):
            raise RpcFailure('MalformedRpcResponse')
        if 'error' in reply:
            error=reply['error']
            raise RpcFailure('RpcError',error.get('code') if isinstance(error,dict) else None)
        return reply['result']


def clean_result(method,value):
    # Discard free-text errors and unneeded response fields which might echo credentials.
    if method=='eth_getBlockByNumber':
        if not isinstance(value,dict) or not fixed_hex(value.get('hash'),32):
            raise ValueError('invalid block header')
        quantity(value.get('number')); quantity(value.get('timestamp'))
        return {k:value[k].lower() for k in ('number','hash','timestamp')}
    if method=='eth_getLogs':
        if not isinstance(value,list) or len(value)>1000:
            raise ValueError('too many or malformed logs')
        out=[]
        for event in value:
            if not isinstance(event,dict) or event.get('removed') is not False:
                raise ValueError('removed or malformed log')
            item={'address':address(event.get('address')),'removed':False}
            topics=event.get('topics')
            if not isinstance(topics,list) or not 1<=len(topics)<=4 or any(not fixed_hex(t,32) for t in topics):
                raise ValueError('invalid log topics')
            item['topics']=[t.lower() for t in topics]
            for k in ('transactionHash','blockHash'):
                if not fixed_hex(event.get(k),32):
                    raise ValueError('invalid log hash')
                item[k]=event[k].lower()
            for k in ('blockNumber','transactionIndex','logIndex'):
                quantity(event.get(k)); item[k]=event[k].lower()
            data=event.get('data')
            if not isinstance(data,str) or len(data)>8194 or re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',data) is None:
                raise ValueError('invalid log data')
            item['data']=data.lower()
            out.append(item)
        return out
    if method=='eth_chainId':
        quantity(value)
    elif not isinstance(value,str) or re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',value) is None:
        raise ValueError('invalid RPC byte data')
    return value.lower()


class Rpc:
    def __init__(self,transport,records,max_calls,max_seconds,clock):
        self.transport,self.records,self.max_calls,self.clock=transport,records,max_calls,clock
        self.deadline=clock()+max_seconds
        self.retained_bytes=0

    def call(self,method,params):
        if method not in ALLOWED:
            raise ValueError('RPC method not allowed')
        remaining=self.deadline-self.clock()
        if remaining<=0 or len(self.records)>=self.max_calls:
            raise BudgetExceeded()
        record={'id':len(self.records)+1,'method':method,'params':params}
        self.records.append(record)
        try:
            result=clean_result(method,self.transport(method,params,min(remaining,20)))
            retained_size=len(json.dumps(result,separators=(',',':')))+len(json.dumps(params,separators=(',',':')))
            if self.retained_bytes+retained_size>MAX_TRANSCRIPT:
                raise RpcFailure('ResponseTooLarge')
            self.retained_bytes+=retained_size
        except RpcFailure as error:
            record['error']={'kind':error.kind,'code':error.code}
            raise
        except Exception:
            record['error']={'kind':'MalformedOrUnavailableRpcData','code':None}
            raise RpcFailure('MalformedOrUnavailableRpcData') from None
        record['result']=result
        return result


def decode_tick(raw):
    a=words(raw,8)
    narrow(a[0],128); signed(a[1],128); signed(a[4],56); narrow(a[5],160); narrow(a[6],32); narrow(a[7],1)
    if bool(a[0])!=bool(a[7]):
        raise ValueError('tick initialization and liquidity disagree')
    if abs(signed(a[1],128))>a[0]:
        raise ValueError('tick net exceeds gross liquidity')
    return {'liquidity_gross':str(a[0]),'liquidity_net':str(signed(a[1],128)),
            'fee_growth_outside0_x128':str(a[2]),'fee_growth_outside1_x128':str(a[3]),
            'tick_cumulative_outside':str(signed(a[4],56)),
            'seconds_per_liquidity_outside_x128':str(a[5]),'seconds_outside':a[6],'initialized':bool(a[7])}


def snapshot(rpc,cfg,number):
    before=rpc.call('eth_getBlockByNumber',[hex(number) if type(number) is int else number,False])
    actual=quantity(before['number'])
    if type(number) is int and actual!=number:
        raise ValueError('BlockNumberMismatch')
    anchor={'blockHash':before['hash'],'requireCanonical':True}
    def call(role,signature,args='',wallet=False):
        tx={'to':cfg[role],'data':selector(signature)+args}
        if wallet:
            tx['from']=cfg['wallet']
            tx['value']='0x0'
        return rpc.call('eth_call',[tx,dict(anchor)])
    code={}
    for role in sorted(cfg['expected_code_sha256']):
        raw=rpc.call('eth_getCode',[cfg[role],dict(anchor)])
        if raw=='0x':
            raise ValueError('EmptyCode:'+role)
        code[role]=hashlib.sha256(bytes.fromhex(raw[2:])).hexdigest()
        if code[role]!=cfg['expected_code_sha256'][role]:
            raise ValueError('CodeFingerprintMismatch:'+role)
    checks=[('pool','factory()',cfg['factory']),('pool','token0()',cfg['token0']),('pool','token1()',cfg['token1'])]
    if cfg['position_manager'] is not None:
        checks.append(('position_manager','factory()',cfg['factory']))
    for role,sig,expected in checks:
        if decode_address(call(role,sig))!=expected:
            raise ValueError('ContractIdentityMismatch')
    args=address_word(cfg['token0'])+address_word(cfg['token1'])+word(cfg['fee'])
    if decode_address(call('factory','getPool(address,address,uint24)',args))!=cfg['pool']:
        raise ValueError('FactoryPoolMismatch')
    fee=narrow(words(call('pool','fee()'),1)[0],24)
    spacing=signed(words(call('pool','tickSpacing()'),1)[0],24)
    if fee!=cfg['fee'] or spacing<=0 or spacing>16384 or any(cfg[t]%spacing for t in ('tick_lower','tick_upper')):
        raise ValueError('PoolFeeOrTickSpacingMismatch')
    if signed(words(call('factory','feeAmountTickSpacing(uint24)',word(fee)),1)[0],24)!=spacing:
        raise ValueError('FactoryTickSpacingMismatch')
    state=words(call('pool','slot0()'),7)
    narrow(state[0],160); tick=signed(state[1],24)
    integer(tick,-887272,887272)
    if not 4295128739<=state[0]<1461446703485210103287273052203988822378723970342:
        raise ValueError('UnsupportedUninitializedOrInvalidPrice')
    from lp_math import sqrt_ratio_at_tick
    if tick>=887272 or not sqrt_ratio_at_tick(tick)<=state[0]<=sqrt_ratio_at_tick(tick+1):
        raise ValueError('TickAndPriceMismatch')
    for i in (2,3,4): narrow(state[i],16)
    narrow(state[5],8); narrow(state[6],1)
    if any(n not in (0,4,5,6,7,8,9,10) for n in (state[5]&15,state[5]>>4)):
        raise ValueError('UnsupportedProtocolFee')
    if state[3]==0 or state[2]>=state[3] or state[4]<state[3] or state[6]!=1:
        raise ValueError('InvalidOrLockedPoolState')
    pool={'address':cfg['pool'],'factory':cfg['factory'],'token0':cfg['token0'],'token1':cfg['token1'],
          'fee':fee,'tick_spacing':spacing,'sqrt_price_x96':str(state[0]),'tick':tick,
          'liquidity':str(narrow(words(call('pool','liquidity()'),1)[0],128)),
          'fee_growth_global0_x128':str(words(call('pool','feeGrowthGlobal0X128()'),1)[0]),
          'fee_growth_global1_x128':str(words(call('pool','feeGrowthGlobal1X128()'),1)[0]),
          'fee_protocol0_denominator':state[5]&15,'fee_protocol1_denominator':state[5]>>4}
    tokens=[{'address':cfg['token%d'%i],'decimals':narrow(words(call('token%d'%i,'decimals()'),1)[0],8)} for i in (0,1)]
    range_state={'tick_lower':cfg['tick_lower'],'tick_upper':cfg['tick_upper']}
    for name in ('lower','upper'):
        range_state[name]=decode_tick(call('pool','ticks(int24)',signed_word(cfg['tick_'+name])))
    position=None
    if cfg['token_id'] is not None:
        a=words(call('position_manager','positions(uint256)',word(int(cfg['token_id']))),12)
        narrow(a[0],96); narrow(a[1],160); narrow(a[4],24); narrow(a[7],128); narrow(a[10],128); narrow(a[11],128)
        p0='0x%040x'%narrow(a[2],160); p1='0x%040x'%narrow(a[3],160)
        lower=signed(a[5],24); upper=signed(a[6],24)
        if (p0,p1,a[4],lower,upper)!=(cfg['token0'],cfg['token1'],fee,cfg['tick_lower'],cfg['tick_upper']):
            raise ValueError('NFTPositionIdentityMismatch')
        owner=decode_address(call('position_manager','ownerOf(uint256)',word(int(cfg['token_id']))))
        address(owner)
        position={'token_id':cfg['token_id'],'nonce':str(a[0]),'operator':'0x%040x'%a[1],
                  'token0':p0,'token1':p1,'fee':fee,'tick_lower':lower,'tick_upper':upper,'liquidity':str(a[7]),
                  'fee_growth_inside0_last_x128':str(a[8]),'fee_growth_inside1_last_x128':str(a[9]),
                  'tokens_owed0':str(a[10]),'tokens_owed1':str(a[11]),'owner':owner}
        if a[7]>min(int(range_state[n]['liquidity_gross']) for n in ('lower','upper')):
            raise ValueError('NFTLiquidityExceedsBoundaryGross')
        if lower<=tick<upper and a[7]>int(pool['liquidity']):
            raise ValueError('NFTLiquidityExceedsActivePoolLiquidity')
    result={'block':{'number':actual,'hash':before['hash'],'timestamp':quantity(before['timestamp'])},
            'code_sha256':code,'pool':pool,'tokens':tokens,'range':range_state,'position':position,
            'wallet_state':None,'simulations':{name:{'status':'not_requested'} for name in ('mint','collect','withdraw')}}
    simulate(rpc,cfg,result,anchor,call)
    after=rpc.call('eth_getBlockByNumber',[hex(actual),False])
    if after!=before:
        raise ValueError('BlockAnchorChanged')
    result['block']['after_hash']=after['hash']
    return result


def simulate(rpc,cfg,result,anchor,call):
    sim=cfg['simulate']
    if not sim:
        return
    wallet=cfg['wallet']
    manager=cfg['position_manager']
    wallet_state={'address':wallet,'tokens':[]}
    result['wallet_state']=wallet_state
    if 'mint' in sim:
        for i in (0,1):
            wallet_state['tokens'].append({'address':cfg['token%d'%i],
                'balance_raw':str(words(call('token%d'%i,'balanceOf(address)',address_word(wallet)),1)[0]),
                'allowance_raw':str(words(call('token%d'%i,'allowance(address,address)',address_word(wallet)+address_word(manager)),1)[0])})
    def attempt(name,data,counts):
        tx={'to':manager,'from':wallet,'value':'0x0','data':data}
        state={'status':'unavailable','call_record_id':len(rpc.records)+1,'result_raw':None}
        result['simulations'][name]=state
        try:
            raw=rpc.call('eth_call',[tx,dict(anchor)])
        except RpcFailure as error:
            state.update(status='rpc_error' if error.kind=='RpcError' else 'unavailable',error_kind=error.kind,error_code=error.code)
            return
        decoded=decode_bytes_array(raw,2) if name=='withdraw' else [raw]
        values=[words(v,count) for v,count in zip(decoded,counts)]
        if name=='mint':
            narrow(values[0][1],128)
            if values[0][1]==0 or any(values[0][i+2]>int(sim[name]['amount%d_desired_raw'%i]) or values[0][i+2]<int(sim[name]['amount%d_min_raw'%i]) for i in (0,1)):
                raise ValueError('InconsistentMintReturn')
            if any(values[0][i+2]>int(wallet_state['tokens'][i][k]) for i in (0,1) for k in ('balance_raw','allowance_raw')):
                raise ValueError('MintReturnExceedsWalletPrerequisites')
        else:
            for v in values[-1]:
                narrow(v,128)
            if name=='withdraw' and any(values[0][i]<int(sim[name]['amount%d_min_raw'%i]) for i in (0,1)):
                raise ValueError('InconsistentWithdrawalReturn')
        state.update(status='call_succeeded',result_raw=[[str(v) for v in row] for row in values])
        state['meaning']='Read-only wallet eth_call returned ABI data; no transaction, wallet delta, gas estimate, future success, or profit proof.'
    if 'mint' in sim:
        p=sim['mint']
        missing=[i for i in (0,1) if any(int(wallet_state['tokens'][i][k])<int(p['amount%d_desired_raw'%i]) for k in ('balance_raw','allowance_raw'))]
        # Desired inputs are caps, not amounts necessarily owed. An out-of-range
        # mint can consume only one asset. The wallet call decides prerequisites.
        args=address_word(cfg['token0'])+address_word(cfg['token1'])+word(cfg['fee'])+signed_word(cfg['tick_lower'])+signed_word(cfg['tick_upper'])
        args+=''.join(word(int(p[k])) for k in ('amount0_desired_raw','amount1_desired_raw','amount0_min_raw','amount1_min_raw'))
        args+=address_word(wallet)+word(result['block']['timestamp']+p['deadline_seconds'])
        attempt('mint',selector('mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))')+args,[4])
        result['simulations']['mint']['desired_cap_shortfall_token_indices']=missing
    if 'collect' in sim or 'withdraw' in sim:
        position=result['position']
        if position['owner']!=wallet:
            for name in ('collect','withdraw'):
                if name in sim:
                    result['simulations'][name]={'status':'missing_prerequisites','reason':'native simulation requires wallet to own the NFT; approved operators are not evaluated'}
            return
        collect_data=selector('collect((uint256,address,uint128,uint128))')+word(int(cfg['token_id']))+address_word(wallet)+word(U128)+word(U128)
        if 'collect' in sim:
            attempt('collect',collect_data,[2])
        if 'withdraw' in sim:
            p=sim['withdraw']
            if int(p['liquidity'])>int(position['liquidity']):
                result['simulations']['withdraw']={'status':'missing_prerequisites','reason':'requested removal exceeds NFT liquidity'}
            else:
                args=word(int(cfg['token_id']))+word(int(p['liquidity']))+word(int(p['amount0_min_raw']))+word(int(p['amount1_min_raw']))+word(result['block']['timestamp']+p['deadline_seconds'])
                decrease=selector('decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))')+args
                data=selector('multicall(bytes[])')+encode_bytes_array([decrease,collect_data])[2:]
                attempt('withdraw',data,[2,2])


def interval(rpc,cfg,start,end):
    first,last=start['block']['number'],end['block']['number']
    out={'start_block':first,'end_block':last,'status':'not_requested','events':[],
         'coverage':'two_bounded_eth_getLogs_requests','provider_completeness_unverified':True}
    if cfg['token_id'] is None:
        return out
    if last-first>cfg['max_log_block_span']:
        out['status']='unavailable'; out['reason']='block span exceeds configured bound'
        return out
    params={'address':cfg['position_manager'],'fromBlock':hex(first+1),'toBlock':hex(last),
            'topics':[list(EVENTS),'0x'+word(int(cfg['token_id']))]}
    transfers={**params,'topics':[TRANSFER,None,None,params['topics'][1]]}
    try:
        events=rpc.call('eth_getLogs',[params])
        transfer_events=rpc.call('eth_getLogs',[transfers])
    except RpcFailure as error:
        out.update(status='unavailable',reason=error.kind)
        return out
    if any(e['topics'][0] not in EVENTS for e in events) or any(e['topics'][0]!=TRANSFER for e in transfer_events):
        raise ValueError('PositionLogDoesNotMatchRequestedTopic')
    for group in (events,transfer_events):
        group_order=[(quantity(e['blockNumber']),quantity(e['transactionIndex']),quantity(e['logIndex'])) for e in group]
        if group_order!=sorted(group_order):
            raise ValueError('NoncanonicalPositionLogOrder')
    seen=set()
    order=[]
    for event in events+transfer_events:
        height=quantity(event['blockNumber'])
        topics=event['topics']
        is_transfer=topics[0]==TRANSFER
        topic_match=(len(topics)==4 and topics[3]==params['topics'][1]) if is_transfer else (len(topics)==2 and topics[0] in EVENTS and topics[1]==params['topics'][1])
        if event['address']!=cfg['position_manager'] or not topic_match or not first<height<=last:
            raise ValueError('UnexpectedPositionLog')
        ident=(event['transactionHash'],event['logIndex'])
        if ident in seen:
            raise ValueError('DuplicatePositionLog')
        seen.add(ident)
        order.append((height,quantity(event['transactionIndex']),quantity(event['logIndex'])))
        if is_transfer:
            words(event['data'],0)
            for t in topics[1:3]:
                narrow(int(t,16),160)
        else:
            a=words(event['data'],3)
            narrow(a[0],160 if EVENTS[topics[0]]=='Collect' else 128)
        out['events'].append({'event':'Transfer' if is_transfer else EVENTS[topics[0]],**event})
    if len(set(order))!=len(order):
        raise ValueError('NoncanonicalPositionLogOrder')
    # Separate event queries may interleave; normalize together by canonical event order.
    out['events'].sort(key=lambda e:(quantity(e['blockNumber']),quantity(e['transactionIndex']),quantity(e['logIndex'])))
    out['status']='position_events_present' if out['events'] else 'provider_returned_no_events'
    # Numeric-range logs have weaker anchoring than EIP-1898 state reads.
    for snap in (start,end):
        header=rpc.call('eth_getBlockByNumber',[hex(snap['block']['number']),False])
        if (header['hash'],quantity(header['number']),quantity(header['timestamp']))!=(snap['block']['hash'],snap['block']['number'],snap['block']['timestamp']):
            raise ValueError('IntervalBlockAnchorChanged')
    return out


def collect(transport,config,source_kind='live_rpc',max_calls=1000,max_seconds=300,clock=time.monotonic):
    cfg=validate_config(config)
    if source_kind not in {'live_rpc','synthetic'}:
        raise ValueError('invalid source_kind')
    integer(max_calls,3,1000)
    if type(max_seconds) not in (int,float) or not math.isfinite(max_seconds) or not 0<max_seconds<=3600:
        raise ValueError('invalid time budget')
    packet={'schema':SCHEMA,'source_kind':source_kind,'request':cfg,'status':'incomplete','chain_id':cfg['chain_id'],
            'snapshots':[],'interval_activity':[],'records':[],'diagnostics':[],
            'captured_at_utc':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z')}
    rpc=Rpc(transport,packet['records'],max_calls,max_seconds,clock)
    try:
        if quantity(rpc.call('eth_chainId',[]))!=cfg['chain_id']:
            raise ValueError('ChainIdMismatch')
        for number in cfg['block_numbers']:
            snap=snapshot(rpc,cfg,number)
            if packet['snapshots'] and snap['block']['number']<=packet['snapshots'][-1]['block']['number']:
                raise ValueError('ResolvedBlocksNotStrictlyIncreasing')
            packet['snapshots'].append(snap)
        for start,end in zip(packet['snapshots'],packet['snapshots'][1:]):
            packet['interval_activity'].append(interval(rpc,cfg,start,end))
        packet['status']='complete'
    except BudgetExceeded:
        packet['diagnostics'].append({'kind':'BudgetExceeded'})
    except RpcFailure as error:
        packet['diagnostics'].append({'kind':error.kind,'code':error.code})
    except ValueError as error:
        packet['status']='invalid'
        packet['diagnostics'].append({'kind':'InvalidStateOrIdentity','detail':str(error)})
    return packet


def verify_evidence(packet):
    """Re-derive a complete packet from every retained RPC input/result.

    Establishes internal consistency, never provider honesty or independent chain truth.
    Complete state collection may still contain failed calls/unavailable activity coverage.
    """
    expected={'schema','source_kind','request','status','chain_id','snapshots','interval_activity','records','diagnostics','captured_at_utc'}
    if not isinstance(packet,dict) or set(packet)!=expected or packet['schema']!=SCHEMA or packet['status']!='complete':
        raise ValueError('complete canonical V3 evidence required')
    timestamp=packet['captured_at_utc']
    if not isinstance(timestamp,str) or len(timestamp)>64:
        raise ValueError('invalid capture timestamp')
    parsed=dt.datetime.fromisoformat(timestamp.replace('Z','+00:00'))
    if parsed.utcoffset()!=dt.timedelta(0):
        raise ValueError('capture timestamp must have explicit UTC timezone')
    records=packet['records']
    if not isinstance(records,list) or not 1<=len(records)<=1000:
        raise ValueError('invalid retained RPC transcript size')
    index=0
    def replay(method,params,timeout):
        nonlocal index
        if index>=len(records):
            raise ValueError('transcript exhausted')
        record=records[index]
        index+=1
        if not isinstance(record,dict) or set(record) not in ({'id','method','params','result'},{'id','method','params','error'}):
            raise ValueError('invalid retained RPC record')
        if record['id']!=index or type(record['id']) is not int or record['method']!=method or canonical(record['params'])!=canonical(params):
            raise ValueError('RPC request binding mismatch')
        if 'error' in record:
            err=record['error']
            if not isinstance(err,dict) or set(err)!={'kind','code'} or err['kind'] not in {'RpcError','TransportError','ResponseTooLarge','RequestDeadlineExceeded','MalformedRpcResponse','MalformedOrUnavailableRpcData'} or (err['code'] is not None and type(err['code']) is not int):
                raise ValueError('invalid sanitized RPC error')
            raise RpcFailure(err['kind'],err['code'])
        return record['result']
    rebuilt=collect(replay,packet['request'],packet['source_kind'],1000,3600,clock=lambda:0)
    if index!=len(records):
        raise ValueError('unused or truncated RPC records')
    for key in expected-{'captured_at_utc'}:
        if canonical(packet[key])!=canonical(rebuilt[key]):
            raise ValueError('evidence normalization binding mismatch: '+key)
    return True


def read_json(path):
    with Path(path).open('rb') as stream:
        raw=stream.read(MAX_INPUT+1)
    if len(raw)>MAX_INPUT:
        raise ValueError('input exceeds 32 MiB')
    return strict_json(raw)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    modes=parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--config')
    modes.add_argument('--verify')
    parser.add_argument('--rpc-env',default='LP_EDGE_RPC_URL')
    parser.add_argument('--out')
    parser.add_argument('--max-calls',type=int,default=1000)
    parser.add_argument('--max-seconds',type=float,default=300)
    args=parser.parse_args()
    try:
        if args.verify:
            verify_evidence(read_json(args.verify))
            print('Retained RPC transcript and normalized evidence reconcile; provider authenticity is not established.')
            return 0
        if not args.out:
            raise ValueError('--out required for collection')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',args.rpc_env):
            raise ValueError('invalid RPC environment variable name')
        url=os.environ.get(args.rpc_env)
        if not url:
            raise ValueError('RPC environment variable unavailable')
        packet=collect(HttpTransport(url),read_json(args.config),max_calls=args.max_calls,max_seconds=args.max_seconds)
        if packet['status']=='complete':
            verify_evidence(packet)
        with Path(args.out).open('x',encoding='utf-8') as stream:
            json.dump(packet,stream,indent=2,sort_keys=True,allow_nan=False)
            stream.write('\n')
        print('Evidence saved with status: '+packet['status'])
        return 0 if packet['status']=='complete' else 2
    except (ValueError,OSError,RecursionError):
        # Do not print endpoint, user file paths, arbitrary provider messages or input values.
        print('LP Edge request failed validation, reconciliation, file access, or configuration; no transaction was submitted.')
        return 2


if __name__=='__main__':
    raise SystemExit(main())
