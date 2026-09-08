#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {latencyReport} from './latency.mjs';

const HELP=`WATCHTOWER — Robinhood Chain 4663 transaction monitoring

  probe    --config CONFIG [--out JSON]
  capture  --config CONFIG --db DB [--from-block N] [--duration SECONDS] [--out JSON]
  workers  --config CONFIG --db DB [--duration SECONDS] [--out JSON]
  report   --db DB [--out JSON]
  events   --db DB [--after SEQ] [--limit N] [--out JSON]
  outbox   --db DB [--after SEQ] [--limit N] [--out JSON]
  classifications --db DB --block-hash HASH [--out JSON]
  latency  --db DB [--out JSON]
  demo     --out DIR
  bench    --out JSON [--blocks N] [--transactions N]

Capture and workers run as separate processes against one durable store.
Duration 0 is continuous. New stores require an explicit first block.
No live transaction signing, broadcasting, or external notification delivery.
`;
function parse(argv){
 const command=argv.shift()??'help',args={};
 for(let i=0;i<argv.length;i+=2){if(!/^--[a-z][a-z-]*$/.test(argv[i])||argv[i+1]===undefined||argv[i+1].startsWith('--')||Object.hasOwn(args,argv[i].slice(2)))throw new Error('INVALID_CLI_ARGUMENT');args[argv[i].slice(2)]=argv[i+1];}
 return {command,args};
}
function number(value,name,{min=0,max=Number.MAX_SAFE_INTEGER,fallback}={}){
 if(value===undefined&&fallback!==undefined)return fallback;
 if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(String(value)))throw new Error(`INVALID_${name}`);
 const n=Number(value);if(!Number.isFinite(n)||n<min||n>max||(name!=='DURATION'&&!Number.isSafeInteger(n)))throw new Error(`INVALID_${name}`);return n;
}
function input(path){if(!path)throw new Error('CONFIG_REQUIRED');return JSON.parse(readFileSync(resolve(path),'utf8'));}
function output(value,path){const text=JSON.stringify(value,null,2)+'\n';if(path){mkdirSync(dirname(resolve(path)),{recursive:true});writeFileSync(resolve(path),text,{mode:0o600});}else process.stdout.write(text);}
function requiredDb(args){if(!args.db)throw new Error('DATABASE_REQUIRED');return resolve(args.db);}
function allowed(args,keys){for(const k of Object.keys(args))if(!keys.includes(k))throw new Error('UNKNOWN_OPTION_'+k.toUpperCase().replaceAll('-','_'));}
function lifetime(){const a=new AbortController();const stop=()=>a.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);return {signal:a.signal,close:()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}};}

export async function main(argv=process.argv.slice(2)){
 const {command,args}=parse([...argv]);
 if(command==='help'||command==='--help'){process.stdout.write(HELP);return;}
 if(command==='probe'){
  allowed(args,['config','out']);const {probe}=await import('./capture.mjs');const result=await probe(input(args.config));output(result,args.out);if(result.sources.find(s=>s.name===result.primary_source)?.state!=='available')process.exitCode=2;return;
 }
 if(command==='demo'||command==='bench'){
  allowed(args,command==='demo'?['out']:['out','blocks','transactions']);if(!args.out)throw new Error('OUTPUT_REQUIRED');
  const {demo,benchmark}=await import('./scenarios.mjs');
  if(command==='demo'){const result=await demo(resolve(args.out));process.stdout.write(JSON.stringify(result,null,2)+'\n');}
  else output(await benchmark({blocks:number(args.blocks,'BLOCKS',{min:1,max:10000,fallback:100}),transactions:number(args.transactions,'TRANSACTIONS',{min:0,max:10000,fallback:100})}),args.out);
  return;
 }
 const {openStore}=await import('./store.mjs');
 if(command==='capture'){
  allowed(args,['config','db','from-block','duration','out']);const config=input(args.config);
  if(args['from-block']!==undefined)config.from_block=number(args['from-block'],'FROM_BLOCK');
  if(args.duration!==undefined)config.duration_seconds=number(args.duration,'DURATION',{max:86400});
  const db=requiredDb(args);
  if(!existsSync(db)&&!Number.isSafeInteger(config.from_block))throw new Error('EXPLICIT_FROM_BLOCK_REQUIRED_FOR_NEW_STORE');
  mkdirSync(dirname(db),{recursive:true});
  const store=openStore(db,{chainId:config.chain_id,startBlock:config.from_block??undefined,maxBytes:config.max_db_bytes,reorgDepth:config.reorg_depth});
  const life=lifetime();
  try{const {capture}=await import('./capture.mjs');const result=await capture({...config,from_block:store.progress().start_block},{store,signal:life.signal});output(result,args.out);if(!['stopped','duration_limit','aborted'].includes(result.reason))process.exitCode=2;}
  finally{life.close();store.close();}return;
 }
 if(command==='workers'){
  allowed(args,['config','db','duration','out']);const config=input(args.config),db=requiredDb(args);if(!existsSync(db))throw new Error('DATABASE_NOT_FOUND');
  const store=openStore(db),life=lifetime(),duration=number(args.duration??config.duration_seconds??60,'DURATION',{max:86400});
  const until=duration===0?Infinity:Date.now()+duration*1000;let rounds=0;
  try{const {routeEvents,runJobs,workerStatus,requeueExpired}=await import('./workers.mjs');
   do{requeueExpired(store,{now:Date.now});routeEvents(store,{policy:config.worker_policy,limit:100});await runJobs(store,{limit:16,now:Date.now});rounds++;
    if(life.signal.aborted||Date.now()>=until)break;
    await pause(100,undefined,{signal:life.signal}).catch(()=>{});
   }while(!life.signal.aborted&&Date.now()<until);
   output({schema:'watchtower.worker-run.v1',rounds,status:workerStatus(store)},args.out);
  }finally{life.close();store.close();}return;
 }
 if(['report','events','outbox','classifications','latency'].includes(command)){
  allowed(args,['events','outbox'].includes(command)?['db','after','limit','out']:command==='classifications'?['db','block-hash','out']:['db','out']);const db=requiredDb(args);if(!existsSync(db))throw new Error('DATABASE_NOT_FOUND');
  const store=openStore(db);
  try{
   if(command==='events')output({schema:'watchtower.events.v1',events:store.readEvents(number(args.after,'AFTER',{fallback:0}),number(args.limit,'LIMIT',{min:1,max:1000,fallback:100}))},args.out);
   else if(command==='outbox'){const {readOutbox}=await import('./workers.mjs');output({schema:'watchtower.outbox.v1',items:readOutbox(store,{after:number(args.after,'AFTER',{fallback:0}),limit:number(args.limit,'LIMIT',{min:1,max:1000,fallback:100})})},args.out);}
   else if(command==='classifications'){if(!args['block-hash'])throw new Error('BLOCK_HASH_REQUIRED');const {readClassifications}=await import('./workers.mjs');output({schema:'watchtower.classifications.v1',items:readClassifications(store,{blockHash:args['block-hash']})},args.out);}
   else if(command==='latency')output(latencyReport(store.observations()),args.out);
   else {const {workerStatus}=await import('./workers.mjs');const observations=store.observations();
    const latest=new Map();for(const r of observations){if(!['source_health','head','block'].includes(r.stage))continue;const ms=Date.parse(r.observed_at);if(Number.isFinite(ms)&&(!latest.has(r.source)||ms>latest.get(r.source).ms))latest.set(r.source,{ms,stage:r.stage,delivery:r.delivery});}
    output({schema:'watchtower.report.v1',generated_at:new Date().toISOString(),coverage:store.coverage(),storage:store.stats(),workers:workerStatus(store),
     source_observations:[...latest].map(([source,v])=>({source,last_stage:v.stage,delivery:v.delivery,age_ms:Math.max(0,Date.now()-v.ms)})),
     execution_detail:{included_transactions:'raw RPC block arrays',receipts:'individually reconciled with exact block transactions',internal_calls:'UNTRACED',l1_finality:'UNVERIFIED',fastest_claim:'UNESTABLISHED'},
     note:'Contiguous retained coverage is separate from current source liveness; no configured sources or timely observations means live health is unverified.'},args.out);
   }
  }finally{store.close();}return;
 }
 throw new Error('UNKNOWN_COMMAND');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
 // Remote/provider errors must not echo endpoint credentials or supplied bodies.
 const candidate=error?.code??error?.message;
 const code=/^[A-Za-z][A-Za-z0-9_:-]{0,160}$/.test(candidate??'')?candidate:'WATCHTOWER_OPERATION_FAILED';
 process.stderr.write(JSON.stringify({error:code})+'\n');process.exitCode=1;
});
