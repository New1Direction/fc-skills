/** Local-only Anvil execution. The remote transport is read-only; all writes target our child. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { makeRpc } from './rpc.mjs';
import { validateCallRequest, digestValue } from './simulation.mjs';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
const MAX_BYTES = 1024 * 1024;
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const q = n => '0x' + BigInt(n).toString(16);
const check = (condition, code) => { if (!condition) throw new TypeError(code); };
const quantity = value => { check(typeof value === 'string' && value.length<=66 && QUANTITY.test(value), 'INVALID_QUANTITY'); return BigInt(value); };
const decimal = value => { check(typeof value === 'string' && value.length<=79 && INTEGER.test(value), 'INVALID_INTEGER'); return BigInt(value); };
const safeNumber = value => { const n = typeof value === 'number' ? value : Number(quantity(value)); check(Number.isSafeInteger(n) && n >= 0, 'INVALID_NUMBER'); return n; };
const key = (token,owner) => token.toLowerCase()+':'+owner.toLowerCase();
const balanceData = owner => '0x70a08231'+owner.slice(2).padStart(64,'0');
const balanceResult = result => { check(typeof result === 'string' && HEX32.test(result), 'INVALID_BALANCE_RESULT'); return BigInt(result); };
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));

export function anvilArguments(rpcUrl, blockNumber, port) {
  const url = new URL(rpcUrl);
  check(['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 'INVALID_RPC_URL');
  check(Number.isSafeInteger(blockNumber) && blockNumber >= 0, 'INVALID_BLOCK');
  check(Number.isInteger(port) && port > 0 && port < 65536, 'INVALID_PORT');
  return ['--host','127.0.0.1','--port',String(port),'--fork-url',rpcUrl,
    '--fork-block-number',String(blockNumber),'--chain-id','4663','--accounts','0',
    '--no-storage-caching','--silent'];
}

async function availablePort() {
  const server = createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port = server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

function localTransport(port, signal, remaining) {
  let sequence = 0;
  return async (method,params=[]) => {
    check(remaining()>0 && !signal.aborted,'FORK_TIMEOUT');
    const id=++sequence;
    const response=await fetch('http://127.0.0.1:'+port,{
      method:'POST',redirect:'error',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(12000,remaining())))])
    });
    check(response.ok,'LOCAL_RPC_HTTP_ERROR');
    let size=0; const chunks=[];
    for await (const chunk of response.body) {
      size+=chunk.length; check(size<=MAX_BYTES,'LOCAL_RPC_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(chunk));
    }
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    check(value?.jsonrpc==='2.0' && value.id===id && Object.hasOwn(value,'result')!==Object.hasOwn(value,'error'),'LOCAL_RPC_ENVELOPE');
    if(value.error) {
      const error=new Error('LOCAL_RPC_ERROR');
      error.code=Number.isInteger(value.error.code)?value.error.code:null;
      if(typeof value.error.data==='string' && /^0x(?:[0-9a-fA-F]{2}){0,8192}$/.test(value.error.data)) error.data=value.error.data;
      throw error;
    }
    return value.result;
  };
}

function initialReport(request) {
  return {
    schema_version:'hook-lab.fork.v1',request,call_digest:digestValue(request),status:'INCOMPLETE',
    execution_environment:'local-anvil-next-block',state_overrides:false,sender_substitution:false,
    impersonated_sender:request.transaction.from,canonical_source_rechecked:false,
    fork_origin:null,local_transaction:null,local_block:null,receipt:null,
    token_balances:[],native_balances:[],expectations:[],observations:[],issues:[],
    costs:{local_execution_gas_wei:null,robinhood_l1_data_fee_wei:null,
      total_robinhood_execution_cost_wei:null,
      caveat:'Anvil EVM gas is local simulation evidence. Nitro L1 data fees and chain-specific execution/precompiles are not reproduced.'}
  };
}

/** Execute one exact call on a disposable fork. Never signs or submits to rpcUrl. */
export async function simulateFork(input,{anvilPath='anvil',rpcUrl}={}) {
  const request=validateCallRequest(input);
  check(typeof anvilPath==='string' && anvilPath.length>0 && anvilPath.length<4096 && !anvilPath.includes('\0'),'INVALID_ANVIL_PATH');
  // Validate endpoint before starting any process. makeRpc has a read-only method allowlist.
  const sourceRpc=makeRpc(rpcUrl,{timeoutMs:12000,maxBytes:MAX_BYTES});
  const report=initialReport(request);
  const start=Date.now(),remaining=()=>30000-(Date.now()-start),abort=new AbortController();
  let child=null,localRpc=null,snapshot=null,phase='SOURCE',terminated=false;
  const timer=setTimeout(()=>{abort.abort();child?.kill('SIGKILL');},30000);
  const observe=async(scope,rpc,method,params=[])=>{
    check(remaining()>0 && !abort.signal.aborted,'FORK_TIMEOUT');
    if(scope==='local') check(child && !terminated && child.exitCode===null,'ANVIL_EXITED');
    const result=await rpc(method,params);
    check(remaining()>0 && !abort.signal.aborted,'FORK_TIMEOUT');
    // nodeInfo contains the private fork URL: keep only the non-secret configuration.
    const retained=method==='anvil_nodeInfo'?{
      currentBlockNumber:result?.currentBlockNumber,currentBlockHash:result?.currentBlockHash,
      currentBlockTimestamp:result?.currentBlockTimestamp,hardFork:result?.hardFork,
      environment:{chainId:result?.environment?.chainId},
      forkConfig:{forkBlockNumber:result?.forkConfig?.forkBlockNumber}
    }:result;
    report.observations.push({scope,method,params,result:JSON.parse(JSON.stringify(retained))});
    if(report.observations.length>256 || Buffer.byteLength(JSON.stringify(report))>MAX_BYTES-1024) {
      report.observations.pop();throw new TypeError('EVIDENCE_TOO_LARGE');
    }
    return result;
  };
  const source=(method,params)=>observe('source',sourceRpc,method,params);
  const local=(method,params)=>observe('local',localRpc,method,params);
  const blockTag=q(request.block.number);
  const matchesHeader=header=>header && same(header.hash,request.block.hash) && safeNumber(header.number)===request.block.number;
  try {
    check(quantity(await source('eth_chainId',[]))===4663n,'SOURCE_CHAIN_MISMATCH');
    check(matchesHeader(await source('eth_getBlockByNumber',[blockTag,false])),'SOURCE_BLOCK_MISMATCH');
    phase='SPAWN';
    const port=await availablePort();
    child=spawn(anvilPath,anvilArguments(rpcUrl,request.block.number,port),{
      shell:false,stdio:['ignore','pipe','pipe'],env:process.env
    });
    child.on('error',()=>{terminated=true;}); child.on('exit',()=>{terminated=true;});
    // Consume bounded output without retaining stdout/stderr, which may contain the private URL.
    let processBytes=0;
    for(const stream of [child.stdout,child.stderr]) stream.on('data',data=>{processBytes+=data.length;if(processBytes>MAX_BYTES)child.kill('SIGKILL');});
    localRpc=localTransport(port,abort.signal,remaining);
    let info;
    phase='READINESS';
    while(remaining()>0 && !terminated) {
      try { info=await localRpc('anvil_nodeInfo',[]); break; }
      catch { await wait(Math.min(100,Math.max(1,remaining()))); }
    }
    check(info && !terminated,'ANVIL_START_FAILED');
    phase='FORK_IDENTITY';
    info=await local('anvil_nodeInfo',[]);
    check(safeNumber(info.environment?.chainId)===4663,'FORK_CHAIN_MISMATCH');
    check(safeNumber(info.forkConfig?.forkBlockNumber)===request.block.number,'FORK_BLOCK_MISMATCH');
    check(safeNumber(info.currentBlockNumber)===request.block.number && same(info.currentBlockHash,request.block.hash),'FORK_HASH_MISMATCH');
    const metadata=await local('anvil_metadata',[]);
    check(safeNumber(metadata.forkedNetwork?.chainId)===4663 && safeNumber(metadata.forkedNetwork?.forkBlockNumber)===request.block.number && same(metadata.forkedNetwork?.forkBlockHash,request.block.hash),'FORK_METADATA_MISMATCH');
    check(typeof info.hardFork==='string'&&info.hardFork.length<=80&&typeof metadata.instanceId==='string'&&HEX32.test(metadata.instanceId),'FORK_METADATA_MISSING');
    check(matchesHeader(await local('eth_getBlockByNumber',[blockTag,false])),'FORK_HEADER_MISMATCH');
    const version=await local('web3_clientVersion',[]);
    check(typeof version==='string' && version.toLowerCase().startsWith('anvil/'),'NOT_ANVIL');
    report.fork_origin={chain_id:4663,block:structuredClone(request.block),anvil_version:version,
      hardfork:info.hardFork,instance_id:metadata.instanceId};
    phase='PRESTATE';
    // Impersonating a contract as tx.origin would not reproduce a valid ordinary wallet transaction.
    check(await local('eth_getCode',[request.transaction.from,'latest'])==='0x','CONTRACT_SENDER_UNSUPPORTED');
    const owners=[...new Set([request.transaction.from,...request.balance_tokens.map(x=>x.owner)].map(x=>x.toLowerCase()))];
    for(const item of request.balance_tokens) {
      const raw=await local('eth_call',[{to:item.address,data:balanceData(item.owner)},'latest']);
      report.token_balances.push({token:item.address,owner:item.owner,before_raw:balanceResult(raw).toString(),after_raw:null,delta_raw:null});
    }
    for(const owner of owners) report.native_balances.push({owner,before_raw:quantity(await local('eth_getBalance',[owner,'latest'])).toString(),after_raw:null,delta_raw:null});
    const gasPrice=await local('eth_gasPrice',[]);
    quantity(gasPrice);
    const senderNative=report.native_balances.find(x=>same(x.owner,request.transaction.from));
    check(BigInt(senderNative.before_raw)>=quantity(request.transaction.value)+quantity(request.transaction.gas)*quantity(gasPrice),'INSUFFICIENT_NATIVE_BALANCE');
    snapshot=await local('evm_snapshot',[]);
    phase='LOCAL_SEND';
    await local('anvil_impersonateAccount',[request.transaction.from]);
    const txHash=await local('eth_sendTransaction',[{...request.transaction,gasPrice}]);
    check(typeof txHash==='string' && HEX32.test(txHash),'INVALID_TRANSACTION_HASH');
    let receipt;
    while(remaining()>0) {
      receipt=await local('eth_getTransactionReceipt',[txHash]);
      if(receipt)break;
      await wait(Math.min(100,Math.max(1,remaining())));
    }
    check(receipt,'MISSING_RECEIPT');
    phase='POSTSTATE';
    const tx=await local('eth_getTransactionByHash',[txHash]);
    const header=await local('eth_getBlockByNumber',[receipt.blockNumber,false]);
    report.local_transaction={hash:tx.hash,from:tx.from,to:tx.to,data:tx.input??tx.data,
      value:tx.value,gas:tx.gas,nonce:tx.nonce,gas_price:tx.gasPrice};
    report.receipt={transaction_hash:receipt.transactionHash,block_hash:receipt.blockHash,
      block_number:safeNumber(receipt.blockNumber),status:safeNumber(receipt.status),
      gas_used:quantity(receipt.gasUsed).toString(),effective_gas_price:quantity(receipt.effectiveGasPrice).toString(),logs:receipt.logs};
    report.local_block={number:safeNumber(header.number),hash:header.hash,parent_hash:header.parentHash,timestamp:safeNumber(header.timestamp)};
    for(const item of report.token_balances) {
      item.after_raw=balanceResult(await local('eth_call',[{to:item.token,data:balanceData(item.owner)},receipt.blockNumber])).toString();
      item.delta_raw=(BigInt(item.after_raw)-BigInt(item.before_raw)).toString();
    }
    for(const item of report.native_balances) {
      item.after_raw=quantity(await local('eth_getBalance',[item.owner,receipt.blockNumber])).toString();
      item.delta_raw=(BigInt(item.after_raw)-BigInt(item.before_raw)).toString();
    }
    report.expectations=(request.expectations??[]).map(expected=>{
      const found=same(expected.token,ZERO)?report.native_balances.find(row=>same(row.owner,expected.owner)):
        report.token_balances.find(row=>key(row.token,row.owner)===key(expected.token,expected.owner));
      check(found,'EXPECTATION_BALANCE_NOT_TRACKED');
      const delta=BigInt(found.delta_raw);
      return {...expected,observed_delta:found.delta_raw,pass:delta>=BigInt(expected.minimum_delta)&&delta<=BigInt(expected.maximum_delta)};
    });
    report.costs.local_execution_gas_wei=(BigInt(report.receipt.gas_used)*BigInt(report.receipt.effective_gas_price)).toString();
    phase='SOURCE_RECHECK';
    check(quantity(await source('eth_chainId',[]))===4663n,'SOURCE_CHAIN_CHANGED');
    check(matchesHeader(await source('eth_getBlockByNumber',[blockTag,false])),'SOURCE_REORG');
    report.canonical_source_rechecked=true;
    report.status=report.receipt.status===1?'FORK_EXECUTED_AT_BLOCK':'FORK_REVERTED_AT_BLOCK';
    if(request.context.wallet_context==='synthetic')report.issues.push('SYNTHETIC_WALLET_CONTEXT');
    if(request.context.source_mapping!=='verified')report.issues.push('SOURCE_MAPPING_UNVERIFIED');
    if(report.expectations.some(x=>!x.pass))report.issues.push('EXPECTATION_FAILED');
    validateComplete(report);
  } catch(error) {
    report.status='INCOMPLETE';
    report.issues.push(error instanceof TypeError && /^[A-Z_]{3,80}$/.test(error.message)?error.message:phase+'_FAILED');
    if(Number.isInteger(error?.code))report.rpc_error_code=error.code;
    if(error?.data)report.revert_data=error.data;
  } finally {
    // Local-only cleanup, bounded by the same 30s process deadline. Termination destroys fork state.
    if(localRpc && child && !terminated && remaining()>300) {
      try {await localRpc('anvil_stopImpersonatingAccount',[request.transaction.from]);} catch {}
      if(snapshot!==null)try {await localRpc('evm_revert',[snapshot]);} catch {}
    }
    abort.abort();
    if(child && !terminated)child.kill('SIGKILL');
    clearTimeout(timer);
  }
  report.evidence_digest=digestValue(report);
  return report;
}

function observation(report,method,predicate,scope='local') {
  return report.observations.filter(x=>x.scope===scope && x.method===method && predicate(x.params));
}

function validateComplete(report) {
  const request=validateCallRequest(report.request), tx=report.local_transaction, receipt=report.receipt, header=report.local_block;
  check(report.execution_environment==='local-anvil-next-block' && report.state_overrides===false && report.sender_substitution===false,'INVALID_EXECUTION_CONTEXT');
  check(same(report.impersonated_sender,request.transaction.from),'SENDER_SUBSTITUTED');
  check(report.canonical_source_rechecked===true,'SOURCE_NOT_RECHECKED');
  check(report.fork_origin?.chain_id===4663 && report.fork_origin.block.number===request.block.number && same(report.fork_origin.block.hash,request.block.hash),'FORK_ORIGIN_MISMATCH');
  check(tx && receipt && header,'EXECUTION_EVIDENCE_MISSING');
  check(HEX32.test(tx.hash) && same(tx.hash,receipt.transaction_hash),'TRANSACTION_HASH_MISMATCH');
  check(same(tx.from,request.transaction.from) && same(tx.to,request.transaction.to) && same(tx.data,request.transaction.data),'TRANSACTION_CALL_MISMATCH');
  for(const field of ['value','gas'])check(quantity(tx[field])===quantity(request.transaction[field]),'TRANSACTION_AMOUNT_MISMATCH');
  quantity(tx.nonce); quantity(tx.gas_price);
  check([0,1].includes(receipt.status) && receipt.block_number===request.block.number+1 && header.number===receipt.block_number,'LOCAL_BLOCK_NUMBER_MISMATCH');
  check(HEX32.test(header.hash) && same(header.hash,receipt.block_hash) && same(header.parent_hash,request.block.hash),'LOCAL_BLOCK_HASH_MISMATCH');
  check(Number.isSafeInteger(header.timestamp) && header.timestamp>=0,'INVALID_LOCAL_TIMESTAMP');
  check(decimal(receipt.gas_used)>=0n && decimal(receipt.gas_used)<=quantity(tx.gas) && decimal(receipt.effective_gas_price)===quantity(tx.gas_price),'GAS_ACCOUNTING_MISMATCH');
  check(report.costs.local_execution_gas_wei===(BigInt(receipt.gas_used)*BigInt(receipt.effective_gas_price)).toString(),'GAS_COST_MISMATCH');
  check(report.costs.robinhood_l1_data_fee_wei===null && report.costs.total_robinhood_execution_cost_wei===null,'UNSUPPORTED_CHAIN_FEE_CLAIM');
  check(report.status===(receipt.status===1?'FORK_EXECUTED_AT_BLOCK':'FORK_REVERTED_AT_BLOCK'),'EXECUTION_STATUS_MISMATCH');
  check(Array.isArray(report.observations) && report.observations.length<=256,'INVALID_OBSERVATIONS');
  const forbidden=/^(?:anvil_set|hardhat_set|anvil_load|anvil_reset|hardhat_reset|eth_sendRaw)/;
  check(!report.observations.some(x=>forbidden.test(x.method)),'STATE_OVERRIDE_OBSERVED');
  const localMethods=new Set(['anvil_nodeInfo','anvil_metadata','eth_getBlockByNumber','web3_clientVersion','eth_getCode',
    'eth_call','eth_getBalance','eth_gasPrice','evm_snapshot','anvil_impersonateAccount','eth_sendTransaction',
    'eth_getTransactionReceipt','eth_getTransactionByHash']);
  check(report.observations.every(x=>['source','local'].includes(x.scope)&&Array.isArray(x.params)), 'INVALID_OBSERVATION_SCOPE');
  check(!report.observations.some(x=>x.scope==='local'&&!localMethods.has(x.method)),'UNEXPECTED_LOCAL_METHOD');
  check(!report.observations.some(x=>x.scope==='source' && !['eth_chainId','eth_getBlockByNumber'].includes(x.method)),'UNEXPECTED_SOURCE_METHOD');
  const infos=observation(report,'anvil_nodeInfo',p=>p.length===0);
  check(infos.length===1 && safeNumber(infos[0].result?.environment?.chainId)===4663&&safeNumber(infos[0].result?.currentBlockNumber)===request.block.number&&safeNumber(infos[0].result?.forkConfig?.forkBlockNumber)===request.block.number&&same(infos[0].result?.currentBlockHash,request.block.hash),'NODE_IDENTITY_EVIDENCE_MISMATCH');
  const metas=observation(report,'anvil_metadata',p=>p.length===0);
  check(metas.length===1 && safeNumber(metas[0].result?.forkedNetwork?.chainId)===4663&&safeNumber(metas[0].result?.forkedNetwork?.forkBlockNumber)===request.block.number&&same(metas[0].result?.forkedNetwork?.forkBlockHash,request.block.hash)&&same(metas[0].result?.instanceId,report.fork_origin.instance_id),'FORK_METADATA_EVIDENCE_MISMATCH');
  const codes=observation(report,'eth_getCode',p=>same(p[0],request.transaction.from)&&p[1]==='latest'&&p.length===2);
  check(codes.length===1&&codes[0].result==='0x','CONTRACT_SENDER_UNSUPPORTED');
  const impersonations=observation(report,'anvil_impersonateAccount',()=>true);
  check(impersonations.length===1&&impersonations[0].params.length===1&&same(impersonations[0].params[0],request.transaction.from),'SENDER_SUBSTITUTED');
  const headers=observation(report,'eth_getBlockByNumber',p=>p[0]===q(request.block.number)&&p[1]===false,'source');
  check(headers.length===2 && headers.every(x=>same(x.result?.hash,request.block.hash)&&safeNumber(x.result?.number)===request.block.number),'SOURCE_HEADER_EVIDENCE_MISMATCH');
  const chains=observation(report,'eth_chainId',p=>p.length===0,'source');
  check(chains.length===2 && chains.every(x=>quantity(x.result)===4663n),'SOURCE_CHAIN_EVIDENCE_MISMATCH');
  const sends=observation(report,'eth_sendTransaction',()=>true);
  check(sends.length===1 && same(sends[0].result,tx.hash),'LOCAL_SEND_EVIDENCE_MISMATCH');
  const submitted=sends[0].params[0];
  check(sends[0].params.length===1 && submitted && Object.keys(submitted).sort().join(',')===['from','to','data','value','gas','gasPrice'].sort().join(','),'LOCAL_SEND_EXTRA_FIELDS');
  check(same(submitted.from,request.transaction.from)&&same(submitted.to,request.transaction.to)&&same(submitted.data,request.transaction.data)&&quantity(submitted.value)===quantity(tx.value)&&quantity(submitted.gas)===quantity(tx.gas)&&quantity(submitted.gasPrice)===quantity(tx.gas_price),'LOCAL_SEND_CALL_MISMATCH');
  const rawTxs=observation(report,'eth_getTransactionByHash',p=>same(p[0],tx.hash));
  check(rawTxs.length===1,'RAW_TRANSACTION_MISSING');
  const rawTx=rawTxs[0].result;
  check(same(rawTx.hash,tx.hash)&&same(rawTx.from,tx.from)&&same(rawTx.to,tx.to)&&same(rawTx.input??rawTx.data,tx.data),'RAW_TRANSACTION_MISMATCH');
  check(same(rawTx.blockHash,header.hash)&&safeNumber(rawTx.blockNumber)===header.number,'RAW_TRANSACTION_BLOCK_MISMATCH');
  if(rawTx.chainId!==undefined)check(quantity(rawTx.chainId)===4663n,'RAW_TRANSACTION_CHAIN_MISMATCH');
  for(const field of ['value','gas','nonce'])check(quantity(rawTx[field])===quantity(tx[field]),'RAW_TRANSACTION_MISMATCH');
  check(quantity(rawTx.gasPrice)===quantity(tx.gas_price),'RAW_TRANSACTION_MISMATCH');
  const rawReceipts=observation(report,'eth_getTransactionReceipt',p=>same(p[0],tx.hash)).filter(x=>x.result);
  check(rawReceipts.length===1,'RAW_RECEIPT_MISSING');
  const rawReceipt=rawReceipts[0].result;
  check(same(rawReceipt.transactionHash,tx.hash)&&same(rawReceipt.blockHash,header.hash)&&safeNumber(rawReceipt.blockNumber)===header.number&&safeNumber(rawReceipt.status)===receipt.status&&quantity(rawReceipt.gasUsed)===BigInt(receipt.gas_used)&&quantity(rawReceipt.effectiveGasPrice)===BigInt(receipt.effective_gas_price),'RAW_RECEIPT_MISMATCH');
  check(Array.isArray(receipt.logs)&&receipt.logs.length<=1024&&digestValue(receipt.logs)===digestValue(rawReceipt.logs),'RAW_LOGS_MISMATCH');
  for(const log of receipt.logs)check(/^0x[0-9a-fA-F]{40}$/.test(log.address)&&Array.isArray(log.topics)&&log.topics.length<=4&&log.topics.every(x=>HEX32.test(x))&&/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)&&same(log.transactionHash,tx.hash)&&same(log.blockHash,header.hash)&&safeNumber(log.blockNumber)===header.number&&log.removed===false,'INVALID_RECEIPT_LOG');
  const rawBlocks=observation(report,'eth_getBlockByNumber',p=>p[0]===q(header.number));
  check(rawBlocks.length===1 && same(rawBlocks[0].result.hash,header.hash)&&same(rawBlocks[0].result.parentHash,header.parent_hash)&&safeNumber(rawBlocks[0].result.timestamp)===header.timestamp,'RAW_BLOCK_MISMATCH');
  check(Array.isArray(report.token_balances) && report.token_balances.length===request.balance_tokens.length,'TOKEN_COVERAGE_MISMATCH');
  const seen=new Set();
  for(const row of report.token_balances) {
    const id=key(row.token,row.owner);check(!seen.has(id),'DUPLICATE_TOKEN_BALANCE');seen.add(id);
    check(request.balance_tokens.some(x=>key(x.address,x.owner)===id),'UNREQUESTED_TOKEN_BALANCE');
    check(decimal(row.before_raw)>=0n&&decimal(row.after_raw)>=0n&&decimal(row.delta_raw)===BigInt(row.after_raw)-BigInt(row.before_raw),'BALANCE_DELTA_MISMATCH');
    for(const [tag,field] of [['latest','before_raw'],[q(header.number),'after_raw']]) {
      const raw=observation(report,'eth_call',p=>same(p[0]?.to,row.token)&&same(p[0]?.data,balanceData(row.owner))&&p[1]===tag&&p.length===2);
      check(raw.length===1 && balanceResult(raw[0].result)===BigInt(row[field]),'RAW_TOKEN_BALANCE_MISMATCH');
    }
  }
  const owners=new Set([request.transaction.from,...request.balance_tokens.map(x=>x.owner)].map(x=>x.toLowerCase()));
  check(Array.isArray(report.native_balances)&&report.native_balances.length===owners.size,'NATIVE_COVERAGE_MISMATCH');
  for(const row of report.native_balances) {
    check(owners.delete(row.owner.toLowerCase()),'DUPLICATE_NATIVE_BALANCE');
    check(decimal(row.before_raw)>=0n&&decimal(row.after_raw)>=0n&&decimal(row.delta_raw)===BigInt(row.after_raw)-BigInt(row.before_raw),'NATIVE_DELTA_MISMATCH');
    for(const [tag,field] of [['latest','before_raw'],[q(header.number),'after_raw']]) {
      const raw=observation(report,'eth_getBalance',p=>same(p[0],row.owner)&&p[1]===tag);
      check(raw.length===1 && quantity(raw[0].result)===BigInt(row[field]),'RAW_NATIVE_BALANCE_MISMATCH');
    }
  }
  const sender=report.native_balances.find(x=>same(x.owner,request.transaction.from));
  check(sender && BigInt(sender.before_raw)>=quantity(tx.value)+quantity(tx.gas)*quantity(tx.gas_price),'INSUFFICIENT_NATIVE_BALANCE');
  const expected=request.expectations??[];
  check(Array.isArray(report.expectations)&&report.expectations.length===expected.length,'EXPECTATION_COVERAGE_MISMATCH');
  for(let i=0;i<expected.length;i++) {
    const a=expected[i],b=report.expectations[i],row=same(a.token,ZERO)?report.native_balances.find(x=>same(x.owner,a.owner)):
      report.token_balances.find(x=>key(x.token,x.owner)===key(a.token,a.owner));
    check(row && same(a.token,b.token)&&same(a.owner,b.owner)&&a.minimum_delta===b.minimum_delta&&a.maximum_delta===b.maximum_delta&&b.observed_delta===row.delta_raw,'EXPECTATION_BINDING_MISMATCH');
    const pass=BigInt(row.delta_raw)>=BigInt(a.minimum_delta)&&BigInt(row.delta_raw)<=BigInt(a.maximum_delta);
    check(b.pass===pass,'EXPECTATION_RESULT_MISMATCH');
  }
  check(Array.isArray(report.issues)&&report.issues.every(x=>typeof x==='string'),'INVALID_ISSUES');
  if(report.expectations.some(x=>!x.pass))check(report.issues.includes('EXPECTATION_FAILED'),'MISSING_EXPECTATION_FAILURE');
  if(request.context.wallet_context==='synthetic')check(report.issues.includes('SYNTHETIC_WALLET_CONTEXT'),'MISSING_SYNTHETIC_CONTEXT');
  if(request.context.source_mapping!=='verified')check(report.issues.includes('SOURCE_MAPPING_UNVERIFIED'),'MISSING_SOURCE_MAPPING_ISSUE');
}

/** Checks retained consistency, not RPC authenticity or economic profitability. */
export function validateForkEvidence(input) {
  check(input && typeof input==='object' && !Array.isArray(input),'INVALID_FORK_EVIDENCE');
  check(Buffer.byteLength(JSON.stringify(input))<=MAX_BYTES,'EVIDENCE_TOO_LARGE');
  const report=structuredClone(input);
  check(report.schema_version==='hook-lab.fork.v1','INVALID_FORK_SCHEMA');
  validateCallRequest(report.request);
  check(same(report.call_digest,digestValue(report.request)),'CALL_DIGEST_MISMATCH');
  const {evidence_digest,...body}=report;
  check(same(evidence_digest,digestValue(body)),'EVIDENCE_DIGEST_MISMATCH');
  check(['FORK_EXECUTED_AT_BLOCK','FORK_REVERTED_AT_BLOCK','INCOMPLETE'].includes(report.status),'INVALID_FORK_STATUS');
  if(report.status!=='INCOMPLETE')validateComplete(report);
  return report;
}
