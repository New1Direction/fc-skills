/** Optional real-EVM smoke. All deployments/funding use our own synthetic local Anvil. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { keccakHex } from './keccak.mjs';
import { simulateCall, digestValue } from './simulation.mjs';
import { simulateFork, validateForkEvidence } from './fork.mjs';
import { makeRpc } from './rpc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = n => '0x' + BigInt(n).toString(16);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const selector = signature => keccakHex(Buffer.from(signature)).slice(0, 10);
const calldata = (signature, ...args) => selector(signature) + args.map(word).join('');
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getProof', 'eth_getAccountInfo', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_gasPrice', 'eth_feeHistory', 'debug_traceCall', 'net_version', 'web3_clientVersion']);

function options(args) {
  const found = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--anvil', '--solc', '--output'].includes(args[i]) && args[i + 1], 'Usage: --anvil /absolute/anvil --solc /absolute/solc/index.js [--output /absolute/report.json]');
    assert(!Object.hasOwn(found, args[i]), 'Duplicate argument');
    assert(isAbsolute(args[i + 1]), 'Every path must be absolute');
    found[args[i]] = args[i + 1];
  }
  assert(found['--anvil'] && found['--solc'], 'Explicit --anvil and --solc paths are required');
  return found;
}
async function freePort() {
  const s = createNetServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve())); return port;
}
async function compile(solcPath) {
  await access(solcPath, fsConstants.R_OK);
  const solc = createRequire(import.meta.url)(solcPath);
  const source = await readFile(resolve(HERE, '../assets/Smoke.sol'), 'utf8');
  const input = {language: 'Solidity', sources: {'Smoke.sol': {content: source}}, settings: {optimizer: {enabled: true, runs: 200}, evmVersion: 'paris', outputSelection: {'*': {'*': ['evm.bytecode.object']}}}};
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = result.errors?.filter(e => e.severity === 'error') ?? [];
  assert.equal(errors.length, 0, 'Synthetic Solidity compilation failed: ' + errors.map(e => e.message).join('; '));
  return {compiler: solc.version(), source_digest: digestValue(source), token: '0x' + result.contracts['Smoke.sol'].SmokeToken.evm.bytecode.object, router: '0x' + result.contracts['Smoke.sol'].SmokeRouter.evm.bytecode.object};
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

export async function runEvmSmoke({anvilPath, solcPath, outputPath} = {}) {
  assert(isAbsolute(anvilPath ?? '') && isAbsolute(solcPath ?? ''), 'Explicit absolute Anvil and solc paths required');
  if (outputPath !== undefined) assert(isAbsolute(outputPath), 'Output path must be absolute');
  await access(anvilPath, fsConstants.X_OK);
  const compiled = await compile(solcPath);
  let child, proxy;
  try {
    const port = await freePort();
    child = spawn(anvilPath, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--accounts', '2', '--balance', '1000', '--silent'], {shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let failed = false, processBytes = 0;
    child.on('error', () => { failed = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processBytes += data.length; if (processBytes > 1024 * 1024) child.kill('SIGKILL'); });
    const sourceRpc = localRpc('http://127.0.0.1:' + port);
    const deadline = Date.now() + 15000;
    let accounts;
    while (Date.now() < deadline && !failed && child.exitCode === null) {
      try { accounts = await sourceRpc('eth_accounts'); break; } catch { await WAIT(100); }
    }
    assert(accounts?.length >= 2, 'Synthetic source Anvil did not start');
    assert.equal(await sourceRpc('eth_chainId'), q(4663));
    const wallet = accounts[0].toLowerCase(), unfundedTokenWallet = accounts[1].toLowerCase();
    const setupTransactions = [];
    async function send(tx) {
      const hash = await sourceRpc('eth_sendTransaction', [{from: wallet, gas: '0x4c4b40', ...tx}]);
      const end = Date.now() + 6000; let receipt;
      while (Date.now() < end) { receipt = await sourceRpc('eth_getTransactionReceipt', [hash]); if (receipt) break; await WAIT(50); }
      assert(receipt && receipt.status === '0x1', 'Synthetic setup transaction failed'); setupTransactions.push(hash); return receipt;
    }
    const inputToken = (await send({data: compiled.token})).contractAddress.toLowerCase();
    const outputToken = (await send({data: compiled.token})).contractAddress.toLowerCase();
    const router = (await send({data: compiled.router + word(inputToken) + word(outputToken)})).contractAddress.toLowerCase();
    await send({to: inputToken, data: calldata('mint(address,uint256)', wallet, 1000)});
    await send({to: outputToken, data: calldata('mint(address,uint256)', router, 10000)});
    await send({to: inputToken, data: calldata('approve(address,uint256)', router, 1000)});
    const header = await sourceRpc('eth_getBlockByNumber', ['latest', false]);
    const block = {number: Number(BigInt(header.number)), hash: header.hash};
    const pairs = [{address: inputToken, owner: wallet}, {address: outputToken, owner: wallet}, {address: inputToken, owner: router}, {address: outputToken, owner: router}];
    async function sourceState() {
      const balances = [];
      for (const pair of pairs) balances.push(BigInt(await sourceRpc('eth_call', [{to: pair.address, data: calldata('balanceOf(address)', pair.owner)}, 'latest'])).toString());
      return {balances, nonce: await sourceRpc('eth_getTransactionCount', [wallet, 'latest']), native: await sourceRpc('eth_getBalance', [wallet, 'latest']), block: await sourceRpc('eth_blockNumber')};
    }
    const before = await sourceState();
    assert.deepEqual(before.balances, ['1000', '0', '0', '10000']);
    proxy = await readonlyProxy(sourceRpc);
    const readRpc = makeRpc(proxy.url);
    const delta = [-100, 97, 100, -97];
    const request = {schema_version: 'hook-lab.call.v1', chain_id: 4663, block, transaction: {from: wallet, to: router, data: calldata('swap(uint256,uint256)', 100, 97), value: '0x0', gas: '0x7a120'}, balance_tokens: pairs, context: {identity_digest: digestValue({synthetic: true, source: compiled.source_digest, inputToken, outputToken, router}), route_id: 'synthetic-smoke:fixed-rate-3-percent', source_mapping: 'unverified', wallet_context: 'synthetic'}, expectations: pairs.map((p, i) => ({token: p.address, owner: p.owner, minimum_delta: String(delta[i]), maximum_delta: String(delta[i])}))};
    const call = await simulateCall(request, {rpc: readRpc});
    assert.equal(call.status, 'CALL_SUCCEEDED_AT_BLOCK', 'Synthetic exact-call simulation must succeed');
    assert.equal(BigInt(call.call.return_data), 97n, 'Synthetic router return must reflect the 3% deduction');
    assert.equal(call.wallet_deltas.status, 'UNKNOWN', 'eth_call must not be promoted to observed wallet deltas');
    const fork = await simulateFork(request, {anvilPath, rpcUrl: proxy.url});
    assert.equal(fork.status, 'FORK_EXECUTED_AT_BLOCK', 'Synthetic fork failed: ' + fork.issues.join(','));
    validateForkEvidence(fork);
    assert.deepEqual(fork.token_balances.map(x => x.delta_raw), delta.map(String));
    assert(fork.expectations.every(x => x.pass));
    const senderNative = fork.native_balances.find(x => x.owner.toLowerCase() === wallet);
    assert.equal(BigInt(senderNative.delta_raw), -BigInt(fork.costs.local_execution_gas_wei), 'Local native cost must match gas for zero-value swap');
    const bad = structuredClone(request);
    bad.transaction.data = calldata('swap(uint256,uint256)', 100, 98);
    bad.context.route_id = 'synthetic-smoke:minimum-output-revert';
    bad.expectations = pairs.map(p => ({token: p.address, owner: p.owner, minimum_delta: '0', maximum_delta: '0'}));
    const revertedCall = await simulateCall(bad, {rpc: readRpc});
    assert.equal(revertedCall.status, 'CALL_REVERTED_AT_BLOCK', 'Synthetic minimum-output call must revert');
    const revertedFork = await simulateFork(bad, {anvilPath, rpcUrl: proxy.url});
    assert.equal(revertedFork.status, 'FORK_REVERTED_AT_BLOCK', 'Synthetic reverted fork failed: ' + revertedFork.issues.join(','));
    validateForkEvidence(revertedFork);
    assert(revertedFork.token_balances.every(x => x.delta_raw === '0'), 'Reverted transaction must preserve token balances');
    const noAllowance = structuredClone(request);
    noAllowance.transaction.from = unfundedTokenWallet;
    noAllowance.context.route_id = 'synthetic-smoke:no-token-allowance';
    const allowanceCall = await simulateCall(noAllowance, {rpc: readRpc});
    assert.equal(allowanceCall.status, 'CALL_REVERTED_AT_BLOCK', 'Alternate wallet must not inherit the approved wallet allowance');
    assert.deepEqual(await sourceState(), before, 'Calls and fork execution must not change synthetic source state');
    assert.deepEqual(proxy.denied, [], 'Simulation attempted a write to its source endpoint');
    const result = {schema_version: 'hook-lab.synthetic-evm-smoke.v1', status: 'PASSED', evidence_mode: 'synthetic', mainnet_qualification: false, validated_at: new Date().toISOString(), compiler: compiled.compiler, anvil: fork.fork_origin.anvil_version, source_digest: compiled.source_digest, source_setup: {chain_id: 4663, block, input_token: inputToken, output_token: outputToken, router, wallet, transactions: setupTransactions}, assertions: {actual_evm_deployment: true, pinned_call_returns_97: true, call_wallet_deltas_remain_unknown: true, fork_wallet_input_minus_100_output_plus_97: true, fork_router_input_plus_100_output_minus_97: true, local_gas_matches_native_delta: true, minimum_output_revert: true, reverted_tokens_unchanged: true, other_wallet_allowance_not_inherited: true, source_state_unchanged: true, source_rpc_writes_attempted: 0}, source_read_methods: [...new Set(proxy.observed)].sort(), limitations: ['Original synthetic fixed-rate router is not Uniswap V4 or a Robinhood deployment.', 'Successful local EVM execution validates the harness only, not a live hook, trading route or profitable strategy.', 'Anvil next-block execution does not model Robinhood Nitro L1 data fees or all chain-specific behavior.'], evidence: {call, fork, reverted_call: revertedCall, reverted_fork: revertedFork, allowance_call: allowanceCall}};
    if (outputPath) { await mkdir(dirname(outputPath), {recursive: true}); await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600}); }
    return result;
  } finally {
    if (proxy) { proxy.server.closeAllConnections(); await new Promise(resolve => proxy.server.close(resolve)); }
    await stop(child);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2));
    const report = await runEvmSmoke({anvilPath: args['--anvil'], solcPath: args['--solc'], outputPath: args['--output']});
    const {evidence, ...summary} = report;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (e) { process.stderr.write('Synthetic EVM smoke failed: ' + e.message + '\n'); process.exitCode = 1; }
}
