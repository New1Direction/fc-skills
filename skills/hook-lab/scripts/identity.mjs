import { createHash } from 'node:crypto';
import { keccakHex } from './keccak.mjs';

export const MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const ZERO = '0x' + '0'.repeat(40);
export const SLOTS = Object.freeze({
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
});
const own = (v, k) => Object.hasOwn(v, k);
function assert(ok, message) { if (!ok) throw new Error(message); }
function object(v, name) { assert(v && typeof v === 'object' && !Array.isArray(v), `${name} must be an object`); }
function fields(v, allowed, name) { object(v, name); for (const k of Object.keys(v)) assert(allowed.includes(k), `${name}: unknown field ${k}`); }
function hex(v, n, name) { assert(typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(v), `${name} must be ${n}-byte hex`); return v.toLowerCase(); }
function bytes(v, name, max = 65536) { assert(typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v) && v.length <= max * 2 + 2, `${name} must be bounded hex bytes`); return v.toLowerCase(); }
function integer(v, min, max, name) { assert(Number.isSafeInteger(v) && v >= min && v <= max, `${name} outside range`); return v; }
function quantity(v, name) { assert(typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v), `${name} must be an RPC quantity`); return BigInt(v); }
function stable(v) { if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'; return JSON.stringify(v); }
export const identityHash = value => 'sha256:' + createHash('sha256').update(stable(value)).digest('hex');
const codeHash = code => keccakHex(Buffer.from(bytes(code, 'runtime bytecode', 1000000).slice(2), 'hex'));
function ref(v, name) { fields(v, ['address', 'expected_code_hash'], name); const address = hex(v.address, 20, name + '.address'); assert(address !== ZERO, name + ' must identify a deployed contract'); return {address, expected_code_hash: hex(v.expected_code_hash, 32, name + '.expected_code_hash')}; }
function poolKey(pool) {
  fields(pool, ['pool_id', 'currency0', 'currency1', 'fee', 'tick_spacing', 'hooks'], 'pool');
  const p = {pool_id: hex(pool.pool_id, 32, 'pool.pool_id'), currency0: hex(pool.currency0, 20, 'pool.currency0'), currency1: hex(pool.currency1, 20, 'pool.currency1'), fee: integer(pool.fee, 0, 0xffffff, 'pool.fee'), tick_spacing: integer(pool.tick_spacing, 1, 32767, 'pool.tick_spacing'), hooks: hex(pool.hooks, 20, 'pool.hooks')};
  assert(BigInt(p.currency0) < BigInt(p.currency1), 'currencies must be strictly sorted');
  assert(p.fee <= 1000000 || p.fee === 0x800000, 'invalid V4 fee');
  const flags = Number(BigInt(p.hooks) & 0x3fffn);
  assert(!(flags & 8) || !!(flags & 128), 'beforeSwap delta requires beforeSwap');
  assert(!(flags & 4) || !!(flags & 64), 'afterSwap delta requires afterSwap');
  assert(!(flags & 2) || !!(flags & 1024), 'afterAddLiquidity delta requires afterAddLiquidity');
  assert(!(flags & 1) || !!(flags & 256), 'afterRemoveLiquidity delta requires afterRemoveLiquidity');
  assert(p.hooks !== ZERO || p.fee !== 0x800000, 'dynamic fee needs a nonzero hook');
  assert(p.hooks === ZERO || flags !== 0 || p.fee === 0x800000, 'nonzero static-fee hook needs permissions');
  const words = [p.currency0, p.currency1, '0x' + p.fee.toString(16), '0x' + p.tick_spacing.toString(16), p.hooks].map(v => v.slice(2).padStart(64, '0')).join('');
  assert(keccakHex(Buffer.from(words, 'hex')) === p.pool_id, 'PoolKey hash does not match pool_id');
  return p;
}

/** Validate independently prepared expectations; never derives trusted hashes from an RPC. */
export function validateManifest(input) {
  fields(input, ['schema_version', 'chain_id', 'block', 'pool', 'contracts', 'checks', 'source_refs', 'dependency_scope'], 'manifest');
  assert(input.schema_version === 'hook-lab.deployment.v1', 'unsupported deployment schema');
  assert(input.chain_id === 4663, 'only Robinhood Chain 4663 is supported');
  fields(input.block, ['number', 'hash'], 'block');
  const block = {number: integer(input.block.number, 0, Number.MAX_SAFE_INTEGER, 'block.number'), hash: hex(input.block.hash, 32, 'block.hash')};
  const pool = poolKey(input.pool);
  assert(Array.isArray(input.contracts) && input.contracts.length > 0 && input.contracts.length <= 20, 'contracts must contain 1 to 20 records');
  const contracts = input.contracts.map((c, i) => {
    const label = `contracts[${i}]`;
    fields(c, ['role', 'address', 'expected_code_hash', 'proxy_kind', 'implementation', 'beacon', 'expected_admin'], label);
    assert(['manager', 'hook', 'router', 'token', 'dependency'].includes(c.role), 'invalid contract role');
    assert(['none', 'eip1967', 'eip1167', 'unknown'].includes(c.proxy_kind), 'invalid proxy_kind');
    const row = {role: c.role, address: hex(c.address, 20, label + '.address'), expected_code_hash: hex(c.expected_code_hash, 32, label + '.expected_code_hash'), proxy_kind: c.proxy_kind};
    assert(row.address !== ZERO, 'native currency is not a deployed contract');
    if (own(c, 'implementation')) row.implementation = ref(c.implementation, label + '.implementation');
    if (own(c, 'beacon')) row.beacon = ref(c.beacon, label + '.beacon');
    if (own(c, 'expected_admin')) row.expected_admin = hex(c.expected_admin, 20, label + '.expected_admin');
    if (c.proxy_kind === 'none') assert(!own(c, 'implementation') && !own(c, 'beacon') && !own(c, 'expected_admin'), 'none cannot include proxy expectations');
    if (c.proxy_kind === 'eip1167') assert(!own(c, 'beacon') && !own(c, 'expected_admin'), 'eip1167 does not use EIP1967 expectations');
    return row;
  }).sort((a, b) => a.address.localeCompare(b.address));
  assert(new Set(contracts.map(c => c.address)).size === contracts.length, 'duplicate contract address');
  const managers = contracts.filter(c => c.role === 'manager');
  assert(managers.length === 1 && managers[0].address === MANAGER, 'exact canonical Robinhood manager required');
  const hooks = contracts.filter(c => c.role === 'hook');
  assert(pool.hooks === ZERO ? hooks.length === 0 : hooks.length === 1 && hooks[0].address === pool.hooks, 'hook role must bind exact PoolKey hook');
  for (const currency of [pool.currency0, pool.currency1]) if (currency !== ZERO) assert(contracts.some(c => c.role === 'token' && c.address === currency), 'each nonnative currency requires a token code expectation');
  assert(Array.isArray(input.checks) && input.checks.length <= 50, 'checks must be an array with at most 50 entries');
  const knownAddresses = new Set(contracts.flatMap(c => [c.address, c.implementation?.address, c.beacon?.address].filter(Boolean)));
  const checks = input.checks.map((c, i) => {
    fields(c, ['id', 'to', 'data', 'expected_result', 'from', 'value'], `checks[${i}]`);
    assert(typeof c.id === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(c.id), 'invalid check id');
    const row = {id: c.id, to: hex(c.to, 20, 'check.to'), data: bytes(c.data, 'check.data'), expected_result: bytes(c.expected_result, 'check.expected_result')};
    assert(knownAddresses.has(row.to), 'check target must be in the reviewed contract graph');
    if (own(c, 'from')) row.from = hex(c.from, 20, 'check.from');
    if (own(c, 'value')) { const value = quantity(c.value, 'check.value'); assert(value < (1n << 256n), 'check.value outside uint256'); row.value = '0x' + value.toString(16); }
    return row;
  }).sort((a, b) => a.id.localeCompare(b.id));
  assert(new Set(checks.map(c => c.id)).size === checks.length, 'duplicate check id');
  assert(Array.isArray(input.source_refs) && input.source_refs.length >= 1 && input.source_refs.length <= 50, 'source_refs must contain 1 to 50 entries');
  const source_refs = input.source_refs.map(s => { assert(typeof s === 'string' && s.length <= 2048 && /^(https:\/\/|git:|sha256:)/.test(s), 'invalid source reference'); return s; }).sort();
  assert(['reviewed', 'unknown'].includes(input.dependency_scope), 'invalid dependency_scope');
  // Worst-case budget includes all proxy reads and the concluding canonical-header read.
  const calls = 3 + contracts.reduce((n, c) => n + 1 + (c.proxy_kind === 'eip1967' ? 6 : c.proxy_kind === 'eip1167' ? 1 : 0), 0) + checks.length;
  assert(calls <= 50, 'manifest exceeds 50-call inspection budget; split dependency investigations');
  return {schema_version: input.schema_version, chain_id: input.chain_id, block, pool, contracts, checks, source_refs, dependency_scope: input.dependency_scope};
}

function wordAddress(word, name) { word = hex(word, 32, name); assert(/^0x0{24}/.test(word), name + ' contains non-address high bytes'); return '0x' + word.slice(-40); }
function header(raw, expected) {
  object(raw, 'block header');
  assert(quantity(raw.number, 'header.number') === BigInt(expected.number), 'header block number mismatch');
  assert(hex(raw.hash, 32, 'header.hash') === expected.hash, 'header block hash mismatch');
  const timestamp = quantity(raw.timestamp, 'header.timestamp');
  assert(timestamp <= BigInt(Number.MAX_SAFE_INTEGER), 'header timestamp outside safe range');
  return {number: expected.number, hash: expected.hash, parent_hash: hex(raw.parentHash, 32, 'header.parentHash'), timestamp: Number(timestamp)};
}
function payloadFrom(result) { return {chain_id: result.chain_id, pool: result.pool, dependency_scope: result.dependency_scope, contracts: result.observations, checks: result.checks}; }
function inspectionStamp(result) { return {manifest_digest: result.manifest_digest, block: result.block, identity_digest: result.identity_digest, evidence_digest: result.evidence_digest, status: result.status, canonical_rechecked: result.canonical_rechecked, qualified_for_identity: result.qualified_for_identity, problems: result.problems}; }

export async function inspectDeployment(input, {rpc} = {}) {
  const manifest = validateManifest(input);
  assert(typeof rpc === 'function', 'rpc function is required');
  const evidence = [], problems = [], observations = [], checks = [];
  const pin = {blockHash: manifest.block.hash, requireCanonical: true};
  let block = {...manifest.block}, canonical_rechecked = false;
  const problem = (code, subject) => problems.push({code, subject});
  async function read(method, params) {
    assert(evidence.length < 50, 'RPC call budget exhausted');
    const request = {method, params: structuredClone(params)};
    try {
      const response = structuredClone(await rpc(method, params));
      assert(response !== undefined, 'RPC returned undefined');
      const row = {index: evidence.length, request, response}; row.digest = identityHash(row); evidence.push(row); return response;
    } catch (e) {
      // Provider messages can contain credential-bearing URLs. Retain only a safe error classification.
      const row = {index: evidence.length, request, error: {name: e?.name === 'TypeError' ? 'TypeError' : 'RpcReadError'}};
      row.digest = identityHash(row); evidence.push(row); throw new Error('RPC_READ_FAILED');
    }
  }
  async function getCode(address, expected) {
    const raw = bytes(await read('eth_getCode', [address, pin]), 'runtime bytecode', 1000000);
    const observed = codeHash(raw);
    if (raw === '0x') problem('MISSING_CODE', address);
    if (expected && observed !== expected) problem('CODE_HASH_MISMATCH', address);
    return {address, code_hash: observed, code_present: raw !== '0x', raw};
  }
  try {
    assert(quantity(await read('eth_chainId', []), 'eth_chainId') === 4663n, 'CHAIN_ID_MISMATCH');
    block = header(await read('eth_getBlockByNumber', ['0x' + manifest.block.number.toString(16), false]), manifest.block);
    for (const c of manifest.contracts) {
      const found = await getCode(c.address, c.expected_code_hash);
      const row = {role: c.role, address: c.address, code_hash: found.code_hash, code_present: found.code_present, proxy_kind: c.proxy_kind};
      observations.push(row);
      if (c.proxy_kind === 'unknown') { problem('UNKNOWN_PROXY_KIND', c.address); continue; }
      if (c.proxy_kind === 'none') {
        if (/^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/.test(found.raw)) problem('UNDECLARED_EIP1167_PROXY', c.address);
        continue;
      }
      let implementation;
      if (c.proxy_kind === 'eip1967') {
        const slots = {};
        for (const [kind, slot] of Object.entries(SLOTS)) slots[kind] = wordAddress(await read('eth_getStorageAt', [c.address, slot, pin]), `EIP1967 ${kind}`);
        row.admin = slots.admin;
        if (!own(c, 'expected_admin')) problem('UNKNOWN_PROXY_ADMIN_EXPECTATION', c.address);
        else if (c.expected_admin !== slots.admin) problem('PROXY_ADMIN_MISMATCH', c.address);
        if (slots.implementation !== ZERO && slots.beacon !== ZERO) problem('AMBIGUOUS_EIP1967_SLOTS', c.address);
        if (slots.implementation !== ZERO) {
          implementation = slots.implementation;
          if (c.beacon) problem('EXPECTED_BEACON_NOT_ACTIVE', c.address);
        } else if (slots.beacon !== ZERO) {
          const beacon = await getCode(slots.beacon, c.beacon?.expected_code_hash);
          row.beacon = {address: slots.beacon, code_hash: beacon.code_hash, code_present: beacon.code_present};
          if (!c.beacon) problem('UNREVIEWED_BEACON', slots.beacon);
          else if (c.beacon.address !== slots.beacon) problem('BEACON_ADDRESS_MISMATCH', c.address);
          implementation = wordAddress(await read('eth_call', [{to: slots.beacon, from: c.address, data: '0x5c60da1b'}, pin]), 'beacon implementation()');
        } else problem('MISSING_PROXY_IMPLEMENTATION', c.address);
      } else {
        const match = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(found.raw);
        if (!match) problem('NONSTANDARD_EIP1167_RUNTIME', c.address);
        else implementation = '0x' + match[1];
      }
      if (implementation && implementation !== ZERO) {
        const impl = await getCode(implementation, c.implementation?.expected_code_hash);
        row.implementation = {address: implementation, code_hash: impl.code_hash, code_present: impl.code_present};
        if (!c.implementation) problem('UNREVIEWED_IMPLEMENTATION', c.address);
        else if (c.implementation.address !== implementation) problem('IMPLEMENTATION_ADDRESS_MISMATCH', c.address);
      } else if (implementation === ZERO) problem('MISSING_PROXY_IMPLEMENTATION', c.address);
    }
    for (const c of manifest.checks) {
      const call = {to: c.to, data: c.data};
      if (own(c, 'from')) call.from = c.from;
      if (own(c, 'value')) call.value = c.value;
      const result = bytes(await read('eth_call', [call, pin]), 'check result');
      checks.push({...call, id: c.id, result});
      if (result !== c.expected_result) problem('CONFIG_RESULT_MISMATCH', c.id);
    }
    const end = header(await read('eth_getBlockByNumber', ['0x' + manifest.block.number.toString(16), false]), manifest.block);
    assert(stable(end) === stable(block), 'CANONICAL_HEADER_CHANGED');
    canonical_rechecked = true;
  } catch (error) { problem(error.message === 'RPC_READ_FAILED' ? 'RPC_UNAVAILABLE' : 'INCONSISTENT_RPC_EVIDENCE', 'inspection'); }
  if (manifest.dependency_scope !== 'reviewed') problem('DEPENDENCY_SCOPE_UNKNOWN', 'manifest');
  const result = {
    schema_version: 'hook-lab.identity.v1', status: problems.length === 0 && canonical_rechecked ? 'IDENTITY_MATCH_AT_BLOCK' : 'IDENTITY_UNQUALIFIED',
    qualified_for_identity: problems.length === 0 && canonical_rechecked, qualified_for_execution: false,
    chain_id: 4663, block, pool: manifest.pool, dependency_scope: manifest.dependency_scope,
    manifest_digest: identityHash(manifest), canonical_rechecked, observations, checks, problems, evidence,
    limitations: [
      'Expected code hashes, source references and dependency review are supplied expectations; RPC agreement is not an audit or independent source verification.',
      'proxy_kind none does not prove absence of delegatecall, upgrade controls or mutable external dependencies. EIP1167 support covers the exact standard 45-byte runtime only.',
      'PoolKey hashing does not prove that the pool was initialized. No liquidity, sellability, route support or profitability conclusion is established.',
      'Identity and config are observations at one pinned block; later state and third-party configuration can change.',
      'Beacon and implementation code hashes bind one reviewed layer; nested delegates and beacon dependencies must be explicitly reviewed and included in the manifest graph.',
    ],
  };
  result.identity_digest = identityHash(payloadFrom(result));
  result.evidence_digest = identityHash(evidence);
  result.inspection_digest = identityHash(inspectionStamp(result));
  return result;
}

/** Compare observations, without treating matching bytecode as durable trading authorization. */
export function compareIdentity(prior, current) {
  const changes = [];
  const invalid = (status, reason) => ({schema_version: 'hook-lab.compatibility.v1', status, qualified_for_execution: false, changes: [reason], continuity: 'UNPROVEN'});
  try {
  for (const r of [prior, current]) {
    if (!r || r.schema_version !== 'hook-lab.identity.v1' || r.status !== 'IDENTITY_MATCH_AT_BLOCK' || r.qualified_for_identity !== true || r.canonical_rechecked !== true || !Array.isArray(r.problems) || r.problems.length !== 0) return invalid('INSUFFICIENT_EVIDENCE', 'Both inspections must have qualified identity evidence');
    if (identityHash(payloadFrom(r)) !== r.identity_digest || identityHash(r.evidence) !== r.evidence_digest || identityHash(inspectionStamp(r)) !== r.inspection_digest) return invalid('INSUFFICIENT_EVIDENCE', 'Inspection digest mismatch');
    if (!r.block || !Number.isSafeInteger(r.block.number) || !Number.isSafeInteger(r.block.timestamp)) return invalid('INSUFFICIENT_EVIDENCE', 'Missing block number or timestamp');
    hex(r.block.hash, 32, 'inspection block hash'); hex(r.block.parent_hash, 32, 'inspection parent hash');
  }
  } catch { return invalid('INSUFFICIENT_EVIDENCE', 'Malformed inspection evidence'); }
  if (prior.chain_id !== current.chain_id || stable(prior.pool) !== stable(current.pool)) changes.push('DEPLOYMENT_TARGET_CHANGED');
  if (prior.identity_digest !== current.identity_digest) changes.push('CODE_DEPENDENCY_OR_CONFIG_CHANGED');
  if (current.block.number < prior.block.number || current.block.timestamp < prior.block.timestamp) changes.push('OBSERVATION_MOVED_BACKWARD');
  let continuity = 'UNPROVEN';
  if (current.block.number === prior.block.number) {
    if (current.block.hash !== prior.block.hash) changes.push('SAME_HEIGHT_DIFFERENT_HASH');
    else continuity = 'SAME_BLOCK';
  } else if (current.block.number === prior.block.number + 1) {
    if (current.block.parent_hash === prior.block.hash) continuity = 'ADJACENT_PARENT_LINK';
    else changes.push('ADJACENT_PARENT_MISMATCH');
  }
  return {schema_version: 'hook-lab.compatibility.v1', status: changes.length ? 'INVALIDATED' : 'COMPATIBLE_OBSERVATIONS_AT_BLOCK', qualified_for_execution: false, changes, continuity, blocks_elapsed: current.block.number - prior.block.number, seconds_elapsed: current.block.timestamp - prior.block.timestamp, limitations: ['Matching observations at separated blocks do not prove unchanged intermediate state or current freshness. No maximum acceptable age is assumed; the consumer must apply its explicit policy and recheck before use.']};
}
