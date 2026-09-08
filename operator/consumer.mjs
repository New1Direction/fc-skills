import { PoolEngine } from '../skills/pulse/scripts/pools.mjs';
import { randomUUID } from 'node:crypto';
import { validateBlock, validateReceipts } from '../skills/watchtower/scripts/store.mjs';
import { readOutbox, routeEvents } from '../skills/watchtower/scripts/workers.mjs';
import { digest, fail } from './common.mjs';

export function initializeConsumer(store, config) {
  routeEvents(store, { policy: config.capture.worker_policy, limit: 1 });
  store.mutate(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS op_database(id INTEGER PRIMARY KEY CHECK(id=1),logical_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS op_consumer(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL,registry_json TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS op_results(job_id TEXT PRIMARY KEY,outbox_seq INTEGER NOT NULL,block_hash TEXT NOT NULL,block_number INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,report_json TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS op_results_block ON op_results(block_hash,generation);
      CREATE INDEX IF NOT EXISTS op_results_status ON op_results(status);
      CREATE TABLE IF NOT EXISTS op_actions(outbox_seq INTEGER PRIMARY KEY,job_id TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS op_attempts(job_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,error_code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS op_retraction_scan(id INTEGER PRIMARY KEY CHECK(id=1),last_rowid INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO op_retraction_scan(id,last_rowid) VALUES(1,0);
      CREATE INDEX IF NOT EXISTS op_event_generation ON wt_events(block_hash,kind,seq DESC);
      CREATE INDEX IF NOT EXISTS op_observation_source_time ON wt_observations(source,observed_at DESC);
      CREATE INDEX IF NOT EXISTS op_observation_run_time ON wt_observations(run_id,observed_at DESC);
    `);
    store.db.prepare('INSERT OR IGNORE INTO op_database(id,logical_id) VALUES(1,?)').run(randomUUID());
    const current = store.db.prepare('SELECT * FROM op_consumer WHERE id=1').get();
    if (current && current.fingerprint !== config.fingerprint) fail('CONSUMER_REGISTRY_CHANGED_USE_NEW_WORKSPACE');
    if (!current) store.db.prepare('INSERT INTO op_consumer(id,fingerprint,registry_json,cursor) VALUES(1,?,?,0)').run(config.fingerprint, JSON.stringify(config.registry));
  });
}
function generation(store, hash) {
  return store.db.prepare("SELECT max(seq) AS n FROM wt_events WHERE block_hash=? AND kind='block'").get(hash).n;
}
function jobGeneration(store, id) {
  const row = store.db.prepare('SELECT payload_json FROM wt_jobs WHERE id=?').get(id);
  return row ? JSON.parse(row.payload_json).canonical_generation : null;
}
function currentlyValid(store, item, expectedGeneration) {
  return store.isCanonical(item.block_hash) && generation(store, item.block_hash) === expectedGeneration;
}

export function analyzeDispatch(store, item, config) {
  const dispatch = item.body;
  if (dispatch.schema_version !== 'watchtower.research-dispatch.v1' || dispatch.target.chain_id !== 4663 || !dispatch.target.pool_id) fail('UNSUPPORTED_DISPATCH');
  const pool = config.registry.pools.find(p => p.pool_id.toLowerCase() === dispatch.target.pool_id);
  if (!pool || dispatch.target.contract_address !== config.registry.manager) fail('DISPATCH_POOL_NOT_CONFIGURED');
  const block = store.blockByHash(item.block_hash), receipts = store.receipts(item.block_hash);
  if (!block || !receipts) fail('RECONCILED_RECEIPTS_REQUIRED');
  validateBlock(block); validateReceipts(block, receipts);
  if (block.hash.toLowerCase() !== dispatch.block.hash || Number(BigInt(block.number)) !== dispatch.block.number) fail('DISPATCH_BLOCK_MISMATCH');
  const logs = receipts.flatMap(receipt => receipt.logs).map(log => ({ ...log, removed: false }));
  if (logs.length > config.limits.max_logs_per_block) fail('RESEARCH_LOG_LIMIT');
  const meta = store.blockMeta(item.block_hash);
  const engine = new PoolEngine({ chain_id: 4663, manager: config.registry.manager, pools: [pool], routes: [] }, { max_logs_per_block: config.limits.max_logs_per_block });
  const change = engine.applyBlock({ number: block.number, hash: block.hash, parent_hash: block.parentHash, timestamp: block.timestamp,
    observed_at: meta?.observed_at ?? new Date().toISOString(), coverage: 'provider_reported_complete', logs });
  if (change.status !== 'APPLIED') fail('POOL_ANALYSIS_REJECTED');
  const swaps = change.events.filter(event => event.event === 'Swap');
  const gross = field => swaps.reduce((sum, swap) => sum + (BigInt(swap[field]) < 0n ? -BigInt(swap[field]) : BigInt(swap[field])), 0n).toString();
  const report = { schema: 'msk.pool-block-research.v1', evidence_mode: config.evidence_mode, analysis: 'PULSE_V4_CORE_OBSERVATIONS',
    scope: 'SINGLE_RECONCILED_BLOCK', job_id: item.job_id, policy_version: dispatch.policy_version, consumer_fingerprint: config.fingerprint,
    analysis_run_id: config.operator_run_id ?? null,
    chain_id: 4663, manager: config.registry.manager, pool_id: pool.pool_id, block: dispatch.block,
    input_evidence: { block_sha256: digest(block), receipts_sha256: digest(receipts), registry_sha256: digest(config.registry),
      storage: 'SAME_DURABLE_DATABASE', transaction_count: block.transactions.length, receipt_count: receipts.length,
      log_count: logs.length, observed_at: meta?.observed_at ?? null, capture_run_id: meta?.run_id ?? null, delivery: meta?.delivery ?? 'UNKNOWN' },
    summary: { swap_events: swaps.length, unique_transactions: new Set(swaps.map(s => s.transaction_hash)).size,
      gross_amount0_raw: gross('amount0_raw'), gross_amount1_raw: gross('amount1_raw'), trader_count: null,
      pool_inventory: null, executable_proceeds: null, net_profit: null },
    events: change.events, pool_state: engine.snapshot().pools[0], created_at: new Date().toISOString(),
    limitations: ['Independent single-block analysis; outbox completion order is not chain order.',
      'Raw core amounts are not USD volume or attributed wallet participation.',
      'Registry decimals and initialization evidence are supplied; deployment and provider authenticity are not established.',
      'Nonzero hooks remain unqualified; spot marks are not wallet execution quotes.',
      'Canonical status is provisional and may be retracted; no trade is signed or submitted.'] };
  if (Buffer.byteLength(JSON.stringify(report)) > config.limits.max_result_bytes) fail('RESEARCH_RESULT_BYTE_LIMIT');
  return report;
}

/** Atomically acknowledge each source row only after a result or explicit disposition is durable. */
export function consumeBatch(store, config, { limit = 32, beforeCommit, analyzer = analyzeDispatch } = {}) {
  // Retract orphaned results even if an earlier incomplete block defers the ordinary cursor.
  // Bound rows examined, not just rows updated: a LIMIT after an orphan predicate
  // would still rescan every valid historical report on each 100 ms round.
  store.mutate(() => {
    const after = store.db.prepare('SELECT last_rowid FROM op_retraction_scan WHERE id=1').get().last_rowid;
    const rows = store.db.prepare('SELECT rowid,job_id,block_hash,generation,status FROM op_results WHERE rowid>? ORDER BY rowid LIMIT 64').all(after);
    for (const row of rows) if (row.status === 'CURRENT' && (!store.isCanonical(row.block_hash) || generation(store,row.block_hash) !== row.generation)) {
      store.db.prepare("UPDATE op_results SET status='RETRACTED',updated_at=? WHERE job_id=?").run(new Date().toISOString(),row.job_id);
    }
    store.db.prepare('UPDATE op_retraction_scan SET last_rowid=? WHERE id=1').run(rows.length < 64 ? 0 : rows.at(-1).rowid);
  });
  const cursor = store.db.prepare('SELECT cursor FROM op_consumer WHERE id=1').get().cursor;
  // This call processes WATCHTOWER invalidations, so it must be outside our transaction.
  const items = readOutbox(store, { after: cursor, limit, includeInvalidated: true });
  const summary = { processed: 0, analyzed: 0, retracted: 0, failed: 0, deferred: 0, cursor };
  for (const item of items) {
    const gen = jobGeneration(store, item.job_id);
    let report = null, failure = null;
    if (item.kind === 'research_dispatch' && item.canonical && currentlyValid(store, item, gen)) {
      // A retained tail block can precede missing earlier receipts. Do not bless a gap.
      const progress = store.progress();
      if (progress.contiguous_receipt_head === null || item.body.block.number > progress.contiguous_receipt_head) { summary.deferred++; break; }
      try { report = analyzer(store, item, config); }
      catch (error) { failure = /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code ?? '') ? error.code : 'POOL_ANALYSIS_FAILED'; }
    }
    if (failure) {
      let attempts;
      store.mutate(() => {
        store.db.prepare('INSERT INTO op_attempts(job_id,attempts,error_code) VALUES(?,1,?) ON CONFLICT(job_id) DO UPDATE SET attempts=attempts+1,error_code=excluded.error_code').run(item.job_id, failure);
        attempts = store.db.prepare('SELECT attempts FROM op_attempts WHERE job_id=?').get(item.job_id).attempts;
      });
      if (attempts < 3) { summary.deferred++; break; }
    }
    beforeCommit?.(item, report);
    store.mutate(() => {
      const currentCursor = store.db.prepare('SELECT cursor FROM op_consumer WHERE id=1').get().cursor;
      if (currentCursor >= item.seq) return;
      const now = new Date().toISOString();
      if (item.kind === 'evidence_invalidated') {
        store.db.prepare("UPDATE op_results SET status='RETRACTED',updated_at=? WHERE job_id=?").run(now, item.body.invalidated_job_id);
        summary.retracted++;
      } else if (item.kind === 'research_dispatch') {
        const valid = currentlyValid(store, item, gen);
        const status = !valid || !item.canonical ? 'RETRACTED' : failure ? 'FAILED' : 'CURRENT';
        store.db.prepare('INSERT OR IGNORE INTO op_results VALUES(?,?,?,?,?,?,?,?,?,?)').run(item.job_id, item.seq, item.block_hash, item.body.block.number, gen ?? 0, status, report ? JSON.stringify(report) : null, failure, now, now);
        if (status === 'CURRENT') summary.analyzed++;
        if (status === 'FAILED') summary.failed++;
      }
      store.db.prepare('INSERT OR IGNORE INTO op_actions VALUES(?,?,?,?)').run(item.seq, item.job_id, item.kind, now);
      store.db.prepare('UPDATE op_consumer SET cursor=? WHERE id=1').run(item.seq);
      summary.cursor = item.seq; summary.processed++;
    });
  }
  return summary;
}
