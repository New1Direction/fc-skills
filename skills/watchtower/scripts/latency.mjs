// Arrival comparisons use the same object, stage, process run and monotonic clock.
// Wall clocks and block timestamps never stand in for wire-arrival timestamps.
export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  const q = p => sorted.length ? sorted[Math.max(0,Math.ceil(p*sorted.length)-1)] : null;
  return {count:sorted.length,min_ms:sorted[0]??null,p50_ms:q(.5),p95_ms:q(.95),p99_ms:q(.99),max_ms:sorted.at(-1)??null};
}

export function latencyReport(rows) {
  if(!Array.isArray(rows)) throw new Error('OBSERVATIONS_ARRAY_REQUIRED');
  const arrivals = new Map(), stages = new Map(), sources = new Set();
  let excluded=0, duplicates=0;
  for(const row of rows) {
    if(!row || !['head','block','block_durable','receipts','receipts_durable'].includes(row.stage) ||
       !['live','backfill','replay'].includes(row.delivery) || typeof row.event_id!=='string' ||
       ![row.source,row.run_id,row.clock_id].every(x=>typeof x==='string'&&x.length) ||
       !/^(0|[1-9][0-9]*)$/.test(String(row.observed_mono_ns))) {excluded++;continue;}
    const scope=JSON.stringify([row.run_id,row.clock_id,row.event_id,row.delivery]);
    const key=JSON.stringify([scope,row.stage,row.source]);
    const ns=BigInt(row.observed_mono_ns), old=arrivals.get(key);
    if(old){duplicates++; if(old.ns<=ns)continue;}
    arrivals.set(key,{scope,stage:row.stage,source:row.source,ns,delivery:row.delivery,run_id:row.run_id,clock_id:row.clock_id});
    sources.add(row.source);
  }
  for(const r of arrivals.values()) {
    const key=JSON.stringify([r.scope,r.stage]);
    if(!stages.has(key))stages.set(key,[]);
    stages.get(key).push(r);
  }
  const comparisons=new Map();
  for(const group of stages.values()) {
    const first=group.reduce((a,b)=>a.ns<b.ns?a:b);
    for(const r of group) {
      const key=JSON.stringify([r.run_id,r.clock_id,r.stage,r.delivery,r.source]);
      if(!comparisons.has(key))comparisons.set(key,{run_id:r.run_id,clock_id:r.clock_id,stage:r.stage,delivery:r.delivery,source:r.source,relative_to_first_observed_ms:[],matched_with_another_source:0,first_arrivals:0});
      const stat=comparisons.get(key);
      stat.relative_to_first_observed_ms.push(Number(r.ns-first.ns)/1e6);
      if(group.length>1)stat.matched_with_another_source++;
      if(r.ns===first.ns)stat.first_arrivals++;
    }
  }
  const pairGroups=new Map();
  for(const r of arrivals.values()) {
    if(!['block_durable','receipts_durable'].includes(r.stage))continue;
    const start=arrivals.get(JSON.stringify([r.scope,r.stage.replace('_durable',''),r.source]));
    if(!start)continue;
    const key=JSON.stringify([r.run_id,r.clock_id,r.stage,r.delivery,r.source]);
    if(!pairGroups.has(key))pairGroups.set(key,{run_id:r.run_id,clock_id:r.clock_id,stage:r.stage,delivery:r.delivery,source:r.source,values:[],negative_pairs:0});
    const group=pairGroups.get(key);
    if(r.ns<start.ns)group.negative_pairs++;
    else group.values.push(Number(r.ns-start.ns)/1e6);
  }
  // Missing observations are counted within each observed stage/run/clock universe.
  const universes=new Map();
  for(const group of stages.values()) {
    const r=group[0], key=JSON.stringify([r.run_id,r.clock_id,r.stage,r.delivery]);
    if(!universes.has(key))universes.set(key,{run_id:r.run_id,clock_id:r.clock_id,stage:r.stage,delivery:r.delivery,events:0,by_source:{}});
    const u=universes.get(key);u.events++;
    for(const x of group)u.by_source[x.source]=(u.by_source[x.source]??0)+1;
  }
  return {schema:'watchtower.latency.v1',scope:'same-object same-stage same-run same-clock relative arrival; provider-derived',
    fastest_claim_established:false,network_origin_latency_available:false,
    retained_rows:rows.length,usable_unique_arrivals:arrivals.size,excluded_rows:excluded,duplicate_rows:duplicates,
    comparisons:[...comparisons.values()].map(({relative_to_first_observed_ms,...rest})=>({...rest,relative_to_first_observed:summarize(relative_to_first_observed_ms)})),
    persistence:[...pairGroups.values()].map(({values,...rest})=>({...rest,arrival_to_commit:summarize(values)})),
    observed_universes:[...universes.values()].map(u=>({...u,by_source:Object.fromEntries([...sources].map(s=>[s,{observed:u.by_source[s]??0,missing_from_observed_union:u.events-(u.by_source[s]??0)}]))})),
    limitations:['An event absent from every source is absent from this comparison universe; reconcile against full canonical blocks.','Independent clock/run values are never subtracted.','Live, backfill and replay deliveries are reported separately.','A block timestamp does not measure sequencer-to-observer delay.']};
}
