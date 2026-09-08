/** Bounded Robinhood V4 core-state observer. No RPC, wallet attribution, quoting or execution. */
import {createHash} from 'node:crypto';
import {keccakHex} from './keccak.mjs';

export const CHAIN_ID=4663;
export const MANAGER='0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const ZERO='0x'+'0'.repeat(40);
export const TOPICS=Object.freeze({
  Initialize:keccakHex(Buffer.from('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')),
  Swap:keccakHex(Buffer.from('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')),
  ModifyLiquidity:keccakHex(Buffer.from('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')),
});
const MIN_SQRT=4295128739n, MAX_SQRT=1461446703485210103287273052203988822378723970342n;
const clone=v=>structuredClone(v);
function assert(ok,message){if(!ok)throw new Error(message);}
function hex(v,size,name){assert(typeof v==='string'&&new RegExp(`^0x[0-9a-fA-F]{${size*2}}$`).test(v),`invalid ${name}`);return v.toLowerCase();}
function natural(v,name){
  assert((typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)||(typeof v==='string'&&/^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.test(v))||typeof v==='bigint',`invalid ${name}`);
  const n=BigInt(v);assert(n>=0n&&n<1n<<64n,`out-of-range ${name}`);return n;
}
function small(v,lo,hi,name){assert(typeof v==='number'&&Number.isInteger(v)&&v>=lo&&v<=hi,`invalid ${name}`);return v;}
function timestamp(v,name){
  if(typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)){assert(Number.isFinite(Date.parse(v)),`invalid ${name}`);return v;}
  return natural(v,name).toString();
}
function stable(v){
  if(Array.isArray(v))return '['+v.map(stable).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
export function abiWord(v){return Buffer.from(BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0'),'hex');}
export function poolId(pool){return keccakHex(Buffer.concat([pool.currency0,pool.currency1,pool.fee,pool.tick_spacing,pool.hooks].map(abiWord)));}
function unsigned(w,bits){assert(w>=0n&&w<(1n<<BigInt(bits)),`noncanonical uint${bits}`);return w;}
function signed(w,bits){const n=BigInt.asIntN(256,w);assert(n>=-(1n<<BigInt(bits-1))&&n<(1n<<BigInt(bits-1)),`noncanonical int${bits}`);return n;}
function addressWord(w){return '0x'+unsigned(w,160).toString(16).padStart(40,'0');}
function words(data,count){hex(data,32*count,'ABI data');return Array.from({length:count},(_,i)=>BigInt('0x'+data.slice(2+i*64,2+(i+1)*64)));}
function gcd(a,b){while(b){[a,b]=[b,a%b];}return a;}
function rational(n,d){assert(n>0n&&d>0n,'invalid price fraction');const g=gcd(n,d);return {numerator:(n/g).toString(),denominator:(d/g).toString()};}
export function priceRatios(sqrt,decimals0,decimals1){
  sqrt=BigInt(sqrt);assert(sqrt>=MIN_SQRT&&sqrt<MAX_SQRT,'sqrt price outside protocol bounds');
  small(decimals0,0,36,'decimals0');small(decimals1,0,36,'decimals1');
  const n=sqrt*sqrt*10n**BigInt(decimals0),d=(1n<<192n)*10n**BigInt(decimals1);
  return {currency1_per_currency0:rational(n,d),currency0_per_currency1:rational(d,n)};
}
export function validHookAddress(address,fee){
  const bits=BigInt(hex(address,20,'hooks'));
  for(const [delta,action] of [[3n,7n],[2n,6n],[1n,10n],[0n,8n]])if((bits&(1n<<delta))&&!(bits&(1n<<action)))return false;
  return bits===0n?fee!==0x800000:!!(bits&0x3fffn)||fee===0x800000;
}
function normalizePool(raw){
  assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'pool must be object');
  const p={};
  for(const k of ['currency0','currency1','hooks'])p[k]=hex(raw[k],20,k);
  assert(BigInt(p.currency0)<BigInt(p.currency1),'currency order');
  p.pool_id=hex(raw.pool_id,32,'pool id');
  p.fee=small(raw.fee,0,0xffffff,'fee');assert(p.fee<=1000000||p.fee===0x800000,'invalid pool fee');
  assert(validHookAddress(p.hooks,p.fee),'invalid hook address/fee flags');
  p.tick_spacing=small(raw.tick_spacing,1,32767,'tick spacing');
  p.decimals0=small(raw.decimals0,0,36,'decimals0');p.decimals1=small(raw.decimals1,0,36,'decimals1');
  if(p.currency0===ZERO)assert(p.decimals0===18,'native ETH decimals');
  assert(poolId(p)===p.pool_id,'pool key hash mismatch');
  return p;
}
function rawLog(log){
  assert(log&&typeof log==='object'&&!Array.isArray(log),'log must be object');
  assert(log.removed===false,'removed or missing removed flag');
  assert(Array.isArray(log.topics)&&log.topics.length<=4,'invalid topics');
  assert(typeof log.data==='string'&&log.data.length<=262146&&/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data),'invalid log data');
  return {address:hex(log.address,20,'log address'),block_number:natural(log.blockNumber,'log block number').toString(),
    block_hash:hex(log.blockHash,32,'log block hash'),transaction_hash:hex(log.transactionHash,32,'transaction hash'),
    transaction_index:natural(log.transactionIndex,'transaction index').toString(),log_index:natural(log.logIndex,'log index').toString(),
    topics:log.topics.map(v=>hex(v,32,'topic')),data:log.data.toLowerCase()};
}
function priceBounds(sqrt,tick){assert(sqrt>=MIN_SQRT&&sqrt<MAX_SQRT&&tick>=-887272n&&tick<=887272n,'price/tick outside protocol bounds');}
function decode(log,pool){
  const t=log.topics,w=log.data;
  if(log.address!==MANAGER||t[1]!==pool.pool_id)return null;
  const common={pool_id:pool.pool_id,transaction_hash:log.transaction_hash,transaction_index:log.transaction_index,
    log_index:log.log_index,block_hash:log.block_hash,block_number:log.block_number};
  if(t[0]===TOPICS.Initialize){
    assert(t.length===4,'Initialize topics');
    assert(addressWord(BigInt(t[2]))===pool.currency0&&addressWord(BigInt(t[3]))===pool.currency1,'Initialize currency mismatch');
    const a=words(w,5),fee=Number(unsigned(a[0],24)),spacing=Number(signed(a[1],24)),hooks=addressWord(a[2]);
    const sqrt=unsigned(a[3],160),tick=signed(a[4],24);priceBounds(sqrt,tick);
    assert(fee===pool.fee&&spacing===pool.tick_spacing&&hooks===pool.hooks,'Initialize key mismatch');
    return {...common,event:'Initialize',sqrt_price_x96:sqrt.toString(),tick:Number(tick),initial_fee:fee};
  }
  if(t[0]===TOPICS.Swap){
    assert(t.length===3,'Swap topics');const sender=addressWord(BigInt(t[2])),a=words(w,6);
    const a0=signed(a[0],128),a1=signed(a[1],128),sqrt=unsigned(a[2],160),liquidity=unsigned(a[3],128),tick=signed(a[4],24),fee=unsigned(a[5],24);
    priceBounds(sqrt,tick);assert(fee<=1000000n,'swap fee exceeds protocol maximum');
    return {...common,event:'Swap',sender,sender_role:'IMMEDIATE_CALLER_NOT_TRADER',trader:null,
      amount0_raw:a0.toString(),amount1_raw:a1.toString(),sqrt_price_x96:sqrt.toString(),active_liquidity_raw:liquidity.toString(),
      tick:Number(tick),fee_pips:Number(fee)};
  }
  if(t[0]===TOPICS.ModifyLiquidity){
    assert(t.length===3,'ModifyLiquidity topics');const sender=addressWord(BigInt(t[2])),a=words(w,4);
    const lower=signed(a[0],24),upper=signed(a[1],24),delta=signed(a[2],256);
    assert(lower>=-887272n&&upper<=887272n&&lower<upper,'invalid liquidity tick range');
    assert(lower%BigInt(pool.tick_spacing)===0n&&upper%BigInt(pool.tick_spacing)===0n,'liquidity ticks not aligned');
    return {...common,event:'ModifyLiquidity',sender,sender_role:'IMMEDIATE_CALLER_NOT_OWNER',
      tick_lower:Number(lower),tick_upper:Number(upper),liquidity_delta_raw:delta.toString(),salt:'0x'+a[3].toString(16).padStart(64,'0')};
  }
  return null;
}
/** Low-level decoding does not verify source authenticity or block canonicality. */
export function decodeLog(log,pool){return decode(rawLog(log),normalizePool(pool));}
function emptyState(pool){return {pool_id:pool.pool_id,identity_status:'REGISTRY_UNPROVEN',identity_evidence:null,
  decimals_status:'SUPPLIED_NOT_RPC_VERIFIED',qualification:'UNOBSERVED',hooks:pool.hooks,
  hook_status:pool.hooks===ZERO?'NO_HOOK':'UNKNOWN_HOOK_UNQUALIFIED',sqrt_price_x96:null,tick:null,active_liquidity_raw:null,
  liquidity_status:'UNOBSERVED',last_swap_fee_pips:null,price_ratios:null,last_event:null,as_of_block:null,
  pool_inventory:null,trader:null,executable_proceeds:null,requires_reanchor:false};}
function refresh(state){
  if(state.requires_reanchor)state.qualification='STATE_INVALIDATED';
  else if(state.sqrt_price_x96===null)state.qualification='UNOBSERVED';
  else if(state.identity_status==='REGISTRY_UNPROVEN')state.qualification='IDENTITY_UNQUALIFIED';
  else if(state.hooks!==ZERO)state.qualification='CORE_MARK_ONLY_HOOK_UNQUALIFIED';
  else if(state.liquidity_status!=='OBSERVED')state.qualification='CORE_MARK_ONLY_LIQUIDITY_UNKNOWN';
  else state.qualification='CORE_STATE_OBSERVED';
}

export class PoolEngine {
  constructor(registry,options={}){
    assert(registry&&registry.chain_id===CHAIN_ID,'registry must specify Robinhood mainnet chain 4663');
    assert(hex(registry.manager,20,'manager')===MANAGER,'unsupported Robinhood manager');
    this.maxHistory=small(options.max_history??128,1,2048,'max_history');
    this.maxLogs=small(options.max_logs_per_block??10000,1,100000,'max_logs_per_block');
    const maxPools=small(options.max_pools??10000,1,100000,'max_pools'),maxRoutes=small(options.max_routes??10000,1,100000,'max_routes');
    assert(Array.isArray(registry.pools)&&registry.pools.length<=maxPools,'pool limit');
    assert(Array.isArray(registry.routes??[])&&(registry.routes??[]).length<=maxRoutes,'route limit');
    this.pools=new Map();this.states=new Map();this.routes=new Map();this.reverse=new Map();this.head=null;this.history=[];this.epoch=0;this.lastFault=null;
    const tokenDecimals=new Map();
    for(const raw of registry.pools){
      const pool=normalizePool(raw);assert(!this.pools.has(pool.pool_id),'duplicate pool id');
      for(const [token,decimals] of [[pool.currency0,pool.decimals0],[pool.currency1,pool.decimals1]]){
        assert(!tokenDecimals.has(token)||tokenDecimals.get(token)===decimals,'conflicting decimals for one currency');tokenDecimals.set(token,decimals);
      }
      this.pools.set(pool.pool_id,pool);this.reverse.set(pool.pool_id,new Set());const state=emptyState(pool);
      if(raw.identity_evidence){
        const evidence=raw.identity_evidence;
        assert(evidence.kind==='initialize_log'&&typeof evidence.source==='string'&&evidence.source.trim().length>0&&evidence.source.length<=2000,'unsupported identity evidence');
        const log=rawLog(evidence.log),event=decode(log,pool);assert(event?.event==='Initialize','identity evidence must be matching Initialize');
        state.identity_status='RETAINED_INITIALIZE_MATCH';state.identity_evidence={source:evidence.source,block_number:log.block_number,block_hash:log.block_hash,
          transaction_hash:log.transaction_hash,log_index:log.log_index,log_sha256:hash(log)};
      }
      this.states.set(pool.pool_id,state);
    }
    for(const route of registry.routes??[]){
      assert(typeof route.id==='string'&&route.id.length>0&&route.id.length<=200&&!this.routes.has(route.id),'route id');
      assert(Array.isArray(route.pool_ids)&&route.pool_ids.length>0&&route.pool_ids.length<=64,'route pool limit');
      const ids=route.pool_ids.map(id=>hex(id,32,'route pool id'));assert(new Set(ids).size===ids.length,'duplicate route pool');
      for(const id of ids){assert(this.pools.has(id),'route contains unknown pool');this.reverse.get(id).add(route.id);}
      this.routes.set(route.id,ids);
    }
  }
  _routes(ids){return [...new Set([...ids].flatMap(id=>[...this.reverse.get(id)]))].sort();}
  _output(status,block,affected=[],events=[],invalidated=[],reason=null,continuity='CONTIGUOUS'){
    const ids=[...new Set(affected)].sort();return {status,block:block?clone(block):null,epoch:this.epoch,continuity,reason,
      affected_pool_ids:ids,dirty_route_ids:this._routes(ids),invalidated_route_ids:[...new Set(invalidated)].sort(),
      events:clone(events),states:ids.map(id=>clone(this.states.get(id))),head:clone(this.head)};
  }
  _fault(reason,status='REJECTED'){
    this.epoch++;this.lastFault=reason;
    for(const s of this.states.values()){s.requires_reanchor=true;refresh(s);}
    return this._output(status,null,this.pools.keys(),[],this.routes.keys(),reason,'INVALIDATED');
  }
  invalidate(reason='upstream source unavailable'){
    assert(typeof reason==='string'&&reason.length>0&&reason.length<=2000,'invalidation reason');
    return this._fault(reason,'INVALIDATED');
  }
  applyBlock(input){
    let block,logs,events,fingerprint;
    try{
      assert(input&&typeof input==='object'&&!Array.isArray(input),'block must be object');
      block={number:natural(input.number,'block number').toString(),hash:hex(input.hash,32,'block hash'),parent_hash:hex(input.parent_hash,32,'parent hash'),
        timestamp:natural(input.timestamp,'block timestamp').toString(),observed_at:timestamp(input.observed_at,'observed_at'),coverage:input.coverage};
      assert(['provider_reported_complete','partial'].includes(block.coverage),'invalid block coverage');
      assert(Array.isArray(input.logs)&&input.logs.length<=this.maxLogs,'block log limit');
      logs=input.logs.map(rawLog);let previous=null;const txByIndex=new Map(),indexByTx=new Map();
      for(const log of logs){
        assert(log.block_number===block.number&&log.block_hash===block.hash,'log block context mismatch');
        if(previous)assert(BigInt(log.log_index)>BigInt(previous.log_index)&&BigInt(log.transaction_index)>=BigInt(previous.transaction_index),'duplicate or out-of-order log');
        const existing=txByIndex.get(log.transaction_index),index=indexByTx.get(log.transaction_hash);
        assert((existing===undefined||existing===log.transaction_hash)&&(index===undefined||index===log.transaction_index),'conflicting transaction index');
        txByIndex.set(log.transaction_index,log.transaction_hash);indexByTx.set(log.transaction_hash,log.transaction_index);previous=log;
      }
      events=logs.map(log=>this.pools.has(log.topics[1])?decode(log,this.pools.get(log.topics[1])):null).filter(Boolean);
      fingerprint=hash({number:block.number,hash:block.hash,parent_hash:block.parent_hash,timestamp:block.timestamp,coverage:block.coverage,logs});
    }catch(error){return this._fault(error.message);}
    if(block.coverage==='partial')return this._fault('partial block cannot advance canonical pool state','PARTIAL');
    const initializations=new Map();
    for(const event of events)if(event.event==='Initialize'){
      if(initializations.has(event.pool_id))return this._fault('duplicate Initialize in block');
      initializations.set(event.pool_id,event);
    }
    for(const event of events){
      const initial=initializations.get(event.pool_id);
      if(initial&&BigInt(event.log_index)<BigInt(initial.log_index))return this._fault('pool activity precedes Initialize');
    }
    const existing=this.history.find(x=>x.block.hash===block.hash);
    if(existing){
      if(existing.fingerprint!==fingerprint)return this._fault('same block hash has conflicting contents','CONFLICT');
      return this._output('DUPLICATE',block);
    }
    // Stage fork rollback and event application on copy-on-write state. Rejection
    // invalidates qualifications but preserves the last accepted head/history.
    let workingHead=clone(this.head),workingEpoch=this.epoch;
    const workingStates=new Map(this.states),workingHistory=this.history.slice();
    let continuity='CONTIGUOUS',invalidated=[],rollbackPools=new Set();
    if(workingHead){
      if(block.parent_hash!==workingHead.hash||BigInt(block.number)!==BigInt(workingHead.number)+1n){
        const parentIndex=workingHistory.findIndex(x=>x.block.hash===block.parent_hash&&BigInt(x.block.number)+1n===BigInt(block.number));
        if(parentIndex<0){
          const reason=BigInt(block.number)>BigInt(workingHead.number)+1n?'missing parent block; replay gap in order':'parent unavailable in bounded history; rebuild from a trusted anchor';
          return this._fault(reason,BigInt(block.number)>BigInt(workingHead.number)+1n?'GAP':'REORG_UNRESOLVED');
        }
        while(workingHistory.length>parentIndex+1){
          const item=workingHistory.pop();for(const [id,state] of item.undo){workingStates.set(id,clone(state));rollbackPools.add(id);}
        }
        workingHead=clone(workingHistory.at(-1).block);
        for(const [id,state] of workingStates){
          if(state.identity_evidence&&BigInt(state.identity_evidence.block_number)>BigInt(workingHead.number)){
            const replacement=clone(state);replacement.identity_status='REGISTRY_UNPROVEN';replacement.identity_evidence=null;refresh(replacement);workingStates.set(id,replacement);rollbackPools.add(id);
          }
        }
        workingEpoch++;invalidated=[...this.routes.keys()];continuity='REORG_ROLLED_BACK';
      }
      if(BigInt(block.timestamp)<BigInt(workingHead.timestamp))return this._fault('block timestamp precedes parent');
    }else continuity='FIRST_OBSERVED_BLOCK';
    const undo=new Map(),affected=new Set(rollbackPools);
    const remember=id=>{if(!undo.has(id)){undo.set(id,clone(workingStates.get(id)));workingStates.set(id,clone(workingStates.get(id)));}affected.add(id);};
    // An externally retained initialization on a replaced block cannot qualify identity.
    for(const [id,state] of workingStates){
      if(state.identity_evidence?.block_number===block.number&&state.identity_evidence.block_hash!==block.hash){
        remember(id);const replacement=workingStates.get(id);replacement.identity_status='REGISTRY_UNPROVEN';replacement.identity_evidence=null;refresh(replacement);
      }
    }
    // Validate state-dependent conditions before committing event changes.
    for(const event of events){
      const state=workingStates.get(event.pool_id);
      if(state.identity_evidence&&BigInt(state.identity_evidence.block_number)>BigInt(block.number))return this._fault('retained Initialize occurs after incoming block');
      if(event.event==='Initialize'&&!state.identity_evidence&&state.last_event)return this._fault('Initialize follows prior pool activity');
      if(state.identity_evidence?.block_number===block.number&&event.event!=='Initialize'&&BigInt(event.log_index)<=BigInt(state.identity_evidence.log_index))return this._fault('pool event precedes retained Initialize');
      if(event.event==='Initialize'&&state.identity_evidence){
        const old=state.identity_evidence;
        if(old.block_hash!==event.block_hash||old.transaction_hash!==event.transaction_hash||old.log_index!==event.log_index)return this._fault('conflicting Initialize identity');
      }
    }
    for(const event of events){
      const id=event.pool_id,pool=this.pools.get(id);remember(id);const state=workingStates.get(id);
      if(event.event==='Initialize'){
        state.identity_status='OBSERVED_INITIALIZE_MATCH';state.identity_evidence={source:'applied_block_bundle',block_number:block.number,block_hash:block.hash,
          transaction_hash:event.transaction_hash,log_index:event.log_index};
        state.sqrt_price_x96=event.sqrt_price_x96;state.tick=event.tick;state.price_ratios=priceRatios(event.sqrt_price_x96,pool.decimals0,pool.decimals1);
        state.active_liquidity_raw='0';state.liquidity_status='OBSERVED';state.requires_reanchor=false;
      }else if(event.event==='Swap'){
        state.sqrt_price_x96=event.sqrt_price_x96;state.tick=event.tick;state.active_liquidity_raw=event.active_liquidity_raw;state.liquidity_status='OBSERVED';
        state.price_ratios=priceRatios(event.sqrt_price_x96,pool.decimals0,pool.decimals1);state.last_swap_fee_pips=event.fee_pips;state.requires_reanchor=false;
      }else if(event.event==='ModifyLiquidity'&&BigInt(event.liquidity_delta_raw)!==0n){
        state.active_liquidity_raw=null;state.liquidity_status='INVALIDATED_BY_MODIFY_LIQUIDITY';
      }
      state.last_event={event:event.event,transaction_hash:event.transaction_hash,log_index:event.log_index,block_number:block.number,block_hash:block.hash};
      state.as_of_block={number:block.number,hash:block.hash,timestamp:block.timestamp,coverage:block.coverage};refresh(state);
    }
    workingHead=clone(block);this.lastFault=null;workingHistory.push({block:clone(block),fingerprint,undo});
    if(workingHistory.length>this.maxHistory)workingHistory.shift();
    this.states=workingStates;this.history=workingHistory;this.head=workingHead;this.epoch=workingEpoch;
    return this._output('APPLIED',block,affected,events,invalidated,null,continuity);
  }
  snapshot(){return {schema:'pulse.v4-pool-state.v1',chain_id:CHAIN_ID,manager:MANAGER,head:clone(this.head),epoch:this.epoch,last_fault:this.lastFault,
    retained_blocks:this.history.length,pools:[...this.states.values()].map(clone),routes:[...this.routes].map(([id,pool_ids])=>({id,pool_ids:clone(pool_ids)})),
    limitations:['Provider block canonicality and completeness must be established upstream.','Registry and retained logs are supplied evidence, not cryptographic proofs.',
      'Decimals are supplied metadata; no RPC or bytecode check is performed here.','Core event state is not a route quote, pool reserves, wallet cash flow, or executable value.',
      'Nonzero hooks remain unqualified; ModifyLiquidity invalidates observed active liquidity.','No transaction signing, submission or simulation is implemented.']};}
}
