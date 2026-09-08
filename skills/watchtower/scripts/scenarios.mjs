import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from './store.mjs';
import {routeEvents,runJobs,workerStatus} from './workers.mjs';

const H=s=>'0x'+createHash('sha256').update(String(s)).digest('hex');
const Q=n=>'0x'+BigInt(n).toString(16);
const A='0x'+'11'.repeat(20), B='0x'+'22'.repeat(20);
const POLICY={version:'synthetic-v1',max_queue:2048,max_attempts:3,lease_ms:30000,timeout_ms:10000,max_result_bytes:4194304,rules:[]};
export function syntheticBlock(number,count=4,branch='a') {
 const hash=H(`${branch}-block-${number}`),parentHash=H(`${branch}-block-${number-1}`);
 const transactions=Array.from({length:count},(_,i)=>({hash:H(`${branch}-tx-${number}-${i}`),blockHash:hash,blockNumber:Q(number),transactionIndex:Q(i),from:A,to:i===1?null:B,
  nonce:Q(number*count+i),value:i===0?'0x1':'0x0',gas:'0x186a0',gasPrice:'0x1',type:i===count-1?'0x7f':'0x2',input:i===1?'0x60006000fd':i===2?'0xdeadbeef':'0x',chainId:'0x1237'}));
 const block={number:Q(number),hash,parentHash,timestamp:Q(1700000000+number),gasLimit:'0x1c9c380',gasUsed:Q(count*21000),transactions};
 const receipts=transactions.map((tx,i)=>({transactionHash:tx.hash,transactionIndex:tx.transactionIndex,blockHash:hash,blockNumber:block.number,from:tx.from,to:tx.to,
  contractAddress:tx.to===null?'0x'+'33'.repeat(20):null,status:i===2?'0x0':'0x1',gasUsed:'0x5208',cumulativeGasUsed:Q((i+1)*21000),logs:[],type:tx.type}));
 return {block,receipts};
}
function clock(){const run_id=randomUUID(),clock_id=randomUUID();return()=>({source:'synthetic',run_id,clock_id,observed_at:new Date().toISOString(),observed_mono_ns:process.hrtime.bigint().toString(),delivery:'replay'});}
async function drain(store){
 // Finite fixture workload. A bounded loop also exposes queue failures in the demo.
 for(let i=0;i<10000;i++){
  const routed=routeEvents(store,{policy:POLICY,limit:100});
  await runJobs(store,{limit:100,now:Date.now});
  const status=workerStatus(store);
  const queued=(status.jobs.QUEUED??0)+(status.jobs.RUNNING??0);
  if(routed.processed_events===0&&queued===0){if(routed.paused)throw new Error('DEMO_QUEUE_CAPACITY');return status;}
  if(i===9999)throw new Error('DEMO_DRAIN_LIMIT');
 }
}
export async function demo(directory){
 if(existsSync(directory))throw new Error('DEMO_REQUIRES_NEW_DIRECTORY');mkdirSync(directory,{recursive:true});
 const store=openStore(join(directory,'watchtower.sqlite'),{chainId:4663,startBlock:1,maxBytes:128*1024*1024,reorgDepth:8}),stamp=clock();
 try{
  const first=syntheticBlock(1),second=syntheticBlock(2),third=syntheticBlock(3,0);
  store.putBlock(first.block,stamp());store.putReceipts(first.block.hash,first.receipts,stamp());
  store.putBlock(third.block,stamp());store.putReceipts(third.block.hash,third.receipts,stamp());
  const gap=store.coverage();
  store.putBlock(second.block,stamp());
  const beforeReceiptRecovery=store.coverage();
  store.putReceipts(second.block.hash,second.receipts,stamp());
  await drain(store);
  const completed=store.coverage();
  store.rewind(3,'synthetic replacement');const replacement=syntheticBlock(3,1,'b');replacement.block.parentHash=second.block.hash;
  store.putBlock(replacement.block,stamp());store.putReceipts(replacement.block.hash,replacement.receipts,stamp());await drain(store);
  const result={schema:'watchtower.demo.v1',synthetic:true,mainnet_qualified:false,case:'missing block, delayed receipts, all-tx classification, replacement block',
   while_block_missing:gap,while_receipts_missing:beforeReceiptRecovery,after_recovery:completed,after_replacement:store.coverage(),workers:workerStatus(store),
   limitations:['Fixture hashes are invented; this is a software recovery demonstration.','Unknown transaction types are retained without claiming decoded system semantics.','No full internal-call tracing or profitable trading result.']};
  writeFileSync(join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');
  writeFileSync(join(directory,'inputs.synthetic.json'),JSON.stringify({synthetic:true,blocks:[first,second,third],replacement},null,2)+'\n');
  return {schema:result.schema,synthetic:true,directory,coverage:result.after_replacement};
 }finally{store.close();}
}
export async function benchmark({blocks=100,transactions=100}={}){
 if(!Number.isSafeInteger(blocks)||blocks<1||blocks>10000||!Number.isSafeInteger(transactions)||transactions<0||transactions>10000||blocks*Math.max(transactions,1)>200000)throw new Error('BENCHMARK_WORKLOAD_LIMIT');
 const dir=mkdtempSync(join(tmpdir(),'watchtower-bench-')),store=openStore(join(dir,'capture.sqlite'),{chainId:4663,startBlock:1,maxBytes:2*1024*1024*1024,reorgDepth:64}),stamp=clock();
 try{
  const workload=Array.from({length:blocks},(_,i)=>syntheticBlock(i+1,transactions));
  const begin=performance.now();
  for(const row of workload){store.putBlock(row.block,stamp());store.putReceipts(row.block.hash,row.receipts,stamp());}
  const retained=performance.now();await drain(store);const end=performance.now();const coverage=store.coverage();
  return {schema:'watchtower.synthetic-throughput.v1',synthetic:true,network_involved:false,mainnet_qualified:false,fastest_claim_established:false,
   runtime:process.version,platform:process.platform,architecture:process.arch,blocks,transactions:blocks*transactions,
   durable_capture_ms:retained-begin,capture_and_builtin_workers_ms:end-begin,
   durable_transactions_per_second:blocks*transactions/((retained-begin)/1000),
   end_to_end_transactions_per_second:blocks*transactions/((end-begin)/1000),
   coverage,workers:workerStatus(store),
   limitations:['This workload has small synthetic transactions and empty receipt logs; it is not representative chain load.','Rates describe this process and filesystem only, with no RPC, Nitro execution or network delay.','Storage fills eventually; no history is silently pruned.','Use retained real blocks, payload distributions, multiple sources and sustained target-host tests before capacity claims.']};
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
