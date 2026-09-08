#!/usr/bin/env node
import {readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeRpc} from './rpc.mjs';
import {inspectDeployment,compareIdentity} from './identity.mjs';
import {discoverPonsPool,quotePonsFees} from './pons.mjs';
import {simulateCall} from './simulation.mjs';
import {simulateFork} from './fork.mjs';

const COMMANDS={
  identity:['input','rpc-env','out'], 'pons-discover':['input','rpc-env','out'],
  'pons-fees':['input','out'],call:['input','rpc-env','out'],fork:['input','rpc-env','anvil','out'],
  qualify:['input','out'],compare:['prior','current','out']
};
const HELP=`HOOK LAB — Robinhood V4 evidence tools (Node.js24+)\nCommands: identity, pons-discover, pons-fees, call, fork, qualify, compare\nUse --input JSON --out JSON; RPC commands also require --rpc-env VARIABLE.\nFork additionally requires --anvil /absolute/path/to/anvil.\nCompare uses --prior JSON --current JSON --out JSON.\nSee SKILL.md and references for strict schemas and evidence boundaries.\n`;
async function readJson(path){const data=await readFile(path);if(data.length>16*1024*1024)throw Error('Input exceeds 16 MiB');return JSON.parse(data.toString('utf8'));}
export async function main(argv=process.argv.slice(2)){
  if(argv.length===0||argv[0]==='--help'){process.stdout.write(HELP);return;}
  const [command,...rest]=argv,allowed=COMMANDS[command];if(!allowed)throw Error('Unknown command');
  const opts={};for(let i=0;i<rest.length;i+=2){const key=rest[i]?.replace(/^--/,'');if(!rest[i]?.startsWith('--')||!allowed.includes(key)||opts[key]!==undefined||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Invalid, duplicate or missing option');opts[key]=rest[i+1];}
  if(allowed.some(k=>!opts[k]))throw Error('Missing required command option');
  let endpoint,rpc;if(opts['rpc-env']){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts['rpc-env']))throw Error('Invalid RPC environment variable name');endpoint=process.env[opts['rpc-env']];if(!endpoint)throw Error('RPC environment variable is not set');rpc=makeRpc(endpoint);}
  const input=opts.input?await readJson(opts.input):null;let report;
  if(command==='identity')report=await inspectDeployment(input,{rpc});
  if(command==='pons-discover')report=await discoverPonsPool(input,{rpc});
  if(command==='pons-fees')report=quotePonsFees(input);
  if(command==='call')report=await simulateCall(input,{rpc});
  if(command==='fork')report=await simulateFork(input,{anvilPath:opts.anvil,rpcUrl:endpoint});
  if(command==='qualify'){const {qualifyEvidence}=await import('./qualify.mjs');report=await qualifyEvidence(input);}
  if(command==='compare')report=compareIdentity(await readJson(opts.prior),await readJson(opts.current));
  const out=resolve(opts.out),temp=out+'.tmp-'+process.pid;
  const data=JSON.stringify(report,null,2)+'\n';if(Buffer.byteLength(data)>32*1024*1024)throw Error('Report exceeds 32 MiB');
  await mkdir(dirname(out),{recursive:true});try{await writeFile(temp,data,{flag:'wx',mode:0o600});await rename(temp,out);}finally{await rm(temp,{force:true});}
  process.stdout.write(JSON.stringify({status:report.status??'REPORT_WRITTEN',output:out})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(e=>{process.stderr.write('HOOK LAB: '+String(e.message).slice(0,400)+'\n');process.exitCode=1;});}
