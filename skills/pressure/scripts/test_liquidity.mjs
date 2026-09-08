import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeLiquidity } from './liquidity.mjs';
const original = JSON.parse(readFileSync(new URL('../assets/liquidity.synthetic.json', import.meta.url)));
const fixture = () => structuredClone(original);
const f = (numerator, denominator = '1') => ({ numerator, denominator });
const otherAddress = '0x4444444444444444444444444444444444444444';
const otherHash = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
function external(o, price = '100', multiplier = '1') {
  o.reference = { kind: 'external_underlying', quote_per_asset: f(price), ui_multiplier: f(multiplier), observed_at: o.block.timestamp, evidence_ref: 'synthetic:underlying' };
}

test('compares two explicit tested sell outputs with exact rational costs and no capacity inference', () => {
  const r = analyzeLiquidity(fixture());
  assert.equal(r.status, 'RETAINED_COMPARISON_AVAILABLE');
  assert.deepEqual(r.observations[0].all_in_quote_per_raw_token, f('497', '5'));
  assert.deepEqual(r.observations[0].venue_execution_shortfall_bps, f('60'));
  assert.deepEqual(r.observations[1].venue_execution_shortfall_bps, f('210'));
  assert.deepEqual(r.comparisons[0].output_change_bps, f('-30000', '199'));
  assert.equal(r.tested_size_limits[0].largest_tested_input_passing_raw, '1000000000000000000');
  assert.equal(r.tested_size_limits[1].largest_tested_input_passing_raw, null);
});

test('buy price uses quote input plus external costs and asset output decimal scales', () => {
  const x = fixture();
  for (const o of x.observations) { o.direction = 'buy'; o.input_raw = '100000000'; o.output_raw = '1000000000000000000'; }
  const r = analyzeLiquidity(x);
  assert.deepEqual(r.observations[0].observed_quote_per_raw_token, f('100'));
  assert.deepEqual(r.observations[0].all_in_quote_per_raw_token, f('1001', '10'));
  assert.deepEqual(r.observations[0].venue_execution_shortfall_bps, f('10'));
});

test('does not subtract a hook fee already included in net received output twice', () => {
  const x = fixture();
  x.observations[0].costs.items.push({ id: 'hook-fee', kind: 'fee', amount_raw: '1000000', currency: x.quote_asset.address, included_in_output: true, evidence_ref: 'synthetic:fee' });
  assert.deepEqual(analyzeLiquidity(x).observations[0].all_in_quote_per_raw_token, f('497', '5'));
});

test('additional external quote fee is counted once', () => {
  const x = fixture();
  x.observations[0].costs.items.push({ id: 'router-fee', kind: 'fee', amount_raw: '1000000', currency: x.quote_asset.address, included_in_output: false, evidence_ref: 'synthetic:fee' });
  assert.deepEqual(analyzeLiquidity(x).observations[0].all_in_quote_per_raw_token, f('492', '5'));
});

for (const coverage of ['unknown', 'partial']) test(`missing ${coverage} costs never become zero`, () => {
  const x = fixture(); x.observations[1].costs.coverage = coverage;
  const r = analyzeLiquidity(x); assert.equal(r.observations[1].all_in_quote_per_raw_token, null);
  assert.equal(r.comparisons[0].all_in_price_change_bps, null);
  assert.ok(r.comparisons[0].output_change_bps);
});

test('unknown fee inclusion suppresses net cost metrics', () => {
  const x = fixture(); x.observations[1].fees_in_output = 'unknown';
  assert.equal(analyzeLiquidity(x).observations[1].all_in_quote_per_raw_token, null);
});

test('native gas currency is not silently treated as quote units', () => {
  const x = fixture(); x.observations[0].costs.items[0].currency = '0x0000000000000000000000000000000000000000';
  const r = analyzeLiquidity(x).observations[0]; assert.equal(r.all_in_quote_per_raw_token, null);
  assert.ok(r.reasons.includes('COST_CURRENCY_UNCONVERTED'));
});

test('zero-valued foreign cost does not require invented exchange rate', () => {
  const x = fixture(); x.observations[0].costs.items[0].currency = otherAddress; x.observations[0].costs.items[0].amount_raw = '0';
  assert.deepEqual(analyzeLiquidity(x).observations[0].all_in_quote_per_raw_token, f('199', '2'));
});

test('costs that exhaust sell proceeds produce no positive net execution metric', () => {
  const x = fixture(); x.observations[0].costs.items[0].amount_raw = x.observations[0].output_raw;
  const r = analyzeLiquidity(x).observations[0]; assert.equal(r.all_in_quote_per_raw_token, null); assert.equal(r.threshold_pass, false);
});

for (const state of ['unavailable', 'reverted']) test(`${state} results are retained as unknown depth, never zero`, () => {
  const x = fixture(); x.observations[1].status = state; x.observations[1].output_raw = null;
  const r = analyzeLiquidity(x); assert.equal(r.comparisons[0].status, 'NOT_COMPARABLE'); assert.equal(r.comparisons[0].output_change_bps, null);
});

test('single point reports insufficient history while preserving its measured result', () => {
  const x = fixture(); x.observations.pop(); const r = analyzeLiquidity(x);
  assert.equal(r.status, 'INSUFFICIENT_COMPARABLE_HISTORY'); assert.equal(r.observations.length, 1);
});

test('stale block cannot be made fresh by refreshing its collection timestamp', () => {
  const x = fixture(); x.as_of = '2026-09-08T11:00:00Z'; x.observations[1].observed_at = x.as_of;
  const r = analyzeLiquidity(x); assert.equal(r.status, 'INSUFFICIENT_COMPARABLE_HISTORY');
  assert.ok(r.observations[1].reasons.includes('STALE_SNAPSHOT'));
});

test('noncanonical evidence cannot produce usable depth change', () => {
  const x = fixture(); x.observations[0].canonical = false;
  assert.equal(analyzeLiquidity(x).comparisons[0].status, 'NOT_COMPARABLE');
});

test('unknown identity blocks observed pressure claims', () => {
  const x = fixture(); x.observations[0].identity_verified = false;
  assert.equal(analyzeLiquidity(x).comparisons[0].status, 'NOT_COMPARABLE');
});

for (const evidenceKind of ['wallet_call', 'wallet_fork']) test(`does not equate quotes with ${evidenceKind}`, () => {
  const x = fixture(); x.observations[1].evidence_kind = evidenceKind;
  assert.equal(analyzeLiquidity(x).comparisons.length, 0);
});

for (const field of ['identity_hash', 'configuration_hash']) test(`does not bridge route ${field} drift`, () => {
  const x = fixture(); x.observations[1].route[field] = otherHash;
  assert.equal(analyzeLiquidity(x).comparisons.length, 0);
});

test('does not compare different tested sizes', () => {
  const x = fixture(); x.observations[1].input_raw = '2000000000000000000';
  assert.equal(analyzeLiquidity(x).comparisons.length, 0);
});

test('external underlying gap is a signed premium, not pool impact or threshold depth', () => {
  const x = fixture(); x.observations.forEach(o => external(o));
  const r = analyzeLiquidity(x); assert.deepEqual(r.observations[0].external_reference_premium_bps, f('-50'));
  assert.equal(r.observations[0].venue_execution_shortfall_bps, null); assert.deepEqual(r.tested_size_limits, []);
});

test('underlying conversion uses multiplier once while preserving raw onchain token quantities', () => {
  const x = fixture(); x.observations.forEach(o => external(o, '50', '2'));
  const r = analyzeLiquidity(x); assert.deepEqual(r.observations[0].reference.quote_per_raw_token, f('100'));
  assert.deepEqual(r.observations[0].external_reference_premium_bps, f('-50')); assert.equal(r.observations[0].input_raw, original.observations[0].input_raw);
});

test('multiplier change prevents comparison of different underlying exposures', () => {
  const x = fixture(); external(x.observations[0], '100', '1'); external(x.observations[1], '50', '2');
  const r = analyzeLiquidity(x); assert.equal(r.comparisons[0].status, 'NOT_COMPARABLE');
  assert.ok(r.comparisons[0].reasons.includes('UNDERLYING_DENOMINATION_CHANGED_OR_UNKNOWN'));
});

test('missing underlying conversion leaves external premium unknown', () => {
  const x = fixture(); external(x.observations[0]); delete x.observations[0].reference.ui_multiplier;
  assert.equal(analyzeLiquidity(x).observations[0].external_reference_premium_bps, null);
});

test('stale reference suppresses derived gap without deleting observed output', () => {
  const x = fixture(); external(x.observations[0]); x.observations[0].reference.observed_at = '2026-09-08T09:00:00Z';
  const o = analyzeLiquidity(x).observations[0]; assert.equal(o.external_reference_premium_bps, null); assert.ok(o.observed_quote_per_raw_token);
});

test('same-block routes rank on exact all-in sell proceeds, never by marginal displayed price', () => {
  const x = fixture(); const alt = structuredClone(x.observations[0]); alt.id = 'alternate'; alt.route.id = 'alternate'; alt.output_raw = '99700000';
  x.observations.splice(1, 0, alt);
  const r = analyzeLiquidity(x); assert.deepEqual(r.cross_route_rankings[0].ordered_observation_ids, ['alternate', 'synthetic-before-sell']);
});

test('same-block routes with different cost coverage do not produce false net ranking', () => {
  const x = fixture(); const alt = structuredClone(x.observations[0]); alt.id = 'alternate'; alt.route.id = 'alternate'; alt.costs.coverage = 'unknown'; x.observations.splice(1, 0, alt);
  assert.deepEqual(analyzeLiquidity(x).cross_route_rankings, []);
});

test('largest passing tested size is not interpolated between passing and failing points', () => {
  const x = fixture(); const big = structuredClone(x.observations[0]); big.id = 'larger'; big.input_raw = '3000000000000000000'; big.output_raw = '280000000'; x.observations.splice(1, 0, big);
  const r = analyzeLiquidity(x); assert.equal(r.tested_size_limits[0].largest_tested_input_passing_raw, '1000000000000000000');
  assert.equal(r.tested_size_limits[0].tested_observation_ids.length, 2);
});

test('explicit threshold includes equality and favorable price is negative shortfall', () => {
  const x = fixture(); x.policy.max_execution_cost_bps = '60'; x.observations[1].output_raw = '101000000';
  const r = analyzeLiquidity(x); assert.equal(r.observations[0].threshold_pass, true); assert.deepEqual(r.observations[1].venue_execution_shortfall_bps, f('-90'));
});

test('exact math preserves raw quantities above Number safe integer range', () => {
  const x = fixture(); for (const o of x.observations) { o.input_raw = '1000000000000000000000000000000000000'; o.output_raw = '100000000000000000000000000'; o.costs.items = []; }
  assert.deepEqual(analyzeLiquidity(x).observations[0].all_in_quote_per_raw_token, f('100'));
});

test('input digest is property-order invariant and changes when retained evidence changes', () => {
  const x = fixture(); const a = analyzeLiquidity(x).input_digest;
  assert.equal(a, analyzeLiquidity(Object.fromEntries(Object.entries(x).reverse())).input_digest);
  x.observations[0].evidence_refs.push('synthetic:extra'); assert.notEqual(a, analyzeLiquidity(x).input_digest);
});

test('synthetic mode is explicit in every analysis result', () => {
  assert.equal(analyzeLiquidity(fixture()).evidence_mode, 'synthetic');
  const x = fixture(); x.evidence_mode = 'retained'; assert.equal(analyzeLiquidity(x).evidence_mode, 'retained');
});

test('already adjusted token reference is used directly without multiplier', () => {
  const x = fixture(); external(x.observations[0]); x.observations[0].reference.kind = 'external_token'; delete x.observations[0].reference.ui_multiplier;
  const o = analyzeLiquidity(x).observations[0]; assert.deepEqual(o.external_reference_premium_bps, f('-50')); assert.equal(o.venue_execution_shortfall_bps, null);
});

const invalid = [
  ['missing evidence mode', x => { delete x.evidence_mode; }],
  ['unsupported evidence mode', x => { x.evidence_mode = 'live_verified'; }],
  ['token reference double adjustment', x => { external(x.observations[0]); x.observations[0].reference.kind = 'external_token'; }],
  ['zero asset pretending ERC-20', x => { x.asset.address = '0x0000000000000000000000000000000000000000'; }],
  ['zero quote pretending ERC-20', x => { x.quote_asset.address = '0x0000000000000000000000000000000000000000'; }],
  ['wrong chain', x => { x.chain_id = 1; }],
  ['wrong wallet override', x => { x.observations[1].wallet = otherAddress; }],
  ['wrong asset override', x => { x.observations[1].asset = { address: otherAddress, decimals: 18 }; }],
  ['wrong quote decimals override', x => { x.observations[1].quote_asset = { ...x.quote_asset, decimals: 18 }; }],
  ['same asset and quote', x => { x.asset.address = x.quote_asset.address; }],
  ['numeric raw amount', x => { x.observations[0].input_raw = 1e18; }],
  ['leading zero amount', x => { x.observations[0].input_raw = '01'; }],
  ['negative raw amount', x => { x.observations[0].output_raw = '-1'; }],
  ['uint overflow', x => { x.observations[0].input_raw = (1n << 256n).toString(); }],
  ['zero output masquerading as unavailable', x => { x.observations[0].status = 'unavailable'; x.observations[0].output_raw = '0'; }],
  ['zero successful output', x => { x.observations[0].output_raw = '0'; }],
  ['future collection', x => { x.observations[1].observed_at = '2026-09-08T11:00:00Z'; }],
  ['future reference lookahead', x => { x.observations[1].reference.observed_at = '2026-09-08T10:01:01Z'; }],
  ['wrong marginal reference block', x => { x.observations[1].reference.block.number = 100; }],
  ['wrong marginal reference hash', x => { x.observations[1].reference.block.hash = otherHash; }],
  ['duplicate multiplier application', x => { x.observations[1].reference.ui_multiplier = f('2'); }],
  ['zero reference denominator', x => { x.observations[1].reference.quote_per_asset.denominator = '0'; }],
  ['gas fee double-inclusion', x => { x.observations[0].costs.items[0].included_in_output = true; }],
  ['duplicate cost', x => { x.observations[0].costs.items.push(structuredClone(x.observations[0].costs.items[0])); }],
  ['missing evidence refs', x => { x.observations[0].evidence_refs = []; }],
  ['fabricated balance evidence kind', x => { x.observations[0].evidence_kind = 'manager_balance'; }],
  ['duplicate observation ID', x => { x.observations[1].id = x.observations[0].id; }],
  ['duplicate curve point', x => { const clone = structuredClone(x.observations[0]); clone.id = 'dup'; x.observations.splice(1, 0, clone); }],
  ['reverse block order', x => { x.observations.reverse(); }],
  ['conflicting canonical hashes', x => { x.observations[1].block.number = 100; }],
  ['impossible UTC date', x => { x.as_of = '2026-02-30T10:02:00Z'; }],
  ['unbounded decimals', x => { x.asset.decimals = 256; }],
  ['unbounded observation list', x => { x.observations = Array(10001).fill(x.observations[0]); }]
];
for (const [name, change] of invalid) test(`rejects ${name}`, () => { const x = fixture(); change(x); assert.throws(() => analyzeLiquidity(x), TypeError); });
