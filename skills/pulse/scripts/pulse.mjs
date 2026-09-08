#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJournal,validateConfig,invariant,boundedInteger} from './common.mjs';

const HELP=`PULSE — Robinhood Chain data runtime (Node 24+)
  collect --config FILE --out JOURNAL [--registry FILE] [--duration SECONDS]
  race --journal FILE [--sources name,name] [--min-matches N] [--out FILE]
  probe --config FILE [--out FILE]
  pools --registry FILE --blocks FILE [--out FILE]
  node-plan --config FILE --out DIRECTORY
  node-check --config FILE [--out FILE]
  export --journal FILE --out FILE
collect serves loopback /health, /v1/pools, /v1/events while running.
duration 0 runs until SIGINT/SIGTERM. Endpoint URLs come from environment variables.
`;
function args(argv) {
  const [command,...rest]=argv, options={};
  for(let i=0;i<rest.length;i+=2) {
    invariant(/^--[a-z-]+$/.test(rest[i])&&rest[i+1]!==undefined&&!rest[i+1].startsWith('--'),'expected --option value');
    const key=rest[i].slice(2);invariant(!(key in options),'duplicate option');options[key]=rest[i+1];
  }
  return {command,options};
}
async function json(path) {invariant(path,'file option required');return JSON.parse(await readFile(path,'utf8'));}
async function output(value,path) {
  const text=JSON.stringify(value,null,2)+'\n';
  if(path) {await mkdir(dirname(resolve(path)),{recursive:true});await writeFile(path,text,{mode:0o600});}
  else process.stdout.write(text);
}
export async function main(argv=process.argv.slice(2)) {
  invariant(Number(process.versions.node.split('.')[0])>=24,'Node 24 or later required');
  if(!argv.length||['help','--help','-h'].includes(argv[0])) {process.stdout.write(HELP);return;}
  const {command,options:o}=args(argv);
  const allowed={collect:['config','out','registry','duration'],race:['journal','sources','min-matches','out'],probe:['config','out'],
    pools:['registry','blocks','out'],'node-plan':['config','out'],'node-check':['config','out'],export:['journal','out']};
  invariant(allowed[command]&&Object.keys(o).every(k=>allowed[command].includes(k)),'unknown command or option');
  if(command==='collect') {
    const [{collect},{PoolEngine},{LivePoolCache},{runService}]=await Promise.all([import('./collector.mjs'),import('./pools.mjs'),import('./live_pools.mjs'),import('./runtime.mjs')]);
    const config=await json(o.config);if(o.duration!==undefined) config.duration_seconds=Number(o.duration);
    const registry=o.registry?await json(o.registry):undefined;
    const abort=new AbortController(), stop=()=>abort.abort();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try {const result=await runService(config,{out:o.out,registry,signal:abort.signal,collectImpl:collect,
      engineFactory:r=>new PoolEngine(r),liveFactory:r=>new LivePoolCache(r),onReady:info=>process.stderr.write(JSON.stringify({kind:'ready',...info})+'\n')});
      await output(result);if(['FAILED','DEGRADED'].includes(result.status))process.exitCode=1;}
    finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  } else if(command==='race') {
    const {analyzeRace}=await import('./race.mjs'), observations=[], sources=new Set();
    await readJournal(o.journal,r=>{invariant(observations.length<100000,'race limit: use a smaller retained journal');observations.push(r.observation);
      if(r.observation?.payload?.kind==='run_start')for(const name of r.observation.payload.sources??[])sources.add(name);});
    const min_matches=o['min-matches']===undefined?20:Number(o['min-matches']);boundedInteger(min_matches,1,100000,'min matches');
    await output(analyzeRace(observations,{sources:o.sources?.split(',')??[...sources],min_matches}),o.out);
  } else if(command==='probe') {
    const {probeEndpoints}=await import('./race.mjs');await output(await probeEndpoints(validateConfig(await json(o.config))),o.out);
  } else if(command==='pools') {
    const {PoolEngine}=await import('./pools.mjs'),registry=await json(o.registry), engine=new PoolEngine(registry);
    const blocks=await json(o.blocks);invariant(Array.isArray(blocks)&&blocks.length<=10000,'blocks must be a bounded array');
    const updates=blocks.map(b=>engine.applyBlock(b));await output({evidence_mode:registry.evidence_mode??'supplied',updates,state:engine.snapshot()},o.out);
  } else if(command==='node-plan') {
    const {renderNodePlan,validateAssets}=await import('./node_ops.mjs'),plan=renderNodePlan(await json(o.config));
    const validation=await validateAssets(plan);invariant(validation.status==='DIGEST_AND_MAINNET_IDENTITIES_MATCH','node assets failed validation');
    invariant(o.out,'output directory required');await mkdir(o.out,{recursive:true,mode:0o700});
    for(const [name,text] of Object.entries(plan.files)) {invariant(/^[A-Za-z0-9_.-]+$/.test(name),'unsafe plan filename');await writeFile(join(o.out,name),text,{flag:'wx',mode:0o600});}
    await output({manifest:plan.manifest,validation});
  } else if(command==='node-check') {
    const {probeNode}=await import('./node_ops.mjs');await output(await probeNode(await json(o.config)),o.out);
  } else if(command==='export') {
    invariant(o.out&&resolve(o.out)!==resolve(o.journal),'choose a separate export path');
    const {open}=await import('node:fs/promises');await mkdir(dirname(resolve(o.out)),{recursive:true});
    const file=await open(o.out,'wx',0o600);
    try {await readJournal(o.journal,r=>file.writeFile(JSON.stringify(r.observation)+'\n'));}finally{await file.close();}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{
  // Adapter exceptions may contain authenticated URLs: preserve only vetted error text.
  const safe=String(error.message??'operation failed').replace(/(?:https?|wss?):\/\/\S+/gi,'[endpoint redacted]');
  process.stderr.write('PULSE failed: '+safe.slice(0,400)+'\n');process.exitCode=1;
});
