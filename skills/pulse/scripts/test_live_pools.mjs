/** Synthetic arrival sequences for the provisional cache. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {LivePoolCache} from './live_pools.mjs';
import {MANAGER,TOPICS,poolId,abiWord} from './pools.mjs';
const h=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),a=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const data=(...a)=>'0x'+Buffer.concat(a.map(abiWord)).toString('hex');
function pool(n=1,hooks=0){const p={currency0:a(n),currency1:a(n+1),fee:3000,tick_spacing:60,hooks:a(hooks),decimals0:18,decimals1:6};return {...p,pool_id:poolId(p)};}
function registry(p=pool()){return {chain_id:4663,manager:MANAGER,pools:[p],routes:[{id:'route',pool_ids:[p.pool_id]}]};}
function obs(stage,payload,extra={}){return {schema_version:'pulse.observation.v1',chain_id:4663,source:'primary',stage,delivery:'live',event_id:`${stage}:${payload.blockHash??payload.hash}:${payload.logIndex??''}`,
  observed_at:'2026-09-09T00:00:00.000Z',payload,...extra};}
function head(n=10,hash=h(n),parent=h(n-1)){return obs('head',{number:'0x'+n.toString(16),hash,parentHash:parent,timestamp:'0x'+(1000+n).toString(16)});}
function log(p=pool(),type='Swap',{n=10,hash=h(n),index=0,tx=100,txindex=0,sqrt=1n<<96n,delta=100}={}){
  const topics=type==='Initialize'?[TOPICS.Initialize,p.pool_id,h(BigInt(p.currency0)),h(BigInt(p.currency1))]:[TOPICS[type],p.pool_id,h(99)];
  return obs('log',{address:MANAGER,topics,data:type==='Initialize'?data(p.fee,p.tick_spacing,p.hooks,sqrt,0):type==='Swap'?data(100,-100,sqrt,1000,0,3000):data(-60,60,delta,0),
    blockNumber:'0x'+n.toString(16),blockHash:hash,transactionHash:h(tx),transactionIndex:'0x'+txindex.toString(16),logIndex:'0x'+index.toString(16),removed:false});
}
function state(cache){return cache.snapshot().pools[0];}

test('Immediate swap updates exact cache before canonical block reconciliation',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));const change=cache.applyObservation(log(p));
  assert.equal(change.status,'OBSERVED');assert.equal(change.updated,true);assert.deepEqual(change.dirty_route_ids,['route']);
  assert.equal(state(cache).qualification,'PROVISIONAL_UNRECONCILED');assert.equal(state(cache).canonicality,'UNKNOWN');assert.equal(state(cache).coverage,'UNKNOWN');
  assert.equal(state(cache).execution_eligible,false);assert.deepEqual(state(cache).price_ratios.currency1_per_currency0,{numerator:'1000000000000',denominator:'1'});
});
test('Head-before-log and log-before-head are both ordinary subscription orderings',()=>{
  const p=pool();for(const arrivals of [[head(),log(p)],[log(p),head()]]){const cache=new LivePoolCache(registry(p));for(const x of arrivals)assert.notEqual(cache.applyObservation(x).status,'INVALIDATED');}
  const cache=new LivePoolCache(registry(p));cache.applyObservation(head(10));cache.applyObservation(head(11));assert.equal(cache.applyObservation(log(p)).status,'OBSERVED');
});
test('Exact duplicate log is idempotent',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p)),x=log(p);cache.applyObservation(x);const before=cache.snapshot();x.observed_at='2026-09-09T00:00:01.000Z';
  assert.equal(cache.applyObservation(x).status,'DUPLICATE');assert.deepEqual(cache.snapshot(),before);
});
test('Conflicting block-global slot invalidates all provisional routes',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p));const result=cache.applyObservation(log(p,'Swap',{sqrt:2n<<96n}));
  assert.equal(result.status,'INVALIDATED');assert.deepEqual(result.invalidated_route_ids,['route']);assert.equal(state(cache).provisional_status,'INVALIDATED');
});
test('Reordered log positions and earlier blocks invalidate',()=>{
  const p=pool();for(const pair of [[log(p,'Swap',{index:2}),log(p,'Swap',{index:1})],[log(p,'Swap',{n:11}),log(p,'Swap',{n:10})]]){
    const cache=new LivePoolCache(registry(p));cache.applyObservation(pair[0]);assert.equal(cache.applyObservation(pair[1]).status,'INVALIDATED');
  }
});
test('Different source cannot mutate selected primary cache',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p));const before=cache.snapshot(),x=log(p,'Swap',{sqrt:2n<<96n});x.source='secondary';
  assert.equal(cache.applyObservation(x).status,'IGNORED');assert.deepEqual(cache.snapshot(),before);
});
test('Backfill and replay never become fresh live state',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));for(const delivery of ['backfill','replay']){const x=log(p);x.delivery=delivery;assert.equal(cache.applyObservation(x).status,'IGNORED');}
  assert.equal(state(cache).provisional_status,'UNOBSERVED');assert.equal(cache.snapshot().source,null);
});
test('Same-height live reorg hint invalidates previous observations',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(head());cache.applyObservation(log(p));const result=cache.applyObservation(head(10,h(110),h(9)));
  assert.equal(result.status,'INVALIDATED');assert.equal(result.head.hash,h(110));assert.equal(state(cache).requires_reanchor,true);
});
test('Parent mismatch and missing head invalidate',()=>{
  for(const next of [head(11,h(11),h(999)),head(12)]){const cache=new LivePoolCache(registry());cache.applyObservation(head());assert.equal(cache.applyObservation(next).status,'INVALIDATED');}
});
test('Removed log invalidates without becoming a state update',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p));const x=log(p);x.payload.removed=true;const change=cache.applyObservation(x);
  assert.equal(change.status,'INVALIDATED');assert.equal(change.updated,false);assert.equal(state(cache).provisional_status,'INVALIDATED');
});
test('ModifyLiquidity invalidates active liquidity and subsequent swap remains provisional',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p));cache.applyObservation(log(p,'ModifyLiquidity',{index:1}));assert.equal(state(cache).active_liquidity_raw,null);
  cache.applyObservation(log(p,'Swap',{index:2}));assert.equal(state(cache).active_liquidity_raw,'1000');assert.equal(state(cache).qualification,'PROVISIONAL_UNRECONCILED');assert.equal(state(cache).execution_eligible,false);
});
test('Unknown hooks remain unqualified and sender never becomes trader',()=>{
  const p=pool(1,128),cache=new LivePoolCache(registry(p)),change=cache.applyObservation(log(p));
  assert.equal(state(cache).hook_status,'UNKNOWN_HOOK_UNQUALIFIED');assert.equal(change.events[0].trader,null);assert.equal(change.events[0].sender,a(99));
});
test('Initialize plus swap still cannot claim coverage or canonicality',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p,'Initialize'));cache.applyObservation(log(p,'Swap',{index:1}));
  assert.equal(state(cache).identity_status,'LIVE_INITIALIZE_MATCH_UNRECONCILED');assert.equal(state(cache).qualification,'PROVISIONAL_UNRECONCILED');assert.equal(state(cache).coverage,'UNKNOWN');
});
test('Malformed ABI and conflicting envelope context invalidate',()=>{
  const p=pool();for(const mutate of [x=>x.payload.data=data((1n<<128n)-1n,-100,1n<<96n,1000,0,3000),x=>x.block_hash=h(999),x=>delete x.payload.removed]){
    const cache=new LivePoolCache(registry(p)),x=log(p);mutate(x);assert.equal(cache.applyObservation(x).status,'INVALIDATED');
  }
});
test('Block retention and per-block slot count are bounded',()=>{
  const cache=new LivePoolCache(registry(),{max_blocks:3});for(let n=10;n<15;n++)cache.applyObservation(head(n));assert.equal(cache.snapshot().retained_blocks,3);
  const p=pool(),limited=new LivePoolCache(registry(p),{max_logs_per_block:1});limited.applyObservation(log(p));assert.equal(limited.applyObservation(log(p,'Swap',{index:1})).status,'INVALIDATED');
});
test('Unknown pools do not dirty configured pool routes',()=>{
  const cache=new LivePoolCache(registry()),result=cache.applyObservation(log(pool(3)));assert.equal(result.status,'IGNORED');assert.deepEqual(result.dirty_route_ids,[]);
});
test('Invalidation preserves old values as historical and fresh swap stays provisional',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p));cache.invalidate('disconnect');assert.equal(state(cache).sqrt_price_x96,(1n<<96n).toString());
  assert.equal(state(cache).provisional_status,'INVALIDATED');cache.applyObservation(log(p,'Swap',{n:11}));assert.equal(state(cache).provisional_status,'OBSERVED_PARTIAL_STREAM');assert.equal(state(cache).execution_eligible,false);
});
test('Snapshot modification does not alter cached state',()=>{
  const cache=new LivePoolCache(registry());cache.applyObservation(log());const s=cache.snapshot();s.pools[0].execution_eligible=true;assert.equal(state(cache).execution_eligible,false);
});

test('Reorg invalidation discards potentially orphaned live Initialize identity',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(head());cache.applyObservation(log(p,'Initialize'));
  cache.applyObservation(head(10,h(110),h(9)));assert.equal(state(cache).identity_status,'REGISTRY_UNPROVEN');
  assert.equal(cache.applyObservation(log(p,'Swap',{n:10,hash:h(110)})).status,'OBSERVED');assert.equal(state(cache).execution_eligible,false);
});

test('Adjacent parent conflict is detected when a log arrives before the first head',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(log(p));
  const result=cache.applyObservation(head(11,h(111),h(999)));
  assert.equal(result.status,'INVALIDATED');assert.equal(state(cache).provisional_status,'INVALIDATED');
});
test('Adjacent child parent conflict is detected when a head arrives before the older log',()=>{
  const p=pool(),cache=new LivePoolCache(registry(p));cache.applyObservation(head(11,h(111),h(999)));
  assert.equal(cache.applyObservation(log(p)).status,'INVALIDATED');
});
