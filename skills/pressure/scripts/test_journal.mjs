import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendCohort,appendOutcome,readJournal,summarizeJournal} from './journal.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),H='0x'+'a'.repeat(64);
const cohort=()=>({id:'batch1',evidence_mode:'synthetic',policy_id:'supply-rise-v1',policy_sha256:'sha256:'+'a'.repeat(64),chain_id:4663,quote_asset:{address:A,decimals:6},capital_per_case_raw:'1000000',horizon_seconds:60,max_signal_age_seconds:30,candidates:[true,false].map((selected,i)=>({id:'case'+i,token:B,selected,signal:'Retained supply change',observed_at:1000,block:{number:100,hash:H,timestamp:999},evidence_refs:['fixture:signal']}))});
const outcome=(id='case0')=>({cohort_id:'batch1',candidate_id:id,measurement_start_at:1000,measurement_end_at:1060,result_kind:'modeled',gross_pnl_raw:'120000',costs_raw:'20000',cost_coverage:'complete',evidence_refs:['fixture:outcome']});
async function run(fn){const dir=await mkdtemp(join(tmpdir(),'pressure-journal-'));try{await fn(join(dir,'events.jsonl'));}finally{await rm(dir,{recursive:true,force:true});}}
test('freeze survives reload and records pending then missing outcomes',()=>run(async path=>{
 await appendCohort(path,cohort(),{now:1000});assert.equal((await readJournal(path)).length,1);
 assert.equal((await summarizeJournal(path,{asOf:1030})).cohorts[0].pending,2);
 const r=(await summarizeJournal(path,{asOf:1061})).cohorts[0];assert.equal(r.missing,2);assert.equal(r.comparisons[0].selected_minus_control_bps,null);
}));
test('net accounting and full matched control comparison use exact rational amounts',()=>run(async path=>{
 await appendCohort(path,cohort(),{now:1000});await appendOutcome(path,outcome(),{now:1061});
 const o=outcome('case1');o.gross_pnl_raw='-30000';await appendOutcome(path,o,{now:1062});
 const r=(await summarizeJournal(path,{asOf:1062})).cohorts[0];assert.equal(r.cases[0].net_pnl_raw,'100000');assert.equal(r.cases[1].net_pnl_raw,'-50000');
 const gap=r.comparisons.find(x=>x.result_kind==='modeled');assert.equal(gap.status,'DESCRIPTIVE_COMPARISON');assert.equal(BigInt(gap.selected_minus_control_bps.numerator)/BigInt(gap.selected_minus_control_bps.denominator),1500n);
}));
test('unknown costs remain unknown and suppress matched claims',()=>run(async path=>{
 await appendCohort(path,cohort(),{now:1000});const o=outcome();o.cost_coverage='partial';o.costs_raw=null;await appendOutcome(path,o,{now:1061});
 const r=(await summarizeJournal(path,{asOf:1061})).cohorts[0];assert.equal(r.unknown_costs,1);assert.equal(r.cases[0].net_pnl_raw,null);assert.equal(r.groups[0].net_return_bps,null);
}));
test('outcomes cannot move horizons, precede maturity, duplicate, or add winners later',()=>run(async path=>{
 await appendCohort(path,cohort(),{now:1000});await assert.rejects(appendOutcome(path,outcome(),{now:1059}),/measurement end/);
 const o=outcome();o.measurement_end_at=1050;await assert.rejects(appendOutcome(path,o,{now:1061}),/exact frozen horizon/);
 await assert.rejects(appendOutcome(path,outcome('new-winner'),{now:1061}),/outside frozen universe/);
 await appendOutcome(path,outcome(),{now:1061});await assert.rejects(appendOutcome(path,outcome(),{now:1062}),/already recorded/);
 await assert.rejects(appendCohort(path,cohort(),{now:1000}),/Clock moved backwards/);
}));
test('stale/future signals, unknown fields, and duplicate candidates rejected',()=>run(async path=>{
 for(const mutate of [x=>x.candidates[0].observed_at=900,x=>x.candidates[0].observed_at=1001,x=>x.extra=true,x=>x.candidates[1].id='case0']){const c=cohort();mutate(c);await assert.rejects(appendCohort(path,c,{now:1000}));}
 assert.equal((await readJournal(path)).length,0);
}));
test('tampered or truncated journal is rejected instead of quietly dropping outcomes',()=>run(async path=>{
 await appendCohort(path,cohort(),{now:1000});const original=await readFile(path,'utf8');
 await writeFile(path,original.replace('supply-rise-v1','supply-rise-v2'));await assert.rejects(readJournal(path),/digest mismatch/);
 await writeFile(path,original.trimEnd());await assert.rejects(readJournal(path),/Truncated journal/);
}));
test('concurrent writer lock prevents mutation',()=>run(async path=>{
 await writeFile(path+'.lock','existing writer');await assert.rejects(appendCohort(path,cohort(),{now:1000}),/locked/);assert.equal((await readJournal(path)).length,0);
}));
test('modeled and executed outcome claims are never pooled',()=>run(async path=>{
 await appendCohort(path,cohort(),{now:1000});await appendOutcome(path,outcome(),{now:1061});const o=outcome('case1');o.result_kind='executed';await appendOutcome(path,o,{now:1062});
 const r=(await summarizeJournal(path,{asOf:1062})).cohorts[0];assert.equal(r.groups.length,2);assert.ok(r.comparisons.every(x=>x.status==='INSUFFICIENT_MATCHED_COVERAGE'));
}));
test('no floating-point loss for large raw PnL',()=>run(async path=>{
 const c=cohort();c.capital_per_case_raw='1000000000000000000000000';await appendCohort(path,c,{now:1000});const o=outcome();o.gross_pnl_raw='900719925474099399999';o.costs_raw='1';await appendOutcome(path,o,{now:1061});assert.equal((await summarizeJournal(path,{asOf:1061})).cohorts[0].cases[0].net_pnl_raw,'900719925474099399998');
}));
