import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyEvidence } from './qualify.mjs';
import { inspectDeployment, validateManifest, identityHash, MANAGER, ZERO } from './identity.mjs';
import { simulateCall, digestValue } from './simulation.mjs';
import { validateForkEvidence } from './fork.mjs';
import { keccakHex } from './keccak.mjs';

// Entire fixture is fabricated test evidence. These hashes and addresses are not deployments.
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), ROUTER = '0x' + '33'.repeat(20), WALLET = '0x' + '44'.repeat(20);
const BLOCK = '0x' + 'aa'.repeat(32), NEXT = '0x' + 'bb'.repeat(32), TX = '0x' + 'cc'.repeat(32);
const CODE = '0x60006000', CODE_HASH = keccakHex(Buffer.from(CODE.slice(2), 'hex'));
const q = n => '0x' + BigInt(n).toString(16);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const balanceData = owner => '0x70a08231' + owner.slice(2).padStart(64, '0');
const sourceRef = 'git:synthetic-qualification-fixture';
const resignFork = fork => { delete fork.evidence_digest; fork.evidence_digest = digestValue(fork); };
const resignSimulation = simulation => { delete simulation.evidence_digest; simulation.evidence_digest = digestValue(simulation); };

async function fixture({nativePool = false, revertedCall = false} = {}) {
  const currency0 = nativePool ? ZERO : A;
  const pool = {currency0, currency1: B, fee: 3000, tick_spacing: 60, hooks: ZERO};
  pool.pool_id = keccakHex(Buffer.from([currency0, B, q(3000), q(60), ZERO].map(x => x.slice(2).padStart(64, '0')).join(''), 'hex'));
  const manifest = validateManifest({schema_version: 'hook-lab.deployment.v1', chain_id: 4663, block: {number: 100, hash: BLOCK}, pool,
    contracts: [[MANAGER, 'manager'], [ROUTER, 'router'], ...(!nativePool ? [[A, 'token']] : []), [B, 'token']].map(([address, role]) => ({address, role, expected_code_hash: CODE_HASH, proxy_kind: 'none'})), checks: [], source_refs: [sourceRef], dependency_scope: 'reviewed'});
  const parent = {number: q(100), hash: BLOCK, parentHash: '0x' + 'dd'.repeat(32), timestamp: q(1700000000)};
  const identity = await inspectDeployment(manifest, {rpc: async method => method === 'eth_chainId' ? q(4663) : method === 'eth_getCode' ? CODE : parent});
  const request = {schema_version: 'hook-lab.call.v1', chain_id: 4663, block: manifest.block,
    transaction: {from: WALLET, to: ROUTER, data: '0x12345678', value: nativePool ? q(100) : '0x0', gas: q(100000)},
    balance_tokens: [...(!nativePool ? [{address: A, owner: WALLET}] : []), {address: B, owner: WALLET}],
    expectations: [{token: currency0, owner: WALLET, minimum_delta: nativePool ? '-21100' : '-100', maximum_delta: nativePool ? '-21100' : '-100'}, {token: B, owner: WALLET, minimum_delta: '80', maximum_delta: '80'}],
    context: {identity_digest: identity.identity_digest, route_id: 'synthetic:swap', source_mapping: 'verified', wallet_context: 'actual'}};
  const simulation = await simulateCall(request, {rpc: async (method, params) => {
    if (method === 'eth_chainId') return q(4663);
    if (method === 'eth_getBlockByNumber') return parent;
    if (method === 'eth_getCode') return CODE;
    if (method === 'eth_getBalance') return q(1000000);
    if (method === 'eth_call') {
      if (params[0].data.startsWith('0x70a08231')) return '0x' + word(params[0].to === A ? 1000 : 10);
      if (revertedCall) {const error = new Error('execution reverted'); error.code = 3; error.data = '0xdeadbeef'; throw error;}
      return '0x';
    }
    const error = new Error('unsupported'); error.code = -32601; throw error;
  }});
  const tx = {hash: TX, from: WALLET, to: ROUTER, input: request.transaction.data, value: request.transaction.value, gas: request.transaction.gas, nonce: '0x0', gasPrice: '0x1', blockHash: NEXT, blockNumber: q(101), chainId: q(4663)};
  const logs = [{address: MANAGER, topics: [keccakHex(Buffer.from('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')), pool.pool_id, '0x' + ROUTER.slice(2).padStart(64, '0')], data: '0x' + '0'.repeat(384), transactionHash: TX, blockHash: NEXT, blockNumber: q(101), transactionIndex: '0x0', logIndex: '0x0', removed: false}];
  const receipt = {transactionHash: TX, blockHash: NEXT, blockNumber: q(101), status: '0x1', gasUsed: q(21000), effectiveGasPrice: '0x1', logs};
  const localHeader = {number: q(101), hash: NEXT, parentHash: BLOCK, timestamp: q(1700000001)};
  const nodeInfo = {currentBlockNumber: 100, currentBlockHash: BLOCK, currentBlockTimestamp: 1700000000, hardFork: 'prague', environment: {chainId: 4663}, forkConfig: {forkBlockNumber: 100}};
  const metadata = {instanceId: '0x' + 'ee'.repeat(32), forkedNetwork: {chainId: 4663, forkBlockNumber: 100, forkBlockHash: BLOCK}};
  const observations = [];
  const push = (method, params, result, scope = 'local') => observations.push({scope, method, params, result});
  push('eth_chainId', [], q(4663), 'source'); push('eth_getBlockByNumber', [q(100), false], parent, 'source');
  push('anvil_nodeInfo', [], nodeInfo); push('anvil_metadata', [], metadata); push('eth_getBlockByNumber', [q(100), false], parent); push('web3_clientVersion', [], 'anvil/test');
  push('eth_getCode', [WALLET, 'latest'], '0x');
  if (!nativePool) push('eth_call', [{to: A, data: balanceData(WALLET)}, 'latest'], '0x' + word(1000));
  push('eth_call', [{to: B, data: balanceData(WALLET)}, 'latest'], '0x' + word(10));
  push('eth_getBalance', [WALLET, 'latest'], q(1000000)); push('eth_gasPrice', [], '0x1'); push('evm_snapshot', [], '0x0');
  push('anvil_impersonateAccount', [WALLET], null); push('eth_sendTransaction', [{...request.transaction, gasPrice: '0x1'}], TX);
  push('eth_getTransactionReceipt', [TX], receipt); push('eth_getTransactionByHash', [TX], tx); push('eth_getBlockByNumber', [q(101), false], localHeader);
  if (!nativePool) push('eth_call', [{to: A, data: balanceData(WALLET)}, q(101)], '0x' + word(900));
  push('eth_call', [{to: B, data: balanceData(WALLET)}, q(101)], '0x' + word(90));
  push('eth_getBalance', [WALLET, q(101)], q(nativePool ? 978900 : 979000));
  push('eth_chainId', [], q(4663), 'source'); push('eth_getBlockByNumber', [q(100), false], parent, 'source');
  const fork = {schema_version: 'hook-lab.fork.v1', request, call_digest: digestValue(request), status: 'FORK_EXECUTED_AT_BLOCK', execution_environment: 'local-anvil-next-block', state_overrides: false, sender_substitution: false, impersonated_sender: WALLET, canonical_source_rechecked: true,
    fork_origin: {chain_id: 4663, block: manifest.block, anvil_version: 'anvil/test', hardfork: 'prague', instance_id: metadata.instanceId},
    local_transaction: {hash: TX, from: WALLET, to: ROUTER, data: request.transaction.data, value: request.transaction.value, gas: request.transaction.gas, nonce: '0x0', gas_price: '0x1'},
    local_block: {number: 101, hash: NEXT, parent_hash: BLOCK, timestamp: 1700000001},
    receipt: {transaction_hash: TX, block_hash: NEXT, block_number: 101, status: 1, gas_used: '21000', effective_gas_price: '1', logs},
    token_balances: [...(!nativePool ? [{token: A, owner: WALLET, before_raw: '1000', after_raw: '900', delta_raw: '-100'}] : []), {token: B, owner: WALLET, before_raw: '10', after_raw: '90', delta_raw: '80'}],
    native_balances: [{owner: WALLET, before_raw: '1000000', after_raw: nativePool ? '978900' : '979000', delta_raw: nativePool ? '-21100' : '-21000'}],
    expectations: request.expectations.map((e, i) => ({...e, observed_delta: i ? '80' : nativePool ? '-21100' : '-100', pass: true})), observations, issues: [],
    costs: {local_execution_gas_wei: '21000', robinhood_l1_data_fee_wei: null, total_robinhood_execution_cost_wei: null, caveat: 'Synthetic test only'}};
  resignFork(fork);
  validateForkEvidence(fork);
  const build = {source_commit: 'f'.repeat(40), compiler: 'solc synthetic test', artifact_sha256: '0'.repeat(64), review_refs: [sourceRef]};
  const source_review = {status: 'verified', deployment_manifest_digest: identityHash(manifest), call_request_digest: digestValue(request), ...build, calldata_review_refs: [sourceRef], access_scope: 'permissionless', reviewed_contracts: manifest.contracts.map(c => ({address: c.address, expected_code_hash: c.expected_code_hash, ...build}))};
  return {schema_version: 'hook-lab.qualification.v1', manifest, identity, call_request: request, simulation, fork, source_review, costs: {status: 'unknown'}};
}

test('exact supplied synthetic fixture is locally consistent, never live execution approval or profit', async () => {
  const result = await qualifyEvidence(await fixture());
  assert.equal(result.status, 'EXACT_CASE_EVIDENCE_CONSISTENT', JSON.stringify(result.issues));
  assert.equal(result.evidence_authenticity, 'UNESTABLISHED');
  assert.equal(result.qualified_for_execution, false); assert.equal(result.net_profit, null);
  assert.equal(result.wallet_reconciliation.exact_pool_swap_logs, 1);
  assert.equal(result.costs.live_chain_cost_completeness, 'UNESTABLISHED');
});

const mutations = [
  ['wrong chain', x => {x.manifest.chain_id = 1;}],
  ['changed amount and calldata', x => {x.call_request.transaction.data = '0xabcdef00';}],
  ['changed wallet', x => {x.call_request.transaction.from = ROUTER;}],
  ['changed block', x => {x.call_request.block.hash = NEXT;}],
  ['changed manifest code', x => {x.manifest.contracts[0].expected_code_hash = NEXT;}],
  ['router omitted from declared graph', x => {x.manifest.contracts = x.manifest.contracts.filter(c => c.role !== 'router');}],
  ['token outside manifest', x => {x.call_request.balance_tokens.push({address: ROUTER, owner: WALLET});}],
  ['identity summary mutated', x => {x.identity.observations[0].code_present = false;}],
  ['identity digest forged', x => {x.identity.identity_digest = identityHash({});}],
  ['identity raw result removed', x => {delete x.identity.evidence[0].response;}],
  ['identity row digest stale', x => {x.identity.evidence[0].response = '0x1';}],
  ['simulation digest forged', x => {x.simulation.evidence_digest = NEXT;}],
  ['simulation native prebalance changed with digest recomputed', x => {x.simulation.native_balance_before.raw = '123'; resignSimulation(x.simulation);}],
  ['simulation raw value changed with digest recomputed', x => {x.simulation.transcript[0].result.value = '0x1'; resignSimulation(x.simulation);}],
  ['simulation failure transcript dropped', x => {x.simulation.transcript = x.simulation.transcript.filter(r => r.method !== 'debug_traceCall'); resignSimulation(x.simulation);}],
  ['simulation unavailable raw response', x => {delete x.simulation.transcript[0].result.value; resignSimulation(x.simulation);}],
  ['fork digest forged', x => {x.fork.evidence_digest = NEXT;}],
  ['fork funding override with digest recomputed', x => {x.fork.state_overrides = true; resignFork(x.fork);}],
  ['fork sender substitution with digest recomputed', x => {x.fork.impersonated_sender = ROUTER; resignFork(x.fork);}],
  ['fork parent reorg with digest recomputed', x => {x.fork.local_block.parent_hash = NEXT; resignFork(x.fork);}],
  ['fork balance invented with digest recomputed', x => {x.fork.token_balances[0].delta_raw = '500'; resignFork(x.fork);}],
  ['fork expectation invented with digest recomputed', x => {x.fork.expectations[0].observed_delta = '500'; resignFork(x.fork);}],
  ['fork native balance missing with digest recomputed', x => {x.fork.native_balances = []; resignFork(x.fork);}],
  ['fork receipt success overwrites revert raw evidence', x => {x.fork.observations.find(r => r.method === 'eth_getTransactionReceipt').result.status = '0x0'; resignFork(x.fork);}],
  ['fork source recheck omitted with digest recomputed', x => {x.fork.canonical_source_rechecked = false; resignFork(x.fork);}],
  ['source review deployment mismatch', x => {x.source_review.deployment_manifest_digest = identityHash({});}],
  ['source review calldata mismatch', x => {x.source_review.call_request_digest = NEXT;}],
  ['missing dependency source review', x => {x.source_review.reviewed_contracts.pop();}],
  ['duplicate dependency source review', x => {x.source_review.reviewed_contracts.push(x.source_review.reviewed_contracts[0]);}],
  ['source review code mismatch', x => {x.source_review.reviewed_contracts[0].expected_code_hash = NEXT;}],
  ['source review not a pinned commit', x => {x.source_review.source_commit = 'main';}],
  ['source calldata review references absent', x => {x.source_review.calldata_review_refs = [];}],
  ['complete costs without coverage', x => {x.costs = {status: 'complete'};}],
  ['gas expense does not match fork', x => {x.costs = {status: 'partial', items: [{kind: 'local_execution_gas', asset: ZERO, amount_raw: '1', evidence_refs: [sourceRef]}]};}],
  ['invented profit claim rejected', x => {x.costs.net_profit = '1000000';}],
  ['undeclared bundle override rejected', x => {x.ignore_failures = true;}],
];
for (const [name, mutate] of mutations) test(name, async () => {
  const evidence = await fixture(); mutate(evidence);
  const result = await qualifyEvidence(evidence);
  assert.notEqual(result.status, 'EXACT_CASE_EVIDENCE_CONSISTENT');
  assert.equal(result.qualified_for_execution, false);
});

test('source family review alone cannot qualify a deployed wallet case', async () => {
  const x = await fixture(); delete x.fork; x.source_review = {status: 'unverified'};
  const result = await qualifyEvidence(x);
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.stages.fork, 'UNQUALIFIED');
});
test('historical privileged wallet case cannot become a permissionless adapter', async () => {
  const x = await fixture(); x.source_review.access_scope = 'wallet_specific';
  assert.equal((await qualifyEvidence(x)).status, 'WALLET_SPECIFIC_EVIDENCE_ONLY');
});
test('unknown access scope stays insufficient', async () => {
  const x = await fixture(); x.source_review.access_scope = 'unknown';
  assert.equal((await qualifyEvidence(x)).status, 'INSUFFICIENT_EVIDENCE');
});
test('matching local gas expense remains unvalued and live cost completeness unestablished', async () => {
  const x = await fixture(); x.costs = {status: 'partial', items: [{kind: 'local_execution_gas', asset: ZERO, amount_raw: '21000', evidence_refs: [sourceRef]}]};
  const result = await qualifyEvidence(x);
  assert.equal(result.status, 'EXACT_CASE_EVIDENCE_CONSISTENT'); assert.equal(result.costs.local_execution_gas_reconciled, true); assert.equal(result.net_profit, null);
});
test('a different pool log cannot establish the declared exact pool', async () => {
  const x = await fixture(); x.fork.receipt.logs[0].topics[1] = NEXT; resignFork(x.fork);
  const result = await qualifyEvidence(x);
  assert.notEqual(result.status, 'EXACT_CASE_EVIDENCE_CONSISTENT');
  assert.match(JSON.stringify(result.issues), /exact pool_id/);
});
test('empty receipt cannot establish actual pool participation', async () => {
  const x = await fixture(); x.fork.receipt.logs.length = 0; resignFork(x.fork);
  assert.notEqual((await qualifyEvidence(x)).status, 'EXACT_CASE_EVIDENCE_CONSISTENT');
});
test('cycles and non-JSON fields are rejected without crashing', async () => {
  const x = await fixture(); x.loop = x;
  assert.equal((await qualifyEvidence(x)).status, 'INCONSISTENT_EVIDENCE');
  const y = await fixture(); y.costs.status = undefined;
  assert.equal((await qualifyEvidence(y)).status, 'INCONSISTENT_EVIDENCE');
});

test('native input requires observed raw expectation and adds local gas back only for swap direction', async () => {
  const result = await qualifyEvidence(await fixture({nativePool: true}));
  assert.equal(result.status, 'EXACT_CASE_EVIDENCE_CONSISTENT', JSON.stringify(result.issues));
  assert.deepEqual(result.wallet_reconciliation.currency_deltas, [{token: ZERO, swap_delta_raw: '-100'}, {token: B, swap_delta_raw: '80'}]);
});
test('a real retained eth_call revert is not overridden by a successful next-block fork', async () => {
  const result = await qualifyEvidence(await fixture({revertedCall: true}));
  assert.equal(result.status, 'EXECUTION_REJECTED', JSON.stringify(result.issues));
  assert.equal(result.stages.call, 'UNQUALIFIED');
});
