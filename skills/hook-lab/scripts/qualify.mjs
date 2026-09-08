/** Local consistency checks for one supplied, direct two-asset swap case. */
import { validateManifest, inspectDeployment, identityHash, ZERO, MANAGER } from './identity.mjs';
import { validateCallRequest, simulateCall, digestValue } from './simulation.mjs';
import { validateForkEvidence } from './fork.mjs';
import { keccakHex } from './keccak.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const COMMIT = /^[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SWAP_TOPIC = keccakHex(Buffer.from('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
const own = (v, k) => Object.hasOwn(v, k);
const assert = (yes, message) => { if (!yes) throw new TypeError(message); };
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => identityHash(a) === identityHash(b);
function fields(v, required, optional, label) {
  assert(object(v), `${label}: expected object`);
  assert(required.every(k => own(v, k)), `${label}: missing required fields`);
  assert(Object.keys(v).every(k => [...required, ...optional].includes(k)), `${label}: unexpected fields`);
}
function plainJSON(value) {
  let count = 0;
  const seen = new Set();
  function visit(v, depth) {
    assert(++count <= 300000 && depth <= 64, 'bundle exceeds structural bound');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { assert(Number.isFinite(v), 'bundle contains nonfinite number'); return; }
    assert(object(v) || Array.isArray(v), 'bundle must contain only JSON values');
    assert(!seen.has(v), 'bundle contains a cycle');
    assert(Array.isArray(v) || [Object.prototype, null].includes(Object.getPrototypeOf(v)), 'bundle contains non-JSON object');
    seen.add(v);
    if (Array.isArray(v)) {
      assert(Object.keys(v).length === v.length, 'sparse or decorated arrays are unsupported');
      v.forEach(x => visit(x, depth + 1));
    } else for (const x of Object.values(v)) visit(x, depth + 1);
    seen.delete(v);
  }
  visit(value, 0);
  assert(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024 * 1024, 'bundle exceeds 16 MiB limit');
}
function refs(values, label) {
  assert(Array.isArray(values) && values.length >= 1 && values.length <= 100, `${label}: evidence references required`);
  for (const value of values) assert(typeof value === 'string' && value.length <= 2048 && /^(https:\/\/|git:|sha256:)/.test(value), `${label}: malformed reference`);
}
function reviewBuild(row, label) {
  assert(typeof row.source_commit === 'string' && COMMIT.test(row.source_commit), `${label}: exact source commit required`);
  assert(typeof row.compiler === 'string' && row.compiler.trim().length > 0 && row.compiler.length <= 256, `${label}: compiler required`);
  assert(typeof row.artifact_sha256 === 'string' && SHA256.test(row.artifact_sha256), `${label}: artifact SHA256 required`);
  refs(row.review_refs, `${label}.review_refs`);
}
function checkSource(review, manifest, request) {
  fields(review, ['status'], ['deployment_manifest_digest', 'call_request_digest', 'source_commit', 'compiler', 'artifact_sha256', 'review_refs', 'calldata_review_refs', 'reviewed_contracts', 'access_scope'], 'source_review');
  assert(['verified', 'unverified'].includes(review.status), 'source review status unsupported');
  if (review.status !== 'verified') return {qualified: false, access_scope: 'unknown', coverage: 0};
  assert(review.deployment_manifest_digest === identityHash(manifest), 'source review manifest digest mismatch');
  assert(review.call_request_digest === digestValue(request), 'source review call request digest mismatch');
  reviewBuild(review, 'source_review');
  refs(review.calldata_review_refs, 'calldata_review_refs');
  assert(['permissionless', 'wallet_specific', 'unknown'].includes(review.access_scope), 'source access scope unsupported');
  assert(Array.isArray(review.reviewed_contracts) && review.reviewed_contracts.length <= 60, 'reviewed_contracts missing or oversized');
  const expected = new Map();
  for (const c of manifest.contracts) for (const entry of [c, c.implementation, c.beacon].filter(Boolean)) {
    const address = entry.address.toLowerCase();
    assert(!expected.has(address) || eq(expected.get(address), entry.expected_code_hash), 'conflicting code expectations in graph');
    expected.set(address, entry.expected_code_hash.toLowerCase());
  }
  const found = new Set();
  for (const row of review.reviewed_contracts) {
    fields(row, ['address', 'expected_code_hash', 'source_commit', 'compiler', 'artifact_sha256', 'review_refs'], [], 'reviewed contract');
    assert(ADDRESS.test(row.address) && HASH.test(row.expected_code_hash), 'invalid reviewed contract identity');
    const address = row.address.toLowerCase();
    assert(!found.has(address), 'duplicate reviewed contract');
    assert(expected.has(address) && eq(expected.get(address), row.expected_code_hash), 'reviewed contract outside expected code graph');
    reviewBuild(row, 'reviewed contract');
    found.add(address);
  }
  assert(found.size === expected.size, 'source review does not cover full declared dependency and implementation graph');
  assert(manifest.dependency_scope === 'reviewed', 'dependency scope is unknown');
  return {qualified: review.access_scope === 'permissionless', access_scope: review.access_scope, coverage: found.size};
}

async function replayIdentity(manifest, retained) {
  assert(object(retained) && Array.isArray(retained.evidence) && retained.evidence.length <= 50, 'identity transcript missing');
  let offset = 0, mismatch = false;
  const regenerated = await inspectDeployment(manifest, {rpc: async (method, params) => {
    const row = retained.evidence[offset++];
    if (!row || row.index !== offset - 1 || !same(row.request, {method, params})) { mismatch = true; throw new Error('TRANSCRIPT_MISMATCH'); }
    const body = structuredClone(row); delete body.digest;
    if (row.digest !== identityHash(body)) { mismatch = true; throw new Error('DIGEST_MISMATCH'); }
    if (own(row, 'error')) {
      if (own(row, 'response') || !['RpcReadError', 'TypeError'].includes(row.error?.name)) mismatch = true;
      const error = new Error('RETAINED_RPC_FAILURE'); error.name = row.error?.name; throw error;
    }
    if (!own(row, 'response')) { mismatch = true; throw new Error('RESPONSE_MISSING'); }
    return structuredClone(row.response);
  }});
  assert(!mismatch && offset === retained.evidence.length && same(regenerated, retained), 'identity report disagrees with retained RPC evidence');
  return regenerated;
}

async function replaySimulation(request, retained) {
  assert(object(retained) && Array.isArray(retained.transcript) && retained.transcript.length <= 100, 'simulation transcript missing');
  let offset = 0, mismatch = false;
  const regenerated = await simulateCall(request, {rpc: async (method, params) => {
    const row = retained.transcript[offset++];
    if (!row || row.sequence !== offset || row.method !== method || !same(row.params, params)) { mismatch = true; throw new Error('TRANSCRIPT_MISMATCH'); }
    if (own(row, 'error')) {
      if (own(row, 'result')) mismatch = true;
      const e = row.error;
      const error = new Error(e?.kind === 'REVERT' ? 'execution reverted' : e?.kind === 'UNSUPPORTED' ? 'unsupported' : e?.kind === 'TIMEOUT' ? 'timeout' : 'RPC_ERROR');
      if (e?.code !== null) error.code = e?.code;
      if (e?.revert_data !== null) error.data = e?.revert_data;
      throw error;
    }
    if (!row.result?.retained || !own(row.result, 'value')) { mismatch = true; throw new Error('RAW_RESPONSE_UNAVAILABLE'); }
    return structuredClone(row.result.value);
  }});
  assert(!mismatch && offset === retained.transcript.length && same(regenerated, retained), 'simulation report disagrees with retained RPC evidence');
  return regenerated;
}

function checkCosts(costs, fork) {
  fields(costs, ['status'], ['items', 'coverage_refs'], 'costs');
  assert(['complete', 'partial', 'unknown'].includes(costs.status), 'unsupported costs status');
  const items = costs.items ?? [];
  assert(Array.isArray(items) && items.length <= 50, 'cost items must be bounded array');
  let local = 0;
  for (const item of items) {
    fields(item, ['kind', 'asset', 'amount_raw', 'evidence_refs'], [], 'cost item');
    assert(['local_execution_gas', 'l1_data_fee', 'other'].includes(item.kind), 'unsupported cost kind');
    assert(ADDRESS.test(item.asset) && typeof item.amount_raw === 'string' && DECIMAL.test(item.amount_raw) && item.amount_raw.length <= 78, 'malformed cost amount');
    refs(item.evidence_refs, 'cost evidence_refs');
    if (item.kind === 'local_execution_gas') {
      assert(++local === 1 && eq(item.asset, ZERO), 'local execution gas must be unique and native');
      assert(fork && item.amount_raw === fork.costs.local_execution_gas_wei, 'local execution gas does not reconcile to fork');
    }
  }
  if (costs.coverage_refs !== undefined) {
    assert(Array.isArray(costs.coverage_refs), 'cost coverage_refs must be an array');
    if (costs.coverage_refs.length) refs(costs.coverage_refs, 'cost coverage_refs');
  }
  if (costs.status === 'complete') assert(items.length > 0 && costs.coverage_refs?.length, 'complete cost claim needs items and coverage references');
  return {supplied_status: costs.status, local_execution_gas_reconciled: local === 1, live_chain_cost_completeness: 'UNESTABLISHED', items, net_profit: null};
}

function checkForkCase(fork, request, manifest, identity, simulation) {
  assert(fork.call_digest === digestValue(request) && same(fork.request, request), 'fork call request mismatch');
  assert(fork.execution_environment === 'local-anvil-next-block' && fork.fork_origin.chain_id === 4663, 'fork environment mismatch');
  assert(fork.fork_origin.block.number === manifest.block.number && eq(fork.fork_origin.block.hash, manifest.block.hash), 'fork origin block mismatch');
  assert(fork.local_block.number === manifest.block.number + 1 && eq(fork.local_block.parent_hash, manifest.block.hash), 'fork parent block mismatch');
  assert(fork.state_overrides === false && fork.sender_substitution === false && eq(fork.impersonated_sender, request.transaction.from), 'funding, state or sender overrides are unsupported');
  assert(fork.canonical_source_rechecked === true && identity.canonical_rechecked === true, 'canonical source recheck missing');
  assert(fork.expectations.length > 0 && fork.expectations.every(row => row.pass === true), 'all requested expectations must be tested and pass');
  const wallet = request.transaction.from;
  const native = fork.native_balances.filter(row => eq(row.owner, wallet));
  assert(native.length === 1, 'native wallet balances must be known exactly once');
  assert(simulation.native_balance_before.status === 'OBSERVED_AT_BLOCK' && simulation.native_balance_before.raw === native[0].before_raw, 'fork native prebalance differs from pinned simulation');
  for (const row of fork.token_balances) {
    const pinned = simulation.token_balances_before.filter(x => eq(x.owner, row.owner) && eq(x.token, row.token));
    assert(pinned.length === 1 && pinned[0].status === 'OBSERVED_AT_BLOCK' && pinned[0].raw === row.before_raw, 'fork token prebalance differs from pinned simulation');
  }
  const values = [];
  for (const token of [manifest.pool.currency0, manifest.pool.currency1]) {
    const balances = token === ZERO ? native : fork.token_balances.filter(row => eq(row.token, token) && eq(row.owner, wallet));
    assert(balances.length === 1, 'both pool currencies require actual sender balance observations');
    const expectations = fork.expectations.filter(row => eq(row.token, token) && eq(row.owner, wallet));
    assert(expectations.length === 1 && expectations[0].pass === true, 'both pool currency balance expectations must be tested and pass');
    const delta = BigInt(balances[0].delta_raw) + (token === ZERO ? BigInt(fork.costs.local_execution_gas_wei) : 0n);
    values.push({token, swap_delta_raw: delta.toString()});
  }
  assert((BigInt(values[0].swap_delta_raw) < 0n && BigInt(values[1].swap_delta_raw) > 0n) || (BigInt(values[1].swap_delta_raw) < 0n && BigInt(values[0].swap_delta_raw) > 0n), 'direct two-asset swap requires opposing nonzero pool currency deltas');
  const logs = fork.receipt.logs ?? fork.raw_receipt?.logs;
  assert(Array.isArray(logs), 'fork receipt logs are missing');
  const swaps = logs.filter(row => eq(row.address, MANAGER) && row.topics?.length === 3 && eq(row.topics[0], SWAP_TOPIC) && eq(row.topics[1], manifest.pool.pool_id) && /^0x[0-9a-fA-F]{384}$/.test(row.data));
  assert(swaps.length >= 1, 'fork receipt lacks canonical manager Swap for exact pool_id');
  return {currency_deltas: values, exact_pool_swap_logs: swaps.length, native_delta_includes_local_gas: true};
}

/** This verifies supplied evidence consistency. It cannot authenticate who collected or reviewed it. */
export async function qualifyEvidence(input) {
  const output = {
    schema_version: 'hook-lab.qualification-report.v1', status: 'INSUFFICIENT_EVIDENCE',
    evidence_authenticity: 'UNESTABLISHED', qualified_for_execution: false,
    scope: 'one direct two-asset swap, exact wallet/target/calldata/value/gas/parent block',
    stages: {source: 'UNQUALIFIED', identity: 'UNQUALIFIED', call: 'UNQUALIFIED', fork: 'UNQUALIFIED'},
    case: null, source_review: null, wallet_reconciliation: null, costs: null, net_profit: null, issues: [],
    limitations: [
      'Positive status means local consistency of supplied evidence only. Digests are not signatures, authentic provenance, audits, live execution approval or proof of source review.',
      'Fork execution takes place in the next local block; it is not inclusion on Robinhood Chain, an exact emulation of Nitro gas/L1 data fees or a guarantee of future state.',
      'The supported positive case is a direct two-asset swap with the sender holding both currency balances. Same-asset arbitrage round trips and another recipient are outside this qualification scope.',
      'Source review and permissionless access scope remain supplied assertions; code hashes bind only the declared graph and do not prove comprehensive dependency discovery.',
      'Any later block, wallet, target, calldata, size, proxy, hook configuration or code change requires new evidence. No interpolation, latency advantage or profit is established.',
      'Additional costs may be expressed in different assets or overlap. No numeraire valuation, cost completeness or net profit is inferred.'
    ]
  };
  let inconsistent = false, rejected = false, walletSpecific = false;
  function issue(stage, code, error, invalid = true) {
    output.issues.push({stage, code, detail: error instanceof Error ? error.message : String(error)});
    if (invalid) inconsistent = true;
  }
  let bundle, manifest, request, identity, simulation, fork;
  try {
    plainJSON(input);
    fields(input, ['schema_version', 'manifest', 'identity', 'call_request', 'simulation', 'source_review', 'costs'], ['fork'], 'bundle');
    assert(input.schema_version === 'hook-lab.qualification.v1', 'unsupported qualification schema');
    bundle = structuredClone(input);
    manifest = validateManifest(bundle.manifest);
    request = validateCallRequest(bundle.call_request);
    output.input_digest = digestValue(bundle);
    output.case = {chain_id: 4663, block: request.block, pool_id: manifest.pool.pool_id, transaction: request.transaction, route_id: request.context.route_id, request_digest: digestValue(request), manifest_digest: identityHash(manifest)};
    assert(request.block.number === manifest.block.number && eq(request.block.hash, manifest.block.hash), 'request and deployment block differ');
    const router = manifest.contracts.filter(row => row.role === 'router' && eq(row.address, request.transaction.to));
    assert(router.length === 1, 'actual call target must be a reviewed router contract');
    for (const token of request.balance_tokens) if (!eq(token.address, ZERO)) assert(manifest.contracts.some(row => row.role === 'token' && eq(row.address, token.address)), 'observed token is missing from manifest');
    if (request.context.wallet_context !== 'actual') issue('call', 'SYNTHETIC_WALLET_CONTEXT', 'Actual requested wallet context is required', false);
    if (request.context.source_mapping !== 'verified') issue('source', 'UNVERIFIED_CALL_MAPPING', 'Exact call mapping review is missing', false);
  } catch (error) { issue('bundle', 'INVALID_INPUT', error); }
  if (manifest && request && bundle) {
    try {
      output.source_review = checkSource(bundle.source_review, manifest, request);
      walletSpecific = output.source_review.access_scope === 'wallet_specific';
      if (output.source_review.qualified && request.context.source_mapping === 'verified') output.stages.source = 'SOURCE_REVIEW_ASSERTIONS_BOUND_TO_CASE';
      else issue('source', 'SOURCE_OR_ACCESS_UNQUALIFIED', 'Source review or permissionless scope is unestablished', false);
    } catch (error) { issue('source', 'SOURCE_REVIEW_INCONSISTENT', error); }
    try {
      identity = await replayIdentity(manifest, bundle.identity);
      assert(identity.identity_digest === request.context.identity_digest, 'call identity digest mismatch');
      if (identity.status === 'IDENTITY_MATCH_AT_BLOCK' && identity.qualified_for_identity === true && identity.problems.length === 0) output.stages.identity = 'IDENTITY_RPC_EVIDENCE_CONSISTENT_AT_BLOCK';
      else issue('identity', 'IDENTITY_UNQUALIFIED', 'Identity inspection contains failure or drift evidence', false);
    } catch (error) { issue('identity', 'IDENTITY_EVIDENCE_INCONSISTENT', error); }
    try {
      simulation = await replaySimulation(request, bundle.simulation);
      const target = manifest.contracts.find(row => row.role === 'router' && eq(row.address, request.transaction.to));
      assert(target && eq(target.expected_code_hash, simulation.target_code_hash), 'simulation target bytecode mismatch');
      if (simulation.status === 'CALL_REVERTED_AT_BLOCK' || simulation.call.status === 'REVERTED') rejected = true;
      if (simulation.status === 'CALL_SUCCEEDED_AT_BLOCK' && simulation.call.status === 'SUCCEEDED' && !simulation.issues.some(x => x === 'CALL_TRACE_DISAGREEMENT' || x.startsWith('TRACE_INVALID:')) && request.context.wallet_context === 'actual') output.stages.call = 'WALLET_CALL_SUCCEEDED_AT_BLOCK';
      else issue('call', 'CALL_UNQUALIFIED', 'Pinned wallet call did not establish consistent success', false);
    } catch (error) { issue('call', 'SIMULATION_EVIDENCE_INCONSISTENT', error); }
    if (bundle.fork) {
      try {
        fork = await validateForkEvidence(bundle.fork);
        if (fork.status === 'FORK_REVERTED_AT_BLOCK') rejected = true;
        if (fork.status !== 'FORK_EXECUTED_AT_BLOCK' || fork.issues.length !== 0) issue('fork', 'FORK_UNQUALIFIED', 'Fork execution contains failure or incomplete evidence', false);
        else {
          assert(identity && simulation, 'fork requires consistent identity and simulation evidence');
          output.wallet_reconciliation = checkForkCase(fork, request, manifest, identity, simulation);
          output.stages.fork = 'WALLET_FORK_BALANCES_RECONCILED';
        }
      } catch (error) { issue('fork', 'FORK_EVIDENCE_INCONSISTENT', error); }
    } else issue('fork', 'FORK_EVIDENCE_MISSING', 'A successful eth_call does not establish actual wallet balance deltas', false);
    try { output.costs = checkCosts(bundle.costs, fork); } catch (error) { issue('costs', 'COST_EVIDENCE_INCONSISTENT', error); }
  }
  output.status = inconsistent ? 'INCONSISTENT_EVIDENCE' : rejected ? 'EXECUTION_REJECTED' : walletSpecific ? 'WALLET_SPECIFIC_EVIDENCE_ONLY' : Object.values(output.stages).every(stage => stage !== 'UNQUALIFIED') && output.issues.length === 0 ? 'EXACT_CASE_EVIDENCE_CONSISTENT' : 'INSUFFICIENT_EVIDENCE';
  output.report_digest = digestValue(output);
  return output;
}
