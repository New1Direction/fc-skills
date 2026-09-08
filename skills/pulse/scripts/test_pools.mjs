/** Synthetic protocol fixtures; these are not retained mainnet observations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccakHex} from './keccak.mjs';
import {PoolEngine,MANAGER,TOPICS,ZERO,poolId,abiWord,priceRatios,validHookAddress,decodeLog} from './pools.mjs';
const h=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const a=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const data=(...args)=>'0x'+Buffer.concat(args.map(abiWord)).toString('hex');
function pool(n=1,hook=0){const p={currency0:a(n),currency1:a(n+1),fee:3000,tick_spacing:60,hooks:a(hook),decimals0:18,decimals1:6};return {...p,pool_id:poolId(p)};}
function log(p,type,{number=10,hash=h(number),index=0,tx=100,txindex=0,sqrt=1n<<96n,liquidity=1000,delta=10,lower=-60,upper=60}={}){
  const topics=type==='Initialize'?[TOPICS.Initialize,p.pool_id,h(BigInt(p.currency0)),h(BigInt(p.currency1))]:[TOPICS[type],p.pool_id,h(99)];
  const abi=type==='Initialize'?data(p.fee,p.tick_spacing,p.hooks,sqrt,0):type==='Swap'?data(10n**18n,-1000000,sqrt,liquidity,0,3000):data(lower,upper,delta,0);
  return {address:MANAGER,topics,data:abi,blockNumber:'0x'+number.toString(16),blockHash:hash,transactionHash:h(tx),transactionIndex:'0x'+txindex.toString(16),logIndex:'0x'+index.toString(16),removed:false};
}
function block(number,logs=[],hash=h(number),parent=h(number-1),coverage='provider_reported_complete'){
  return {number,hash,parent_hash:parent,timestamp:1000+number,observed_at:'2026-09-09T00:00:00.000Z',coverage,logs};
}
function registry(pools=[pool()]){return {chain_id:4663,manager:MANAGER,pools,routes:pools.map((p,i)=>({id:'route'+i,pool_ids:[p.pool_id]}))};}
function ready(){const p=pool(),engine=new PoolEngine(registry([p]));engine.applyBlock(block(10,[log(p,'Initialize'),log(p,'Swap',{index:1})]));return {p,engine};}
function last(engine){return engine.snapshot().pools[0];}

test('Keccak independent published vectors and protocol topics',()=>{
  assert.equal(keccakHex(Buffer.from('')),'0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex(Buffer.from('abc')),'0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccakHex(Buffer.from('Transfer(address,address,uint256)')),'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  assert.equal(TOPICS.Swap,'0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f');
  assert.equal(TOPICS.Initialize,'0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438');
});
test('Initialize plus Swap records exact core state and does not infer wallet/reserves',()=>{
  const {engine}=ready(),s=last(engine);
  assert.equal(s.qualification,'CORE_STATE_OBSERVED');assert.equal(s.identity_status,'OBSERVED_INITIALIZE_MATCH');
  assert.equal(s.active_liquidity_raw,'1000');assert.equal(s.trader,null);assert.equal(s.pool_inventory,null);assert.equal(s.executable_proceeds,null);
  assert.deepEqual(s.price_ratios.currency1_per_currency0,{numerator:'1000000000000',denominator:'1'});
});
test('Supplied registry alone never qualifies identity',()=>{
  const p=pool(),engine=new PoolEngine(registry([p]));engine.applyBlock(block(10,[log(p,'Swap')]));
  assert.equal(last(engine).qualification,'IDENTITY_UNQUALIFIED');
});
test('Retained matching Initialize has explicit evidence status',()=>{
  const p=pool();p.identity_evidence={kind:'initialize_log',source:'SYNTHETIC retained receipt',log:log(p,'Initialize',{number:9})};
  const engine=new PoolEngine(registry([p]));engine.applyBlock(block(10,[log(p,'Swap')]));
  assert.equal(last(engine).identity_status,'RETAINED_INITIALIZE_MATCH');assert.equal(last(engine).qualification,'CORE_STATE_OBSERVED');
  assert.equal(last(engine).decimals_status,'SUPPLIED_NOT_RPC_VERIFIED');
});
test('Nonzero hooks remain core-mark only even with valid identity',()=>{
  const p=pool(1,128),engine=new PoolEngine(registry([p]));engine.applyBlock(block(10,[log(p,'Initialize'),log(p,'Swap',{index:1})]));
  assert.equal(last(engine).qualification,'CORE_MARK_ONLY_HOOK_UNQUALIFIED');assert.equal(last(engine).hook_status,'UNKNOWN_HOOK_UNQUALIFIED');
});
test('Hook-key validity rejects orphan delta permissions and empty dynamic hook',()=>{
  assert.equal(validHookAddress(ZERO,0x800000),false);assert.equal(validHookAddress(a(16384),3000),false);
  for(const bits of [1,2,4,8])assert.equal(validHookAddress(a(bits),3000),false);
  for(const bits of [257,1026,68,136])assert.equal(validHookAddress(a(bits),3000),true);
  assert.equal(validHookAddress(a(16384),0x800000),true);
});
test('ModifyLiquidity invalidates active liquidity until subsequent Swap',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11,[log(p,'ModifyLiquidity',{number:11})]));
  assert.equal(last(engine).active_liquidity_raw,null);assert.equal(last(engine).qualification,'CORE_MARK_ONLY_LIQUIDITY_UNKNOWN');
  engine.applyBlock(block(12,[log(p,'Swap',{number:12,liquidity:4000})]));assert.equal(last(engine).active_liquidity_raw,'4000');assert.equal(last(engine).qualification,'CORE_STATE_OBSERVED');
});
test('Swap then ModifyLiquidity in same block leaves liquidity unqualified',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11,[log(p,'Swap',{number:11}),log(p,'ModifyLiquidity',{number:11,index:1})]));
  assert.equal(last(engine).active_liquidity_raw,null);
});
test('Zero liquidity change keeps observed active liquidity',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11,[log(p,'ModifyLiquidity',{number:11,delta:0})]));assert.equal(last(engine).active_liquidity_raw,'1000');
});
test('Only affected pools and their dependent routes are dirty',()=>{
  const p=pool(),q=pool(3),r=registry([p,q]);r.routes.push({id:'both',pool_ids:[p.pool_id,q.pool_id]});const engine=new PoolEngine(r);
  const result=engine.applyBlock(block(10,[log(p,'Swap')]));assert.deepEqual(result.affected_pool_ids,[p.pool_id]);assert.deepEqual(result.dirty_route_ids,['both','route0']);
});
test('Duplicate block is idempotent across observation-time changes',()=>{
  const p=pool(),engine=new PoolEngine(registry([p])),b=block(10,[log(p,'Swap')]);engine.applyBlock(b);const before=engine.snapshot();
  b.observed_at='2026-09-09T00:00:01.000Z';const result=engine.applyBlock(b);assert.equal(result.status,'DUPLICATE');assert.deepEqual(engine.snapshot(),before);assert.deepEqual(result.dirty_route_ids,[]);
});
test('Conflicting same hash invalidates cached state and candidates',()=>{
  const {p,engine}=ready();const result=engine.applyBlock(block(10,[log(p,'Swap',{sqrt:2n<<96n})]));
  assert.equal(result.status,'CONFLICT');assert.deepEqual(result.invalidated_route_ids,['route0']);assert.equal(last(engine).qualification,'STATE_INVALIDATED');
});
test('Forward gap does not advance head and complete replay can reanchor pool',()=>{
  const {p,engine}=ready();assert.equal(engine.applyBlock(block(12)).status,'GAP');assert.equal(engine.snapshot().head.number,'10');
  assert.equal(last(engine).qualification,'STATE_INVALIDATED');engine.applyBlock(block(11,[log(p,'Swap',{number:11})]));engine.applyBlock(block(12));
  assert.equal(last(engine).qualification,'CORE_STATE_OBSERVED');assert.equal(engine.snapshot().head.number,'12');
});
test('Public invalidate preserves historical values but disqualifies all current state',()=>{
  const {engine}=ready(),old=last(engine).sqrt_price_x96,result=engine.invalidate('primary disconnected');
  assert.equal(result.status,'INVALIDATED');assert.equal(last(engine).sqrt_price_x96,old);assert.equal(last(engine).requires_reanchor,true);assert.equal(last(engine).qualification,'STATE_INVALIDATED');
});
test('Partial block cannot advance head; complete retry succeeds',()=>{
  const {p,engine}=ready(),b=block(11,[log(p,'Swap',{number:11})],h(11),h(10),'partial');
  assert.equal(engine.applyBlock(b).status,'PARTIAL');assert.equal(engine.snapshot().head.number,'10');
  b.coverage='provider_reported_complete';assert.equal(engine.applyBlock(b).status,'APPLIED');assert.equal(last(engine).qualification,'CORE_STATE_OBSERVED');
});
test('Known-parent reorg rolls back removed branch state and invalidates all routes',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11,[log(p,'Swap',{number:11,sqrt:2n<<96n})]));engine.applyBlock(block(12,[log(p,'Swap',{number:12,sqrt:3n<<96n})]));
  const result=engine.applyBlock(block(11,[],h(111),h(10)));assert.equal(result.continuity,'REORG_ROLLED_BACK');
  assert.equal(last(engine).sqrt_price_x96,(1n<<96n).toString());assert.deepEqual(result.invalidated_route_ids,['route0']);assert.equal(engine.snapshot().head.hash,h(111));
});
test('Reorg orphaning retained Initialize removes its identity qualification',()=>{
  const p=pool();p.identity_evidence={kind:'initialize_log',source:'SYNTHETIC',log:log(p,'Initialize',{number:10})};const engine=new PoolEngine(registry([p]));
  engine.applyBlock(block(9));engine.applyBlock(block(10,[log(p,'Initialize')]));engine.applyBlock(block(11,[log(p,'Swap',{number:11})]));
  engine.applyBlock(block(10,[],h(110),h(9)));engine.applyBlock(block(11,[log(p,'Swap',{number:11,hash:h(111)})],h(111),h(110)));
  assert.equal(last(engine).identity_status,'REGISTRY_UNPROVEN');assert.equal(last(engine).qualification,'IDENTITY_UNQUALIFIED');
});
test('Reorg older than bounded history requires rebuild',()=>{
  const p=pool(),engine=new PoolEngine(registry([p]),{max_history:2});for(const n of [10,11,12])engine.applyBlock(block(n));
  assert.equal(engine.snapshot().retained_blocks,2);assert.equal(engine.applyBlock(block(10,[],h(110),h(9))).status,'REORG_UNRESOLVED');
});
test('Pool key hash, chain, currency sorting, decimals and unknown routes are strict',()=>{
  assert.throws(()=>new PoolEngine({...registry(),chain_id:'4663'}));assert.throws(()=>new PoolEngine({...registry(),manager:a(9)}));
  const p=pool();p.currency1=a(3);assert.throws(()=>new PoolEngine(registry([p])),/hash/);
  const q=pool();q.decimals0=true;assert.throws(()=>new PoolEngine(registry([q])),/decimals/);
  const r=registry();r.routes[0].pool_ids=[h(999)];assert.throws(()=>new PoolEngine(r),/unknown pool/);
});
test('Exact decimal ratios preserve large integers and invert without float loss',()=>{
  const sqrt=(1n<<159n)+123456789n,ratios=priceRatios(sqrt,36,0),forward=ratios.currency1_per_currency0,reverse=ratios.currency0_per_currency1;
  assert.equal(forward.numerator,reverse.denominator);assert.equal(forward.denominator,reverse.numerator);
  assert.equal(BigInt(forward.numerator)*(1n<<192n),BigInt(forward.denominator)*sqrt*sqrt*10n**36n);
});
test('Noncanonical signed ABI encodings are rejected atomically',()=>{
  const {p,engine}=ready(),x=log(p,'Swap',{number:11});x.data=data((1n<<128n)-1n,-100,1n<<96n,1000,0,3000);
  assert.equal(engine.applyBlock(block(11,[x])).status,'REJECTED');assert.equal(engine.snapshot().head.number,'10');assert.equal(last(engine).qualification,'STATE_INVALIDATED');
});
test('Invalid ModifyLiquidity range and tick alignment are rejected',()=>{
  const p=pool();for(const args of [{lower:1},{lower:60,upper:60},{lower:-887280}])assert.throws(()=>decodeLog(log(p,'ModifyLiquidity',args),p));
});
test('Removed logs, duplicate logs, malformed topics and context mismatch reject',()=>{
  const p=pool();for(const mutate of [x=>x.removed=true,x=>delete x.removed,x=>x.blockHash=h(999),x=>x.topics.push(h(1))]){
    const engine=new PoolEngine(registry([p])),x=log(p,'Swap');mutate(x);assert.equal(engine.applyBlock(block(10,[x])).status,'REJECTED');
  }
  const engine=new PoolEngine(registry([p])),x=log(p,'Swap');assert.equal(engine.applyBlock(block(10,[x,x])).status,'REJECTED');
});
test('Transaction indices and log ordering cannot conflict',()=>{
  const p=pool();for(const pair of [[log(p,'Swap',{index:1}),log(p,'Swap',{index:0})],[log(p,'Swap'),log(p,'Swap',{index:1,tx:101})]]){
    assert.equal(new PoolEngine(registry([p])).applyBlock(block(10,pair)).status,'REJECTED');
  }
});
test('Activity preceding Initialize and duplicate Initialize reject',()=>{
  const p=pool();for(const logs of [[log(p,'Swap'),log(p,'Initialize',{index:1})],[log(p,'Initialize'),log(p,'Initialize',{index:1})]])assert.equal(new PoolEngine(registry([p])).applyBlock(block(10,logs)).status,'REJECTED');
});
test('Retained future Initialize cannot qualify earlier Swap',()=>{
  const p=pool();p.identity_evidence={kind:'initialize_log',source:'SYNTHETIC',log:log(p,'Initialize',{number:12})};
  assert.equal(new PoolEngine(registry([p])).applyBlock(block(10,[log(p,'Swap')])).status,'REJECTED');
});
test('Unrelated pool logs are retained upstream but do not dirty configured routes',()=>{
  const p=pool(),q=pool(3),engine=new PoolEngine(registry([p]));const r=engine.applyBlock(block(10,[log(q,'Swap')]));assert.equal(r.status,'APPLIED');assert.deepEqual(r.affected_pool_ids,[]);
});
test('Snapshots and returned states are defensive copies',()=>{
  const {engine}=ready(),snapshot=engine.snapshot();snapshot.pools[0].qualification='fake';snapshot.routes[0].pool_ids[0]='bad';assert.equal(last(engine).qualification,'CORE_STATE_OBSERVED');
});
test('Stale historical same-branch duplicate does not rewind head',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11));const result=engine.applyBlock(block(10,[log(p,'Initialize'),log(p,'Swap',{index:1})]));assert.equal(result.status,'DUPLICATE');assert.equal(engine.snapshot().head.number,'11');
});

test('Rejected replacement is transactional and cannot rewind accepted head/history',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11,[log(p,'Swap',{number:11,sqrt:2n<<96n})]));
  const before=engine.snapshot();const bad=block(11,[],h(111),h(10));bad.timestamp=1;
  const rejected=engine.applyBlock(bad);assert.equal(rejected.status,'REJECTED');
  assert.equal(engine.snapshot().head.hash,before.head.hash);assert.equal(engine.snapshot().retained_blocks,before.retained_blocks);
  assert.equal(last(engine).sqrt_price_x96,(2n<<96n).toString());assert.equal(last(engine).qualification,'STATE_INVALIDATED');
  assert.equal(engine.applyBlock(block(12,[log(p,'Swap',{number:12})])).status,'APPLIED');
});
test('State-dependent rejection after staged fork leaves accepted branch intact',()=>{
  const {p,engine}=ready();engine.applyBlock(block(11));
  const rejected=engine.applyBlock(block(11,[log(p,'Initialize',{number:11,hash:h(111)})],h(111),h(10)));
  assert.equal(rejected.status,'REJECTED');assert.equal(engine.snapshot().head.hash,h(11));
  assert.equal(engine.applyBlock(block(12)).status,'APPLIED');
});

test('The same currency cannot have conflicting decimals across pools',()=>{
  assert.throws(()=>new PoolEngine(registry([pool(1),pool(2)])),/conflicting decimals/);
});
