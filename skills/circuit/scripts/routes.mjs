/** Exact-input candidate construction for the pinned UniversalRouter 2.1.1 V4 ABI. */
import { abiEncode, encodeUniversalV4 } from './abi.mjs';
import { keccakHex } from './keccak.mjs';
import { digestValue, validateCallRequest } from './simulation.mjs';

export const ZERO = '0x' + '0'.repeat(40);
export const ADAPTER = 'universal-router-2.1.1-v4';
export const SOURCE_PINS = Object.freeze({
  universal_router: '999d561c3ad58fb5cab91b602911f3c75591a9c7',
  v4_periphery: '3231810e39b8c4d569b9d66907fa4ef8cd2cec22'
});
const assert = (condition, message) => { if (!condition) throw new TypeError(message); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
function boundedJson(value) {
  let count = 0, bytes = 0;
  const ancestors = new Set();
  function walk(item, depth) {
    assert(++count <= 10000 && depth <= 20, 'Built candidate exceeds structural limits');
    if (typeof item === 'string') bytes += Buffer.byteLength(item);
    else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) bytes += 32;
    else {
      assert(Array.isArray(item) || object(item), 'Built candidate must contain finite JSON');
      assert(!ancestors.has(item), 'Built candidate must not be cyclic');
      ancestors.add(item);
      for (const [key, child] of Object.entries(item)) { bytes += Buffer.byteLength(key); walk(child, depth + 1); }
      ancestors.delete(item);
    }
    assert(bytes <= 1048576, 'Built candidate exceeds one MiB');
  }
  walk(value, 0);
}
function keys(x, required, label) {
  assert(object(x) && Object.keys(x).length === required.length && required.every(k => Object.hasOwn(x, k)), `${label} has missing or unsupported fields`);
}
function address(x, label, nonzero = false) {
  assert(typeof x === 'string' && ADDRESS.test(x), `${label} must be a 20-byte address`);
  const normalized = x.toLowerCase();
  assert(!nonzero || normalized !== ZERO, `${label} must be nonzero`);
  return normalized;
}
function boundedInt(x, lower, upper, label) {
  assert(Number.isSafeInteger(x) && x >= lower && x <= upper, `${label} outside integer bounds`);
  return x;
}
function decimal(x, lower, upper, label) {
  assert(typeof x === 'string' && x.length <= 78 && /^(?:0|[1-9][0-9]*)$/.test(x), `${label} must be a canonical decimal string`);
  assert(BigInt(x) >= lower && BigInt(x) <= upper, `${label} outside integer bounds`);
  return x;
}
function hookData(x) {
  assert(typeof x === 'string' && x.length <= 8194 && /^0x(?:[a-fA-F0-9]{2})*$/.test(x), 'hook_data must be even hex of at most 4096 bytes');
  return x.toLowerCase();
}
function poolKey(key) {
  keys(key, ['currency0', 'currency1', 'fee', 'tick_spacing', 'hooks'], 'pool_key');
  const currency0 = address(key.currency0, 'currency0'), currency1 = address(key.currency1, 'currency1');
  assert(currency0 < currency1, 'Pool currencies must be distinct and sorted');
  const fee = boundedInt(key.fee, 0, 0xffffff, 'fee');
  assert(fee <= 1000000 || fee === 0x800000, 'fee must be <=1000000 or the dynamic flag alone');
  return { currency0, currency1, fee, tick_spacing: boundedInt(key.tick_spacing, 1, 32767, 'tick_spacing'), hooks: address(key.hooks, 'hooks') };
}
export function poolId(key) {
  const k = poolKey(key);
  return keccakHex(Buffer.from(abiEncode(['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tick_spacing, k.hooks]).slice(2), 'hex'));
}

function normalize(input) {
  keys(input, ['schema_version', 'adapter', 'chain_id', 'block', 'router', 'pool_manager', 'permit2', 'wallet', 'recipient', 'wallet_context', 'currency_in', 'hops', 'amount_in', 'minimum_out', 'deadline', 'gas'], 'route');
  assert(input.schema_version === 'circuit.route.v1' && input.adapter === ADAPTER && input.chain_id === 4663, 'Unsupported route schema, adapter or chain');
  keys(input.block, ['number', 'hash', 'timestamp'], 'block');
  const block = { number: boundedInt(input.block.number, 0, Number.MAX_SAFE_INTEGER, 'block.number'), hash: input.block.hash, timestamp: boundedInt(input.block.timestamp, 0, Number.MAX_SAFE_INTEGER - 86400, 'block.timestamp') };
  assert(typeof block.hash === 'string' && HASH.test(block.hash), 'block.hash must be 32-byte hex');
  block.hash = block.hash.toLowerCase();
  const router = address(input.router, 'router', true), pool_manager = address(input.pool_manager, 'pool_manager', true), permit2 = address(input.permit2, 'permit2', true);
  const wallet = address(input.wallet, 'wallet', true), recipient = address(input.recipient, 'recipient', true);
  assert(wallet === recipient, 'First adapter requires recipient equal to wallet');
  assert(new Set([router, pool_manager, permit2, wallet]).size === 4, 'Router, manager, Permit2 and wallet must be distinct');
  assert(['actual', 'synthetic'].includes(input.wallet_context), 'Unsupported wallet_context');
  const currency_in = address(input.currency_in, 'currency_in');
  assert(Array.isArray(input.hops) && input.hops.length >= 1 && input.hops.length <= 4, 'Route requires one to four hops');
  let current = currency_in;
  const poolIds = new Set(), visited = new Set([current]);
  const hops = input.hops.map((hop, index) => {
    keys(hop, ['pool_key', 'currency_out', 'hook_data'], 'hop');
    const pool_key = poolKey(hop.pool_key), currency_out = address(hop.currency_out, 'currency_out');
    assert(current !== currency_out && [pool_key.currency0, pool_key.currency1].includes(current) && [pool_key.currency0, pool_key.currency1].includes(currency_out), 'Hop currencies do not match the PoolKey');
    const id = poolId(pool_key);
    assert(!poolIds.has(id), 'Route cannot repeat a pool');
    assert(!visited.has(currency_out) || (index === input.hops.length - 1 && currency_out === currency_in), 'Route cannot revisit an intermediate currency');
    poolIds.add(id); visited.add(currency_out); current = currency_out;
    return { pool_key, currency_out, hook_data: hookData(hop.hook_data) };
  });
  const amount_in = decimal(input.amount_in, 1n, (1n << 127n) - 1n, 'amount_in');
  const minimum_out = decimal(input.minimum_out, 1n, (1n << 128n) - 1n, 'minimum_out');
  const deadline = decimal(input.deadline, BigInt(block.timestamp) + 1n, BigInt(block.timestamp) + 86400n, 'deadline');
  const gas = decimal(input.gas, 1n, 100000000n, 'gas');
  return { schema_version: 'circuit.route.v1', adapter: ADAPTER, chain_id: 4663, block, router, pool_manager, permit2, wallet, recipient, wallet_context: input.wallet_context, currency_in, hops, amount_in, minimum_out, deadline, gas };
}

export function buildRoute(input) {
  const route = normalize(input);
  const output = route.hops.at(-1).currency_out;
  const currencies = [...new Set([route.currency_in, ...route.hops.map(h => h.currency_out)])];
  // Prepay creates credit before any swap. Returning to the input currency is safe:
  // TAKE_ALL receives total resulting credit, rather than trying to settle a positive delta.
  const settlement_currencies = [output, ...currencies.filter(c => c !== output)];
  const route_digest = digestValue(route);
  const transaction = {
    from: route.wallet, to: route.router, data: encodeUniversalV4(route, settlement_currencies),
    value: '0x' + (route.currency_in === ZERO ? BigInt(route.amount_in) : 0n).toString(16),
    gas: '0x' + BigInt(route.gas).toString(16)
  };
  const call_request = validateCallRequest({
    schema_version: 'hook-lab.call.v1', chain_id: 4663,
    block: { number: route.block.number, hash: route.block.hash }, transaction,
    balance_tokens: currencies.filter(c => c !== ZERO).flatMap(address => [route.wallet, route.router].map(owner => ({ address, owner }))),
    context: { identity_digest: route_digest, route_id: 'circuit:' + route_digest.slice(2), source_mapping: 'unverified', wallet_context: route.wallet_context }
  });
  const built = {
    schema_version: 'circuit.built.v1', status: 'CANDIDATE_COMPILED', route, route_digest, transaction,
    pool_ids: route.hops.map(h => poolId(h.pool_key)), settlement_currencies, call_request,
    limitations: [
      'Compilation establishes calldata for pinned source semantics; deployment bytecode, hooks, approvals, token behavior and executable liquidity remain unverified.',
      'Only exact-input paths with wallet as payer and recipient are supported. No signatures, permits, flash borrowing, arbitrary commands or live submission.',
      'ERC20 input requires existing token allowance to Permit2 and existing Permit2 allowance to this router; the compiler does not create either allowance.',
      'The pinned V4 ABI uses an empty minHopPriceX36 array; only the aggregate minimum output is enforced, with no per-hop price floor.',
      'Whole-call fork balance evidence, canonical source checks and separate Robinhood gas-cost evidence are required before evaluating a route; future execution or profit is not established.',
      'All unique route currencies are taken back to the wallet. Tokens outside the route are not enumerated or valued.'
    ]
  };
  return { ...built, build_digest: digestValue(built) };
}

export function validateBuilt(input) {
  boundedJson(input);
  keys(input, ['schema_version', 'status', 'route', 'route_digest', 'transaction', 'pool_ids', 'settlement_currencies', 'call_request', 'limitations', 'build_digest'], 'built');
  const expected = buildRoute(input.route);
  assert(digestValue(expected) === digestValue(input), 'Built candidate does not match its canonical route');
  return expected;
}

/** Deterministic graph enumeration only; it neither quotes nor ranks profitability. */
export function enumerateRoutes(input) {
  keys(input, ['currency_in', 'currency_out', 'pools', 'max_hops', 'max_routes'], 'graph request');
  const start = address(input.currency_in, 'currency_in'), target = address(input.currency_out, 'currency_out');
  const maxHops = boundedInt(input.max_hops, 1, 4, 'max_hops'), maxRoutes = boundedInt(input.max_routes, 1, 64, 'max_routes');
  assert(Array.isArray(input.pools) && input.pools.length <= 64, 'Graph must contain at most 64 pools');
  const ids = new Set();
  const pools = input.pools.map(pool => {
    keys(pool, ['pool_key', 'hook_data'], 'graph pool');
    const pool_key = poolKey(pool.pool_key), id = poolId(pool_key);
    assert(!ids.has(id), 'Graph contains a duplicate pool'); ids.add(id);
    return { pool_key, hook_data: hookData(pool.hook_data), id };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const adjacency = new Map();
  for (const pool of pools) for (const currency of [pool.pool_key.currency0, pool.pool_key.currency1]) {
    if (!adjacency.has(currency)) adjacency.set(currency, []);
    adjacency.get(currency).push(pool);
  }
  const routes = [];
  function visit(current, hops, usedPools, visitedCurrencies) {
    if (hops.length >= maxHops || routes.length >= maxRoutes) return;
    for (const pool of adjacency.get(current) ?? []) {
      if (routes.length >= maxRoutes) return;
      if (usedPools.has(pool.id)) continue;
      const next = current === pool.pool_key.currency0 ? pool.pool_key.currency1 : pool.pool_key.currency0;
      const hop = { pool_key: pool.pool_key, currency_out: next, hook_data: pool.hook_data };
      if (next === target) { routes.push([...hops, hop]); continue; }
      if (visitedCurrencies.has(next)) continue;
      visit(next, [...hops, hop], new Set([...usedPools, pool.id]), new Set([...visitedCurrencies, next]));
    }
  }
  visit(start, [], new Set(), new Set([start]));
  return structuredClone(routes);
}
