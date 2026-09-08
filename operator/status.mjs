import { DatabaseSync } from 'node:sqlite';
import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../skills/watchtower/scripts/capture.mjs';
import { latencyReport } from '../skills/watchtower/scripts/latency.mjs';
import { alive, diskBytes, fail, paths, readJSON } from './common.mjs';
import { loadConfig } from './config.mjs';

const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export function readDB(file, fn) {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=1000');
  try { return fn(db); } finally { db.close(); }
}
export function persistedConfig(config) {
  const stored = readDB(config.paths.db, db => db.prepare('SELECT * FROM wt_config WHERE id=1').get());
  if (stored) {
    if (stored.chain_id !== 4663 || stored.start_block !== config.capture.from_block || stored.reorg_depth !== config.capture.reorg_depth) fail('PERSISTED_CAPTURE_CONFIG_MISMATCH');
    // Explicit capacity expansion commits the database first. It is authoritative after a crash.
    config.capture.max_db_bytes = stored.max_bytes;
  }
  return config;
}
export function status(workspace) {
  const config = loadConfig(workspace), p = config.paths;
  const owner = existsSync(join(p.lock, 'owner.json')) ? readJSON(join(p.lock, 'owner.json')) : null;
  const state = existsSync(p.state) ? readJSON(p.state) : null;
  const fs = statfsSync(p.root, { bigint: true });
  const result = { schema: 'msk.operator.status.v1', generated_at: new Date().toISOString(), evidence_mode: config.evidence_mode,
    supervisor_alive: alive(owner), phase: state?.phase ?? 'NOT_STARTED', run_id: state?.run_id ?? null,
    heartbeat_age_ms: state?.heartbeat_at ? Math.max(0, Date.now() - Date.parse(state.heartbeat_at)) : null,
    configured_pools: config.registry.pools.length, storage: { database_bytes: diskBytes(p.db), filesystem_free_bytes: (fs.bavail * fs.bsize).toString() },
    coverage: null, workers: null, research: null, sources: [], health: 'NOT_STARTED', reasons: [] };
  readDB(p.db, db => {
    const stored = db.prepare('SELECT * FROM wt_config WHERE id=1').get();
    const progress = db.prepare('SELECT * FROM wt_progress WHERE id=1').get();
    result.coverage = { chain_id: stored.chain_id, start_block: stored.start_block, ...progress,
      complete_through_head: progress.canonical_head !== null && progress.contiguous_block_head === progress.canonical_head,
      receipt_complete_through_head: progress.canonical_head !== null && progress.contiguous_receipt_head === progress.canonical_head,
      evidence: 'RPC_REPORTED_INCLUDED_TRANSACTIONS', internal_calls: 'UNTRACED', finality: 'UNVERIFIED' };
    delete result.coverage.id;
    result.storage.max_db_bytes = stored.max_bytes;
    result.storage.usage_ratio = result.storage.database_bytes / stored.max_bytes;
    if (has(db, 'wt_jobs')) {
      const jobs = Object.fromEntries(db.prepare('SELECT status,count(*) AS n FROM wt_jobs GROUP BY status').all().map(r => [r.status, r.n]));
      result.workers = { jobs, pending: (jobs.QUEUED ?? 0) + (jobs.RUNNING ?? 0), failed: jobs.FAILED ?? 0,
        event_head: db.prepare('SELECT coalesce(max(seq),0) AS n FROM wt_events').get().n,
        policies: db.prepare('SELECT version,cursor FROM wt_policies').all() };
    }
    if (has(db, 'op_consumer')) {
      const cursor = db.prepare('SELECT cursor FROM op_consumer WHERE id=1').get().cursor;
      const head = db.prepare('SELECT coalesce(max(seq),0) AS n FROM wt_outbox').get().n;
      const counts = Object.fromEntries(db.prepare('SELECT status,count(*) AS n FROM op_results GROUP BY status').all().map(r => [r.status, r.n]));
      const usable = db.prepare(`SELECT count(*) AS n FROM op_results r JOIN wt_blocks b ON b.hash=r.block_hash
        WHERE r.status='CURRENT' AND b.canonical=1 AND r.generation=(SELECT max(seq) FROM wt_events WHERE block_hash=r.block_hash AND kind='block')`).get().n;
      result.research = { cursor, outbox_head: head, unacknowledged: db.prepare('SELECT count(*) AS n FROM wt_outbox WHERE seq>?').get(cursor).n,
        results: counts, currently_canonical_reports: usable, failed: counts.FAILED ?? 0 };
    }
    for (const source of config.capture.sources) {
      const latest = db.prepare("SELECT observed_at,payload FROM wt_observations WHERE source=? AND stage='source_health' ORDER BY observed_at DESC LIMIT 1").get(source.name);
      const payload = latest ? JSON.parse(latest.payload) : null;
      const head = payload?.head_hash ? db.prepare('SELECT raw FROM wt_blocks WHERE hash=?').get(payload.head_hash) : null;
      let headTime = null;
      try { if (head) { const raw = JSON.parse(head.raw).timestamp; if (/^0x[0-9a-f]+$/i.test(raw ?? '')) { const n = Number(BigInt(raw)) * 1000; if (Number.isSafeInteger(n)) headTime = n; } } } catch {}
      result.sources.push({ source: source.name, primary: source.name === config.capture.primary_source,
        last_observed_at: latest?.observed_at ?? null, observation_age_ms: latest?.observed_at ? Math.max(0, Date.now() - Date.parse(latest.observed_at)) : null,
        retained_head_age_ms: headTime === null ? null : Math.max(0, Date.now() - headTime), reported: payload });
    }
  });
  const primary = result.sources.find(s => s.primary);
  if (!result.supervisor_alive) result.reasons.push('OPERATOR_STOPPED');
  if (!primary?.last_observed_at) result.reasons.push('SOURCE_UNOBSERVED');
  else if (primary.observation_age_ms > config.limits.source_stale_seconds * 1000) result.reasons.push('SOURCE_STALE');
  if (primary?.reported?.syncing !== false) result.reasons.push('SOURCE_SYNC_UNVERIFIED');
  if (primary?.retained_head_age_ms === null || primary?.retained_head_age_ms > config.limits.source_stale_seconds * 1000) result.reasons.push('SOURCE_HEAD_STALE_OR_UNOBSERVED');
  if (!result.coverage?.complete_through_head) result.reasons.push('BLOCK_COVERAGE_INCOMPLETE');
  if (!result.coverage?.receipt_complete_through_head) result.reasons.push('RECEIPT_COVERAGE_INCOMPLETE');
  if (result.workers?.pending || result.research?.unacknowledged) result.reasons.push('WORK_PENDING');
  if (result.workers?.failed || result.research?.failed) result.reasons.push('FAILED_RESEARCH_OR_WORKER_JOBS');
  if (!config.registry.pools.length) result.reasons.push('NO_RESEARCH_POOLS_CONFIGURED');
  if (result.storage.usage_ratio >= config.limits.stop_at_storage_ratio) result.reasons.push('STORAGE_HIGH_WATER');
  if (BigInt(result.storage.filesystem_free_bytes) < BigInt(config.limits.minimum_free_bytes)) result.reasons.push('FILESYSTEM_RESERVE_LOW');
  result.health = result.reasons.length ? 'DEGRADED' : 'OBSERVED_HEALTHY';
  return result;
}

export async function doctor(workspace, { rpc } = {}) {
  const config = persistedConfig(loadConfig(workspace));
  const result = await probe(config.capture, { rpc });
  const primary = result.sources.find(s => s.name === config.capture.primary_source);
  return { schema: 'msk.operator.doctor.v1', ready_for_capture: primary?.state === 'available' && primary.full_blocks === 'observed_supported' && primary.syncing === false,
    research_pools: config.registry.pools.length, probe: result, state: status(workspace),
    notes: ['A probe is a bounded provider observation, not a sustained capacity or source authenticity check.',
      'Run capture and research on an owned persistent host; installation does not start a service.'] };
}

export function reports(workspace, { after = 0, limit = 20, includeEvidence = false } = {}) {
  const p = paths(workspace);
  return readDB(p.db, db => {
    if (!has(db, 'op_results')) return { schema: 'msk.operator.reports.v1', items: [] };
    const rows = db.prepare(`SELECT r.*,b.canonical AS block_canonical,
      (SELECT max(seq) FROM wt_events WHERE block_hash=r.block_hash AND kind='block') AS current_generation
      FROM op_results r JOIN wt_blocks b ON b.hash=r.block_hash WHERE r.outbox_seq>? ORDER BY r.outbox_seq LIMIT ?`).all(after, limit);
    return { schema: 'msk.operator.reports.v1', pagination: 'outbox_seq for new rows; re-query earlier report pages to observe later retractions', items: rows.map(row => {
      const valid = row.block_canonical === 1 && row.current_generation === row.generation;
      const item = { job_id: row.job_id, outbox_seq: row.outbox_seq, status: !valid && row.status === 'CURRENT' ? 'RETRACTED_PENDING_PROCESSING' : row.status,
        canonical_now: valid, generation: row.generation, report: row.report_json ? JSON.parse(row.report_json) : null, error_code: row.error_code, updated_at: row.updated_at };
      if (includeEvidence) item.evidence = { block: JSON.parse(db.prepare('SELECT raw FROM wt_blocks WHERE hash=?').get(row.block_hash).raw),
        receipts: JSON.parse(db.prepare('SELECT raw FROM wt_receipts WHERE block_hash=?').get(row.block_hash).raw),
        registry: JSON.parse(db.prepare('SELECT registry_json FROM op_consumer WHERE id=1').get().registry_json) };
      return item;
    }) };
  }) ?? { schema: 'msk.operator.reports.v1', items: [] };
}

export function runEvidence(workspace, runId) {
  return readDB(paths(workspace).db, db => {
    const rows = db.prepare('SELECT * FROM wt_observations WHERE run_id=? ORDER BY observed_at DESC LIMIT 50001').all(runId);
    const truncated = rows.length > 50000;
    const retained = rows.slice(0, 50000).map(row => ({ ...row, delivery: JSON.parse(row.meta).delivery ?? null }));
    const reports = db.prepare(`SELECT count(*) AS n FROM op_results r JOIN wt_blocks b ON b.hash=r.block_hash
      WHERE r.status='CURRENT' AND b.canonical=1 AND r.generation=(SELECT max(seq) FROM wt_events WHERE block_hash=r.block_hash AND kind='block')
      AND json_extract(r.report_json,'$.analysis_run_id')=? AND json_extract(r.report_json,'$.input_evidence.capture_run_id')=?`).get(runId,runId).n;
    return { canonical_reports_from_this_run: reports, latency: { ...latencyReport(retained), sampling: { kind: 'LATEST_ROWS_OF_SELECTED_RUN', max_rows: 50000, truncated, capture_run_ids: [...new Set(retained.map(r => r.run_id))] } } };
  });
}
export function acceptance(workspace, { runId, minimumSeconds = 86400 } = {}) {
  const config = loadConfig(workspace), p = config.paths;
  const state = runId ? readJSON(join(p.runs, runId, 'run.json')) : readJSON(p.state);
  const final = state.final_status ?? status(workspace), evidence = state.run_evidence ?? {};
  const staleSeconds = state.acceptance_policy?.source_stale_seconds ?? 0;
  const checks = { live_evidence: state.evidence_mode === 'live' && config.evidence_mode === 'live', config_matches: state.config_fingerprint === config.fingerprint, finished: state.phase === 'STOPPED',
    duration: Number.isFinite(state.capture_duration_seconds) && state.capture_duration_seconds >= minimumSeconds,
    blocks_complete: final.coverage?.complete_through_head === true, receipts_complete: final.coverage?.receipt_complete_through_head === true,
    workers_drained: final.workers?.pending === 0 && final.workers?.failed === 0 && final.workers.policies.every(p => p.cursor === final.workers.event_head),
    consumer_drained: final.research?.unacknowledged === 0 && final.research?.failed === 0,
    real_pool_report: (evidence.canonical_reports_from_this_run ?? 0) > 0,
    source_observed: final.sources?.some(s => s.primary && s.observation_age_ms !== null && s.observation_age_ms <= staleSeconds * 1000 && s.retained_head_age_ms !== null && s.retained_head_age_ms <= staleSeconds * 1000 && s.reported?.syncing === false) === true,
    clean_child_shutdown: ['capture','workers','consumer'].every(role => state.children?.[role]?.exit_code === 0 && state.children[role].signal === null),
    normal_stop: ['DURATION_LIMIT', 'STOP_REQUESTED'].includes(state.reason) };
  return { schema: 'msk.operator.acceptance.v1', result: Object.values(checks).every(Boolean) ? 'PASS' : 'INCOMPLETE', run_id: state.run_id,
    required_seconds: minimumSeconds, observed_seconds: state.capture_duration_seconds ?? null, checks, final_status: final, latency: evidence.latency ?? null,
    evaluation: 'RETAINED_END_OF_SELECTED_RUN; not current network health',
    recovery_validation: 'SEPARATE_TEST_EVIDENCE_REQUIRED', profitable_execution_established: false };
}
