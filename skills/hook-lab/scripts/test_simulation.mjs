import test from 'node:test';
import assert from 'node:assert/strict';
import { digestValue, validateCallRequest, simulateCall } from './simulation.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
function request() {
  return {
    schema_version: 'hook-lab.call.v1', chain_id: 4663,
    block: { number: 100, hash: hash(10) },
    transaction: { from: address(1), to: address(2), data: '0x12345678', value: '0x0', gas: '0x186a0' },
    balance_tokens: [{ address: address(3), owner: address(1) }],
    context: { identity_digest: hash(11), route_id: 'pons-v2/test', source_mapping: 'unverified', wallet_context: 'actual' },
    expectations: [{ token: address(3), owner: address(1), minimum_delta: '-10', maximum_delta: '20' }]
  };
}
function provider(change = {}) {
  const calls = [];
  let headers = 0;
  async function rpc(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (change.intercept) {
      const replacement = await change.intercept(method, params, calls);
      if (replacement !== undefined) return replacement;
    }
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: change.reorg && ++headers > 1 ? hash(12) : hash(10) };
    if (method === 'eth_getCode') return '0x60006000f3';
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (method === 'eth_call') return params[0].data.startsWith('0x70a08231') ? hash(100) : '0x1234';
    if (method === 'debug_traceCall') return params[2].tracer === 'callTracer'
      ? { type: 'CALL', from: address(1), to: address(2), input: '0x12345678', output: '0x1234', gasUsed: '0x100' }
      : { pre: { [address(3)]: { storage: { [hash(0)]: hash(100) } } }, post: { [address(3)]: { storage: { [hash(0)]: hash(120) } } } };
    throw new Error('Unexpected method ' + method);
  }
  return { rpc, calls };
}

test('strict validation retains the exact caller, gas, calldata and value', () => {
  const input = request();
  input.transaction.from = address(0xab).toUpperCase().replace('0X', '0x');
  const copy = validateCallRequest(input);
  assert.deepEqual(copy, input);
  copy.transaction.gas = '0x1';
  assert.notEqual(copy.transaction.gas, input.transaction.gas);
});

test('identity digest supports the identity module sha256 form', () => {
  const input = request();
  input.context.identity_digest = 'sha256:' + 'a'.repeat(64);
  assert.equal(validateCallRequest(input).context.identity_digest, input.context.identity_digest);
});

test('canonical digests are independent of object insertion order', () => {
  assert.equal(digestValue({ a: 1, b: [2, { x: 3, y: 4 }] }), digestValue({ b: [2, { y: 4, x: 3 }], a: 1 }));
  assert.notEqual(digestValue({ a: '1' }), digestValue({ a: 1 }));
});

for (const [label, mutate] of [
  ['wrong chain', r => { r.chain_id = 1; }],
  ['latest block', r => { r.block.number = 'latest'; }],
  ['missing block hash', r => { delete r.block.hash; }],
  ['unsafe block number', r => { r.block.number = Number.MAX_SAFE_INTEGER + 1; }],
  ['state override', r => { r.stateOverrides = {}; }],
  ['nonce mutation', r => { r.transaction.nonce = '0x1'; }],
  ['contract creation', r => { delete r.transaction.to; }],
  ['zero caller', r => { r.transaction.from = address(0); }],
  ['odd calldata', r => { r.transaction.data = '0x123'; }],
  ['excess gas', r => { r.transaction.gas = '0x5f5e101'; }],
  ['noncanonical quantity', r => { r.transaction.value = '0x00'; }],
  ['overflow value', r => { r.transaction.value = '0x1' + '0'.repeat(64); }],
  ['too many balances', r => { r.balance_tokens = Array.from({ length: 17 }, (_, i) => ({ address: address(i + 3), owner: address(1) })); }],
  ['duplicate balance', r => { r.balance_tokens.push(r.balance_tokens[0]); }],
  ['native currency as ERC20 balance token', r => { r.balance_tokens[0].address = address(0); }],
  ['zero balance owner', r => { r.balance_tokens[0].owner = address(0); }],
  ['unobserved expectation owner', r => { r.expectations[0].owner = address(4); }],
  ['reversed bounds', r => { r.expectations[0].minimum_delta = '21'; }],
  ['floating bounds', r => { r.expectations[0].minimum_delta = '0.1'; }],
  ['unknown wallet context', r => { r.context.wallet_context = 'privileged'; }]
]) {
  test('rejects ' + label + ' before any RPC', async () => {
    const input = request(); mutate(input);
    let count = 0;
    await assert.rejects(() => simulateCall(input, { rpc: async () => { count++; } }), TypeError);
    assert.equal(count, 0);
  });
}

test('collects a pinned call without inferring wallet balance deltas from storage', async () => {
  const input = request();
  const p = provider();
  const result = await simulateCall(input, p);
  assert.equal(result.status, 'CALL_SUCCEEDED_AT_BLOCK');
  assert.equal(result.call.return_data, '0x1234');
  assert.equal(result.token_balances_before[0].raw, '100');
  assert.equal(result.native_balance_before.raw, '1000000000000000000');
  assert.equal(result.wallet_deltas.status, 'UNKNOWN');
  assert.equal(result.wallet_deltas.rows[0].delta, null);
  assert.equal(result.expectations.status, 'UNVERIFIED');
  assert.equal(result.trace.state_diff.status, 'OBSERVED');
  assert.equal(result.target_code_hash.length, 66);
  assert.equal(result.request_digest, digestValue(input));
  const { evidence_digest, ...rest } = result;
  assert.equal(evidence_digest, digestValue(rest));
  assert.deepEqual(input, request());
});

test('native expectations are allowed only for explicitly tracked wallet owners', () => {
  const input = request();
  input.expectations.push({ token: address(0), owner: address(1), minimum_delta: '-100000', maximum_delta: '0' });
  assert.deepEqual(validateCallRequest(input), input);
  input.expectations.at(-1).owner = address(20);
  assert.throws(() => validateCallRequest(input), /tracked native owner/);
});

test('uses requireCanonical hash pins for state reads and explicit numbered trace blocks', async () => {
  const p = provider();
  await simulateCall(request(), p);
  const reads = p.calls.filter(c => ['eth_getCode', 'eth_getBalance', 'eth_call'].includes(c.method));
  for (const call of reads) assert.deepEqual(call.params[1], { blockHash: hash(10), requireCanonical: true });
  for (const call of p.calls.filter(c => c.method === 'debug_traceCall')) {
    assert.equal(call.params[1], '0x64');
    assert.deepEqual(call.params[0], request().transaction);
    assert.equal(call.params[2].timeout, '5s');
  }
  const mutation = p.calls.filter(c => /send|sign|set|impersonate|mine/i.test(c.method));
  assert.deepEqual(mutation, []);
  assert.equal(p.calls.at(-1).method, 'eth_getBlockByNumber');
});

test('retains raw bounded RPC responses for independent replay', async () => {
  const result = await simulateCall(request(), provider());
  const call = result.transcript.find(e => e.method === 'eth_call');
  assert.equal(call.result.value, '0x1234');
  assert.equal(call.result.retained, true);
  assert.equal(call.result.sha256.length, 64);
  assert.equal(result.transcript[0].result.value, '0x1237');
});

test('wrong RPC chain stops before contract reads', async () => {
  const p = provider({ intercept: method => method === 'eth_chainId' ? '0x1' : undefined });
  const result = await simulateCall(request(), p);
  assert.equal(result.status, 'INCOMPLETE');
  assert.deepEqual(result.issues, ['CHAIN_UNVERIFIED_OR_MISMATCH']);
  assert.equal(p.calls.length, 1);
});

test('unknown initial block stops before simulation', async () => {
  const p = provider({ intercept: method => method === 'eth_getBlockByNumber' ? null : undefined });
  const result = await simulateCall(request(), p);
  assert.equal(result.status, 'BLOCK_INVALIDATED');
  assert.equal(result.call.status, 'NOT_RUN');
  assert.equal(p.calls.length, 2);
});

test('final header change invalidates otherwise successful calls and traces', async () => {
  const result = await simulateCall(request(), provider({ reorg: true }));
  assert.equal(result.call.status, 'SUCCEEDED');
  assert.equal(result.status, 'BLOCK_INVALIDATED');
  assert.ok(result.issues.includes('FINAL_BLOCK_HASH_UNVERIFIED_OR_MISMATCH'));
});

test('EOA call target is not reported as successful adapter execution', async () => {
  const p = provider({ intercept: method => method === 'eth_getCode' ? '0x' : undefined });
  const result = await simulateCall(request(), p);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.call.status, 'NOT_RUN');
  assert.equal(p.calls.some(c => c.method === 'eth_call'), false);
  assert.equal(p.calls.at(-1).method, 'eth_getBlockByNumber');
});

test('unsupported traces remain explicit partial evidence after a successful call', async () => {
  const result = await simulateCall(request(), provider({ intercept: method => {
    if (method === 'debug_traceCall') throw Object.assign(new Error('method not found'), { code: -32601 });
  } }));
  assert.equal(result.status, 'CALL_SUCCEEDED_AT_BLOCK');
  assert.equal(result.trace.call.status, 'UNAVAILABLE');
  assert.equal(result.trace.call.error.kind, 'UNSUPPORTED');
  assert.equal(result.wallet_deltas.status, 'UNKNOWN');
});

test('EIP-1898 failure never silently falls back to latest or a numeric state call', async () => {
  const p = provider({ intercept: method => {
    if (method === 'eth_getCode') throw Object.assign(new Error('unsupported blockHash'), { code: -32602 });
  } });
  const result = await simulateCall(request(), p);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(p.calls.filter(c => c.method === 'eth_getCode').length, 1);
  assert.equal(result.call.status, 'NOT_RUN');
});

test('reverted call retains hex error evidence but strips provider messages and credentials', async () => {
  const p = provider({ intercept: (method, params) => {
    if (method === 'eth_call' && params[0].data === '0x12345678') throw Object.assign(new Error('execution reverted at https://secret-token@rpc.test/API_KEY'), { code: 3, data: '0xdeadbeef' });
    if (method === 'debug_traceCall' && params[2].tracer === 'callTracer') return { type: 'CALL', from: address(1), to: address(2), input: '0x12345678', output: '0xdeadbeef', error: 'execution reverted' };
  } });
  const result = await simulateCall(request(), p);
  assert.equal(result.status, 'CALL_REVERTED_AT_BLOCK');
  assert.equal(result.call.error.revert_data, '0xdeadbeef');
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
  assert.equal(JSON.stringify(result).includes('API_KEY'), false);
});

test('transport failure is not mislabeled as an EVM revert', async () => {
  const result = await simulateCall(request(), provider({ intercept: (method, params) => {
    if (method === 'eth_call' && params[0].data === '0x12345678') throw new Error('network timeout https://rpc.test/secret');
  } }));
  assert.equal(result.call.status, 'UNAVAILABLE');
  assert.equal(result.call.error.kind, 'TIMEOUT');
  assert.equal(result.status, 'INCOMPLETE');
});

test('trace disagreement blocks a supported-scope interpretation', async () => {
  const result = await simulateCall(request(), provider({ intercept: (method, params) => {
    if (method === 'debug_traceCall' && params[2].tracer === 'callTracer') return { type: 'CALL', from: address(1), to: address(2), input: '0x12345678', output: '0x4321' };
  } }));
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.issues.includes('CALL_TRACE_DISAGREEMENT'));
});

test('trace from another caller is invalid rather than accepted as wallet execution', async () => {
  const result = await simulateCall(request(), provider({ intercept: (method, params) => {
    if (method === 'debug_traceCall' && params[2].tracer === 'callTracer') return { type: 'CALL', from: address(4), to: address(2), input: '0x12345678', output: '0x1234' };
  } }));
  assert.equal(result.trace.call.status, 'INVALID_RESPONSE');
  assert.ok(result.issues.includes('TRACE_INVALID:call'));
});

test('malformed token balance return stays unknown', async () => {
  const result = await simulateCall(request(), provider({ intercept: (method, params) => {
    if (method === 'eth_call' && params[0].data.startsWith('0x70a08231')) return '0x64';
  } }));
  assert.equal(result.token_balances_before[0].status, 'UNAVAILABLE');
  assert.equal(result.token_balances_before[0].raw, null);
  assert.equal(result.wallet_deltas.rows[0].delta, null);
});

test('oversized trace response is summarized and never retained as a complete trace', async () => {
  const result = await simulateCall(request(), provider({ intercept: (method, params) => {
    if (method === 'debug_traceCall' && params[2].tracer === 'callTracer') return { payload: 'a'.repeat(1_048_576) };
  } }));
  assert.equal(result.trace.call.status, 'UNAVAILABLE');
  assert.equal(result.trace.call.error.kind, 'RESPONSE_LIMIT');
  const entry = result.transcript.find(e => e.method === 'debug_traceCall');
  assert.equal(entry.result.retained, false);
  assert.equal(Object.hasOwn(entry.result, 'value'), false);
});

test('deep trace and non-JSON responses are rejected without overflowing digest serialization', async () => {
  const chain = {}; let current = chain;
  for (let i = 0; i < 60; i++) { current.child = {}; current = current.child; }
  const result = await simulateCall(request(), provider({ intercept: method => method === 'debug_traceCall' ? chain : undefined }));
  assert.equal(result.trace.state_diff.status, 'UNAVAILABLE');
  assert.equal(result.trace.state_diff.error.kind, 'RESPONSE_LIMIT');
});

test('malformed eth_call response is not declared successful', async () => {
  const result = await simulateCall(request(), provider({ intercept: (method, params) => {
    if (method === 'eth_call' && params[0].data === '0x12345678') return { success: true };
  } }));
  assert.equal(result.call.status, 'INVALID_RESPONSE');
  assert.equal(result.status, 'INCOMPLETE');
});
