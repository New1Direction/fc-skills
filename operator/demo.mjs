import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialize, loadConfig } from './config.mjs';
import { atomicJSON, fail, readJSON } from './common.mjs';
import { fixtureBlock, fixtureServer } from './fixtures.mjs';
import { start } from './runtime.mjs';
import { acceptance, reports } from './status.mjs';
import { exportWorkspace, verifyExport } from './storage.mjs';
import { fileURLToPath } from 'node:url';

export async function demo(destination) {
  const root = resolve(destination);
  if (existsSync(root)) fail('DEMO_DESTINATION_MUST_BE_NEW');
  const first = fixtureBlock(1,{initialize:true}), second = fixtureBlock(2,{parent:first.block.hash});
  const server = await fixtureServer([first,second]);
  const previous = process.env.MSK_OPERATOR_DEMO_HTTP; process.env.MSK_OPERATOR_DEMO_HTTP = server.url;
  try {
    const workspace = join(root,'workspace');
    const { mkdirSync } = await import('node:fs'); mkdirSync(root,{recursive:true,mode:0o700});
    await initialize(workspace,{fromBlock:1,registryFile:fileURLToPath(new URL('../skills/pulse/assets/pools.synthetic.json',import.meta.url)),evidenceMode:'synthetic',httpEnv:'MSK_OPERATOR_DEMO_HTTP',maxBytes:32*1024*1024});
    const cfg = readJSON(join(workspace,'operator.json')); cfg.capture.max_requests_per_second=100; cfg.capture.poll_ms=50; cfg.limits={heartbeat_ms:100,minimum_free_bytes:0,drain_seconds:2}; atomicJSON(join(workspace,'operator.json'),cfg);
    const initial = await start(workspace,{duration:2});
    const before = reports(workspace);
    const replacement = fixtureBlock(2,{branch:'b',parent:first.block.hash,sqrt:2n << 96n}); server.state.blocks.set(2,replacement);
    const recovered = await start(workspace,{duration:2});
    const after = reports(workspace);
    const archive = await exportWorkspace(workspace,join(root,'export'));
    await verifyExport(archive.directory);
    const result = {schema:'msk.operator.demo.v1',evidence_mode:'synthetic',workspace,
      initial_run:initial.run_id,recovery_run:recovered.run_id,
      included_transactions:recovered.final_status.coverage.transaction_count,
      receipt_count:recovered.final_status.coverage.receipt_count,reports_before:before.items.length,
      current_reports:after.items.filter(r=>r.status==='CURRENT').length,retracted_reports:after.items.filter(r=>r.status==='RETRACTED').length,
      export_manifest_sha256:archive.manifest_sha256,read_only_rpc_requests:server.state.requests.length,forbidden_rpc_requests:server.state.forbidden,
      live_24_hour_acceptance:acceptance(workspace).result,
      checks:{initial_capture:initial.reason==='DURATION_LIMIT',recovery_capture:recovered.reason==='DURATION_LIMIT',reports:after.items.some(r=>r.status==='CURRENT'),retractions:after.items.some(r=>r.status==='RETRACTED'),receipts:recovered.final_status.coverage.receipt_complete_through_head,source_writes:server.state.forbidden===0}};
    if (!Object.values(result.checks).every(Boolean)) { atomicJSON(join(root,'demo-report.json'),result); fail('DEMO_ACCEPTANCE_FAILED'); }
    atomicJSON(join(root,'demo-report.json'),result); return result;
  } finally { if(previous===undefined)delete process.env.MSK_OPERATOR_DEMO_HTTP;else process.env.MSK_OPERATOR_DEMO_HTTP=previous;await server.close(); }
}
