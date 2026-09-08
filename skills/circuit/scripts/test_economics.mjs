import test from 'node:test';
import assert from 'node:assert/strict';
import { assessExecution, compareExecutions } from './economics.mjs';
import { buildRoute, ADAPTER, ZERO } from './routes.mjs';
import { costCall } from './costs.mjs';
import { digestValue } from './simulation.mjs';
import { validateForkEvidence } from './fork.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const q = n => '0x' + BigInt(n).toString(16);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const wallet = address(1), router = address(2), tokenA = address(100), tokenB = address(200);
const seal = value => { delete value.evidence_digest; value.evidence_digest = digestValue(value); return value; };
const pair = (a, b, fee) => ({ currency0: a < b ? a : b, currency1: a < b ? b : a, fee, tick_spacing: 60, hooks: ZERO });

function candidate({ native = false, open = false, amount = '1000', block = 100, context = 'synthetic' } = {}) {
  const input = native ? ZERO : tokenA;
  return buildRoute({ schema_version: 'circuit.route.v1', adapter: ADAPTER, chain_id: 4663,
    block: { number: block, hash: hash(block), timestamp: 1000 }, router, pool_manager: address(3), permit2: address(4),
    wallet, recipient: wallet, wallet_context: context, currency_in: input,
    hops: [{ pool_key: pair(input, tokenB, 3000), currency_out: tokenB, hook_data: '0x' },
      ...(open ? [] : [{ pool_key: pair(input, tokenB, 500), currency_out: input, hook_data: '0x' }])],
    amount_in: amount, minimum_out: '1', deadline: '1100', gas: '3000000' });
}

// Retained transaction transcript fixture. These manually supplied balances are intentionally
// independent of quote math and are labelled synthetic; no fixture claims a profitable pool.
function forkFixture(built, { spread = 500n, output = 2000n, reverted = false, deltas = {} } = {}) {
  const request = structuredClone(built.call_request), route = built.route;
  const beforeBlock = route.block.number, afterBlock = beforeBlock + 1;
  const blockHash = hash(afterBlock), txHash = hash(9);
  const currencyOut = route.hops.at(-1).currency_out;
  const cycle = route.currency_in === currencyOut;
  const deltaFor = (token, owner) => {
    const override = deltas[token + ':' + owner];
    if (override !== undefined) return BigInt(override);
    if (owner === router || reverted) return token === ZERO && owner === wallet ? -21000n : 0n;
    let delta = token === route.currency_in ? cycle ? spread : -BigInt(route.amount_in)
      : token === currencyOut ? output : 0n;
    if (token === ZERO) delta -= 21000n;
    return delta;
  };
  const tokens = request.balance_tokens.map(item => ({ token: item.address, owner: item.owner,
    before_raw: '1000000', after_raw: (1000000n + deltaFor(item.address, item.owner)).toString(), delta_raw: deltaFor(item.address, item.owner).toString() }));
  const owners = [...new Set([wallet, ...request.balance_tokens.map(item => item.owner)])];
  const natives = owners.map(owner => ({ owner, before_raw: '1000000000',
    after_raw: (1000000000n + deltaFor(ZERO, owner)).toString(), delta_raw: deltaFor(ZERO, owner).toString() }));
  const tx = { hash: txHash, ...request.transaction, input: request.transaction.data, nonce: '0x0', gasPrice: '0x1',
    blockHash, blockNumber: q(afterBlock), chainId: q(4663) };
  delete tx.data;
  const receipt = { transactionHash: txHash, blockHash, blockNumber: q(afterBlock), status: reverted ? '0x0' : '0x1',
    gasUsed: q(21000), effectiveGasPrice: '0x1', logs: [] };
  const observations = [];
  const add = (method, params, result, scope = 'local') => observations.push({ scope, method, params, result });
  const sourceHeader = () => ({ number: q(beforeBlock), hash: route.block.hash, timestamp: q(1000) });
  add('eth_chainId', [], q(4663), 'source');
  add('eth_getBlockByNumber', [q(beforeBlock), false], sourceHeader(), 'source');
  add('anvil_nodeInfo', [], { environment: { chainId: 4663 }, currentBlockNumber: beforeBlock,
    currentBlockHash: route.block.hash, forkConfig: { forkBlockNumber: beforeBlock }, hardFork: 'Prague' });
  add('anvil_metadata', [], { forkedNetwork: { chainId: 4663, forkBlockNumber: beforeBlock, forkBlockHash: route.block.hash }, instanceId: hash(88) });
  add('eth_getBlockByNumber', [q(beforeBlock), false], sourceHeader());
  add('web3_clientVersion', [], 'anvil/v1.7.1'); add('eth_getCode', [wallet, 'latest'], '0x');
  for (const row of tokens) add('eth_call', [{ to: row.token, data: '0x70a08231' + row.owner.slice(2).padStart(64, '0') }, 'latest'], '0x' + word(row.before_raw));
  for (const row of natives) add('eth_getBalance', [row.owner, 'latest'], q(row.before_raw));
  add('eth_gasPrice', [], '0x1'); add('evm_snapshot', [], '0x0'); add('anvil_impersonateAccount', [wallet], null);
  add('eth_sendTransaction', [{ ...request.transaction, gasPrice: '0x1' }], txHash);
  add('eth_getTransactionReceipt', [txHash], receipt); add('eth_getTransactionByHash', [txHash], tx);
  add('eth_getBlockByNumber', [q(afterBlock), false], { number: q(afterBlock), hash: blockHash, parentHash: route.block.hash, timestamp: q(1001) });
  for (const row of tokens) add('eth_call', [{ to: row.token, data: '0x70a08231' + row.owner.slice(2).padStart(64, '0') }, q(afterBlock)], '0x' + word(row.after_raw));
  for (const row of natives) add('eth_getBalance', [row.owner, q(afterBlock)], q(row.after_raw));
  add('eth_chainId', [], q(4663), 'source'); add('eth_getBlockByNumber', [q(beforeBlock), false], sourceHeader(), 'source');
  return seal({ schema_version: 'hook-lab.fork.v1', request, call_digest: digestValue(request),
    status: reverted ? 'FORK_REVERTED_AT_BLOCK' : 'FORK_EXECUTED_AT_BLOCK', execution_environment: 'local-anvil-next-block',
    state_overrides: false, sender_substitution: false, impersonated_sender: wallet, canonical_source_rechecked: true,
    fork_origin: { chain_id: 4663, block: request.block, anvil_version: 'anvil/v1.7.1', hardfork: 'Prague', instance_id: hash(88) },
    local_transaction: { hash: txHash, from: wallet, to: router, data: request.transaction.data, value: tx.value, gas: tx.gas, nonce: '0x0', gas_price: '0x1' },
    local_block: { number: afterBlock, hash: blockHash, parent_hash: route.block.hash, timestamp: 1001 },
    receipt: { transaction_hash: txHash, block_hash: blockHash, block_number: afterBlock, status: reverted ? 0 : 1, gas_used: '21000', effective_gas_price: '1', logs: [] },
    token_balances: tokens, native_balances: natives, expectations: [],
    costs: { local_execution_gas_wei: '21000', robinhood_l1_data_fee_wei: null, total_robinhood_execution_cost_wei: null },
    observations, issues: ['SOURCE_MAPPING_UNVERIFIED', ...(route.wallet_context === 'synthetic' ? ['SYNTHETIC_WALLET_CONTEXT'] : [])] });
}

function costFixture(built, { numerator = '1', denominator = '10', conversion = true, observed = 1002 } = {}) {
  const header = { number: q(built.route.block.number), hash: built.route.block.hash, timestamp: q(1000) };
  const block = { number: built.route.block.number, hash: built.route.block.hash };
  return seal({ schema_version: 'circuit.cost.v1', route_digest: built.route_digest, chain_id: 4663, block,
    transaction_digest: digestValue(built.transaction), basis: 'estimate', method: 'NodeInterface.gasEstimateComponents',
    gas_units: '100', l1_gas_units: '20', gas_price_wei: '2', l1_base_fee_estimate_wei: '3', total_native_cost_wei: '200',
    includes_l1_data_fee: true, observed_at: observed, expires_at: observed + 120,
    observations: [{ method: 'eth_chainId', params: [], result: q(4663) },
      { method: 'eth_getBlockByNumber', params: [q(built.route.block.number), false], result: structuredClone(header) },
      { method: 'eth_call', params: costCall(built), result: '0x' + [100, 20, 2, 3].map(word).join('') },
      { method: 'eth_chainId', params: [], result: q(4663) },
      { method: 'eth_getBlockByNumber', params: [q(built.route.block.number), false], result: structuredClone(header) }],
    ...(conversion && built.route.currency_in !== ZERO ? { conversion: { currency: built.route.currency_in,
      numerator_input_raw: numerator, denominator_native_wei: denominator, block } } : {}) });
}
const assess = (built, report, cost) => assessExecution(built, report, { as_of: 1010, ...(cost ? { cost_evidence: cost } : {}) });
const entry = (built, report, cost) => ({ built, fork_report: report, as_of: 1010, ...(cost ? { cost_evidence: cost } : {}) });

test('retained fixture validates full wallet and router observations', () => {
  const built = candidate(), report = forkFixture(built); assert.deepEqual(validateForkEvidence(report), report);
});
test('same-asset spread is observed but missing Robinhood cost stays unknown', () => {
  const built = candidate(), result = assess(built, forkFixture(built));
  assert.equal(result.spread_input_raw, '500'); assert.equal(result.amount_out_raw, '1500');
  assert.equal(result.estimated_net_input_raw, null); assert.equal(result.economics, 'COST_UNKNOWN');
  assert.ok(result.issues.includes('ROBINHOOD_COST_UNKNOWN'));
});
test('native cycle adds back local gas before subtracting full source cost once', () => {
  const built = candidate({ native: true }), result = assess(built, forkFixture(built), costFixture(built));
  assert.equal(result.wallet_changes.find(row => row.currency === ZERO).observed_delta_raw, '-20500');
  assert.equal(result.spread_input_raw, '500'); assert.equal(result.estimated_net_input_raw, '300');
  assert.equal(result.cost.total_native_cost_wei, '200'); assert.equal(result.cost.l1_gas_units, '20');
});
test('ERC20 cycle does not subtract local gas from token units or charge hook fees again', () => {
  const built = candidate(), result = assess(built, forkFixture(built), costFixture(built));
  assert.equal(result.spread_input_raw, '500'); assert.equal(result.cost.cost_in_input_raw, '20');
  assert.equal(result.estimated_net_input_raw, '480'); assert.ok(result.issues.includes('EXTERNAL_COST_CONVERSION_ASSUMPTION'));
});
test('token cost conversion rounds upward so a fractional raw cost is not zero', () => {
  const built = candidate(), result = assess(built, forkFixture(built), costFixture(built, { denominator: '1000' }));
  assert.equal(result.cost.cost_in_input_raw, '1'); assert.equal(result.estimated_net_input_raw, '499');
});
test('missing input valuation keeps native source cost separate and net unknown', () => {
  const built = candidate(), result = assess(built, forkFixture(built), costFixture(built, { conversion: false }));
  assert.equal(result.cost.total_native_cost_wei, '200'); assert.equal(result.cost.cost_in_input_raw, null);
  assert.equal(result.estimated_net_input_raw, null); assert.ok(result.issues.includes('INPUT_COST_CONVERSION_MISSING'));
});
test('negative spread and zero estimated net are explicitly nonpositive', () => {
  const built = candidate();
  for (const [spread, net] of [[-50n, '-70'], [20n, '0']]) {
    const result = assess(built, forkFixture(built, { spread }), costFixture(built));
    assert.equal(result.estimated_net_input_raw, net); assert.equal(result.economics, 'ESTIMATED_NONPOSITIVE_NET');
  }
});
test('open routes retain two asset changes without inventing unlike-asset profit', () => {
  const built = candidate({ open: true }), result = assess(built, forkFixture(built), costFixture(built));
  assert.equal(result.amount_out_raw, '2000'); assert.equal(result.spread_input_raw, null);
  assert.equal(result.estimated_net_input_raw, null); assert.equal(result.economics, 'UNAVAILABLE_UNLIKE_ASSET_UNITS');
});
test('native open route uses gas-normalized exact input without a second gas subtraction', () => {
  const built = candidate({ native: true, open: true }), result = assess(built, forkFixture(built), costFixture(built));
  assert.equal(result.wallet_changes.find(row => row.currency === ZERO).economic_delta_raw, '-1000');
  assert.equal(result.status, 'SIMULATED'); assert.deepEqual(result.blocking_issues, []);
});
test('synthetic success and actual-context success both retain unverified deployment state', () => {
  for (const context of ['actual', 'synthetic']) {
    const built = candidate({ context }), result = assess(built, forkFixture(built), costFixture(built));
    assert.equal(result.route_qualification, 'UNVERIFIED_DEPLOYMENT'); assert.equal(result.source_mapping, 'unverified');
    assert.equal(result.issues.includes('SYNTHETIC_CONTEXT'), context === 'synthetic');
  }
});
test('valid outer fork evidence from another size cannot be relabelled as this route', () => {
  const built = candidate(), other = candidate({ amount: '2000' });
  assert.throws(() => assess(built, forkFixture(other)), /FORK_ROUTE_BINDING_MISMATCH/);
});
test('tampered raw balances fail even when the outer digest is resealed', () => {
  const built = candidate(), report = forkFixture(built); report.token_balances[0].delta_raw = '9999';
  assert.throws(() => assess(built, seal(report)), /BALANCE_DELTA/);
});
test('missing router coverage fails retained evidence validation', () => {
  const built = candidate(), report = forkFixture(built); report.token_balances = report.token_balances.filter(row => row.owner !== router);
  assert.throws(() => assess(built, seal(report)), /TOKEN_COVERAGE/);
});
test('router residual and loss each block a positive wallet-only estimate', () => {
  const built = candidate();
  for (const [delta, issue] of [[1, 'ROUTER_RESIDUAL'], [-1, 'UNEXPECTED_ROUTER_LOSS']]) {
    const result = assess(built, forkFixture(built, { deltas: { [tokenA + ':' + router]: delta } }), costFixture(built));
    assert.equal(result.estimated_net_input_raw, null); assert.ok(result.blocking_issues.includes(issue));
    assert.equal(result.residuals[0].location, 'router');
  }
});
test('wallet intermediate proceeds and losses cannot be ignored in cycle accounting', () => {
  const built = candidate();
  for (const [delta, issue] of [[1, 'WALLET_RESIDUAL'], [-1, 'UNEXPECTED_WALLET_LOSS']]) {
    const result = assess(built, forkFixture(built, { deltas: { [tokenB + ':' + wallet]: delta } }), costFixture(built));
    assert.equal(result.estimated_net_input_raw, null); assert.ok(result.blocking_issues.includes(issue));
  }
});
test('unexpected native charges on ERC20 path block accounting instead of becoming unpriced costs', () => {
  const built = candidate(), result = assess(built, forkFixture(built, { deltas: { [ZERO + ':' + wallet]: -21001 } }), costFixture(built));
  assert.equal(result.estimated_net_input_raw, null); assert.ok(result.blocking_issues.includes('UNEXPECTED_WALLET_LOSS'));
});
test('open route partial-fill refund is measured without treating it as a balance anomaly', () => {
  const built = candidate({ open: true }), result = assess(built, forkFixture(built, { deltas: { [tokenA + ':' + wallet]: -999 } }));
  assert.equal(result.input_debited_raw, '999'); assert.equal(result.input_refund_raw, '1');
  assert.ok(result.issues.includes('PARTIAL_INPUT_REFUND_OBSERVED')); assert.equal(result.status, 'SIMULATED');
});
test('open route overspend or net input credit exceeds the supported prepayment flow', () => {
  const built = candidate({ open: true });
  for (const delta of [-1001, 1]) {
    const result = assess(built, forkFixture(built, { deltas: { [tokenA + ':' + wallet]: delta } }));
    assert.ok(result.blocking_issues.includes('INPUT_BALANCE_OUTSIDE_PREPAID_LIMIT'));
    assert.equal(result.status, 'SIMULATED_WITH_BALANCE_ANOMALY');
  }
});
test('cycle settled return explicitly includes any input refund and does not claim gross input spent', () => {
  const built = candidate(), result = assess(built, forkFixture(built));
  assert.equal(result.amount_out_basis, 'settled_return_including_any_unspent_input');
  assert.equal(result.input_debited_raw, null); assert.equal(result.input_refund_raw, null);
});
test('successful status without minimum output balance still blocks economics', () => {
  const built = candidate(), result = assess(built, forkFixture(built, { spread: -1000n }), costFixture(built));
  assert.equal(result.amount_out_raw, '0'); assert.ok(result.blocking_issues.includes('MINIMUM_OUTPUT_NOT_OBSERVED'));
});
test('reverted call retains gas observation and has no route output or positive net', () => {
  const built = candidate(), result = assess(built, forkFixture(built, { reverted: true }), costFixture(built));
  assert.equal(result.status, 'SIMULATION_REVERTED'); assert.equal(result.local_execution_gas_wei, '21000');
  assert.equal(result.amount_out_raw, null); assert.equal(result.estimated_net_input_raw, null); assert.deepEqual(result.blocking_issues, []);
});
test('incomplete fork balances are never interpreted as completed economic observations', () => {
  const built = candidate(), report = forkFixture(built); report.status = 'INCOMPLETE'; report.token_balances[0].delta_raw = '999999';
  const result = assess(built, seal(report), costFixture(built));
  assert.equal(result.status, 'INCOMPLETE'); assert.deepEqual(result.wallet_changes, []); assert.equal(result.spread_input_raw, null);
});
test('cost transcript binding and arithmetic cannot be changed by a new outer hash', () => {
  const built = candidate(), report = forkFixture(built);
  for (const mutate of [cost => { cost.total_native_cost_wei = '0'; }, cost => { cost.route_digest = hash(22); },
    cost => { cost.observations[2].params[0].from = address(99); }]) {
    const cost = costFixture(built); mutate(cost); assert.throws(() => assess(built, report, seal(cost)), /COST_/);
  }
});
test('expired or future-observed estimates preserve unknown net', () => {
  const built = candidate(), report = forkFixture(built), cost = costFixture(built);
  const expired = assessExecution(built, report, { cost_evidence: cost, as_of: 1123 });
  assert.equal(expired.estimated_net_input_raw, null); assert.ok(expired.issues.includes('COST_ESTIMATE_EXPIRED'));
  const future = assessExecution(built, report, { cost_evidence: cost, as_of: 1001 });
  assert.equal(future.estimated_net_input_raw, null); assert.ok(future.issues.includes('COST_ESTIMATE_NOT_YET_OBSERVED'));
});
test('historical pinned state remains marked even during its estimate freshness interval', () => {
  const built = candidate(), cost = costFixture(built, { observed: 2000 });
  const result = assessExecution(built, forkFixture(built), { cost_evidence: cost, as_of: 2010 });
  assert.ok(result.issues.includes('HISTORICAL_COST_ESTIMATE')); assert.equal(result.estimated_net_input_raw, '480');
});
test('assessment rejects arbitrary valuation options and invalid clocks', () => {
  const built = candidate(), report = forkFixture(built);
  for (const options of [{ cost: 0 }, { as_of: true }, { as_of: -1 }, { as_of: 1.5 }])
    assert.throws(() => assessExecution(built, report, options), /INVALID_/);
});
test('sampled route sizes rank by estimated absolute net rather than gross output', () => {
  const small = candidate(), large = candidate({ amount: '2000' });
  const result = compareExecutions([entry(small, forkFixture(small, { spread: 50n }), costFixture(small)),
    entry(large, forkFixture(large, { spread: 200n }), costFixture(large))]);
  assert.equal(result.status, 'ESTIMATED_COMPARISON'); assert.equal(result.ranked[0].route_digest, large.route_digest);
  assert.equal(result.ranked[0].estimated_net_input_raw, '180');
});
test('comparison excludes unknown costs explicitly instead of ranking missing cost as zero', () => {
  const small = candidate(), large = candidate({ amount: '2000' });
  const result = compareExecutions([entry(small, forkFixture(small), costFixture(small)), entry(large, forkFixture(large, { spread: 999n }))]);
  assert.equal(result.status, 'PARTIAL_ESTIMATED_COMPARISON'); assert.equal(result.ranked.length, 1);
  assert.equal(result.excluded[0].reason, 'COST_UNKNOWN');
});
test('open routes produce observation tables without a net ranking', () => {
  const built = candidate({ open: true }), result = compareExecutions([entry(built, forkFixture(built), costFixture(built))]);
  assert.equal(result.status, 'NO_COMPARABLE_NET_ESTIMATES'); assert.deepEqual(result.ranked, []);
});
test('different conversion assumptions suppress a misleading net ranking', () => {
  const small = candidate(), large = candidate({ amount: '2000' });
  const result = compareExecutions([entry(small, forkFixture(small), costFixture(small)),
    entry(large, forkFixture(large), costFixture(large, { denominator: '20' }))]);
  assert.equal(result.status, 'NO_COMPARABLE_NET_ESTIMATES'); assert.ok(result.excluded.every(item => item.reason === 'INCOMPARABLE_COST_CONVERSION'));
});
test('comparison rejects different blocks, currencies, contexts, assessment times and duplicate routes', () => {
  const first = candidate();
  for (const second of [candidate({ block: 101 }), candidate({ native: true }), candidate({ context: 'actual' })])
    assert.throws(() => compareExecutions([entry(first, forkFixture(first)), entry(second, forkFixture(second))]), /INCOMPARABLE_EXECUTION_SCOPE/);
  const second = candidate({ amount: '2000' }), later = entry(second, forkFixture(second)); later.as_of = 1011;
  assert.throws(() => compareExecutions([entry(first, forkFixture(first)), later]), /INCOMPARABLE_EXECUTION_SCOPE/);
  assert.throws(() => compareExecutions([entry(first, forkFixture(first)), entry(first, forkFixture(first))]), /DUPLICATE_COMPARISON_ROUTE/);
});
test('comparison bounds input count and rejects extra entry fields', () => {
  const built = candidate(), item = entry(built, forkFixture(built));
  assert.throws(() => compareExecutions([]), /INVALID_COMPARISON/);
  assert.throws(() => compareExecutions(Array(65).fill(item)), /INVALID_COMPARISON/);
  assert.throws(() => compareExecutions([{ ...item, profit: '9999' }]), /INVALID_COMPARISON_ENTRY/);
});
