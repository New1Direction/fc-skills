import {test} from 'node:test';
import assert from 'node:assert/strict';
import {latencyReport,summarize} from './latency.mjs';
const row=(source,ns,extra={})=>({source,observed_mono_ns:String(ns),run_id:'r',clock_id:'c',event_id:'block:abc',stage:'block',delivery:'live',...extra});
test('matched providers use first actual same-stage arrival and retain missing observations',()=>{
 const r=latencyReport([row('a',1e6),row('b',5e6),row('a',10e6,{event_id:'block:def'})]);
 assert.equal(r.comparisons.find(x=>x.source==='b').relative_to_first_observed.p95_ms,4);
 assert.equal(r.observed_universes[0].by_source.b.missing_from_observed_union,1);
 assert.equal(r.fastest_claim_established,false);
});
test('unmatched clock, run, event and delivery never manufacture a speed advantage',()=>{
 const r=latencyReport([row('a',100),row('b',1,{clock_id:'other'}),row('b',1,{run_id:'other'}),row('b',1,{event_id:'other'}),row('b',1,{delivery:'backfill'})]);
 assert(r.comparisons.every(x=>x.matched_with_another_source===0));
});
test('arrival to durable commit is measured and negative observations remain invalid',()=>{
 const r=latencyReport([row('a',1e6),row('a',7e6,{stage:'block_durable'}),row('a',9e6,{stage:'receipts'}),row('a',8e6,{stage:'receipts_durable'})]);
 assert.equal(r.persistence[0].arrival_to_commit.p50_ms,6);
 assert.equal(r.persistence[1].negative_pairs,1);
 assert.equal(r.persistence[1].arrival_to_commit.count,0);
});
test('duplicate source arrivals use earliest without double counting',()=>{
 const r=latencyReport([row('a',5e6),row('a',1e6),row('b',3e6)]);
 assert.equal(r.duplicate_rows,1);assert.equal(r.usable_unique_arrivals,2);
 assert.equal(r.comparisons.find(x=>x.source==='b').relative_to_first_observed.p50_ms,2);
});
test('unknown feed messages and missing timing data are never transaction latency',()=>{
 const r=latencyReport([row('a',1,{stage:'feed'}),row('b','NaN'),{}]);
 assert.equal(r.excluded_rows,3);assert.deepEqual(r.comparisons,[]);
});
test('empty percentile sample stays unknown',()=>{assert.equal(summarize([]).p99_ms,null);assert.equal(summarize([1,2,10]).p95_ms,10);});
