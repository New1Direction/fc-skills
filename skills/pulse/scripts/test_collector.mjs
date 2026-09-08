import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { collect } from './collector.mjs';

const A = `0x${'1'.repeat(40)}`;
const H = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const Q = n => `0x${n.toString(16)}`;
const block = (n, hash = H(n), parent = H(n - 1)) => ({ number: Q(n), hash, parentHash: parent, timestamp: Q(1700000000 + n) });
const log = (n, hash = H(n), index = 0) => ({ address: A, blockNumber: Q(n), blockHash: hash,
  transactionHash: H(1000 + n), transactionIndex: '0x0', logIndex: Q(index), topics: [H(99)], data: '0x', removed: false });

function settings(extra = {}) {
  process.env.PULSE_TEST_HTTP = 'https://mock.invalid/rpc?key=secret-key-123';
  process.env.PULSE_TEST_WS = 'wss://mock.invalid/ws?key=secret-key-123';
  process.env.PULSE_TEST_FEED = 'wss://mock.invalid/feed?key=secret-key-123';
  return { chain_id: 4663, run_id: 'test-run', clock_id: 'test-clock', sources: [{ name: 'one', http_env: 'PULSE_TEST_HTTP', ws_env: 'PULSE_TEST_WS' }],
    addresses: [A], from_block: 1, duration_seconds: 0.08, request_timeout_ms: 100,
    reconnect_ms: 2, max_reconnects: 1, max_backfill_blocks: 20, reorg_depth: 8,
    queue_limit: 16, max_message_bytes: 4096, ...extra };
}
function socketFactory({ onReady, onSend, onConstruct } = {}) {
  const instances = [];
  class MockSocket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.closed = false; this.index = instances.length; instances.push(this);
      onConstruct?.(this);
      queueMicrotask(() => { if (!this.closed) { this.dispatchEvent(new Event('open')); if (url.includes('/feed')) onReady?.(this); } });
    }
    send(text) {
      const request = JSON.parse(text);
      if (onSend?.(this, request) === false) return;
      this.message({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'eth_chainId' ? Q(4663) : request.params[0] === 'newHeads' ? 'heads' : 'logs' });
      if (request.id === 3) setTimeout(() => { if (!this.closed) onReady?.(this); }, 1);
    }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
    head(value) { this.message({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: 'heads', result: value } }); }
    log(value) { this.message({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: 'logs', result: value } }); }
    close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  return { MockSocket, instances };
}
function rpcFactory({ tip = () => 1, getBlock = n => block(n), getLogs = n => [log(n)], intercept } = {}) {
  const calls = [];
  const rpc = async (source, method, params, options) => {
    calls.push({ source: source.name, method, params });
    const override = await intercept?.(source, method, params, options);
    if (override !== undefined) return override;
    if (method === 'eth_chainId') return Q(4663);
    if (method === 'eth_blockNumber') return Q(tip());
    if (method === 'eth_getBlockByNumber') return getBlock(Number(BigInt(params[0])));
    if (method === 'eth_getLogs') {
      assert.equal(params[0].fromBlock, params[0].toBlock, 'backfill must use a single block');
      return getLogs(Number(BigInt(params[0].fromBlock)));
    }
    throw new Error('unknown method must never appear');
  };
  return { rpc, calls };
}
async function run(config, sockets, rpc, extra = {}) {
  const rows = [];
  const result = await collect(config, { emit: async row => { rows.push(row); await extra.afterEmit?.(row); },
    WebSocketImpl: sockets.MockSocket, rpc, ...extra });
  return { rows, result };
}

test('native-equivalent sockets capture live arrivals and HTTP completion separately', async () => {
  const sockets = socketFactory({ onReady: socket => { socket.head(block(1)); socket.log(log(1)); } });
  const { rpc } = rpcFactory();
  const { rows, result } = await run(settings(), sockets, rpc);
  assert.equal(result.sources[0].status, 'stopped');
  assert.equal(result.sources[0].recovered_blocks, 1);
  assert.equal(result.sources[0].live_heads, 1);
  assert.equal(result.sources[0].live_logs, 1);
  assert.ok(rows.every(row => row.chain_id === 4663 && row.run_id === 'test-run' && row.clock_id === 'test-clock'));
  const arrivals = rows.filter(row => row.stage === 'log');
  assert.deepEqual(new Set(arrivals.map(row => row.delivery)), new Set(['live', 'backfill']));
  assert.equal(new Set(arrivals.map(row => row.event_id)).size, 1);
  const complete = rows.findIndex(row => row.payload.kind === 'block_complete');
  const checkpoint = rows.findIndex(row => row.payload.kind === 'checkpoint');
  assert.ok(complete >= 0 && checkpoint > complete);
  assert.equal(rows[complete].payload.block.coverage, 'provider_reported_complete');
  assert.equal(rows[complete].payload.block.logs.length, 1);
  assert.equal(rows[checkpoint].payload.next_block, 2);
  assert.ok(sockets.instances.every(socket => socket.closed));
});

test('pre-ACK arrivals remain buffered until verification and retain original times', async () => {
  const sockets = socketFactory({ onSend: (socket, request) => {
    if (request.id === 2) { socket.head(block(10)); socket.log(log(10)); }
  }, onReady: socket => socket.head(block(11)) });
  const { rpc } = rpcFactory({ tip: () => 11 });
  const { rows } = await run(settings({ from_block: undefined }), sockets, rpc);
  assert.equal(rows.filter(row => row.stage === 'head' && row.delivery === 'live').length, 2);
  assert.equal(rows.find(row => row.payload.kind === 'pre_ready_notifications_buffered').payload.count, 2);
  const ready = rows.findIndex(row => row.payload.kind === 'subscriptions_ready');
  assert.ok(rows.findIndex(row => row.stage === 'head' && row.delivery === 'live') > ready);
  assert.ok(BigInt(rows.find(row => row.stage === 'head' && row.delivery === 'live' && row.block_number === 10).observed_mono_ns) < BigInt(rows[ready].observed_mono_ns));
  assert.deepEqual(rows.filter(row => row.payload.kind === 'block_complete').map(row => row.payload.block.number), [10, 11]);
});

test('HTTP tip regression degrades source, preserves checkpoint and fails after bounded retries', async () => {
  let tip = 3; let changed = false;
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ tip: () => tip });
  const { rows, result } = await run(settings(), sockets, rpc, { afterEmit: async row => {
    if (!changed && row.payload.kind === 'checkpoint' && row.payload.next_block === 4) {
      changed = true; tip = 2; sockets.instances[0].head(block(4));
    }
  } });
  assert.equal(result.sources[0].reason, 'HTTP_TIP_LAG_EXCEEDED');
  assert.equal(result.sources[0].resume.next_block, 4);
  assert.ok(rows.some(row => row.payload.kind === 'rpc_lag_detected' && row.payload.http_tip === 2 && row.payload.last_completed_block === 3));
  assert.ok(!rows.some(row => row.payload.kind === 'rpc_lag_resolved'));
});

test('pre-ACK buffer enforces byte capacity independently of record count', async () => {
  const sockets = socketFactory({ onSend: (socket, request) => {
    if (request.id === 3) for (let n = 1; n <= 10; n++) socket.head({ ...block(n), extra: 'x'.repeat(1500) });
  } });
  const { rpc } = rpcFactory();
  const { result, rows } = await run(settings({ queue_limit: 100, max_message_bytes: 2048, max_reconnects: 0 }), sockets, rpc);
  assert.equal(result.sources[0].reason, 'WS_QUEUE_LIMIT');
  assert.ok(!rows.some(row => row.stage === 'head' && row.delivery === 'live'));
});

test('ordinary RPC propagation lag resolves only after recovery through the live head', async () => {
  let tip = 3; let changed = false;
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ tip: () => tip });
  const { rows, result } = await run(settings({ max_reconnects: 5, reconnect_ms: 5 }), sockets, rpc, { afterEmit: async row => {
    if (!changed && row.payload.kind === 'checkpoint' && row.payload.next_block === 4) {
      changed = true; tip = 2; sockets.instances[0].head(block(4));
      setTimeout(() => { tip = 4; }, 8);
    }
  } });
  assert.equal(result.sources[0].reason, null);
  const resolved = rows.findIndex(row => row.payload.kind === 'rpc_lag_resolved');
  const completed = rows.findIndex(row => row.payload.kind === 'checkpoint' && row.payload.next_block === 5);
  assert.ok(completed >= 0 && resolved > completed);
  assert.equal(rows[resolved].payload.recovered_through, 4);
});

test('wrong HTTP chain fails before WebSocket construction', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ intercept: (_s, method) => method === 'eth_chainId' ? '0x1' : undefined });
  const { rows, result } = await run(settings(), sockets, rpc);
  assert.equal(result.sources[0].reason, 'HTTP_CHAIN_MISMATCH');
  assert.equal(sockets.instances.length, 0);
  assert.equal(rows.filter(row => row.stage === 'head').length, 0);
});

test('wrong WS chain fails closed and never produces canonical live events', async () => {
  const sockets = socketFactory({ onSend: (socket, request) => {
    if (request.id === 1) { socket.message({ jsonrpc: '2.0', id: 1, result: '0x1' }); return false; }
  } });
  const { rpc } = rpcFactory();
  const { rows, result } = await run(settings({ max_reconnects: 0 }), sockets, rpc);
  assert.equal(result.sources[0].reason, 'WS_CHAIN_MISMATCH');
  assert.equal(rows.filter(row => ['head', 'log'].includes(row.stage)).length, 0);
});

test('subscription rejection and transport secrets are never journaled', async () => {
  const sockets = socketFactory({ onSend: (socket, request) => {
    if (request.id === 2) { socket.message({ jsonrpc: '2.0', id: 2, error: { message: 'secret-key-123 https://mock.invalid/rpc?key=secret-key-123' } }); return false; }
  } });
  const { rpc } = rpcFactory();
  const { rows, result } = await run(settings({ max_reconnects: 0 }), sockets, rpc);
  assert.equal(result.sources[0].reason, 'WS_SUBSCRIPTION_REJECTED');
  assert.ok(!JSON.stringify(rows).includes('secret-key-123'));
  assert.ok(!JSON.stringify(rows).includes('mock.invalid'));
});

test('reconnect backfills the gap without labelling historical observations live', async () => {
  let tip = 1;
  const sockets = socketFactory({ onReady: socket => {
    if (socket.index === 0) setTimeout(() => { tip = 3; socket.close(); }, 8);
    else { socket.head(block(3)); socket.log(log(3)); }
  } });
  const { rpc } = rpcFactory({ tip: () => tip });
  const { rows, result } = await run(settings({ duration_seconds: 0.12 }), sockets, rpc);
  assert.equal(result.sources[0].reconnects, 1);
  assert.equal(result.sources[0].resume.next_block, 4);
  assert.ok(rows.some(row => row.payload.kind === 'gap_detected' && row.payload.from_block === 2 && row.payload.to_block === 3));
  assert.ok(rows.filter(row => row.block_number === 2).every(row => row.delivery === 'backfill'));
  assert.equal(rows.filter(row => row.stage === 'log' && row.delivery === 'live' && row.block_number === 3).length, 1);
});

test('late callbacks from a closed generation do not create arrivals', async () => {
  const sockets = socketFactory({ onReady: socket => {
    if (socket.index === 0) { setTimeout(() => socket.close(), 3); setTimeout(() => socket.head(block(999)), 10); }
    else socket.head(block(1));
  } });
  const { rpc } = rpcFactory();
  const { rows } = await run(settings(), sockets, rpc);
  assert.ok(!rows.some(row => row.block_number === 999));
});

test('gap beyond configured bound fails closed without jumping checkpoint', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ tip: () => 10 });
  const { rows, result } = await run(settings({ max_backfill_blocks: 2 }), sockets, rpc);
  assert.equal(result.sources[0].reason, 'GAP_EXCEEDS_BACKFILL_LIMIT');
  assert.ok(!rows.some(row => row.payload.kind === 'checkpoint'));
});

test('resume verifies retained history and begins at the persisted next block', async () => {
  const sockets = socketFactory();
  const { rpc, calls } = rpcFactory({ tip: () => 3 });
  const { rows, result } = await run(settings({ resume: { one: { next_block: 3,
    recent_blocks: [{ number: 1, hash: H(1), parent_hash: H(0) }, { number: 2, hash: H(2), parent_hash: H(1) }] } } }), sockets, rpc);
  assert.equal(result.sources[0].recovered_blocks, 1);
  assert.deepEqual(rows.filter(row => row.payload.kind === 'block_complete').map(row => row.payload.block.number), [3]);
  assert.ok(calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0x2'));
});

test('shallow reorg rewinds to common ancestor and durably replaces blocks', async () => {
  let fork = false;
  const canonical = n => !fork || n === 1 ? block(n) : block(n, H(100 + n), n === 2 ? H(1) : H(100 + n - 1));
  const sockets = socketFactory({ onReady: socket => setTimeout(() => { fork = true; socket.head(canonical(3)); }, 12) });
  const { rpc } = rpcFactory({ tip: () => 3, getBlock: canonical, getLogs: n => [log(n, canonical(n).hash)] });
  const { rows, result } = await run(settings({ duration_seconds: 0.11 }), sockets, rpc);
  assert.equal(result.sources[0].reason, null);
  const reorg = rows.find(row => row.payload.kind === 'reorg_detected');
  assert.equal(reorg.payload.ancestor.number, 1);
  assert.deepEqual(reorg.payload.orphaned.map(x => x.number), [2, 3]);
  assert.equal(result.sources[0].resume.recent_blocks.at(-1).hash, H(103));
});

test('reorg outside retained history fails closed', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ tip: () => 3, getBlock: n => block(n, H(100 + n), H(100 + n - 1)) });
  const { result, rows } = await run(settings({ resume: { one: { next_block: 3,
    recent_blocks: [{ number: 1, hash: H(1), parent_hash: H(0) }, { number: 2, hash: H(2), parent_hash: H(1) }] } } }), sockets, rpc);
  assert.equal(result.sources[0].reason, 'REORG_BEYOND_RETAINED_DEPTH');
  assert.ok(!rows.some(row => row.payload.kind === 'checkpoint'));
});

test('inconsistent block log hash cannot produce block completion or checkpoint', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ getLogs: n => [log(n, H(999))] });
  const { result, rows } = await run(settings(), sockets, rpc);
  assert.equal(result.sources[0].reason, 'BLOCK_LOG_BINDING_MISMATCH');
  assert.ok(!rows.some(row => ['block_complete', 'checkpoint'].includes(row.payload.kind)));
});

test('conflicting block-wide log slots fail closed', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory({ getLogs: n => [log(n), { ...log(n), transactionHash: H(9000), transactionIndex: '0x1' }] });
  const { result } = await run(settings(), sockets, rpc);
  assert.equal(result.sources[0].reason, 'CONFLICTING_BLOCK_LOG_SLOT');
});

test('checkpoint waits until block bundle persistence resolves', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory();
  let durable = false;
  const rows = [];
  await collect(settings(), { WebSocketImpl: sockets.MockSocket, rpc, emit: async row => {
    if (row.payload.kind === 'block_complete') { await new Promise(resolve => setTimeout(resolve, 8)); durable = true; }
    if (row.payload.kind === 'checkpoint') assert.equal(durable, true);
    rows.push(row);
  } });
  assert.ok(rows.some(row => row.payload.kind === 'checkpoint'));
});

test('journal failure prevents checkpoint and rejects collection', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory();
  const rows = [];
  await assert.rejects(collect(settings(), { WebSocketImpl: sockets.MockSocket, rpc, emit: async row => {
    rows.push(row);
    if (row.payload.kind === 'block_complete') throw new Error('secret-key-123');
  } }), /JOURNAL_EMIT_FAILED/);
  assert.ok(!rows.some(row => row.payload.kind === 'checkpoint'));
});

test('oversized message and bounded queue fail a source closed', async t => {
  await t.test('size', async () => {
    const sockets = socketFactory({ onReady: socket => socket.message('x'.repeat(5000)) });
    const { rpc } = rpcFactory();
    const { result } = await run(settings({ max_reconnects: 0 }), sockets, rpc);
    assert.equal(result.sources[0].reason, 'WS_MESSAGE_LIMIT');
  });
  await t.test('queue', async () => {
    const sockets = socketFactory({ onReady: socket => { for (let n = 1; n <= 20; n++) socket.head(block(n)); } });
    const { rpc } = rpcFactory();
    const { result } = await run(settings({ max_reconnects: 0, queue_limit: 4 }), sockets, rpc);
    assert.equal(result.sources[0].reason, 'WS_QUEUE_LIMIT');
  });
});

test('raw Nitro feed is provisional, not decoded, and credentials are redacted before base64', async () => {
  const sockets = socketFactory({ onReady: socket => { if (socket.url.includes('/feed')) socket.message('{"sequenceNumber":555,"echo":"secret-key-123"}'); } });
  const { rpc } = rpcFactory();
  const { rows } = await run(settings({ sources: [{ name: 'one', http_env: 'PULSE_TEST_HTTP', ws_env: 'PULSE_TEST_WS', feed_env: 'PULSE_TEST_FEED' }] }), sockets, rpc);
  const feed = rows.find(row => row.stage === 'feed');
  assert.equal(feed.payload.provisional, true);
  assert.equal(feed.payload.chain_binding, 'configured_unverified');
  assert.equal(feed.block_number, undefined);
  const raw = Buffer.from(feed.payload.raw_base64, 'base64').toString('utf8');
  assert.ok(raw.includes('555'));
  assert.ok(!raw.includes('secret-key-123'));
  assert.equal(feed.payload.credentials_redacted, true);
});

test('receipt monotonic clock is captured before delayed persistence', async () => {
  let ticks = 0n;
  const sockets = socketFactory({ onReady: socket => { socket.head(block(1)); socket.log(log(1)); } });
  const { rpc } = rpcFactory();
  const { rows } = await run(settings(), sockets, rpc, { clock: () => ({ mono_ns: ++ticks, wall_iso: '2026-09-08T14:00:00.000Z' }) });
  const live = rows.filter(row => row.delivery === 'live' && ['head', 'log'].includes(row.stage));
  assert.ok(BigInt(live[0].observed_mono_ns) < BigInt(live[1].observed_mono_ns));
  assert.equal(live[0].observed_at, '2026-09-08T14:00:00.000Z');
});

test('multiple sources share event identities while retaining source attribution', async () => {
  const sockets = socketFactory({ onReady: socket => socket.log(log(1)) });
  const { rpc } = rpcFactory();
  const config = settings();
  config.sources.push({ ...config.sources[0], name: 'two' });
  const { rows, result } = await run(config, sockets, rpc);
  assert.equal(result.sources.length, 2);
  const arrivals = rows.filter(row => row.stage === 'log' && row.delivery === 'live');
  assert.deepEqual(new Set(arrivals.map(row => row.source)), new Set(['one', 'two']));
  assert.equal(new Set(arrivals.map(row => row.event_id)).size, 1);
});

test('explicit abort closes all sockets promptly', async () => {
  const sockets = socketFactory();
  const { rpc } = rpcFactory();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 12);
  const before = Date.now();
  const { result } = await run(settings({ duration_seconds: 0 }), sockets, rpc, { signal: controller.signal });
  assert.ok(Date.now() - before < 500);
  assert.equal(result.sources[0].status, 'stopped');
  assert.ok(sockets.instances.every(socket => socket.closed));
});

test('path credentials are redacted even when only the key is echoed', async () => {
  const config = settings();
  process.env.PULSE_TEST_HTTP = 'https://mock.invalid/v2/path-secret-123';
  const sockets = socketFactory({ onReady: socket => socket.head({ ...block(1), provider_note: 'path-secret-123' }) });
  const { rpc } = rpcFactory();
  const { rows } = await run(config, sockets, rpc);
  assert.ok(!JSON.stringify(rows).includes('path-secret-123'));
  assert.ok(rows.some(row => row.payload.provider_note === '[REDACTED]'));
});

test('request timeout is bounded and sanitized', async () => {
  const sockets = socketFactory();
  const { result, rows } = await run(settings({ request_timeout_ms: 10 }), sockets, () => new Promise(() => {}));
  assert.equal(result.sources[0].reason, 'REQUEST_TIMEOUT');
  assert.ok(!JSON.stringify(rows).includes('mock.invalid'));
});

test('real fetch integration uses a local HTTP JSON-RPC server with single-block queries', async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push(body);
    let result;
    if (body.method === 'eth_chainId') result = Q(4663);
    else if (body.method === 'eth_blockNumber') result = '0x1';
    else if (body.method === 'eth_getBlockByNumber') result = block(1);
    else if (body.method === 'eth_getLogs') { assert.equal(body.params[0].fromBlock, body.params[0].toBlock); result = [log(1)]; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = settings({ duration_seconds: 0.15, request_timeout_ms: 300 });
  process.env.PULSE_TEST_HTTP = `http://127.0.0.1:${server.address().port}/rpc?key=secret-key-123`;
  const sockets = socketFactory();
  try {
    const { result, rows } = await run(config, sockets);
    assert.equal(result.sources[0].recovered_blocks, 1);
    assert.ok(calls.some(call => call.method === 'eth_getLogs'));
    assert.ok(!JSON.stringify(rows).includes('secret-key-123'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('actual native WebSocket and fetch operate against a local protocol server', async () => {
  const peers = new Set();
  function frame(payload, opcode = 1) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    if (body.length < 126) header[1] = body.length;
    else { header[1] = 126; header.writeUInt16BE(body.length, 2); }
    return Buffer.concat([header, body]);
  }
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const result = body.method === 'eth_chainId' ? Q(4663) : body.method === 'eth_blockNumber' ? '0x1' :
      body.method === 'eth_getBlockByNumber' ? block(1) : [log(1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  server.on('upgrade', (request, socket) => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15;
        const masked = Boolean(pending[1] & 128);
        let size = pending[1] & 127;
        let offset = 2;
        if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); offset = 4; }
        assert.notEqual(size, 127);
        const headerSize = offset + (masked ? 4 : 0);
        if (pending.length < headerSize + size) return;
        const body = Buffer.from(pending.subarray(headerSize, headerSize + size));
        if (masked) for (let i = 0; i < size; i++) body[i] ^= pending[offset + i % 4];
        pending = pending.subarray(headerSize + size);
        if (opcode === 8) { socket.end(frame(body, 8)); continue; }
        if (opcode === 9) { socket.write(frame(body, 10)); continue; }
        assert.equal(opcode, 1);
        const request = JSON.parse(body.toString('utf8'));
        const result = request.id === 1 ? Q(4663) : request.id === 2 ? 'native-heads' : 'native-logs';
        socket.write(frame({ jsonrpc: '2.0', id: request.id, result }));
        if (request.id === 3) setTimeout(() => {
          if (socket.destroyed) return;
          socket.write(frame({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: 'native-heads', result: block(1) } }));
          socket.write(frame({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: 'native-logs', result: log(1) } }));
        }, 10);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = settings({ duration_seconds: 0.15, request_timeout_ms: 300 });
  process.env.PULSE_TEST_HTTP = `http://127.0.0.1:${server.address().port}/rpc`;
  process.env.PULSE_TEST_WS = `ws://127.0.0.1:${server.address().port}/ws`;
  const rows = [];
  try {
    const result = await collect(config, { emit: async row => rows.push(row) });
    assert.equal(result.sources[0].live_heads, 1);
    assert.equal(result.sources[0].live_logs, 1);
    assert.equal(result.sources[0].recovered_blocks, 1);
    assert.equal(result.fatal, false);
  } finally {
    for (const socket of peers) socket.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('invalid chain, permissive filters and malformed resume are rejected', async () => {
  await assert.rejects(collect(settings({ chain_id: 1 }), { emit: async () => {} }), /CHAIN_ID_MUST_BE_4663/);
  await assert.rejects(collect(settings({ addresses: [] }), { emit: async () => {} }), /INVALID_ADDRESS_FILTER/);
  const sockets = socketFactory(); const { rpc } = rpcFactory();
  const { result } = await run(settings({ resume: { one: { next_block: 5, recent_blocks: [{ number: 1, hash: H(1), parent_hash: H(0) }] } } }), sockets, rpc);
  assert.equal(result.sources[0].reason, 'INVALID_RESUME_CURSOR');
});
