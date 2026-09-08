/** Exact-state, read-only route observations. RPC consistency is not source authenticity. */
import { validateBuilt, ZERO } from './routes.mjs';
import { digestValue } from './simulation.mjs';
import { keccakHex } from './keccak.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const MAX_REPORT_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_TRANSCRIPT_BYTES = 786_432;
const MAX_CALLS = 64;
const METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_call']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const assert = (x, m) => { if (!x) throw new TypeError(m); };
const hex = x => '0x' + BigInt(x).toString(16);
const addressWord = x => x.slice(2).padStart(64, '0');
const selector = signature => keccakHex(Buffer.from(signature)).slice(0, 10);
const same = (a, b) => digestValue(a) === digestValue(b);

function boundedJSON(value, maxBytes) {
  let nodes = 0;
  function visit(v, depth) {
    if (++nodes > 20_000 || depth > 32) throw new Error('STRUCTURAL_LIMIT');
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v === 'string') { if (v.length > maxBytes) throw new Error('BYTE_LIMIT'); return; }
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    if (object(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      for (const [key, item] of Object.entries(v)) { if (key.length > 512) throw new Error('KEY_LIMIT'); visit(item, depth + 1); }
      return;
    }
    throw new Error('NOT_JSON');
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error('BYTE_LIMIT');
  return JSON.parse(encoded);
}

class ObservationError extends Error {
  constructor(error) { super(error.kind); this.observation = error; }
}

function sanitizeError(e) {
  if (e instanceof ObservationError) return e.observation;
  const code = Number.isSafeInteger(e?.code) ? e.code : null;
  const message = typeof e?.message === 'string' ? e.message : '';
  const kind = code === 3 || /execution reverted/i.test(message) ? 'REVERT'
    : [-32601, -32602, -32004].includes(code) || /unsupported|not supported|method not found/i.test(message) ? 'UNSUPPORTED'
      : /timed out|timeout/i.test(message) ? 'TIMEOUT' : 'RPC_ERROR';
  return {kind, code, revert_data: typeof e?.data === 'string' && BYTES.test(e.data) && e.data.length <= 8194 ? e.data.toLowerCase() : null};
}

function participants(route) {
  const out = new Map();
  const add = (address, role) => {
    if (address === ZERO) return;
    if (!out.has(address)) out.set(address, []);
    if (!out.get(address).includes(role)) out.get(address).push(role);
  };
  add(route.router, 'router'); add(route.pool_manager, 'pool_manager'); add(route.permit2, 'permit2'); add(route.wallet, 'wallet');
  add(route.currency_in, 'token');
  for (const hop of route.hops) { add(hop.currency_out, 'token'); add(hop.pool_key.hooks, 'hook'); }
  return [...out].map(([address, roles]) => ({address, roles}));
}

function expectedHashes(value, addresses) {
  assert(object(value) && Object.keys(value).length <= 16, 'expected_code_hashes must contain at most 16 participants');
  const normalized = {};
  for (const [address, hash] of Object.entries(value)) {
    assert(ADDRESS.test(address) && HASH.test(hash), 'Expected code hashes require address keys and 32-byte hashes');
    const key = address.toLowerCase();
    assert(addresses.has(key) && !Object.hasOwn(normalized, key), 'Expected code address must be a unique route participant');
    normalized[key] = hash.toLowerCase();
  }
  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

function quantity(value) {
  assert(typeof value === 'string' && value.length <= 66 && QUANTITY.test(value), 'Noncanonical RPC quantity');
  return BigInt(value);
}

function safeQuantity(value) {
  const n = quantity(value); assert(n <= BigInt(Number.MAX_SAFE_INTEGER), 'RPC quantity exceeds safe block range'); return Number(n);
}

function word(value, bits = 256) {
  assert(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), 'Expected exactly one ABI word');
  const n = BigInt(value); assert(n < (1n << BigInt(bits)), 'ABI word exceeds declared width'); return n;
}

function headerMatches(value, block) {
  try {
    return object(value) && HASH.test(value.hash) && value.hash.toLowerCase() === block.hash && safeQuantity(value.number) === block.number && safeQuantity(value.timestamp) === block.timestamp;
  } catch { return false; }
}

/** Observes existing balances/approvals only. Does not approve, permit, sign, send, or fund. */
export async function collectPreflight(input, options) {
  const built = validateBuilt(input), route = built.route;
  assert(object(options) && Object.keys(options).every(k => ['rpc', 'expected_code_hashes'].includes(k)) && typeof options.rpc === 'function', 'Expected an injected read-only rpc function');
  const addresses = participants(route);
  const expected = expectedHashes(options.expected_code_hashes ?? {}, new Set(addresses.map(x => x.address)));
  const report = {
    schema_version: 'circuit.preflight.v1', route_digest: built.route_digest, build_digest: built.build_digest,
    chain_id: route.chain_id, block: structuredClone(route.block), wallet_context: route.wallet_context,
    status: 'INCOMPLETE', source_mapping: 'UNVERIFIED', expected_code_hashes: expected,
    head_number: null, head_lag_blocks: null, canonical_start: false, canonical_end: false,
    code_hashes: [], balances: [], native_balance: null,
    router_wiring: {pool_manager_expected: route.pool_manager, pool_manager_observed: null, pool_manager_matches: null, permit2_expected: route.permit2, permit2_correspondence: 'UNVERIFIED_INTERNAL_IMMUTABLE'},
    approvals: route.currency_in === ZERO ? {status: 'NOT_REQUIRED_NATIVE_INPUT'} : {status: 'UNOBSERVED', token: route.currency_in, owner: route.wallet, spender: route.router, permit2: route.permit2, required_raw: route.amount_in, required_expiration: route.deadline, token_allowance_raw: null, permit2_amount_raw: null, permit2_expiration: null, permit2_nonce: null},
    issues: [], observations: [],
    limits: {maximum_rpc_calls: MAX_CALLS, maximum_response_bytes: MAX_RESPONSE_BYTES, maximum_report_bytes: MAX_REPORT_BYTES},
    limitations: [
      'Observed code hashes and caller-supplied matches do not prove source-to-runtime correspondence.',
      'The router exposes poolManager() but its internal Permit2 immutable has no getter; observing a supplied Permit2 address does not prove router wiring.',
      'No liquidity quote, hook permission conclusion, gas-affordability estimate, or profitability claim follows from preflight.',
      'Head lag is a separate observation; all state reads use the exact pinned block hash with requireCanonical=true.',
      'Retained transcript validation establishes internal consistency, not RPC authenticity or future execution.'
    ]
  };
  const pin = {blockHash: route.block.hash, requireCanonical: true};
  const issue = (code, severity, address) => { report.issues.push({code, severity, ...(address ? {address} : {})}); };
  let transcriptBytes = 0, finished = false;
  const started = Date.now();
  async function read(method, params) {
    assert(METHODS.has(method), 'RPC method outside preflight allowlist');
    if (report.observations.length >= MAX_CALLS) throw new ObservationError({kind: 'CALL_LIMIT', code: null, revert_data: null});
    let result, error, timer;
    try {
      const available = Math.min(12_000, 90_000 - (Date.now() - started));
      if (available <= 0) throw new ObservationError({kind: 'TIMEOUT', code: null, revert_data: null});
      result = await Promise.race([
        Promise.resolve().then(() => options.rpc(method, structuredClone(params))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new ObservationError({kind: 'TIMEOUT', code: null, revert_data: null})), available); })
      ]);
      try { result = boundedJSON(result, MAX_RESPONSE_BYTES); }
      catch { throw new ObservationError({kind: 'RESPONSE_LIMIT_OR_INVALID_JSON', code: null, revert_data: null}); }
      const bytes = Buffer.byteLength(JSON.stringify({method, params, result}));
      if (transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) throw new ObservationError({kind: 'TRANSCRIPT_LIMIT', code: null, revert_data: null});
      transcriptBytes += bytes;
    } catch (e) { error = sanitizeError(e); }
    finally { if (timer) clearTimeout(timer); }
    const observation = {method, params: structuredClone(params), ...(error ? {error} : {result})};
    report.observations.push(observation);
    if (error) throw new ObservationError(error);
    return result;
  }
  async function call(to, data) { return read('eth_call', [{from: route.wallet, to, data}, pin]); }
  try {
    const chain = await read('eth_chainId', []);
    if (quantity(chain) !== 4663n) { issue('CHAIN_ID_MISMATCH', 'BLOCKED'); throw new Error('STOP'); }
    report.canonical_start = headerMatches(await read('eth_getBlockByNumber', [hex(route.block.number), false]), route.block);
    if (!report.canonical_start) { issue('PINNED_HEADER_MISMATCH', 'BLOCKED'); throw new Error('STOP'); }
    report.head_number = safeQuantity(await read('eth_blockNumber', []));
    report.head_lag_blocks = report.head_number - route.block.number;
    if (report.head_lag_blocks < 0) issue('HEAD_BEHIND_PINNED_BLOCK', 'BLOCKED');
    for (const participant of addresses) {
      const code = await read('eth_getCode', [participant.address, pin]);
      if (typeof code !== 'string' || !BYTES.test(code)) { issue('MALFORMED_CODE_RESPONSE', 'INCOMPLETE', participant.address); throw new Error('STOP'); }
      const hash = keccakHex(Buffer.from(code.slice(2), 'hex'));
      const match = Object.hasOwn(expected, participant.address) ? hash === expected[participant.address] : null;
      report.code_hashes.push({...participant, bytes: (code.length - 2) / 2, keccak256: hash, expected_keccak256: expected[participant.address] ?? null, expected_hash_matches: match});
      if (participant.roles.includes('wallet') && code !== '0x') issue('WALLET_HAS_CODE_UNSUPPORTED', 'BLOCKED', participant.address);
      if (participant.roles.some(role => role !== 'wallet') && code === '0x') issue('REQUIRED_CONTRACT_CODE_MISSING', 'BLOCKED', participant.address);
      if (match === false) issue('EXPECTED_CODE_HASH_MISMATCH', 'BLOCKED', participant.address);
    }
    const managerWord = word(await call(route.router, selector('poolManager()')), 160);
    report.router_wiring.pool_manager_observed = '0x' + managerWord.toString(16).padStart(40, '0');
    report.router_wiring.pool_manager_matches = report.router_wiring.pool_manager_observed === route.pool_manager;
    if (!report.router_wiring.pool_manager_matches) issue('ROUTER_POOL_MANAGER_MISMATCH', 'BLOCKED', route.router);
    const native = quantity(await read('eth_getBalance', [route.wallet, pin]));
    report.native_balance = {owner: route.wallet, raw: native.toString(), transaction_value_raw: BigInt(built.transaction.value).toString(), covers_transaction_value: native >= BigInt(built.transaction.value), gas_affordability: 'UNMEASURED'};
    if (!report.native_balance.covers_transaction_value) issue('INSUFFICIENT_NATIVE_VALUE_BALANCE', 'BLOCKED', route.wallet);
    for (const pair of built.call_request.balance_tokens) {
      const raw = word(await call(pair.address, selector('balanceOf(address)') + addressWord(pair.owner)));
      report.balances.push({token: pair.address, owner: pair.owner, raw: raw.toString()});
      if (pair.address === route.currency_in && pair.owner === route.wallet && raw < BigInt(route.amount_in)) issue('INSUFFICIENT_INPUT_TOKEN_BALANCE', 'BLOCKED', route.currency_in);
    }
    if (route.currency_in !== ZERO) {
      const approval = report.approvals;
      const tokenAllowance = word(await call(route.currency_in, selector('allowance(address,address)') + addressWord(route.wallet) + addressWord(route.permit2)));
      const allowanceWords = await call(route.permit2, selector('allowance(address,address,address)') + addressWord(route.wallet) + addressWord(route.currency_in) + addressWord(route.router));
      assert(typeof allowanceWords === 'string' && /^0x[0-9a-fA-F]{192}$/.test(allowanceWords), 'Permit2 allowance must contain exactly three ABI words');
      const amount = word('0x' + allowanceWords.slice(2, 66), 160), expiration = word('0x' + allowanceWords.slice(66, 130), 48), nonce = word('0x' + allowanceWords.slice(130, 194), 48);
      Object.assign(approval, {token_allowance_raw: tokenAllowance.toString(), permit2_amount_raw: amount.toString(), permit2_expiration: expiration.toString(), permit2_nonce: nonce.toString(), status: 'OBSERVED'});
      if (tokenAllowance < BigInt(route.amount_in)) issue('INSUFFICIENT_TOKEN_TO_PERMIT2_ALLOWANCE', 'BLOCKED', route.currency_in);
      if (amount < BigInt(route.amount_in)) issue('INSUFFICIENT_PERMIT2_TO_ROUTER_ALLOWANCE', 'BLOCKED', route.permit2);
      if (expiration < BigInt(route.deadline)) issue('PERMIT2_EXPIRATION_BEFORE_ROUTE_DEADLINE', 'BLOCKED', route.permit2);
    }
    finished = true;
  } catch (e) {
    if (e instanceof ObservationError) issue('RPC_' + e.observation.kind, 'INCOMPLETE');
    else if (e?.message !== 'STOP') issue('NONSTANDARD_OR_MALFORMED_RESPONSE', 'INCOMPLETE');
  } finally {
    if (report.canonical_start) {
      try {
        report.canonical_end = headerMatches(await read('eth_getBlockByNumber', [hex(route.block.number), false]), route.block);
        if (!report.canonical_end) issue('PINNED_HEADER_CHANGED', 'BLOCKED');
      } catch (e) { issue(e instanceof ObservationError ? 'CANONICAL_RECHECK_' + e.observation.kind : 'CANONICAL_RECHECK_FAILED', 'INCOMPLETE'); }
    }
  }
  report.status = report.issues.some(x => x.severity === 'INCOMPLETE') ? 'INCOMPLETE'
    : report.issues.some(x => x.severity === 'BLOCKED') ? 'PREFLIGHT_BLOCKED'
      : finished && report.canonical_start && report.canonical_end ? 'PREFLIGHT_OBSERVED' : 'INCOMPLETE';
  report.evidence_digest = digestValue(report);
  return boundedJSON(report, MAX_REPORT_BYTES);
}

/** Replays every retained read; no network access. Does not authenticate the RPC provider. */
export async function validatePreflight(built, input) {
  const report = boundedJSON(input, MAX_REPORT_BYTES);
  assert(report.schema_version === 'circuit.preflight.v1' && Array.isArray(report.observations) && report.observations.length <= MAX_CALLS, 'Invalid preflight report');
  const unsigned = {...report}; delete unsigned.evidence_digest;
  assert(HASH.test(report.evidence_digest) && digestValue(unsigned) === report.evidence_digest, 'Preflight evidence digest mismatch');
  let cursor = 0;
  const replayed = await collectPreflight(built, {expected_code_hashes: report.expected_code_hashes, rpc: async (method, params) => {
    const entry = report.observations[cursor++];
    assert(object(entry) && same({method: entry.method, params: entry.params}, {method, params}), 'Preflight transcript request mismatch');
    assert(Object.hasOwn(entry, 'result') !== Object.hasOwn(entry, 'error'), 'Preflight observation must contain exactly one result or error');
    if (Object.hasOwn(entry, 'error')) {
      const e = entry.error;
      assert(object(e) && Object.keys(e).length === 3 && ['REVERT', 'UNSUPPORTED', 'TIMEOUT', 'RPC_ERROR', 'RESPONSE_LIMIT_OR_INVALID_JSON', 'TRANSCRIPT_LIMIT', 'CALL_LIMIT'].includes(e.kind) && (e.code === null || Number.isSafeInteger(e.code)) && (e.revert_data === null || (typeof e.revert_data === 'string' && BYTES.test(e.revert_data) && e.revert_data.length <= 8194)), 'Invalid retained RPC error');
      throw new ObservationError(e);
    }
    return entry.result;
  }});
  assert(cursor === report.observations.length && same(replayed, report), 'Preflight replay or derived findings mismatch');
  return replayed;
}
