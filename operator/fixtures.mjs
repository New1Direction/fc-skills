// Synthetic protocol-shaped RPC fixtures for operator integration tests and demos.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { syntheticBlock } from '../skills/watchtower/scripts/scenarios.mjs';
import { abiWord, MANAGER, TOPICS } from '../skills/pulse/scripts/pools.mjs';

export const registry = JSON.parse(readFileSync(new URL('../skills/pulse/assets/pools.synthetic.json', import.meta.url)));
const hexWords = values => '0x' + Buffer.concat(values.map(abiWord)).toString('hex');
const topicAddress = address => '0x' + abiWord(address).toString('hex');
export function fixtureBlock(number, { branch = 'a', parent, initialize = false, sqrt = 1n << 96n, missingRemoved = false, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const result = syntheticBlock(number, 4, branch), pool = registry.pools[0];
  result.block.timestamp = '0x' + timestamp.toString(16);
  if (parent) result.block.parentHash = parent;
  const tx = result.block.transactions[0]; tx.to = MANAGER; result.receipts[0].to = MANAGER;
  const common = { address: MANAGER, blockNumber: result.block.number, blockHash: result.block.hash,
    transactionHash: tx.hash, transactionIndex: '0x0', ...(missingRemoved ? {} : { removed: false }) };
  const logs = [];
  if (initialize) logs.push({ ...common, logIndex: '0x0', topics: [TOPICS.Initialize,pool.pool_id,topicAddress(pool.currency0),topicAddress(pool.currency1)],
    data: hexWords([pool.fee,pool.tick_spacing,pool.hooks,1n << 96n,0]) });
  logs.push({ ...common, logIndex: '0x' + logs.length.toString(16), topics: [TOPICS.Swap,pool.pool_id,topicAddress(tx.from)],
    data: hexWords([1000000,-990000,sqrt,1000000000,0,3000]) });
  result.receipts[0].logs = logs;
  return result;
}
export async function fixtureServer(initial) {
  const state = { blocks: new Map(initial.map(r => [Number(BigInt(r.block.number)),r])), down: false,
    omitReceipts: new Set(), unsupportedBlockReceipts: false, requests: [], forbidden: 0 };
  const allowed = new Set(['eth_chainId','eth_syncing','eth_getBlockByNumber','eth_getBlockReceipts','eth_getTransactionReceipt']);
  const server = createServer(async (request,response) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) { response.writeHead(413).end(); return; } chunks.push(chunk); }
      const call = JSON.parse(Buffer.concat(chunks));
      if (state.requests.length < 10000) state.requests.push(call.method);
      if (!allowed.has(call.method)) { state.forbidden++; response.writeHead(403).end(); return; }
      if (state.down) { response.writeHead(503).end(); return; }
      let result = null, error;
      if (call.method === 'eth_chainId') result = '0x1237';
      if (call.method === 'eth_syncing') result = false;
      const rows = [...state.blocks.values()];
      if (call.method === 'eth_getBlockByNumber') {
        const height = call.params[0] === 'latest' ? Math.max(...state.blocks.keys()) : Number(BigInt(call.params[0]));
        const row = state.blocks.get(height);
        if (row) result = { ...row.block, transactions: call.params[1] ? row.block.transactions : row.block.transactions.map(t => t.hash) };
      }
      if (call.method === 'eth_getBlockReceipts') {
        if (state.unsupportedBlockReceipts) error = { code: -32601,message:'Method not supported' };
        else { const height = Number(BigInt(call.params[0])); result = state.omitReceipts.has(height) ? null : state.blocks.get(height)?.receipts ?? null; }
      }
      if (call.method === 'eth_getTransactionReceipt') result = rows.flatMap(r => r.receipts).find(r => r.transactionHash === call.params[0]) ?? null;
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:call.id,...(error ? {error} : {result})}));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return { state, url:`http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
