#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, errorCode, fail, integer } from '../operator/common.mjs';

const HELP = `MSK Operator — Robinhood Chain capture and retained pool research

  init         --workspace NEW_DIR --from-block N|latest [--registry JSON] [--http-env NAME] [--max-db-bytes N]
  doctor       --workspace DIR [--out JSON]
  start        --workspace DIR [--duration SECONDS] [--out JSON]
  stop         --workspace DIR
  status       --workspace DIR [--out JSON]
  reports      --workspace DIR [--after N] [--limit N] [--evidence true] [--out JSON]
  acceptance   --workspace DIR [--run-id UUID] [--minimum-seconds N] [--out JSON]
  export       --workspace DIR --out NEW_EXPORT_DIR
  verify-export --export EXPORT_DIR [--out JSON]
  ack-export   --workspace DIR --export EXPORT_DIR --sha256 MANIFEST_DIGEST --owner RETENTION_OWNER
  restore      --export EXPORT_DIR --workspace NEW_DIR
  resize       --workspace DIR --max-db-bytes N --snapshot NEW_EXPORT_DIR
  demo         --out NEW_DIR

Node.js 24+. Start supervises capture, workers, and the pool consumer in separate
processes. It stays in the foreground; duration 0 is continuous (default 60).
Endpoint values come only from named environment variables. Init requires an
explicit first block; latest resolves and persists an observed starting block.
Export/restore preserve history. Export does not free disk or prove off-host
retention. No command signs or submits a live trade.
`;
function parse(argv) {
  const [command = 'help', ...rest] = argv, args = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z][a-z-]*$/.test(rest[i]) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) fail('INVALID_ARGUMENT');
    const key = rest[i].slice(2); if (Object.hasOwn(args, key)) fail('DUPLICATE_ARGUMENT'); args[key] = rest[i + 1];
  }
  return { command, args };
}
const allowed = (args, keys) => { for (const key of Object.keys(args)) if (!keys.includes(key)) fail('UNKNOWN_ARGUMENT'); };
const required = (args, key) => args[key] ?? fail('REQUIRED_' + key.toUpperCase().replaceAll('-', '_'));
function output(value, path) { if (path) atomicJSON(resolve(path), value); else process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const { command, args } = parse(argv);
  if (['help', '--help'].includes(command)) { process.stdout.write(HELP); return; }
  let result;
  if (command === 'init') {
    allowed(args, ['workspace','from-block','registry','http-env','max-db-bytes']);
    const { initialize } = await import('../operator/config.mjs');
    result = await initialize(required(args, 'workspace'), { fromBlock: required(args, 'from-block'), registryFile: args.registry,
      httpEnv: args['http-env'], maxBytes: args['max-db-bytes'] === undefined ? undefined : integer(args['max-db-bytes'], 'MAX_DB_BYTES') });
  } else if (command === 'start') {
    allowed(args, ['workspace','duration','out']);
    const duration = args.duration === undefined ? 60 : Number(args.duration);
    if (args.duration !== undefined && !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(args.duration)) fail('INVALID_DURATION');
    const { start } = await import('../operator/runtime.mjs');
    result = await start(required(args, 'workspace'), { duration });
    if (result.phase !== 'STOPPED' || !['DURATION_LIMIT','STOP_REQUESTED'].includes(result.reason)) process.exitCode = 2;
  } else if (command === '_child') {
    allowed(args, ['workspace','role','run-id']);
    const { child } = await import('../operator/runtime.mjs');
    process.exitCode = await child(required(args,'role'),required(args,'workspace'),required(args,'run-id')); return;
  } else if (command === 'stop') {
    allowed(args, ['workspace']); const { requestStop } = await import('../operator/runtime.mjs'); result = requestStop(required(args,'workspace'));
  } else if (['doctor','status','reports','acceptance'].includes(command)) {
    const api = await import('../operator/status.mjs');
    allowed(args, command === 'reports' ? ['workspace','after','limit','evidence','out'] : command === 'acceptance' ? ['workspace','run-id','minimum-seconds','out'] : ['workspace','out']);
    const workspace = required(args,'workspace');
    if (command === 'doctor') { result = await api.doctor(workspace); if (!result.ready_for_capture) process.exitCode = 2; }
    if (command === 'status') result = api.status(workspace);
    if (command === 'reports') {
      if (args.evidence !== undefined && !['true','false'].includes(args.evidence)) fail('INVALID_EVIDENCE_OPTION');
      result = api.reports(workspace,{ after: integer(args.after ?? 0,'AFTER'), limit: integer(args.limit ?? 20,'LIMIT',1,args.evidence === 'true' ? 5 : 100),includeEvidence:args.evidence === 'true' });
    }
    if (command === 'acceptance') {
      if (args['run-id'] && !/^[a-f0-9-]{36}$/.test(args['run-id'])) fail('INVALID_RUN_ID');
      result = api.acceptance(workspace,{runId:args['run-id'],minimumSeconds:integer(args['minimum-seconds'] ?? 86400,'MINIMUM_SECONDS',1,86400)});
      if (result.result !== 'PASS') process.exitCode = 2;
    }
  } else if (['export','verify-export','ack-export','restore','resize'].includes(command)) {
    const api = await import('../operator/storage.mjs');
    allowed(args, { export:['workspace','out'], 'verify-export':['export','out'], 'ack-export':['workspace','export','sha256','owner'], restore:['export','workspace'], resize:['workspace','max-db-bytes','snapshot'] }[command]);
    if (command === 'export') { result = await api.exportWorkspace(required(args,'workspace'),required(args,'out')); output(result); return; }
    if (command === 'verify-export') result = await api.verifyExport(required(args,'export'));
    if (command === 'ack-export') result = await api.acknowledgeExport(required(args,'workspace'),required(args,'export'),{sha256:required(args,'sha256'),owner:required(args,'owner')});
    if (command === 'restore') result = await api.restoreExport(required(args,'export'),required(args,'workspace'));
    if (command === 'resize') result = await api.resizeWorkspace(required(args,'workspace'),integer(required(args,'max-db-bytes'),'MAX_DB_BYTES'),required(args,'snapshot'));
  } else if (command === 'demo') {
    allowed(args,['out']); const { demo } = await import('../operator/demo.mjs'); result = await demo(required(args,'out')); output(result); return;
  } else fail('UNKNOWN_COMMAND');
  output(result,args.out);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(JSON.stringify({error:errorCode(error)}) + '\n'); process.exitCode=1;
});
