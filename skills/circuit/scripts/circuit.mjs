#!/usr/bin/env node
/** CIRCUIT CLI. Builds unsigned calls and submits only to disposable local forks. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildRoute, validateBuilt, enumerateRoutes } from './routes.mjs';
import { makeRpc } from './rpc.mjs';
import { collectPreflight, validatePreflight } from './preflight.mjs';
import { collectCostEstimate, validateCostEvidence } from './costs.mjs';
import { simulateFork, validateForkEvidence } from './fork.mjs';
import { assessExecution, compareExecutions } from './economics.mjs';
import { digestValue } from './simulation.mjs';

const check=(ok,code)=>{if(!ok)throw new TypeError(code);};
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const HELP=`CIRCUIT — Robinhood V4 candidate construction and isolated simulation
Node.js 24+. Supply a fresh output path; existing files are never overwritten.

  build     --in route.json --out built.json
  enumerate --in graph.json --out paths.json
  preflight --in built.json --rpc-env CIRCUIT_RPC_URL --out preflight.json
  costs     --in built.json --rpc-env CIRCUIT_RPC_URL [--conversion conversion.json] --out costs.json
  simulate  --in built.json --rpc-env CIRCUIT_RPC_URL --anvil /trusted/anvil --out run.json
  sweep     --in sizes.json --rpc-env CIRCUIT_RPC_URL --anvil /trusted/anvil --out NEW_DIRECTORY
  assess    --in evidence.json --out assessment.json
  compare   --in entries.json --out comparison.json
  validate  --in artifact.json [--built built.json] --out validation.json
  demo      --out NEW_DIRECTORY

Optional preflight/simulate/sweep: --expected-code-hashes hashes.json
Optional simulate/sweep: --conversion conversion.json
Optional assess/compare: --as-of EPOCH_SECONDS for retained historical estimates
RPC endpoint is read from the named environment variable and omitted from reports.
Source RPC is read-only. No live execution, key handling or approval creation.
`;
async function readJSON(path,maxBytes=8*1024*1024) {
  check(typeof path==='string'&&path.length>0,'INPUT_PATH_REQUIRED');
  const info=await stat(path);check(info.isFile()&&info.size<=maxBytes,'INPUT_SIZE_OR_TYPE');
  const data=await readFile(path,'utf8');check(Buffer.byteLength(data)<=maxBytes,'INPUT_SIZE_OR_TYPE');return JSON.parse(data);
}
async function saveJSON(path,value) {
  check(typeof path==='string'&&path.length>0,'OUTPUT_PATH_REQUIRED');
  const text=JSON.stringify(value,null,2)+'\n';check(Buffer.byteLength(text)<=32*1024*1024,'OUTPUT_TOO_LARGE');
  await writeFile(path,text,{encoding:'utf8',flag:'wx',mode:0o600});
}
function exactKeys(value,required,optional=[]) {
  check(value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))
    &&Object.keys(value).every(k=>[...required,...optional].includes(k)),'INPUT_FIELDS_INVALID');
}
function connection(values) {
  const name=values['rpc-env']??'CIRCUIT_RPC_URL';
  check(/^[A-Z][A-Z0-9_]{0,63}$/.test(name),'RPC_ENV_NAME_INVALID');
  const rpcUrl=process.env[name];check(typeof rpcUrl==='string'&&rpcUrl.length>0,'RPC_ENV_MISSING');
  return {rpcUrl,rpc:makeRpc(rpcUrl,{timeoutMs:12000,maxBytes:1_048_576})};
}
/** Run one candidate, retaining a failed preflight instead of bypassing it. */
export async function runCandidate(builtInput,{rpc,rpcUrl,anvilPath='anvil',expected_code_hashes={},conversion}={}) {
  const built=validateBuilt(builtInput);
  const output={schema_version:'circuit.run.v1',built,status:'INCOMPLETE',preflight:null,cost_collection:null,fork_report:null,assessment:null};
  output.preflight=await collectPreflight(built,{rpc,expected_code_hashes});
  if(output.preflight.status!=='PREFLIGHT_OBSERVED') {
    output.status=output.preflight.status;
  } else {
    output.cost_collection=await collectCostEstimate(built,{rpc,conversion});
    output.fork_report=await simulateFork(built.call_request,{rpcUrl,anvilPath});
    const cost=output.cost_collection.cost_evidence;
    output.assessment=assessExecution(built,output.fork_report,cost?{cost_evidence:cost}:{});
    output.status=output.fork_report.status;
  }
  return {...output,evidence_digest:digestValue(output)};
}
function assessInput(input,asOf) {
  exactKeys(input,['built','fork_report'],['cost_evidence','as_of']);
  return assessExecution(input.built,input.fork_report,{
    ...(input.cost_evidence?{cost_evidence:input.cost_evidence}:{}),
    ...(asOf!==undefined?{as_of:asOf}:input.as_of!==undefined?{as_of:input.as_of}:{})
  });
}
export async function main(args=process.argv.slice(2)) {
  const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{
    help:{type:'boolean'},in:{type:'string'},out:{type:'string'},built:{type:'string'},'rpc-env':{type:'string'},
    anvil:{type:'string'},'expected-code-hashes':{type:'string'},conversion:{type:'string'},'as-of':{type:'string'}
  }});
  if(values.help){process.stdout.write(HELP);return;}
  check(positionals.length===1,'ONE_COMMAND_REQUIRED');const command=positionals[0];
  check(['build','enumerate','preflight','costs','simulate','sweep','assess','compare','validate','demo'].includes(command),'UNKNOWN_COMMAND');
  const allowed={build:['in','out'],enumerate:['in','out'],preflight:['in','out','rpc-env','expected-code-hashes'],
    costs:['in','out','rpc-env','conversion'],simulate:['in','out','rpc-env','anvil','expected-code-hashes','conversion'],
    sweep:['in','out','rpc-env','anvil','expected-code-hashes','conversion'],assess:['in','out','as-of'],compare:['in','out','as-of'],
    validate:['in','out','built'],demo:['out']}[command];
  check(Object.keys(values).every(k=>allowed.includes(k)),'UNSUPPORTED_COMMAND_OPTION');
  check(values.out,'OUTPUT_PATH_REQUIRED');
  let asOf;
  if(values['as-of']!==undefined){check(/^(0|[1-9][0-9]*)$/.test(values['as-of']),'AS_OF_INVALID');asOf=Number(values['as-of']);check(Number.isSafeInteger(asOf),'AS_OF_INVALID');}
  if(command==='demo') {
    await mkdir(values.out,{recursive:false,mode:0o700});
    const route=await readJSON(join(ROOT,'assets','route-example.json'));
    const built=buildRoute(route);
    const paths=enumerateRoutes({currency_in:route.currency_in,currency_out:route.currency_in,
      pools:route.hops.map(h=>({pool_key:h.pool_key,hook_data:h.hook_data})),max_hops:4,max_routes:64});
    await saveJSON(join(values.out,'built.json'),built);
    await saveJSON(join(values.out,'paths.json'),{schema_version:'circuit.paths.v1',wallet_context:'synthetic',paths,
      limitations:['Supplied synthetic registry only; path existence does not establish liquidity, execution or profit.']});
    process.stdout.write(JSON.stringify({status:'SYNTHETIC_CANDIDATES_BUILT',paths:paths.length})+'\n');return;
  }
  const input=await readJSON(values.in,command==='compare'?32*1024*1024:8*1024*1024);
  let result;
  if(command==='build')result=buildRoute(input);
  else if(command==='enumerate')result={schema_version:'circuit.paths.v1',paths:enumerateRoutes(input),
    limitations:['Bounded supplied registry only. No liquidity, price or execution qualification.']};
  else if(command==='assess')result=assessInput(input,asOf);
  else if(command==='compare') {
    check(Array.isArray(input),'COMPARISON_ARRAY_REQUIRED');
    result=compareExecutions(input.map(e=>({...e,...(asOf===undefined?{}:{as_of:asOf})})));
  } else if(command==='validate') {
    if(input.schema_version==='circuit.built.v1')validateBuilt(input);
    else if(input.schema_version==='hook-lab.fork.v1')validateForkEvidence(input);
    else if(input.schema_version==='circuit.cost.v1')validateCostEvidence(await readJSON(values.built),input);
    else if(input.schema_version==='circuit.preflight.v1')await validatePreflight(await readJSON(values.built),input);
    else throw new TypeError('UNSUPPORTED_VALIDATION_SCHEMA');
    result={schema_version:'circuit.validation.v1',status:'CONSISTENT',input_schema:input.schema_version,
      input_digest:digestValue(input),limitation:'Consistency does not establish source authenticity, current state or execution approval.'};
  } else {
    const conn=connection(values);
    const expected_code_hashes=values['expected-code-hashes']?await readJSON(values['expected-code-hashes'],16384):{};
    const conversion=values.conversion?await readJSON(values.conversion,16384):undefined;
    const options={...conn,expected_code_hashes,conversion,anvilPath:values.anvil??'anvil'};
    if(command==='preflight')result=await collectPreflight(input,{rpc:conn.rpc,expected_code_hashes});
    if(command==='costs')result=await collectCostEstimate(input,options);
    if(command==='simulate')result=await runCandidate(input,options);
    if(command==='sweep') {
      exactKeys(input,['schema_version','route','sizes']);
      check(input.schema_version==='circuit.sweep.v1'&&Array.isArray(input.sizes)&&input.sizes.length>=1&&input.sizes.length<=8,'SWEEP_SIZE_LIMIT');
      const candidates=input.sizes.map(size=>{exactKeys(size,['amount_in','minimum_out']);return buildRoute({...input.route,...size});});
      check(new Set(candidates.map(b=>b.route_digest)).size===candidates.length,'DUPLICATE_SWEEP_CANDIDATE');
      await mkdir(values.out,{recursive:false,mode:0o700});
      const rows=[],entries=[];
      for(let i=0;i<candidates.length;i++) {
        const run=await runCandidate(candidates[i],options);
        const filename=`run-${String(i+1).padStart(2,'0')}.json`;
        await saveJSON(join(values.out,filename),run);
        rows.push({file:filename,route_digest:candidates[i].route_digest,amount_in:candidates[i].route.amount_in,status:run.status});
        if(run.fork_report)entries.push({built:candidates[i],fork_report:run.fork_report,
          ...(run.cost_collection?.cost_evidence?{cost_evidence:run.cost_collection.cost_evidence}:{})});
      }
      result={schema_version:'circuit.sweep-report.v1',rows,comparison:entries.length?compareExecutions(entries):null,
        limitations:['Every size starts from the same pinned parent state in its own disposable fork.',
          'This is a bounded sample, not a global size optimizer. Failed and missing cases remain listed.']};
      await saveJSON(join(values.out,'sweep.json'),result);
      process.stdout.write(JSON.stringify({status:'SWEEP_COMPLETE',candidates:rows.length})+'\n');return;
    }
  }
  await saveJSON(values.out,result);
  process.stdout.write(JSON.stringify({status:result.status??'WRITTEN',schema_version:result.schema_version})+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  process.stderr.write(JSON.stringify({status:'CIRCUIT_COMMAND_FAILED',reason:error instanceof TypeError?error.message:'INPUT_OUTPUT_OR_RUNTIME_ERROR'})+'\n');
  process.exitCode=1;
});
