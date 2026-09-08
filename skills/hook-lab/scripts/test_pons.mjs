import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PONS_CANDIDATE, decodeLaunch, decodeLaunchedToken, encodePonsRead, ponsPoolId, reconstructPonsPool, quotePonsFees, discoverPonsPool } from './pons.mjs';

const A = '0x' + '11'.repeat(20);
const Q = '0x' + '22'.repeat(20);
const C = '0x' + '33'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const HASH = '0x' + 'ab'.repeat(32);
const WORD = n => BigInt(n).toString(16).padStart(64, '0');
const ADDR = a => a.slice(2).padStart(64, '0');
function launchWords() { return [WORD(1), WORD(1), ADDR(A), ADDR(Q), ADDR(C), ADDR(C), ADDR(C), WORD(50), WORD(3000), WORD(5000), WORD(100), WORD(300), WORD(1)]; }
function tokenWords() { return [ADDR(A), ADDR(C), ADDR(C), ADDR(C), ADDR(Q), WORD(2n ** 150n), WORD(0), WORD(200), WORD(50), WORD(1), WORD(2), WORD(2n ** 180n), WORD(123), WORD(1788854400), WORD(1)]; }
const RAW = words => '0x' + words.join('');
function input() { return { pool_key: { currency0: A, currency1: Q, fee: 0, tickSpacing: 200, hooks: PONS_CANDIDATE.hook }, launch: decodeLaunch(RAW(launchWords())), amount_specified: '-100', zero_for_one: true, core_delta0: '-100', core_delta1: '200' }; }

test('decode a complete static hook record without losing identity or fee terms', () => {
  assert.deepEqual(decodeLaunch(RAW(launchWords())), { registered: true, memecoinIsCurrency0: true, memecoin: A, quoteToken: Q, creator: C, buybackCreatorRecipient: C, protocolFeeRecipient: C, creatorTaxBps: 50, protocolFeeShareBps: 3000, buybackBurnBps: 5000, hookFeeBps: 100, maxInternalPriceImpactBps: 300, buybackEnabled: true });
});
test('factory decode preserves values beyond floating point and enum state', () => {
  const result = decodeLaunchedToken(RAW(tokenWords()));
  assert.equal(result.graduationThreshold, (2n ** 150n).toString());
  assert.equal(result.sweptQuote, (2n ** 180n).toString());
  assert.equal(result.phase, 2); assert.equal(result.tickSpacing, 200); assert.equal(result.exists, true);
});
test('canonical negative int24 decodes but cannot become a valid pool spacing', () => {
  const w = tokenWords(); w[7] = WORD(2n ** 256n - 1n);
  const decoded = decodeLaunchedToken(RAW(w)); assert.equal(decoded.tickSpacing, -1);
  assert.throws(() => reconstructPonsPool(decoded), /tickSpacing/);
});
for (const [label, raw] of [['short', RAW(launchWords()).slice(0, -2)], ['trailing', RAW(launchWords()) + '00'], ['nonhex', RAW(launchWords()).slice(0, -1) + 'z']]) {
  test(`reject ${label} hook ABI payload`, () => assert.throws(() => decodeLaunch(raw), /exactly 13/));
}
for (const [label, index, value] of [['bool', 0, WORD(2)], ['uint16', 7, WORD(65536)], ['address', 2, '1' + ADDR(A).slice(1)]]) {
  test(`reject noncanonical hook ${label}`, () => { const w = launchWords(); w[index] = value; assert.throws(() => decodeLaunch(RAW(w)), /padding/); });
}
for (const [label, index, value] of [['phase', 10, WORD(4)], ['phase width', 10, WORD(256)], ['tick sign', 7, WORD(0xffffff)], ['uint24', 6, WORD(0x1000000)], ['bool', 14, WORD(2)]]) {
  test(`reject invalid factory ${label}`, () => { const w = tokenWords(); w[index] = value; assert.throws(() => decodeLaunchedToken(RAW(w))); });
}
test('unregistered all-zero record decodes as absent and cannot reconstruct', () => {
  const r = decodeLaunchedToken('0x' + '0'.repeat(15 * 64));
  assert.equal(r.exists, false); assert.throws(() => reconstructPonsPool(r), /not registered/);
});
for (const phase of [0, 1, 3]) test(`reject nongraduated or rescued phase ${phase}`, () => {
  const r = decodeLaunchedToken(RAW(tokenWords())); r.phase = phase;
  assert.throws(() => reconstructPonsPool(r), /PoolCreated/);
});
test('pool reconstruction orders native ETH first and hashes every key field', () => {
  const r = decodeLaunchedToken(RAW(tokenWords())); r.pairToken = ZERO;
  const out = reconstructPonsPool(r);
  assert.equal(out.pool_key.currency0, ZERO); assert.equal(out.pool_key.currency1, A);
  assert.match(out.pool_id, /^0x[0-9a-f]{64}$/);
  assert.notEqual(out.pool_id, ponsPoolId({ ...out.pool_key, tickSpacing: 60 }));
});
test('supported read selectors only and exact static calldata lengths', () => {
  assert.equal(encodePonsRead('memeHook').length, 10);
  assert.equal(encodePonsRead('getLaunchedToken', A).length, 74);
  assert.equal(encodePonsRead('launches', HASH).slice(10), HASH.slice(2));
  assert.throws(() => encodePonsRead('sweepPoolFees', HASH), /unsupported/);
  assert.throws(() => encodePonsRead('factory', A), /no argument/);
  assert.throws(() => encodePonsRead('launches', A), /32 bytes/);
});
for (const [kind, z, amount, d0, d1, feeCurrency, a0, a1] of [
  ['input 0 to 1', true, '-100', '-100', '200', Q, '-100', '197'],
  ['input 1 to 0', false, '-100', '200', '-100', A, '197', '-100'],
  ['output 0 to 1', true, '100', '-200', '100', A, '-203', '100'],
  ['output 1 to 0', false, '100', '100', '-200', Q, '100', '-203'],
]) test(`hook fee lands on unspecified leg: exact ${kind}`, () => {
  const x = input(); Object.assign(x, { amount_specified: amount, zero_for_one: z, core_delta0: d0, core_delta1: d1 });
  const r = quotePonsFees(x);
  assert.equal(r.fee_currency, feeCurrency); assert.equal(r.hook_adjusted_delta0, a0); assert.equal(r.hook_adjusted_delta1, a1);
  assert.equal(r.fee_raw, '2'); assert.equal(r.creator_tax_raw, '1'); assert.equal(r.partial_fill, false);
});
test('fee and tax floors must not be combined', () => {
  const x = input(); x.launch.creatorTaxBps = 100; x.core_delta1 = '199';
  const r = quotePonsFees(x); assert.equal(r.total_raw, '2'); assert.equal(r.hook_adjusted_delta1, '197');
});
test('retain exact integer arithmetic above 2^53', () => {
  const x = input(); x.core_delta1 = '9007199254740993123';
  const r = quotePonsFees(x); assert.equal(r.fee_raw, '90071992547409931'); assert.equal(r.creator_tax_raw, '45035996273704965');
  assert.equal(r.hook_adjusted_delta1, '8872091265919878227');
});
test('partial specified fills are preserved rather than assuming requested size executed', () => {
  const x = input(); x.core_delta0 = '-60'; const r = quotePonsFees(x);
  assert.equal(r.partial_fill, true); assert.equal(r.specified_fill, '60');
});
test('zero core fill returns zero fees and partial fill', () => {
  const x = input(); x.core_delta0 = '0'; x.core_delta1 = '0'; const r = quotePonsFees(x);
  assert.equal(r.total_raw, '0'); assert.equal(r.partial_fill, true);
});
for (const [name, mutation] of [
  ['zero amount', x => { x.amount_specified = '0'; }],
  ['wrong direction', x => { x.zero_for_one = false; }],
  ['input overfill', x => { x.core_delta0 = '-101'; }],
  ['output overfill', x => { x.amount_specified = '100'; x.core_delta1 = '101'; }],
  ['float amount', x => { x.amount_specified = -0.5; }],
  ['unsafe number', x => { x.core_delta1 = 9007199254740992; }],
  ['hex amount', x => { x.amount_specified = '0xff'; }],
  ['leading zero amount', x => { x.amount_specified = '-0100'; }],
  ['string boolean', x => { x.zero_for_one = 'true'; }],
  ['unregistered hook pool', x => { x.launch.registered = false; }],
  ['wrong fee rate source bounds', x => { x.launch.hookFeeBps = 1001; }],
  ['excess fee sum', x => { x.launch.creatorTaxBps = 2000; }],
  ['wrong token identity', x => { x.launch.memecoin = Q; }],
  ['nonzero core fee', x => { x.pool_key.fee = 3000; }],
  ['unreviewed hook', x => { x.pool_key.hooks = C; }],
  ['invalid tick spacing', x => { x.pool_key.tickSpacing = 0; }],
  ['unsorted currencies', x => { x.pool_key.currency0 = Q; x.pool_key.currency1 = A; }],
]) test(`reject ${name}`, () => { const x = input(); mutation(x); assert.throws(() => quotePonsFees(x)); });
test('int128 minimum absolute-value overflow reproduces source failure', () => {
  const x = input(); Object.assign(x, { amount_specified: '100', core_delta0: (-(2n ** 127n)).toString(), core_delta1: '100' });
  assert.throws(() => quotePonsFees(x), /minimum would overflow/);
  x.launch.hookFeeBps = 0; x.launch.creatorTaxBps = 0;
  assert.equal(quotePonsFees(x).total_raw, '0');
});
test('hook-adjusted input overflow rejects impossible settlement', () => {
  const x = input(); Object.assign(x, { amount_specified: '100', core_delta0: (-(2n ** 127n) + 1n).toString(), core_delta1: '100' });
  assert.throws(() => quotePonsFees(x), /adjusted delta would overflow/);
});
test('fee output is explicitly source-derived and excludes execution claims', () => {
  const r = quotePonsFees(input()); assert.equal(r.status, 'SOURCE_DERIVED_FEE_ARITHMETIC');
  assert.equal(r.deployment_status, 'SOURCE_DERIVED_UNVERIFIED_DEPLOYMENT');
  assert.ok(r.limitations.some(x => x.includes('No wallet call')));
});
test('bundled synthetic example runs offline and retains synthetic evidence label', () => {
  const x = JSON.parse(readFileSync(new URL('../assets/pons-fees.synthetic.json', import.meta.url), 'utf8'));
  const r = quotePonsFees(x);
  assert.equal(r.evidence_mode, 'synthetic'); assert.equal(r.fee_raw, '19999');
  assert.equal(r.creator_tax_raw, '9999'); assert.equal(r.hook_adjusted_delta1, '1970001');
});

const request = () => ({ token: A, chain_id: 4663, block: { number: 100, hash: HASH } });
function fixtureRpc(overrides = {}) {
  const calls = [];
  const responses = new Map([
    [PONS_CANDIDATE.factory + encodePonsRead('memeHook'), RAW([ADDR(PONS_CANDIDATE.hook)])],
    [PONS_CANDIDATE.factory + encodePonsRead('poolManager'), RAW([ADDR(PONS_CANDIDATE.pool_manager)])],
    [PONS_CANDIDATE.hook + encodePonsRead('factory'), RAW([ADDR(PONS_CANDIDATE.factory)])],
    [PONS_CANDIDATE.hook + encodePonsRead('poolManager'), RAW([ADDR(PONS_CANDIDATE.pool_manager)])],
    [PONS_CANDIDATE.factory + encodePonsRead('getLaunchedToken', A), RAW(tokenWords())],
    [PONS_CANDIDATE.hook + encodePonsRead('launches', reconstructPonsPool(decodeLaunchedToken(RAW(tokenWords()))).pool_id), RAW(launchWords())],
  ]);
  let headerCount = 0;
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return overrides.chain ?? '0x1237';
    if (method === 'eth_getBlockByNumber') { headerCount++; return { number: '0x64', hash: overrides.reorg && headerCount > 1 ? '0x' + 'cd'.repeat(32) : HASH, timestamp: '0x64' }; }
    if (method === 'eth_getCode') return overrides.code ?? '0x60006000';
    if (method === 'eth_call') {
      if (overrides.readError) throw new Error('provider unavailable');
      const value = responses.get(params[0].to + params[0].data);
      assert.notEqual(value, undefined, 'only documented read selectors are requested');
      return overrides.transform ? overrides.transform(params[0], value) : value;
    }
    throw new Error('unexpected RPC method');
  };
  return { rpc, calls };
}
test('discovery pins every state read, retains transcript, and leaves deployment unverified', async () => {
  const { rpc, calls } = fixtureRpc(); const r = await discoverPonsPool(request(), { rpc });
  assert.equal(calls.length, 12); assert.equal(r.evidence.length, 12);
  for (const c of calls.filter(x => ['eth_call', 'eth_getCode'].includes(x.method))) assert.deepEqual(c.params[1], { blockHash: HASH, requireCanonical: true });
  assert.equal(r.status, 'CANDIDATE_STATE_OBSERVED'); assert.equal(r.runtime_observations.length, 3);
  assert.ok(r.runtime_observations.every(x => x.source_match === 'UNVERIFIED'));
});
test('discovery rejects wrong chain before contract reads', async () => {
  const { rpc, calls } = fixtureRpc({ chain: '0x1' }); await assert.rejects(discoverPonsPool(request(), { rpc }), /chain mismatch/);
  assert.equal(calls.length, 1);
});
test('discovery refuses unpinned latest or missing block hash', async () => {
  const { rpc, calls } = fixtureRpc(); const r = request(); r.block = 'latest';
  await assert.rejects(discoverPonsPool(r, { rpc }), /block must/);
  const q = request(); delete q.block.hash; await assert.rejects(discoverPonsPool(q, { rpc }), /32 bytes/);
  assert.equal(calls.length, 0);
});
test('discovery detects changed canonical header at the end', async () => {
  const { rpc } = fixtureRpc({ reorg: true }); await assert.rejects(discoverPonsPool(request(), { rpc }), /block identity/);
});
test('discovery rejects factory to hook mismatch', async () => {
  const { rpc } = fixtureRpc({ transform: (call, value) => call.data === encodePonsRead('memeHook') ? RAW([ADDR(C)]) : value });
  await assert.rejects(discoverPonsPool(request(), { rpc }), /factory hook mismatch/);
});
test('discovery rejects token substitution', async () => {
  const { rpc } = fixtureRpc({ transform: (call, value) => { if (call.data === encodePonsRead('getLaunchedToken', A)) { const w = tokenWords(); w[0] = ADDR(C); return RAW(w); } return value; } });
  await assert.rejects(discoverPonsPool(request(), { rpc }), /different token/);
});
test('discovery rejects factory and hook fee snapshot conflict', async () => {
  const { rpc } = fixtureRpc({ transform: (call, value) => { if (call.data === encodePonsRead('getLaunchedToken', A)) { const w = tokenWords(); w[8] = WORD(99); return RAW(w); } return value; } });
  await assert.rejects(discoverPonsPool(request(), { rpc }), /state disagree/);
});
test('discovery fails with missing contract code', async () => {
  const { rpc } = fixtureRpc({ code: '0x' }); await assert.rejects(discoverPonsPool(request(), { rpc }), /bytecode/);
});
test('discovery surfaces provider failure rather than substituting empty state', async () => {
  const { rpc } = fixtureRpc({ readError: true }); await assert.rejects(discoverPonsPool(request(), { rpc }), /provider unavailable/);
});
