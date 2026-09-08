/** Optional real-EVM smoke. Deployments are confined to our own synthetic local Anvil. */
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer as createNetServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {readFile, mkdir, writeFile, access} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {keccakHex} from './keccak.mjs';
import {makeRpc} from './rpc.mjs';
import {collectSupply, validateCollection} from './collect.mjs';
import {analyzeSupply} from './supply.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = n => '0x' + BigInt(n).toString(16);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const units = n => BigInt(n) * 10n ** 18n;
const selector = signature => keccakHex(Buffer.from(signature)).slice(0, 10);
const calldata = (signature, ...args) => selector(signature) + args.map(word).join('');
const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_getBalance', 'eth_getTransactionCount']);
const TRANSFER = keccakHex(Buffer.from('Transfer(address,address,uint256)'));
const ZERO = '0x' + '0'.repeat(40);

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
  const server = createNetServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}
async function compile(solcPath) {
  await access(solcPath, fsConstants.R_OK);
  const solc = createRequire(import.meta.url)(solcPath);
  const source = await readFile(resolve(HERE, '../assets/StockSmoke.sol'), 'utf8');
  const input = {language: 'Solidity', sources: {'StockSmoke.sol': {content: source}}, settings: {optimizer: {enabled: true, runs: 200}, evmVersion: 'paris', outputSelection: {'*': {'*': ['evm.bytecode.object']}}}};
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = result.errors?.filter(e => e.severity === 'error') ?? [];
  assert.equal(errors.length, 0, 'Synthetic Solidity compilation failed: ' + errors.map(e => e.message).join('; '));
  return {compiler: solc.version(), source_digest: digest(source), bytecode: '0x' + result.contracts['StockSmoke.sol'].StockSmoke.evm.bytecode.object};
}
function localRpc(url) {
  let next = 0;
  return async (method, params = []) => {
    const id = ++next;
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(6000), body: JSON.stringify({jsonrpc: '2.0', id, method, params})});
    assert(response.ok, 'Local source RPC HTTP failure');
    const raw = await response.text(); assert(raw.length <= 4 * 1024 * 1024, 'Local source RPC response too large');
    const data = JSON.parse(raw); assert.equal(data.id, id); assert.equal(data.jsonrpc, '2.0');
    if (data.error) { const error = new Error('Local synthetic RPC error'); error.code = data.error.code; error.data = data.error.data; throw error; }
    return data.result;
  };
}
async function readonlyProxy(sourceRpc) {
  const observed = [], denied = [];
  let dropTransferLog = false;
  const server = createHttpServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      assert.equal(req.method, 'POST');
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; assert(length <= 262144, 'Proxy request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks));
      assert(body && !Array.isArray(body) && typeof body.method === 'string', 'Single RPC requests required');
      observed.push({method: body.method, params: body.params ?? []});
      if (!READ_METHODS.has(body.method)) {
        denied.push(body.method); res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, error: {code: -32601, message: 'Synthetic source is read-only'}})); return;
      }
      try {
        let result = await sourceRpc(body.method, body.params ?? []);
        // Simulate a provider omitting the first event while retaining the next log index.
        if (dropTransferLog && body.method === 'eth_getTransactionReceipt' && result?.logs?.[0]?.topics?.[0]?.toLowerCase() === TRANSFER) result = {...result, logs: result.logs.slice(1)};
        res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
      } catch (error) {
        res.end(JSON.stringify({jsonrpc: '2.0', id: body.id, error: {code: error.code ?? -32000, message: 'Synthetic upstream error'}}));
      }
    } catch { res.statusCode = 400; res.end(JSON.stringify({error: 'Invalid local RPC request'})); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {server, observed, denied, url: 'http://127.0.0.1:' + server.address().port, omitLog: () => { dropTransferLog = true; }};
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
    child = spawn(anvilPath, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--accounts', '4', '--balance', '1000', '--silent'], {shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let failed = false, processBytes = 0;
    child.on('error', () => { failed = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { processBytes += data.length; if (processBytes > 1024 * 1024) child.kill('SIGKILL'); });
    const sourceRpc = localRpc('http://127.0.0.1:' + port);
    const deadline = Date.now() + 15000;
    let accounts;
    while (Date.now() < deadline && !failed && child.exitCode === null) {
      try { accounts = await sourceRpc('eth_accounts'); break; } catch { await WAIT(100); }
    }
    assert(accounts?.length >= 4, 'Synthetic source Anvil did not start');
    assert.equal(await sourceRpc('eth_chainId'), q(4663));
    const [issuer, holder, venue, other] = accounts.map(x => x.toLowerCase());
    const transactions = [];
    async function send(tx) {
      const hash = await sourceRpc('eth_sendTransaction', [{from: issuer, gas: '0x4c4b40', ...tx}]);
      const end = Date.now() + 6000; let receipt;
      while (Date.now() < end) { receipt = await sourceRpc('eth_getTransactionReceipt', [hash]); if (receipt) break; await WAIT(50); }
      assert(receipt && receipt.status === '0x1', 'Synthetic setup transaction failed'); transactions.push(hash); return receipt;
    }
    const token = (await send({data: compiled.bytecode})).contractAddress.toLowerCase();
    const decoy = (await send({data: compiled.bytecode})).contractAddress.toLowerCase();
    await send({to: token, data: calldata('mint(address,uint256)', issuer, units(200))});
    await send({to: token, data: calldata('mint(address,uint256)', holder, units(200))});
    const startHeader = await sourceRpc('eth_getBlockByNumber', ['latest', false]);
    const start = {number: Number(BigInt(startHeader.number)), hash: startHeader.hash};
    const setupCount = transactions.length;
    await send({to: token, data: calldata('mint(address,uint256)', issuer, units(1000))});
    await send({to: token, data: calldata('transfer(address,uint256)', venue, units(600))});
    await send({from: holder, to: token, data: calldata('burn(uint256)', units(100))});
    await send({to: token, data: calldata('setUiMultiplier(uint256)', units(2))});
    await send({to: decoy, data: calldata('mint(address,uint256)', other, units(17))});
    await send({to: other, value: '0x1'});
    const endHeader = await sourceRpc('eth_getBlockByNumber', ['latest', false]);
    const end = {number: Number(BigInt(endHeader.number)), hash: endHeader.hash};
    const runtimeCode = await sourceRpc('eth_getCode', [token, q(end.number)]);
    const runtimeHash = keccakHex(Buffer.from(runtimeCode.slice(2), 'hex'));
    async function sourceState() {
      const balances = [];
      for (const owner of [issuer, holder, venue, other]) balances.push(BigInt(await sourceRpc('eth_call', [{to: token, data: calldata('balanceOf(address)', owner)}, 'latest'])).toString());
      const supply = BigInt(await sourceRpc('eth_call', [{to: token, data: calldata('totalSupply()')}, 'latest'])).toString();
      const multiplier = BigInt(await sourceRpc('eth_call', [{to: token, data: calldata('uiMultiplier()')}, 'latest'])).toString();
      return {balances, supply, multiplier, block: await sourceRpc('eth_blockNumber'), nonces: await Promise.all([issuer, holder].map(owner => sourceRpc('eth_getTransactionCount', [owner, 'latest'])))};
    }
    const before = await sourceState();
    assert.deepEqual(before.balances, [units(600), units(100), units(600), 0n].map(String));
    assert.equal(before.supply, units(1300).toString());
    assert.equal(before.multiplier, units(2).toString());
    proxy = await readonlyProxy(sourceRpc);
    const readRpc = makeRpc(proxy.url);
    const context = {compiled, token, decoy, runtimeHash, issuer, holder, venue, other, start, end, transactions, setupCount, before};
    const result = await collectAssertions(context, {rpc: readRpc, proxy});
    assert.deepEqual(await sourceState(), before, 'Collector must leave synthetic source state unchanged');
    assert.deepEqual(proxy.denied, [], 'Collector attempted a write to its source endpoint');
    if (outputPath) { await mkdir(dirname(outputPath), {recursive: true}); await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600}); }
    return result;
  } finally {
    if (proxy) { proxy.server.closeAllConnections(); await new Promise(resolve => proxy.server.close(resolve)); }
    await stop(child);
  }
}

async function collectAssertions(context, {rpc, proxy}) {
  const {compiled, token, decoy, runtimeHash, issuer, holder, venue, other, start, end, transactions, setupCount} = context;
  const request = {schema_version: 'pressure.collect.v1', evidence_mode: 'synthetic', chain_id: 4663, token: {address: token, decimals: 18, expected_code_hash: runtimeHash}, start, end, tracked_addresses: [issuer, holder, venue, other], attributions: [{address: venue, category: 'venue', label: 'Original synthetic venue fixture', valid_from_block: start.number, valid_to_block: end.number, evidence_refs: ['synthetic-fixture:' + compiled.source_digest]}]};
  const collection = await collectSupply(request, {rpc});
  assert.equal(collection.status, 'COLLECTED_AT_BLOCK', 'Synthetic supply collection failed: ' + JSON.stringify(collection.issues));
  assert.equal((await validateCollection(collection)).valid, true, 'Retained synthetic evidence must replay');
  const data = collection.dataset;
  assert.equal(data.evidence_mode, 'synthetic', 'Synthetic chain ID must not turn this into mainnet evidence');
  assert.equal(data.snapshots.start.total_supply_raw, units(400).toString());
  assert.equal(data.snapshots.end.total_supply_raw, units(1300).toString());
  assert.equal(data.snapshots.start.multiplier_raw, units(1).toString());
  assert.equal(data.snapshots.end.multiplier_raw, units(2).toString());
  assert.equal(data.transfers.length, 3, 'Only this token\'s standard Transfer logs belong in the ledger');
  const minted = data.transfers.filter(t => t.from === ZERO).reduce((sum, t) => sum + BigInt(t.amount_raw), 0n);
  const burned = data.transfers.filter(t => t.to === ZERO).reduce((sum, t) => sum + BigInt(t.amount_raw), 0n);
  assert.equal(minted, units(1000));
  assert.equal(burned, units(100));
  assert.equal(BigInt(data.snapshots.start.total_supply_raw) + minted - burned, BigInt(data.snapshots.end.total_supply_raw));
  for (const owner of request.tracked_addresses) {
    const before = BigInt(data.snapshots.start.balances.find(b => b.address === owner).balance_raw);
    const after = BigInt(data.snapshots.end.balances.find(b => b.address === owner).balance_raw);
    const received = data.transfers.filter(t => t.to === owner).reduce((sum, t) => sum + BigInt(t.amount_raw), 0n);
    const sent = data.transfers.filter(t => t.from === owner).reduce((sum, t) => sum + BigInt(t.amount_raw), 0n);
    assert.equal(before + received - sent, after, 'Tracked balance reconciliation failed');
  }
  assert.equal(data.coverage.receipts_checked, transactions.length - setupCount);
  assert.equal(data.coverage.receipts_checked, 6);
  assert.equal(data.coverage.logs_checked, 9, 'Coverage must enumerate duplicate display events and unrelated-token events');
  const analysis = analyzeSupply(data);
  assert.equal(analysis.status, 'RECONCILED_WINDOW', 'Actual EVM evidence must reconcile in the supply analyzer');
  assert.equal(analysis.supply.net_issuance_raw, units(900).toString());
  assert.equal(analysis.supply.reconciled, true);
  assert.deepEqual(analysis.display_adjusted_supply.start, {numerator: '400', denominator: '1'});
  assert.deepEqual(analysis.display_adjusted_supply.end, {numerator: '2600', denominator: '1'});
  assert.equal(analysis.display_adjusted_supply.multiplier_changed, true);
  assert(analysis.tracked_balances.every(b => b.reconciled));
  const recipient = analysis.mint_recipient_followup.find(x => x.address === issuer);
  assert.equal(recipient.minted_to_address_raw, units(1000).toString());
  assert.equal(recipient.observed_outgoing_after_first_mint_raw, units(600).toString());
  assert.equal(recipient.subsequent_observed_destinations.find(x => x.address === venue).observed_outgoing_raw, units(600).toString());
  assert.equal(Object.hasOwn(recipient, 'minted_provenance_raw'), false, 'Fungible recipient activity cannot establish provenance');
  assert(recipient.interpretation.includes('Fungibility') && recipient.interpretation.includes('prior inventory'), 'Downstream recipient activity must retain the fungibility limitation');
  const observedReceiptHashes = proxy.observed.filter(x => x.method === 'eth_getTransactionReceipt').map(x => x.params[0]);
  assert.deepEqual(observedReceiptHashes, transactions.slice(setupCount), 'Every transaction receipt in the window must be read, including empty and unrelated receipts');
  proxy.omitLog();
  const omitted = await collectSupply(request, {rpc});
  assert.equal(omitted.status, 'INVALID_EVIDENCE', 'A discontinuous receipt log sequence must invalidate collection');
  assert.equal(omitted.dataset, null, 'Omitted-log evidence must not produce a complete dataset');
  assert.equal((await validateCollection(omitted)).valid, false);
  return {schema_version: 'pressure.synthetic-evm-smoke.v1', status: 'PASSED', evidence_mode: 'synthetic', mainnet_qualification: false, validated_at: new Date().toISOString(), compiler: compiled.compiler, source_digest: compiled.source_digest, source_setup: {chain_id: 4663, start, end, token, decoy_token: decoy, code_hash: runtimeHash, issuer, holder, venue, other, transactions}, assertions: {actual_evm_deployment: true, standard_transfers_count: 3, all_receipts_enumerated: 6, all_logs_enumerated: 9, supply_400_plus_1000_minus_100_equals_1300: true, balances_reconciled: true, ui_multiplier_change_not_a_mint: true, display_transfers_not_double_counted: true, other_token_transfers_excluded: true, retained_collection_replays: true, observed_mint_recipient_transfers_kept_separate_from_provenance: true, omitted_receipt_log_invalidates: true, source_state_unchanged: true, source_rpc_writes_attempted: 0}, source_read_methods: [...new Set(proxy.observed.map(x => x.method))].sort(), limitations: ['Original synthetic ERC-20 fixture is not a Robinhood deployment or issuer implementation.', 'Its local chain ID 4663 exists only to exercise chain checks; this is not mainnet evidence.', 'Local successful collection validates accounting and receipt coverage, not economic backing or a profitable trading strategy.', 'A transfer by a mint recipient does not identify the provenance of fungible units or establish selling intent.', 'Receipt enumeration checks provider-reported coverage and internal consistency; it is not a receipt-trie inclusion proof.'], evidence: {collection, analysis, omitted_log_collection: omitted}};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2));
    const report = await runEvmSmoke({anvilPath: args['--anvil'], solcPath: args['--solc'], outputPath: args['--output']});
    const {evidence, ...summary} = report;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (error) { process.stderr.write('Synthetic EVM smoke failed: ' + error.message + '\n'); process.exitCode = 1; }
}
