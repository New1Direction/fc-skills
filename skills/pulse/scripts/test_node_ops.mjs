import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { renderNodePlan, validateAssets, probeNode, NODE_GUIDE, CHAIN_INFO_SOURCE, GENESIS_SOURCE, NITRO_IMAGE, MAINNET_ROLLUP } from './node_ops.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
function config() {
  return { schema: 'pulse.node-plan.v1', chainId: 4663, image: NITRO_IMAGE, imageSource: NODE_GUIDE,
    chainInfo: { path: '/srv/robinhood/config/chain-info.json', sha256: 'a'.repeat(64), source: CHAIN_INFO_SOURCE },
    genesis: { path: '/srv/robinhood/config/genesis.json', sha256: 'b'.repeat(64), source: GENESIS_SOURCE },
    dataDir: '/srv/robinhood/nitro-data', l1ExecutionEnv: 'RH_L1_EXECUTION_URL', l1BeaconEnv: 'RH_L1_BEACON_URL' };
}
async function assetFixture(t, change = () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pulse-node-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = { chainId: 4663, arbitrum: { EnableArbOS: true, AllowDebugPrecompiles: false,
    DataAvailabilityCommittee: false, InitialArbOSVersion: 51 } };
  const info = [{ 'chain-id': 4663, 'parent-chain-id': 1, 'parent-chain-is-arbitrum': false,
    'chain-config': chain, rollup: { ...MAINNET_ROLLUP } }];
  const genesis = { alloc: { ['0x' + '1'.repeat(40)]: { balance: 0, code: '0x60' } },
    serializedChainConfig: JSON.stringify(chain), timestamp: '0x0' };
  change(info, genesis);
  const c = config();
  for (const [key, value] of [['chainInfo', info], ['genesis', genesis]]) {
    const bytes = JSON.stringify(value);
    c[key].path = path.join(dir, key + '.json'); c[key].sha256 = hash(bytes); await writeFile(c[key].path, bytes);
  }
  return { config: c, dir, info, genesis };
}
const NOW = 1_800_000_000_000;
const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function rpcFixture({ chainId = '0x1237', syncing = false, age = 1, local = 100, peer = 103, disagree = false } = {}) {
  const calls = [];
  return { calls, rpc: async (method, params, { target }) => {
    calls.push({ method, params, target });
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_syncing') return syncing;
    const number = params[0] === 'latest' ? target === 'peer' ? peer : local : Number(BigInt(params[0]));
    return { number: '0x' + number.toString(16), timestamp: '0x' + (NOW / 1000 - age).toString(16), hash: h(number + (disagree && target === 'peer' ? 1000 : 0)) };
  } };
}

test('plan emits valid Compose JSON, correct data/config mounts, and only loopback ports', () => {
  const p = renderNodePlan(config()), docker = JSON.parse(p.files['compose.json']), nitro = JSON.parse(p.files['nitro-config.json']);
  const service = docker.services.nitro;
  assert.equal(service.image, NITRO_IMAGE);
  assert.deepEqual(service.ports.map(p => [p.host_ip, p.published, p.target]), [['127.0.0.1', '8547', 8547], ['127.0.0.1', '8548', 8548]]);
  assert(service.volumes.some(v => v.target === '/home/nitro/.arbitrum' && !v.read_only));
  assert(service.volumes.filter(v => v.target.startsWith('/home/nitro/config/')).every(v => v.read_only));
  assert.deepEqual(nitro.http.api, ['net', 'web3', 'eth']);
  assert.equal(nitro.execution['forwarding-target'], 'null');
  assert.equal(nitro.node.staker.enable, false);
  assert.equal(nitro.node['batch-poster'].enable, false);
  assert.equal(nitro.execution.sequencer.enable, false);
  assert.equal(p.manifest.deploymentPerformed, false);
  assert.equal(p.manifest.runtimeValidated, false);
});

test('renderer never resolves launch secrets and only passes two explicit Nitro environment variables', () => {
  process.env.RH_L1_EXECUTION_URL = 'https://secret.example/key-do-not-render';
  try {
    const p = renderNodePlan(config());
    assert(!JSON.stringify(p).includes('key-do-not-render'));
    const env = JSON.parse(p.files['compose.json']).services.nitro.environment;
    assert.equal(Object.keys(env).length, 2);
    assert(env.PULSE_NITRO_PARENT__CHAIN_CONNECTION_URL.startsWith('${RH_L1_EXECUTION_URL:?'));
    assert(env.PULSE_NITRO_PARENT__CHAIN_BLOB__CLIENT_BEACON__URL.startsWith('${RH_L1_BEACON_URL:?'));
  } finally { delete process.env.RH_L1_EXECUTION_URL; }
});

test('public ports, extra flags, actual credentials, and YAML/shell/Compose injection reject', () => {
  for (const value of ['/srv/$(touch hacked)', '/srv/${SECRET}', '/srv/a\nb', '/srv/a:ro', '/srv/../escape', '/srv/"evil', '/srv/`cmd`', './relative', '/']) {
    const c = config(); c.dataDir = value; assert.throws(() => renderNodePlan(c), /path/);
  }
  for (const value of ['https://secret.example', 'VAR:-evil', 'A${EVIL}', 'HOME', 'NODE_OPTIONS']) {
    const c = config(); c.l1ExecutionEnv = value; assert.throws(() => renderNodePlan(c), /environment/);
  }
  for (const [key, value] of [['hostBind', '0.0.0.0'], ['extraFlags', ['--node.staker.enable=true']], ['privateKey', 'secret']]) {
    const c = config(); c[key] = value; assert.throws(() => renderNodePlan(c), /unsupported fields/);
  }
});

test('missing beacon, reused endpoints names, wrong chain, misplaced configuration reject', () => {
  const missing = config(); delete missing.l1BeaconEnv; assert.throws(() => renderNodePlan(missing), /environment/);
  const same = config(); same.l1BeaconEnv = same.l1ExecutionEnv; assert.throws(() => renderNodePlan(same), /differ/);
  for (const chainId of [46630, '4663', true, 1]) { const c = config(); c.chainId = chainId; assert.throws(() => renderNodePlan(c), /4663/); }
  const c = config(); c.genesis.path = c.dataDir + '/genesis.json'; assert.throws(() => renderNodePlan(c), /outside/);
});

test('floating/unknown image rejected; supplied immutable digest remains explicitly unverified', () => {
  for (const image of ['offchainlabs/nitro-node:latest', 'offchainlabs/nitro-node:v3', 'evil/nitro:v3.11.2', NITRO_IMAGE + ';evil']) {
    const c = config(); c.image = image; assert.throws(() => renderNodePlan(c), /version/);
  }
  const c = config(); c.image += '@sha256:' + 'a'.repeat(64);
  assert.equal(renderNodePlan(c).manifest.imageSelection, 'SUPPLIED_DIGEST_NOT_REGISTRY_VERIFIED');
});

test('actual files must match independent digests and matching mainnet serializedChainConfig', async t => {
  const f = await assetFixture(t);
  const r = await validateAssets(renderNodePlan(f.config));
  assert.equal(r.status, 'DIGEST_AND_MAINNET_IDENTITIES_MATCH');
  assert.equal(r.runtimeCompatibility, 'NOT_TESTED');
  await writeFile(f.config.genesis.path, '{}');
  await assert.rejects(validateAssets(renderNodePlan(f.config)), /digest/);
});

test('wrong L1, wrong rollup, genesis mismatch, malformed/duplicate JSON fail', async t => {
  for (const mutate of [
    (i) => { i[0]['parent-chain-id'] = 11155111; },
    (i) => { i[0].rollup.inbox = '0x' + 'f'.repeat(40); },
    (_, g) => { g.serializedChainConfig = '{"chainId":46630}'; },
    (_, g) => { g.serializedChainConfig = '{"chainId":46630,"chainId":4663}'; },
  ]) {
    const f = await assetFixture(t, mutate); await assert.rejects(validateAssets(renderNodePlan(f.config)));
  }
  const f = await assetFixture(t);
  const malformed = '{"alloc":{},"alloc":{},"serializedChainConfig":"{}"}';
  await writeFile(f.config.genesis.path, malformed); f.config.genesis.sha256 = hash(malformed);
  await assert.rejects(validateAssets(renderNodePlan(f.config)), /duplicate/);
});

test('rendered plan tamper and symlinked asset reject', async t => {
  const f = await assetFixture(t), p = renderNodePlan(f.config);
  p.files['compose.json'] = p.files['compose.json'].replaceAll('127.0.0.1', '0.0.0.0');
  await assert.rejects(validateAssets(p), /changed/);
  const target = path.join(f.dir, 'link.json'); await symlink(f.config.genesis.path, target);
  f.config.genesis.path = target;
  await assert.rejects(validateAssets(renderNodePlan(f.config)), /regular file/);
});

test('probe current local chain without independent peer never claims broad health', async () => {
  const f = rpcFixture(); const r = await probeNode({ nowMs: NOW }, f);
  assert.equal(r.status, 'RESPONDING_CURRENT_WITHOUT_PEER');
  assert.equal(r.finality, 'NOT_PROVEN'); assert.equal(r.l1Health, 'NOT_PROBED');
  assert.equal(r.rpcCalls, 3); assert.equal(r.head.number, '100');
  assert.deepEqual(f.calls.map(c => c.method), ['eth_chainId', 'eth_syncing', 'eth_getBlockByNumber']);
});

test('wrong chain, malformed sync, unsynced node, stale/future blocks reject usable status', async () => {
  for (const [params, expected] of [
    [{ chainId: '0x1' }, 'UNAVAILABLE'], [{ syncing: null }, 'UNAVAILABLE'],
    [{ syncing: 0 }, 'UNAVAILABLE'], [{ syncing: {} }, 'UNAVAILABLE'],
    [{ syncing: { currentBlock: '0x40', highestBlock: '0x80' } }, 'SYNCING'],
    [{ age: 100 }, 'STALE_HEAD'], [{ age: -5 }, 'FUTURE_HEAD'],
  ]) assert.equal((await probeNode({ nowMs: NOW }, rpcFixture(params))).status, expected);
});

test('independent peer checks common block, not merely chain ID or equal latest height', async () => {
  for (const [params, expected] of [
    [{}, 'RESPONDING_CURRENT_PEER_CONSISTENT'], [{ disagree: true }, 'PEER_FORK_DISAGREEMENT'],
    [{ peer: 200 }, 'BEHIND_PEER'], [{ local: 200 }, 'PEER_BEHIND_LOCAL'],
  ]) {
    const f = rpcFixture(params), r = await probeNode({ nowMs: NOW, peerRpcEnv: 'RH_PEER_RPC' }, f);
    assert.equal(r.status, expected); assert.equal(r.rpcCalls, 7);
    const common = '0x' + Math.min(params.local ?? 100, params.peer ?? 103).toString(16);
    assert.equal(f.calls[5].params[0], common); assert.equal(f.calls[6].params[0], common);
  }
});

test('head changes during peer comparison and malformed peer identity fail', async () => {
  const f = rpcFixture();
  const r = await probeNode({ nowMs: NOW, peerRpcEnv: 'RH_PEER_RPC' }, { rpc: async (m, p, c) => {
    const value = await f.rpc(m, p, c);
    if (m === 'eth_getBlockByNumber' && p[0] !== 'latest' && c.target === 'local') value.hash = h(999);
    return value;
  } });
  assert.equal(r.status, 'UNAVAILABLE');
});

test('probe transport errors and deadlines never expose endpoint credentials', async () => {
  const r = await probeNode({ nowMs: NOW }, { rpc: async () => { throw Error('https://rpc.example/SECRET'); } });
  assert.equal(r.status, 'UNAVAILABLE'); assert(!JSON.stringify(r).includes('SECRET'));
  const timed = await probeNode({ nowMs: NOW, timeoutMs: 50 }, { rpc: () => new Promise(() => {}) });
  assert.equal(timed.status, 'UNAVAILABLE');
  for (const localRpcUrl of ['http://0.0.0.0:8547', 'http://public.example', 'https://127.0.0.1', 'http://localhost/?key=secret']) {
    await assert.rejects(probeNode({ localRpcUrl }, rpcFixture()), /loopback/);
  }
});

test('builtin HTTP probe works against a real bounded loopback JSON-RPC server', async t => {
  const fixture = rpcFixture();
  const server = createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const call = JSON.parse(bytes); const result = await fixture.rpc(call.method, call.params, { target: 'local' });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const r = await probeNode({ nowMs: NOW, localRpcUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal(r.status, 'RESPONDING_CURRENT_WITHOUT_PEER');
});
