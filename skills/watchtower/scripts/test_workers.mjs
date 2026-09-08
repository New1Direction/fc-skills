import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { routeEvents,runJobs,workerStatus,requeueExpired,readClassifications,readOutbox,normalizePolicy } from './workers.mjs';

const h=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const a=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const hex=n=>'0x'+n.toString(16);
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function block(number=10,count=4,salt=0,parent=h(number-1)) {
  const hash=h(number+salt*1000);
  return {number:hex(number),hash,parentHash:parent,timestamp:'0x65000000',transactions:Array.from({length:count},(_,i)=>({
    hash:h(100+number*10+i+salt*10000),blockHash:hash,blockNumber:hex(number),transactionIndex:hex(i),from:a(1),to:i===2?null:a(i===0?20:21),
    nonce:hex(i),gas:'0x186a0',value:i===0?'0x64':'0x0',type:i===1?'0x7f':'0x2',input:i===0?'0x':i===2?'0x60006000f3':'0x12345678',unknownProviderField:i===1?'retain-me':null
  }))};
}
function receipts(b) {
  return b.transactions.map((tx,i)=>({transactionHash:tx.hash,transactionIndex:hex(i),blockHash:b.hash,blockNumber:b.number,
    status:i===3?'0x0':'0x1',from:tx.from,to:tx.to,contractAddress:i===2?a(77):null,gasUsed:'0x5208',
    logs:i===1?[{address:a(20),topics:[TRANSFER,h(1),h(2)],data:h(250),logIndex:'0x0',transactionHash:tx.hash,transactionIndex:hex(i),blockHash:b.hash,blockNumber:b.number,removed:false},
      {address:a(21),topics:[h(99)],data:'0xdeadbeef',logIndex:'0x1',transactionHash:tx.hash,transactionIndex:hex(i),blockHash:b.hash,blockNumber:b.number,removed:false}]:[]}));
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'watchtower-workers-')),path=join(dir,'store.db');let store=openStore(path,{chainId:4663,startBlock:10,maxBytes:16*1024*1024,reorgDepth:32});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},reopen(){store.close();store=openStore(path);return store;}};
}
const rule={id:'supply-token-20',skill:'pressure',target:{chain_id:4663,token_address:a(20)},match:{log_address:a(20),topic0:TRANSFER}};
const callRule={id:'inspect-contract',skill:'hook-lab',target:{chain_id:4663,contract_address:a(21)},match:{transaction_to:a(21)}};
async function drain(store,policy={version:'v1'}){const routed=routeEvents(store,{policy,limit:1000});const ran=await runJobs(store,{limit:1000});return {routed,ran};}

test('every included top-level transaction is classified before receipts without dropping unknown types',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);const {ran}=await drain(store);
  assert.equal(ran.completed,1);const rows=readClassifications(store,{blockHash:b.hash});assert.equal(rows.length,4);
  assert.deepEqual(rows.map(r=>r.execution_status),['UNKNOWN','UNKNOWN','UNKNOWN','UNKNOWN']);
  assert.equal(rows[1].type_status,'UNKNOWN_ENVELOPE_TYPE');assert.equal(rows[1].raw_input,'0x12345678');assert.equal(rows[2].top_level_kind,'CONTRACT_CREATION');
  assert.equal(rows[0].has_native_value,true);assert.equal(rows[0].value_raw,'0x64');assert.equal(rows[1].coverage.internal_calls,'NOT_COLLECTED');
  assert.equal(store.transactions(b.hash)[1].unknownProviderField,'retain-me');
});

test('receipts enrich successful and reverted statuses and retain unknown event topics',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);await drain(store);store.putReceipts(b.hash,receipts(b));await drain(store);
  const rows=readClassifications(store,{blockHash:b.hash});assert.deepEqual(rows.map(r=>r.execution_status),['SUCCESS','SUCCESS','SUCCESS','REVERTED']);
  assert.equal(rows[1].logs[0].topic_class,'TRANSFER_SIGNATURE');assert.equal(rows[1].logs[1].topic_class,'UNKNOWN_TOPIC');
  assert.equal(rows[1].logs[1].data,'0xdeadbeef');assert.equal(rows[2].created_contract,a(77));assert.equal(workerStatus(store).classifications.with_receipts,4);
});

test('receipt-complete processing cannot regress enriched classification through another policy',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);store.putReceipts(b.hash,receipts(b));await drain(store);await drain(store,{version:'v2'});
  assert.equal(readClassifications(store,{blockHash:b.hash})[3].execution_status,'REVERTED');assert.equal(workerStatus(store).classifications.total,4);
});

test('empty block and empty receipts both produce completed classification jobs',async t=>{
  const {store}=fixture(t),b=block(10,0);store.putBlock(b);store.putReceipts(b.hash,[]);const {ran}=await drain(store);
  assert.equal(ran.completed,2);assert.equal(readOutbox(store).length,2);assert.equal(readClassifications(store,{blockHash:b.hash}).length,0);
});

test('durable event cursor and completed jobs survive restart without duplicates',async t=>{
  const fx=fixture(t),b=block();fx.store.putBlock(b);await drain(fx.store);const first=workerStatus(fx.store);
  fx.reopen();const {routed,ran}=await drain(fx.store);assert.equal(routed.processed_events,0);assert.equal(ran.attempted,0);
  assert.equal(workerStatus(fx.store).outbox.total,first.outbox.total);assert.equal(readClassifications(fx.store,{blockHash:b.hash}).length,4);
});

test('queued jobs survive restart and finish once',async t=>{
  const fx=fixture(t),b=block();fx.store.putBlock(b);routeEvents(fx.store);fx.reopen();assert.equal((await runJobs(fx.store)).completed,1);assert.equal((await runJobs(fx.store)).attempted,0);
});

test('exact receipt rule produces a reviewable research intent with original identity',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);store.putReceipts(b.hash,receipts(b));await drain(store,{version:'v1',rules:[rule]});
  const intents=readOutbox(store).filter(r=>r.kind==='research_dispatch');assert.equal(intents.length,1);
  const body=intents[0].body;assert.equal(body.dispatch_state,'PENDING_CONSUMER_REVIEW');assert.equal(body.target.token_address,a(20));
  assert.equal(body.matches[0].transaction_hash,b.transactions[1].hash);assert.equal(body.matches[0].log_index,0);assert.equal(body.block.hash,b.hash);
  assert.match(body.limitations.join(' '),/no skill analysis/);assert.equal(body.coverage_at_dispatch.chain_id,4663);
});

test('receipt-specific rule does not manufacture matches before receipts or on other addresses',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);await drain(store,{version:'v1',rules:[rule]});assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,0);
  const wrong={...rule,target:{chain_id:4663,token_address:a(22)},match:{log_address:a(22),topic0:TRANSFER}};
  store.putReceipts(b.hash,receipts(b));await drain(store,{version:'v2',rules:[wrong]});assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,0);
});

test('exact contract-call target dispatch retains unknown execution status',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);await drain(store,{version:'v1',rules:[callRule]});
  const body=readOutbox(store).find(r=>r.kind==='research_dispatch').body;assert.equal(body.matches.length,2);assert.ok(body.matches.every(m=>m.receipt_status==='UNKNOWN'));
});

test('pool target requires exact indexed pool identity in the rule',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);store.putReceipts(b.hash,receipts(b));
  const poolRule={id:'pool',skill:'ignition',target:{chain_id:4663,contract_address:a(20),pool_id:h(1)},match:{log_address:a(20),topic0:TRANSFER,topic1:h(1)}};
  await drain(store,{version:'v1',rules:[poolRule]});assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,1);
  assert.throws(()=>normalizePolicy({version:'v2',rules:[{...poolRule,match:{...poolRule.match,topic1:h(2)}}]}),/pool target/);
});

test('policy version cannot silently change matching rules or resource bounds',t=>{
  const {store}=fixture(t);routeEvents(store,{policy:{version:'v1'}});assert.throws(()=>routeEvents(store,{policy:{version:'v1',max_queue:42}}),/different contents/);
});

test('unknown policy fields, target mismatch, duplicate rule IDs and unsupported skills fail closed',()=>{
  assert.throws(()=>normalizePolicy({version:'v1',command:'curl example'}),/unknown policy/);
  assert.throws(()=>normalizePolicy({version:'v1',rules:[{...rule,target:{chain_id:4663,token_address:a(30)}}]}),/target does not match/);
  assert.throws(()=>normalizePolicy({version:'v1',rules:[rule,rule]}),/duplicate/);
  assert.throws(()=>normalizePolicy({version:'v1',rules:[{...rule,skill:'execute-trade'}]}),/unsupported skill/);
  assert.throws(()=>normalizePolicy({version:'v1',lease_ms:10,timeout_ms:10}),/must exceed/);
});

test('queue capacity pauses before unprocessed event then resumes after drain without loss',async t=>{
  const {store}=fixture(t),b=block(10,1),next=block(11,1,0,b.hash);store.putBlock(b);store.putBlock(next);const policy={version:'v1',max_queue:1};
  const first=routeEvents(store,{policy});assert.equal(first.processed_events,1);assert.equal(first.paused,true);assert.equal(first.reason,'QUEUE_CAPACITY');
  await runJobs(store);const second=routeEvents(store,{policy});assert.equal(second.processed_events,1);await runJobs(store);
  assert.equal(workerStatus(store).classifications.canonical,2);assert.equal(store.coverage().transaction_count,2);
});

test('all tasks for an event enqueue atomically or leave its cursor unchanged',t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);const out=routeEvents(store,{policy:{version:'v1',max_queue:1,rules:[callRule]}});
  assert.equal(out.cursor,0);assert.equal(out.enqueued_jobs,0);assert.equal(out.paused,true);assert.equal(workerStatus(store).jobs.QUEUED,undefined);
});

test('reorg invalidates completed outbox and classifications while retaining audit history',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);await drain(store);const replacement=block(10,1,1);store.putBlock(replacement);await drain(store);
  assert.equal(readClassifications(store,{blockHash:b.hash}).length,0);assert.equal(readClassifications(store,{blockHash:b.hash,includeInvalidated:true}).length,4);
  assert.ok(readOutbox(store).filter(r=>r.kind!=='evidence_invalidated').every(r=>r.block_hash===replacement.hash));assert.ok(readOutbox(store,{includeInvalidated:true}).some(r=>!r.canonical));
  assert.equal(workerStatus(store).jobs.INVALIDATED,1);
});

test('jobs queued before a reorg cannot run on orphaned blocks even before routing invalidation',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store);store.rewind(10,'fixture reorg');
  assert.equal((await runJobs(store)).attempted,0);assert.equal(workerStatus(store).jobs.INVALIDATED,1);assert.equal(readOutbox(store).length,0);
});

test('in-flight research response is discarded if its source block becomes orphaned',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',rules:[callRule]}});
  await runJobs(store,{limit:10,handlers:{research:async()=>{store.rewind(10,'during handler');return {note:'late result'};}}});
  assert.equal(readOutbox(store).filter(r=>r.kind!=='evidence_invalidated').length,0);assert.ok((workerStatus(store).jobs.INVALIDATED??0)>=1);
});

test('research timeout respects finite attempts and records no provider error secrets',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',rules:[callRule],timeout_ms:5,lease_ms:100,max_attempts:2}});
  const result=await runJobs(store,{limit:10,handlers:{research:async()=>new Promise(()=>{})}});
  assert.equal(result.failed,1);const failed=store.db.prepare("SELECT * FROM wt_jobs WHERE kind='research'").get();
  assert.equal(failed.attempts,2);assert.equal(failed.error_code,'HANDLER_TIMEOUT');assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,0);
});

test('arbitrary handler failures retain fixed error codes without raw secrets',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',rules:[callRule],max_attempts:1}});
  await runJobs(store,{handlers:{research:()=>{throw new Error('https://secret-key.example/token');}}});
  const failed=store.db.prepare("SELECT * FROM wt_jobs WHERE kind='research'").get();assert.equal(failed.error_code,'HANDLER_FAILED');assert.equal(JSON.stringify(failed).includes('secret-key'),false);
});

test('expired worker lease is retried and eventually terminal after attempt bound',t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',max_attempts:2}});
  store.mutate(()=>store.db.prepare("UPDATE wt_jobs SET status='RUNNING',attempts=1,lease_until=100,lease_token='old'").run());
  assert.deepEqual(requeueExpired(store,{now:101}),{requeued:1,failed:0});
  store.mutate(()=>store.db.prepare("UPDATE wt_jobs SET status='RUNNING',attempts=2,lease_until=200,lease_token='older'").run());
  assert.deepEqual(requeueExpired(store,{now:201}),{requeued:0,failed:1});assert.equal(workerStatus(store).jobs.FAILED,1);
});

test('stale handler cannot complete a job after another worker expires its lease',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',rules:[callRule],lease_ms:100,timeout_ms:50,max_attempts:1}});
  await runJobs(store,{limit:10,now:1000,handlers:{research:()=>{requeueExpired(store,{now:1200});return {late:true};}}});
  assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,0);assert.equal(workerStatus(store).jobs.FAILED,1);
});

test('oversized handler result fails boundedly without committing partial intent',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',rules:[callRule],max_result_bytes:8192,max_attempts:1}});
  await runJobs(store,{handlers:{research:()=>({text:'x'.repeat(9000)})}});
  assert.equal(store.db.prepare("SELECT error_code FROM wt_jobs WHERE kind='research'").get().error_code,'RESULT_BYTE_LIMIT');assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,0);
});

test('research output remains dispatch intent even when extension contains claimed results',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);routeEvents(store,{policy:{version:'v1',rules:[callRule]}});
  await runJobs(store,{handlers:{research:async(_job,{dispatch})=>{dispatch.dispatch_state='EXECUTED';return {claim:'caller supplied'};}}});
  const body=readOutbox(store).find(r=>r.kind==='research_dispatch').body;assert.equal(body.dispatch_state,'PENDING_CONSUMER_REVIEW');assert.equal(body.consumer_extension.claim,'caller supplied');
});

test('classification of disconnected retained blocks keeps chain coverage visibly incomplete',async t=>{
  const {store}=fixture(t),b=block(12,1);store.putBlock(b);await drain(store);const status=workerStatus(store);
  assert.equal(status.classifications.canonical,1);assert.equal(status.coverage.complete_through_head,false);assert.ok(status.coverage.gaps.length>0);
});

test('outbox cursor pagination does not duplicate completed records',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);store.putReceipts(b.hash,receipts(b));await drain(store);
  const first=readOutbox(store,{limit:1});const next=readOutbox(store,{after:first[0].seq,limit:1});assert.equal(first.length,1);assert.equal(next.length,1);assert.notEqual(first[0].seq,next[0].seq);
});

test('cursor consumer receives explicit retraction after previously published evidence is orphaned',async t=>{
  const {store}=fixture(t),b=block();store.putBlock(b);await drain(store);const published=readOutbox(store),cursor=published.at(-1).seq;
  store.rewind(10,'retract fixture');const next=readOutbox(store,{after:cursor});assert.equal(next.length,1);assert.equal(next[0].kind,'evidence_invalidated');
  assert.equal(next[0].body.invalidated_job_id,published[0].job_id);assert.equal(next[0].canonical,false);
  assert.equal(readOutbox(store,{after:next[0].seq}).length,0);
});

test('a restored canonical block is reclassified with retained receipts and a new dispatch generation',async t=>{
  const {store}=fixture(t),b=block();const policy={version:'v1',rules:[rule]};store.putBlock(b);store.putReceipts(b.hash,receipts(b));await drain(store,policy);
  const initial=readOutbox(store).find(r=>r.kind==='research_dispatch');store.rewind(10,'temporary orphan');workerStatus(store);store.putBlock(b);await drain(store,policy);
  assert.equal(readClassifications(store,{blockHash:b.hash}).length,4);assert.equal(readClassifications(store,{blockHash:b.hash})[3].execution_status,'REVERTED');
  const current=readOutbox(store).filter(r=>r.kind==='research_dispatch');assert.equal(current.length,1);assert.notEqual(current[0].job_id,initial.job_id);
  await drain(store,{...policy,version:'v2'});assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch'&&r.body.policy_version==='v2').length,1);
});

test('rapid orphan and restoration between worker calls retracts old generation before publishing replacement',async t=>{
  const {store}=fixture(t),b=block(),policy={version:'v1',rules:[callRule]};store.putBlock(b);await drain(store,policy);
  const old=readOutbox(store).find(r=>r.kind==='research_dispatch');store.rewind(10,'rapid reorg');store.putBlock(b);
  const outputs=readOutbox(store);assert.equal(outputs.filter(r=>r.kind==='research_dispatch').length,0);
  assert.ok(outputs.some(r=>r.kind==='evidence_invalidated'&&r.body.invalidated_job_id===old.job_id));
  await drain(store,policy);assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,1);
});

test('in-flight handler cannot commit after rapid orphan and restoration of the identical block hash',async t=>{
  const {store}=fixture(t),b=block(),policy={version:'v1',rules:[callRule]};store.putBlock(b);routeEvents(store,{policy});
  await runJobs(store,{limit:10,handlers:{research:()=>{store.rewind(10,'handler reorg');store.putBlock(b);return {late:true};}}});
  assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,0);
  await drain(store,policy);assert.equal(readOutbox(store).filter(r=>r.kind==='research_dispatch').length,1);
});

test('missing transaction fields remain unknown rather than zero-valued transfers',async t=>{
  const {store}=fixture(t),b=block(10,1);delete b.transactions[0].value;delete b.transactions[0].input;delete b.transactions[0].type;store.putBlock(b);await drain(store);
  const row=readClassifications(store,{blockHash:b.hash})[0];assert.equal(row.has_native_value,null);assert.equal(row.value_raw,null);assert.equal(row.raw_input,null);
  assert.equal(row.top_level_kind,'UNKNOWN_CALL_DATA');assert.equal(row.raw_type,null);assert.equal(row.type_status,'UNKNOWN_ENVELOPE_TYPE');
});
