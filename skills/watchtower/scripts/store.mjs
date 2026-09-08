import { DatabaseSync } from 'node:sqlite';
import { statSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX = 1024 * 1024 * 1024;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
function fail(message, code = 'INVALID_EVIDENCE') { const e = new Error(message); e.code = code; throw e; }
export function quantity(value, label = 'quantity') {
  if (typeof value !== 'string' || !QUANTITY.test(value)) fail(`${label} must be an RPC hex quantity`);
  return BigInt(value);
}
export function index(value, label = 'index') {
  const n = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : quantity(value, label);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} exceeds safe index range`);
  return Number(n);
}
function hash(value, label) { if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a 32-byte hash`); return value.toLowerCase(); }
function address(value, label, nullable = false) { if (nullable && value === null) return; if (typeof value !== 'string' || !ADDRESS.test(value)) fail(`${label} must be an address`); }
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
function parse(value) { return JSON.parse(value); }
function metadata(meta = {}) {
  const result = {};
  for (const key of ['source', 'run_id', 'clock_id', 'observed_mono_ns', 'observed_at', 'delivery']) {
    if (meta[key] !== undefined) {
      if (typeof meta[key] !== 'string' || meta[key].length > 512 || /(?:https?|wss?):\/\//i.test(meta[key])) fail(`Invalid ${key} metadata; endpoint URLs must not be retained`);
      result[key] = meta[key];
    }
  }
  if (result.observed_mono_ns !== undefined && !/^\d+$/.test(result.observed_mono_ns)) fail('observed_mono_ns must be decimal nanoseconds');
  if (result.observed_at !== undefined && !Number.isFinite(Date.parse(result.observed_at))) fail('observed_at must be an ISO timestamp');
  return result;
}

export function validateBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Full block object required');
  const blockHash = hash(raw.hash, 'block.hash'), parentHash = hash(raw.parentHash, 'block.parentHash'), number = index(raw.number, 'block.number');
  if (!Array.isArray(raw.transactions)) fail('block.transactions must contain full transaction objects');
  const seen = new Set();
  raw.transactions.forEach((tx, i) => {
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) fail('Full included transaction objects required, not hashes');
    const txHash = hash(tx.hash, 'transaction.hash');
    if (seen.has(txHash)) fail('Duplicate included transaction hash'); seen.add(txHash);
    if (hash(tx.blockHash, 'transaction.blockHash') !== blockHash || index(tx.blockNumber, 'transaction.blockNumber') !== number || index(tx.transactionIndex, 'transaction.transactionIndex') !== i) fail('Included transaction block identity or order mismatch');
    address(tx.from, 'transaction.from'); address(tx.to, 'transaction.to', true);
    for (const key of ['nonce', 'value', 'gas', 'type']) if (tx[key] !== undefined) quantity(tx[key], `transaction.${key}`);
    // Type is deliberately not restricted: Nitro/unknown future transaction types remain evidence.
    if (tx.input !== undefined && (typeof tx.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input))) fail('transaction.input must be hex bytes');
  });
  return { number, hash: blockHash, parent_hash: parentHash, raw: stable(raw), transaction_count: raw.transactions.length };
}

export function validateReceipts(block, receipts) {
  if (!Array.isArray(receipts) || receipts.length !== block.transactions.length) fail('Receipt count must match every included transaction exactly once');
  const byIndex = new Map(); let previousLog = -1;
  const sorted = [...receipts].sort((a, b) => index(a?.transactionIndex, 'receipt.transactionIndex') - index(b?.transactionIndex, 'receipt.transactionIndex'));
  sorted.forEach((receipt, i) => {
    const tx = block.transactions[i];
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('Receipt object required');
    if (index(receipt.transactionIndex, 'receipt.transactionIndex') !== i || byIndex.has(i)) fail('Receipt indexes must be unique and complete');
    byIndex.set(i, receipt);
    if (hash(receipt.transactionHash, 'receipt.transactionHash') !== hash(tx.hash, 'tx.hash') || hash(receipt.blockHash, 'receipt.blockHash') !== hash(block.hash, 'block.hash') || index(receipt.blockNumber, 'receipt.blockNumber') !== index(block.number, 'block.number')) fail('Receipt transaction/block identity mismatch');
    const status = quantity(receipt.status, 'receipt.status'); if (status !== 0n && status !== 1n) fail('Included receipt status must be success or failure');
    if (receipt.from !== undefined) { address(receipt.from, 'receipt.from'); if (receipt.from.toLowerCase() !== tx.from.toLowerCase()) fail('Receipt sender mismatch'); }
    if (receipt.to !== undefined) { address(receipt.to, 'receipt.to', true); if ((receipt.to?.toLowerCase() ?? null) !== (tx.to?.toLowerCase() ?? null)) fail('Receipt recipient mismatch'); }
    if (!Array.isArray(receipt.logs)) fail('Receipt logs array required');
    if (status === 0n && receipt.logs.length !== 0) fail('Failed receipt cannot retain successful EVM logs');
    for (const log of receipt.logs) {
      if (hash(log.blockHash, 'log.blockHash') !== hash(block.hash, 'block.hash') || index(log.blockNumber, 'log.blockNumber') !== index(block.number, 'block.number') || hash(log.transactionHash, 'log.transactionHash') !== hash(tx.hash, 'tx.hash') || index(log.transactionIndex, 'log.transactionIndex') !== i) fail('Receipt log identity mismatch');
      const logIndex = index(log.logIndex, 'log.logIndex');
      if (logIndex !== previousLog + 1) fail('Receipt log indexes must be complete, contiguous and ordered'); previousLog = logIndex;
      if (log.removed !== undefined && log.removed !== false) fail('Removed logs cannot reconcile current block receipts');
      address(log.address, 'log.address');
      if (!Array.isArray(log.topics) || log.topics.length > 4) fail('Invalid log topics');
      log.topics.forEach(t => hash(t, 'log.topic'));
      if (typeof log.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)) fail('log.data must be hex bytes');
    }
  });
  return sorted;
}

/** RPC-derived selected branch; completeness is explicit in coverage(), never finality or trie proof. */
export function openStore(path, options = {}) {
  if ((path === ':memory:' || !existsSync(path)) && options.startBlock === undefined) fail('New stores require an explicit startBlock', 'CONFIG_REQUIRED');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path); let closed = false, mutating = false, storageBlocked = false;
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA wal_autocheckpoint=0;');
  db.exec(`CREATE TABLE IF NOT EXISTS wt_config (id INTEGER PRIMARY KEY CHECK(id=1), chain_id INTEGER NOT NULL, start_block INTEGER NOT NULL, max_bytes INTEGER NOT NULL, reorg_depth INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wt_blocks(hash TEXT PRIMARY KEY, number INTEGER NOT NULL, parent_hash TEXT NOT NULL, canonical INTEGER NOT NULL, raw TEXT NOT NULL, meta TEXT NOT NULL, tx_count INTEGER NOT NULL, receipts_complete INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS wt_canonical_height ON wt_blocks(number) WHERE canonical=1;
    CREATE INDEX IF NOT EXISTS wt_block_height ON wt_blocks(number);
    CREATE INDEX IF NOT EXISTS wt_pending_receipt_height ON wt_blocks(number DESC) WHERE canonical=1 AND receipts_complete=0;
    CREATE TABLE IF NOT EXISTS wt_receipts(block_hash TEXT PRIMARY KEY REFERENCES wt_blocks(hash), raw TEXT NOT NULL, meta TEXT NOT NULL, receipt_count INTEGER NOT NULL, log_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wt_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, block_hash TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS wt_progress(id INTEGER PRIMARY KEY CHECK(id=1), canonical_head INTEGER, contiguous_block_head INTEGER, contiguous_receipt_head INTEGER, block_count INTEGER NOT NULL, transaction_count INTEGER NOT NULL, receipt_count INTEGER NOT NULL, pending_receipt_blocks INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wt_observations(run_id TEXT NOT NULL, clock_id TEXT NOT NULL, source TEXT NOT NULL, stage TEXT NOT NULL, event_id TEXT NOT NULL, observed_mono_ns TEXT NOT NULL, observed_at TEXT, meta TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,clock_id,source,stage,event_id));`);
  let config = db.prepare('SELECT * FROM wt_config WHERE id=1').get();
  if (config) {
    if (options.chainId !== undefined && options.chainId !== config.chain_id) { db.close(); fail('Stored chain identity mismatch', 'CONFIG_MISMATCH'); }
    if (options.startBlock !== undefined && index(options.startBlock, 'startBlock') !== config.start_block) { db.close(); fail('Stored start block mismatch', 'CONFIG_MISMATCH'); }
  } else {
    const chain = options.chainId ?? 4663, start = index(options.startBlock, 'startBlock'), max = options.maxBytes ?? DEFAULT_MAX, depth = options.reorgDepth ?? 128;
    if (chain !== 4663) { db.close(); fail('WATCHTOWER native chain must be 4663', 'CONFIG_MISMATCH'); }
    for (const [key, value] of Object.entries({ maxBytes: max, reorgDepth: depth })) if (!Number.isSafeInteger(value) || value <= 0) { db.close(); fail(`Invalid ${key}`); }
    db.prepare('INSERT INTO wt_config VALUES(1,?,?,?,?)').run(chain, start, max, depth);
    config = db.prepare('SELECT * FROM wt_config').get();
  }
  if (options.maxBytes !== undefined && options.maxBytes !== config.max_bytes) { db.close(); fail('Stored storage budget mismatch; reopen with persisted configuration', 'CONFIG_MISMATCH'); }
  if (options.reorgDepth !== undefined && options.reorgDepth !== config.reorg_depth) { db.close(); fail('Stored reorg depth mismatch', 'CONFIG_MISMATCH'); }
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  db.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor(config.max_bytes / pageSize))};`);
  function diskBytes() {
    if (path === ':memory:') return Number(db.prepare('PRAGMA page_count').get().page_count) * pageSize;
    return ['', '-wal', '-shm', '-journal'].reduce((n, suffix) => { try { return n + statSync(path + suffix).size; } catch (e) { if (e.code !== 'ENOENT') throw e; return n; } }, 0);
  }
  function checkpoint() { if (path !== ':memory:') db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); }
  function budget(before = false, hint = 0) {
    let size = diskBytes();
    if ((before && size + hint > config.max_bytes) || size > config.max_bytes) { checkpoint(); size = diskBytes(); }
    if (size > config.max_bytes || (before && size + hint > config.max_bytes)) { storageBlocked = true; fail(`Storage budget exhausted (${size}/${config.max_bytes} bytes); ingestion must stop`, 'STORAGE_LIMIT'); }
    storageBlocked = false;
  }
  try { checkpoint(); budget(); } catch (e) { db.close(); throw e; }
  function mutate(fn, { bytesHint = 0 } = {}) {
    if (closed) fail('Store is closed', 'STORE_CLOSED');
    if (mutating) fail('Nested store mutation is unsupported', 'NESTED_MUTATION');
    budget(true, bytesHint);
    // Bound WAL growth without checkpointing each capture event.
    if (path !== ':memory:') { let wal = 0; try { wal = statSync(path + '-wal').size; } catch {} if (wal >= Math.min(4 * 1024 * 1024, config.max_bytes / 4)) checkpoint(); }
    db.exec('BEGIN IMMEDIATE'); mutating = true;
    let result;
    try {
      result = fn();
      if (result && typeof result.then === 'function') fail('Store mutations must be synchronous');
      const logical = Number(db.prepare('PRAGMA page_count').get().page_count) * pageSize;
      if (logical > config.max_bytes) fail('Projected database exceeds storage budget', 'STORAGE_LIMIT');
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} mutating = false; if (/database or disk is full/i.test(e.message)) { e.code = 'STORAGE_LIMIT'; storageBlocked = true; } throw e; }
    mutating = false;
    try { budget(); } catch (e) { e.committed = true; throw e; }
    return result;
  }
  function rowAt(n) { return db.prepare('SELECT * FROM wt_blocks WHERE canonical=1 AND number=?').get(index(n, 'block number')); }
  function headerAt(n) { return db.prepare('SELECT number,hash,parent_hash,receipts_complete FROM wt_blocks WHERE canonical=1 AND number=?').get(index(n, 'block number')); }
  function event(kind, blockHash, payload = null) { db.prepare('INSERT INTO wt_events(kind,block_hash,payload) VALUES(?,?,?)').run(kind, blockHash, payload === null ? null : stable(payload)); }
  function writeProgress(p) {
    db.prepare('INSERT INTO wt_progress VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_head=excluded.canonical_head,contiguous_block_head=excluded.contiguous_block_head,contiguous_receipt_head=excluded.contiguous_receipt_head,block_count=excluded.block_count,transaction_count=excluded.transaction_count,receipt_count=excluded.receipt_count,pending_receipt_blocks=excluded.pending_receipt_blocks').run(p.canonical_head, p.contiguous_block_head, p.contiguous_receipt_head, p.block_count, p.transaction_count, p.receipt_count, p.pending_receipt_blocks);
  }
  function advanceProgress(p) {
    let next = p.contiguous_block_head === null ? config.start_block : p.contiguous_block_head + 1;
    let parent = p.contiguous_block_head === null ? null : headerAt(p.contiguous_block_head)?.hash;
    for (;;) {
      const row = headerAt(next);
      if (!row || (parent !== null && row.parent_hash !== parent)) break;
      p.contiguous_block_head = next; next++; parent = row.hash;
    }
    next = p.contiguous_receipt_head === null ? config.start_block : p.contiguous_receipt_head + 1;
    while (p.contiguous_block_head !== null && next <= p.contiguous_block_head) {
      const row = headerAt(next); if (!row?.receipts_complete) break;
      p.contiguous_receipt_head = next; next++;
    }
    writeProgress(p);
  }
  function progress() {
    const p = db.prepare('SELECT canonical_head,contiguous_block_head,contiguous_receipt_head,block_count,transaction_count,receipt_count,pending_receipt_blocks FROM wt_progress WHERE id=1').get();
    return { chain_id: config.chain_id, start_block: config.start_block, ...p, complete_through_head: p.canonical_head !== null && p.contiguous_block_head === p.canonical_head, receipt_complete_through_head: p.canonical_head !== null && p.contiguous_receipt_head === p.canonical_head, storage_bytes: diskBytes(), max_bytes: config.max_bytes, storage_blocked: storageBlocked, evidence_kind: 'rpc-derived', finalized: false, receipt_trie_verified: false };
  }
  function rebuildProgress() { writeProgress(coverage()); }
  function invalidate(from, reason) {
    const rows = db.prepare('SELECT hash,number FROM wt_blocks WHERE canonical=1 AND number>=? ORDER BY number').all(from);
    const head = rows.at(-1)?.number;
    if (head !== undefined && head - from + 1 > config.reorg_depth) fail('Reorganization exceeds configured recovery depth; operator repair required', 'REORG_TOO_DEEP');
    if (!rows.length) return [];
    db.prepare('UPDATE wt_blocks SET canonical=0 WHERE canonical=1 AND number>=?').run(from);
    rebuildProgress();
    event('invalidate', null, { from_block: from, reason, hashes: rows.map(r => r.hash) });
    return rows.map(r => r.number);
  }
  function putBlock(raw, meta = {}) {
    const record = validateBlock(raw), m = metadata(meta);
    if (record.number < config.start_block) fail('Block precedes configured coverage start');
    const prior = db.prepare('SELECT * FROM wt_blocks WHERE hash=?').get(record.hash);
    if (prior && prior.raw !== record.raw) fail('Source changed full block content under an existing block hash', 'SOURCE_DRIFT');
    return mutate(() => {
      if (prior?.canonical) return { inserted: false, canonical: true, invalidated: [] };
      const predecessor = headerAt(record.number - 1 < 0 ? 0 : record.number - 1);
      if (record.number > config.start_block && predecessor && predecessor.hash !== record.parent_hash) fail('Block parent disagrees with retained predecessor', 'PARENT_MISMATCH');
      const current = headerAt(record.number), successor = headerAt(record.number + 1); let invalidated = [];
      if (current && current.hash !== record.hash) invalidated = invalidate(record.number, 'primary block replacement');
      else if (successor && successor.parent_hash !== record.hash) invalidated = invalidate(record.number + 1, 'predecessor revealed disconnected branch');
      if (prior) db.prepare('UPDATE wt_blocks SET canonical=1 WHERE hash=?').run(record.hash);
      else db.prepare('INSERT INTO wt_blocks(hash,number,parent_hash,canonical,raw,meta,tx_count) VALUES(?,?,?,1,?,?,?)').run(record.hash, record.number, record.parent_hash, record.raw, stable(m), record.transaction_count);
      const p = progress();
      p.canonical_head = p.canonical_head === null ? record.number : Math.max(p.canonical_head, record.number);
      p.block_count++; p.transaction_count += record.transaction_count;
      if (prior?.receipts_complete) p.receipt_count += record.transaction_count; else p.pending_receipt_blocks++;
      advanceProgress(p);
      event('block', record.hash);
      if (prior?.receipts_complete) event('receipts', record.hash);
      return { inserted: !prior, canonical: true, invalidated };
    }, { bytesHint: prior ? 0 : Buffer.byteLength(record.raw) + 8192 });
  }
  function putReceipts(blockHash, rawReceipts, meta = {}) {
    const h = hash(blockHash, 'blockHash'), row = db.prepare('SELECT * FROM wt_blocks WHERE hash=?').get(h);
    if (!row) fail('Cannot retain receipts without their complete block');
    const receipts = validateReceipts(parse(row.raw), rawReceipts), raw = stable(receipts), m = metadata(meta);
    const prior = db.prepare('SELECT raw FROM wt_receipts WHERE block_hash=?').get(h);
    if (prior && prior.raw !== raw) fail('Source changed receipt content under an existing block hash', 'SOURCE_DRIFT');
    return mutate(() => {
      if (prior) return { inserted: false, receipt_count: receipts.length };
      const logs = receipts.reduce((n, r) => n + r.logs.length, 0);
      db.prepare('INSERT INTO wt_receipts VALUES(?,?,?,?,?)').run(h, raw, stable(m), receipts.length, logs);
      db.prepare('UPDATE wt_blocks SET receipts_complete=1 WHERE hash=?').run(h);
      if (row.canonical) { const p = progress(); p.receipt_count += receipts.length; p.pending_receipt_blocks--; advanceProgress(p); }
      if (row.canonical) event('receipts', h);
      return { inserted: true, receipt_count: receipts.length, log_count: logs };
    }, { bytesHint: prior ? 0 : Buffer.byteLength(raw) + 4096 });
  }
  function coverage() {
    const rows = db.prepare('SELECT number,hash,parent_hash,tx_count,receipts_complete FROM wt_blocks WHERE canonical=1 ORDER BY number').all();
    let blockHead = null, receiptHead = null, expected = config.start_block, previous = null, receiptRun = true;
    const gaps = [], disconnected = []; let nextMissing = config.start_block;
    for (const row of rows) {
      if (row.number > nextMissing) gaps.push({ from_block: nextMissing, to_block: row.number - 1 }); nextMissing = row.number + 1;
      if (row.number === expected && (previous === null || row.parent_hash === previous)) {
        blockHead = row.number; expected++; previous = row.hash;
        if (receiptRun && row.receipts_complete) receiptHead = row.number; else receiptRun = false;
      } else disconnected.push(row.number);
    }
    const head = rows.at(-1)?.number ?? null;
    const counts = db.prepare('SELECT COALESCE(SUM(r.receipt_count),0) AS receipts FROM wt_receipts r JOIN wt_blocks b ON b.hash=r.block_hash WHERE b.canonical=1').get();
    return { chain_id: config.chain_id, start_block: config.start_block, canonical_head: head, contiguous_block_head: blockHead, contiguous_receipt_head: receiptHead, block_count: rows.length, transaction_count: rows.reduce((n, r) => n + r.tx_count, 0), receipt_count: counts.receipts, pending_receipt_blocks: rows.filter(r => !r.receipts_complete).length, gaps, disconnected_blocks: disconnected, complete_through_head: head !== null && blockHead === head, receipt_complete_through_head: head !== null && receiptHead === head, storage_bytes: diskBytes(), max_bytes: config.max_bytes, storage_blocked: storageBlocked, evidence_kind: 'rpc-derived', finalized: false, receipt_trie_verified: false };
  }
  function receipts(h) { const row = db.prepare('SELECT raw FROM wt_receipts WHERE block_hash=?').get(hash(h, 'blockHash')); return row ? parse(row.raw) : null; }
  function observations() { return db.prepare('SELECT * FROM wt_observations ORDER BY run_id,clock_id,source,stage,event_id').all().map(r => ({ ...r, delivery: parse(r.meta).delivery ?? null, meta: parse(r.meta), payload: parse(r.payload) })); }
  if (!db.prepare('SELECT 1 FROM wt_progress WHERE id=1').get()) mutate(rebuildProgress);
  return {
    db, mutate, putBlock, putReceipts, receipts, coverage, progress, observations,
    blockMeta(h) { const row = db.prepare('SELECT meta FROM wt_blocks WHERE hash=?').get(hash(h, 'blockHash')); return row ? parse(row.meta) : null; },
    blockByHash(h) { const row = db.prepare('SELECT raw FROM wt_blocks WHERE hash=?').get(hash(h, 'blockHash')); return row ? parse(row.raw) : null; },
    block(n) { const r = rowAt(n); return r ? parse(r.raw) : null; },
    isCanonical(h) { return !!db.prepare('SELECT 1 FROM wt_blocks WHERE hash=? AND canonical=1').get(hash(h, 'blockHash')); },
    rewind(fromBlock, reason = 'operator rewind') { const from = index(fromBlock, 'fromBlock'); if (from < config.start_block) fail('Rewind precedes configured start'); if (typeof reason !== 'string' || reason.length > 1024 || /(?:https?|wss?):\/\//i.test(reason)) fail('Invalid rewind reason'); return mutate(() => ({ invalidated: invalidate(from, reason) })); },
    pendingReceipts(limit = 100) { const n = index(limit, 'limit'); if (n > 10000) fail('Receipt query limit exceeds 10000'); return db.prepare('SELECT raw FROM wt_blocks WHERE canonical=1 AND receipts_complete=0 ORDER BY number DESC LIMIT ?').all(n).map(r => parse(r.raw)); },
    transactions(h) { const row = db.prepare('SELECT raw FROM wt_blocks WHERE hash=?').get(hash(h, 'blockHash')); return row ? parse(row.raw).transactions : []; },
    readEvents(after = 0, limit = 100) {
      const n = index(limit, 'limit'); if (n > 10000) fail('Event query limit exceeds 10000');
      return db.prepare('SELECT * FROM wt_events WHERE seq>? ORDER BY seq LIMIT ?').all(index(after, 'after'), n).map(r => ({ seq: r.seq, kind: r.kind, block_hash: r.block_hash, payload: r.kind === 'block' ? parse(db.prepare('SELECT raw FROM wt_blocks WHERE hash=?').get(r.block_hash).raw) : r.kind === 'receipts' ? { block_hash: r.block_hash, receipts: receipts(r.block_hash) } : parse(r.payload) }));
    },
    observe(stage, eventId, meta, payload = {}) {
      const m = metadata(meta);
      for (const key of ['run_id', 'clock_id', 'source', 'observed_mono_ns']) if (m[key] === undefined) fail(`Observation requires ${key}`);
      for (const [key, value] of Object.entries({ stage, eventId })) if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /(?:https?|wss?):\/\//i.test(value)) fail(`Invalid observation ${key}`);
      const raw = stable(payload); if (/(?:https?|wss?):\/\//i.test(raw)) fail('Observation payload must not contain endpoint URLs');
      return mutate(() => {
        const keys = [m.run_id, m.clock_id, m.source, stage, eventId];
        const prior = db.prepare('SELECT observed_mono_ns FROM wt_observations WHERE run_id=? AND clock_id=? AND source=? AND stage=? AND event_id=?').get(...keys);
        if (prior && BigInt(prior.observed_mono_ns) <= BigInt(m.observed_mono_ns)) return { inserted: false };
        db.prepare('INSERT INTO wt_observations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,clock_id,source,stage,event_id) DO UPDATE SET observed_mono_ns=excluded.observed_mono_ns,observed_at=excluded.observed_at,meta=excluded.meta,payload=excluded.payload').run(...keys, m.observed_mono_ns, m.observed_at ?? null, stable(m), raw);
        return { inserted: !prior, replaced_with_earlier: !!prior };
      }, { bytesHint: Buffer.byteLength(raw) + 1024 });
    },
    stats() { return { ...coverage(), retained_blocks: db.prepare('SELECT COUNT(*) AS n FROM wt_blocks').get().n, orphan_blocks: db.prepare('SELECT COUNT(*) AS n FROM wt_blocks WHERE canonical=0').get().n, event_count: db.prepare('SELECT COUNT(*) AS n FROM wt_events').get().n, observation_count: db.prepare('SELECT COUNT(*) AS n FROM wt_observations').get().n, journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode }; },
    close() { if (!closed) { try { checkpoint(); } finally { db.close(); closed = true; } } }
  };
}
