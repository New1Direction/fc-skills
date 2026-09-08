#!/usr/bin/env node
import {readFile,mkdir,writeFile,rename,rm,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeRpc} from './rpc.mjs';
import {collectSupply,validateCollection} from './collect.mjs';
import {analyzeSupply} from './supply.mjs';
import {analyzeLiquidity} from './liquidity.mjs';
import {appendCohort,appendOutcome,summarizeJournal} from './journal.mjs';
const OPTIONS={collect:['input','rpc-env','out'],verify:['input','out'],analyze:['input','out'],liquidity:['input','out'],report:['input','out'],freeze:['input','journal','out'],outcome:['input','journal','out'],journal:['journal','out'],demo:['out']};
const HELP=`PRESSURE — Robinhood stock-token supply and liquidity research\nCommands: collect, verify, analyze, liquidity, report, freeze, outcome, journal, demo\nUse --input JSON --out JSON. collect also requires --rpc-env VARIABLE.\nfreeze/outcome also require --journal JSONL; journal uses --journal JSONL --out JSON.\ndemo --out NEW_DIRECTORY runs the bundled synthetic workflow without network access.\nSee SKILL.md and references for schemas and evidence limits.\n`;
async function readJson(path){if((await stat(path)).size>32*1024*1024)throw Error('Input exceeds 32 MiB');return JSON.parse(await readFile(path,'utf8'));}
async function save(path,value){const data=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(data)>32*1024*1024)throw Error('Output exceeds 32 MiB');await mkdir(dirname(path),{recursive:true});const tmp=path+'.tmp-'+process.pid;try{await writeFile(tmp,data,{flag:'wx',mode:0o600});await rename(tmp,path);}finally{await rm(tmp,{force:true});}}
export async function supplyEvidence(input){
 if(input?.schema_version==='pressure.synthetic-evm-smoke.v1'){
  const collection=smokeCollection(input),value=await supplyEvidence(collection);
  value.verification.validated_scope='nested_synthetic_collection_only';return value;
 }
 if(input?.schema_version==='pressure.collection.v1'){
  const verification=await validateCollection(input);if(!verification.valid)throw Error('Retained collector transcript failed verification');
  if(!input.dataset)return{dataset:null,report:{schema_version:'pressure.supply-report.v1',status:'UNAVAILABLE',collection_status:input.status,issues:input.issues},verification};
  return{dataset:input.dataset,report:analyzeSupply(input.dataset),verification};
 }
 return{dataset:input,report:analyzeSupply(input),verification:{status:'SUPPLIED_DATASET',limitation:'Normalized evidence was supplied without a native collector transcript.'}};
}
function smokeCollection(input){
 if(input.evidence_mode!=='synthetic'||input.mainnet_qualification!==false||input.evidence?.collection?.dataset?.evidence_mode!=='synthetic')throw Error('Invalid synthetic smoke envelope');
 return input.evidence.collection;
}
export async function verifyEvidence(input){
 if(input?.schema_version==='pressure.synthetic-evm-smoke.v1')return{...await validateCollection(smokeCollection(input)),validated_scope:'nested_synthetic_collection_only'};
 return validateCollection(input);
}
export async function buildReport(input){
 if(!input||typeof input!=='object'||!Object.hasOwn(input,'supply')||Object.keys(input).some(k=>!['supply','liquidity'].includes(k)))throw Error('Report input requires supply and optional liquidity');
 const supply=await supplyEvidence(input.supply),liquidity=input.liquidity?analyzeLiquidity(input.liquidity):null;
 if(liquidity&&supply.dataset&&(liquidity.asset.address!==supply.dataset.token.address.toLowerCase()||liquidity.asset.decimals!==supply.dataset.token.decimals))throw Error('Supply and liquidity asset identity differ');
 const end=supply.dataset?.window.end;
 const matched=end&&input.liquidity?.observations.some(o=>o.block.number===end.number&&o.block.hash.toLowerCase()===end.hash.toLowerCase());
 return{schema_version:'pressure.report.v1',status:'RESEARCH_REPORT',chain_id:4663,evidence_modes:{supply:supply.dataset?.evidence_mode??null,liquidity:liquidity?.evidence_mode??null},supply:supply.report,supply_verification:supply.verification,liquidity,alignment:liquidity?(matched?'END_BLOCK_OBSERVATION_PRESENT':'NO_MATCHING_END_BLOCK_OBSERVATION'):'LIQUIDITY_NOT_SUPPLIED',trade_signal:null,limitations:['Supply and liquidity are separately retained observations; this report does not infer a causal connection or trade instruction.','Address custody, pool inventory and wallet-specific executable liquidity remain distinct.','The presence of matching token and block identities does not establish truthful upstream data, complete costs or a profitable opportunity.']};
}
async function demo(out){
 await mkdir(out,{recursive:false});const supply=await readJson(new URL('../assets/supply.synthetic.json',import.meta.url)),liquidity=await readJson(new URL('../assets/liquidity.synthetic.json',import.meta.url));
 await save(resolve(out,'supply-report.json'),(await supplyEvidence(supply)).report);await save(resolve(out,'liquidity-report.json'),analyzeLiquidity(liquidity));
 // Construct a separate, explicitly synthetic coherent joint case. Original independent fixtures stay intact.
 const aligned=structuredClone(liquidity);aligned.asset={address:supply.token.address,decimals:supply.token.decimals};
 const points=[supply.window.start,supply.window.end];
 aligned.as_of=new Date((supply.window.end.timestamp+60)*1000).toISOString();
 aligned.observations=aligned.observations.map((o,i)=>{const point=points[i];if(!point)throw Error('Demo expects two liquidity points');const block={number:point.number,hash:point.hash,timestamp:new Date(point.timestamp*1000).toISOString()};return{...o,block,observed_at:new Date((point.timestamp+1)*1000).toISOString(),reference:{...o.reference,observed_at:block.timestamp,block:{number:point.number,hash:point.hash}},evidence_refs:['SYNTHETIC-ALIGNED-DEMO:generated-point-'+i]};});
 const joint={supply,liquidity:aligned};await save(resolve(out,'research-bundle.json'),joint);await save(resolve(out,'report.json'),await buildReport(joint));
 const freezeTime=1700000000,hash='0x'+'a'.repeat(64),journal=resolve(out,'synthetic-journal.jsonl');
 const cohort={id:'synthetic-cohort',evidence_mode:'synthetic',policy_id:'demonstration-only',policy_sha256:'sha256:'+'a'.repeat(64),chain_id:4663,quote_asset:{address:'0x'+'2'.repeat(40),decimals:6},capital_per_case_raw:'1000000',horizon_seconds:60,max_signal_age_seconds:30,candidates:[true,false,true].map((selected,i)=>({id:'case'+i,token:'0x'+'1'.repeat(40),selected,signal:'Synthetic observed supply change',observed_at:freezeTime,block:{number:100,hash,timestamp:freezeTime},evidence_refs:['synthetic:case'+i]}))};
 await appendCohort(journal,cohort,{now:freezeTime});
 for(let i=0;i<2;i++)await appendOutcome(journal,{cohort_id:cohort.id,candidate_id:'case'+i,measurement_start_at:freezeTime,measurement_end_at:freezeTime+60,result_kind:'modeled',gross_pnl_raw:i===0?'120000':'-30000',costs_raw:'20000',cost_coverage:'complete',evidence_refs:['synthetic:outcome'+i]},{now:freezeTime+61});
 await save(resolve(out,'outcomes.json'),await summarizeJournal(journal,{asOf:freezeTime+62}));
 return{status:'SYNTHETIC_DEMO_WRITTEN',output:out,files:['supply-report.json','liquidity-report.json','research-bundle.json','report.json','synthetic-journal.jsonl','outcomes.json'],mainnet_evidence:false};
}
export async function main(argv=process.argv.slice(2)){
 if(!argv.length||argv[0]==='--help'){process.stdout.write(HELP);return;}
 const [command,...args]=argv,allowed=OPTIONS[command];if(!allowed)throw Error('Unknown command');const o={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!allowed.includes(key)||o[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid, duplicate or missing option');o[key]=args[i+1];}if(allowed.some(k=>!o[k]))throw Error('Missing required command option');
 if(command==='demo'){process.stdout.write(JSON.stringify(await demo(resolve(o.out)))+'\n');return;}
 const input=o.input?await readJson(o.input):null;let report;
 if(command==='collect'){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o['rpc-env']))throw Error('Invalid RPC environment name');const endpoint=process.env[o['rpc-env']];if(!endpoint)throw Error('RPC environment variable is not set');report=await collectSupply(input,{rpc:makeRpc(endpoint)});}
 if(command==='verify')report=await verifyEvidence(input);
 if(command==='analyze')report=(await supplyEvidence(input)).report;
 if(command==='liquidity')report=analyzeLiquidity(input);
 if(command==='report')report=await buildReport(input);
 if(command==='freeze')report=await appendCohort(resolve(o.journal),input);
 if(command==='outcome')report=await appendOutcome(resolve(o.journal),input);
 if(command==='journal')report=await summarizeJournal(resolve(o.journal));
 await save(resolve(o.out),report);process.stdout.write(JSON.stringify({status:report.status??'JOURNAL_APPENDED',output:resolve(o.out)})+'\n');
 if(command==='verify'&&!report.valid)process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{process.stderr.write('PRESSURE: '+String(e.message).slice(0,400)+'\n');process.exitCode=1;});
