/** Immediate primary-source V4 observations. Always provisional; never execution eligible. */
import {createHash} from 'node:crypto';
import {PoolEngine,MANAGER,ZERO,decodeLog,priceRatios} from './pools.mjs';
const clone=v=>structuredClone(v);
function assert(ok,message){if(!ok)throw new Error(message);}
function hex(v,size,name){assert(typeof v==='string'&&new RegExp(`^0x[0-9a-fA-F]{${size*2}}$`).test(v),`invalid ${name}`);return v.toLowerCase();}
function quantity(v,name){
  assert((typeof v==='string'&&v.length<=20&&/^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.test(v))||(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0),`invalid ${name}`);
  const n=BigInt(v);assert(n>=0n&&n<(1n<<64n),`invalid ${name}`);return n.toString();
}
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function readLog(raw){
  assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'invalid log');
  assert(typeof raw.removed==='boolean','missing log removed flag');
  assert(Array.isArray(raw.topics)&&raw.topics.length<=4,'invalid topics');
  assert(typeof raw.data==='string'&&raw.data.length<=262146&&/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data),'invalid log data');
  return {address:hex(raw.address,20,'log address'),block_number:quantity(raw.blockNumber,'log block'),block_hash:hex(raw.blockHash,32,'log hash'),
    transaction_hash:hex(raw.transactionHash,32,'transaction hash'),transaction_index:quantity(raw.transactionIndex,'transaction index'),
    log_index:quantity(raw.logIndex,'log index'),topics:raw.topics.map(t=>hex(t,32,'topic')),data:raw.data.toLowerCase(),removed:raw.removed};
}
function readHead(raw){
  assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'invalid head');
  return {number:quantity(raw.number,'head number'),hash:hex(raw.hash,32,'head hash'),parent_hash:hex(raw.parentHash,32,'head parent'),timestamp:quantity(raw.timestamp,'head timestamp')};
}
export class LivePoolCache {
  constructor(registry,options={}){
    // Reuse strict key, route and retained-initialization validation without advancing canonical state.
    const checked=new PoolEngine(registry,{max_history:1});
    this.pools=checked.pools;this.reverse=checked.reverse;this.routes=checked.routes;
    this.maxBlocks=options.max_blocks??32;this.maxLogs=options.max_logs_per_block??10000;
    assert(Number.isInteger(this.maxBlocks)&&this.maxBlocks>=1&&this.maxBlocks<=32,'max_blocks must be 1..32');
    assert(Number.isInteger(this.maxLogs)&&this.maxLogs>=1&&this.maxLogs<=10000,'max_logs_per_block must be 1..10000');
    this.states=new Map(checked.snapshot().pools.map(state=>[state.pool_id,{...state,qualification:'PROVISIONAL_UNRECONCILED',
      provisional_status:'UNOBSERVED',canonicality:'UNKNOWN',coverage:'UNKNOWN',execution_eligible:false}]));
    this.blocks=new Map();this.source=null;this.head=null;this.lastLog=null;this.epoch=0;this.reason=null;
  }
  _routes(ids){return [...new Set([...ids].flatMap(id=>[...this.reverse.get(id)]))].sort();}
  _result(status,ids=[],events=[],obs=null,reason=null){
    ids=[...new Set(ids)].sort();return {status,updated:status==='OBSERVED',event_id:obs?.event_id??null,source:this.source,epoch:this.epoch,
      qualification:'PROVISIONAL_UNRECONCILED',canonicality:'UNKNOWN',coverage:'UNKNOWN',execution_eligible:false,
      affected_pool_ids:ids,dirty_route_ids:this._routes(ids),invalidated_route_ids:status==='INVALIDATED'?[...this.routes.keys()].sort():[],
      states:ids.map(id=>clone(this.states.get(id))),events:clone(events),head:clone(this.head),reason};
  }
  invalidate(reason='primary source disconnected'){
    assert(typeof reason==='string'&&reason.length>0&&reason.length<=2000,'invalid invalidation reason');
    this.epoch++;this.reason=reason;this.blocks.clear();this.lastLog=null;this.head=null;
    for(const state of this.states.values()){
      state.provisional_status='INVALIDATED';state.requires_reanchor=true;state.qualification='PROVISIONAL_UNRECONCILED';state.execution_eligible=false;
      state.identity_status='REGISTRY_UNPROVEN';state.identity_evidence=null;
    }
    return this._result('INVALIDATED',this.pools.keys(),[],null,reason);
  }
  _block(number,hash){
    const existing=this.blocks.get(number);
    if(existing){assert(existing.hash===hash,'same-height block hash conflict');return existing;}
    if(this.blocks.size===this.maxBlocks){
      const minimum=[...this.blocks.keys()].reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
      assert(BigInt(number)>BigInt(minimum),'observation older than retained block window');this.blocks.delete(minimum);
    }
    const value={number,hash,header:null,slots:new Map(),transactions:new Map(),txIndices:new Map()};this.blocks.set(number,value);return value;
  }
  applyObservation(obs){
    if(obs?.delivery!=='live'||!['head','log'].includes(obs?.stage))return this._result('IGNORED',[],[],obs,'non-live or unsupported stage');
    if(this.source!==null&&obs.source!==this.source)return this._result('IGNORED',[],[],obs,'different source; selected primary is unchanged');
    try{
      assert(obs.schema_version==='pulse.observation.v1'&&obs.chain_id===4663,'invalid observation schema/chain');
      assert(typeof obs.source==='string'&&/^[a-zA-Z0-9_-]{1,48}$/.test(obs.source),'invalid source');
      assert(typeof obs.event_id==='string'&&obs.event_id.length>0&&obs.event_id.length<=1024,'invalid event identity');
      assert(typeof obs.observed_at==='string'&&obs.observed_at.length<=64&&Number.isFinite(Date.parse(obs.observed_at)),'invalid observation timestamp');
      this.source??=obs.source;
      if(obs.stage==='head')return this._head(obs);
      return this._log(obs);
    }catch(error){const result=this.invalidate(error.message);result.event_id=obs?.event_id??null;return result;}
  }
  _head(obs){
    const head=readHead(obs.payload);
    if(obs.block_hash!==undefined)assert(hex(obs.block_hash,32,'envelope hash')===head.hash,'head envelope hash mismatch');
    if(obs.block_number!==undefined)assert(quantity(obs.block_number,'envelope number')===head.number,'head envelope number mismatch');
    let fault=null;
    const known=this.blocks.get(head.number);
    const parentKnown=this.blocks.get((BigInt(head.number)-1n).toString());
    const childKnown=this.blocks.get((BigInt(head.number)+1n).toString());
    if(parentKnown&&parentKnown.hash!==head.parent_hash)fault='live head conflicts with adjacent observed block';
    if(childKnown?.header&&childKnown.header.parent_hash!==head.hash)fault='live head conflicts with observed child parent';
    if(known&&known.hash!==head.hash)fault='live same-height reorg hint';
    if(known?.header&&fingerprint(known.header)!==fingerprint(head))fault='conflicting live header';
    if(this.head){
      if(head.number===this.head.number&&head.hash===this.head.hash&&!fault)return this._result('DUPLICATE',[],[],obs);
      if(BigInt(head.number)<BigInt(this.head.number)&&!fault)return this._result('IGNORED',[],[],obs,'older live head');
      if(BigInt(head.number)>BigInt(this.head.number)+1n)fault='live head gap';
      else if(BigInt(head.number)===BigInt(this.head.number)+1n&&head.parent_hash!==this.head.hash)fault='live parent mismatch';
      if(BigInt(head.timestamp)<BigInt(this.head.timestamp)&&BigInt(head.number)>BigInt(this.head.number))fault='live head timestamp regression';
    }
    let result;
    if(fault)result=this.invalidate(fault);
    const value=this._block(head.number,head.hash);value.header=clone(head);this.head=clone(head);
    if(result){result.head=clone(head);result.event_id=obs.event_id;return result;}
    return this._result('HEAD',[],[],obs);
  }
  _log(obs){
    const log=readLog(obs.payload);
    for(const [field,actual] of [['block_hash',log.block_hash],['transaction_hash',log.transaction_hash]])if(obs[field]!==undefined)assert(hex(obs[field],32,field)===actual,'log envelope hash mismatch');
    for(const [field,actual] of [['block_number',log.block_number],['log_index',log.log_index],['transaction_index',log.transaction_index]])if(obs[field]!==undefined)assert(quantity(obs[field],field)===actual,'log envelope index mismatch');
    if(log.removed){const result=this.invalidate('removed live log');result.event_id=obs.event_id;return result;}
    const childKnown=this.blocks.get((BigInt(log.block_number)+1n).toString());
    assert(!childKnown?.header||childKnown.header.parent_hash===log.block_hash,'live log block conflicts with observed child parent');
    const block=this._block(log.block_number,log.block_hash),key=log.log_index,signature=fingerprint(log),previous=block.slots.get(key);
    if(previous!==undefined){assert(previous===signature,'conflicting global log slot');return this._result('DUPLICATE',[],[],obs);}
    assert(block.slots.size<this.maxLogs,'live block log limit');
    if(this.lastLog){
      assert(BigInt(log.block_number)>=BigInt(this.lastLog.block_number),'out-of-order live log block');
      if(log.block_number===this.lastLog.block_number)assert(log.block_hash===this.lastLog.block_hash&&BigInt(log.log_index)>BigInt(this.lastLog.log_index)&&BigInt(log.transaction_index)>=BigInt(this.lastLog.transaction_index),'out-of-order live log position');
    }
    const tx=block.transactions.get(log.transaction_index),index=block.txIndices.get(log.transaction_hash);
    assert((tx===undefined||tx===log.transaction_hash)&&(index===undefined||index===log.transaction_index),'conflicting live transaction index');
    // Unknown pools are not registered automatically; preserve upstream raw evidence instead.
    const pool=this.pools.get(log.topics[1]);const event=log.address===MANAGER&&pool?decodeLog(obs.payload,pool):null;
    if(event){
      const state=this.states.get(event.pool_id),identity=state.identity_evidence;
      assert(!identity||BigInt(identity.block_number)<=BigInt(log.block_number),'Initialize evidence is newer than live event');
      if(identity?.block_number===log.block_number){
        assert(identity.block_hash===log.block_hash,'retained Initialize block conflicts with live event');
        if(event.event!=='Initialize')assert(BigInt(log.log_index)>BigInt(identity.log_index),'live event precedes retained Initialize');
      }
      if(event.event==='Initialize'){
        if(state.last_event&&!state.requires_reanchor)throw new Error('Initialize follows prior live pool activity');
        if(identity&&!state.requires_reanchor)assert(identity.block_hash===log.block_hash&&identity.transaction_hash===log.transaction_hash&&identity.log_index===log.log_index,'conflicting live Initialize');
        state.identity_status='LIVE_INITIALIZE_MATCH_UNRECONCILED';state.identity_evidence={source:'live_primary_observation',block_number:log.block_number,
          block_hash:log.block_hash,transaction_hash:log.transaction_hash,log_index:log.log_index};
        state.sqrt_price_x96=event.sqrt_price_x96;state.tick=event.tick;state.active_liquidity_raw='0';state.liquidity_status='PROVISIONAL_OBSERVED';
        state.price_ratios=priceRatios(event.sqrt_price_x96,pool.decimals0,pool.decimals1);state.requires_reanchor=false;
      }else if(event.event==='Swap'){
        state.sqrt_price_x96=event.sqrt_price_x96;state.tick=event.tick;state.active_liquidity_raw=event.active_liquidity_raw;state.liquidity_status='PROVISIONAL_OBSERVED';
        state.price_ratios=priceRatios(event.sqrt_price_x96,pool.decimals0,pool.decimals1);state.last_swap_fee_pips=event.fee_pips;state.requires_reanchor=false;
      }else if(event.event==='ModifyLiquidity'&&BigInt(event.liquidity_delta_raw)!==0n){state.active_liquidity_raw=null;state.liquidity_status='INVALIDATED_BY_MODIFY_LIQUIDITY';}
      state.provisional_status=state.requires_reanchor?'INVALIDATED':'OBSERVED_PARTIAL_STREAM';state.qualification='PROVISIONAL_UNRECONCILED';
      state.hook_status=pool.hooks===ZERO?'NO_HOOK':'UNKNOWN_HOOK_UNQUALIFIED';state.execution_eligible=false;
      state.last_event={event:event.event,transaction_hash:log.transaction_hash,log_index:log.log_index,block_number:log.block_number,block_hash:log.block_hash,event_id:obs.event_id};
      state.as_of_block={number:log.block_number,hash:log.block_hash,coverage:'UNKNOWN'};state.observed_at=obs.observed_at;
    }
    block.slots.set(key,signature);block.transactions.set(log.transaction_index,log.transaction_hash);block.txIndices.set(log.transaction_hash,log.transaction_index);this.lastLog=log;this.reason=null;
    return this._result(event?'OBSERVED':'IGNORED',event?[event.pool_id]:[],event?[event]:[],obs,event?null:'unconfigured pool or unsupported event');
  }
  snapshot(){return {schema:'pulse.provisional-pools.v1',source:this.source,head:clone(this.head),epoch:this.epoch,qualification:'PROVISIONAL_UNRECONCILED',
    canonicality:'UNKNOWN',coverage:'UNKNOWN',execution_eligible:false,retained_blocks:this.blocks.size,reason:this.reason,pools:[...this.states.values()].map(clone)};}
}
