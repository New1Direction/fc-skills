import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openStore } from './store.mjs';
import { capture, probe, normalizeConfig } from './capture.mjs';

const hash = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const address = n => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hex = n => `0x${n.toString(16)}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = overrides => ({ chain_id: 4663, sources: [{ name: 'primary' }], primary_source: 'primary', from_block: 1, poll_ms: 2, request_timeout_ms: 80, block_concurrency: 3, receipt_concurrency: 2, max_blocks_per_round: 8, reorg_depth: 8, max_pending_receipt_blocks: 16, max_requests_per_second: 100000, duration_seconds: 0.15, ...overrides });

function block(number, { variant = 0, parent = hash(number - 1), types = ['0x2', '0x7e', '0x99'] } = {}) {
  const h = hash(number + variant * 1000);
  return { number: hex(number), hash: h, parentHash: parent, timestamp: hex(1700000000 + number), transactions: types.map((type, i) => ({ hash: hash(number * 100 + i + variant * 100000), blockHash: h, blockNumber: hex(number), transactionIndex: hex(i), from: address(1), to: i === 1 ? null : address(i + 2), nonce: hex(number * 3 + i), value: i === 0 ? '0x64' : '0x0', gas: '0x186a0', type, input: i === 0 ? '0x' : '0x12345678' })) };
}
function receipts(b) {
  return b.transactions.map((tx, i) => ({ transactionHash: tx.hash, blockHash: b.hash, blockNumber: b.number, transactionIndex: tx.transactionIndex, from: tx.from, to: tx.to, status: i === 2 ? '0x0' : '0x1', gasUsed: '0x5208', cumulativeGasUsed: hex((i + 1) * 21000), logs: [] }));
}
function provider(blocks, options = {}) {
  const requests = [];
  const rpc = async (source, method, params, context) => {
    requests.push({ source, method, params });
    if (options.intercept) { const result = await options.intercept(source, method, params, context); if (result?.handled) return result.value; }
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_syncing') return false;
    const list = typeof blocks === 'function' ? blocks(source) : blocks;
    if (method === 'eth_getBlockByNumber') {
      const b = params[0] === 'latest' ? list.at(-1) : list.find(b => b.number === params[0]);
      return b ? structuredClone(params[1] ? b : { ...b, transactions: b.transactions.map(tx => tx.hash) }) : null;
    }
    if (method === 'eth_getBlockReceipts') {
      if (options.unsupported) throw Object.assign(new Error('Method absent'), { code: -32601 });
      const b = list.find(b => b.number === params[0]); return b ? receipts(b) : null;
    }
    if (method === 'eth_getTransactionReceipt') {
      for (const b of list) { const r = receipts(b).find(row => row.transactionHash === params[0]); if (r) return r; }
      return null;
    }
    throw new Error(`Unexpected method ${method}`);
  };
  return { rpc, requests };
}
function memory(start = 1, depth = 8) { return openStore(':memory:', { chainId: 4663, startBlock: start, reorgDepth: depth }); }
async function untilComplete(store, rpc, head, overrides = {}) {
  const stop = new AbortController();
  const timer = setInterval(() => { if (store.coverage().contiguous_receipt_head === head) stop.abort(); }, 1);
  try { return await capture(config(overrides), { store, rpc, signal: stop.signal }); }
  finally { clearInterval(timer); }
}

test('captures every included type and failed receipt with separate durable arrival stages', async () => {
  const store = memory();
  try {
    const list = [block(1), block(2), block(3)]; const p = provider(list);
    const result = await untilComplete(store, p.rpc, 3);
    assert.equal(result.coverage.contiguous_block_head, 3);
    assert.equal(result.coverage.contiguous_receipt_head, 3);
    assert.equal(result.transactions_committed, 9);
    assert.equal(store.block(1).transactions[2].type, '0x99');
    assert.equal(store.receipts(list[0].hash)[2].status, '0x0');
    assert.deepEqual(store.readEvents(0, 30).filter(e => e.kind === 'block').map(e => e.payload.number), ['0x1', '0x2', '0x3']);
    const rows = store.observations();
    for (const stage of ['head', 'block', 'block_durable', 'receipts', 'receipts_durable', 'source_health']) assert.ok(rows.some(row => row.stage === stage), stage);
    assert.ok(p.requests.every(row => !/send|sign|debug|trace/i.test(row.method)));
  } finally { store.close(); }
});

test('commits an early block before a slower later concurrent fetch and before slow receipts', async () => {
  const store = memory(); let firstCommittedBeforeLater = false; let slowReturned = false;
  const p = provider([block(1), block(2), block(3)], { intercept: async (_, method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === '0x3' && params[1]) { await pause(35); firstCommittedBeforeLater = Boolean(store.block(1)); slowReturned = true; }
    if (method === 'eth_getBlockReceipts') await pause(45);
  } });
  try {
    const result = await untilComplete(store, p.rpc, 3, { duration_seconds: 0.35 });
    assert.ok(slowReturned); assert.ok(firstCommittedBeforeLater); assert.equal(result.coverage.contiguous_receipt_head, 3);
  } finally { store.close(); }
});

test('retries a missing block and does not jump the durable cursor over its gap', async () => {
  const store = memory(); let missed = false; let gapWasHonest = false;
  const p = provider([block(1), block(2), block(3)], { intercept: async (_, method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === '0x2' && params[1] && !missed) { missed = true; return { handled: true, value: null }; }
    if (missed && method === 'eth_getBlockByNumber' && params[0] === 'latest') gapWasHonest ||= store.coverage().contiguous_block_head === 1;
  } });
  try {
    const result = await untilComplete(store, p.rpc, 3); assert.ok(gapWasHonest); assert.equal(result.coverage.contiguous_block_head, 3);
    assert.ok(result.errors.some(e => e.error_code === 'invalid_block'));
  } finally { store.close(); }
});

test('unsupported full block receipts falls back to bounded per-transaction calls', async () => {
  const store = memory(); let active = 0; let peak = 0;
  const p = provider([block(1), block(2)], { unsupported: true, intercept: async (_, method) => {
    if (method === 'eth_getTransactionReceipt') { active++; peak = Math.max(peak, active); await pause(3); active--; }
  } });
  try {
    const result = await untilComplete(store, p.rpc, 2);
    assert.equal(result.block_receipts_support, 'unsupported_fallback'); assert.equal(result.coverage.receipt_count, 6);
    assert.ok(peak <= 2); assert.ok(p.requests.filter(r => r.method === 'eth_getBlockReceipts').length <= 2);
  } finally { store.close(); }
});

test('receipt errors persist and backlog saturation pauses full block capture', async () => {
  const store = memory();
  const p = provider([block(1), block(2), block(3)], { intercept: async (_, method) => { if (method === 'eth_getBlockReceipts') throw new Error('https://secret.example/key=123'); } });
  try {
    const result = await capture(config({ max_pending_receipt_blocks: 1, duration_seconds: 0.055 }), { store, rpc: p.rpc });
    assert.equal(result.coverage.contiguous_block_head, 1); assert.equal(result.coverage.pending_receipt_blocks, 1);
    assert.equal(result.coverage.contiguous_receipt_head, null); assert.ok(result.backlog_pauses > 0); assert.equal(result.degraded, true);
    assert.ok(store.observations().some(r => r.stage === 'receipt_error'));
    assert.ok(!JSON.stringify(result).includes('secret.example'));
  } finally { store.close(); }
});

test('malformed receipts cannot establish receipt coverage', async () => {
  const store = memory();
  const p = provider([block(1)], { intercept: async (_, method) => method === 'eth_getBlockReceipts' ? { handled: true, value: receipts(block(1)).slice(0, 2) } : undefined });
  try {
    const result = await capture(config({ duration_seconds: 0.035 }), { store, rpc: p.rpc });
    assert.equal(result.coverage.contiguous_block_head, 1); assert.equal(result.coverage.contiguous_receipt_head, null);
    assert.equal(result.block_receipts_support, 'unverified');
  } finally { store.close(); }
});

test('restart resumes durable missing receipts without recollecting completed blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-capture-')); const path = join(dir, 'state.sqlite');
  let store = openStore(path, { chainId: 4663, startBlock: 1, reorgDepth: 8 });
  try {
    const list = [block(1), block(2)]; store.putBlock(list[0]); store.putBlock(list[1]); store.putReceipts(list[0].hash, receipts(list[0]));
    store.close(); store = openStore(path);
    const p = provider(list); const result = await untilComplete(store, p.rpc, 2);
    assert.equal(result.blocks_committed, 0); assert.equal(result.receipt_blocks_committed, 1); assert.equal(result.coverage.contiguous_receipt_head, 2);
    assert.equal(p.requests.filter(r => r.method === 'eth_getBlockByNumber' && r.params[1]).length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('primary bounded fork invalidates orphan descendants and reconciles replacements', async () => {
  const store = memory(); const old = [block(1), block(2), block(3), block(4)];
  try {
    for (const b of old) { store.putBlock(b); store.putReceipts(b.hash, receipts(b)); }
    const third = block(3, { variant: 1 }); const fourth = block(4, { variant: 1, parent: third.hash });
    const result = await capture(config({ duration_seconds: 0.07 }), { store, rpc: provider([old[0], old[1], third, fourth]).rpc });
    assert.equal(result.reorgs, 1); assert.equal(store.block(3).hash, third.hash); assert.equal(store.isCanonical(old[3].hash), false);
    assert.ok(store.readEvents(0, 50).some(e => e.kind === 'invalidate'));
  } finally { store.close(); }
});

test('a fork deeper than the configured bound stops instead of promoting it', async () => {
  const store = memory(1, 2); const old = Array.from({ length: 5 }, (_, i) => block(i + 1));
  try {
    for (const b of old) store.putBlock(b);
    const replacement = old.map((b, i) => block(i + 1, { variant: 1, parent: i ? hash(i + 1000) : hash(0) }));
    const result = await capture(config({ reorg_depth: 2 }), { store, rpc: provider(replacement).rpc });
    assert.equal(result.reason, 'reorg_depth_exceeded'); assert.equal(store.block(5).hash, old[4].hash); assert.equal(result.reorgs, 0);
  } finally { store.close(); }
});

test('secondary conflicting blocks are observation-only and never canonical', async () => {
  const store = memory(); const canonical = block(1); const conflicting = block(1, { variant: 9 });
  try {
    const p = provider(source => source === 'secondary' ? [conflicting] : [canonical]);
    const result = await capture(config({ sources: [{ name: 'primary' }, { name: 'secondary' }], duration_seconds: 0.055 }), { store, rpc: p.rpc });
    assert.equal(store.block(1).hash, canonical.hash); assert.equal(store.isCanonical(conflicting.hash), false);
    assert.equal(result.source_states.secondary, 'observation_only');
    assert.ok(store.observations().some(r => r.source === 'secondary' && r.event_id === conflicting.hash));
  } finally { store.close(); }
});

test('wrong primary chain stops before any block is accepted', async () => {
  const store = memory(); const p = provider([block(1)], { intercept: async (_, method) => method === 'eth_chainId' ? { handled: true, value: '0x1' } : undefined });
  try { const r = await capture(config(), { store, rpc: p.rpc }); assert.equal(r.reason, 'wrong_chain'); assert.equal(r.coverage.block_count, 0); }
  finally { store.close(); }
});

test('a wrong-chain secondary cannot contribute stage observations', async () => {
  const store = memory(); const p = provider([block(1)], { intercept: async (source, method) => source === 'secondary' && method === 'eth_chainId' ? { handled: true, value: '0x1' } : undefined });
  try {
    const r = await capture(config({ sources: [{ name: 'primary' }, { name: 'secondary' }], duration_seconds: 0.035 }), { store, rpc: p.rpc });
    assert.equal(r.source_states.secondary, 'wrong_chain'); assert.equal(r.degraded, true); assert.ok(!store.observations().some(o => o.source === 'secondary'));
  } finally { store.close(); }
});

test('a timed-out adapter that ignores AbortSignal cannot hang capture', async () => {
  const store = memory(); const p = provider([block(1)], { intercept: async (_, method) => { if (method === 'eth_getBlockByNumber') return new Promise(() => {}); } });
  try {
    const started = Date.now(); const r = await capture(config({ request_timeout_ms: 5, duration_seconds: 0.035 }), { store, rpc: p.rpc });
    assert.ok(Date.now() - started < 300); assert.ok(r.errors.some(e => e.error_code === 'request_timeout')); assert.equal(r.coverage.block_count, 0);
  } finally { store.close(); }
});

test('explicit start is preserved and older chain history is not claimed', async () => {
  const store = memory(3); try {
    const r = await untilComplete(store, provider([block(1), block(2), block(3), block(4)]).rpc, 4, { from_block: 3 });
    assert.equal(r.coverage.start_block, 3); assert.equal(r.coverage.block_count, 2); assert.equal(store.block(2), null);
    await assert.rejects(capture(config(), { store, rpc: provider([block(1)]).rpc }), /store_config_mismatch/);
  } finally { store.close(); }
});

test('duration zero runs until caller cancellation', async () => {
  const store = memory(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25);
  try { const r = await capture(config({ duration_seconds: 0 }), { store, rpc: provider([block(1)]).rpc, signal: controller.signal }); assert.equal(r.reason, 'aborted'); assert.equal(r.coverage.contiguous_receipt_head, 1); }
  finally { clearTimeout(timer); store.close(); }
});

test('source health preserves responsive empty-chain head without inventing finality', async () => {
  const store = memory(); try {
    const r = await untilComplete(store, provider([block(1, { types: [] })]).rpc, 1);
    assert.equal(r.coverage.transaction_count, 0); const health = store.observations().find(r => r.stage === 'source_health');
    assert.equal(health.payload.responsive, true); assert.equal(health.payload.head_number, 1); assert.equal(health.payload.primary, true);
  } finally { store.close(); }
});

test('probe distinguishes RPC capabilities from captured coverage and never retains endpoint text', async () => {
  const p = provider([block(1)]); const r = await probe(config(), { rpc: p.rpc });
  assert.equal(r.sources[0].full_blocks, 'observed_supported'); assert.equal(r.sources[0].block_receipts, 'observed_response_shape');
  assert.equal(r.sources[0].syncing, false); assert.equal(r.sources[0].live_coverage_established, false); assert.equal(r.endpoints_retained, false);
  const bad = await probe(config(), { rpc: async () => { throw new Error('https://foo/token=secret'); } });
  assert.equal(bad.sources[0].state, 'unavailable'); assert.ok(!JSON.stringify(bad).includes('secret'));
});

test('configuration rejects direct URLs, missing explicit start and invalid limits', () => {
  assert.throws(() => normalizeConfig(config({ sources: [{ name: 'primary', url: 'https://example.com' }] })), /invalid_source_field/);
  assert.throws(() => normalizeConfig(config({ from_block: undefined })), /invalid_from_block/);
  for (const key of ['block_concurrency', 'receipt_concurrency', 'max_pending_receipt_blocks', 'request_timeout_ms']) assert.throws(() => normalizeConfig(config({ [key]: 0 })));
  assert.throws(() => normalizeConfig(config({ chain_id: 1 })), /invalid_chain_config/);
});

test('real HTTP endpoint captures full blocks and validates JSON-RPC responses', async () => {
  const p = provider([block(1)]); const observed = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body); observed.push(input.method);
    const result = await p.rpc('primary', input.method, input.params); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const old = process.env.WATCHTOWER_CAPTURE_TEST_HTTP; process.env.WATCHTOWER_CAPTURE_TEST_HTTP = `http://127.0.0.1:${server.address().port}/secret-not-retained`;
  const store = memory();
  try {
    const r = await untilComplete(store, undefined, 1, { sources: [{ name: 'primary', http_env: 'WATCHTOWER_CAPTURE_TEST_HTTP' }], duration_seconds: 0.4 });
    assert.equal(r.coverage.contiguous_receipt_head, 1); assert.ok(observed.includes('eth_getBlockReceipts')); assert.ok(!JSON.stringify(store.observations()).includes('secret-not-retained'));
  } finally { store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.WATCHTOWER_CAPTURE_TEST_HTTP; else process.env.WATCHTOWER_CAPTURE_TEST_HTTP = old; }
});

test('real HTTP transport rejects oversized bodies without persisting response content', async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(4096) })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); process.env.WATCHTOWER_CAPTURE_TEST_BIG = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await probe(config({ sources: [{ name: 'primary', http_env: 'WATCHTOWER_CAPTURE_TEST_BIG' }], max_response_bytes: 512 }));
    assert.equal(r.sources[0].error_code, 'response_too_large');
  } finally { delete process.env.WATCHTOWER_CAPTURE_TEST_BIG; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('WebSocket newHeads wakes HTTP reconciliation while out-of-order heads never rewrite history', async () => {
  const store = memory(); let list = [block(1)];
  class FakeSocket extends EventTarget {
    constructor() { super(); this.timers = [setTimeout(() => this.dispatchEvent(new Event('open')), 0)]; }
    send(raw) {
      assert.equal(JSON.parse(raw).method, 'eth_subscribe');
      this.timers.push(setTimeout(() => {
        list = [block(1), block(2)]; this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'eth_subscription', params: { result: block(2) } }) }));
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'eth_subscription', params: { result: block(1) } }) }));
      }, 35));
    }
    close() { for (const timer of this.timers) clearTimeout(timer); this.dispatchEvent(new Event('close')); }
  }
  process.env.WATCHTOWER_CAPTURE_TEST_WS = 'ws://127.0.0.1:9999/not-contacted';
  try {
    const r = await capture(config({ sources: [{ name: 'primary', ws_env: 'WATCHTOWER_CAPTURE_TEST_WS' }], poll_ms: 1000, duration_seconds: 0.12, request_timeout_ms: 250 }), { store, rpc: provider(() => list).rpc, WebSocketImpl: FakeSocket });
    assert.equal(r.websocket_heads, 2); assert.equal(r.coverage.contiguous_block_head, 2); assert.equal(store.block(1).hash, hash(1));
  } finally { delete process.env.WATCHTOWER_CAPTURE_TEST_WS; store.close(); }
});

test('latest transactions become durable while a historical gap is still being backfilled', async () => {
  const store = memory(); let sawTailBeforeHistory = false;
  const list = Array.from({ length: 8 }, (_, i) => block(i + 1));
  const p = provider(list, { intercept: async (_, method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === '0x1' && params[1]) {
      await pause(30); sawTailBeforeHistory = Boolean(store.block(8)) && store.coverage().contiguous_block_head === null;
    }
  } });
  try {
    const result = await untilComplete(store, p.rpc, 8, { max_blocks_per_round: 2, duration_seconds: 0.3 });
    assert.equal(sawTailBeforeHistory, true); assert.equal(result.coverage.contiguous_receipt_head, 8);
    assert.ok(store.observations().some(o => o.stage === 'block_durable' && o.event_id === hash(8) && o.meta.delivery === 'live'));
  } finally { store.close(); }
});

test('a disconnected live tail is invalidated promptly on a primary fork during backfill', async () => {
  const store = memory(); const oldTail = block(8); const newTail = block(8, { variant: 1 });
  store.putBlock(oldTail);
  const list = Array.from({ length: 7 }, (_, i) => block(i + 1)).concat(newTail);
  const p = provider(list, { intercept: async (_, method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === '0x1' && params[1]) await pause(15);
  } });
  try {
    const result = await untilComplete(store, p.rpc, 8, { max_blocks_per_round: 2, reorg_depth: 8 });
    assert.equal(result.reorgs, 1); assert.equal(store.isCanonical(oldTail.hash), false); assert.equal(store.block(8).hash, newTail.hash);
    assert.equal(result.coverage.contiguous_block_head, 8);
  } finally { store.close(); }
});

test('full block receipt fetching is parallel but remains within receipt concurrency', async () => {
  const store = memory(); let active = 0; let peak = 0;
  const p = provider([block(1), block(2), block(3), block(4)], { intercept: async (_, method) => {
    if (method === 'eth_getBlockReceipts') { active++; peak = Math.max(peak, active); await pause(15); active--; }
  } });
  try { const result = await untilComplete(store, p.rpc, 4); assert.equal(result.coverage.contiguous_receipt_head, 4); assert.equal(peak, 2); }
  finally { store.close(); }
});

test('restarted receipt work preserves durable block delivery metadata', async () => {
  const store = memory(); const b = block(1); store.putBlock(b, { delivery: 'live' });
  try {
    await untilComplete(store, provider([b]).rpc, 1);
    const rows = store.observations().filter(o => ['receipts', 'receipts_durable'].includes(o.stage));
    assert.equal(rows.length, 2); assert.ok(rows.every(o => o.meta.delivery === 'live'));
  } finally { store.close(); }
});

test('missing and invalid endpoint environment fail preflight without counting transport requests', async () => {
  const env = 'WATCHTOWER_CAPTURE_TEST_MISSING'; const prior = process.env[env]; delete process.env[env];
  const c = config({ sources: [{ name: 'primary', http_env: env }] }); const store = memory();
  try {
    const missing = await probe(c);
    assert.equal(missing.requests, 0); assert.equal(missing.sources[0].error_code, 'missing_endpoint_environment');
    const captured = await capture(c, { store });
    assert.equal(captured.requests, 0); assert.equal(captured.reason, 'missing_endpoint_environment'); assert.equal(captured.degraded, true);
    assert.equal(store.observations().length, 0);
    process.env[env] = 'not a valid endpoint';
    const invalid = await probe(c);
    assert.equal(invalid.requests, 0); assert.equal(invalid.sources[0].error_code, 'invalid_endpoint_environment');
  } finally { store.close(); if (prior === undefined) delete process.env[env]; else process.env[env] = prior; }
});
