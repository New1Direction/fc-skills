import { randomUUID } from 'node:crypto';

const READ_METHODS = new Set(['eth_chainId', 'eth_syncing', 'eth_getBlockByNumber', 'eth_getBlockReceipts', 'eth_getTransactionReceipt']);
const quantity = value => `0x${BigInt(value).toString(16)}`;
const blockNumber = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw coded('invalid_block_number');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n)) throw coded('invalid_block_number');
  return n;
};
const coded = (code, rpcCode) => Object.assign(new Error(code), { code, ...(rpcCode !== undefined ? { rpcCode } : {}) });
const safeCode = error => {
  const allowed = new Set(['aborted', 'request_timeout', 'response_too_large', 'invalid_rpc_response', 'rpc_error', 'http_error', 'transport_error', 'invalid_block_number', 'invalid_block', 'invalid_head', 'wrong_chain', 'reorg_depth_exceeded', 'storage_error', 'block_chain_changed', 'receipt_error', 'missing_endpoint_environment', 'invalid_endpoint_environment']);
  return allowed.has(error?.code) ? error.code : 'operation_failed';
};

export function normalizeConfig(input) {
  const c = {
    chain_id: 4663, poll_ms: 500, request_timeout_ms: 10000, block_concurrency: 4,
    receipt_concurrency: 4, max_blocks_per_round: 32, reorg_depth: 128,
    max_response_bytes: 32 * 1024 * 1024, max_requests_per_second: 20,
    max_pending_receipt_blocks: 256, duration_seconds: 0, ...input,
  };
  if (c.chain_id !== 4663) throw coded('invalid_chain_config');
  for (const key of ['from_block', 'poll_ms', 'request_timeout_ms', 'block_concurrency', 'receipt_concurrency', 'max_blocks_per_round', 'reorg_depth', 'max_response_bytes', 'max_pending_receipt_blocks']) {
    if (!Number.isSafeInteger(c[key]) || c[key] < (key === 'from_block' ? 0 : 1)) throw coded(`invalid_${key}`);
  }
  if (!Number.isFinite(c.max_requests_per_second) || c.max_requests_per_second <= 0 || !Number.isFinite(c.duration_seconds) || c.duration_seconds < 0) throw coded('invalid_rate_or_duration');
  if (!Array.isArray(c.sources) || !c.sources.length || c.sources.length > 8) throw coded('invalid_sources');
  const names = new Set();
  for (const s of c.sources) {
    if (!s || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.name ?? '') || names.has(s.name)) throw coded('invalid_source_name');
    names.add(s.name);
    for (const field of ['http_env', 'ws_env']) if (s[field] !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(s[field])) throw coded('invalid_endpoint_env');
    // URLs are never accepted in config or retained metadata.
    if (Object.keys(s).some(k => !['name', 'http_env', 'ws_env'].includes(k))) throw coded('invalid_source_field');
  }
  if (!names.has(c.primary_source)) throw coded('invalid_primary_source');
  return c;
}
const settings = normalizeConfig;

function abortWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(coded('aborted'));
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(coded('aborted')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function notifier() {
  const waiting = new Set();
  let pending = false;
  return {
    wake() { if (!waiting.size) pending = true; else for (const wake of [...waiting]) wake(); },
    wait(ms, signal) {
      return new Promise(resolve => {
        if (signal.aborted) return resolve();
        if (pending) { pending = false; return resolve(); }
        let timer;
        const finish = () => { clearTimeout(timer); waiting.delete(finish); signal.removeEventListener('abort', finish); resolve(); };
        waiting.add(finish); signal.addEventListener('abort', finish, { once: true }); timer = setTimeout(finish, ms);
      });
    },
  };
}

function defaultClock() {
  const run_id = randomUUID();
  const clock_id = randomUUID();
  return () => ({ run_id, clock_id, observed_mono_ns: process.hrtime.bigint().toString(), observed_at: new Date().toISOString() });
}

function endpoint(source, field) {
  const key = source[field];
  if (!key || !process.env[key]) throw coded('missing_endpoint_environment');
  let parsed;
  try { parsed = new URL(process.env[key]); } catch { throw coded('invalid_endpoint_environment'); }
  const protocols = field === 'ws_env' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!protocols.includes(parsed.protocol)) throw coded('invalid_endpoint_environment');
  return parsed.href;
}

function transport(config, injected, outerSignal, counts) {
  let nextStart = 0;
  let id = 0;
  return async (source, method, params) => {
    if (!READ_METHODS.has(method)) throw coded('forbidden_rpc_method');
    if (outerSignal.aborted) throw coded('aborted');
    // Resolve configuration before consuming a request slot or reporting an attempted transport call.
    const url = injected ? null : endpoint(source, 'http_env');
    const now = performance.now();
    const scheduled = Math.max(now, nextStart);
    nextStart = scheduled + 1000 / config.max_requests_per_second;
    await abortWait(scheduled - now, outerSignal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal.addEventListener('abort', abort, { once: true });
    let timeout;
    let timedOut = false;
    let timeoutReject;
    const cancelled = new Promise((_, reject) => { timeoutReject = reject; });
    const onAbort = () => timeoutReject(coded(timedOut ? 'request_timeout' : 'aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.request_timeout_ms);
    counts.requests++;
    try {
      const request = (async () => {
        if (injected) return injected(source.name, method, params, { signal: controller.signal });
        let response;
        try {
          const requestId = ++id;
          response = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: controller.signal,
          });
          response.watchtowerRequestId = requestId;
        } catch (error) { if (controller.signal.aborted) throw coded(timedOut ? 'request_timeout' : 'aborted'); throw coded('transport_error'); }
        if (!response.ok) { await response.body?.cancel(); throw coded('http_error'); }
        if (Number(response.headers.get('content-length')) > config.max_response_bytes) { await response.body?.cancel(); throw coded('response_too_large'); }
        const reader = response.body?.getReader();
        if (!reader) throw coded('invalid_rpc_response');
        const chunks = []; let bytes = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > config.max_response_bytes) { await reader.cancel(); throw coded('response_too_large'); }
          chunks.push(Buffer.from(value));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw coded('invalid_rpc_response'); }
        if (!body || body.jsonrpc !== '2.0' || body.id !== response.watchtowerRequestId || (!Object.hasOwn(body, 'result') && !body.error)) throw coded('invalid_rpc_response');
        if (body.error) throw coded('rpc_error', Number.isInteger(body.error.code) ? body.error.code : undefined);
        return body.result;
      })();
      return await Promise.race([request, cancelled]);
    } catch (error) {
      if (outerSignal.aborted) throw coded('aborted');
      if (timedOut) throw coded('request_timeout');
      // Preserve numeric capability codes from injected adapters, never their text.
      const rpcCode = Number.isInteger(error?.rpcCode) ? error.rpcCode : Number.isInteger(error?.code) ? error.code : undefined;
      throw coded(rpcCode !== undefined ? 'rpc_error' : safeCode(error), rpcCode);
    } finally {
      clearTimeout(timeout); outerSignal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
    }
  };
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    for (;;) { const i = index++; if (i >= items.length) break; result[i] = await fn(items[i], i); }
  }));
  return result;
}

function semaphore(limit) {
  let active = 0; const waiting = [];
  return async fn => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await fn(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

function validHead(raw) {
  if (!raw || !/^0x[0-9a-f]{64}$/i.test(raw.hash ?? '') || !/^0x[0-9a-f]{64}$/i.test(raw.parentHash ?? '')) throw coded('invalid_head');
  return blockNumber(raw.number);
}

/** Read-only endpoint inspection; capability support is only asserted after a valid response. */
export async function probe(input, { rpc, signal } = {}) {
  const config = settings(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const counts = { requests: 0 };
  const call = transport(config, rpc, controller.signal, counts);
  try {
    const sources = await Promise.all(config.sources.map(async source => {
      try {
        const chain = blockNumber(await call(source, 'eth_chainId', []));
        if (chain !== config.chain_id) return { name: source.name, state: 'wrong_chain', chain_id: chain };
        const head = await call(source, 'eth_getBlockByNumber', ['latest', false]);
        const number = validHead(head);
        const result = { name: source.name, state: 'available', chain_id: chain, head_number: number, head_hash: head.hash, websocket_configured: Boolean(source.ws_env && process.env[source.ws_env]), syncing: 'unverified', full_blocks: 'unverified', block_receipts: 'unverified', direct_nitro_feed: false, live_coverage_established: false };
        try { const sync = await call(source, 'eth_syncing', []); result.syncing = sync === false ? false : sync && typeof sync === 'object' ? true : 'invalid_response'; } catch { result.syncing = 'unavailable'; }
        let full;
        try {
          full = await call(source, 'eth_getBlockByNumber', [head.number, true]);
          if (!full || validHead(full) !== number || full.hash !== head.hash || !Array.isArray(full.transactions) || full.transactions.some(tx => !tx || typeof tx !== 'object' || !/^0x[0-9a-f]{64}$/i.test(tx.hash ?? ''))) throw coded('invalid_block');
          result.full_blocks = 'observed_supported';
        } catch { result.full_blocks = 'unavailable_or_invalid'; }
        try {
          const receipts = await call(source, 'eth_getBlockReceipts', [head.number]);
          if (!full || !Array.isArray(receipts) || receipts.length !== full.transactions.length || receipts.some((row, i) => !row || row.blockHash !== head.hash || row.transactionHash !== full.transactions[i]?.hash || blockNumber(row.transactionIndex) !== i)) throw coded('receipt_error');
          result.block_receipts = 'observed_response_shape';
        } catch (error) { result.block_receipts = [-32601, -32602, -32004].includes(error.rpcCode) ? 'unsupported' : 'unavailable_or_invalid'; }
        return result;
      } catch (error) { return { name: source.name, state: 'unavailable', error_code: safeCode(error) }; }
    }));
    return { schema: 'watchtower.probe.v1', primary_source: config.primary_source, sources, requests: counts.requests, endpoints_retained: false };
  } finally { signal?.removeEventListener('abort', abort); }
}

/** Full included-transaction capture; receipt enrichment runs independently of ordered block commits. */
export async function capture(input, { store, signal, rpc, WebSocketImpl = globalThis.WebSocket, clock = defaultClock() } = {}) {
  const config = settings(input);
  if (!store) throw coded('store_required');
  const progress = () => store.progress ? store.progress() : store.coverage();
  const initialCoverage = progress();
  if (initialCoverage.chain_id !== config.chain_id || initialCoverage.start_block !== config.from_block) throw coded('store_config_mismatch');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const started = Date.now();
  const status = { schema: 'watchtower.capture.v1', primary_source: config.primary_source, reason: 'stopped', blocks_committed: 0, transactions_committed: 0, receipt_blocks_committed: 0, requests: 0, reorgs: 0, errors: [], errors_total: 0, backlog_pauses: 0, websocket_heads: 0, websocket_reconnects: 0, source_states: {}, direct_nitro_feed: false };
  let timeout;
  if (config.duration_seconds > 0) timeout = setTimeout(() => { status.reason = 'duration_limit'; controller.abort(); }, config.duration_seconds * 1000);
  const call = transport(config, rpc, controller.signal, status);
  const primary = config.sources.find(s => s.name === config.primary_source);
  const primaryWake = notifier(); const receiptWake = notifier();
  const background = [];
  let fatal;
  const meta = (source, delivery = 'live') => ({ ...clock(), source: source.name, delivery });
  const observe = (stage, eventId, source, payload, delivery = 'live') => {
    try { store.observe(stage, eventId, meta(source, delivery), payload); } catch { fatal = coded('storage_error'); controller.abort(); }
  };
  const failure = (stage, source, error, eventId) => {
    const row = { stage, source: source.name, error_code: safeCode(error), ...(eventId ? { event_id: eventId } : {}) };
    status.errors_total++; if (status.errors.length < 100) status.errors.push(row);
    if (eventId) observe(`${stage}_error`, eventId, source, { error_code: row.error_code });
  };
  const receiptAttempts = new Map(); let blockReceiptsSupported;
  const receiptSlot = semaphore(config.receipt_concurrency);
  const receiptCall = (method, params) => receiptSlot(() => call(primary, method, params));
  const healthWritten = new Map();
  const syncState = new Map();
  const health = (source, head) => {
    const now = Date.now();
    if (now - (healthWritten.get(source.name) ?? 0) < 1000) return;
    healthWritten.set(source.name, now);
    observe('source_health', `${source.name}:${Math.floor(now / 1000)}`, source, {
      responsive: true, head_number: validHead(head), head_hash: head.hash,
      primary: source.name === primary.name,
      syncing: syncState.get(source.name)?.value ?? 'unverified',
      syncing_checked_at: syncState.get(source.name)?.checked_at ?? null,
    });
  };
  async function inspectSync(source) {
    try {
      const value = await call(source, 'eth_syncing', []);
      syncState.set(source.name, { value: value === false ? false : value && typeof value === 'object' ? true : 'invalid_response', checked_at: new Date().toISOString() });
    } catch { syncState.set(source.name, { value: 'unavailable', checked_at: new Date().toISOString() }); }
  }

  async function fetchReceipts(block) {
    let rows;
    const delivery = store.blockMeta?.(block.hash)?.delivery ?? 'backfill';
    if (blockReceiptsSupported !== false) {
      try {
        rows = await receiptCall('eth_getBlockReceipts', [block.number]);
        if (!Array.isArray(rows)) throw coded('invalid_rpc_response');
        // Store validation, not the mere existence of an endpoint, verifies contents.
      } catch (error) {
        if ([-32601, -32602, -32004].includes(error.rpcCode)) blockReceiptsSupported = false;
        else throw error;
      }
    }
    if (blockReceiptsSupported === false) {
      rows = await mapLimit(block.transactions, config.receipt_concurrency, tx => receiptCall('eth_getTransactionReceipt', [tx.hash]));
      if (rows.some(row => row === null)) throw coded('receipt_error');
    }
    if (!store.isCanonical(block.hash)) return;
    observe('receipts', block.hash, primary, { number: block.number, receipt_count: rows.length }, delivery);
    if (fatal) throw fatal;
    try { store.putReceipts(block.hash, rows, meta(primary, delivery)); } catch (error) { if (error.code === 'STORAGE_LIMIT' || error.code === 'STORE_CLOSED') { fatal = coded('storage_error'); controller.abort(); throw fatal; } throw coded('receipt_error'); }
    observe('receipts_durable', block.hash, primary, { number: block.number, receipt_count: rows.length }, delivery);
    blockReceiptsSupported ??= true;
    status.receipt_blocks_committed++; receiptAttempts.delete(block.hash); primaryWake.wake();
  }

  async function receiptLoop() {
    while (!controller.signal.aborted) {
      // Parallel block enrichment and transaction fallback share one bounded receipt RPC semaphore.
      const blocks = store.pendingReceipts(config.max_pending_receipt_blocks + 1);
      const now = Date.now();
      const eligible = blocks.filter(b => (receiptAttempts.get(b.hash)?.next ?? 0) <= now);
      if (!eligible.length) { await receiptWake.wait(Math.min(config.poll_ms, 250), controller.signal); continue; }
      await mapLimit(eligible, config.receipt_concurrency, async block => {
        if (controller.signal.aborted) return;
        try { await fetchReceipts(block); }
        catch (error) {
          if (controller.signal.aborted) return;
          const attempts = (receiptAttempts.get(block.hash)?.attempts ?? 0) + 1;
          receiptAttempts.set(block.hash, { attempts, next: Date.now() + Math.min(30000, config.poll_ms * 2 ** Math.min(attempts, 8)) });
          failure('receipt', primary, error, block.hash);
        }
      });
      for (const hash of receiptAttempts.keys()) if (!store.isCanonical(hash)) receiptAttempts.delete(hash);
    }
  }

  async function compareSecondary(source) {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const head = await call(source, 'eth_getBlockByNumber', ['latest', false]);
        validHead(head); observe('head', head.hash, source, { number: head.number }); health(source, head);
        const raw = await call(source, 'eth_getBlockByNumber', [head.number, true]);
        if (!raw || raw.hash !== head.hash || !Array.isArray(raw.transactions)) throw coded('invalid_block');
        observe('block', raw.hash, source, { number: raw.number, transaction_count: raw.transactions.length });
        status.source_states[source.name] = 'observation_only'; failures = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        failure('comparison', source, error); status.source_states[source.name] = 'degraded'; failures++;
      }
      try { await abortWait(Math.min(30000, config.poll_ms * 2 ** Math.min(failures, 6)), controller.signal); } catch { break; }
    }
  }

  async function websocketLoop(source) {
    if (!source.ws_env || !WebSocketImpl) return;
    let url;
    try { url = endpoint(source, 'ws_env'); } catch { status.source_states[`${source.name}_ws`] = 'unavailable'; return; }
    let attempt = 0;
    while (!controller.signal.aborted) {
      await new Promise(resolve => {
        let socket; let watchdog; let ended = false;
        const done = () => {
          if (ended) return; ended = true; clearTimeout(watchdog); controller.signal.removeEventListener('abort', done);
          try { socket?.close(); } catch {} resolve();
        };
        const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(done, Math.max(config.request_timeout_ms, config.poll_ms * 4)); };
        try { socket = new WebSocketImpl(url); } catch { done(); return; }
        controller.signal.addEventListener('abort', done, { once: true }); arm();
        socket.addEventListener('open', () => { try { socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })); } catch { done(); } });
        socket.addEventListener('message', event => {
          if (ended) return;
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > config.max_response_bytes) { done(); return; }
          let data;
          try { data = JSON.parse(event.data); } catch { done(); return; }
          if (data.error) { done(); return; }
          if (data.method !== 'eth_subscription') return;
          try {
            const head = data.params?.result; validHead(head); arm(); attempt = 0;
            observe('head', head.hash, source, { number: head.number, transport: 'websocket' }); status.websocket_heads++;
            // A push is only a wakeup; primary HTTP reconciliation decides canonical blocks.
            if (source.name === primary.name) primaryWake.wake();
          } catch { done(); }
        });
        socket.addEventListener('close', done); socket.addEventListener('error', done);
      });
      if (controller.signal.aborted) break;
      status.websocket_reconnects++; attempt++;
      try { await abortWait(Math.min(30000, config.poll_ms * 2 ** Math.min(attempt, 6)), controller.signal); } catch { break; }
    }
  }

  async function reconcileFork(head) {
    const coverage = progress();
    if (coverage.canonical_head === null) return;
    const headNumber = validHead(head);
    let checkAt = Math.min(coverage.canonical_head, headNumber);
    if (checkAt < config.from_block) return;
    let retained = store.block(checkAt);
    if (!retained) {
      if (coverage.contiguous_block_head === null || coverage.contiguous_block_head > headNumber) return;
      checkAt = coverage.contiguous_block_head; retained = store.block(checkAt);
    }
    const current = checkAt === headNumber ? head : await call(primary, 'eth_getBlockByNumber', [quantity(checkAt), false]);
    if (!current || validHead(current) !== checkAt) throw coded('invalid_head');
    if (retained?.hash === current.hash) return;
    const floor = Math.max(config.from_block, coverage.canonical_head - config.reorg_depth);
    let earliestRetained = checkAt;
    for (let n = checkAt - 1; n >= floor; n--) {
      const old = store.block(n);
      if (!old) continue;
      earliestRetained = n;
      const candidate = await call(primary, 'eth_getBlockByNumber', [quantity(n), false]);
      if (!candidate || validHead(candidate) !== n) throw coded('invalid_head');
      if (old.hash === candidate.hash) {
        store.rewind(n + 1, 'primary_hash_changed'); status.reorgs++; return;
      }
    }
    // A disconnected live tail has no accepted link to the contiguous history.
    // Drop its bounded observed suffix and refetch; this does not claim the missing ancestry was verified.
    if (earliestRetained > config.from_block && !store.block(earliestRetained - 1) && coverage.canonical_head - earliestRetained + 1 <= config.reorg_depth) {
      store.rewind(earliestRetained, 'primary_disconnected_tail_changed'); status.reorgs++; return;
    }
    // The explicit start has no retained parent. Permit a bounded replacement of that entire window.
    if (floor === config.from_block && coverage.canonical_head - config.from_block + 1 <= config.reorg_depth) {
      store.rewind(config.from_block, 'primary_hash_changed_at_start'); status.reorgs++; return;
    }
    throw coded('reorg_depth_exceeded');
  }

  try {
    // Only the primary gates capture startup. Secondary health never delays or authorizes canonical writes.
    const chain = blockNumber(await call(primary, 'eth_chainId', []));
    if (chain !== config.chain_id) throw coded('wrong_chain');
    status.source_states[primary.name] = 'canonical_primary';
    background.push(inspectSync(primary));
    background.push(receiptLoop().catch(error => { fatal = coded(safeCode(error)); controller.abort(); }));
    background.push(websocketLoop(primary));
    for (const source of config.sources.filter(s => s !== primary)) background.push((async () => {
      try {
        const sourceChain = blockNumber(await call(source, 'eth_chainId', []));
        if (sourceChain !== config.chain_id) { status.source_states[source.name] = 'wrong_chain'; return; }
        await Promise.all([compareSecondary(source), websocketLoop(source), inspectSync(source)]);
      } catch (error) { if (!controller.signal.aborted) { failure('source', source, error); status.source_states[source.name] = 'unavailable'; } }
    })());
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const head = await call(primary, 'eth_getBlockByNumber', ['latest', false]);
        const headNumber = validHead(head); observe('head', head.hash, primary, { number: head.number }); health(primary, head);
        status.last_primary_head = { number: headNumber, hash: head.hash, observed_at: new Date().toISOString() };
        if (fatal) throw fatal;
        await reconcileFork(head);
        const coverage = progress();
        const next = coverage.contiguous_block_head === null ? config.from_block : coverage.contiguous_block_head + 1;
        const remaining = config.max_pending_receipt_blocks - coverage.pending_receipt_blocks;
        if (remaining <= 0) { status.backlog_pauses++; status.source_states[primary.name] = 'receipt_backlog_paused'; }
        const needsTail = headNumber - next >= config.max_blocks_per_round && remaining > 1 && !store.block(headNumber);
        const count = Math.max(0, Math.min(config.max_blocks_per_round, remaining - (needsTail ? 1 : 0), headNumber - next + 1));
        const numbers = Array.from({ length: count }, (_, i) => next + i);
        const fetchBlock = async (number, delivery = number < headNumber ? 'backfill' : 'live') => {
          const raw = await call(primary, 'eth_getBlockByNumber', [quantity(number), true]);
          if (!raw || validHead(raw) !== number || !Array.isArray(raw.transactions) || raw.transactions.some(tx => typeof tx !== 'object' || tx === null)) throw coded('invalid_block');
          observe('block', raw.hash, primary, { number: raw.number, transaction_count: raw.transactions.length }, delivery);
          return raw;
        };
        // Sliding concurrent fetches, ordered immediate commits: a later slow block cannot delay earlier durable blocks.
        const commit = (raw, delivery = blockNumber(raw.number) < headNumber ? 'backfill' : 'live') => {
          const n = blockNumber(raw.number); const previous = n > config.from_block ? store.block(n - 1) : null;
          if (previous && raw.parentHash !== previous.hash) throw coded('block_chain_changed');
          let saved;
          try { saved = store.putBlock(raw, meta(primary, delivery)); } catch { throw coded('storage_error'); }
          observe('block_durable', raw.hash, primary, { number: raw.number, transaction_count: raw.transactions.length }, delivery);
          if (saved?.inserted !== false) { status.blocks_committed++; status.transactions_committed += raw.transactions.length; }
          receiptWake.wake();
        };
        // Reserve one bounded request slot for the latest block during history recovery.
        // Disconnected live data remains visibly outside contiguous coverage until backfill connects it.
        let tailError;
        const tail = needsTail ? fetchBlock(headNumber, 'live').then(raw => { if (!controller.signal.aborted) commit(raw, 'live'); }, error => { tailError = error; }).catch(error => { tailError = error; }) : Promise.resolve();
        if (needsTail && config.block_concurrency === 1) await tail;
        const backfillConcurrency = needsTail && config.block_concurrency > 1 ? config.block_concurrency - 1 : config.block_concurrency;
        const inflight = new Map(); let launched = 0; let committed = 0;
        const launch = () => {
          while (launched < numbers.length && inflight.size < backfillConcurrency) {
            const number = numbers[launched++];
            inflight.set(number, fetchBlock(number).then(raw => ({ raw }), error => ({ error })));
          }
        };
        try {
          launch();
          for (const number of numbers) {
            const { raw, error } = await inflight.get(number); inflight.delete(number);
            if (error) throw error;
            if (controller.signal.aborted) break;
            commit(raw); committed++; launch();
          }
        } finally { await Promise.allSettled([...inflight.values(), tail]); }
        if (tailError) throw tailError;
        if (committed) status.source_states[primary.name] = 'canonical_primary';
        failures = 0;
        // Drain historical catch-up without an artificial poll delay.
        if (count > 0 && next + count <= headNumber) continue;
      } catch (error) {
        if (controller.signal.aborted) break;
        failure('capture', primary, error);
        if (['wrong_chain', 'reorg_depth_exceeded', 'storage_error'].includes(error.code)) { fatal = error; break; }
        status.source_states[primary.name] = 'degraded'; failures++;
      }
      await primaryWake.wait(Math.min(30000, config.poll_ms * 2 ** Math.min(failures, 6)), controller.signal);
    }
  } catch (error) { if (!controller.signal.aborted) { fatal = error; failure('capture', primary, error); } }
  finally {
    controller.abort(); primaryWake.wake(); receiptWake.wake(); clearTimeout(timeout);
    await Promise.allSettled(background); signal?.removeEventListener('abort', abort);
  }
  if (fatal) status.reason = safeCode(fatal);
  else if (status.reason === 'stopped' && signal?.aborted) status.reason = 'aborted';
  status.elapsed_ms = Date.now() - started;
  status.block_receipts_support = blockReceiptsSupported === undefined ? 'unverified' : blockReceiptsSupported ? 'observed_supported' : 'unsupported_fallback';
  status.coverage = store.coverage();
  status.caught_up_to_observed_primary = Boolean(status.last_primary_head && status.coverage.contiguous_block_head !== null && status.coverage.contiguous_block_head >= status.last_primary_head.number);
  status.degraded = Boolean(fatal || status.coverage.pending_receipt_blocks || Object.values(status.source_states).some(s => ['degraded', 'unavailable', 'wrong_chain', 'receipt_backlog_paused'].includes(s)));
  return status;
}
