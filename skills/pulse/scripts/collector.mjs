import { createHash } from 'node:crypto';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
class Fault extends Error { constructor(code) { super(code); this.code = code; } }
function requireThat(value, code) { if (!value) throw new Fault(code); }
function bounded(value, fallback, min, max, name) {
  const result = value ?? fallback;
  requireThat(Number.isSafeInteger(result) && result >= min && result <= max, `INVALID_${name}`);
  return result;
}
function quantity(value, name) {
  requireThat(typeof value === 'string' && QUANTITY.test(value), `INVALID_${name}`);
  const result = Number(BigInt(value));
  requireThat(Number.isSafeInteger(result), `OVERSIZED_${name}`);
  return result;
}
function hash(value, name) { requireThat(typeof value === 'string' && HASH.test(value), `INVALID_${name}`); return value.toLowerCase(); }
function hex(number) { return `0x${number.toString(16)}`; }
function code(error) { return error instanceof Fault ? error.code : error?.name === 'AbortError' ? 'ABORTED' : 'SOURCE_OPERATION_FAILED'; }
function stamp(clock) {
  const result = clock ? clock() : { mono_ns: process.hrtime.bigint(), wall_iso: new Date().toISOString() };
  requireThat(result && /^(?:0|[1-9][0-9]*)$/.test(String(result.mono_ns)) && typeof result.wall_iso === 'string' && Number.isFinite(Date.parse(result.wall_iso)), 'INVALID_CLOCK');
  return { observed_mono_ns: String(result.mono_ns), observed_at: result.wall_iso };
}
function wait(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
function boundedOperation(operation, timeout, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, new Fault('ABORTED'));
    const timer = setTimeout(() => finish(reject, new Fault('REQUEST_TIMEOUT')), timeout);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
function resolveEndpoint(envName, protocols) {
  requireThat(typeof envName === 'string' && ENV_NAME.test(envName), 'INVALID_ENDPOINT_ENV_NAME');
  const value = process.env[envName];
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 8192, 'MISSING_ENDPOINT_ENV');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Fault('INVALID_ENDPOINT_URL'); }
  requireThat(protocols.includes(parsed.protocol), 'INVALID_ENDPOINT_PROTOCOL');
  requireThat(!parsed.hash, 'ENDPOINT_FRAGMENT_NOT_ALLOWED');
  return { value, parsed };
}
function redact(value, secrets, depth = 0) {
  requireThat(depth <= 32, 'PAYLOAD_DEPTH_LIMIT');
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map(x => redact(x, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets, depth + 1), redact(item, secrets, depth + 1)]));
  return value;
}
function normalizedHeader(raw) {
  requireThat(raw && typeof raw === 'object' && !Array.isArray(raw), 'BLOCK_UNAVAILABLE');
  return { number: quantity(raw.number, 'BLOCK_NUMBER'), hash: hash(raw.hash, 'BLOCK_HASH'),
    parent_hash: hash(raw.parentHash, 'PARENT_HASH'), timestamp: quantity(raw.timestamp, 'BLOCK_TIMESTAMP') };
}
function normalizedLog(raw) {
  requireThat(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_LOG');
  requireThat(typeof raw.address === 'string' && ADDRESS.test(raw.address), 'INVALID_LOG_ADDRESS');
  requireThat(Array.isArray(raw.topics) && raw.topics.length <= 4 && raw.topics.every(t => typeof t === 'string' && HASH.test(t)), 'INVALID_LOG_TOPICS');
  requireThat(typeof raw.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data), 'INVALID_LOG_DATA');
  requireThat(raw.removed === undefined || typeof raw.removed === 'boolean', 'INVALID_LOG_REMOVED');
  return { block_number: quantity(raw.blockNumber, 'LOG_BLOCK_NUMBER'), block_hash: hash(raw.blockHash, 'LOG_BLOCK_HASH'),
    transaction_hash: hash(raw.transactionHash, 'TRANSACTION_HASH'), log_index: quantity(raw.logIndex, 'LOG_INDEX'),
    transaction_index: quantity(raw.transactionIndex, 'TRANSACTION_INDEX') };
}
function validateConfig(input) {
  requireThat(input && input.chain_id === 4663, 'CHAIN_ID_MUST_BE_4663');
  requireThat(typeof input.run_id === 'string' && NAME.test(input.run_id), 'INVALID_RUN_ID');
  requireThat(typeof input.clock_id === 'string' && NAME.test(input.clock_id), 'INVALID_CLOCK_ID');
  requireThat(Array.isArray(input.sources) && input.sources.length >= 1 && input.sources.length <= 8, 'INVALID_SOURCES');
  const names = new Set();
  for (const source of input.sources) {
    requireThat(source && typeof source.name === 'string' && NAME.test(source.name) && !names.has(source.name), 'INVALID_SOURCE_NAME');
    names.add(source.name);
    requireThat(ENV_NAME.test(source.http_env ?? '') && ENV_NAME.test(source.ws_env ?? ''), 'INVALID_SOURCE_ENDPOINT_ENV');
    if (source.feed_env !== undefined) requireThat(ENV_NAME.test(source.feed_env), 'INVALID_FEED_ENDPOINT_ENV');
  }
  requireThat(Array.isArray(input.addresses) && input.addresses.length >= 1 && input.addresses.length <= 100 && input.addresses.every(x => typeof x === 'string' && ADDRESS.test(x)), 'INVALID_ADDRESS_FILTER');
  const c = { ...input, addresses: [...new Set(input.addresses.map(x => x.toLowerCase()))] };
  c.max_backfill_blocks = bounded(c.max_backfill_blocks, 200, 1, 10000, 'BACKFILL_LIMIT');
  c.reorg_depth = bounded(c.reorg_depth, 32, 1, 2048, 'REORG_DEPTH');
  c.request_timeout_ms = bounded(c.request_timeout_ms, 10000, 10, 120000, 'REQUEST_TIMEOUT');
  c.reconnect_ms = bounded(c.reconnect_ms, 1000, 1, 60000, 'RECONNECT_DELAY');
  c.max_reconnects = bounded(c.max_reconnects, 10, 0, 100, 'RECONNECT_LIMIT');
  c.queue_limit = bounded(c.queue_limit, 1000, 1, 100000, 'QUEUE_LIMIT');
  c.max_message_bytes = bounded(c.max_message_bytes, 2097152, 256, 16777216, 'MESSAGE_LIMIT');
  c.max_logs_per_block = bounded(c.max_logs_per_block, 10000, 1, 100000, 'BLOCK_LOG_LIMIT');
  requireThat(typeof (c.duration_seconds ?? 60) === 'number' && Number.isFinite(c.duration_seconds ?? 60) && (c.duration_seconds ?? 60) >= 0 && (c.duration_seconds ?? 60) <= 86400, 'INVALID_DURATION');
  c.duration_seconds ??= 60;
  if (c.from_block !== undefined) bounded(c.from_block, 0, 0, Number.MAX_SAFE_INTEGER, 'FROM_BLOCK');
  requireThat(c.resume === undefined || (c.resume && typeof c.resume === 'object' && !Array.isArray(c.resume)), 'INVALID_RESUME');
  return c;
}

/** Collect live arrivals and separately labelled HTTP recovery. No transactions. */
export async function collect(input, { emit, signal: externalSignal, rpc: injectedRpc, WebSocketImpl = globalThis.WebSocket, clock } = {}) {
  const config = validateConfig(input);
  requireThat(typeof emit === 'function', 'EMIT_REQUIRED');
  requireThat(typeof WebSocketImpl === 'function', 'WEBSOCKET_UNAVAILABLE');
  const lifetime = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, lifetime.signal]) : lifetime.signal;
  const duration = config.duration_seconds === 0 ? null : setTimeout(() => lifetime.abort(), config.duration_seconds * 1000);
  const secrets = new Set();
  const allSockets = new Set();
  let sequence = 0;
  let emitTail = Promise.resolve();
  let journalFailure = false;
  function addSecrets(endpoint) {
    secrets.add(endpoint.value);
    for (const value of [endpoint.parsed.username, endpoint.parsed.password, ...endpoint.parsed.searchParams.values()]) {
      if (value.length >= 4) { secrets.add(value); try { secrets.add(decodeURIComponent(value)); } catch {} }
    }
    const standardPathWords = new Set(['ethereum', 'robinhood', 'websocket', 'websockets', 'public-rpc', 'mainnet', 'testnet', 'jsonrpc', 'sequencer', 'archive']);
    for (const segment of endpoint.parsed.pathname.split('/')) {
      if (segment.length >= 8 && !standardPathWords.has(segment.toLowerCase())) {
        secrets.add(segment); try { secrets.add(decodeURIComponent(segment)); } catch {}
      }
    }
  }
  async function publish(source, stage, event_id, payload, extra = {}, received = stamp(clock)) {
    const observation = { schema_version: 'pulse.observation.v1', chain_id: 4663, run_id: config.run_id,
      clock_id: config.clock_id, source, stage, event_id, ...received, delivery: 'live', ...extra,
      payload: redact(payload, secrets) };
    const operation = emitTail.then(() => emit(observation));
    emitTail = operation.catch(() => { journalFailure = true; lifetime.abort(); });
    await operation;
  }
  async function health(source, kind, details = {}, extra = {}) {
    return publish(source, 'health', `health:${config.run_id}:${source}:${++sequence}`, { kind, ...details }, extra);
  }
  async function runSource(source) {
    const local = new AbortController();
    const sourceSignal = AbortSignal.any([signal, local.signal]);
    const state = { connected: false, sockets: new Set(), cursor: null, recent: [], fatal: null,
      wake: null, wake_pending: false, reconnects: 0, generation: 0, recovered_blocks: 0, feed_messages: 0, live_heads: 0, live_logs: 0,
      last_live_head: null, first_live_block: null };
    let endpoints;
    let httpRequestId = 0;
    function wake() { state.wake_pending = true; if (state.wake) { state.wake_pending = false; state.wake(); } }
    function stop(failure) {
      if (failure && !state.fatal) state.fatal = failure;
      local.abort(); wake();
      for (const socket of state.sockets) try { socket.close(1000); } catch {}
    }
    function pause(ms) {
      if (state.wake_pending) { state.wake_pending = false; return Promise.resolve(); }
      return new Promise(resolve => {
        const done = () => { clearTimeout(timer); sourceSignal.removeEventListener('abort', done); if (state.wake === done) state.wake = null; resolve(); };
        const timer = setTimeout(done, ms);
        state.wake = done;
        if (sourceSignal.aborted) done(); else sourceSignal.addEventListener('abort', done, { once: true });
      });
    }
    async function rpc(method, params) {
      const result = await boundedOperation(async () => {
        if (injectedRpc) return injectedRpc(source, method, params, { signal: sourceSignal, timeout_ms: config.request_timeout_ms });
        const timeout = AbortSignal.timeout(config.request_timeout_ms);
        const requestId = ++httpRequestId;
        let response;
        try {
          response = await fetch(endpoints.http.value, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.any([sourceSignal, timeout]) });
        } catch { throw new Fault('HTTP_TRANSPORT_FAILED'); }
        requireThat(response.ok, 'HTTP_STATUS_FAILED');
        const length = response.headers.get('content-length');
        if (length) requireThat(Number(length) <= config.max_message_bytes, 'HTTP_MESSAGE_LIMIT');
        const reader = response.body.getReader();
        let size = 0; const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            requireThat(size <= config.max_message_bytes, 'HTTP_MESSAGE_LIMIT');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fault('INVALID_HTTP_JSON'); }
        requireThat(body && body.jsonrpc === '2.0' && body.id === requestId && !body.error && Object.hasOwn(body, 'result'), 'RPC_RESPONSE_FAILED');
        return body.result;
      }, config.request_timeout_ms, sourceSignal);
      requireThat(Buffer.byteLength(JSON.stringify(result) ?? '') <= config.max_message_bytes, 'RPC_MESSAGE_LIMIT');
      return result;
    }
    async function getHeader(number) {
      const raw = await rpc('eth_getBlockByNumber', [hex(number), false]);
      const block = normalizedHeader(raw);
      requireThat(block.number === number, 'BLOCK_NUMBER_MISMATCH');
      return { raw, block };
    }
    async function reconcile() {
      if (!state.recent.length) return;
      const last = state.recent.at(-1);
      const actual = await getHeader(last.number);
      if (actual.block.hash === last.hash) return;
      let ancestor = null;
      for (let index = state.recent.length - 2; index >= 0; index--) {
        const candidate = state.recent[index];
        const canonical = await getHeader(candidate.number);
        if (canonical.block.hash === candidate.hash) { ancestor = candidate; break; }
      }
      requireThat(ancestor, 'REORG_BEYOND_RETAINED_DEPTH');
      const orphaned = state.recent.filter(x => x.number > ancestor.number);
      await health(source.name, 'reorg_detected', { ancestor, orphaned, rewind_to: ancestor.number + 1 }, { delivery: 'backfill' });
      state.recent = state.recent.filter(x => x.number <= ancestor.number);
      state.cursor = ancestor.number + 1;
    }
    async function recoverBlock(number) {
      const first = await getHeader(number);
      const logs = await rpc('eth_getLogs', [{ fromBlock: hex(number), toBlock: hex(number), address: config.addresses }]);
      requireThat(Array.isArray(logs) && logs.length <= config.max_logs_per_block, 'INVALID_BLOCK_LOGS');
      const slots = new Map();
      const retained = [];
      for (const raw of logs) {
        const log = normalizedLog(raw);
        requireThat(log.block_number === number && log.block_hash === first.block.hash && raw.removed !== true, 'BLOCK_LOG_BINDING_MISMATCH');
        requireThat(config.addresses.includes(raw.address.toLowerCase()), 'LOG_OUTSIDE_ADDRESS_FILTER');
        const serialization = JSON.stringify(raw);
        if (slots.has(log.log_index)) {
          requireThat(slots.get(log.log_index) === serialization, 'CONFLICTING_BLOCK_LOG_SLOT');
          continue;
        }
        slots.set(log.log_index, serialization);
        retained.push({ raw, normalized: log });
      }
      retained.sort((a, b) => a.normalized.log_index - b.normalized.log_index);
      const second = await getHeader(number);
      requireThat(second.block.hash === first.block.hash && second.block.parent_hash === first.block.parent_hash, 'BLOCK_CHANGED_DURING_RECOVERY');
      const parent = state.recent.at(-1);
      if (parent) requireThat(number === parent.number + 1 && first.block.parent_hash === parent.hash, 'RECOVERY_PARENT_MISMATCH');
      const received = stamp(clock);
      await publish(source.name, 'head', `head:4663:${first.block.hash}`, first.raw,
        { delivery: 'backfill', block_number: number, block_hash: first.block.hash }, received);
      for (const item of retained) await publish(source.name, 'log', `log:4663:${item.normalized.block_hash}:${item.normalized.transaction_hash}:${item.normalized.log_index}`,
        item.raw, { delivery: 'backfill', ...item.normalized }, received);
      await health(source.name, 'block_complete', { block: { ...first.block, logs: retained.map(x => x.raw),
        coverage: 'provider_reported_complete', observed_at: received.observed_at } }, { delivery: 'backfill', block_number: number, block_hash: first.block.hash });
      const recent = [...state.recent, first.block].slice(-config.reorg_depth);
      // emit resolves only after the caller has persisted the block bundle.
      await health(source.name, 'checkpoint', { next_block: number + 1,
        recent_blocks: recent.map(({ number, hash, parent_hash }) => ({ number, hash, parent_hash })) }, { delivery: 'backfill' });
      state.recent = recent;
      state.cursor = number + 1;
      state.recovered_blocks++;
    }
    async function recovery() {
      let consecutiveRetries = 0;
      let lagRetries = 0;
      let lagged = false;
      while (!sourceSignal.aborted) {
        if (!state.connected) { await pause(config.reconnect_ms); continue; }
        try {
          const tip = quantity(await rpc('eth_blockNumber', []), 'TIP');
          if (state.cursor === null) state.cursor = state.first_live_block === null ? tip : Math.min(tip, state.first_live_block);
          const lastCompleted = state.recent.at(-1)?.number ?? -1;
          const lastLive = state.last_live_head?.number ?? -1;
          if (tip < lastCompleted || tip < lastLive) {
            lagged = true;
            await health(source.name, 'rpc_lag_detected', { http_tip: tip, last_completed_block: lastCompleted,
              last_live_head: lastLive, retry: ++lagRetries, retry_limit: config.max_reconnects,
              checkpoint_preserved: true }, { delivery: 'backfill' });
            if (lagRetries > config.max_reconnects) { stop('HTTP_TIP_LAG_EXCEEDED'); break; }
            await pause(config.reconnect_ms);
            continue;
          }
          await reconcile();
          const missing = tip - state.cursor + 1;
          requireThat(missing <= config.max_backfill_blocks, 'GAP_EXCEEDS_BACKFILL_LIMIT');
          if (missing > 1) await health(source.name, 'gap_detected', { from_block: state.cursor, to_block: tip,
            missing_blocks: missing, recovery: 'single_block_http' }, { delivery: 'backfill' });
          for (let number = state.cursor; number <= tip && state.connected && !sourceSignal.aborted; number++) await recoverBlock(number);
          if (state.last_live_head && state.last_live_head.number > tip) continue;
          if (lagged && state.connected && !sourceSignal.aborted) {
            await health(source.name, 'rpc_lag_resolved', { http_tip: tip, recovered_through: state.cursor - 1,
              last_live_head: state.last_live_head?.number ?? null }, { delivery: 'backfill' });
            lagged = false;
          }
          lagRetries = 0;
          consecutiveRetries = 0;
        } catch (error) {
          if (sourceSignal.aborted) break;
          const reason = code(error);
          if (reason === 'BLOCK_CHANGED_DURING_RECOVERY' || reason === 'RECOVERY_PARENT_MISMATCH') {
            await health(source.name, 'recovery_retry', { reason }, { delivery: 'backfill' });
            if (++consecutiveRetries > config.max_reconnects) { stop(reason); break; }
            await pause(config.reconnect_ms);
            continue;
          }
          stop(reason); break;
        }
        await pause(Math.max(config.reconnect_ms, 1000));
      }
    }
    function socketSession(endpoint, feed = false) {
      const generation = feed ? null : ++state.generation;
      return new Promise(resolve => {
        let socket;
        let finished = false;
        let ready = false;
        let processing = false;
        let queuedBytes = 0;
        let earlyBytes = 0;
        let initTimer;
        const queue = [];
        const early = [];
        const subscriptions = new Map();
        const answers = new Map();
        const current = () => !finished && !sourceSignal.aborted && (feed || state.generation === generation);
        const finish = reason => {
          if (finished) return;
          finished = true; clearTimeout(initTimer); queue.length = 0; early.length = 0; queuedBytes = 0; earlyBytes = 0;
          sourceSignal.removeEventListener('abort', onAbort);
          if (!feed && state.generation === generation) { state.connected = false; wake(); }
          if (socket) { state.sockets.delete(socket); allSockets.delete(socket); try { socket.close(1000); } catch {} }
          resolve(reason);
        };
        const onAbort = () => finish('ABORTED');
        async function notification(message, received) {
          requireThat(message?.method === 'eth_subscription' && message.params && typeof message.params.subscription === 'string', 'INVALID_WS_NOTIFICATION');
          const stage = subscriptions.get(message.params.subscription);
          requireThat(stage, 'UNRECOGNIZED_SUBSCRIPTION');
          const payload = message.params.result;
          if (stage === 'head') {
            const header = normalizedHeader(payload);
            state.first_live_block = state.first_live_block === null ? header.number : Math.min(state.first_live_block, header.number);
            await publish(source.name, 'head', `head:4663:${header.hash}`, payload,
              { block_number: header.number, block_hash: header.hash }, received);
            state.live_heads++;
            const previous = state.recent.find(x => x.number === header.number);
            if (previous && previous.hash !== header.hash) await health(source.name, 'live_reorg_hint', { number: header.number, previous_hash: previous.hash, observed_hash: header.hash });
            if (state.last_live_head && header.number > state.last_live_head.number + 1) await health(source.name, 'gap_detected', {
              scope: 'websocket_head_notifications', from_block: state.last_live_head.number + 1, to_block: header.number - 1,
              missing_blocks: header.number - state.last_live_head.number - 1, recovery: 'http_verification_pending' });
            if (state.last_live_head && header.number === state.last_live_head.number && header.hash !== state.last_live_head.hash && !previous)
              await health(source.name, 'live_reorg_hint', { number: header.number, previous_hash: state.last_live_head.hash, observed_hash: header.hash });
            if (state.last_live_head && header.number === state.last_live_head.number + 1 && header.parent_hash !== state.last_live_head.hash)
              await health(source.name, 'live_reorg_hint', { number: header.number, expected_parent_hash: state.last_live_head.hash,
                observed_parent_hash: header.parent_hash, reason: 'live_parent_disagreement' });
            if (!state.last_live_head || header.number >= state.last_live_head.number) state.last_live_head = header;
            wake();
          } else {
            const log = normalizedLog(payload);
            state.first_live_block = state.first_live_block === null ? log.block_number : Math.min(state.first_live_block, log.block_number);
            requireThat(config.addresses.includes(payload.address.toLowerCase()), 'LOG_OUTSIDE_ADDRESS_FILTER');
            const prefix = payload.removed ? 'log_removed' : 'log';
            await publish(source.name, 'log', `${prefix}:4663:${log.block_hash}:${log.transaction_hash}:${log.log_index}`, payload, log, received);
            state.live_logs++;
            if (payload.removed) { await health(source.name, 'removed_log_hint', log); wake(); }
          }
        }
        async function drain() {
          if (processing) return;
          processing = true;
          try {
            while (queue.length && current()) {
              const item = queue.shift();
              queuedBytes -= item.size;
              let bytes;
              if (typeof item.data === 'string') bytes = Buffer.from(item.data);
              else if (item.data instanceof ArrayBuffer) bytes = Buffer.from(item.data);
              else if (ArrayBuffer.isView(item.data)) bytes = Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength);
              else if (item.data && typeof item.data.arrayBuffer === 'function') bytes = Buffer.from(await item.data.arrayBuffer());
              else throw new Fault('UNSUPPORTED_WS_MESSAGE_TYPE');
              requireThat(bytes.byteLength <= config.max_message_bytes, 'WS_MESSAGE_LIMIT');
              if (feed) {
                requireThat(ready, 'FEED_NOT_READY');
                const rawText = bytes.toString('utf8');
                const redactedText = redact(rawText, secrets);
                const retainedBytes = redactedText === rawText ? bytes : Buffer.from(redactedText);
                await publish(source.name, 'feed', `feed:4663:${createHash('sha256').update(bytes).digest('hex')}`,
                  { provisional: true, chain_binding: 'configured_unverified', encoding: 'base64', raw_base64: retainedBytes.toString('base64'), credentials_redacted: redactedText !== rawText,
                    interpretation: 'Raw relay envelope; feed sequence is not an L2 block number; no log decoding performed.' }, {}, item.received);
                state.feed_messages++;
                continue;
              }
              let message;
              try { message = JSON.parse(bytes.toString('utf8')); } catch { throw new Fault('INVALID_WS_JSON'); }
              requireThat(message && !Array.isArray(message) && message.jsonrpc === '2.0', 'INVALID_WS_RPC_MESSAGE');
              if (Object.hasOwn(message, 'id')) {
                requireThat([1, 2, 3].includes(message.id) && !answers.has(message.id) && !message.error && Object.hasOwn(message, 'result'), 'WS_SUBSCRIPTION_REJECTED');
                if (message.id === 1) requireThat(quantity(message.result, 'WS_CHAIN_ID') === 4663, 'WS_CHAIN_MISMATCH');
                else requireThat(typeof message.result === 'string' && message.result.length > 0 && message.result.length <= 256, 'INVALID_SUBSCRIPTION_ID');
                answers.set(message.id, message.result);
                if (answers.size === 3) {
                  requireThat(answers.get(2) !== answers.get(3), 'DUPLICATE_SUBSCRIPTION_ID');
                  subscriptions.set(answers.get(2), 'head'); subscriptions.set(answers.get(3), 'log');
                  ready = true; clearTimeout(initTimer);
                  await health(source.name, 'subscriptions_ready', { chain_id: 4663, stages: ['head', 'log'], generation });
                  if (!current()) break;
                  if (early.length) await health(source.name, 'pre_ready_notifications_buffered', { count: early.length,
                    retained_bytes: earlyBytes, original_receipt_times_preserved: true });
                  for (const pending of early.splice(0)) {
                    earlyBytes -= pending.size;
                    if (!current()) break;
                    await notification(pending.message, pending.received);
                  }
                  if (!current()) break;
                  state.connected = true; wake();
                }
              } else if (!ready) {
                requireThat(early.length + queue.length < config.queue_limit && earlyBytes + queuedBytes + item.size <= Math.min(config.max_message_bytes * 4, 67108864), 'WS_QUEUE_LIMIT');
                earlyBytes += item.size;
                early.push({ message, received: item.received, size: item.size });
              } else await notification(message, item.received);
            }
          } catch (error) { finish(code(error)); }
          finally { processing = false; }
        }
        try { socket = new WebSocketImpl(endpoint.value); }
        catch { finish('WS_CONSTRUCTION_FAILED'); return; }
        state.sockets.add(socket); allSockets.add(socket);
        socket.binaryType = 'arraybuffer';
        initTimer = setTimeout(() => finish('WS_INITIALIZATION_TIMEOUT'), config.request_timeout_ms);
        sourceSignal.addEventListener('abort', onAbort, { once: true });
        if (sourceSignal.aborted) { finish('ABORTED'); return; }
        socket.addEventListener('open', () => {
          if (!current()) return;
          if (feed) { ready = true; clearTimeout(initTimer); health(source.name, 'feed_connected', { provisional: true }).catch(() => finish('JOURNAL_FAILED')); }
          else {
            try {
              socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
              socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
              socket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_subscribe', params: ['logs', { address: config.addresses }] }));
            } catch { finish('WS_SEND_FAILED'); }
          }
        });
        socket.addEventListener('message', event => {
          if (!current()) return;
          const size = typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data?.byteLength ?? event.data?.size;
          if (!Number.isSafeInteger(size) || size > config.max_message_bytes) { finish('WS_MESSAGE_LIMIT'); return; }
          if (queue.length + early.length >= config.queue_limit || queuedBytes + earlyBytes + size > Math.min(config.max_message_bytes * 4, 67108864)) { finish('WS_QUEUE_LIMIT'); return; }
          let received;
          try { received = stamp(clock); } catch { finish('INVALID_CLOCK'); return; }
          queuedBytes += size;
          queue.push({ data: event.data, received, size });
          void drain();
        });
        socket.addEventListener('close', () => finish('WS_CLOSED'));
        socket.addEventListener('error', () => finish('WS_TRANSPORT_FAILED'));
      });
    }
    async function feedLoop() {
      if (!endpoints.feed) return;
      for (let attempt = 0; attempt <= config.max_reconnects && !sourceSignal.aborted; attempt++) {
        const reason = await socketSession(endpoints.feed, true);
        if (sourceSignal.aborted) break;
        await health(source.name, 'feed_disconnected', { reason, reconnect_attempt: attempt });
        if (attempt === config.max_reconnects) { await health(source.name, 'feed_failed_closed', { reason }); break; }
        await wait(config.reconnect_ms, sourceSignal);
      }
    }
    let recoveryTask, feedTask;
    try {
      endpoints = { http: resolveEndpoint(source.http_env, ['https:', 'http:']), ws: resolveEndpoint(source.ws_env, ['wss:', 'ws:']) };
      if (source.feed_env) endpoints.feed = resolveEndpoint(source.feed_env, ['wss:', 'ws:']);
      Object.values(endpoints).forEach(addSecrets);
      const resume = config.resume?.[source.name];
      if (resume) {
        state.cursor = bounded(resume.next_block, undefined, 0, Number.MAX_SAFE_INTEGER, 'RESUME_NEXT_BLOCK');
        requireThat(Array.isArray(resume.recent_blocks) && resume.recent_blocks.length <= config.reorg_depth, 'INVALID_RESUME_HISTORY');
        state.recent = resume.recent_blocks.map(x => ({ number: bounded(x.number, undefined, 0, Number.MAX_SAFE_INTEGER, 'RESUME_BLOCK'),
          hash: hash(x.hash, 'RESUME_HASH'), parent_hash: hash(x.parent_hash, 'RESUME_PARENT') }));
        for (let i = 1; i < state.recent.length; i++) requireThat(state.recent[i].number === state.recent[i - 1].number + 1 && state.recent[i].parent_hash === state.recent[i - 1].hash, 'INVALID_RESUME_CONTINUITY');
        if (state.recent.length) requireThat(state.recent.at(-1).number + 1 === state.cursor, 'INVALID_RESUME_CURSOR');
      } else state.cursor = config.from_block ?? null;
      requireThat(quantity(await rpc('eth_chainId', []), 'HTTP_CHAIN_ID') === 4663, 'HTTP_CHAIN_MISMATCH');
      await health(source.name, 'http_chain_verified', { chain_id: 4663 });
      recoveryTask = recovery();
      feedTask = feedLoop();
      for (let attempt = 0; attempt <= config.max_reconnects && !sourceSignal.aborted; attempt++) {
        const reason = await socketSession(endpoints.ws);
        if (sourceSignal.aborted) break;
        await health(source.name, 'source_disconnected', { reason, reconnect_attempt: attempt });
        if (attempt === config.max_reconnects) { stop(reason); break; }
        state.reconnects++;
        await wait(config.reconnect_ms, sourceSignal);
        requireThat(quantity(await rpc('eth_chainId', []), 'HTTP_CHAIN_ID') === 4663, 'HTTP_CHAIN_MISMATCH');
      }
    } catch (error) { if (!signal.aborted) state.fatal ??= code(error); }
    finally {
      stop();
      await Promise.allSettled([recoveryTask, feedTask].filter(Boolean));
      if (!journalFailure) await health(source.name, state.fatal ? 'source_failed_closed' : 'source_stopped', {
        reason: state.fatal ?? (externalSignal?.aborted ? 'external_abort' : 'duration_elapsed'),
        recovered_blocks: state.recovered_blocks, reconnects: state.reconnects,
        next_block: state.cursor, recent_blocks: state.recent.map(({ number, hash, parent_hash }) => ({ number, hash, parent_hash })) });
    }
    return { source: source.name, status: state.fatal ? 'failed_closed' : 'stopped', reason: state.fatal,
      live_heads: state.live_heads, live_logs: state.live_logs, feed_messages: state.feed_messages,
      recovered_blocks: state.recovered_blocks, reconnects: state.reconnects,
      resume: { next_block: state.cursor, recent_blocks: state.recent.map(({ number, hash, parent_hash }) => ({ number, hash, parent_hash })) } };
  }
  try {
    const results = await Promise.allSettled(config.sources.map(runSource));
    await emitTail;
    requireThat(!journalFailure, 'JOURNAL_EMIT_FAILED');
    const sources = results.map((result, index) => result.status === 'fulfilled' ? result.value :
      { source: config.sources[index].name, status: 'failed_closed', reason: code(result.reason) });
    return { chain_id: 4663, run_id: config.run_id, fatal: sources.every(source => source.status === 'failed_closed'),
      any_source_failed: sources.some(source => source.status === 'failed_closed'), sources };
  } finally {
    clearTimeout(duration); lifetime.abort();
    for (const socket of allSockets) try { socket.close(1000); } catch {}
  }
}
