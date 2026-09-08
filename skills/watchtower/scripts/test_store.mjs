import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';

const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const a = n => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const q = n => `0x${BigInt(n).toString(16)}`;
const clone = v => structuredClone(v);
const meta = { source: 'primary', run_id: 'run-1', clock_id: 'clock-1', observed_mono_ns: '123456789123456789', observed_at: '2026-09-08T12:00:00.000Z', delivery: 'http' };
function block(n, { id = n, parent = n - 1, count = 2 } = {}) {
  const hash = h(id);
  return { hash, parentHash: h(parent), number: q(n), timestamp: q(1788888000 + n), gasUsed: q(count * 21000), transactions: Array.from({ length: count }, (_, i) => ({ hash: h(id * 1000 + i + 100), blockHash: hash, blockNumber: q(n), transactionIndex: q(i), from: a(11), to: i ? a(12) : null, nonce: '0x20000000000001', value: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', gas: '0x5208', type: i ? '0x64' : '0x2', input: i ? '0xdeadbeef' : '0x60806040' })) };
}
function receipts(b) {
  let logIndex = 0;
  return b.transactions.map((tx, i) => ({ transactionHash: tx.hash, transactionIndex: q(i), blockHash: b.hash, blockNumber: b.number, from: tx.from, to: tx.to, status: i ? '0x0' : '0x1', gasUsed: '0x5208', cumulativeGasUsed: q((i + 1) * 21000), logs: i ? [] : [{ address: a(12), blockHash: b.hash, blockNumber: b.number, transactionHash: tx.hash, transactionIndex: q(i), logIndex: q(logIndex++), topics: [h(999)], data: '0x00', removed: false }] }));
}
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-store-')), path = join(dir, 'capture.sqlite');
  const store = openStore(path, { chainId: 4663, startBlock: 1, maxBytes: 32 * 1024 * 1024, reorgDepth: 8, ...options });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, path, dir };
}

test('retains all raw transactions including failed and unknown Nitro types without integer loss', t => {
  const { store } = fixture(t), b = block(1), rs = receipts(b);
  store.putBlock(b, meta);
  assert.equal(store.coverage().transaction_count, 2);
  assert.equal(store.coverage().receipt_count, 0);
  assert.equal(store.transactions(b.hash)[1].type, '0x64');
  assert.equal(store.transactions(b.hash)[0].nonce, '0x20000000000001');
  assert.equal(store.transactions(b.hash)[0].value, b.transactions[0].value);
  store.putReceipts(b.hash, rs, meta);
  assert.equal(store.receipts(b.hash)[1].status, '0x0');
  assert.deepEqual(store.block(1), b);
  assert.equal(store.coverage().receipt_complete_through_head, true);
  assert.equal(store.coverage().receipt_trie_verified, false);
  assert.equal(store.coverage().finalized, false);
});

test('durable restart retains progress, raw receipts, outbox cursor and metadata', t => {
  const { store, path } = fixture(t), b = block(1);
  store.putBlock(b, meta); store.putReceipts(b.hash, receipts(b), meta); store.observe('block', b.hash, meta, { number: 1 });
  const before = store.readEvents(); store.close();
  const resumed = openStore(path); t.after(() => resumed.close());
  assert.deepEqual(resumed.readEvents(), before); assert.equal(resumed.coverage().start_block, 1);
  assert.deepEqual(resumed.receipts(b.hash), receipts(b)); assert.equal(resumed.observations()[0].delivery, 'http');
  assert.equal(resumed.coverage().pending_receipt_blocks, 0);
});

test('pending receipt blocks survive restart and return newest first', t => {
  const { store, path } = fixture(t);
  store.putBlock(block(1)); store.putBlock(block(2)); store.close();
  const resumed = openStore(path); t.after(() => resumed.close());
  assert.deepEqual(resumed.pendingReceipts(10).map(b => b.number), ['0x2', '0x1']);
  resumed.putReceipts(h(2), receipts(block(2)));
  assert.equal(resumed.coverage().contiguous_receipt_head, null);
  resumed.putReceipts(h(1), receipts(block(1)));
  assert.equal(resumed.coverage().contiguous_receipt_head, 2);
});

test('gaps and disconnected history never produce complete coverage', t => {
  const { store } = fixture(t);
  store.putBlock(block(3)); assert.deepEqual(store.coverage().gaps, [{ from_block: 1, to_block: 2 }]);
  assert.deepEqual(store.coverage().disconnected_blocks, [3]); assert.equal(store.coverage().complete_through_head, false);
  store.putBlock(block(1)); assert.equal(store.coverage().contiguous_block_head, 1);
  store.putBlock(block(2)); assert.equal(store.coverage().contiguous_block_head, 3);
  assert.equal(store.coverage().complete_through_head, true);
});

test('wrong predecessor is rejected atomically', t => {
  const { store } = fixture(t); store.putBlock(block(1));
  assert.throws(() => store.putBlock(block(2, { parent: 999 })), { code: 'PARENT_MISMATCH' });
  assert.equal(store.coverage().canonical_head, 1); assert.equal(store.stats().retained_blocks, 1);
});

test('gap filling invalidates conflicting successor and descendants instead of stitching branches', t => {
  const { store } = fixture(t);
  store.putBlock(block(2, { parent: 51 })); store.putBlock(block(3));
  store.putBlock(block(1));
  assert.equal(store.block(2), null); assert.equal(store.block(3), null);
  assert.equal(store.stats().orphan_blocks, 2); assert.equal(store.coverage().canonical_head, 1);
  assert.deepEqual(store.readEvents().filter(e => e.kind === 'invalidate')[0].payload.hashes, [h(2), h(3)]);
});

test('replacement retains orphan raw blocks/receipts and invalidates descendants', t => {
  const { store } = fixture(t);
  for (let n = 1; n <= 3; n++) { const b = block(n); store.putBlock(b); store.putReceipts(b.hash, receipts(b)); }
  const replacement = block(2, { id: 52, parent: 1 }); store.putBlock(replacement);
  assert.equal(store.isCanonical(h(2)), false); assert.equal(store.isCanonical(h(3)), false);
  assert.deepEqual(store.receipts(h(2)), receipts(block(2))); assert.deepEqual(store.blockByHash(h(3)), block(3));
  assert.equal(store.block(2).hash, h(52)); assert.equal(store.block(3), null);
  assert.equal(store.coverage().transaction_count, 4); assert.equal(store.coverage().receipt_count, 2);
  assert.equal(store.coverage().pending_receipt_blocks, 1);
});

test('rewind is durable, idempotent and bounded by recovery depth', t => {
  const { store } = fixture(t, { reorgDepth: 2 });
  [1, 2, 3].forEach(n => store.putBlock(block(n)));
  assert.throws(() => store.rewind(1, 'too deep'), { code: 'REORG_TOO_DEEP' });
  assert.equal(store.coverage().canonical_head, 3);
  store.rewind(2, 'primary changed'); const count = store.stats().event_count;
  store.rewind(2, 'repeat'); assert.equal(store.stats().event_count, count);
  assert.equal(store.coverage().canonical_head, 1);
});

test('re-adoption of exact retained orphan emits both block and existing receipts', t => {
  const { store } = fixture(t), b = block(1);
  store.putBlock(b); store.putReceipts(b.hash, receipts(b)); store.rewind(1);
  store.putBlock(b);
  assert.deepEqual(store.readEvents().slice(-2).map(e => e.kind), ['block', 'receipts']);
  assert.equal(store.coverage().receipt_complete_through_head, true);
});

test('same block and receipt content is idempotent despite object key order', t => {
  const { store } = fixture(t), b = block(1), rs = receipts(b);
  store.putBlock(b); store.putReceipts(b.hash, rs);
  const swapped = Object.fromEntries(Object.entries(b).reverse());
  assert.equal(store.putBlock(swapped).inserted, false);
  assert.equal(store.putReceipts(b.hash, [...rs].reverse()).inserted, false);
  assert.equal(store.stats().event_count, 2);
});

test('same-hash altered raw block content is source drift', t => {
  const { store } = fixture(t), b = block(1); store.putBlock(b);
  const changed = clone(b); changed.transactions[0].value = '0x1';
  assert.throws(() => store.putBlock(changed), { code: 'SOURCE_DRIFT' });
  assert.equal(store.transactions(b.hash)[0].value, b.transactions[0].value);
});

test('same-hash altered complete receipt content is source drift', t => {
  const { store } = fixture(t), b = block(1), rs = receipts(b); store.putBlock(b); store.putReceipts(b.hash, rs);
  const changed = clone(rs); changed[0].gasUsed = '0x1';
  assert.throws(() => store.putReceipts(b.hash, changed), { code: 'SOURCE_DRIFT' });
  assert.deepEqual(store.receipts(b.hash), rs);
});

for (const [name, change] of [
  ['omitted receipt', r => r.pop()],
  ['duplicated receipt', r => { r[1] = clone(r[0]); }],
  ['wrong transaction hash', r => { r[0].transactionHash = h(444); }],
  ['wrong block hash', r => { r[0].blockHash = h(444); }],
  ['wrong block number', r => { r[0].blockNumber = '0x2'; }],
  ['invalid status', r => { r[0].status = '0x2'; }],
  ['missing status', r => { delete r[0].status; }],
  ['failed receipt with logs', r => { r[0].status = '0x0'; }],
  ['log wrong tx', r => { r[0].logs[0].transactionHash = h(444); }],
  ['log wrong block', r => { r[0].logs[0].blockHash = h(444); }],
  ['log gap', r => { r[0].logs[0].logIndex = '0x1'; }],
  ['removed log', r => { r[0].logs[0].removed = true; }],
  ['duplicate log', r => { r[0].logs.push(clone(r[0].logs[0])); }],
  ['invalid log bytes', r => { r[0].logs[0].data = '0x1'; }],
  ['wrong sender', r => { r[0].from = a(99); }]
]) test(`${name} prevents receipt coverage without losing raw transactions`, t => {
  const { store } = fixture(t), b = block(1), rs = receipts(b); store.putBlock(b); change(rs);
  assert.throws(() => store.putReceipts(b.hash, rs), { code: 'INVALID_EVIDENCE' });
  assert.equal(store.coverage().receipt_count, 0); assert.equal(store.coverage().transaction_count, 2);
  assert.equal(store.coverage().pending_receipt_blocks, 1); assert.equal(store.receipts(b.hash), null);
  assert.equal(store.stats().event_count, 1);
});

for (const [name, change] of [
  ['hash-only transactions', b => { b.transactions = b.transactions.map(t => t.hash); }],
  ['duplicate transaction', b => { b.transactions[1] = clone(b.transactions[0]); }],
  ['wrong tx block hash', b => { b.transactions[0].blockHash = h(55); }],
  ['wrong tx block number', b => { b.transactions[0].blockNumber = '0x2'; }],
  ['wrong tx order', b => { b.transactions.reverse(); }],
  ['unsafe block index', b => { b.number = '0x20000000000000'; }],
  ['malformed nonce', b => { b.transactions[0].nonce = 23; }]
]) test(`${name} prevents block coverage`, t => {
  const { store } = fixture(t), b = block(1); change(b);
  assert.throws(() => store.putBlock(b), { code: 'INVALID_EVIDENCE' });
  assert.equal(store.coverage().block_count, 0);
});

test('empty block explicitly reconciles empty receipt set', t => {
  const { store } = fixture(t), b = block(1, { count: 0 }); store.putBlock(b);
  assert.equal(store.coverage().pending_receipt_blocks, 1); store.putReceipts(b.hash, []);
  assert.equal(store.coverage().receipt_complete_through_head, true);
  assert.deepEqual(store.readEvents(1)[0].payload, { block_hash: b.hash, receipts: [] });
});

test('arrival observations retain earliest duplicates within same clock and distinguish sources/runs', t => {
  const { store } = fixture(t);
  store.observe('head', h(1), meta, { n: 1 });
  store.observe('head', h(1), { ...meta, observed_mono_ns: '123456789123456790' }, { n: 2 });
  assert.deepEqual(store.observations()[0].payload, { n: 1 });
  store.observe('head', h(1), { ...meta, observed_mono_ns: '123456789123456780' }, { n: 0 });
  assert.deepEqual(store.observations()[0].payload, { n: 0 });
  store.observe('head', h(1), { ...meta, source: 'secondary' }, {});
  store.observe('head', h(1), { ...meta, run_id: 'run-2' }, {});
  store.observe('head', h(1), { ...meta, clock_id: 'clock-2' }, {});
  assert.equal(store.observations().length, 4);
});

test('endpoint metadata is excluded and URL values are rejected', t => {
  const { store } = fixture(t);
  store.putBlock(block(1), { ...meta, endpoint: 'https://secret.example/private-key' });
  const stored = store.db.prepare('SELECT meta FROM wt_blocks').get().meta;
  assert.equal(stored.includes('secret'), false);
  assert.throws(() => store.observe('head', h(1), { ...meta, source: 'https://secret.example' }, {}));
  assert.throws(() => store.observe('head', h(1), meta, { endpoint: 'wss://secret.example' }));
  assert.equal(store.observations().length, 0);
});

test('persisted chain, start, budget and reorg configuration cannot be silently replaced', t => {
  const { store, path } = fixture(t); store.close();
  for (const opts of [{ chainId: 1 }, { startBlock: 2 }, { maxBytes: 999999 }, { reorgDepth: 2 }]) assert.throws(() => openStore(path, opts), { code: 'CONFIG_MISMATCH' });
});

test('missing explicit start does not create a new database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-new-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'absent.sqlite');
  assert.throws(() => openStore(path), { code: 'CONFIG_REQUIRED' }); assert.equal(existsSync(path), false);
});

test('worker SQL uses atomic mutations and rolls back failures', t => {
  const { store } = fixture(t);
  store.mutate(() => store.db.exec('CREATE TABLE test_worker(n INTEGER)'));
  assert.throws(() => store.mutate(() => { store.db.exec('INSERT INTO test_worker VALUES(1)'); throw new Error('crash'); }), /crash/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM test_worker').get().n, 0);
  assert.throws(() => store.mutate(() => store.mutate(() => {})), { code: 'NESTED_MUTATION' });
  store.putBlock(block(1)); assert.equal(store.coverage().block_count, 1);
});

test('storage budget stops before oversized payload and does not pretend complete coverage', t => {
  const { store } = fixture(t, { maxBytes: 512 * 1024 }); store.putBlock(block(1));
  const oversized = block(2); oversized.transactions[0].input = `0x${'ab'.repeat(400000)}`;
  assert.throws(() => store.putBlock(oversized), { code: 'STORAGE_LIMIT' });
  assert.equal(store.coverage().canonical_head, 1); assert.equal(store.block(2), null);
  assert.equal(store.coverage().storage_blocked, true);
  assert.ok(store.coverage().storage_bytes <= store.coverage().max_bytes);
});

test('disk report accounts for database plus WAL and shared memory files', t => {
  const { store, path } = fixture(t); store.putBlock(block(1));
  const bytes = ['', '-wal', '-shm', '-journal'].reduce((n, suffix) => n + (existsSync(path + suffix) ? statSync(path + suffix).size : 0), 0);
  assert.equal(store.coverage().storage_bytes, bytes);
  assert.equal(store.stats().journal_mode, 'wal');
});

test('incremental progress equals full audit after gaps, receipts, replacement and re-adoption', t => {
  const { store } = fixture(t);
  const match = () => {
    const actual = store.progress(), audit = store.coverage();
    for (const key of ['canonical_head', 'contiguous_block_head', 'contiguous_receipt_head', 'block_count', 'transaction_count', 'receipt_count', 'pending_receipt_blocks', 'complete_through_head', 'receipt_complete_through_head']) assert.deepEqual(actual[key], audit[key], key);
  };
  match(); store.putBlock(block(3)); match(); store.putReceipts(h(3), receipts(block(3))); match();
  store.putBlock(block(1)); match(); store.putReceipts(h(1), receipts(block(1))); match();
  store.putBlock(block(2)); match(); store.putReceipts(h(2), receipts(block(2))); match();
  store.putBlock(block(2, { id: 52, parent: 1 })); match();
  store.putReceipts(h(52), receipts(block(2, { id: 52, parent: 1 }))); match();
  store.rewind(2); match(); store.putBlock(block(2)); match(); store.putBlock(block(3)); match();
});

test('long-history capture progress avoids full-history audit scans; pending queue uses partial index', t => {
  const { store } = fixture(t);
  for (let n = 1; n <= 300; n++) { const b = block(n, { count: 0 }); store.putBlock(b); store.putReceipts(b.hash, []); }
  const original = store.db.prepare.bind(store.db); const seen = [];
  store.db.prepare = sql => {
    seen.push(sql);
    assert.ok(!sql.includes('SELECT number,hash,parent_hash,tx_count,receipts_complete FROM wt_blocks WHERE canonical=1 ORDER BY number'), 'hot path attempted historical audit');
    return original(sql);
  };
  const b = block(301); store.putBlock(b); store.putReceipts(b.hash, receipts(b));
  for (let i = 0; i < 100; i++) assert.equal(store.progress().contiguous_receipt_head, 301);
  assert.deepEqual(store.pendingReceipts(20), []);
  store.db.prepare = original;
  assert.ok(seen.some(sql => sql.includes('FROM wt_progress WHERE id=1')));
  const plan = original('EXPLAIN QUERY PLAN SELECT raw FROM wt_blocks WHERE canonical=1 AND receipts_complete=0 ORDER BY number DESC LIMIT 20').all();
  assert.ok(plan.some(row => row.detail.includes('wt_pending_receipt_height')));
  assert.equal(store.coverage().receipt_complete_through_head, true);
});
