/** Optional isolated real-protocol EVM validation. Never accepts a remote source URL. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isAbsolute, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { keccakHex } from './keccak.mjs';
import { digestValue } from './simulation.mjs';
import { simulateFork, validateForkEvidence } from './fork.mjs';
import { buildRoute, ADAPTER, ZERO } from './routes.mjs';
import { collectPreflight, validatePreflight } from './preflight.mjs';
import { makeRpc } from './rpc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = n => '0x' + BigInt(n).toString(16);
const word = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const selector = signature => keccakHex(Buffer.from(signature)).slice(0, 10);
const calldata = (signature, ...args) => selector(signature) + args.map(word).join('');
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getProof', 'eth_getAccountInfo', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_gasPrice', 'eth_feeHistory', 'debug_traceCall', 'net_version', 'web3_clientVersion']);

async function freePort() {
  const s = createNetServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve())); return port;
}
function localRpc(url) {
  let next = 0;
  return async (method, params = []) => {
    const id = ++next;
    const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(6000), body: JSON.stringify({jsonrpc: '2.0', id, method, params})});
    assert(r.ok, 'Local source RPC HTTP failure');
    const raw = await r.text(); assert(raw.length <= 4 * 1024 * 1024, 'Local source RPC response too large');
    const data = JSON.parse(raw); assert.equal(data.id, id); assert.equal(data.jsonrpc, '2.0');
    if (data.error) { const e = new Error('Local synthetic RPC error'); e.code = data.error.code; e.data = data.error.data; throw e; }
    return data.result;
  };
}
async function readonlyProxy(sourceRpc) {
  const observed = [], denied = [];
  const server = createHttpServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      assert.equal(req.method, 'POST');
      const chunks = []; let length = 0;
      for await (const c of req) { length += c.length; assert(length <= 262144, 'Proxy request too large'); chunks.push(c); }
      const body = JSON.parse(Buffer.concat(chunks));
      assert(body && !Array.isArray(body) && typeof body.method === 'string', 'Single RPC requests required');
      observed.push(body.method);
      if (!READ_METHODS.has(body.method)) {
        denied.push(body.method); res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, error: {code: -32601, message: 'Synthetic source is read-only'}})); return;
      }
      try { res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result: await sourceRpc(body.method, body.params ?? [])})); }
      catch (e) { res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, error: {code: e.code ?? -32000, message: 'Synthetic upstream error', ...(typeof e.data === 'string' ? {data: e.data} : {})}})); }
    } catch { res.statusCode = 400; res.end(JSON.stringify({error: 'Invalid local RPC request'})); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {server, observed, denied, url: 'http://127.0.0.1:' + server.address().port};
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit').catch(() => {}), WAIT(1000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function compileFixtures(solcPath) {
  await access(solcPath, fsConstants.R_OK);
  const solc = createRequire(import.meta.url)(solcPath);
  const source = await readFile(resolve(HERE, '../assets/contracts/Fixture.sol'), 'utf8');
  const input = {language: 'Solidity', sources: {'Fixture.sol': {content: source}}, settings: {optimizer: {enabled: true, runs: 200}, viaIR: true, evmVersion: 'cancun', outputSelection: {'*': {'*': ['evm.bytecode.object']}}}};
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = result.errors?.filter(e => e.severity === 'error') ?? [];
  assert.equal(errors.length, 0, 'Original fixture compilation failed: ' + errors.map(e => e.message).join('; '));
  return {compiler: solc.version(), source_digest: digestValue(source), contracts: Object.fromEntries(Object.entries(result.contracts['Fixture.sol']).map(([k, v]) => [k, '0x' + v.evm.bytecode.object]))};
}

async function protocolArtifacts() {
  const lock = JSON.parse(await readFile(resolve(HERE, '../assets/contracts/source-lock.json'), 'utf8'));
  assert.equal(lock.schema_version, 'circuit.evm-artifacts.v1');
  const result = {};
  for (const name of ['UniversalRouter', 'PoolManager', 'Permit2']) {
    const row = lock.artifacts.find(x => x.name === name);
    assert(row && row.file === name + '.creation.hex', 'Missing pinned artifact');
    const code = (await readFile(resolve(HERE, '../assets/contracts', row.file), 'utf8')).trim();
    assert(/^0x(?:[a-f0-9]{2})+$/.test(code), 'Malformed artifact');
    const bytes = Buffer.from(code.slice(2), 'hex');
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256, 'Artifact digest mismatch');
    assert.equal(row.deployer_source_file, name + '.deployer.sol');
    const source = await readFile(resolve(HERE, '../assets/contracts', row.deployer_source_file), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), row.deployer_source_sha256, 'Upstream deployment source digest mismatch');
    assert.equal(source.match(/return hex'([a-f0-9]+)'/)?.[1], code.slice(2), 'Artifact does not match retained upstream deployment source');
    result[name] = {code, ...row, keccak256: keccakHex(bytes)};
  }
  assert.equal(result.UniversalRouter.keccak256, '0x6dba80c0116a490d48657845492bb38374489ed49c296ac50614265f97221510');
  assert.equal(result.PoolManager.keccak256, '0x2aa0ab6866fc2e2b2a0a9128e66982a049eb04516c012690426ab110f92966f8');
  assert.equal(result.Permit2.keccak256, '0xe2be1e05eedf35dacd66c65c862f8150ff9ab4b6b24b9bbe62be71b6b16cf0f8');
  return result;
}

async function mineHook(factory, initCode) {
  const initHash = keccakHex(Buffer.from(initCode.slice(2), 'hex')).slice(2);
  for (let salt = 0; salt < 1000000; salt++) {
    const hash = keccakHex(Buffer.from('ff' + factory.slice(2) + word(salt) + initHash, 'hex'));
    const address = '0x' + hash.slice(-40);
    if ((BigInt(address) & 0x3fffn) === 0x44n) return {address, salt};
    if (salt % 1024 === 0) await WAIT(0);
  }
  throw new Error('Synthetic hook salt search exhausted');
}

export async function runEvmSmoke({anvilPath, solcPath, outputPath} = {}) {
  assert(isAbsolute(anvilPath ?? '') && isAbsolute(solcPath ?? ''), 'Explicit absolute Anvil and solc paths required');
  if (outputPath !== undefined) assert(isAbsolute(outputPath), 'Output path must be absolute');
  await access(anvilPath, fsConstants.X_OK);
  const compiled = await compileFixtures(solcPath), artifacts = await protocolArtifacts();
  let child, proxy;
  try {
    const port = await freePort();
    child = spawn(anvilPath, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--accounts', '2', '--balance', '1000', '--hardfork', 'cancun', '--gas-limit', '30000000', '--silent'], {shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let failed = false, processBytes = 0;
    child.on('error', () => { failed = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processBytes += data.length; if (processBytes > 1024 * 1024) child.kill('SIGKILL'); });
    const sourceRpc = localRpc('http://127.0.0.1:' + port);
    const deadline = Date.now() + 15000; let accounts;
    while (Date.now() < deadline && !failed && child.exitCode === null) {
      try { accounts = await sourceRpc('eth_accounts'); break; } catch { await WAIT(100); }
    }
    assert(accounts?.length >= 2, 'Synthetic source Anvil did not start');
    assert.equal(await sourceRpc('eth_chainId'), q(4663));
    const wallet = accounts[0].toLowerCase(), otherWallet = accounts[1].toLowerCase();
    const setupTransactions = [];
    async function send(tx) {
      const hash = await sourceRpc('eth_sendTransaction', [{from: wallet, gas: q(28000000), ...tx}]);
      const end = Date.now() + 6000; let receipt;
      while (Date.now() < end) { receipt = await sourceRpc('eth_getTransactionReceipt', [hash]); if (receipt) break; await WAIT(50); }
      assert(receipt && receipt.status === '0x1', 'Synthetic setup transaction failed: ' + hash);
      setupTransactions.push(hash); return receipt;
    }
    const deploy = async (code, args = '') => (await send({data: code + args})).contractAddress.toLowerCase();
    const manager = await deploy(artifacts.PoolManager.code, word(wallet));
    const permit2 = await deploy(artifacts.Permit2.code);
    const router = await deploy(artifacts.UniversalRouter.code, [permit2, ZERO, ZERO, ZERO, 0, 0, manager, ZERO, ZERO, ZERO].map(word).join(''));
    const tokens = [await deploy(compiled.contracts.FixtureToken), await deploy(compiled.contracts.FixtureToken)].sort();
    const [tokenA, tokenB] = tokens;
    const lp = await deploy(compiled.contracts.FixtureLiquidity, word(manager));
    const factory = await deploy(compiled.contracts.FixtureFactory);
    const hook = await mineHook(factory, compiled.contracts.FixtureFeeHook + word(manager));
    await send({to: factory, data: calldata('deployFeeHook(address,bytes32)', manager, hook.salt)});
    assert.notEqual(await sourceRpc('eth_getCode', [hook.address, 'latest']), '0x', 'Mined fee hook must be deployed');
    for (const token of tokens) {
      await send({to: token, data: calldata('mint(address,uint256)', lp, 10n ** 25n)});
      await send({to: token, data: calldata('mint(address,uint256)', wallet, 10n ** 22n)});
      await send({to: token, data: calldata('mint(address,uint256)', otherWallet, 10n ** 22n)});
      await send({to: token, data: calldata('approve(address,uint256)', permit2, 10n ** 22n)});
      await send({to: permit2, data: calldata('approve(address,address,uint160,uint48)', token, router, 10n ** 22n, (1n << 48n) - 1n)});
    }
    const key = (fee, spacing, hooks = ZERO, c0 = tokenA, c1 = tokenB) => ({currency0: c0, currency1: c1, fee, tick_spacing: spacing, hooks});
    const pools = {low: key(500, 10), high: key(3000, 60), discount: key(3000, 120), hook: key(3000, 60, hook.address), native: key(500, 10, ZERO, ZERO, tokenA)};
    for (const [name, k] of Object.entries(pools)) {
      const native = name === 'native', discount = name === 'discount';
      await send({to: lp, value: native ? q(10n ** 18n) : '0x0', data: calldata('seed((address,address,uint24,int24,address),uint160,int24,int24,int256)', k.currency0, k.currency1, k.fee, k.tick_spacing, k.hooks, discount ? (1n << 96n) * 99n / 100n : 1n << 96n, discount ? -360 : native ? -60 : -120, discount ? 0 : native ? 60 : 120, native ? 10n ** 18n : 10n ** 20n)});
    }
    const header = await sourceRpc('eth_getBlockByNumber', ['latest', false]);
    const block = {number: Number(BigInt(header.number)), hash: header.hash, timestamp: Number(BigInt(header.timestamp))};
    const pairs = tokens.flatMap(address => [wallet, otherWallet, router, manager, lp, hook.address].map(owner => ({address, owner})));
    async function sourceState() {
      const balances = [];
      for (const pair of pairs) balances.push(BigInt(await sourceRpc('eth_call', [{to: pair.address, data: calldata('balanceOf(address)', pair.owner)}, 'latest'])).toString());
      const owners = [wallet, otherWallet, router, manager, lp, hook.address];
      const native = await Promise.all(owners.map(owner => sourceRpc('eth_getBalance', [owner, 'latest'])));
      return {balances, native, nonce: await sourceRpc('eth_getTransactionCount', [wallet, 'latest']), block: await sourceRpc('eth_blockNumber')};
    }
    const before = await sourceState();
    proxy = await readonlyProxy(sourceRpc);
    const readRpc = makeRpc(proxy.url);
    const base = {schema_version: 'circuit.route.v1', adapter: ADAPTER, chain_id: 4663, block, router, pool_manager: manager, permit2, wallet, recipient: wallet, wallet_context: 'synthetic', currency_in: tokenA, amount_in: '1000000000000000', minimum_out: '1', deadline: String(block.timestamp + 3600), gas: '3000000'};
    const hop = (pool_key, currency_out) => ({pool_key, currency_out, hook_data: '0x'});
    const cases = {};
    async function run(name, changes, expected = 'FORK_EXECUTED_AT_BLOCK') {
      const built = buildRoute({...base, ...changes});
      let preflight;
      if (['open_route', 'missing_permit2_allowance'].includes(name)) {
        preflight = await collectPreflight(built, {rpc: readRpc});
        assert.equal(preflight.status, name === 'open_route' ? 'PREFLIGHT_OBSERVED' : 'PREFLIGHT_BLOCKED', name + ': preflight observation');
        await validatePreflight(built, preflight);
        assert.equal(preflight.router_wiring.pool_manager_matches, true);
        if (name === 'missing_permit2_allowance') assert(preflight.issues.some(x => x.code === 'INSUFFICIENT_PERMIT2_TO_ROUTER_ALLOWANCE'));
      }
      const fork = await simulateFork(built.call_request, {anvilPath, rpcUrl: proxy.url});
      assert.equal(fork.status, expected, name + ': ' + fork.issues.join(','));
      validateForkEvidence(fork);
      assert(fork.token_balances.filter(x => x.owner === router).every(x => x.delta_raw === '0'), name + ': router token dust');
      assert.equal(fork.native_balances.find(x => x.owner === router)?.delta_raw, '0', name + ': router native dust');
      cases[name] = {built, ...(preflight ? {preflight} : {}), fork}; return fork;
    }
    const delta = (report, token, owner = wallet) => BigInt(report.token_balances.find(x => x.token === token && x.owner === owner)?.delta_raw ?? assert.fail('Missing token balance'));
    const open = await run('open_route', {hops: [hop(pools.high, tokenB)]});
    assert.equal(delta(open, tokenA), -BigInt(base.amount_in));
    assert(delta(open, tokenB) > 0n && delta(open, tokenB) < BigInt(base.amount_in));
    const cycle = await run('same_asset_cycle', {hops: [hop(pools.low, tokenB), hop(pools.high, tokenA)]});
    assert(delta(cycle, tokenA) < 0n && delta(cycle, tokenA) > -BigInt(base.amount_in));
    assert.equal(delta(cycle, tokenB), 0n, 'Cycle must settle all intermediate credits');
    const positiveCycle = await run('positive_spread_cycle', {hops: [hop(pools.low, tokenB), hop(pools.discount, tokenA)], minimum_out: String(BigInt(base.amount_in) + 1n)});
    assert(delta(positiveCycle, tokenA) > 0n, 'Deliberately mispriced synthetic pool must settle positive final input credit');
    assert.equal(delta(positiveCycle, tokenB), 0n, 'Positive cycle must settle all intermediate credits');
    const minimum = await run('minimum_output_revert', {hops: [hop(pools.low, tokenB), hop(pools.high, tokenA)], minimum_out: base.amount_in}, 'FORK_REVERTED_AT_BLOCK');
    assert(minimum.token_balances.every(x => x.delta_raw === '0'));
    const allowance = await run('missing_permit2_allowance', {wallet: otherWallet, recipient: otherWallet, hops: [hop(pools.high, tokenB)]}, 'FORK_REVERTED_AT_BLOCK');
    assert(allowance.token_balances.every(x => x.delta_raw === '0'));
    const hooked = await run('after_swap_fee_hook', {hops: [hop(pools.hook, tokenB)]});
    assert.equal(delta(hooked, tokenA), -BigInt(base.amount_in));
    assert.equal(delta(hooked, tokenB), delta(open, tokenB) - delta(open, tokenB) / 100n, 'Hook output must include the 1% unspecified delta exactly once');
    const native = await run('native_partial_fill_refund', {currency_in: ZERO, amount_in: '1000000000000000000', hops: [hop(pools.native, tokenA)]});
    const nativeMovement = BigInt(native.native_balances.find(x => x.owner === wallet).delta_raw) + BigInt(native.costs.local_execution_gas_wei);
    assert(nativeMovement < 0n && nativeMovement > -(10n ** 18n), 'Partial native fill must refund unused prepaid currency');
    assert(delta(native, tokenA) > 0n);
    const partial = await run('erc20_partial_fill_refund', {amount_in: '1000000000000000000', hops: [hop(pools.low, tokenB)]});
    assert(delta(partial, tokenA) < 0n && delta(partial, tokenA) > -(10n ** 18n), 'Partial ERC20 fill must refund unused prepaid currency');
    assert(delta(partial, tokenB) > 0n);
    assert.deepEqual(await sourceState(), before, 'Measured fork calls changed source state');
    assert.deepEqual(proxy.denied, [], 'Fork collector attempted a source write');
    const result = {schema_version: 'circuit.synthetic-evm-smoke.v1', status: 'PASSED', evidence_mode: 'synthetic', mainnet_qualification: false, validated_at: new Date().toISOString(), fixture_compiler: compiled.compiler, fixture_source_digest: compiled.source_digest, anvil: open.fork_origin.anvil_version, protocol_artifacts: Object.values(artifacts).map(({code, ...metadata}) => metadata), source_setup: {chain_id: 4663, block, manager, permit2, router, wallet, other_wallet: otherWallet, token_a: tokenA, token_b: tokenB, fee_hook: hook.address, pools, transactions: setupTransactions}, assertions: {real_upstream_universal_router_2_1_1: true, real_upstream_pool_manager_and_permit2: true, compiler_calldata_executed_unchanged: true, open_route_final_balances: true, same_asset_cycle_prepaid_and_settled: true, positive_spread_cycle_settled_with_minimum_above_input: true, minimum_output_revert: true, missing_permit2_approval_revert_with_funded_token_wallet: true, after_swap_return_delta_deducted_once: true, native_partial_fill_refunded: true, erc20_partial_fill_refunded: true, zero_router_route_currency_dust: true, source_state_unchanged: true, source_rpc_writes_attempted: 0}, source_read_methods: [...new Set(proxy.observed)].sort(), limitations: ['Isolated synthetic liquidity and original fixture tokens/hook; no Robinhood live deployment or Pons runtime is qualified.', 'Protocol creation artifacts are taken from pinned upstream deployment libraries; this harness verifies their hashes but does not independently rebuild the upstream contracts.', 'Anvil next-block execution does not model all Robinhood Nitro behavior or L1 data fees.', 'The deliberately mispriced pool only validates positive token-credit settlement. It is not a discovered market opportunity or a net-profit result.', 'Passing a cycle with a low output minimum does not imply positive spread or profitability; the equal-price cycle in this fixture loses tokens to fees and impact.'], cases};
    if (outputPath) { await mkdir(dirname(outputPath), {recursive: true}); await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600}); }
    return result;
  } finally {
    if (proxy) { proxy.server.closeAllConnections(); await new Promise(resolve => proxy.server.close(resolve)); }
    await stop(child);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), opts = {};
    for (let i = 0; i < args.length; i += 2) {
      assert(['--anvil', '--solc', '--output'].includes(args[i]) && isAbsolute(args[i + 1] ?? '') && !Object.hasOwn(opts, args[i]), 'Usage: --anvil /absolute/anvil --solc /absolute/solc/index.js [--output /absolute/new-report.json]');
      opts[args[i]] = args[i + 1];
    }
    const report = await runEvmSmoke({anvilPath: opts['--anvil'], solcPath: opts['--solc'], outputPath: opts['--output']});
    const {cases, ...summary} = report;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (e) { process.stderr.write('CIRCUIT real-protocol smoke failed: ' + e.message + '\n'); process.exitCode = 1; }
}
