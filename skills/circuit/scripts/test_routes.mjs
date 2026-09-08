import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abiEncode, selector } from './abi.mjs';
import { ADAPTER, ZERO, buildRoute, validateBuilt, enumerateRoutes, poolId } from './routes.mjs';
import { digestValue } from './simulation.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('../assets/route-example.json', import.meta.url), 'utf8'));
const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const word = n => BigInt(n).toString(16).padStart(64, '0');
const words = (...values) => '0x' + values.join('');
const key = (a, b, fee = 3000, tick_spacing = 60) => ({ currency0: address(Math.min(a, b)), currency1: address(Math.max(a, b)), fee, tick_spacing, hooks: ZERO });
const graphPool = (...args) => ({ pool_key: key(...args), hook_data: '0x' });

// Read-only decoder deliberately separate from the encoder: walks raw ABI byte
// offsets and asserts the pinned tuple shape and settlement action parameters.
const dataWord = (hex, offset) => {
  assert.equal(offset % 32, 0);
  assert.ok(offset >= 0 && offset * 2 + 64 <= hex.length);
  return BigInt('0x' + hex.slice(offset * 2, offset * 2 + 64));
};
const offsetAt = (hex, offset) => {
  const value = dataWord(hex, offset);
  assert.ok(value <= BigInt(hex.length / 2));
  return Number(value);
};
const bytesAt = (hex, offset) => {
  const length = offsetAt(hex, offset);
  assert.ok((offset + 32 + length) * 2 <= hex.length);
  return hex.slice((offset + 32) * 2, (offset + 32 + length) * 2);
};
function decodeActions(built) {
  assert.equal(built.transaction.data.slice(0, 10), '0x3593564c');
  const execute = built.transaction.data.slice(10);
  assert.equal(bytesAt(execute, offsetAt(execute, 0)), '10');
  assert.equal(dataWord(execute, 64), BigInt(built.route.deadline));
  const inputsBase = offsetAt(execute, 32);
  assert.equal(dataWord(execute, inputsBase), 1n);
  const actionInput = bytesAt(execute, inputsBase + 32 + offsetAt(execute, inputsBase + 32));
  const actions = bytesAt(actionInput, offsetAt(actionInput, 0));
  const paramsBase = offsetAt(actionInput, 32);
  const count = offsetAt(actionInput, paramsBase);
  assert.equal(count, actions.length / 2);
  const params = Array.from({ length: count }, (_, i) => bytesAt(actionInput, paramsBase + 32 + offsetAt(actionInput, paramsBase + 32 + i * 32)));
  return { actions, params };
}

test('function selectors match established ERC20 and UniversalRouter signatures', () => {
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selector('balanceOf(address)'), '0x70a08231');
  assert.equal(selector('execute(bytes,bytes[],uint256)'), '0x3593564c');
});

test('ABI matches the independent Solidity specification mixed-static/dynamic example', () => {
  // f(uint256,uint32[],bytes10,bytes): 0x123,[0x456,0x789],"1234567890","Hello, world!".
  const expected = words(word(0x123), word(0x80), '31323334353637383930'.padEnd(64, '0'), word(0xe0),
    word(2), word(0x456), word(0x789), word(13), '48656c6c6f2c20776f726c6421'.padEnd(64, '0'));
  assert.equal(abiEncode(['uint256', { array: 'uint32' }, 'bytes10', 'bytes'], ['291', [1110, 1929], '0x31323334353637383930', '0x48656c6c6f2c20776f726c6421']), expected);
});

test('nested dynamic array offsets start after each array length word', () => {
  const expected = words(word(32), word(2), word(64), word(160), word(2), word(1), word(2), word(1), word(3));
  assert.equal(abiEncode([{ array: { array: 'uint256' } }], [[[1, 2], [3]]]), expected);
});

test('ABI tuple static heads and sign extension are canonical', () => {
  assert.equal(abiEncode([{ tuple: ['uint16', 'int24'] }, 'bool'], [[65535, -60], true]), words(word(65535), word((1n << 256n) - 60n), word(1)));
  assert.equal(abiEncode(['bytes'], ['0x']), words(word(32), word(0)));
});

for (const [label, types, values] of [
  ['negative uint', ['uint128'], [-1]], ['overflow uint8', ['uint8'], [256]],
  ['overflow int24', ['int24'], [1 << 23]], ['unsafe number', ['uint256'], [Number.MAX_SAFE_INTEGER + 1]],
  ['bool integer', ['uint256'], [true]], ['nonboolean', ['bool'], [1]],
  ['leading zero', ['uint256'], ['01']], ['exponent integer', ['uint256'], ['1e9']],
  ['invalid integer width', ['uint7'], [1]], ['bytes padding mismatch', ['bytes2'], ['0x01']],
  ['odd hex', ['bytes'], ['0x1']], ['huge bytes', ['bytes'], ['0x' + '00'.repeat(65537)]],
  ['array limit', [{ array: 'uint256' }], [Array(65).fill(1)]],
  ['tuple mismatch', [{ tuple: ['uint256'] }], [[1, 2]]],
  ['unknown descriptor', [{ bogus: 'uint256' }], [[1]]]
]) test(`ABI rejects ${label}`, () => assert.throws(() => abiEncode(types, values), TypeError));

test('example compiles into a deterministic source-unverified same-asset circuit', () => {
  const original = fixture(), built = buildRoute(original);
  assert.equal(built.route.adapter, 'universal-router-2.1.1-v4');
  assert.equal(built.status, 'CANDIDATE_COMPILED');
  assert.equal(built.call_request.context.source_mapping, 'unverified');
  assert.equal(built.call_request.context.wallet_context, 'synthetic');
  assert.deepEqual(validateBuilt(built), built);
  assert.deepEqual(buildRoute(original), built);
  assert.equal(built.transaction.value, '0x0');
  assert.equal(built.transaction.gas, '0x2dc6c0');
  assert.equal(new Set(built.pool_ids).size, 2);
  assert.deepEqual(built.settlement_currencies, [address(256), address(512)]);
  assert.deepEqual(built.call_request.balance_tokens, [
    { address: address(256), owner: original.wallet }, { address: address(256), owner: original.router },
    { address: address(512), owner: original.wallet }, { address: address(512), owner: original.router }
  ]);
  assert.equal(built.route_digest, digestValue(built.route));
  built.route.hops[0].hook_data = '0xab';
  assert.equal(original.hops[0].hook_data, '0x');
});

test('independent calldata decoding verifies prepay, UR2.1.1 V4 tuple, cycle path and TAKE_ALL refunds', () => {
  const route = fixture(); route.hops[0].hook_data = '0xabcdef';
  const built = buildRoute(route), { actions, params } = decodeActions(built);
  assert.equal(actions, '0b070f0f');
  assert.equal(params[0], abiStatic([BigInt(route.currency_in), 1000n, 1n]));
  const swap = params[1], structBase = offsetAt(swap, 0);
  assert.equal(structBase, 32);
  assert.equal(dataWord(swap, structBase), BigInt(route.currency_in));
  assert.equal(dataWord(swap, structBase + 96), 1000n);
  assert.equal(dataWord(swap, structBase + 128), 1n);
  const path = structBase + offsetAt(swap, structBase + 32);
  const minPrices = structBase + offsetAt(swap, structBase + 64);
  assert.equal(dataWord(swap, minPrices), 0n);
  assert.equal(dataWord(swap, path), 2n);
  for (let i = 0; i < 2; i++) {
    const item = path + 32 + offsetAt(swap, path + 32 + i * 32), hop = route.hops[i];
    assert.equal(dataWord(swap, item), BigInt(hop.currency_out));
    assert.equal(dataWord(swap, item + 32), BigInt(hop.pool_key.fee));
    assert.equal(dataWord(swap, item + 64), BigInt(hop.pool_key.tick_spacing));
    assert.equal(dataWord(swap, item + 96), BigInt(hop.pool_key.hooks));
    assert.equal(bytesAt(swap, item + offsetAt(swap, item + 128)), hop.hook_data.slice(2));
  }
  assert.equal(params[2], abiStatic([BigInt(route.currency_in), 1n]));
  assert.equal(params[3], abiStatic([BigInt(route.hops[0].currency_out), 0n]));
});
const abiStatic = numbers => numbers.map(word).join('');

test('open route settles output first and refunds input without unit conversion', () => {
  const route = fixture(); route.hops.length = 1;
  const built = buildRoute(route), decoded = decodeActions(built);
  assert.deepEqual(built.settlement_currencies, [address(512), address(256)]);
  assert.equal(decoded.params[2], abiStatic([512n, 1n]));
  assert.equal(decoded.params[3], abiStatic([256n, 0n]));
});

test('native exact-input uses exact msg.value and observes ERC20 owner pairs', () => {
  const route = fixture(); route.hops.length = 1; route.currency_in = ZERO; route.hops[0].pool_key.currency0 = ZERO;
  const built = buildRoute(route);
  assert.equal(built.transaction.value, '0x3e8');
  assert.deepEqual(built.settlement_currencies, [address(512), ZERO]);
  assert.deepEqual(built.call_request.balance_tokens, [{ address: address(512), owner: route.wallet }, { address: address(512), owner: route.router }]);
});

test('native output and native same-asset circuits compile with appropriate value', () => {
  const route = fixture(); route.hops.length = 1; route.currency_in = address(512); route.hops[0].currency_out = ZERO; route.hops[0].pool_key.currency0 = ZERO;
  assert.equal(buildRoute(route).transaction.value, '0x0');
  const circuit = fixture(); circuit.currency_in = ZERO;
  circuit.hops.forEach(h => h.pool_key.currency0 = ZERO); circuit.hops[1].currency_out = ZERO;
  const built = buildRoute(circuit);
  assert.equal(built.transaction.value, '0x3e8');
  assert.equal(built.settlement_currencies[0], ZERO);
});

test('all four-hop route currencies are monitored at both wallet and router', () => {
  const route = fixture(); route.currency_in = address(100);
  route.hops = Array.from({ length: 4 }, (_, i) => ({ pool_key: key(100 + i, 101 + i), currency_out: address(101 + i), hook_data: '0x' }));
  const built = buildRoute(route);
  assert.equal(built.call_request.balance_tokens.length, 10);
  assert.equal(built.settlement_currencies.length, 5);
  assert.equal(decodeActions(built).actions, '0b07' + '0f'.repeat(5));
});

test('address/data case normalizes without changing identity', () => {
  const lower = fixture(); lower.wallet = address(0xabcd); lower.recipient = lower.wallet; lower.hops[0].hook_data = '0xaabb';
  const upper = structuredClone(lower); upper.wallet = '0x' + upper.wallet.slice(2).toUpperCase(); upper.recipient = upper.wallet; upper.hops[0].hook_data = '0xAABB';
  assert.deepEqual(buildRoute(lower), buildRoute(upper));
});

for (const [label, mutate] of [
  ['extra root field', r => r.signature = '0x'], ['wrong chain', r => r.chain_id = 1],
  ['old ABI adapter', r => r.adapter = 'universal-router-2.0.0-v4'],
  ['unknown block field', r => r.block.latest = true], ['invalid block hash', r => r.block.hash = 'latest'],
  ['fractional block', r => r.block.number = 1.1], ['boolean block', r => r.block.number = true],
  ['unsafe timestamp', r => r.block.timestamp = Number.MAX_SAFE_INTEGER],
  ['zero router', r => r.router = ZERO], ['contract sender alias', r => r.wallet = r.recipient = r.router],
  ['different recipient', r => r.recipient = address(999)], ['manager Permit2 alias', r => r.permit2 = r.pool_manager],
  ['invalid wallet context', r => r.wallet_context = 'verified'],
  ['empty hops', r => r.hops = []], ['too many hops', r => r.hops = Array(5).fill(r.hops[0])],
  ['unknown hop field', r => r.hops[0].allowRevert = true], ['unknown pool field', r => r.hops[0].pool_key.price = '1'],
  ['unsorted pool', r => [r.hops[0].pool_key.currency0, r.hops[0].pool_key.currency1] = [r.hops[0].pool_key.currency1, r.hops[0].pool_key.currency0]],
  ['same currency pool', r => r.hops[0].pool_key.currency1 = r.hops[0].pool_key.currency0],
  ['disconnected path', r => r.hops[1].pool_key = key(10, 11)],
  ['wrong output', r => r.hops[0].currency_out = address(999)], ['self hop', r => r.hops[0].currency_out = r.currency_in],
  ['repeat pool', r => r.hops[1].pool_key = structuredClone(r.hops[0].pool_key)],
  ['odd hook data', r => r.hops[0].hook_data = '0x1'], ['oversized hook data', r => r.hops[0].hook_data = '0x' + '00'.repeat(4097)],
  ['dynamic fee plus other flags', r => r.hops[0].pool_key.fee = 0x800001], ['fee > 100%', r => r.hops[0].pool_key.fee = 1000001],
  ['negative spacing', r => r.hops[0].pool_key.tick_spacing = -1], ['zero spacing', r => r.hops[0].pool_key.tick_spacing = 0],
  ['boolean fee', r => r.hops[0].pool_key.fee = true],
  ['zero input sentinel', r => r.amount_in = '0'], ['numeric amount', r => r.amount_in = 1000],
  ['input overflow', r => r.amount_in = (1n << 127n).toString()], ['leading-zero input', r => r.amount_in = '01000'],
  ['negative input', r => r.amount_in = '-1'], ['unbounded input', r => r.amount_in = '1'.repeat(100000)],
  ['zero minimum', r => r.minimum_out = '0'], ['minimum overflow', r => r.minimum_out = (1n << 128n).toString()],
  ['expired deadline', r => r.deadline = '100'], ['too distant deadline', r => r.deadline = '86501'],
  ['zero gas', r => r.gas = '0'], ['excessive gas', r => r.gas = '100000001']
]) test(`route rejects ${label}`, () => { const route = fixture(); mutate(route); assert.throws(() => buildRoute(route), TypeError); });

test('valid dynamic fee and max boundaries are accepted as unqualified candidates', () => {
  const route = fixture(); route.hops[0].pool_key.fee = 0x800000; route.hops[0].pool_key.tick_spacing = 32767;
  route.amount_in = ((1n << 127n) - 1n).toString(); route.minimum_out = ((1n << 128n) - 1n).toString(); route.deadline = '86500'; route.gas = '100000000';
  assert.equal(buildRoute(route).status, 'CANDIDATE_COMPILED');
});

test('intermediate currency revisit is rejected even with distinct pools', () => {
  const route = fixture(); route.currency_in = address(1);
  route.hops = [
    { pool_key: key(1, 2), currency_out: address(2), hook_data: '0x' },
    { pool_key: key(2, 3), currency_out: address(3), hook_data: '0x' },
    { pool_key: key(2, 3, 500, 10), currency_out: address(2), hook_data: '0x' }
  ];
  assert.throws(() => buildRoute(route), /intermediate/);
});

for (const [label, mutate] of [
  ['calldata', b => b.transaction.data += '00'], ['router', b => b.transaction.to = address(999)],
  ['source claim', b => b.call_request.context.source_mapping = 'verified'],
  ['monitor pairs', b => b.call_request.balance_tokens.pop()], ['pool identity', b => b.pool_ids.reverse()],
  ['settlement order', b => b.settlement_currencies.reverse()], ['limitations', b => b.limitations = []],
  ['route digest', b => b.route_digest = '0x' + '0'.repeat(64)], ['status', b => b.status = 'PROFITABLE'],
  ['extra field', b => b.extra = true], ['build digest', b => b.build_digest = '0x' + '0'.repeat(64)]
]) test(`validateBuilt rejects modified ${label} even with recomputed outer digest`, () => {
  const built = buildRoute(fixture()); mutate(built);
  if (label !== 'build digest') { const { build_digest, ...body } = built; built.build_digest = digestValue(body); }
  assert.throws(() => validateBuilt(built), TypeError);
});

test('pool identity binds fee, spacing and hooks and normalizes case', () => {
  const original = key(1, 2);
  const all = [original, { ...original, fee: 500 }, { ...original, tick_spacing: 10 }, { ...original, hooks: address(99) }].map(poolId);
  assert.equal(new Set(all).size, 4);
  assert.equal(poolId({ ...original, hooks: '0x' + 'ab'.repeat(20) }), poolId({ ...original, hooks: '0x' + 'AB'.repeat(20) }));
});

test('validateBuilt rejects oversized retained evidence before canonical hashing', () => {
  const built = buildRoute(fixture()); built.limitations = ['x'.repeat(1048577)];
  assert.throws(() => validateBuilt(built), /MiB/);
});
test('validateBuilt rejects cyclic and excessively nested retained evidence', () => {
  const built = buildRoute(fixture()); built.limitations = [built];
  assert.throws(() => validateBuilt(built), /cyclic/);
  const nested = buildRoute(fixture()); nested.limitations = Array.from({ length: 25 }).reduce(v => [v], 'leaf');
  assert.throws(() => validateBuilt(nested), /structural/);
});

test('graph enumeration finds direct and multihop paths with deterministic pool ordering', () => {
  const input = { currency_in: address(1), currency_out: address(3), pools: [graphPool(1, 2), graphPool(2, 3), graphPool(1, 3), graphPool(3, 4)], max_hops: 4, max_routes: 64 };
  const routes = enumerateRoutes(input);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes.map(r => r.length).sort(), [1, 2]);
  assert.deepEqual(routes, enumerateRoutes({ ...input, pools: [...input.pools].reverse() }));
  assert.ok(routes.every(r => r.at(-1).currency_out === address(3)));
});

test('graph finds same-asset triangles and distinct-pool two-leg circuits', () => {
  const routes = enumerateRoutes({ currency_in: address(1), currency_out: address(1), pools: [graphPool(1, 2), graphPool(1, 2, 500, 10), graphPool(2, 3), graphPool(1, 3)], max_hops: 3, max_routes: 64 });
  assert.equal(routes.length, 6); // two parallel-pool returns plus two orientations of two triangles.
  assert.ok(routes.every(r => new Set(r.map(h => poolId(h.pool_key))).size === r.length));
  assert.ok(routes.every(r => r.at(-1).currency_out === address(1)));
});

test('graph respects result and hop bounds and handles disconnected destinations', () => {
  const input = { currency_in: address(1), currency_out: address(3), pools: [graphPool(1, 2), graphPool(2, 3), graphPool(1, 3)], max_hops: 1, max_routes: 64 };
  assert.equal(enumerateRoutes(input).length, 1);
  assert.equal(enumerateRoutes({ ...input, max_hops: 4, max_routes: 1 }).length, 1);
  assert.deepEqual(enumerateRoutes({ ...input, currency_out: address(99) }), []);
  assert.deepEqual(enumerateRoutes({ ...input, pools: [] }), []);
});

for (const [label, mutate] of [
  ['duplicate pools', x => x.pools.push(structuredClone(x.pools[0]))], ['too many pools', x => x.pools = Array(65).fill(x.pools[0])],
  ['unknown property', x => x.quote = true], ['too many hops', x => x.max_hops = 5],
  ['too many results', x => x.max_routes = 65], ['zero results', x => x.max_routes = 0],
  ['boolean max hops', x => x.max_hops = true], ['pool unknown field', x => x.pools[0].liquidity = '100'],
  ['unsafe data', x => x.pools[0].hook_data = '0xz1']
]) test(`graph rejects ${label}`, () => {
  const input = { currency_in: address(1), currency_out: address(3), pools: [graphPool(1, 2)], max_hops: 4, max_routes: 64 };
  mutate(input); assert.throws(() => enumerateRoutes(input), TypeError);
});
