import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, inspectDeployment, compareIdentity, MANAGER, ZERO, SLOTS, identityHash } from './identity.mjs';
import { keccakHex } from './keccak.mjs';

const address = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const hash = c => '0x' + c.repeat(64);
const HOOK = address(0xc0), T0 = address(1), T1 = address(2), IMPL = address(0x9000), ADMIN = address(0x9001), BEACON = address(0x9002);
const CODE = '0x60006000', CODE2 = '0x60016000';
const kh = c => keccakHex(Buffer.from(c.slice(2), 'hex'));
const word = a => '0x' + a.slice(2).padStart(64, '0');
function setPoolId(m) { m.pool.pool_id = kh('0x' + [m.pool.currency0, m.pool.currency1, '0x' + m.pool.fee.toString(16), '0x' + m.pool.tick_spacing.toString(16), m.pool.hooks].map(x => x.slice(2).padStart(64, '0')).join('')); return m; }
function manifest() {
  return setPoolId({schema_version: 'hook-lab.deployment.v1', chain_id: 4663, block: {number: 100, hash: hash('a')}, pool: {pool_id: hash('a'), currency0: T0, currency1: T1, fee: 3000, tick_spacing: 60, hooks: HOOK}, contracts: [
    {role: 'manager', address: MANAGER, expected_code_hash: kh(CODE), proxy_kind: 'none'},
    {role: 'hook', address: HOOK, expected_code_hash: kh(CODE), proxy_kind: 'none'},
    ...[T0, T1].map(a => ({role: 'token', address: a, expected_code_hash: kh(CODE), proxy_kind: 'none'})),
  ], checks: [{id: 'hook-paused', to: HOOK, data: '0x12345678', expected_result: '0x00'}], source_refs: ['https://example.test/pinned-independent-build'], dependency_scope: 'reviewed'});
}
function proxy(m, kind = 'eip1967') {
  const c = m.contracts.find(c => c.role === 'hook');
  c.proxy_kind = kind; c.implementation = {address: IMPL, expected_code_hash: kh(CODE)};
  if (kind === 'eip1967') c.expected_admin = ADMIN;
  return c;
}
function harness(m, options = {}) {
  const calls = [];
  let headers = 0;
  const rpc = async (method, params) => {
    calls.push({method, params: structuredClone(params)});
    if (options.throwMethod === method) throw new Error('secret https://provider.test/SECRET');
    if (method === 'eth_chainId') return options.chainId ?? '0x1237';
    if (method === 'eth_getBlockByNumber') {
      headers++;
      return {number: '0x' + m.block.number.toString(16), hash: options.reorg && headers > 1 ? hash('d') : m.block.hash, parentHash: options.parentHash ?? hash('b'), timestamp: '0x' + (options.timestamp ?? 1000).toString(16)};
    }
    const pin = params.at(-1);
    assert.deepEqual(pin, {blockHash: m.block.hash, requireCanonical: true});
    if (method === 'eth_getCode') return options.codes?.[params[0]] ?? CODE;
    if (method === 'eth_getStorageAt') {
      if (options.storage) return options.storage[params[1]] ?? word(ZERO);
      return params[1] === SLOTS.implementation ? word(IMPL) : params[1] === SLOTS.admin ? word(ADMIN) : word(ZERO);
    }
    if (method === 'eth_call') return params[0].data === '0x5c60da1b' ? word(options.beaconImplementation ?? IMPL) : options.checkResult ?? '0x00';
    throw new Error('unexpected method ' + method);
  };
  return {rpc, calls};
}
async function inspect(m = manifest(), options = {}) { const h = harness(m, options); return {result: await inspectDeployment(m, h), calls: h.calls}; }

test('binds code, exact config bytes and every state read to canonical block', async () => {
  const m = manifest(); const {result: r, calls} = await inspect(m);
  assert.equal(r.status, 'IDENTITY_MATCH_AT_BLOCK'); assert.equal(r.qualified_for_identity, true); assert.equal(r.qualified_for_execution, false);
  assert.equal(r.canonical_rechecked, true); assert.equal(r.observations.length, 4); assert.equal(calls.length, 8);
  assert.equal(r.evidence_digest, identityHash(r.evidence)); assert.equal(r.evidence.length, calls.length);
  for (const {digest, ...entry} of r.evidence) assert.equal(digest, identityHash(entry));
  assert.equal(r.manifest_digest, identityHash(validateManifest(m)));
});
test('normalizes unordered records and case to deterministic identity', async () => {
  const m = manifest(), altered = structuredClone(m); altered.contracts.reverse(); altered.pool.hooks = altered.pool.hooks.toUpperCase().replace('0X', '0x');
  const a = (await inspect(m)).result, b = (await inspect(altered)).result; assert.equal(a.identity_digest, b.identity_digest); assert.equal(a.manifest_digest, b.manifest_digest);
});
test('rejects forged PoolKey pool ID', () => { const m = manifest(); m.pool.pool_id = hash('f'); assert.throws(() => validateManifest(m), /PoolKey hash/); });
test('rejects malformed expected hash before network use', async () => { const m = manifest(); m.contracts[0].expected_code_hash = '0x12'; let called = false; await assert.rejects(inspectDeployment(m, {rpc() {called = true;}}), /32-byte/); assert.equal(called, false); });
test('requires integer mainnet chain ID', () => { const m = manifest(); m.chain_id = '4663'; assert.throws(() => validateManifest(m), /4663/); });
test('rejects misspelled fields so config expectations cannot silently disappear', () => { const m = manifest(); m.contracts[0].expectedCodeHash = kh(CODE); assert.throws(() => validateManifest(m), /unknown field/); });
test('rejects swapped or identical currencies', () => { for (const c0 of [T1, address(3)]) { const m = manifest(); m.pool.currency0 = c0; assert.throws(() => validateManifest(m), /sorted/); } });
test('rejects wrong manager even when its code matches', () => { const m = manifest(); m.contracts[0].address = address(100); assert.throws(() => validateManifest(m), /canonical Robinhood manager/); });
test('requires PoolKey hook in dependency list', () => { const m = manifest(); m.contracts[1].address = address(0x4000c0); assert.throws(() => validateManifest(m), /exact PoolKey hook/); });
test('requires code expectations for each ERC20 currency', () => { const m = manifest(); m.contracts.pop(); assert.throws(() => validateManifest(m), /nonnative currency/); });
test('native currency needs no code expectation', async () => { const m = manifest(); m.pool.currency0 = ZERO; m.contracts = m.contracts.filter(c => c.address !== T0); setPoolId(m); assert.equal((await inspect(m)).result.status, 'IDENTITY_MATCH_AT_BLOCK'); });
test('allows zero hook only with static fee and without hook record', async () => { const m = manifest(); m.pool.hooks = ZERO; m.contracts = m.contracts.filter(c => c.role !== 'hook'); m.checks = []; setPoolId(m); assert.equal((await inspect(m)).result.status, 'IDENTITY_MATCH_AT_BLOCK'); m.pool.fee = 0x800000; setPoolId(m); assert.throws(() => validateManifest(m), /dynamic fee/); });
test('validates all return delta flag dependencies', () => { for (const flag of [1, 2, 4, 8]) { const m = manifest(); m.pool.hooks = address(flag); m.contracts[1].address = address(flag); setPoolId(m); assert.throws(() => validateManifest(m), /delta requires/); } });
test('rejects nonzero static hook without permission flags', () => { const m = manifest(); m.pool.hooks = address(0x4000); m.contracts[1].address = m.pool.hooks; setPoolId(m); assert.throws(() => validateManifest(m), /needs permissions/); });
test('allows dynamic fee hook without callback flags', () => { const m = manifest(); m.pool.hooks = address(0x4000); m.contracts[1].address = m.pool.hooks; m.checks = []; m.pool.fee = 0x800000; setPoolId(m); assert.equal(validateManifest(m).pool.fee, 0x800000); });
test('rejects invalid fee and tick spacing', () => { for (const [key, value] of [['fee', 1000001], ['fee', 0xc00000], ['tick_spacing', 0], ['tick_spacing', -1], ['tick_spacing', 32768]]) { const m = manifest(); m.pool[key] = value; assert.throws(() => validateManifest(m)); } });
test('rejects duplicate contract or config IDs', () => { const m = manifest(); m.contracts.push(m.contracts[0]); assert.throws(() => validateManifest(m), /duplicate contract/); const m2 = manifest(); m2.checks.push(m2.checks[0]); assert.throws(() => validateManifest(m2), /duplicate check/); });
test('rejects unknown config call target and malformed calldata', () => { const m = manifest(); m.checks[0].to = address(99999); assert.throws(() => validateManifest(m), /reviewed contract graph/); const m2 = manifest(); m2.checks[0].data = '0x1'; assert.throws(() => validateManifest(m2), /hex bytes/); });
test('bounds work to 50 total reads', () => { const m = manifest(); m.checks = Array.from({length: 44}, (_, i) => ({...m.checks[0], id: 'c' + i})); assert.throws(() => validateManifest(m), /50-call/); });
test('wrong RPC chain stops before contract reads', async () => { const {result: r, calls} = await inspect(manifest(), {chainId: '0x1'}); assert.equal(r.qualified_for_identity, false); assert.equal(calls.length, 1); });
test('missing code never qualifies even when expected hash is empty-code hash', async () => { const m = manifest(); m.contracts[1].expected_code_hash = kh('0x'); const r = (await inspect(m, {codes: {[HOOK]: '0x'}})).result; assert.ok(r.problems.some(p => p.code === 'MISSING_CODE')); assert.equal(r.qualified_for_identity, false); });
test('runtime hash mismatch prevents identity qualification', async () => { const r = (await inspect(manifest(), {codes: {[HOOK]: CODE2}})).result; assert.ok(r.problems.some(p => p.code === 'CODE_HASH_MISMATCH')); });
test('unknown dependency review fails qualification', async () => { const m = manifest(); m.dependency_scope = 'unknown'; assert.ok((await inspect(m)).result.problems.some(p => p.code === 'DEPENDENCY_SCOPE_UNKNOWN')); });
test('unknown proxy kind fails qualification', async () => { const m = manifest(); m.contracts[1].proxy_kind = 'unknown'; assert.ok((await inspect(m)).result.problems.some(p => p.code === 'UNKNOWN_PROXY_KIND')); });
test('reorg at final canonical header check invalidates all reads', async () => { const r = (await inspect(manifest(), {reorg: true})).result; assert.equal(r.canonical_rechecked, false); assert.equal(r.qualified_for_identity, false); });
test('RPC failures are retained without leaking credential-bearing error messages', async () => { const r = (await inspect(manifest(), {throwMethod: 'eth_getCode'})).result; assert.ok(r.problems.some(p => p.code === 'RPC_UNAVAILABLE')); assert.equal(JSON.stringify(r).includes('SECRET'), false); assert.ok(r.evidence.at(-1).error); });
test('config mismatch invalidates identity with exact bytes', async () => { const r = (await inspect(manifest(), {checkResult: '0x0000'})).result; assert.ok(r.problems.some(p => p.code === 'CONFIG_RESULT_MISMATCH')); });
test('config preserves explicit caller and native value', async () => { const m = manifest(); m.checks[0].from = address(900); m.checks[0].value = '0x10'; const {result: r, calls} = await inspect(m); const call = calls.find(c => c.method === 'eth_call'); assert.equal(call.params[0].from, address(900)); assert.equal(call.params[0].value, '0x10'); assert.equal(r.checks[0].from, address(900)); });
test('EIP1967 reads admin implementation and beacon slots, then implementation code', async () => { const m = manifest(); proxy(m); const {result: r, calls} = await inspect(m); assert.equal(r.status, 'IDENTITY_MATCH_AT_BLOCK'); assert.equal(calls.filter(c => c.method === 'eth_getStorageAt').length, 3); const h = r.observations.find(o => o.role === 'hook'); assert.equal(h.implementation.address, IMPL); assert.equal(h.admin, ADMIN); });
test('EIP1967 changed implementation address invalidates even identical implementation code', async () => { const m = manifest(); proxy(m); const r = (await inspect(m, {storage: {[SLOTS.implementation]: word(address(0x9003)), [SLOTS.admin]: word(ADMIN)}})).result; assert.ok(r.problems.some(p => p.code === 'IMPLEMENTATION_ADDRESS_MISMATCH')); });
test('EIP1967 changed implementation code invalidates unchanged address', async () => { const m = manifest(); proxy(m); assert.ok((await inspect(m, {codes: {[IMPL]: CODE2}})).result.problems.some(p => p.code === 'CODE_HASH_MISMATCH' && p.subject === IMPL)); });
test('EIP1967 missing admin expectation remains unqualified', async () => { const m = manifest(); const c = proxy(m); delete c.expected_admin; assert.ok((await inspect(m)).result.problems.some(p => p.code === 'UNKNOWN_PROXY_ADMIN_EXPECTATION')); });
test('EIP1967 changed admin invalidates', async () => { const m = manifest(); proxy(m); assert.ok((await inspect(m, {storage: {[SLOTS.implementation]: word(IMPL)}})).result.problems.some(p => p.code === 'PROXY_ADMIN_MISMATCH')); });
test('EIP1967 missing implementation dependency remains unqualified', async () => { const m = manifest(); const c = proxy(m); delete c.implementation; assert.ok((await inspect(m)).result.problems.some(p => p.code === 'UNREVIEWED_IMPLEMENTATION')); });
test('EIP1967 rejects noncanonical address words and no implementation', async () => { const m = manifest(); proxy(m); const malformed = (await inspect(m, {storage: {[SLOTS.implementation]: hash('f')}})).result; assert.equal(malformed.qualified_for_identity, false); const missing = (await inspect(m, {storage: {[SLOTS.admin]: word(ADMIN)}})).result; assert.ok(missing.problems.some(p => p.code === 'MISSING_PROXY_IMPLEMENTATION')); });
test('EIP1967 simultaneous beacon and implementation is ambiguous', async () => { const m = manifest(); proxy(m); const r = (await inspect(m, {storage: {[SLOTS.implementation]: word(IMPL), [SLOTS.admin]: word(ADMIN), [SLOTS.beacon]: word(BEACON)}})).result; assert.ok(r.problems.some(p => p.code === 'AMBIGUOUS_EIP1967_SLOTS')); });
test('unreviewed beacon is observed but unqualified', async () => { const m = manifest(); proxy(m); const r = (await inspect(m, {storage: {[SLOTS.admin]: word(ADMIN), [SLOTS.beacon]: word(BEACON)}})).result; assert.ok(r.problems.some(p => p.code === 'UNREVIEWED_BEACON')); });
test('reviewed beacon binds proxy caller, beacon code and returned implementation', async () => { const m = manifest(); const c = proxy(m); c.beacon = {address: BEACON, expected_code_hash: kh(CODE)}; const {result: r, calls} = await inspect(m, {storage: {[SLOTS.admin]: word(ADMIN), [SLOTS.beacon]: word(BEACON)}}); assert.equal(r.status, 'IDENTITY_MATCH_AT_BLOCK'); const beaconCall = calls.find(x => x.method === 'eth_call' && x.params[0].data === '0x5c60da1b'); assert.equal(beaconCall.params[0].from, HOOK); assert.equal(r.observations.find(o => o.role === 'hook').beacon.address, BEACON); });
test('beacon address upgrade is detected despite unchanged bytecode', async () => { const m = manifest(); const c = proxy(m); c.beacon = {address: address(0x9999), expected_code_hash: kh(CODE)}; assert.ok((await inspect(m, {storage: {[SLOTS.admin]: word(ADMIN), [SLOTS.beacon]: word(BEACON)}})).result.problems.some(p => p.code === 'BEACON_ADDRESS_MISMATCH')); });
test('standard EIP1167 clone resolves exact target', async () => { const m = manifest(); const c = proxy(m, 'eip1167'); const clone = '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3'; c.expected_code_hash = kh(clone); const r = (await inspect(m, {codes: {[HOOK]: clone}})).result; assert.equal(r.status, 'IDENTITY_MATCH_AT_BLOCK'); assert.equal(r.observations.find(o => o.role === 'hook').implementation.address, IMPL); });
test('nonstandard EIP1167 runtime is not guessed', async () => { const m = manifest(); proxy(m, 'eip1167'); assert.ok((await inspect(m)).result.problems.some(p => p.code === 'NONSTANDARD_EIP1167_RUNTIME')); });
test('obvious clone cannot be mislabeled none and qualify', async () => { const m = manifest(); const clone = '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3'; m.contracts[1].expected_code_hash = kh(clone); assert.ok((await inspect(m, {codes: {[HOOK]: clone}})).result.problems.some(p => p.code === 'UNDECLARED_EIP1167_PROXY')); });
test('same-block comparison is compatible but never execution permission', async () => { const r = (await inspect()).result; const c = compareIdentity(r, r); assert.equal(c.status, 'COMPATIBLE_OBSERVATIONS_AT_BLOCK'); assert.equal(c.continuity, 'SAME_BLOCK'); assert.equal(c.qualified_for_execution, false); });
test('adjacent blocks verify parent linkage without requiring same manifest hash', async () => { const m = manifest(); const a = (await inspect(m)).result; m.block = {number: 101, hash: hash('c')}; const b = (await inspect(m, {parentHash: a.block.hash, timestamp: 1001})).result; const c = compareIdentity(a, b); assert.equal(c.status, 'COMPATIBLE_OBSERVATIONS_AT_BLOCK'); assert.equal(c.continuity, 'ADJACENT_PARENT_LINK'); assert.equal(c.seconds_elapsed, 1); assert.notEqual(a.manifest_digest, b.manifest_digest); });
test('separated matching observations cannot prove intermediate continuity', async () => { const m = manifest(); const a = (await inspect(m)).result; m.block.number = 104; m.block.hash = hash('c'); const b = (await inspect(m, {timestamp: 1004})).result; assert.equal(compareIdentity(a, b).continuity, 'UNPROVEN'); });
test('updated expected config does not hide compatibility changes', async () => { const m = manifest(); const a = (await inspect(m)).result; m.block.number = 102; m.block.hash = hash('c'); m.checks[0].expected_result = '0x01'; const b = (await inspect(m, {checkResult: '0x01', timestamp: 1002})).result; assert.equal(b.status, 'IDENTITY_MATCH_AT_BLOCK'); assert.equal(compareIdentity(a, b).status, 'INVALIDATED'); });
test('updated code expectations do not hide implementation changes', async () => { const m = manifest(); proxy(m); const a = (await inspect(m)).result; m.contracts.find(c => c.role === 'hook').implementation.expected_code_hash = kh(CODE2); const b = (await inspect(m, {codes: {[IMPL]: CODE2}})).result; assert.equal(b.status, 'IDENTITY_MATCH_AT_BLOCK'); assert.equal(compareIdentity(a, b).status, 'INVALIDATED'); });
test('same-height fork or wrong adjacent parent invalidates comparison', async () => { const m = manifest(); const a = (await inspect(m)).result; m.block.hash = hash('c'); const b = (await inspect(m)).result; assert.ok(compareIdentity(a, b).changes.includes('SAME_HEIGHT_DIFFERENT_HASH')); m.block.number = 101; const c = (await inspect(m)).result; assert.ok(compareIdentity(a, c).changes.includes('ADJACENT_PARENT_MISMATCH')); });
test('older block or timestamp cannot refresh identity', async () => { const m = manifest(); const a = (await inspect(m)).result; m.block.number = 99; m.block.hash = hash('c'); const b = (await inspect(m, {timestamp: 999})).result; assert.ok(compareIdentity(a, b).changes.includes('OBSERVATION_MOVED_BACKWARD')); });
test('tampered observations, block or raw transcript fail comparison', async () => { const a = (await inspect()).result; for (const kind of ['observation', 'block', 'evidence']) { const b = structuredClone(a); if (kind === 'observation') b.observations[0].code_hash = hash('f'); if (kind === 'block') b.block.timestamp++; if (kind === 'evidence') b.evidence[0].response = '0x1'; assert.equal(compareIdentity(a, b).status, 'INSUFFICIENT_EVIDENCE'); } });
test('unqualified inspection cannot refresh prior qualification', async () => { const a = (await inspect()).result; const b = (await inspect(manifest(), {checkResult: '0x01'})).result; assert.equal(compareIdentity(a, b).status, 'INSUFFICIENT_EVIDENCE'); });
test('malformed compatibility evidence returns insufficient without throwing', async () => { const a = (await inspect()).result; for (const value of [undefined, null, {}, {...a, evidence: undefined}, {...a, block: null}]) assert.equal(compareIdentity(a, value).status, 'INSUFFICIENT_EVIDENCE'); });
test('rejects zero implementation references and values above uint256', () => { const m = manifest(); proxy(m).implementation.address = ZERO; assert.throws(() => validateManifest(m), /deployed contract/); const m2 = manifest(); m2.checks[0].value = '0x1' + '0'.repeat(64); assert.throws(() => validateManifest(m2), /uint256/); });
