import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRoute, ZERO} from './routes.mjs';
import {collectPreflight, validatePreflight} from './preflight.mjs';
import {digestValue} from './simulation.mjs';
import {keccakHex} from './keccak.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const [TOKEN, OUT, WALLET, PERMIT2, MANAGER, ROUTER] = [17, 34, 102, 119, 136, 153].map(address);
const HASH = '0x' + '11'.repeat(32);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const sig = s => keccakHex(Buffer.from(s)).slice(0, 10);
const SELECTORS = {manager: sig('poolManager()'), balance: '0x70a08231', tokenAllowance: '0xdd62ed3e', permitAllowance: sig('allowance(address,address,address)')};
function built(overrides = {}) {
  return buildRoute({schema_version: 'circuit.route.v1', adapter: 'universal-router-2.1.1-v4', chain_id: 4663,
    block: {number: 1, hash: HASH, timestamp: 100}, router: ROUTER, pool_manager: MANAGER, permit2: PERMIT2,
    wallet: WALLET, recipient: WALLET, wallet_context: 'actual', currency_in: TOKEN,
    hops: [{pool_key: {currency0: TOKEN, currency1: OUT, fee: 3000, tick_spacing: 60, hooks: ZERO}, currency_out: OUT, hook_data: '0x'}],
    amount_in: '1000', minimum_out: '900', deadline: '200', gas: '3000000', ...overrides});
}
function source(options = {}) {
  const requests = []; let headers = 0;
  const rpc = async (method, params) => {
    requests.push({method, params: structuredClone(params)});
    if (options.intercept) {
      const replacement = await options.intercept(method, params, requests);
      if (replacement !== undefined) return replacement;
    }
    if (method === 'eth_chainId') return options.chain ?? '0x1237';
    if (method === 'eth_blockNumber') return '0xa';
    if (method === 'eth_getBlockByNumber') {
      headers++;
      assert.deepEqual(params, ['0x1', false]);
      return {number: '0x1', hash: options.reorg && headers === 2 ? '0x' + '22'.repeat(32) : HASH, timestamp: options.wrongTimestamp ? '0x65' : '0x64'};
    }
    assert.deepEqual(params.at(-1), {blockHash: HASH, requireCanonical: true});
    if (method === 'eth_getCode') return params[0] === WALLET ? (options.walletCode ?? '0x') : (options.missingCode === params[0] ? '0x' : '0x6001600155');
    if (method === 'eth_getBalance') return options.nativeBalance ?? '0xf4240';
    if (method === 'eth_call') {
      const [{to, from, data}] = params;
      assert.equal(from, WALLET);
      if (data.startsWith(SELECTORS.manager)) return '0x' + word(options.manager ?? MANAGER);
      if (data.startsWith(SELECTORS.balance)) return '0x' + word(data.slice(-40) === WALLET.slice(2) ? (options.tokenBalance ?? 1_000_000) : 0);
      if (data.startsWith(SELECTORS.tokenAllowance)) {
        assert.equal(to, TOKEN); assert.equal(data.slice(-40), PERMIT2.slice(2));
        return options.tokenAllowanceResult ?? '0x' + word(options.tokenAllowance ?? 1_000_000);
      }
      if (data.startsWith(SELECTORS.permitAllowance)) {
        assert.equal(to, PERMIT2); assert.equal(data.slice(-40), ROUTER.slice(2));
        return options.permitAllowanceResult ?? '0x' + word(options.permitAmount ?? 1_000_000) + word(options.expiration ?? 10_000) + word(0);
      }
    }
    throw new Error('Unexpected RPC method or call');
  };
  return {rpc, requests};
}
const observed = async (options = {}, route = built()) => {
  const rpcSource = source(options); return {report: await collectPreflight(route, {rpc: rpcSource.rpc}), ...rpcSource, route};
};

test('observes exact block, balances, both approvals and unverified immutable correspondence', async () => {
  const {report, requests, route} = await observed();
  assert.equal(report.status, 'PREFLIGHT_OBSERVED'); assert.equal(report.head_lag_blocks, 9);
  assert.equal(report.source_mapping, 'UNVERIFIED');
  assert.equal(report.router_wiring.pool_manager_matches, true);
  assert.equal(report.router_wiring.permit2_correspondence, 'UNVERIFIED_INTERNAL_IMMUTABLE');
  assert.equal(report.approvals.token_allowance_raw, '1000000'); assert.equal(report.approvals.permit2_amount_raw, '1000000');
  assert.equal(report.balances.length, 4); assert.equal(report.native_balance.gas_affordability, 'UNMEASURED');
  assert.ok(requests.length < 64); assert.ok(requests.every(x => !/send|sign|approve|set|impersonate/i.test(x.method)));
  assert.deepEqual(await validatePreflight(route, report), report);
});

for (const [name, option, code] of [
  ['token approval missing', {tokenAllowance: 0}, 'INSUFFICIENT_TOKEN_TO_PERMIT2_ALLOWANCE'],
  ['Permit2 approval missing', {permitAmount: 0}, 'INSUFFICIENT_PERMIT2_TO_ROUTER_ALLOWANCE'],
  ['Permit2 expires before deadline', {expiration: 199}, 'PERMIT2_EXPIRATION_BEFORE_ROUTE_DEADLINE'],
  ['insufficient wallet input balance', {tokenBalance: 999}, 'INSUFFICIENT_INPUT_TOKEN_BALANCE'],
  ['contract wallet', {walletCode: '0x6000'}, 'WALLET_HAS_CODE_UNSUPPORTED'],
  ['delegated EOA code', {walletCode: '0xef0100' + ROUTER.slice(2)}, 'WALLET_HAS_CODE_UNSUPPORTED'],
  ['missing required contract', {missingCode: MANAGER}, 'REQUIRED_CONTRACT_CODE_MISSING'],
  ['wrong manager wiring', {manager: address(7)}, 'ROUTER_POOL_MANAGER_MISMATCH'],
  ['canonical source reorg', {reorg: true}, 'PINNED_HEADER_CHANGED'],
  ['wrong pinned timestamp', {wrongTimestamp: true}, 'PINNED_HEADER_MISMATCH'],
  ['wrong chain', {chain: '0x1'}, 'CHAIN_ID_MISMATCH']
]) test(name + ' fails closed with reproducible evidence', async () => {
  const {report, route} = await observed(option);
  assert.equal(report.status, 'PREFLIGHT_BLOCKED'); assert.ok(report.issues.some(x => x.code === code));
  assert.deepEqual(await validatePreflight(route, report), report);
});

test('Permit2 expiration equal to deadline is sufficient for the observed window', async () => {
  const {report} = await observed({expiration: 200}); assert.equal(report.status, 'PREFLIGHT_OBSERVED');
});

for (const [name, option] of [
  ['negative allowance value', {tokenAllowanceResult: '-1'}],
  ['empty nonstandard allowance', {tokenAllowanceResult: '0x'}],
  ['trailing allowance words', {tokenAllowanceResult: '0x' + word(1_000_000) + word(0)}],
  ['short Permit2 tuple', {permitAllowanceResult: '0x' + word(1_000_000)}],
  ['Permit2 uint160 overflow', {permitAllowanceResult: '0x' + word(1n << 160n) + word(1000) + word(0)}],
  ['Permit2 uint48 expiration overflow', {permitAllowanceResult: '0x' + word(1000) + word(1n << 48n) + word(0)}],
  ['Permit2 uint48 nonce overflow', {permitAllowanceResult: '0x' + word(1000) + word(1000) + word(1n << 48n)}]
]) test(name + ' is incomplete rather than assumed standard', async () => {
  const {report, route} = await observed(option);
  assert.equal(report.status, 'INCOMPLETE'); assert.ok(report.issues.some(x => x.code === 'NONSTANDARD_OR_MALFORMED_RESPONSE'));
  assert.deepEqual(await validatePreflight(route, report), report);
});

test('expected code hashes compare exact participants but cannot verify source mapping', async () => {
  const route = built(), rpcSource = source();
  const expected = keccakHex(Buffer.from('6001600155', 'hex'));
  const report = await collectPreflight(route, {rpc: rpcSource.rpc, expected_code_hashes: {[ROUTER]: expected}});
  assert.equal(report.status, 'PREFLIGHT_OBSERVED'); assert.equal(report.source_mapping, 'UNVERIFIED');
  assert.equal(report.code_hashes.find(x => x.address === ROUTER).expected_hash_matches, true);
  assert.deepEqual(await validatePreflight(route, report), report);
  const mismatch = await collectPreflight(route, {rpc: source().rpc, expected_code_hashes: {[ROUTER]: HASH}});
  assert.equal(mismatch.status, 'PREFLIGHT_BLOCKED'); assert.ok(mismatch.issues.some(x => x.code === 'EXPECTED_CODE_HASH_MISMATCH'));
  await validatePreflight(route, mismatch);
  await assert.rejects(collectPreflight(route, {rpc: source().rpc, expected_code_hashes: {[address(999)]: HASH}}), /participant/);
});

test('source response limit is enforced before retention and is replayable', async () => {
  const {report, route} = await observed({intercept: (method) => method === 'eth_getCode' ? '0x' + 'aa'.repeat(131_072) : undefined});
  assert.equal(report.status, 'INCOMPLETE'); assert.ok(report.issues.some(x => x.code === 'RPC_RESPONSE_LIMIT_OR_INVALID_JSON'));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 20_000);
  await validatePreflight(route, report);
});

test('provider errors retain controlled codes and revert bytes without leaking provider prose', async () => {
  const {report, route} = await observed({intercept: method => {
    if (method === 'eth_getCode') { const e = new Error('https://secret:password@provider.example?api_key=secret123 execution reverted'); e.code = 3; e.data = '0x1234'; throw e; }
  }});
  assert.equal(report.status, 'INCOMPLETE'); assert.ok(!JSON.stringify(report).includes('secret'));
  assert.deepEqual(report.observations.find(x => x.error).error, {kind: 'REVERT', code: 3, revert_data: '0x1234'});
  await validatePreflight(route, report);
});

test('hash-pinned method unsupported never falls back to latest', async () => {
  const {report, requests, route} = await observed({intercept: method => {
    if (method === 'eth_getCode') { const e = new Error('method unsupported'); e.code = -32602; throw e; }
  }});
  assert.equal(report.status, 'INCOMPLETE'); assert.ok(!JSON.stringify(requests).includes('latest'));
  await validatePreflight(route, report);
});

test('native input skips Permit2 approvals and checks exact transaction value', async () => {
  const route = built({currency_in: ZERO, hops: [{pool_key: {currency0: ZERO, currency1: TOKEN, fee: 3000, tick_spacing: 60, hooks: ZERO}, currency_out: TOKEN, hook_data: '0x'}]});
  const {report, requests} = await observed({nativeBalance: '0x3e7'}, route);
  assert.equal(report.status, 'PREFLIGHT_BLOCKED'); assert.equal(report.approvals.status, 'NOT_REQUIRED_NATIVE_INPUT');
  assert.ok(report.issues.some(x => x.code === 'INSUFFICIENT_NATIVE_VALUE_BALANCE'));
  assert.ok(!requests.some(x => x.method === 'eth_call' && x.params[0].data.startsWith(SELECTORS.permitAllowance)));
  await validatePreflight(route, report);
});

test('validator rejects changed derived conclusions even with a recomputed digest', async () => {
  const {report, route} = await observed({tokenAllowance: 0});
  report.status = 'PREFLIGHT_OBSERVED'; report.issues = [];
  delete report.evidence_digest; report.evidence_digest = digestValue(report);
  await assert.rejects(validatePreflight(route, report), /replay|findings/);
});

test('validator binds the exact build, transcript and observation coverage', async () => {
  const {report, route} = await observed();
  await assert.rejects(validatePreflight(built({amount_in: '1001'}), report), /replay|findings/);
  const tamper = structuredClone(report); tamper.observations.pop(); delete tamper.evidence_digest; tamper.evidence_digest = digestValue(tamper);
  await assert.rejects(validatePreflight(route, tamper), /replay|findings/);
  const extra = structuredClone(report); extra.injected = true; delete extra.evidence_digest; extra.evidence_digest = digestValue(extra);
  await assert.rejects(validatePreflight(route, extra), /replay|findings/);
});
