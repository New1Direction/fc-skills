import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initialize, loadConfig, validateRegistry } from './config.mjs';
import { acquire, alive, atomicJSON, digest, fail, readJSON } from './common.mjs';
import { initializeConsumer, consumeBatch } from './consumer.mjs';
import { start, openWorkspaceStore, requestStop } from './runtime.mjs';
import { status, reports, runEvidence, acceptance } from './status.mjs';
import { exportWorkspace, verifyExport, restoreExport, acknowledgeExport, resizeWorkspace } from './storage.mjs';
import { fixtureBlock, fixtureServer, registry } from './fixtures.mjs';
import { routeEvents, runJobs } from '../skills/watchtower/scripts/workers.mjs';

const registryFile = fileURLToPath(new URL('../skills/pulse/assets/pools.synthetic.json', import.meta.url));
const entry = fileURLToPath(new URL('../scripts/msk.mjs', import.meta.url));
async function setup(t, { open = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'msk-operator-test-')), workspace = join(root, 'workspace');
  await initialize(workspace, { fromBlock: 1, registryFile, evidenceMode: 'synthetic', maxBytes: 32 * 1024 ** 2, httpEnv: 'MSK_OPERATOR_TEST_HTTP' });
  const raw = readJSON(join(workspace,'operator.json'));
  raw.capture.poll_ms = 50; raw.capture.max_requests_per_second = 100; raw.capture.request_timeout_ms = 500;
  raw.limits = { heartbeat_ms:100, minimum_free_bytes:0, drain_seconds:2 };
  atomicJSON(join(workspace,'operator.json'), raw);
  const config = loadConfig(workspace), store = open ? openWorkspaceStore(config) : null;
  if (store) initializeConsumer(store,config);
  t.after(() => { try { store?.close(); } catch {} rmSync(root,{recursive:true,force:true}); });
  return {root,workspace,config,store};
}
function retain(store, row, meta = {}) { store.putBlock(row.block,meta); store.putReceipts(row.block.hash,row.receipts,meta); }
async function dispatch(store, config) { routeEvents(store,{policy:config.capture.worker_policy,limit:1000}); await runJobs(store,{limit:1000}); }
function consumeAll(store, config) { for(let i=0;i<20;i++) { const r=consumeBatch(store,config); if(r.deferred || !r.processed) return r; } throw Error('consumer did not drain'); }
function count(store, table) { return store.db.prepare('SELECT count(*) AS n FROM '+table).get().n; }

test('exact registry identity is checked and address case is normalized', () => {
  const input = structuredClone(registry); input.manager = '0x'+input.manager.slice(2).toUpperCase();
  assert.equal(validateRegistry(input).manager,registry.manager);
  input.pools[0].fee = 500; assert.throws(() => validateRegistry(input));
});

test('retained full receipts drive exact single-block research; optional removed is normalized',async t=>{
  const {store,config,workspace}=await setup(t), row=fixtureBlock(1,{initialize:true,missingRemoved:true});
  retain(store,row); await dispatch(store,config); consumeAll(store,config);
  const items=reports(workspace,{includeEvidence:true}).items;
  assert.equal(items.length,2); assert(items.every(r=>r.status==='CURRENT'));
  const report=items[0].report;
  assert.equal(report.scope,'SINGLE_RECONCILED_BLOCK'); assert.equal(report.summary.swap_events,1);
  assert.equal(report.input_evidence.block_sha256,digest(row.block));
  assert.equal(report.input_evidence.receipts_sha256,digest(row.receipts));
  assert.equal(report.input_evidence.transaction_count,4); assert.equal(report.input_evidence.receipt_count,4);
  assert.equal(report.summary.net_profit,null); assert.equal(report.summary.trader_count,null);
  assert.deepEqual(items[0].evidence.receipts,row.receipts);
});

test('crash before result commit leaves cursor replayable and retry is idempotent',async t=>{
  const {store,config}=await setup(t); retain(store,fixtureBlock(1)); await dispatch(store,config);
  const cursor=store.db.prepare('SELECT cursor FROM op_consumer').get().cursor;
  assert.throws(()=>consumeBatch(store,config,{beforeCommit(){throw Error('simulated crash');}}),/simulated crash/);
  assert.equal(count(store,'op_results'),0); assert.equal(store.db.prepare('SELECT cursor FROM op_consumer').get().cursor,cursor);
  consumeAll(store,config); const results=count(store,'op_results'),actions=count(store,'op_actions');
  consumeAll(store,config); assert.equal(count(store,'op_results'),results); assert.equal(count(store,'op_actions'),actions);
});

test('out-of-order worker completion waits for earlier missing receipts',async t=>{
  const {store,config,workspace}=await setup(t), a=fixtureBlock(1), b=fixtureBlock(2,{parent:a.block.hash});
  store.putBlock(a.block); retain(store,b); await dispatch(store,config);
  assert.equal(consumeBatch(store,config).deferred,1); assert.equal(count(store,'op_results'),0);
  store.putReceipts(a.block.hash,a.receipts); await dispatch(store,config); consumeAll(store,config);
  assert.deepEqual(reports(workspace).items.map(r=>r.report.block.number),[2,1]);
  assert(reports(workspace).items.every(r=>r.report.scope==='SINGLE_RECONCILED_BLOCK'));
});

test('same block hash re-adoption creates a new generation and retracts the old report',async t=>{
  const {store,config,workspace}=await setup(t), a=fixtureBlock(1), b=fixtureBlock(1,{branch:'b'});
  retain(store,a); await dispatch(store,config); consumeAll(store,config);
  const original=reports(workspace).items[0];
  retain(store,b); await dispatch(store,config); consumeAll(store,config);
  retain(store,a); await dispatch(store,config); consumeAll(store,config);
  const rows=reports(workspace).items, current=rows.filter(r=>r.status==='CURRENT');
  assert.equal(current.length,1); assert.notEqual(current[0].job_id,original.job_id);
  assert(current[0].generation>original.generation); assert.equal(rows.find(r=>r.job_id===original.job_id).status,'RETRACTED');
});

test('reorg between analysis and commit cannot publish a current orphan',async t=>{
  const {store,config,workspace}=await setup(t); retain(store,fixtureBlock(1)); await dispatch(store,config);
  let once=false;
  consumeBatch(store,config,{beforeCommit(){if(!once){once=true;store.rewind(1,'test concurrent reorg');}}});
  assert(reports(workspace).items.every(r=>r.status!=='CURRENT'));
});

test('canonicality is rechecked for reports even while the consumer is stopped',async t=>{
  const {store,config,workspace}=await setup(t); retain(store,fixtureBlock(1)); await dispatch(store,config); consumeAll(store,config);
  store.rewind(1,'test stopped consumer');
  assert.equal(reports(workspace).items[0].status,'RETRACTED_PENDING_PROCESSING');
  consumeBatch(store,config); assert.equal(reports(workspace).items[0].status,'RETRACTED');
});

test('analysis failures retry three times, then retain failure before acknowledging',async t=>{
  const {store,config,workspace}=await setup(t); retain(store,fixtureBlock(1)); await dispatch(store,config);
  const options={limit:100,analyzer(){fail('TEST_UNSUPPORTED_INPUT');}};
  assert.equal(consumeBatch(store,config,options).deferred,1);
  assert.equal(consumeBatch(store,config,options).deferred,1);
  assert.equal(count(store,'op_results'),0);
  assert.equal(consumeBatch(store,config,options).failed,1);
  assert.equal(reports(workspace).items[0].error_code,'TEST_UNSUPPORTED_INPUT');
  assert.equal(status(workspace).research.failed,1);
});

test('missing block timestamp is unknown health and a visible analysis failure',async t=>{
  const {store,config,workspace}=await setup(t), row=fixtureBlock(1); delete row.block.timestamp; retain(store,row);
  store.observe('source_health','head',{source:'primary',run_id:'test',clock_id:'clock',observed_mono_ns:'1',observed_at:new Date().toISOString()}, {head_hash:row.block.hash,syncing:false});
  assert.equal(status(workspace).sources[0].retained_head_age_ms,null);
  await dispatch(store,config); for(let i=0;i<3;i++)consumeBatch(store,config);
  assert.equal(status(workspace).research.failed,1);
});

test('run evidence never borrows earlier capture reports or latency rows',async t=>{
  const {store,config,workspace}=await setup(t); config.operator_run_id='new-run';
  retain(store,fixtureBlock(1),{run_id:'old-run'}); await dispatch(store,config); consumeAll(store,config);
  store.observe('source_health','old',{source:'primary',run_id:'old-run',clock_id:'clock',observed_mono_ns:'1',observed_at:new Date().toISOString()});
  assert.equal(runEvidence(workspace,'new-run').canonical_reports_from_this_run,0);
  assert.deepEqual(runEvidence(workspace,'new-run').latency.sampling.capture_run_ids,[]);
});

test('synthetic mode, missing run evidence, short capture, and killed children cannot pass acceptance',async t=>{
  const {workspace,config}=await setup(t), runId=randomUUID();
  const run={run_id:runId,phase:'STOPPED',reason:'DURATION_LIMIT',evidence_mode:'synthetic',config_fingerprint:config.fingerprint,
    capture_duration_seconds:2,children:{capture:{exit_code:0,signal:null},workers:{exit_code:null,signal:'SIGKILL'},consumer:{exit_code:0,signal:null}},
    final_status:{coverage:{complete_through_head:true,receipt_complete_through_head:true},research:{unacknowledged:0,failed:0,currently_canonical_reports:99},workers:{pending:0,failed:0,policies:[],event_head:0},sources:[]}};
  atomicJSON(join(workspace,'runs',runId,'run.json'),run);
  const raw=readJSON(config.paths.config); raw.evidence_mode='live'; atomicJSON(config.paths.config,raw);
  const result=acceptance(workspace,{runId});
  assert.equal(result.result,'INCOMPLETE');
  for(const key of ['live_evidence','config_matches','duration','real_pool_report','clean_child_shutdown']) assert.equal(result.checks[key],false,key);
});

test('live owners, orphan children, and interrupted ownership updates fail closed',async t=>{
  const {workspace}=await setup(t), lock=acquire(workspace);
  assert.throws(()=>acquire(workspace),{code:'OPERATOR_BUSY'}); lock.release();
  const p=join(workspace,'operator.lock'); mkdirSync(p);
  atomicJSON(join(p,'owner.json'),{pid:2147483647,children:[{pid:process.pid}]});
  assert.throws(()=>acquire(workspace),{code:'OPERATOR_BUSY'}); rmSync(p,{recursive:true});
  mkdirSync(join(workspace,'ownership.guard'));
  assert.throws(()=>acquire(workspace),{code:'OWNERSHIP_UPDATE_BUSY_OR_INTERRUPTED'});
});

test('concurrent stale-owner reclaimers never both acquire the workspace',async t=>{
  const {workspace}=await setup(t); mkdirSync(join(workspace,'operator.lock'));
  atomicJSON(join(workspace,'operator.lock','owner.json'),{pid:2147483647,children:[]});
  const moduleURL=new URL('./common.mjs',import.meta.url).href;
  const script=`import {acquire} from ${JSON.stringify(moduleURL)}; try { const l=acquire(process.argv[1]); process.stdout.write('ACQUIRED'); setTimeout(()=>l.release(),300); } catch(e) { process.stdout.write(e.code); }`;
  const launch=()=>new Promise(resolve=>{const p=spawn(process.execPath,['--input-type=module','-e',script,workspace],{stdio:['ignore','pipe','ignore']});let out='';p.stdout.on('data',b=>out+=b);p.on('close',()=>resolve(out));});
  const results=await Promise.all([launch(),launch()]); assert.equal(results.filter(x=>x==='ACQUIRED').length,1);
});

test('export seals committed WAL, verifies hashes, and restore resumes the same consumer',async t=>{
  const {store,config,workspace,root}=await setup(t); retain(store,fixtureBlock(1)); await dispatch(store,config); consumeAll(store,config);
  assert(existsSync(config.paths.db+'-wal'));
  const exported=await exportWorkspace(workspace,join(root,'export')); assert.equal((await verifyExport(exported.directory)).verified,true);
  assert.equal(existsSync(join(exported.directory,'watchtower.sqlite-wal')),false);
  const restored=join(root,'restored'); await restoreExport(exported.directory,restored);
  const reopened=openWorkspaceStore(loadConfig(restored));
  try { initializeConsumer(reopened,loadConfig(restored)); const before=count(reopened,'op_results'); consumeAll(reopened,loadConfig(restored)); assert.equal(count(reopened,'op_results'),before); const {storage_bytes:a,...left}=reopened.progress(),{storage_bytes:b,...right}=store.progress(); assert.deepEqual(left,right); }
  finally {reopened.close();}
  assert(existsSync(config.paths.db));
});

test('tampered exports fail verification and cannot be restored or acknowledged',async t=>{
  const {workspace,root}=await setup(t), exp=await exportWorkspace(workspace,join(root,'export'));
  writeFileSync(join(exp.directory,'registry.json'),'{}');
  await assert.rejects(verifyExport(exp.directory),{code:'EXPORT_DIGEST_MISMATCH'});
  await assert.rejects(restoreExport(exp.directory,join(root,'restored')),{code:'EXPORT_DIGEST_MISMATCH'});
  await assert.rejects(acknowledgeExport(workspace,exp.directory,{sha256:exp.manifest_sha256,owner:'test'}),{code:'EXPORT_DIGEST_MISMATCH'});
});

test('registry drift cannot produce a supposedly verified export',async t=>{
  const {workspace,config,root}=await setup(t), changed=readJSON(config.paths.registry); changed.pools[0].decimals0=17; atomicJSON(config.paths.registry,changed);
  await assert.rejects(exportWorkspace(workspace,join(root,'export')),{code:'EXPORT_CONFIG_MISMATCH'});
  assert.equal(existsSync(join(root,'export')),false);
});

test('retention acknowledgement is bound to the logical database and never prunes',async t=>{
  const a=await setup(t),b=await setup(t),exp=await exportWorkspace(a.workspace,join(a.root,'export'));
  await assert.rejects(acknowledgeExport(b.workspace,exp.directory,{sha256:exp.manifest_sha256,owner:'test'}),{code:'ACK_WORKSPACE_MISMATCH'});
  const ack=await acknowledgeExport(a.workspace,exp.directory,{sha256:exp.manifest_sha256,owner:'test'});
  assert.equal(ack.source_pruned,false); assert.equal(ack.off_host_durability_independently_verified,false);
  assert(existsSync(a.config.paths.db));
});

test('capacity expansion preserves history and resumes after a storage budget stop',async t=>{
  const {workspace,config,store,root}=await setup(t); retain(store,fixtureBlock(1)); await dispatch(store,config); consumeAll(store,config); store.close();
  const db=new DatabaseSync(config.paths.db); db.prepare('UPDATE wt_config SET max_bytes=?').run(1024*1024); db.close();
  const small=openWorkspaceStore(loadConfig(workspace));
  assert.throws(()=>small.mutate(()=>{}, {bytesHint:2*1024*1024}),{code:'STORAGE_LIMIT'}); small.close();
  const resized=await resizeWorkspace(workspace,8*1024*1024,join(root,'before-resize'));
  assert.equal(resized.old_max_bytes,1024*1024); assert.equal(resized.source_pruned,false);
  const resumed=openWorkspaceStore(loadConfig(workspace));
  try { const a=resumed.block(1); retain(resumed,fixtureBlock(2,{parent:a.hash})); assert.equal(resumed.progress().transaction_count,8); assert.equal(count(resumed,'op_results'),1); } finally {resumed.close();}
});

test('maintenance refuses an active operator and restoration refuses an existing directory',async t=>{
  const {workspace,root}=await setup(t), lock=acquire(workspace);
  await assert.rejects(exportWorkspace(workspace,join(root,'export')),{code:'OPERATOR_BUSY'}); lock.release();
  const exp=await exportWorkspace(workspace,join(root,'export'));
  await assert.rejects(restoreExport(exp.directory,workspace),{code:'RESTORE_DESTINATION_MUST_BE_NEW'});
});

test('real HTTP boundary, separate processes, receipt fallback, stop token, and same-run reports',async t=>{
  const {workspace}=await setup(t,{open:false}), server=await fixtureServer([fixtureBlock(1,{initialize:true})]);
  server.state.unsupportedBlockReceipts=true;
  const prior=process.env.MSK_OPERATOR_TEST_HTTP; process.env.MSK_OPERATOR_TEST_HTTP=server.url;
  try {
    const run=await start(workspace,{duration:1});
    assert.equal(run.phase,'STOPPED'); assert.equal(run.reason,'DURATION_LIMIT'); assert(run.capture_duration_seconds>=1);
    assert.equal(run.final_status.coverage.transaction_count,4); assert.equal(run.final_status.coverage.receipt_count,4);
    assert(run.run_evidence.canonical_reports_from_this_run>0); assert.deepEqual(run.run_evidence.latency.sampling.capture_run_ids,[run.run_id]);
    assert(server.state.requests.includes('eth_getTransactionReceipt')); assert.equal(server.state.forbidden,0);
    assert.equal(acceptance(workspace).result,'INCOMPLETE');
    const second=await start(workspace,{duration:0,onStarted(){setTimeout(()=>requestStop(workspace),600);}});
    assert.equal(second.reason,'STOP_REQUESTED'); assert.equal(second.run_evidence.canonical_reports_from_this_run,0);
  } finally {if(prior===undefined)delete process.env.MSK_OPERATOR_TEST_HTTP;else process.env.MSK_OPERATOR_TEST_HTTP=prior;await server.close();}
});

test('provider outage is visible and restart resumes without inventing coverage',async t=>{
  const {workspace}=await setup(t,{open:false}),server=await fixtureServer([fixtureBlock(1)]), prior=process.env.MSK_OPERATOR_TEST_HTTP;
  process.env.MSK_OPERATOR_TEST_HTTP=server.url;
  try {
    server.state.down=true; const failed=await start(workspace,{duration:0.5});
    assert.equal(failed.final_status.coverage.transaction_count,0); assert(failed.final_status.reasons.includes('SOURCE_UNOBSERVED'));
    server.state.down=false; const recovered=await start(workspace,{duration:1});
    assert.equal(recovered.final_status.coverage.transaction_count,4); assert.equal(recovered.final_status.coverage.receipt_count,4);
  } finally {if(prior===undefined)delete process.env.MSK_OPERATOR_TEST_HTTP;else process.env.MSK_OPERATOR_TEST_HTTP=prior;await server.close();}
});

test('a killed child makes the supervised run incomplete',async t=>{
  const {workspace}=await setup(t,{open:false}), server=await fixtureServer([fixtureBlock(1)]),prior=process.env.MSK_OPERATOR_TEST_HTTP;
  process.env.MSK_OPERATOR_TEST_HTTP=server.url;
  try {
    const run=await start(workspace,{duration:2,onStarted(){setTimeout(()=>{const owner=readJSON(join(workspace,'operator.lock','owner.json'));process.kill(owner.children.find(c=>c.role==='consumer').pid,'SIGKILL');},350);}});
    assert.equal(run.phase,'FAILED'); assert.equal(run.reason,'CHILD_SHUTDOWN_INCOMPLETE');
    assert.equal(acceptance(workspace).checks.clean_child_shutdown,false);
  } finally {if(prior===undefined)delete process.env.MSK_OPERATOR_TEST_HTTP;else process.env.MSK_OPERATOR_TEST_HTTP=prior;await server.close();}
});

test('run archive capacity stays bounded when repeated starts are refused',async t=>{
  const {workspace,config}=await setup(t); const raw=readJSON(config.paths.config);raw.limits.max_runs=1;atomicJSON(config.paths.config,raw);
  mkdirSync(join(workspace,'runs',randomUUID()),{recursive:true});
  for(let i=0;i<2;i++) {const r=await start(workspace,{duration:1});assert.equal(r.reason,'RUN_ARCHIVE_CAPACITY_REACHED');}
  assert.equal(readdirSync(join(workspace,'runs')).length,1);
});

test('supervisor death makes owned children exit and permits a safe restart',async t=>{
  const {workspace}=await setup(t,{open:false}), server=await fixtureServer([fixtureBlock(1)]);
  const parent=spawn(process.execPath,[entry,'start','--workspace',workspace,'--duration','0'],{stdio:'ignore',env:{...process.env,MSK_OPERATOR_TEST_HTTP:server.url}});
  try {
    let owner;
    for(let i=0;i<100;i++) {try {owner=readJSON(join(workspace,'operator.lock','owner.json'));if(owner.children.length===3&&existsSync(join(workspace,'runs',owner.run_id,'capture-start.json')))break;}catch{}await pause(50);}
    assert.equal(owner.children.length,3);
    const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
    for(let i=0;i<100;i++) {if(owner.children.every(c=>!alive(c)))break;await pause(50);}
    assert(owner.children.every(c=>!alive(c)));
    // No automatic acceptance from a supervisor that never committed its final record.
    assert.equal(acceptance(workspace).result,'INCOMPLETE');
    const lock=acquire(workspace);lock.release();
  } finally {parent.kill('SIGKILL');await server.close();}
});
