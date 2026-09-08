/** Pinned, read-only EVM call evidence. No signing, sending or state overrides. */
import { createHash } from 'node:crypto';
import { keccakHex } from './keccak.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DIGEST = /^(?:0x[0-9a-fA-F]{64}|sha256:[0-9a-f]{64})$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const ALLOWED_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_call', 'debug_traceCall']);
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TRACE_DEPTH = 48;
const MAX_TRACE_NODES = 10000;
const ZERO = '0x' + '0'.repeat(40);
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assert = (condition, message) => { if (!condition) throw new TypeError(message); };

function keys(value, required, optional, label) {
  assert(object(value), `${label} must be an object`);
  assert(required.every(key => Object.hasOwn(value, key)), `${label} is missing required fields`);
  assert(Object.keys(value).every(key => [...required, ...optional].includes(key)), `${label} contains unsupported fields`);
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  throw new TypeError('Digest input must be finite JSON');
}

export const digestValue = value => keccakHex(Buffer.from(canonical(value)));

export function validateCallRequest(request) {
  keys(request, ['schema_version', 'chain_id', 'block', 'transaction', 'balance_tokens', 'context'], ['expectations'], 'request');
  assert(request.schema_version === 'hook-lab.call.v1', 'Unsupported call schema');
  assert(request.chain_id === 4663, 'Only Robinhood Chain 4663 is supported');
  keys(request.block, ['number', 'hash'], [], 'block');
  assert(Number.isSafeInteger(request.block.number) && request.block.number >= 0, 'block.number must be a nonnegative safe integer');
  assert(HASH.test(request.block.hash), 'block.hash must be 32-byte hex');
  const tx = request.transaction;
  keys(tx, ['from', 'to', 'data', 'value', 'gas'], [], 'transaction');
  assert(ADDRESS.test(tx.from) && ADDRESS.test(tx.to), 'Transaction addresses must be 20-byte hex');
  assert(!/^0x0{40}$/i.test(tx.from) && !/^0x0{40}$/i.test(tx.to), 'Transaction addresses must be nonzero');
  assert(BYTES.test(tx.data) && tx.data.length <= 131074, 'Calldata must be at most 65536 bytes');
  assert(QUANTITY.test(tx.value) && BigInt(tx.value) < 2n ** 256n, 'value must be a uint256 RPC quantity');
  assert(QUANTITY.test(tx.gas) && BigInt(tx.gas) > 0n && BigInt(tx.gas) <= 100000000n, 'gas must be between 1 and 100000000');
  keys(request.context, ['identity_digest', 'route_id', 'source_mapping', 'wallet_context'], [], 'context');
  assert(DIGEST.test(request.context.identity_digest), 'identity_digest must be a 32-byte Keccak or sha256 digest');
  assert(typeof request.context.route_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.context.route_id), 'route_id must be a short machine identifier');
  assert(['verified', 'unverified'].includes(request.context.source_mapping), 'Unsupported source_mapping');
  assert(['actual', 'synthetic'].includes(request.context.wallet_context), 'Unsupported wallet_context');
  assert(Array.isArray(request.balance_tokens) && request.balance_tokens.length <= 16, 'balance_tokens must have at most 16 entries');
  const pairs = new Set();
  for (const pair of request.balance_tokens) {
    keys(pair, ['address', 'owner'], [], 'balance token');
    assert(ADDRESS.test(pair.address) && ADDRESS.test(pair.owner), 'Balance addresses must be 20-byte hex');
    assert(!eq(pair.address, ZERO) && !eq(pair.owner, ZERO), 'ERC20 balance token and owner must be nonzero');
    const key = pair.address.toLowerCase() + ':' + pair.owner.toLowerCase();
    assert(!pairs.has(key), 'Duplicate balance token and owner');
    pairs.add(key);
  }
  if (request.expectations !== undefined) {
    assert(Array.isArray(request.expectations) && request.expectations.length <= 32, 'expectations must have at most 32 entries');
    const seen = new Set();
    for (const entry of request.expectations) {
      keys(entry, ['token', 'owner', 'minimum_delta', 'maximum_delta'], [], 'expectation');
      assert(ADDRESS.test(entry.token) && ADDRESS.test(entry.owner), 'Expectation addresses must be 20-byte hex');
      assert(typeof entry.minimum_delta === 'string' && INTEGER.test(entry.minimum_delta) && entry.minimum_delta.length <= 79, 'minimum_delta must be a decimal integer');
      assert(typeof entry.maximum_delta === 'string' && INTEGER.test(entry.maximum_delta) && entry.maximum_delta.length <= 79, 'maximum_delta must be a decimal integer');
      assert(BigInt(entry.minimum_delta) <= BigInt(entry.maximum_delta), 'Expectation bounds are reversed');
      assert(BigInt(entry.minimum_delta) > -(2n ** 256n) && BigInt(entry.maximum_delta) < 2n ** 256n, 'Expectation exceeds ERC20 balance delta bounds');
      const key = entry.token.toLowerCase() + ':' + entry.owner.toLowerCase();
      const trackedNativeOwner = eq(entry.token, ZERO) && (eq(entry.owner, tx.from) || request.balance_tokens.some(pair => eq(pair.owner, entry.owner)));
      assert(pairs.has(key) || trackedNativeOwner, 'Expectation requires a matching observed token and owner, or a tracked native owner');
      assert(!seen.has(key), 'Duplicate expectation');
      seen.add(key);
    }
  }
  return structuredClone(request);
}

function sanitizedError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = Number.isInteger(error?.code) ? error.code : null;
  const kind = code === 3 || /execution reverted|vm execution error.*revert/i.test(message) ? 'REVERT'
    : [-32601, -32602, -32004].includes(code) || /not supported|unsupported|method not found|tracer.*not found/i.test(message) ? 'UNSUPPORTED'
      : /timeout|timed out/i.test(message) ? 'TIMEOUT' : 'RPC_ERROR';
  const data = typeof error?.data === 'string' && BYTES.test(error.data) && error.data.length <= 8194 ? error.data : null;
  // Provider text can contain API keys or URLs; preserve only a controlled classification and hex revert bytes.
  return { kind, code, revert_data: data };
}

function bounded(value) {
  let nodes = 0;
  function visit(v, depth) {
    if (++nodes > MAX_TRACE_NODES || depth > MAX_TRACE_DEPTH) throw new Error('STRUCTURAL_LIMIT');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (object(v)) { for (const x of Object.values(v)) visit(x, depth + 1); return; }
    throw new Error('NOT_JSON');
  }
  try {
    visit(value, 0);
    const encoded = JSON.stringify(value);
    const bytes = Buffer.byteLength(encoded);
    const sha256 = createHash('sha256').update(encoded).digest('hex');
    return bytes <= MAX_RESPONSE_BYTES
      ? { retained: true, bytes, sha256, value: structuredClone(value) }
      : { retained: false, bytes, sha256, reason: 'BYTE_LIMIT' };
  } catch {
    return { retained: false, bytes: null, sha256: null, reason: 'STRUCTURAL_LIMIT_OR_INVALID_JSON' };
  }
}

function validHeader(header, block) {
  return object(header) && QUANTITY.test(header.number) && BigInt(header.number) === BigInt(block.number) && eq(header.hash, block.hash);
}

/** rpc(method, params) is a read-only JSON-RPC transport returning the raw result. */
export async function simulateCall(input, { rpc } = {}) {
  const request = validateCallRequest(input);
  assert(typeof rpc === 'function', 'A read-only RPC function is required');
  const output = {
    schema_version: 'hook-lab.simulation.v1',
    request_digest: digestValue(request),
    status: 'INCOMPLETE',
    chain_id: request.chain_id,
    block: request.block,
    transaction: request.transaction,
    context: request.context,
    target_code_hash: null,
    call: { status: 'NOT_RUN', return_data: null, error: null },
    trace: { call: { status: 'NOT_RUN' }, state_diff: { status: 'NOT_RUN' } },
    native_balance_before: { owner: request.transaction.from, status: 'UNKNOWN', raw: null },
    token_balances_before: [],
    wallet_deltas: { status: 'UNKNOWN', rows: request.balance_tokens.map(pair => ({ token: pair.address, owner: pair.owner, delta: null })) },
    expectations: { status: request.expectations?.length ? 'UNVERIFIED' : 'NOT_REQUESTED', rows: request.expectations ?? [] },
    issues: [],
    transcript: [],
    limits: { max_response_bytes: MAX_RESPONSE_BYTES, max_trace_nodes: MAX_TRACE_NODES, max_trace_depth: MAX_TRACE_DEPTH },
    limitations: [
      'eth_call and debug_traceCall do not establish actual wallet token balance deltas.',
      'Return data, event logs and raw storage differences are not ERC20 balance accounting.',
      'Call success does not establish transaction inclusion, permissions in another caller context, profit, or continued support.',
      'Context and source_mapping are supplied claims and require independent identity and source verification.',
      'Native balances and balances returned by tokens are observations; no gas-inclusive execution cost is inferred.'
    ]
  };
  let seq = 0;
  async function read(method, params) {
    if (!ALLOWED_METHODS.has(method)) throw new TypeError('RPC method is not read-only allowlisted');
    const entry = { sequence: ++seq, method, params: structuredClone(params) };
    output.transcript.push(entry);
    try {
      const result = await rpc(method, structuredClone(params));
      const retained = bounded(result);
      entry.result = { retained: retained.retained, bytes: retained.bytes, sha256: retained.sha256, ...(retained.reason ? { reason: retained.reason } : {}), ...(retained.retained ? { value: retained.value } : {}) };
      if (!retained.retained) {
        output.issues.push(`${method}:RESPONSE_LIMIT`);
        return { ok: false, error: { kind: 'RESPONSE_LIMIT', code: null, revert_data: null } };
      }
      return { ok: true, value: retained.value };
    } catch (error) {
      entry.error = sanitizedError(error);
      return { ok: false, error: entry.error };
    }
  }
  function finish() {
    output.transcript.sort((a, b) => a.sequence - b.sequence);
    output.evidence_digest = digestValue(output);
    return output;
  }
  const chain = await read('eth_chainId', []);
  if (!chain.ok || !QUANTITY.test(chain.value) || BigInt(chain.value) !== 4663n) {
    output.issues.push('CHAIN_UNVERIFIED_OR_MISMATCH');
    return finish();
  }
  const numberTag = '0x' + request.block.number.toString(16);
  const pin = { blockHash: request.block.hash, requireCanonical: true };
  const first = await read('eth_getBlockByNumber', [numberTag, false]);
  if (!first.ok || !validHeader(first.value, request.block)) {
    output.status = 'BLOCK_INVALIDATED';
    output.issues.push('INITIAL_BLOCK_HASH_UNVERIFIED_OR_MISMATCH');
    return finish();
  }
  const code = await read('eth_getCode', [request.transaction.to, pin]);
  if (!code.ok || !BYTES.test(code.value) || code.value === '0x') {
    output.issues.push('TARGET_CODE_UNVERIFIED_OR_EMPTY');
  } else {
    output.target_code_hash = keccakHex(Buffer.from(code.value.slice(2), 'hex'));
    const [native, call] = await Promise.all([
      read('eth_getBalance', [request.transaction.from, pin]),
      read('eth_call', [request.transaction, pin])
    ]);
    if (native.ok && QUANTITY.test(native.value)) output.native_balance_before = { owner: request.transaction.from, status: 'OBSERVED_AT_BLOCK', raw: BigInt(native.value).toString() };
    else output.issues.push('NATIVE_BALANCE_UNAVAILABLE');
    if (call.ok && BYTES.test(call.value)) output.call = { status: 'SUCCEEDED', return_data: call.value, error: null };
    else if (!call.ok) output.call = { status: call.error.kind === 'REVERT' ? 'REVERTED' : 'UNAVAILABLE', return_data: null, error: call.error };
    else output.call = { status: 'INVALID_RESPONSE', return_data: null, error: null };
    for (const pair of request.balance_tokens) {
      const data = '0x70a08231' + pair.owner.slice(2).padStart(64, '0');
      const result = await read('eth_call', [{ from: request.transaction.from, to: pair.address, data }, pin]);
      const valid = result.ok && typeof result.value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result.value);
      output.token_balances_before.push({ token: pair.address, owner: pair.owner, status: valid ? 'OBSERVED_AT_BLOCK' : 'UNAVAILABLE', raw: valid ? BigInt(result.value).toString() : null, ...(result.error ? { error: result.error } : {}) });
      if (!valid) output.issues.push('TOKEN_BALANCE_UNAVAILABLE:' + pair.address.toLowerCase() + ':' + pair.owner.toLowerCase());
    }
    const traces = await Promise.all([
      read('debug_traceCall', [request.transaction, numberTag, { tracer: 'callTracer', timeout: '5s', tracerConfig: { onlyTopCall: false, withLog: true } }]),
      read('debug_traceCall', [request.transaction, numberTag, { tracer: 'prestateTracer', timeout: '5s', tracerConfig: { diffMode: true } }])
    ]);
    for (let i = 0; i < traces.length; i++) {
      const name = i === 0 ? 'call' : 'state_diff';
      const trace = traces[i];
      if (!trace.ok) {
        output.trace[name] = { status: 'UNAVAILABLE', error: trace.error };
        output.issues.push('TRACE_UNAVAILABLE:' + name);
        continue;
      }
      const valid = i === 0
        ? object(trace.value) && eq(trace.value.from, request.transaction.from) && eq(trace.value.to, request.transaction.to) && eq(trace.value.input, request.transaction.data)
        : object(trace.value) && object(trace.value.pre) && object(trace.value.post);
      if (!valid) {
        output.trace[name] = { status: 'INVALID_RESPONSE' };
        output.issues.push('TRACE_INVALID:' + name);
        continue;
      }
      output.trace[name] = { status: 'OBSERVED', value: trace.value };
      if (i === 0) {
        const errored = typeof trace.value.error === 'string' && trace.value.error.length > 0;
        if ((output.call.status === 'SUCCEEDED' && (errored || (trace.value.output !== undefined && !eq(trace.value.output, output.call.return_data)))) || (output.call.status === 'REVERTED' && !errored)) {
          output.issues.push('CALL_TRACE_DISAGREEMENT');
        }
      }
    }
  }
  const last = await read('eth_getBlockByNumber', [numberTag, false]);
  if (!last.ok || !validHeader(last.value, request.block)) {
    output.status = 'BLOCK_INVALIDATED';
    output.issues.push('FINAL_BLOCK_HASH_UNVERIFIED_OR_MISMATCH');
  } else if (output.issues.includes('CALL_TRACE_DISAGREEMENT')) {
    output.status = 'INCOMPLETE';
  } else if (output.call.status === 'SUCCEEDED') output.status = 'CALL_SUCCEEDED_AT_BLOCK';
  else if (output.call.status === 'REVERTED') output.status = 'CALL_REVERTED_AT_BLOCK';
  return finish();
}
