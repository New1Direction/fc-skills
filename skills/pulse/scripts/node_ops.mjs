#!/usr/bin/env node
/** Read-only Robinhood Chain full-node planning and bounded observation. Node 24+. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const NODE_GUIDE = 'https://docs.robinhood.com/chain/run-a-full-node/';
export const CHAIN_INFO_SOURCE = 'https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-info.json';
export const GENESIS_SOURCE = 'https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-genesis.json';
export const NITRO_IMAGE = 'offchainlabs/nitro-node:v3.11.2-3599aca';
export const MAINNET_ROLLUP = {
  bridge: '0xdf8755334ce7a73ccf6b581c02ea649ae3e864b3',
  inbox: '0x1a07cc4bd17e0118bdb54d70990d2158abad7a2d',
  'sequencer-inbox': '0xbd0d173eeb87d57a09521c24388a12789f33ba96',
  rollup: '0x23a19d23e89166adedbdcb432518ab01e4272d94',
};
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
const require = (ok, message) => { if (!ok) fail(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const json = (x) => JSON.stringify(x, null, 2) + '\n';
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (obj(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function keys(value, allowed, label) {
  require(obj(value), `${label} must be an object`);
  require(Object.keys(value).every(k => allowed.includes(k)), `${label} has unsupported fields`);
}
function safePath(value, label) {
  require(typeof value === 'string' && value.length <= 512 && value !== '/' &&
    /^\/[A-Za-z0-9_./-]+$/.test(value) && path.posix.normalize(value) === value &&
    !value.split('/').some(x => x === '.' || x === '..'), `${label} must be a normalized absolute path with simple characters`);
  return value;
}
function envName(value, label) {
  require(typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) &&
    !['HOME', 'PATH', 'SHELL', 'NODE_OPTIONS', 'LD_PRELOAD', 'CODEX_HOME'].includes(value), `${label} must be an environment variable name, never an endpoint or secret`);
  return value;
}
function asset(value, label, source) {
  keys(value, ['path', 'sha256', 'source'], label);
  safePath(value.path, `${label}.path`);
  require(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), `${label}.sha256 required`);
  require(value.source === source, `${label} must identify the official mainnet source`);
}
function configCheck(config) {
  keys(config, ['schema', 'chainId', 'image', 'imageSource', 'chainInfo', 'genesis', 'dataDir', 'l1ExecutionEnv', 'l1BeaconEnv', 'sequencerFeed'], 'node plan');
  require(config.schema === 'pulse.node-plan.v1' && config.chainId === 4663, 'only Robinhood Chain mainnet 4663 is supported');
  require(typeof config.image === 'string' && (config.image === NITRO_IMAGE ||
    new RegExp('^' + NITRO_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '@sha256:[a-f0-9]{64}$').test(config.image)), 'use the documented compatible version tag, optionally with an independently verified digest');
  require(config.imageSource === NODE_GUIDE, 'image source must identify the checked Robinhood node guide');
  asset(config.chainInfo, 'chainInfo', CHAIN_INFO_SOURCE);
  asset(config.genesis, 'genesis', GENESIS_SOURCE);
  safePath(config.dataDir, 'dataDir');
  require(config.chainInfo.path !== config.genesis.path, 'chain-info and genesis paths must differ');
  require(![config.chainInfo.path, config.genesis.path].some(p => p === config.dataDir || p.startsWith(config.dataDir + '/')), 'configuration assets must be outside the writable node data directory');
  envName(config.l1ExecutionEnv, 'l1ExecutionEnv');
  envName(config.l1BeaconEnv, 'l1BeaconEnv');
  require(config.l1ExecutionEnv !== config.l1BeaconEnv, 'execution and beacon environment names must differ');
  require(config.sequencerFeed === undefined || typeof config.sequencerFeed === 'boolean', 'sequencerFeed must be boolean');
}

/** This produces reviewable files only. It never creates directories, pulls images, or starts Docker. */
export function renderNodePlan(config) {
  configCheck(config);
  const normalized = structuredClone(config);
  normalized.sequencerFeed ??= true;
  const nitro = {
    chain: { id: 4663, 'info-files': ['/home/nitro/config/robinhood-chain-info.json'] },
    init: { 'genesis-json-file': '/home/nitro/config/robinhood-genesis.json' },
    http: { addr: '0.0.0.0', port: 8547, api: ['net', 'web3', 'eth'], vhosts: ['localhost', '127.0.0.1'], corsdomain: [] },
    ws: { addr: '0.0.0.0', port: 8548, api: ['net', 'web3', 'eth'], origins: ['http://localhost', 'http://127.0.0.1'] },
    execution: { 'forwarding-target': 'null', sequencer: { enable: false } },
    node: { sequencer: false, 'batch-poster': { enable: false }, staker: { enable: false },
      'block-validator': { enable: false }, feed: { input: { url: normalized.sequencerFeed ? ['wss://feed.mainnet.chain.robinhood.com'] : [] } } },
    metrics: false,
  };
  const reference = (name) => '${' + name + ':?Set ' + name + ' securely in the launch environment}';
  const bind = (source, target, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly, bind: { create_host_path: false } });
  const compose = {
    name: 'pulse-robinhood-node',
    services: { nitro: {
      image: normalized.image, restart: 'unless-stopped', init: true,
      command: ['--conf.file=/home/nitro/config/nitro-config.json', '--conf.env-prefix=PULSE_NITRO'],
      environment: {
        PULSE_NITRO_PARENT__CHAIN_CONNECTION_URL: reference(normalized.l1ExecutionEnv),
        PULSE_NITRO_PARENT__CHAIN_BLOB__CLIENT_BEACON__URL: reference(normalized.l1BeaconEnv),
      },
      ports: [
        { target: 8547, published: '8547', host_ip: '127.0.0.1', protocol: 'tcp' },
        { target: 8548, published: '8548', host_ip: '127.0.0.1', protocol: 'tcp' },
      ],
      volumes: [bind(normalized.dataDir, '/home/nitro/.arbitrum', false),
        bind(normalized.chainInfo.path, '/home/nitro/config/robinhood-chain-info.json'),
        bind(normalized.genesis.path, '/home/nitro/config/robinhood-genesis.json'),
        bind('./nitro-config.json', '/home/nitro/config/nitro-config.json')],
      security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'],
      logging: { driver: 'json-file', options: { 'max-size': '50m', 'max-file': '3' } },
    } },
  };
  const runbook = `# Robinhood Chain full-node plan\n\nGenerated for chain 4663 from the official guide checked 2026-09-08. This plan has not started a node.\n\n1. Download chain-info and custom genesis from the official sources recorded in the manifest. Establish their SHA-256 values independently of an untrusted plan. Run validateAssets(plan) before launch. Protect these files from edits after validation and repeat validation immediately before each start.\n2. Prepare the selected data directory on locally attached NVMe. Minimum planning assumptions: 8+ modern CPU cores, 64 GB RAM (128 GB recommended), and (2 × current chain size) + 20% storage buffer, ordinarily multiple TB. Measure current chain size and your L1 request budget before renting hardware.\n3. Check the current Robinhood Nitro/ArbOS upgrade notice. This plan pins ${NITRO_IMAGE}, the version in the guide at build time. A version tag can be moved by its publisher; add an independently verified image digest for immutable selection. No image or runtime compatibility has been tested by rendering.\n4. Ensure the data directory is writable by the pinned image's nitro user. Do not use broad world-writable permissions. Keep an existing database backed up before an upgrade; never initialize over an unrelated chain database. The data mount must remain /home/nitro/.arbitrum.\n5. Supply ${normalized.l1ExecutionEnv} and ${normalized.l1BeaconEnv} only through your local secret environment. Both an Ethereum mainnet execution RPC and a mainnet beacon endpoint are required; check their synchronization, blob history availability, credentials, and quotas. Docker administrators can inspect container environment values. Do not commit credentials, resolved Compose output, or provider logs.\n6. From the directory containing these generated files, validate syntax without printing resolved credentials: docker compose -f compose.json config --quiet. A real launch, when deliberately authorized, is docker compose -f compose.json up -d. The renderer never runs either command.\n7. Inspect local node progress and run probeNode against http://127.0.0.1:8547. A chain ID alone is not health. Require eth_syncing=false, fresh nonfuture head, and an independent peer comparison before relying on the node for current research. A matching peer is not an L1 finality proof. Monitor errors, disk, memory, clock, and L1 provider usage separately.\n8. Stop deliberately with docker compose -f compose.json stop. Do not delete the data directory as a troubleshooting shortcut.\n\nHTTP 8547 and WS 8548 publish only on host loopback. Container listeners use 0.0.0.0 so Docker forwarding works. Other local processes and containers on this Compose network may reach RPC; this is not an authentication boundary. Do not switch to host networking, publish on 0.0.0.0, add public proxies, or add admin/debug/personal APIs. Forwarding target is the literal string null; sequencer, batch poster, staker, and block validator are disabled. No wallet or signing key is needed. The eth namespace still contains transaction method names; this nonsequencer node is configured not to forward submitted transactions.\n\nThis is a full node plan, not archive service, independent validation proof, staking, or a validator deployment. Current guide says ArbOS61; the official genesis initial ArbOS version51 is historical and must not be rewritten to61.\n\nSources: ${NODE_GUIDE}\nhttps://docs.arbitrum.io/run-arbitrum-node/nitro/configuration-system\nhttps://docs.arbitrum.io/run-arbitrum-node/nitro/cli-flags-reference\n`;
  const files = { 'compose.json': json(compose), 'nitro-config.json': json(nitro), 'RUNBOOK.md': runbook };
  const manifest = {
    schema: 'pulse.rendered-node-plan.v1', config: normalized,
    fileSha256: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
    chainId: 4663, parentChainId: 1, guideCheckedOn: '2026-09-08',
    imageSelection: normalized.image.includes('@sha256:') ? 'SUPPLIED_DIGEST_NOT_REGISTRY_VERIFIED' : 'VERSION_TAG_NOT_IMMUTABLE',
    assetsValidated: false, runtimeValidated: false, deploymentPerformed: false,
    security: { hostBind: '127.0.0.1', rpcApis: ['net', 'web3', 'eth'], forwarding: false, staking: false, signing: false },
  };
  return { files, manifest };
}

/** Strict duplicate-key JSON reader; keeps large genesis balances in source text for digest binding. */
function parseJson(text) {
  // JSON.parse establishes grammar. A second lexical walk detects duplicate member names at each depth.
  const value = JSON.parse(text);
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  const stack = [];
  for (const match of text.matchAll(token)) {
    const t = match[0];
    if (t === '{' || t === '[') { stack.push(t === '{' ? new Set() : null); require(stack.length <= 128, 'JSON nesting limit'); }
    else if (t === '}' || t === ']') stack.pop();
    else if (t.startsWith('"') && text.slice(match.index + t.length).match(/^\s*:/)) {
      const current = stack.at(-1); require(current instanceof Set, 'invalid JSON member');
      const key = JSON.parse(t); require(!current.has(key), 'duplicate JSON key'); current.add(key);
    }
  }
  return value;
}
async function loadAsset(spec) {
  const stat = await lstat(spec.path);
  require(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_ASSET_BYTES, 'asset must be a bounded regular file');
  require(await realpath(spec.path) === spec.path, 'symlinked asset path is unsupported');
  const bytes = await readFile(spec.path);
  require(bytes.length <= MAX_ASSET_BYTES && sha256(bytes) === spec.sha256, 'asset digest mismatch');
  return { value: parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes: bytes.length };
}
export async function validateAssets(plan) {
  require(obj(plan) && obj(plan.manifest), 'rendered plan required');
  const rebuilt = renderNodePlan(plan.manifest.config);
  require(canonical(plan) === canonical(rebuilt), 'rendered plan changed after generation');
  const [info, genesis] = await Promise.all([loadAsset(rebuilt.manifest.config.chainInfo), loadAsset(rebuilt.manifest.config.genesis)]);
  require(Array.isArray(info.value) && info.value.length === 1, 'one mainnet chain-info entry required');
  const entry = info.value[0];
  require(obj(entry) && entry['chain-id'] === 4663 && entry['parent-chain-id'] === 1 && entry['parent-chain-is-arbitrum'] === false, 'wrong chain-info network');
  const chain = entry['chain-config'];
  require(obj(chain) && chain.chainId === 4663 && obj(chain.arbitrum) && chain.arbitrum.EnableArbOS === true &&
    chain.arbitrum.DataAvailabilityCommittee === false && chain.arbitrum.AllowDebugPrecompiles === false, 'wrong chain configuration');
  require(obj(entry.rollup) && Object.entries(MAINNET_ROLLUP).every(([k, v]) => typeof entry.rollup[k] === 'string' && entry.rollup[k].toLowerCase() === v), 'wrong Ethereum mainnet rollup identity');
  require(obj(genesis.value) && obj(genesis.value.alloc) && Object.keys(genesis.value.alloc).length > 0 &&
    typeof genesis.value.serializedChainConfig === 'string', 'custom Nitro genesis structure required');
  const embedded = parseJson(genesis.value.serializedChainConfig);
  require(canonical(embedded) === canonical(chain), 'genesis and chain-info configurations differ');
  require(genesis.value.timestamp === '0x0', 'unexpected mainnet genesis timestamp');
  return { schema: 'pulse.node-assets-check.v1', status: 'DIGEST_AND_MAINNET_IDENTITIES_MATCH', chainId: 4663,
    chainInfoBytes: info.bytes, genesisBytes: genesis.bytes,
    fingerprints: { chainInfo: rebuilt.manifest.config.chainInfo.sha256, genesis: rebuilt.manifest.config.genesis.sha256 },
    sourceAuthenticity: 'DEPENDS_ON_INDEPENDENT_EXPECTED_DIGESTS', runtimeCompatibility: 'NOT_TESTED',
    limitations: ['This checks retained files, not image authenticity or live chain state.', 'Recheck protected files immediately before launch; later filesystem mutation is outside this check.'] };
}

function boundedInteger(x, low, high, label) { require(Number.isSafeInteger(x) && x >= low && x <= high, `invalid ${label}`); return x; }
function quantity(x) { require(typeof x === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(x), 'invalid RPC quantity'); return BigInt(x); }
function header(x) {
  require(obj(x) && typeof x.hash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(x.hash), 'invalid block header');
  return { number: quantity(x.number), timestamp: quantity(x.timestamp), hash: x.hash.toLowerCase() };
}
function endpointLocal(url) {
  const u = new URL(url);
  require(u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'probe local RPC must be a loopback HTTP origin');
  return u.href;
}
function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RPC deadline exceeded')), ms); })]).finally(() => clearTimeout(timer));
}
async function httpRpc(url, method, params, timeoutMs) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  require(response.ok && response.body, 'RPC transport failed');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
    require(size <= 1024 * 1024, 'RPC response too large'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const result = parseJson(Buffer.concat(chunks).toString('utf8'));
  require(obj(result) && result.jsonrpc === '2.0' && result.id === 1 && !Object.hasOwn(result, 'error') && Object.hasOwn(result, 'result'), 'RPC envelope failed');
  return result.result;
}

/** rpc injection contract: async (method, params, { target: 'local'|'peer', timeoutMs }) => RPC result. */
export async function probeNode(config, { rpc } = {}) {
  keys(config, ['localRpcUrl', 'peerRpcEnv', 'nowMs', 'maxHeadAgeSeconds', 'maxFutureSkewSeconds', 'maxPeerLagBlocks', 'timeoutMs'], 'probe config');
  const local = endpointLocal(config.localRpcUrl ?? 'http://127.0.0.1:8547');
  const timeoutMs = boundedInteger(config.timeoutMs ?? 5000, 50, 10000, 'timeoutMs');
  const nowMs = boundedInteger(config.nowMs ?? Date.now(), 0, 8_640_000_000_000_000, 'nowMs');
  const clockMs = () => config.nowMs ?? Date.now();
  const maxAge = boundedInteger(config.maxHeadAgeSeconds ?? 30, 1, 3600, 'maxHeadAgeSeconds');
  const future = boundedInteger(config.maxFutureSkewSeconds ?? 2, 0, 60, 'maxFutureSkewSeconds');
  const lagLimit = boundedInteger(config.maxPeerLagBlocks ?? 20, 0, 10000, 'maxPeerLagBlocks');
  if (config.peerRpcEnv !== undefined) envName(config.peerRpcEnv, 'peerRpcEnv');
  let peer;
  if (!rpc && config.peerRpcEnv) {
    const candidate = process.env[config.peerRpcEnv]; require(candidate, 'peer RPC environment variable missing');
    const u = new URL(candidate); require(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'peer RPC requires HTTPS'); peer = u.href;
  }
  const transport = rpc ?? ((method, params, { target }) => httpRpc(target === 'local' ? local : peer, method, params, timeoutMs));
  let calls = 0;
  const read = async (method, params, target = 'local') => {
    require(['eth_chainId', 'eth_syncing', 'eth_getBlockByNumber'].includes(method) && ++calls <= 9, 'read-only probe bound exceeded');
    return deadline(Promise.resolve().then(() => transport(method, params, { target, timeoutMs })), timeoutMs);
  };
  const report = { schema: 'pulse.node-probe.v1', observedAt: new Date(nowMs).toISOString(), status: 'UNAVAILABLE',
    chainId: null, syncing: null, head: null, peerComparison: null, l1Health: 'NOT_PROBED', finality: 'NOT_PROVEN',
    policy: { maxHeadAgeSeconds: maxAge, maxFutureSkewSeconds: future, maxPeerLagBlocks: lagLimit },
    limitations: ['One bounded observation does not prove sustained availability, L1 correctness, or hardware health.', 'Peer identity and independence must be established by the operator.'] };
  try {
    require(quantity(await read('eth_chainId', [])) === 4663n, 'wrong RPC chain'); report.chainId = 4663;
    const syncing = await read('eth_syncing', []);
    require(syncing === false || obj(syncing), 'invalid eth_syncing result');
    if (syncing !== false) { quantity(syncing.currentBlock); quantity(syncing.highestBlock); report.syncing = true; }
    else report.syncing = false;
    const head = header(await read('eth_getBlockByNumber', ['latest', false]));
    const age = Number(BigInt(Math.floor(clockMs() / 1000)) - head.timestamp);
    require(Number.isSafeInteger(age), 'timestamp out of range');
    report.head = { number: head.number.toString(), hash: head.hash, timestamp: head.timestamp.toString(), ageSeconds: age };
    if (report.syncing) { report.status = 'SYNCING'; return report; }
    if (age < -future) { report.status = 'FUTURE_HEAD'; return report; }
    if (age > maxAge) { report.status = 'STALE_HEAD'; return report; }
    report.status = 'RESPONDING_CURRENT_WITHOUT_PEER';
    if (config.peerRpcEnv) {
      require(quantity(await read('eth_chainId', [], 'peer')) === 4663n, 'wrong peer chain');
      const peerHead = header(await read('eth_getBlockByNumber', ['latest', false], 'peer'));
      const peerAge = Number(BigInt(Math.floor(clockMs() / 1000)) - peerHead.timestamp);
      require(Number.isSafeInteger(peerAge) && peerAge >= -future && peerAge <= maxAge, 'peer head is stale or future');
      const common = head.number < peerHead.number ? head.number : peerHead.number;
      const block = '0x' + common.toString(16);
      const localCommon = header(await read('eth_getBlockByNumber', [block, false]));
      const peerCommon = header(await read('eth_getBlockByNumber', [block, false], 'peer'));
      require(localCommon.number === common && peerCommon.number === common, 'wrong common block response');
      require(common !== head.number || (localCommon.hash === head.hash && localCommon.timestamp === head.timestamp), 'local head changed during probe');
      require(common !== peerHead.number || (peerCommon.hash === peerHead.hash && peerCommon.timestamp === peerHead.timestamp), 'peer head changed during probe');
      require(localCommon.hash !== peerCommon.hash || localCommon.timestamp === peerCommon.timestamp, 'same-hash header inconsistency');
      const delta = peerHead.number - head.number;
      report.peerComparison = { peerHead: peerHead.number.toString(), commonBlock: common.toString(),
        headDifferenceBlocks: delta.toString(), commonHashMatches: localCommon.hash === peerCommon.hash };
      report.status = localCommon.hash !== peerCommon.hash ? 'PEER_FORK_DISAGREEMENT' :
        delta > BigInt(lagLimit) ? 'BEHIND_PEER' : delta < -BigInt(lagLimit) ? 'PEER_BEHIND_LOCAL' : 'RESPONDING_CURRENT_PEER_CONSISTENT';
    }
    return report;
  } catch {
    // Provider errors may contain endpoints/keys. Keep them out of returned reports.
    report.status = 'UNAVAILABLE'; report.failure = 'RPC_TRANSPORT_OR_RESPONSE_CHECK_FAILED'; return report;
  } finally {
    report.rpcCalls = calls;
    report.observedAt = new Date(clockMs()).toISOString();
    if (report.head) {
      report.head.ageSeconds = Number(BigInt(Math.floor(clockMs() / 1000)) - BigInt(report.head.timestamp));
      if (report.status.startsWith('RESPONDING_CURRENT') && report.head.ageSeconds > maxAge) report.status = 'STALE_HEAD';
    }
  }
}
