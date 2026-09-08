/** Bounded read-only collection. Full receipt enumeration is provider evidence, not a trie proof. */
import {createHash} from 'node:crypto';
import {keccakHex} from './keccak.mjs';

export const COLLECTION_LIMITS = Object.freeze({blocks:64, transactions:256, trackedAddresses:20, transcriptBytes:16*1024*1024, resultBytes:2*1024*1024, logs:32768});
const ADDR=/^0x[0-9a-fA-F]{40}$/, HASH=/^0x[0-9a-fA-F]{64}$/, BYTES=/^0x(?:[0-9a-fA-F]{2})*$/, WORD=/^0x[0-9a-fA-F]{64}$/;
const ZERO='0x'+'0'.repeat(40), TRANSFER=keccakHex(Buffer.from('Transfer(address,address,uint256)'));
const SIG = Object.freeze(Object.fromEntries(['totalSupply()','decimals()','uiMultiplier()','balanceOf(address)'].map(s=>[s,keccakHex(Buffer.from(s)).slice(0,10)])));
const ALLOWED_STATUS=new Set(['COLLECTED_AT_BLOCK','INVALID_REQUEST','INCOMPLETE','RPC_UNAVAILABLE','INVALID_EVIDENCE','IDENTITY_MISMATCH','CANONICALITY_FAILED']);
const lower=x=>x.toLowerCase(), hex=n=>'0x'+BigInt(n).toString(16);
function canonical(value) {
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export const collectionDigest = value => 'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
class CollectionError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status,code)=>{throw new CollectionError(status,code);};
function assert(ok,code,status='INVALID_EVIDENCE'){if(!ok)fail(status,code);}
function quantity(value,label){assert(typeof value==='string'&&/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value),label);const n=BigInt(value);assert(n<=BigInt(Number.MAX_SAFE_INTEGER),label);return Number(n);}
function word(value,label){assert(typeof value==='string'&&WORD.test(value),label);return BigInt(value).toString();}
function pin(p){return p&&Number.isSafeInteger(p.number)&&p.number>=0&&typeof p.hash==='string'&&HASH.test(p.hash);}

export function validateCollectRequest(request){
  const r=request;
  assert(r&&typeof r==='object'&&!Array.isArray(r),'REQUEST_OBJECT','INVALID_REQUEST');
  assert(JSON.stringify(r).length<=131072,'REQUEST_TOO_LARGE','INVALID_REQUEST');
  assert(r.schema_version==='pressure.collect.v1'&&r.chain_id===4663,'SCHEMA_OR_CHAIN','INVALID_REQUEST');
  assert(r.evidence_mode===undefined||['rpc_observed','synthetic'].includes(r.evidence_mode),'EVIDENCE_MODE','INVALID_REQUEST');
  assert(r.token&&ADDR.test(r.token.address)&&HASH.test(r.token.expected_code_hash)&&Number.isInteger(r.token.decimals)&&r.token.decimals>=0&&r.token.decimals<=36,'TOKEN_IDENTITY','INVALID_REQUEST');
  assert(pin(r.start)&&pin(r.end)&&r.end.number>=r.start.number,'BLOCK_PINS','INVALID_REQUEST');
  assert(r.end.number!==r.start.number||lower(r.start.hash)===lower(r.end.hash),'SAME_BLOCK_DIFFERENT_HASH','INVALID_REQUEST');
  assert(r.end.number-r.start.number<=COLLECTION_LIMITS.blocks,'BLOCK_BUDGET','INCOMPLETE');
  assert(Array.isArray(r.tracked_addresses)&&Array.isArray(r.attributions),'ADDRESS_ARRAYS','INVALID_REQUEST');
  assert(r.tracked_addresses.length<=COLLECTION_LIMITS.trackedAddresses,'ADDRESS_BUDGET','INCOMPLETE');
  assert(r.tracked_addresses.every(a=>typeof a==='string'&&ADDR.test(a)&&lower(a)!==ZERO)&&new Set(r.tracked_addresses.map(lower)).size===r.tracked_addresses.length,'TRACKED_ADDRESSES','INVALID_REQUEST');
  assert(r.attributions.length<=100,'ATTRIBUTION_BUDGET','INCOMPLETE');
  const categories=new Set(['issuer','venue','custody','treasury','locker','burn','unknown']);
  for(const a of r.attributions) assert(a&&ADDR.test(a.address)&&categories.has(a.category)&&typeof a.label==='string'&&a.label.length>0&&a.label.length<=256&&Number.isSafeInteger(a.valid_from_block)&&a.valid_from_block>=0&&Number.isSafeInteger(a.valid_to_block)&&a.valid_to_block>=a.valid_from_block&&Array.isArray(a.evidence_refs)&&a.evidence_refs.length>0&&a.evidence_refs.length<=20&&a.evidence_refs.every(x=>typeof x==='string'&&x.length>0&&x.length<=2048),'ATTRIBUTION_SCHEMA','INVALID_REQUEST');
  return true;
}

function parseHeader(raw,number){
  assert(raw&&typeof raw==='object'&&quantity(raw.number,'HEADER_NUMBER')===number,'HEADER_NUMBER');
  assert(HASH.test(raw.hash)&&HASH.test(raw.parentHash),'HEADER_HASH');
  const timestamp=quantity(raw.timestamp,'HEADER_TIMESTAMP');
  assert(Array.isArray(raw.transactions)&&raw.transactions.length<=4096&&raw.transactions.every(h=>typeof h==='string'&&HASH.test(h)),'HEADER_TRANSACTIONS');
  assert(new Set(raw.transactions.map(lower)).size===raw.transactions.length,'DUPLICATE_HEADER_TRANSACTION');
  return {number,hash:lower(raw.hash),parent_hash:lower(raw.parentHash),timestamp,transactions:raw.transactions.map(lower)};
}

function decodeReceipt(raw,h,tx,index,state,token){
  assert(raw&&typeof raw==='object','RECEIPT_MISSING');
  assert(typeof raw.transactionHash==='string'&&lower(raw.transactionHash)===tx&&quantity(raw.transactionIndex,'RECEIPT_TRANSACTION_INDEX')===index,'RECEIPT_TRANSACTION_ID');
  assert(typeof raw.blockHash==='string'&&lower(raw.blockHash)===h.hash&&quantity(raw.blockNumber,'RECEIPT_BLOCK_NUMBER')===h.number,'RECEIPT_BLOCK_ID');
  assert(raw.status==='0x0'||raw.status==='0x1','RECEIPT_STATUS');
  assert(Array.isArray(raw.logs)&&raw.logs.length<=8192,'RECEIPT_LOGS');
  assert(raw.status!=='0x0'||raw.logs.length===0,'FAILED_RECEIPT_HAS_LOGS');
  state.logs+=raw.logs.length;assert(state.logs<=COLLECTION_LIMITS.logs,'LOG_BUDGET','INCOMPLETE');
  const transfers=[];
  for(const log of raw.logs){
    assert(log&&typeof log==='object'&&ADDR.test(log.address),'LOG_ADDRESS');
    assert(log.removed===undefined||log.removed===false,'REMOVED_LOG','CANONICALITY_FAILED');
    assert(typeof log.transactionHash==='string'&&lower(log.transactionHash)===tx&&quantity(log.transactionIndex,'LOG_TRANSACTION_INDEX')===index,'LOG_TRANSACTION_ID');
    assert(typeof log.blockHash==='string'&&lower(log.blockHash)===h.hash&&quantity(log.blockNumber,'LOG_BLOCK_NUMBER')===h.number,'LOG_BLOCK_ID');
    const logIndex=quantity(log.logIndex,'LOG_INDEX');assert(logIndex===state.nextLog,'NONCONTIGUOUS_LOG_INDICES');state.nextLog++;
    assert(Array.isArray(log.topics)&&log.topics.length<=4&&log.topics.every(t=>typeof t==='string'&&HASH.test(t))&&typeof log.data==='string'&&BYTES.test(log.data),'LOG_ENCODING');
    if(lower(log.address)!==token||lower(log.topics[0]??'')!==TRANSFER)continue;
    assert(log.topics.length===3&&WORD.test(log.data),'TRANSFER_ENCODING');
    assert(log.topics.slice(1).every(t=>/^0x0{24}[0-9a-fA-F]{40}$/.test(t)),'TRANSFER_ADDRESS_PADDING');
    const from='0x'+lower(log.topics[1].slice(26)),to='0x'+lower(log.topics[2].slice(26));
    assert(from!==ZERO||to!==ZERO,'AMBIGUOUS_ZERO_TO_ZERO_TRANSFER');
    transfers.push({block_number:h.number,block_hash:h.hash,transaction_hash:tx,transaction_index:index,log_index:logIndex,from,to,amount_raw:BigInt(log.data).toString()});
  }
  return transfers;
}

/** No transaction writes. An RPC function takes (method, params) and returns the raw JSON result. */
export async function collectSupply(request,{rpc}={}){
  const transcript=[];let bytes=0;
  // Clone before calls so an injected provider cannot mutate the original evidence input.
  let retainedRequest=null,status='COLLECTED_AT_BLOCK',dataset=null,issues=[];
  async function call(method,params){
    assert(transcript.length<512,'CALL_BUDGET','INCOMPLETE');
    let result;
    try{result=await rpc(method,structuredClone(params));}
    catch(error){
      const entry={index:transcript.length,method,params,error:{code:Number.isInteger(error?.code)?error.code:null,kind:'RPC_FAILURE'}};
      transcript.push(entry);fail('RPC_UNAVAILABLE','RPC_CALL_FAILED');
    }
    let serialized;try{serialized=JSON.stringify(result);}catch{fail('INVALID_EVIDENCE','NON_JSON_RPC_RESULT');}
    assert(typeof serialized==='string','NON_JSON_RPC_RESULT');
    assert(Buffer.byteLength(serialized)<=COLLECTION_LIMITS.resultBytes,'RPC_RESULT_BUDGET','INCOMPLETE');
    const entry={index:transcript.length,method,params,result:JSON.parse(serialized)};
    bytes+=Buffer.byteLength(JSON.stringify(entry));assert(bytes<=COLLECTION_LIMITS.transcriptBytes,'TRANSCRIPT_BUDGET','INCOMPLETE');
    transcript.push(entry);return entry.result;
  }
  try{
    validateCollectRequest(request);retainedRequest=JSON.parse(JSON.stringify(request));
    assert(typeof rpc==='function','RPC_FUNCTION_REQUIRED','INVALID_REQUEST');
    const r=retainedRequest,token=lower(r.token.address);
    assert(quantity(await call('eth_chainId',[]),'CHAIN_ID')===4663,'CHAIN_ID_MISMATCH','IDENTITY_MISMATCH');
    const headers=[],seenTransactions=new Set();let transactionCount=0;
    for(let number=r.start.number;number<=r.end.number;number++){
      const h=parseHeader(await call('eth_getBlockByNumber',[hex(number),false]),number),previous=headers.at(-1);
      if(previous)assert(h.parent_hash===previous.hash&&h.timestamp>=previous.timestamp,'HEADER_CHAIN','CANONICALITY_FAILED');
      if(number===r.start.number)assert(h.hash===lower(r.start.hash),'START_PIN','CANONICALITY_FAILED');
      if(number===r.end.number)assert(h.hash===lower(r.end.hash),'END_PIN','CANONICALITY_FAILED');
      if(number>r.start.number){
        transactionCount+=h.transactions.length;assert(transactionCount<=COLLECTION_LIMITS.transactions,'TRANSACTION_BUDGET','INCOMPLETE');
        for(const tx of h.transactions){assert(!seenTransactions.has(tx),'TRANSACTION_IN_MULTIPLE_BLOCKS');seenTransactions.add(tx);}
      }
      headers.push(h);
    }
    async function snapshot(h){
      const block={blockHash:h.hash,requireCanonical:true};
      const code=await call('eth_getCode',[token,block]);
      assert(typeof code==='string'&&BYTES.test(code)&&code.length>2,'TOKEN_CODE_MISSING','IDENTITY_MISMATCH');
      const codeHash=keccakHex(Buffer.from(code.slice(2),'hex'));
      assert(codeHash===lower(r.token.expected_code_hash),'TOKEN_CODE_HASH','IDENTITY_MISMATCH');
      const read=data=>call('eth_call',[{to:token,data},block]);
      const total_supply_raw=word(await read(SIG['totalSupply()']),'TOTAL_SUPPLY_ENCODING');
      const decimals=word(await read(SIG['decimals()']),'DECIMALS_ENCODING');
      assert(BigInt(decimals)===BigInt(r.token.decimals),'TOKEN_DECIMALS','IDENTITY_MISMATCH');
      const multiplier_raw=word(await read(SIG['uiMultiplier()']),'MULTIPLIER_ENCODING');
      assert(BigInt(multiplier_raw)>0n,'ZERO_MULTIPLIER');
      const balances=[];
      for(const address of r.tracked_addresses){
        const balance_raw=word(await read(SIG['balanceOf(address)']+lower(address).slice(2).padStart(64,'0')),'BALANCE_ENCODING');
        balances.push({address:lower(address),balance_raw});
      }
      return {total_supply_raw,multiplier_raw,code_hash:codeHash,balances};
    }
    const snapshots={start:await snapshot(headers[0]),end:await snapshot(headers.at(-1))};
    const transfers=[],state={logs:0,nextLog:0};let receipts=0;
    for(const h of headers.slice(1)){
      state.nextLog=0;
      for(let index=0;index<h.transactions.length;index++){
        const tx=h.transactions[index];
        transfers.push(...decodeReceipt(await call('eth_getTransactionReceipt',[tx]),h,tx,index,state,token));receipts++;
      }
    }
    for(const h of [headers[0],headers.at(-1)]){
      const fresh=parseHeader(await call('eth_getBlockByNumber',[hex(h.number),false]),h.number);
      assert(canonical(fresh)===canonical(h),'FINAL_CANONICAL_HEADER_CHANGED','CANONICALITY_FAILED');
    }
    assert(quantity(await call('eth_chainId',[]),'FINAL_CHAIN_ID')===4663,'FINAL_CHAIN_CHANGED','IDENTITY_MISMATCH');
    assert(receipts===transactionCount,'RECEIPT_COVERAGE');
    const normalizedHeaders=headers.map(({transactions,...h})=>h);
    const first=normalizedHeaders[0],last=normalizedHeaders.at(-1);
    dataset={schema_version:'pressure.dataset.v1',evidence_mode:r.evidence_mode??'rpc_observed',chain_id:4663,token:{address:token,decimals:r.token.decimals,expected_code_hash:lower(r.token.expected_code_hash)},window:{start:{number:first.number,hash:first.hash,timestamp:first.timestamp},end:{number:last.number,hash:last.hash,timestamp:last.timestamp}},snapshots,headers:normalizedHeaders,transfers,coverage:{method:'full_receipts',complete:true,canonical_rechecked:true,missing_blocks:[],evidence_refs:['transcript:'+collectionDigest(transcript)],integrity:'provider_reported_receipt_enumeration',receipt_blocks:r.end.number-r.start.number,receipts_checked:receipts,logs_checked:state.logs,cryptographic_receipt_proof:false},identity_scope:{status:'ENDPOINT_RUNTIME_CODE_MATCH',expected_code_hash_source:'caller_supplied',proxy_implementation_verified:false,intermediate_code_changes_checked:false,token_semantics_independently_verified:false},attributions:structuredClone(r.attributions)};
  }catch(error){status=error instanceof CollectionError?error.status:'INVALID_REQUEST';issues=[{code:error instanceof CollectionError?error.code:'INVALID_INPUT',detail:'Collection did not establish a complete pinned dataset.'}];dataset=null;}
  const body={schema_version:'pressure.collection.v1',status,request:retainedRequest,dataset,transcript,issues};
  return {...body,digest:collectionDigest(body)};
}

/** Replay retained RPC results; hashes detect alteration, not provider truth or source authenticity. */
export async function validateCollection(report){
  const invalid=code=>({valid:false,status:'INVALID_COLLECTION',issues:[{code}]});
  try{
    if(!report||report.schema_version!=='pressure.collection.v1'||!ALLOWED_STATUS.has(report.status)||!Array.isArray(report.transcript)||report.transcript.length>512)return invalid('COLLECTION_SCHEMA');
    if(Buffer.byteLength(JSON.stringify(report))>COLLECTION_LIMITS.transcriptBytes+1024*1024)return invalid('COLLECTION_BUDGET');
    const {digest,...body}=report;if(digest!==collectionDigest(body))return invalid('COLLECTION_DIGEST');
    // Failed runs are retained diagnostics; they can never validate a completed dataset.
    if(report.status!=='COLLECTED_AT_BLOCK'||!report.dataset)return invalid('COLLECTION_NOT_COMPLETE');
    let cursor=0;
    const replay=await collectSupply(report.request,{rpc:async(method,params)=>{
      const entry=report.transcript[cursor++];
      if(!entry||entry.index!==cursor-1||entry.method!==method||canonical(entry.params)!==canonical(params)||Object.hasOwn(entry,'error')||!Object.hasOwn(entry,'result'))throw new Error('Transcript mismatch');
      return structuredClone(entry.result);
    }});
    if(cursor!==report.transcript.length||replay.status!=='COLLECTED_AT_BLOCK'||canonical(replay)!==canonical(report))return invalid('COLLECTION_REPLAY_MISMATCH');
    return {valid:true,status:'VALID_RETAINED_COLLECTION',digest,issues:[],limitation:'Replay verifies internal consistency of retained provider evidence; it does not authenticate the provider or prove receipt-trie inclusion.'};
  }catch{return invalid('COLLECTION_ENCODING');}
}
