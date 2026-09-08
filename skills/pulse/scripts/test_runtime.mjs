import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal,context,observation,readJournal,validateConfig,scopeFingerprint} from './common.mjs';
import {runService} from './runtime.mjs';
import {serve} from './api.mjs';

const config={chain_id:4663,sources:[{name:'mock',http_env:'MOCK_HTTP',ws_env:'MOCK_WS'}],addresses:['0x'+'11'.repeat(20)],duration_seconds:1};
async function temp(t) {const dir=await mkdtemp(join(tmpdir(),'pulse-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const obs=()=>observation(context(),'mock','head','block:x',{chain_id:4663});

test('journal serializes concurrent append with continuous durable sequence',async t=>{
 const path=join(await temp(t),'events.jsonl'),j=new Journal(path);await j.start();
 assert.deepEqual(await Promise.all(Array.from({length:20},()=>j.append(obs(),{durable:true}))),Array.from({length:20},(_,i)=>i+1));
 await j.close();const records=[];const summary=await readJournal(path,r=>records.push(r));
 assert.equal(summary.count,20);assert.equal(records[19].seq,20);
});
test('journal recovers only an incomplete trailing write',async t=>{
 const path=join(await temp(t),'events.jsonl'),j=new Journal(path);await j.start();await j.append(obs());await j.close();
 const complete=await readFile(path);await writeFile(path,Buffer.concat([complete,Buffer.from('{"schema_')]));
 const next=new Journal(path),result=await next.start();assert.equal(result.recovered_records,1);assert.equal(result.truncated_tail_bytes,9);
 await next.append(obs());await next.close();let count=0;await readJournal(path,()=>count++);assert.equal(count,2);
});
test('complete corrupt journal lines fail without rewriting evidence',async t=>{
 const path=join(await temp(t),'events.jsonl');await writeFile(path,'broken\n');const j=new Journal(path);
 await assert.rejects(j.start(),/corrupt/);assert.equal(await readFile(path,'utf8'),'broken\n');
});
test('journal lock excludes a second writer without deleting first lock',async t=>{
 const path=join(await temp(t),'events.jsonl'),a=new Journal(path),b=new Journal(path);await a.start();
 await assert.rejects(b.start(),{code:'EEXIST'});await b.close();assert.ok(await stat(path+'.lock'));await a.close();
});
test('journal byte budget fails closed and preserves earlier complete records',async t=>{
 const path=join(await temp(t),'events.jsonl'),j=new Journal(path,{maxBytes:1024});await j.start();await j.append(obs());
 await assert.rejects(j.append({...obs(),payload:{big:'x'.repeat(1024)}}),/journal full/);await assert.rejects(j.append(obs()),/unavailable/);await j.close();
 let count=0;await readJournal(path,()=>count++);assert.equal(count,1);
});
test('readJournal rejects an oversized line',async t=>{
 const path=join(await temp(t),'events.jsonl');await writeFile(path,JSON.stringify({a:'x'.repeat(100)})+'\n');
 await assert.rejects(readJournal(path,()=>{},{maxLineBytes:50}),/line exceeds/);
});
test('config binds Robinhood identity, explicit scope, finite budgets and env references',()=>{
 assert.equal(validateConfig(config).max_backfill_blocks,200);
 for(const changed of [{chain_id:1},{addresses:[]},{queue_limit:Infinity},{sources:[{name:'a',http_env:'https://key-secret',ws_env:'W'}]},
   {sources:[{name:'a',http_env:'H',ws_env:'W',token:'secret'}]},{primary_source:'unknown'}]) assert.throws(()=>validateConfig({...config,...changed}));
});
test('scope fingerprint ignores log-address case but changes registry/provider scope',()=>{
 const c=validateConfig(config);assert.equal(scopeFingerprint(c),scopeFingerprint({...c,addresses:c.addresses.map(x=>x.toUpperCase().replace('0X','0x'))}));
 assert.notEqual(scopeFingerprint(c),scopeFingerprint(c,{pools:[]}));
});
test('loopback API rejects writes and reports expired replay cursor',async()=>{
 const api=await serve({health:()=>({status:'OK'}),snapshot:()=>({pools:[]}),events:()=>({status:'CURSOR_EXPIRED'})});
 try {const url=`http://127.0.0.1:${api.address.port}`;assert.equal((await fetch(url+'/health')).status,200);
  assert.equal((await fetch(url+'/health',{method:'POST'})).status,405);assert.equal((await fetch(url+'/v1/events?after=0')).status,410);
  assert.equal((await fetch(url+'/v1/events?limit=1001')).status,400);assert.equal((await fetch(url+'/missing')).status,404);
 }finally{await api.close();}
});
test('runtime persists checkpoints and resumes with a new monotonic clock',async t=>{
 const out=join(await temp(t),'events.jsonl'),runs=[];
 const collectImpl=async(c,{emit})=>{runs.push(c);await emit(observation(c,'mock','health','checkpoint:10',{kind:'checkpoint',next_block:10,recent_blocks:[]}));return {status:'DONE'};};
 await runService(config,{out,collectImpl});await runService(config,{out,collectImpl});
 assert.equal(runs[1].resume.mock.next_block,10);assert.notEqual(runs[0].clock_id,runs[1].clock_id);
});
test('API exposes initial run record without a spurious expired cursor',async t=>{
 const out=join(await temp(t),'events.jsonl');let base;
 await runService(config,{out,onReady:i=>{base=`http://127.0.0.1:${i.api.port}`;},collectImpl:async(c,{emit})=>{
  const first=await(await fetch(base+'/v1/events?after=0')).json();assert.equal(first.status,'OK');assert.equal(first.records[0].seq,1);
  await emit(observation(c,'mock','health','ready',{kind:'subscriptions_ready'}));
  const second=await fetch(base+'/v1/events?after=0');assert.equal(second.status,200);assert.equal((await second.json()).records.length,2);
  return {};
 }});
});
test('runtime rejects a changed scope before collecting into an existing journal',async t=>{
 const out=join(await temp(t),'events.jsonl');await runService(config,{out,collectImpl:async()=>({status:'DONE'})});
 await assert.rejects(runService({...config,addresses:['0x'+'22'.repeat(20)]},{out,collectImpl:async()=>assert.fail('must not collect')}),/configuration changed/);
});
test('runtime feeds only selected source block completions into engine',async t=>{
 const out=join(await temp(t),'events.jsonl'),blocks=[],invalidations=[];
 const c={...config,sources:[...config.sources,{name:'secondary',http_env:'H',ws_env:'W'}]};
 await runService(c,{out,registry:{chain_id:4663},engineFactory:()=>({applyBlock:b=>{blocks.push(b);return {status:'APPLIED'};},snapshot:()=>({}),invalidate:r=>invalidations.push(r)}),
 collectImpl:async(c,{emit})=>{for(const source of ['secondary','mock']) await emit(observation(c,source,'health','block:10',
   {kind:'block_complete',block:{number:10,hash:'x',logs:[]}}, {delivery:'backfill'}));return {status:'DONE'};}});
 assert.equal(blocks.length,1);assert.ok(invalidations.includes('COLLECTION_STOPPED'));
 const records=[];await readJournal(out,r=>records.push(r.observation));const ready=records.filter(x=>x.stage==='state_ready');
 assert.equal(ready.length,1);assert.equal(ready[0].delivery,'backfill');
});
test('rejected derived state is never labelled ready and has an independent height',async t=>{
 const out=join(await temp(t),'events.jsonl');
 const result=await runService(config,{out,registry:{},engineFactory:()=>({applyBlock:()=>({status:'REJECTED',reason:'bad ABI'}),snapshot:()=>({head:null}),invalidate:()=>{}}),
 collectImpl:async(c,{emit})=>{await emit(observation(c,'mock','health','block:10',{kind:'block_complete',block:{number:10,hash:'x',logs:[]}}, {delivery:'backfill'}));
  await emit(observation(c,'mock','health','checkpoint:11',{kind:'checkpoint',next_block:11,recent_blocks:[]},{delivery:'backfill'}));return {};}});
 assert.equal(result.health.state_status,'REJECTED_REQUIRES_REPLAY');assert.equal(result.health.last_state_block,null);assert.equal(result.health.last_complete_block.number,10);
 const records=[];await readJournal(out,r=>records.push(r.observation));assert.equal(records.filter(r=>r.stage==='state_ready').length,0);
 assert.ok(records.find(r=>r.payload.kind==='state_rejected'));assert.ok(records.find(r=>r.payload.kind==='checkpoint'));
});
test('runtime failure closes API and journal for subsequent recovery',async t=>{
 const out=join(await temp(t),'events.jsonl');let port;
 await assert.rejects(runService(config,{out,onReady:i=>{port=i.api.port;},collectImpl:async()=>{throw new Error('injected');}}),/injected/);
 await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));await runService(config,{out,collectImpl:async()=>({status:'DONE'})});
});
test('actual collector fault kinds invalidate both primary views',async t=>{
 const out=join(await temp(t),'events.jsonl'),invalidations=[],liveInvalidations=[];
 const kinds=['source_disconnected','source_failed_closed','gap_detected','reorg_detected','live_reorg_hint','removed_log_hint','recovery_retry','rpc_lag_detected'];
 await runService(config,{out,registry:{},engineFactory:()=>({invalidate:x=>invalidations.push(x),snapshot:()=>({})}),
  liveFactory:()=>({invalidate:x=>liveInvalidations.push(x),snapshot:()=>({})}),collectImpl:async(c,{emit})=>{
   for(const kind of kinds)await emit(observation(c,'mock','health','fault:'+kind,{kind}));return {status:'DONE'};}});
 for(const kind of kinds){assert.ok(invalidations.includes(kind),kind);assert.ok(liveInvalidations.includes(kind),kind);}
});
test('fatal and partial source failures are visible in the runtime result',async t=>{
 const dir=await temp(t);
 for(const [fatal,expected] of [[true,'FAILED'],[false,'DEGRADED']]) {
  const report=await runService(config,{out:join(dir,expected+'.jsonl'),collectImpl:async()=>({fatal,any_source_failed:true,sources:[{source:'mock',status:'failed_closed'}]})});
  assert.equal(report.status,expected);assert.equal(report.health.status,expected);
 }
});
test('live state update is recorded under log identity with processing time and provisional scope',async t=>{
 const out=join(await temp(t),'events.jsonl');
 await runService(config,{out,registry:{},liveFactory:()=>({invalidate:()=>{},snapshot:()=>({}),applyObservation:()=>({status:'OBSERVED',execution_eligible:false})}),
  collectImpl:async(c,{emit})=>{await emit(observation(c,'mock','log','log:synthetic',{},
   {block_number:1,block_hash:'0x'+'aa'.repeat(32),transaction_hash:'0x'+'bb'.repeat(32),log_index:0}));return {};}});
 const records=[];await readJournal(out,r=>records.push(r.observation));const ready=records.find(r=>r.stage==='state_ready');
 assert.equal(ready.event_id,'log:synthetic');assert.equal(ready.delivery,'live');assert.equal(ready.payload.scope,'PROVISIONAL_UNRECONCILED');
 assert.ok(BigInt(ready.processing_delay_ns)>=0n);
});
