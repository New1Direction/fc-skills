/** Append-only prospective candidate cohorts and supplied outcome accounting. */
import {createHash} from 'node:crypto';
import {readFile,open,mkdir,unlink,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
const A=/^0x[0-9a-f]{40}$/,H=/^0x[0-9a-f]{64}$/,U=/^(0|[1-9][0-9]{0,77})$/,I=/^(0|-?[1-9][0-9]{0,77})$/;
const ok=(v,m)=>{if(!v)throw new TypeError(m);};
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>'sha256:'+createHash('sha256').update(canonical(v)).digest('hex');
const clock=()=>Math.floor(Date.now()/1000);
function fields(x,keys,label){ok(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)),label+': incorrect fields');}
function integer(x,min,max,label){ok(Number.isSafeInteger(x)&&x>=min&&x<=max,label+': invalid integer');}
function id(x){ok(typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(x),'Invalid ID');}
function refs(x){ok(Array.isArray(x)&&x.length>0&&x.length<=20&&x.every(v=>typeof v==='string'&&v.length>0&&v.length<=2048),'Evidence references required');}
function amount(x,signed=false){ok(typeof x==='string'&&(signed?I:U).test(x)&&BigInt(x)<2n**256n&&BigInt(x)>-(2n**256n),'Invalid raw amount');return BigInt(x);}
function cohort(x,now){
 fields(x,['id','evidence_mode','policy_id','policy_sha256','chain_id','quote_asset','capital_per_case_raw','horizon_seconds','max_signal_age_seconds','candidates'],'cohort');
 id(x.id);id(x.policy_id);ok(['prospective','synthetic'].includes(x.evidence_mode),'Invalid evidence mode');ok(/^sha256:[0-9a-f]{64}$/.test(x.policy_sha256),'Policy digest required');ok(x.chain_id===4663,'Wrong chain');
 fields(x.quote_asset,['address','decimals'],'quote_asset');ok(A.test(x.quote_asset.address),'Invalid quote asset');integer(x.quote_asset.decimals,0,36,'decimals');ok(amount(x.capital_per_case_raw)>0n,'Capital must be positive');
 integer(x.horizon_seconds,1,2592000,'horizon');integer(x.max_signal_age_seconds,0,604800,'signal age');
 ok(Array.isArray(x.candidates)&&x.candidates.length>=1&&x.candidates.length<=1000,'Candidate universe must contain 1–1000 cases');
 const seen=new Set();
 for(const c of x.candidates){
  fields(c,['id','token','selected','signal','observed_at','block','evidence_refs'],'candidate');id(c.id);ok(!seen.has(c.id),'Duplicate candidate');seen.add(c.id);ok(A.test(c.token)&&typeof c.selected==='boolean','Invalid candidate identity');
  ok(typeof c.signal==='string'&&c.signal.length>0&&c.signal.length<=1000,'Signal description required');integer(c.observed_at,0,now,'observation time');ok(now-c.observed_at<=x.max_signal_age_seconds,'Candidate observation is stale');
  fields(c.block,['number','hash','timestamp'],'candidate block');integer(c.block.number,0,Number.MAX_SAFE_INTEGER,'block');ok(H.test(c.block.hash),'Block hash required');integer(c.block.timestamp,0,c.observed_at,'block timestamp');refs(c.evidence_refs);
 }
 return structuredClone(x);
}
function outcome(x,rows,now){
 fields(x,['cohort_id','candidate_id','measurement_start_at','measurement_end_at','result_kind','gross_pnl_raw','costs_raw','cost_coverage','evidence_refs'],'outcome');id(x.cohort_id);id(x.candidate_id);
 const parent=rows.find(r=>r.type==='cohort'&&r.data.id===x.cohort_id);ok(parent,'Unknown cohort');ok(parent.data.candidates.some(c=>c.id===x.candidate_id),'Candidate outside frozen universe');
 ok(!rows.some(r=>r.type==='outcome'&&r.data.cohort_id===x.cohort_id&&r.data.candidate_id===x.candidate_id),'Outcome already recorded');
 ok(x.measurement_start_at===parent.recorded_at&&x.measurement_end_at===parent.recorded_at+parent.data.horizon_seconds,'Outcome must use the exact frozen horizon');integer(x.measurement_end_at,0,now,'measurement end');
 ok(['modeled','wallet_fork','executed'].includes(x.result_kind),'Invalid result kind');amount(x.gross_pnl_raw,true);ok(['complete','partial','unknown'].includes(x.cost_coverage),'Invalid cost coverage');if(x.costs_raw!==null)amount(x.costs_raw);ok(x.cost_coverage!=='complete'||x.costs_raw!==null,'Complete costs need an amount');refs(x.evidence_refs);
 return structuredClone(x);
}
export async function readJournal(path){
 let bytes;try{ok(!(await lstat(path)).isSymbolicLink(),'Journal symlinks are unsupported');bytes=await readFile(path);}catch(e){if(e.code==='ENOENT')return[];throw e;}
 ok(bytes.length<=8*1024*1024,'Journal exceeds 8 MiB');const text=bytes.toString('utf8');ok(!text||text.endsWith('\n'),'Truncated journal; recover from retained backup');
 const lines=text.trimEnd()?text.trimEnd().split('\n'):[];ok(lines.length<=10000,'Journal exceeds 10000 events');const rows=[];
 for(const line of lines){const r=JSON.parse(line);fields(r,['schema_version','sequence','previous_digest','recorded_at','type','data','digest'],'journal row');
  ok(r.schema_version==='pressure.journal.v1'&&r.sequence===rows.length+1&&r.previous_digest===(rows.at(-1)?.digest??null),'Journal chain mismatch');integer(r.recorded_at,0,Number.MAX_SAFE_INTEGER,'record time');ok(!rows.length||r.recorded_at>=rows.at(-1).recorded_at,'Clock moved backwards');
  const body={...r};delete body.digest;ok(hash(body)===r.digest,'Journal digest mismatch');
  if(r.type==='cohort'){cohort(r.data,r.recorded_at);ok(!rows.some(p=>p.type==='cohort'&&p.data.id===r.data.id),'Duplicate cohort');}
  else if(r.type==='outcome')outcome(r.data,rows,r.recorded_at);else throw new TypeError('Unknown journal event');rows.push(r);
 }
 return rows;
}
async function append(path,type,input,{now=clock()}={}){
 integer(now,0,Number.MAX_SAFE_INTEGER,'record time');await mkdir(dirname(path),{recursive:true});let lock;
 try{lock=await open(path+'.lock','wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('Journal is locked; inspect any abandoned writer before recovery');throw e;}
 try{const rows=await readJournal(path);ok(rows.length<10000,'Journal full');ok(!rows.length||now>=rows.at(-1).recorded_at,'Clock moved backwards');
  let data;if(type==='cohort'){data=cohort(input,now);ok(!rows.some(r=>r.type==='cohort'&&r.data.id===data.id),'Duplicate cohort');}else data=outcome(input,rows,now);
  const event={schema_version:'pressure.journal.v1',sequence:rows.length+1,previous_digest:rows.at(-1)?.digest??null,recorded_at:now,type,data};event.digest=hash(event);
  const line=JSON.stringify(event)+'\n';let size=0;try{size=(await lstat(path)).size;}catch(e){if(e.code!=='ENOENT')throw e;}ok(size+Buffer.byteLength(line)<=8*1024*1024,'Journal exceeds 8 MiB');
  const file=await open(path,'a',0o600);try{await file.writeFile(line);await file.sync();}finally{await file.close();}return event;
 }finally{await lock.close();await unlink(path+'.lock');}
}
export const appendCohort=(path,input,options)=>append(path,'cohort',input,options);
export const appendOutcome=(path,input,options)=>append(path,'outcome',input,options);
export async function summarizeJournal(path,{asOf=clock()}={}){
 integer(asOf,0,Number.MAX_SAFE_INTEGER,'asOf');const rows=(await readJournal(path)).filter(r=>r.recorded_at<=asOf),cohorts=[];
 for(const r of rows.filter(x=>x.type==='cohort')){
  const c=r.data,groups=[],cases=c.candidates.map(candidate=>{
   const found=rows.find(x=>x.type==='outcome'&&x.data.cohort_id===c.id&&x.data.candidate_id===candidate.id)?.data;
   return {candidate_id:candidate.id,selected:candidate.selected,status:found?'recorded':asOf>=r.recorded_at+c.horizon_seconds?'missing':'pending',result_kind:found?.result_kind??null,net_pnl_raw:found?.cost_coverage==='complete'?(BigInt(found.gross_pnl_raw)-BigInt(found.costs_raw)).toString():null,cost_coverage:found?.cost_coverage??'unknown'};
  });
  for(const selected of [true,false])for(const kind of ['modeled','wallet_fork','executed']){
   const available=cases.filter(x=>x.selected===selected&&x.result_kind===kind),known=available.filter(x=>x.net_pnl_raw!==null);if(!available.length)continue;
   const net=known.reduce((s,x)=>s+BigInt(x.net_pnl_raw),0n),capital=BigInt(c.capital_per_case_raw)*BigInt(known.length);
   groups.push({selected,result_kind:kind,recorded:available.length,with_complete_costs:known.length,net_pnl_raw:known.length?net.toString():null,net_return_bps:capital?{numerator:(net*10000n).toString(),denominator:capital.toString()}:null,positive_net_cases:known.filter(x=>BigInt(x.net_pnl_raw)>0n).length});
  }
  const comparisons=['modeled','wallet_fork','executed'].map(kind=>{const selected=groups.find(g=>g.selected&&g.result_kind===kind),control=groups.find(g=>!g.selected&&g.result_kind===kind);const full=s=>{const set=cases.filter(x=>x.selected===s);return set.length>0&&set.every(x=>x.result_kind===kind&&x.net_pnl_raw!==null);};
   if(!full(true)||!full(false))return{result_kind:kind,status:'INSUFFICIENT_MATCHED_COVERAGE',selected_minus_control_bps:null};
   const a=selected.net_return_bps,b=control.net_return_bps;return{result_kind:kind,status:'DESCRIPTIVE_COMPARISON',selected_minus_control_bps:{numerator:(BigInt(a.numerator)*BigInt(b.denominator)-BigInt(b.numerator)*BigInt(a.denominator)).toString(),denominator:(BigInt(a.denominator)*BigInt(b.denominator)).toString()}};
  });
  cohorts.push({id:c.id,evidence_mode:c.evidence_mode,policy_id:c.policy_id,policy_sha256:c.policy_sha256,quote_asset:c.quote_asset,registered_at:r.recorded_at,horizon_end_at:r.recorded_at+c.horizon_seconds,universe:cases.length,selected:cases.filter(x=>x.selected).length,pending:cases.filter(x=>x.status==='pending').length,missing:cases.filter(x=>x.status==='missing').length,unknown_costs:cases.filter(x=>x.status==='recorded'&&x.net_pnl_raw===null).length,cases,groups,comparisons});
 }
 return{schema_version:'pressure.outcome-summary.v1',status:'DESCRIPTIVE_RESEARCH',as_of:asOf,cohorts,edge_established:false,limitations:['Timestamps and hashes are local records, not third-party attestations. Rewriting an entire journal can evade hash-chain checks.','Recorded outcomes and cost coverage are supplied assertions; inspect their retained evidence. Execution claims are not independently verified here.','Selected-versus-control differences are descriptive, not causal inference or out-of-sample proof. Freeze a representative universe and retain missing outcomes.','Different result kinds, cohorts and quote assets are never pooled. Synthetic evidence cannot establish prospective performance.']};
}
