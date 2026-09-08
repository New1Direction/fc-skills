#!/usr/bin/env node
/**
 * Actual local-EVM capture exercise. Requires a separately installed Anvil.
 * This authorizes fixture transactions only on the newly spawned loopback node.
 * WATCHTOWER sees a separate HTTP proxy with an explicit read-method allowlist.
 * No remote RPC, fork endpoint, signer, npm dependency, or solc is used.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const CHAIN_ID = 4663;
const REVERT_INIT = '0x6005600c60003960056000f360006000fd';
const REVERT_RUNTIME = '0x60006000fd';
const READ_METHODS = new Set([
  'eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getBlockReceipts', 'eth_getTransactionReceipt',
]);
const SOURCE_METHODS = new Set([
  ...READ_METHODS, 'eth_accounts', 'eth_getCode', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_sendTransaction', 'evm_mine',
]);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const hex = value => `0x${BigInt(value).toString(16)}`;
const lower = value => value.toLowerCase();

async function readLimited(stream, limit) {
  const buffers = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('SMOKE_RESPONSE_TOO_LARGE');
    buffers.push(Buffer.from(chunk));
  }
  return Buffer.concat(buffers).toString('utf8');
}

async function pickLoopbackPort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
  return port;
}

function localRpc(url, methodSet) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.protocol, 'http:');
  let id = 0;
  const metrics = { methods: {} };
  const call = async (method, params = []) => {
    assert(methodSet.has(method), 'SMOKE_SOURCE_METHOD_NOT_ALLOWED');
    metrics.methods[method] = (metrics.methods[method] ?? 0) + 1;
    const requestId = ++id;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`SMOKE_RPC_HTTP_${response.status}`);
    const raw = await readLimited(response.body, 8 * 1024 * 1024);
    const data = JSON.parse(raw);
    assert.equal(data.jsonrpc, '2.0');
    assert.equal(data.id, requestId);
    if (data.error) throw Object.assign(new Error(`SMOKE_RPC_ERROR_${data.error.code}`), { rpcCode: data.error.code });
    if (!Object.hasOwn(data, 'result')) throw new Error('SMOKE_RPC_RESULT_MISSING');
    return data.result;
  };
  call.metrics = metrics;
  return call;
}

async function startReadonlyProxy(sourceRpc) {
  const metrics = { read_requests: 0, disallowed_requests: 0, write_attempts: 0, methods: {} };
  const server = createServer(async (request, response) => {
    let id = null;
    const respond = payload => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    try {
      if (request.method !== 'POST') throw new Error('POST_REQUIRED');
      const data = JSON.parse(await readLimited(request, 128 * 1024));
      if (Array.isArray(data)) throw new Error('SINGLE_RPC_REQUEST_REQUIRED');
      id = data.id ?? null;
      if (data.jsonrpc !== '2.0' || typeof data.method !== 'string' || !Array.isArray(data.params)) {
        throw new Error('INVALID_RPC_REQUEST');
      }
      if (!READ_METHODS.has(data.method)) {
        metrics.disallowed_requests += 1;
        if (/send|sign|submit|mine|set|impersonate|snapshot|revert|reset|dump|load|stop/i.test(data.method)) {
          metrics.write_attempts += 1;
        }
        respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Read method not allowed' } });
        return;
      }
      metrics.read_requests += 1;
      metrics.methods[data.method] = (metrics.methods[data.method] ?? 0) + 1;
      const result = await sourceRpc(data.method, data.params);
      respond({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!response.headersSent) respond({ jsonrpc: '2.0', id, error: { code: Number.isInteger(error.rpcCode) ? error.rpcCode : -32603, message: 'Local smoke proxy request failed' } });
      else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, metrics,
    close: async () => {
      const done = new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
      server.closeAllConnections();
      await done;
    },
  };
}

async function sourceState(rpc, accounts, contractAddress) {
  const [head, ...values] = await Promise.all([
    rpc('eth_getBlockByNumber', ['latest', false]),
    ...accounts.map(account => rpc('eth_getBalance', [account, 'latest'])),
    ...accounts.map(account => rpc('eth_getTransactionCount', [account, 'latest'])),
    rpc('eth_getCode', [contractAddress, 'latest']),
  ]);
  return {
    head_number: head.number, head_hash: head.hash, state_root: head.stateRoot,
    balances: values.slice(0, accounts.length),
    nonces: values.slice(accounts.length, 2 * accounts.length),
    contract_runtime: values.at(-1),
  };
}

/** Run this optional fixture locally. The caller supplies only a binary path. */
export async function evmSmoke({ anvilPath, durationSeconds = 3 } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE_24_REQUIRED');
  if (typeof anvilPath !== 'string' || anvilPath.length === 0) throw new Error('ANVIL_PATH_REQUIRED');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 30) throw new Error('DURATION_MUST_BE_2_TO_30_SECONDS');
  const binary = resolve(anvilPath);
  assert((await stat(binary)).isFile(), 'ANVIL_BINARY_MUST_BE_FILE');
  const { stdout: anvilVersionRaw } = await promisify(execFile)(binary, ['--version'], { timeout: 5000, maxBuffer: 16_384 });
  const anvilVersion = anvilVersionRaw.trim().slice(0, 1024);
  const workspace = await mkdtemp(resolve(tmpdir(), 'watchtower-evm-'));
  const rpcEnv = `WATCHTOWER_SMOKE_RPC_${process.pid}`;
  const previousEnv = process.env[rpcEnv];
  let child, proxy, store;
  try {
    const port = await pickLoopbackPort();
    child = spawn(binary, [
      '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID),
      '--no-mining', '--no-cors', '--quiet', '--order', 'fifo', '--accounts', '4',
      '--hardfork', 'cancun',
    ], { cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let spawnFailure = false;
    child.once('error', () => { spawnFailure = true; });
    // Consume bounded diagnostics without printing dev keys or arbitrary binary output.
    let diagnosticBytes = 0;
    child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 256 * 1024) child.kill('SIGTERM'); });
    const rpc = localRpc(`http://127.0.0.1:${port}`, SOURCE_METHODS);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnFailure || child.exitCode !== null) throw new Error('ANVIL_STARTUP_FAILED');
      try { ready = Number(BigInt(await rpc('eth_chainId'))) === CHAIN_ID; } catch { /* bounded startup only */ }
      if (ready) break;
      await delay(100);
    }
    assert(ready, 'ANVIL_STARTUP_TIMEOUT');
    const accounts = (await rpc('eth_accounts')).slice(0, 4);
    assert.equal(accounts.length, 4);
    const send = request => rpc('eth_sendTransaction', [{ gasPrice: '0x77359400', ...request }]);
    const fixtureHashes = [];
    const deploymentHash = await send({ from: accounts[0], data: REVERT_INIT, gas: '0x186a0', nonce: '0x0' });
    fixtureHashes.push(deploymentHash);
    fixtureHashes.push(await send({ from: accounts[1], to: accounts[2], value: '0x3e8', gas: '0x5208', nonce: '0x0' }));
    fixtureHashes.push(await send({ from: accounts[2], to: accounts[3], value: '0x7d0', gas: '0x5208', nonce: '0x0' }));
    await rpc('evm_mine');
    const deployment = await rpc('eth_getTransactionReceipt', [deploymentHash]);
    assert.equal(deployment.status, '0x1');
    assert.match(deployment.contractAddress, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(await rpc('eth_getCode', [deployment.contractAddress, 'latest']), REVERT_RUNTIME);
    const revertedHash = await send({ from: accounts[0], to: deployment.contractAddress, data: '0x12345678', gas: '0x186a0', nonce: '0x1' });
    fixtureHashes.push(revertedHash);
    fixtureHashes.push(await send({ from: accounts[1], to: accounts[3], value: '0xbb8', gas: '0x5208', nonce: '0x1' }));
    await rpc('evm_mine');
    await rpc('evm_mine'); // A real empty block must also enter contiguous coverage.
    const before = await sourceState(rpc, accounts, deployment.contractAddress);
    const fixtureWrites = { eth_sendTransaction: rpc.metrics.methods.eth_sendTransaction ?? 0, evm_mine: rpc.metrics.methods.evm_mine ?? 0 };
    assert.deepEqual(fixtureWrites, { eth_sendTransaction: 5, evm_mine: 3 });
    assert.equal(Number(BigInt(before.head_number)), 3);
    const expectedBlocks = await Promise.all([1, 2, 3].map(number => rpc('eth_getBlockByNumber', [hex(number), true])));
    const expectedReceipts = await Promise.all(fixtureHashes.map(hash => rpc('eth_getTransactionReceipt', [hash])));
    assert.deepEqual(expectedBlocks.map(block => block.transactions.length), [3, 2, 0]);
    assert.equal(expectedReceipts.find(receipt => lower(receipt.transactionHash) === lower(revertedHash)).status, '0x0');
    assert.deepEqual(new Set(expectedBlocks.flatMap(block => block.transactions.map(tx => lower(tx.hash)))), new Set(fixtureHashes.map(lower)));

    // Only this allowlisted proxy is configured in WATCHTOWER's actual HTTP transport.
    proxy = await startReadonlyProxy(rpc);
    process.env[rpcEnv] = proxy.url;
    const { openStore } = await import('./store.mjs');
    const { capture } = await import('./capture.mjs');
    const storePath = resolve(workspace, 'watchtower.sqlite');
    const storeOptions = { chainId: CHAIN_ID, startBlock: 1, reorgDepth: 32, maxBytes: 128 * 1024 * 1024 };
    store = openStore(storePath, storeOptions);
    const config = {
      chain_id: CHAIN_ID, sources: [{ name: 'local-readonly', http_env: rpcEnv }],
      primary_source: 'local-readonly', from_block: 1,
      poll_ms: 50, request_timeout_ms: 5000, block_concurrency: 3,
      receipt_concurrency: 4, max_blocks_per_round: 16, reorg_depth: 32,
      max_response_bytes: 8 * 1024 * 1024, max_requests_per_second: 100,
      max_pending_receipt_blocks: 32, duration_seconds: durationSeconds,
    };
    const started = performance.now();
    const run = await capture(config, { store, signal: AbortSignal.timeout((durationSeconds + 15) * 1000) });
    const captureElapsedMs = performance.now() - started;
    const coverage = store.coverage();
    assert.equal(coverage.block_count, 3, 'EVERY_FIXED_SOURCE_BLOCK_CAPTURED');
    assert.equal(coverage.transaction_count, 5, 'EVERY_FIXED_SOURCE_TRANSACTION_CAPTURED');
    assert.equal(coverage.receipt_count, 5, 'EVERY_FIXED_SOURCE_RECEIPT_CAPTURED');
    assert.equal(coverage.pending_receipt_blocks, 0, 'NO_PENDING_RECEIPT_BLOCKS');
    assert.equal(coverage.contiguous_block_head, 3, 'CONTIGUOUS_BLOCK_COVERAGE');
    assert.equal(coverage.contiguous_receipt_head, 3, 'CONTIGUOUS_RECEIPT_COVERAGE');
    assert.equal(store.pendingReceipts(100).length, 0);
    const retained = expectedBlocks.map(expected => {
      const actual = store.block(Number(BigInt(expected.number)));
      assert(actual, 'BLOCK_RETAINED');
      assert.equal(lower(actual.hash), lower(expected.hash));
      const txs = store.transactions(actual.hash);
      assert.deepEqual(txs, expected.transactions, 'FULL_TRANSACTION_OBJECTS_RETAINED');
      const receipts = store.receipts(actual.hash);
      assert(Array.isArray(receipts), 'RECEIPT_SET_RECONCILED');
      const expectedForBlock = expectedReceipts.filter(receipt => lower(receipt.blockHash) === lower(expected.hash));
      expectedForBlock.sort((a, b) => Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)));
      assert.deepEqual(receipts, expectedForBlock, 'FULL_RECEIPTS_MATCH_INDEPENDENT_SOURCE');
      return { block: actual, receipts };
    });
    store.close();
    store = openStore(storePath, storeOptions);
    const reopened = store.coverage();
    for (const key of ['block_count', 'transaction_count', 'receipt_count', 'contiguous_block_head', 'contiguous_receipt_head']) {
      assert.equal(reopened[key], coverage[key], `DURABLE_REOPEN_${key}`);
    }
    assert.equal(store.receipts(expectedBlocks[1].hash).find(receipt => lower(receipt.transactionHash) === lower(revertedHash)).status, '0x0');
    assert.equal(lower(store.receipts(expectedBlocks[0].hash).find(receipt => lower(receipt.transactionHash) === lower(deploymentHash)).contractAddress), lower(deployment.contractAddress));
    const { routeEvents, runJobs, workerStatus, readClassifications, readOutbox } = await import('./workers.mjs');
    const policy = {
      version: 'smoke-v1', max_queue: 2048, max_attempts: 3, lease_ms: 30_000,
      timeout_ms: 10_000, max_result_bytes: 4 * 1024 * 1024, rules: [],
    };
    const routing = routeEvents(store, { policy, limit: 1000 });
    assert.equal(routing.paused, false, 'ALL_RETAINED_EVENTS_ROUTED');
    const jobs = await runJobs(store, { limit: 1000 });
    const workers = workerStatus(store);
    assert.equal(workers.jobs.QUEUED ?? 0, 0, 'NO_QUEUED_CLASSIFICATION_JOBS');
    assert.equal(workers.jobs.FAILED ?? 0, 0, 'NO_FAILED_CLASSIFICATION_JOBS');
    assert.equal(workers.classifications.with_receipts, 5, 'EVERY_TRANSACTION_CLASSIFIED_WITH_RECEIPT');
    const classifications = expectedBlocks.flatMap(block => readClassifications(store, { blockHash: block.hash }));
    assert.equal(classifications.length, 5);
    assert.deepEqual(new Set(classifications.map(row => row.transaction_hash)), new Set(fixtureHashes.map(lower)));
    assert.equal(classifications.filter(row => row.execution_status === 'REVERTED').length, 1);
    assert.equal(classifications.filter(row => row.top_level_kind === 'CONTRACT_CREATION').length, 1);
    assert.equal(classifications.filter(row => row.has_native_value && row.execution_status === 'SUCCESS').length, 3);
    assert(classifications.every(row => row.receipt_present && row.coverage.internal_calls === 'NOT_COLLECTED'));
    const outbox = readOutbox(store, { after: 0, limit: 1000 });
    const after = await sourceState(rpc, accounts, deployment.contractAddress);
    assert.deepEqual({ eth_sendTransaction: rpc.metrics.methods.eth_sendTransaction ?? 0, evm_mine: rpc.metrics.methods.evm_mine ?? 0 }, fixtureWrites, 'NO_SOURCE_WRITES_AFTER_FIXTURE_SETUP');
    assert.deepEqual(after, before, 'SOURCE_STATE_UNCHANGED_DURING_CAPTURE');
    assert.equal(proxy.metrics.write_attempts, 0, 'WATCHTOWER_ZERO_WRITE_ATTEMPTS');
    assert.equal(proxy.metrics.disallowed_requests, 0, 'WATCHTOWER_ONLY_ALLOWED_READ_METHODS');
    assert(proxy.metrics.read_requests > 0, 'ACTUAL_HTTP_RPC_READS_OCCURRED');
    return {
      schema_version: 'watchtower.synthetic-evm-smoke.v1',
      evidence_kind: 'synthetic_actual_local_evm', mainnet_qualification: false,
      chain_id: CHAIN_ID, anvil_version: anvilVersion, node_version: process.version,
      status: 'PASS', recorded_at: new Date().toISOString(),
      scope: {
        from_block: 1, through_block: 3, source_blocks: 3, source_transactions: 5,
        native_transfers: 3, contract_creations: 1, reverted_transactions: 1, empty_blocks: 1,
        internal_trace_coverage: 'NOT_COLLECTED', nitro_feed_validation: 'NOT_TESTED',
        profitability: 'NOT_EVALUATED', live_mainnet: false,
      },
      fixture: {
        chain_environment: 'fresh_loopback_Anvil_no_fork',
        fixture_authoring: 'separate_source_client_on_new_local_node_only',
        fixture_authoring_rpc_writes: fixtureWrites,
        init_bytecode: REVERT_INIT, deployed_runtime: REVERT_RUNTIME,
        deployment_transaction: deploymentHash, reverted_transaction: revertedHash,
        all_transaction_hashes: fixtureHashes,
      },
      checks: {
        every_source_transaction_and_receipt_retained: true,
        reverted_transaction_retained: true, contract_creation_retained: true,
        empty_block_retained: true, durable_reopen: true,
        every_transaction_classified_with_receipt: true,
        source_head_balances_nonces_code_and_state_root_unchanged: true,
        watchtower_write_attempts: 0,
      },
      capture_elapsed_ms: captureElapsedMs,
      capture_run: run, coverage, reopened_coverage: reopened,
      routing, classification_jobs: jobs, worker_status: workers, classifications, outbox,
      readonly_proxy: { ...proxy.metrics, allowed_methods: [...READ_METHODS] },
      source_state_before: before, source_state_after: after, retained,
      interpretation: 'This validates actual local-EVM RPC capture, durable persistence and classification of a fixed synthetic chain window. It does not establish Robinhood mainnet coverage, Nitro decoding, finality, internal-call coverage, or production latency.',
    };
  } finally {
    try { store?.close(); } catch { /* Preserve original failure. */ }
    if (previousEnv === undefined) delete process.env[rpcEnv];
    else process.env[rpcEnv] = previousEnv;
    try { await proxy?.close(); } catch { /* Preserve original failure. */ }
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit').catch(() => {}), delay(1500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/evm-smoke.mjs --anvil /absolute/path/to/anvil --out /absolute/path/to/report.json [--duration-seconds 3]\nUses a fresh isolated loopback Anvil; never connects to a live network. Node24 required. --output is an alias for --out.\n');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i] === '--output' ? '--out' : args[i];
    if (!['--anvil', '--out', '--duration-seconds'].includes(key) || !args[i + 1] || options[key] !== undefined) throw new Error('INVALID_ARGUMENTS_USE_HELP');
    options[key] = args[i + 1];
  }
  if (!options['--anvil'] || !options['--out']) throw new Error('ANVIL_AND_OUTPUT_REQUIRED');
  const report = await evmSmoke({ anvilPath: options['--anvil'], durationSeconds: Number(options['--duration-seconds'] ?? 3) });
  const output = resolve(options['--out']);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, evidence_kind: report.evidence_kind, blocks: report.scope.source_blocks, transactions: report.scope.source_transactions, write_attempts: report.readonly_proxy.write_attempts, mainnet_qualification: false })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`WATCHTOWER local EVM smoke failed: ${String(error.message).replaceAll(/https?:\/\/\S+/g, '[endpoint]').slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
