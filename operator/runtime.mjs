import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { openStore } from '../skills/watchtower/scripts/store.mjs';
import { capture } from '../skills/watchtower/scripts/capture.mjs';
import { requeueExpired, routeEvents, runJobs } from '../skills/watchtower/scripts/workers.mjs';
import { acquire, alive, atomicJSON, diskBytes, errorCode, fail, paths, processIdentity, readJSON } from './common.mjs';
import { loadConfig } from './config.mjs';
import { consumeBatch, initializeConsumer } from './consumer.mjs';
import { persistedConfig, status, runEvidence } from './status.mjs';

const ENTRY = fileURLToPath(new URL('../scripts/msk.mjs', import.meta.url));
export function openWorkspaceStore(config) {
  persistedConfig(config);
  return openStore(config.paths.db, { chainId: 4663, startBlock: config.capture.from_block,
    maxBytes: config.capture.max_db_bytes, reorgDepth: config.capture.reorg_depth });
}
function retryable(error) { return /database is locked|database is busy/i.test(error?.message ?? ''); }
async function ownedChild(config, runId) {
  const file = join(config.paths.lock, 'owner.json');
  for (let round = 0; round < 40; round++) {
    if (!existsSync(file)) fail('SUPERVISOR_MISSING');
    const owner = readJSON(file);
    if (owner.run_id !== runId || !alive(owner)) fail('SUPERVISOR_MISSING');
    if (owner.children.some(c => c.pid === process.pid)) return owner;
    await pause(50);
  }
  fail('CHILD_NOT_REGISTERED');
}

export async function child(role, workspace, runId) {
  if (!['capture', 'workers', 'consumer'].includes(role)) fail('INVALID_CHILD_ROLE');
  const config = loadConfig(workspace), owner = await ownedChild(config, runId), controller = new AbortController();
  config.operator_run_id = runId;
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const watchdog = setInterval(() => {
    try {
      const current = readJSON(join(config.paths.lock, 'owner.json'));
      if (current.run_id !== runId || !alive(owner)) controller.abort();
    } catch { controller.abort(); }
  }, 200);
  const started = performance.now(); let store, result, exitCode = 0;
  try {
    store = openWorkspaceStore(config);
    if (role === 'capture') {
      const clockId = randomUUID();
      const clock = () => ({ run_id: runId, clock_id: clockId, observed_mono_ns: process.hrtime.bigint().toString(), observed_at: new Date().toISOString() });
      atomicJSON(join(config.paths.runs, runId, 'capture-start.json'), { run_id: runId, clock_id: clockId, started_at: new Date().toISOString() });
      const captureStarted = performance.now();
      result = await capture({ ...config.capture, duration_seconds: 0 }, { store, signal: controller.signal, clock });
      result.capture_elapsed_monotonic_ms = performance.now() - captureStarted;
      if (!['aborted', 'stopped'].includes(result.reason)) exitCode = 2;
    } else {
      result = { schema: 'msk.operator.child.v1', role, rounds: 0, transient_database_busy: 0, processed: 0 };
      while (!controller.signal.aborted) {
        try {
          if (role === 'workers') {
            requeueExpired(store);
            routeEvents(store, { policy: config.capture.worker_policy, limit: 64 });
            const round = await runJobs(store, { limit: 16 }); result.processed += round.completed;
          } else result.processed += consumeBatch(store, config, { limit: 16 }).processed;
          result.rounds++;
        } catch (error) { if (!retryable(error)) throw error; result.transient_database_busy++; }
        await pause(100, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  } catch (error) { exitCode = 2; result = { schema: 'msk.operator.child.v1', role, error_code: errorCode(error), committed_before_error: error.committed === true }; }
  finally {
    clearInterval(watchdog); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { store?.close(); } catch (error) { exitCode = 2; result.close_error = errorCode(error); }
  }
  result.duration_seconds = (performance.now() - started) / 1000;
  result.evidence_mode = config.evidence_mode;
  atomicJSON(join(config.paths.runs, runId, role + '.json'), result);
  return exitCode;
}

export async function start(workspace, { duration = 60, onStarted } = {}) {
  const config = persistedConfig(loadConfig(workspace)), p = config.paths;
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400) fail('INVALID_DURATION');
  if (existsSync(p.maintenance)) fail('MAINTENANCE_RECOVERY_REQUIRED');
  const lock = acquire(workspace), runId = lock.owner.run_id;
  const records = new Map(), startMono = performance.now(); let reason = null, signalRequested = false, captureStartedMono = null, archived = false;
  const stop = () => { signalRequested = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const run = { schema: 'msk.operator.run.v1', run_id: runId, phase: 'STARTING', evidence_mode: config.evidence_mode,
    config_fingerprint: config.fingerprint, acceptance_policy: { source_stale_seconds: config.limits.source_stale_seconds },
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), requested_seconds: duration,
    children: {}, reason: null };
  const save = () => { run.heartbeat_at = new Date().toISOString(); atomicJSON(p.state, run); if (archived) atomicJSON(join(p.runs, runId, 'run.json'), run); };
  const launch = role => {
    const processHandle = spawn(process.execPath, [ENTRY, '_child', '--workspace', p.root, '--role', role, '--run-id', runId], { stdio: 'ignore', env: process.env });
    const record = { process: processHandle, exited: false, code: null, signal: null, role };
    record.done = new Promise(resolve => {
      processHandle.once('error', () => { record.exited = true; record.code = 2; resolve(); });
      processHandle.once('exit', (code, signal) => { record.exited = true; record.code = code; record.signal = signal; resolve(); });
    });
    records.set(role, record);
    if (processHandle.pid) lock.owner.children.push({ role, pid: processHandle.pid, identity: processIdentity(processHandle.pid) });
    lock.update();
  };
  const halt = async roles => {
    const selected = roles.map(r => records.get(r)).filter(Boolean);
    for (const r of selected) if (!r.exited) r.process.kill('SIGTERM');
    const timer = new AbortController();
    await Promise.race([Promise.all(selected.map(r => r.done)), pause(config.capture.request_timeout_ms + 3000, undefined, { signal: timer.signal }).catch(() => {})]);
    timer.abort();
    for (const r of selected) if (!r.exited) r.process.kill('SIGKILL');
    await Promise.all(selected.map(r => r.done));
  };
  try {
    if (existsSync(p.runs) && readdirSync(p.runs, { withFileTypes: true }).filter(e => e.isDirectory()).length >= config.limits.max_runs) fail('RUN_ARCHIVE_CAPACITY_REACHED');
    for (const source of config.capture.sources) if (!process.env[source.http_env]) fail('SOURCE_ENVIRONMENT_MISSING');
    mkdirSync(join(p.runs, runId), { recursive: true, mode: 0o700 });
    archived = true;
    const store = openWorkspaceStore(config);
    try { initializeConsumer(store, config); run.initial_coverage = store.progress(); } finally { store.close(); }
    save();
    for (const role of ['capture', 'workers', 'consumer']) launch(role);
    run.phase = 'RUNNING'; save(); onStarted?.({ run_id: runId, workspace: p.root });
    while (!reason) {
      if (captureStartedMono === null && existsSync(join(p.runs, runId, 'capture-start.json'))) captureStartedMono = performance.now();
      if (captureStartedMono === null && performance.now() - startMono > 15000) reason = 'CAPTURE_START_TIMEOUT';
      if (signalRequested) reason = 'STOP_REQUESTED';
      if (duration && captureStartedMono !== null && performance.now() - captureStartedMono >= duration * 1000) reason ??= 'DURATION_LIMIT';
      if (existsSync(p.stop) && readJSON(p.stop).run_id === runId) reason ??= 'STOP_REQUESTED';
      for (const [role, r] of records) if (r.exited) reason ??= role.toUpperCase() + '_EXITED';
      const fs = statfsSync(p.root, { bigint: true });
      if (fs.bavail * fs.bsize < BigInt(config.limits.minimum_free_bytes)) reason ??= 'FILESYSTEM_RESERVE_LOW';
      if (diskBytes(p.db) >= config.capture.max_db_bytes * config.limits.stop_at_storage_ratio) reason ??= 'STORAGE_HIGH_WATER';
      save();
      if (!reason) await pause(config.limits.heartbeat_ms);
    }
    run.phase = 'DRAINING'; run.reason = reason; save();
    await halt(['capture']);
    // Keep downstream processing separate and drain only for a bounded interval.
    const until = performance.now() + config.limits.drain_seconds * 1000;
    while (performance.now() < until && !records.get('workers').exited && !records.get('consumer').exited) {
      const health = status(workspace);
      if (health.workers?.pending === 0 && health.workers.policies.every(p => p.cursor === health.workers.event_head) && health.research?.unacknowledged === 0) break;
      if (['STORAGE_HIGH_WATER', 'FILESYSTEM_RESERVE_LOW'].includes(reason)) break;
      await pause(100);
    }
    await halt(['workers', 'consumer']);
    run.phase = 'STOPPED';
  } catch (error) {
    reason = errorCode(error); run.phase = 'FAILED'; run.reason = reason;
    await halt([...records.keys()]);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    run.reason = reason; run.ended_at = new Date().toISOString(); run.duration_seconds = (performance.now() - startMono) / 1000;
    const captureFile = join(p.runs, runId, 'capture.json');
    run.capture_duration_seconds = existsSync(captureFile) && Number.isFinite(readJSON(captureFile).capture_elapsed_monotonic_ms) ? readJSON(captureFile).capture_elapsed_monotonic_ms / 1000 : null;
    run.children = Object.fromEntries([...records].map(([role, r]) => [role, { exit_code: r.code, signal: r.signal }]));
    if (run.phase === 'STOPPED' && (records.size !== 3 || [...records.values()].some(r => r.code !== 0 || r.signal !== null))) {
      run.phase = 'FAILED'; run.reason = 'CHILD_SHUTDOWN_INCOMPLETE';
    }
    try { run.final_status = status(workspace); } catch (error) { run.final_status = { error_code: errorCode(error) }; }
    try { run.run_evidence = runEvidence(workspace,runId); } catch (error) { run.run_evidence = { error_code: errorCode(error) }; }
    try { save(); } finally { lock.release(); }
  }
  return run;
}

export function requestStop(workspace) {
  const p = paths(workspace), file = join(p.lock, 'owner.json');
  if (!existsSync(file)) return { state: 'ALREADY_STOPPED' };
  const owner = readJSON(file);
  if (!alive(owner) || owner.kind !== 'run') fail('RUNNING_SUPERVISOR_NOT_FOUND');
  atomicJSON(p.stop, { run_id: owner.run_id, requested_at: new Date().toISOString() });
  return { state: 'STOP_REQUESTED', run_id: owner.run_id };
}
