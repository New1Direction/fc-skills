import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSupply,validateCollection,collectionDigest,COLLECTION_LIMITS} from './collect.mjs';
import {keccakHex} from './keccak.mjs';
const hash=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const qty=n=>'0x'+BigInt(n).toString(16),word=n=>hash(n),topic=a=>'0x'+a.slice(2).padStart(64,'0');
const TOKEN=address(10),ISSUER=address(11),VENUE=address(12),OTHER=address(13),ZERO=address(0),CODE='0x600060005260206000f3';
const H0=hash(100),H1=hash(101),TX0=hash(1000),TX1=hash(1001);
const transferTopic=keccakHex(Buffer.from('Transfer(address,address,uint256)'));
const uiTopic=keccakHex(Buffer.from('TransferWithScaledUI(address,address,uint256,uint256)'));
const sel=s=>keccakHex(Buffer.from(s)).slice(0,10);
function fixture(){
  const request={schema_version:'pressure.collect.v1',chain_id:4663,token:{address:TOKEN,decimals:18,expected_code_hash:keccakHex(Buffer.from(CODE.slice(2),'hex'))},start:{number:100,hash:H0},end:{number:101,hash:H1},tracked_addresses:[ISSUER,VENUE],attributions:[]};
  const headers={100:{number:'0x64',hash:H0,parentHash:hash(99),timestamp:'0x100',transactions:[]},101:{number:'0x65',hash:H1,parentHash:H0,timestamp:'0x101',transactions:[TX0,TX1]}};
  const makeLog=(tx,index,logIndex,from,to,amount)=>({address:TOKEN,blockNumber:'0x65',blockHash:H1,transactionHash:tx,transactionIndex:qty(index),logIndex:qty(logIndex),topics:[transferTopic,topic(from),topic(to)],data:word(amount),removed:false});
  const mint=makeLog(TX0,0,0,ZERO,ISSUER,100),scaled={...makeLog(TX0,0,1,ZERO,ISSUER,100),topics:[uiTopic,topic(ZERO),topic(ISSUER)],data:word(100)+word(100).slice(2)};
  const transfer=makeLog(TX1,1,2,ISSUER,VENUE,50);
  const receipts={
    [TX0]:{transactionHash:TX0,transactionIndex:'0x0',blockNumber:'0x65',blockHash:H1,status:'0x1',logs:[mint,scaled]},
    [TX1]:{transactionHash:TX1,transactionIndex:'0x1',blockNumber:'0x65',blockHash:H1,status:'0x1',logs:[transfer]}
  };
  const calls=[];
  async function rpc(method,params){
    calls.push({method,params:structuredClone(params)});
    if(method==='eth_chainId')return '0x1237';
    if(method==='eth_getBlockByNumber')return structuredClone(headers[Number(BigInt(params[0]))]);
    if(method==='eth_getTransactionReceipt')return structuredClone(receipts[params[0]]);
    if(method==='eth_getCode')return CODE;
    if(method==='eth_call'){
      const [call,pin]=params;assert.equal(call.to,TOKEN);assert.equal(pin.requireCanonical,true);assert([H0,H1].includes(pin.blockHash));
      const start=pin.blockHash===H0,data=call.data;
      if(data===sel('totalSupply()'))return word(start?100:200);
      if(data===sel('decimals()'))return word(18);
      if(data===sel('uiMultiplier()'))return word(start?10n**18n:2n*10n**18n);
      if(data.startsWith(sel('balanceOf(address)'))){const a='0x'+data.slice(-40);return word(a===ISSUER?(start?100:150):(start?0:50));}
    }
    throw new Error('unexpected rpc');
  }
  return {request,headers,receipts,calls,rpc};
}
function mutateRpc(f,change){return async(method,params)=>{const result=await f.rpc(method,params);return change(result,method,params,f);};}
async function expectFailure(f,code,{rpc=f.rpc,request=f.request}={}){const r=await collectSupply(request,{rpc});assert.notEqual(r.status,'COLLECTED_AT_BLOCK');assert.equal(r.dataset,null);assert.equal(r.issues[0].code,code);return r;}

test('full receipt collection retains raw evidence and counts standard Transfer once',async()=>{
  const f=fixture(),r=await collectSupply(f.request,{rpc:f.rpc});assert.equal(r.status,'COLLECTED_AT_BLOCK');
  assert.equal(r.dataset.transfers.length,2);assert.equal(r.dataset.transfers[0].amount_raw,'100');
  assert.equal(r.dataset.coverage.receipts_checked,2);assert.equal(r.dataset.coverage.logs_checked,3);
  assert.equal(r.dataset.coverage.cryptographic_receipt_proof,false);
  assert.equal(r.dataset.snapshots.start.multiplier_raw,'1000000000000000000');assert.equal(r.dataset.snapshots.end.multiplier_raw,'2000000000000000000');
  assert.equal(r.dataset.snapshots.end.total_supply_raw,'200');
  assert.equal(r.dataset.snapshots.end.balances[1].balance_raw,'50');
  assert.equal(f.calls.filter(c=>c.method==='eth_getLogs').length,0);
  assert.deepEqual(f.calls.filter(c=>c.method==='eth_getTransactionReceipt').map(c=>c.params[0]),[TX0,TX1]);
  assert.equal((await validateCollection(r)).valid,true);
});
test('local synthetic evidence remains explicitly synthetic',async()=>{const f=fixture();f.request.evidence_mode='synthetic';const r=await collectSupply(f.request,{rpc:f.rpc});assert.equal(r.dataset.evidence_mode,'synthetic');});
test('complete empty window at one exact block is valid',async()=>{const f=fixture();f.request.end=structuredClone(f.request.start);const r=await collectSupply(f.request,{rpc:f.rpc});assert.equal(r.status,'COLLECTED_AT_BLOCK');assert.equal(r.dataset.coverage.receipts_checked,0);assert.equal(r.dataset.headers.length,1);});
test('provider errors retain numeric code without prose or endpoint secret',async()=>{const f=fixture();const r=await expectFailure(f,'RPC_CALL_FAILED',{rpc:async()=>{const e=new Error('https://host/key-secret');e.code=-32000;throw e;}});assert.equal(r.status,'RPC_UNAVAILABLE');assert.equal(r.transcript[0].error.code,-32000);assert(!JSON.stringify(r).includes('key-secret'));});
test('null receipt is incomplete evidence, never an empty event result',async()=>{const f=fixture();f.receipts[TX1]=null;await expectFailure(f,'RECEIPT_MISSING');});
test('every unrelated transaction receipt is still fetched',async()=>{const f=fixture();f.receipts[TX1].logs[0].address=OTHER;const r=await collectSupply(f.request,{rpc:f.rpc});assert.equal(r.status,'COLLECTED_AT_BLOCK');assert.equal(r.dataset.transfers.length,1);assert.equal(r.dataset.coverage.receipts_checked,2);});
test('failed transaction with no logs preserves receipt coverage',async()=>{const f=fixture();f.receipts[TX1].status='0x0';f.receipts[TX1].logs=[];const r=await collectSupply(f.request,{rpc:f.rpc});assert.equal(r.status,'COLLECTED_AT_BLOCK');assert.equal(r.dataset.coverage.receipts_checked,2);});

const receiptCases=[
  ['forged receipt transaction hash','RECEIPT_TRANSACTION_ID',f=>f.receipts[TX1].transactionHash=hash(2000)],
  ['wrong receipt transaction index','RECEIPT_TRANSACTION_ID',f=>f.receipts[TX1].transactionIndex='0x0'],
  ['wrong receipt block hash','RECEIPT_BLOCK_ID',f=>f.receipts[TX1].blockHash=hash(222)],
  ['wrong receipt block number','RECEIPT_BLOCK_ID',f=>f.receipts[TX1].blockNumber='0x66'],
  ['missing receipt status','RECEIPT_STATUS',f=>delete f.receipts[TX1].status],
  ['failed receipt cannot retain logs','FAILED_RECEIPT_HAS_LOGS',f=>f.receipts[TX1].status='0x0'],
  ['missing logs field','RECEIPT_LOGS',f=>delete f.receipts[TX1].logs],
  ['omitted middle receipt log is caught by block global index','NONCONTIGUOUS_LOG_INDICES',f=>f.receipts[TX0].logs.pop()],
  ['duplicate block log index','NONCONTIGUOUS_LOG_INDICES',f=>f.receipts[TX1].logs[0].logIndex='0x1'],
  ['removed receipt log','REMOVED_LOG',f=>f.receipts[TX1].logs[0].removed=true],
  ['foreign log transaction','LOG_TRANSACTION_ID',f=>f.receipts[TX1].logs[0].transactionHash=TX0],
  ['foreign log block','LOG_BLOCK_ID',f=>f.receipts[TX1].logs[0].blockHash=H0],
  ['odd-length log data','LOG_ENCODING',f=>f.receipts[TX1].logs[0].data='0x1'],
  ['malformed Transfer amount','TRANSFER_ENCODING',f=>f.receipts[TX1].logs[0].data='0x1234'],
  ['ERC721-shaped Transfer is not decoded as ERC20','TRANSFER_ENCODING',f=>f.receipts[TX1].logs[0].topics.push(hash(99))],
  ['nonzero address ABI padding','TRANSFER_ADDRESS_PADDING',f=>f.receipts[TX1].logs[0].topics[1]='0x'+'1'.repeat(24)+ISSUER.slice(2)],
  ['ambiguous zero to zero transfer','AMBIGUOUS_ZERO_TO_ZERO_TRANSFER',f=>{f.receipts[TX1].logs[0].topics[1]=topic(ZERO);f.receipts[TX1].logs[0].topics[2]=topic(ZERO);}]
];
for(const [name,code,mutate] of receiptCases)test(name,async()=>{const f=fixture();mutate(f);await expectFailure(f,code);});
test('standard zero-amount transfer remains retained evidence',async()=>{const f=fixture();f.receipts[TX1].logs[0].data=word(0);const r=await collectSupply(f.request,{rpc:f.rpc});assert.equal(r.dataset.transfers[1].amount_raw,'0');});

const requestCases=[
  ['wrong schema','SCHEMA_OR_CHAIN',r=>r.schema_version='other'],
  ['wrong requested chain','SCHEMA_OR_CHAIN',r=>r.chain_id=1],
  ['unrecognized evidence mode','EVIDENCE_MODE',r=>r.evidence_mode='verified'],
  ['invalid decimals','TOKEN_IDENTITY',r=>r.token.decimals=37],
  ['invalid code hash','TOKEN_IDENTITY',r=>r.token.expected_code_hash='0x'],
  ['reversed window','BLOCK_PINS',r=>r.start.number=102],
  ['same block conflicting pin','SAME_BLOCK_DIFFERENT_HASH',r=>r.end.number=r.start.number],
  ['block budget fails before network','BLOCK_BUDGET',r=>r.end.number=r.start.number+65],
  ['address budget fails before network','ADDRESS_BUDGET',r=>r.tracked_addresses=Array.from({length:21},(_,i)=>address(i+1))],
  ['duplicate tracked address','TRACKED_ADDRESSES',r=>r.tracked_addresses=[ISSUER,ISSUER]],
  ['tracked zero address rejected','TRACKED_ADDRESSES',r=>r.tracked_addresses=[ZERO]],
  ['unattributed source label rejected','ATTRIBUTION_SCHEMA',r=>r.attributions=[{address:ISSUER,category:'issuer',label:'issuer'}]],
  ['invalid attribution category','ATTRIBUTION_SCHEMA',r=>r.attributions=[{address:ISSUER,category:'AP_VERIFIED',label:'issuer',valid_from_block:0,valid_to_block:101,evidence_refs:['source']}]]
];
for(const [name,code,mutate] of requestCases)test(name,async()=>{const f=fixture();mutate(f.request);await expectFailure(f,code);assert.equal(f.calls.length,0);});
test('invalid caller data cannot crash collection',async()=>{const r=await collectSupply(null,{rpc:async()=>{throw Error();}});assert.equal(r.status,'INVALID_REQUEST');assert.equal(r.dataset,null);});
test('request snapshot cannot be changed by provider',async()=>{const f=fixture();const rpc=async(method,params)=>{if(method==='eth_chainId')f.request.token.decimals=0;return f.rpc(method,params);};const r=await collectSupply(f.request,{rpc});assert.equal(r.status,'COLLECTED_AT_BLOCK');assert.equal(r.request.token.decimals,18);});

const headerCases=[
  ['header missing','HEADER_NUMBER',f=>f.headers[101]=null],
  ['wrong header number','HEADER_NUMBER',f=>f.headers[101].number='0x66'],
  ['changed end pin','END_PIN',f=>f.headers[101].hash=hash(666)],
  ['broken parent chain','HEADER_CHAIN',f=>f.headers[101].parentHash=hash(98)],
  ['backwards block timestamp','HEADER_CHAIN',f=>f.headers[101].timestamp='0xff'],
  ['header duplicate transaction','DUPLICATE_HEADER_TRANSACTION',f=>f.headers[101].transactions=[TX0,TX0]],
  ['full transaction objects rejected','HEADER_TRANSACTIONS',f=>f.headers[101].transactions=[{hash:TX0}]],
  ['transaction budget stops before receipts','TRANSACTION_BUDGET',f=>f.headers[101].transactions=Array.from({length:257},(_,i)=>hash(i+1000))]
];
for(const [name,code,mutate] of headerCases)test(name,async()=>{const f=fixture();mutate(f);await expectFailure(f,code);assert.equal(f.calls.filter(x=>x.method==='eth_getTransactionReceipt').length,0);});
test('canonical endpoint recheck detects reorg after initial read',async()=>{const f=fixture();let n=0;const rpc=mutateRpc(f,(r,m,p)=>{if(m==='eth_getBlockByNumber'&&p[0]==='0x65'&&++n===2)r.hash=hash(777);return r;});await expectFailure(f,'FINAL_CANONICAL_HEADER_CHANGED',{rpc});});
test('endpoint transaction list changed under same claimed hash also fails',async()=>{const f=fixture();let n=0;const rpc=mutateRpc(f,(r,m,p)=>{if(m==='eth_getBlockByNumber'&&p[0]==='0x65'&&++n===2)r.transactions.pop();return r;});await expectFailure(f,'FINAL_CANONICAL_HEADER_CHANGED',{rpc});});
test('chain switch during collection fails final identity check',async()=>{const f=fixture();let n=0;const rpc=mutateRpc(f,(r,m)=>m==='eth_chainId'&&++n===2?'0x1':r);await expectFailure(f,'FINAL_CHAIN_CHANGED',{rpc});});
test('wrong chain rejected before any header',async()=>{const f=fixture();await expectFailure(f,'CHAIN_ID_MISMATCH',{rpc:async()=>'0x1'});});

test('end-block code drift blocks dataset',async()=>{const f=fixture();const rpc=mutateRpc(f,(r,m,p)=>m==='eth_getCode'&&p[1].blockHash===H1?'0x6001':r);await expectFailure(f,'TOKEN_CODE_HASH',{rpc});});
test('empty code is not an ERC20 deployment',async()=>{const f=fixture();await expectFailure(f,'TOKEN_CODE_MISSING',{rpc:mutateRpc(f,(r,m)=>m==='eth_getCode'?'0x':r)});});
test('decimals read must match exact expected decimals',async()=>{const f=fixture();await expectFailure(f,'TOKEN_DECIMALS',{rpc:mutateRpc(f,(r,m,p)=>m==='eth_call'&&p[0].data===sel('decimals()')?word(6):r)});});
test('missing multiplier return cannot be silently replaced with one',async()=>{const f=fixture();await expectFailure(f,'MULTIPLIER_ENCODING',{rpc:mutateRpc(f,(r,m,p)=>m==='eth_call'&&p[0].data===sel('uiMultiplier()')?'0x':r)});});
test('zero multiplier invalidates stock token observation',async()=>{const f=fixture();await expectFailure(f,'ZERO_MULTIPLIER',{rpc:mutateRpc(f,(r,m,p)=>m==='eth_call'&&p[0].data===sel('uiMultiplier()')?word(0):r)});});
test('uint256 supply retains exact precision beyond JavaScript number range',async()=>{const f=fixture();const amount=(1n<<255n)-1n;const r=await collectSupply(f.request,{rpc:mutateRpc(f,(r,m,p)=>m==='eth_call'&&p[0].data===sel('totalSupply()')?word(amount):r)});assert.equal(r.dataset.snapshots.start.total_supply_raw,amount.toString());});
test('oversized result stops and returns no partial dataset',async()=>{const f=fixture();await expectFailure(f,'RPC_RESULT_BUDGET',{rpc:async()=>({padding:'a'.repeat(COLLECTION_LIMITS.resultBytes)})});});
test('all state reads use canonical hash pins, never latest',async()=>{const f=fixture();await collectSupply(f.request,{rpc:f.rpc});for(const c of f.calls.filter(c=>['eth_call','eth_getCode'].includes(c.method)))assert.deepEqual(c.params[1],{blockHash:c.params[1].blockHash,requireCanonical:true});assert(!JSON.stringify(f.calls).includes('latest'));});

test('tampered normalized data fails digest check',async()=>{const f=fixture(),r=await collectSupply(f.request,{rpc:f.rpc});r.dataset.transfers[0].amount_raw='999';assert.equal((await validateCollection(r)).issues[0].code,'COLLECTION_DIGEST');});
test('rehashed tampered normalized data fails transcript replay',async()=>{const f=fixture(),r=await collectSupply(f.request,{rpc:f.rpc});r.dataset.transfers[0].amount_raw='999';const {digest,...body}=r;r.digest=collectionDigest(body);assert.equal((await validateCollection(r)).issues[0].code,'COLLECTION_REPLAY_MISMATCH');});
test('omitted retained receipt cannot be repaired with a digest',async()=>{const f=fixture(),r=await collectSupply(f.request,{rpc:f.rpc});r.transcript.splice(r.transcript.findIndex(x=>x.method==='eth_getTransactionReceipt'),1);const {digest,...body}=r;r.digest=collectionDigest(body);assert.equal((await validateCollection(r)).valid,false);});
test('extra retained calls fail exact replay consumption',async()=>{const f=fixture(),r=await collectSupply(f.request,{rpc:f.rpc});r.transcript.push({index:r.transcript.length,method:'eth_chainId',params:[],result:'0x1237'});const {digest,...body}=r;r.digest=collectionDigest(body);assert.equal((await validateCollection(r)).valid,false);});
test('failed collection cannot validate as a completed dataset',async()=>{const f=fixture();f.receipts[TX1]=null;const r=await collectSupply(f.request,{rpc:f.rpc});assert.equal((await validateCollection(r)).issues[0].code,'COLLECTION_NOT_COMPLETE');});
test('canonical digest is stable across object key order',()=>{assert.equal(collectionDigest({b:1,a:{z:2}}),collectionDigest({a:{z:2},b:1}));});
