import {Journal, context, observation, scopeFingerprint, invariant, validateConfig} from './common.mjs';
import {serve} from './api.mjs';

/** Wire adapters without a signing surface or application-specific trade decisions. */
export async function runService(input,{out,registry,signal,collectImpl,engineFactory,liveFactory,onReady=()=>{}}={}) {
  const config=validateConfig(input), ctx=context(), scope=scopeFingerprint(config,registry);
  invariant(typeof out==='string'&&out.length>0,'journal output path required');
  const journal=new Journal(out,{maxBytes:config.journal_max_bytes,maxLineBytes:Math.max(4*1024*1024,config.max_message_bytes*2)});
  const engine=registry&&engineFactory?engineFactory(registry):null;
  const live=registry&&liveFactory?liveFactory(registry):null;
  const primary=config.primary_source??config.sources[0].name;
  let priorScope, latestState=null, status='STARTING', lastComplete=null, lastStateBlock=null, stateStatus=engine?'AWAITING_RECONCILIATION':'DISABLED', api, firstSeq=1, tail=[], tailBytes=0, resume={};
  const sourceStates=Object.fromEntries(config.sources.map(s=>[s.name,{status:'UNKNOWN'}]));
  const remember=(obs,seq)=>{
    const item={seq,observation:obs},bytes=Buffer.byteLength(JSON.stringify(item));tail.push({...item,_bytes:bytes});tailBytes+=bytes;
    while(tail.length>2048||tailBytes>16*1024*1024) tailBytes-=tail.shift()._bytes;
    firstSeq=tail[0]?.seq??seq+1;
  };
  const apply=(obs)=>{
    if(obs.source!==primary) return;
    if(obs.stage==='health' && obs.payload?.kind==='block_complete') {
      lastComplete={number:obs.payload.block.number,hash:obs.payload.block.hash,observed_at:obs.observed_at};
      if(engine) {
        latestState=engine.applyBlock(obs.payload.block);
        if(['APPLIED','DUPLICATE'].includes(latestState.status)) {
          lastStateBlock=engine.snapshot().head;stateStatus='RECONCILED_PROVIDER_EVIDENCE';
        } else stateStatus='REJECTED_REQUIRES_REPLAY';
      }
    }
  };
  try {
    const recovery=await journal.start((obs,seq)=>{
      if(obs.source==='pulse'&&obs.payload?.kind==='run_start') {
        invariant(obs.payload.scope===scope,'journal configuration changed; use a separate output journal');
        priorScope=obs.payload.scope;
      }
      invariant(priorScope===scope,'journal missing matching run scope');
      apply(obs);
      if(obs.stage==='health'&&obs.payload?.kind==='checkpoint')
        resume[obs.source]={next_block:obs.payload.next_block,recent_blocks:obs.payload.recent_blocks};
      remember(obs,seq);
    });
    const start=observation(ctx,'pulse','health','run:'+ctx.run_id,
      {kind:'run_start',scope,primary_source:primary,sources:config.sources.map(s=>s.name),recovery});
    remember(start,await journal.append(start,{durable:true}));
    // Retained state cannot imply that a restarted network connection is current.
    engine?.invalidate?.('STARTUP_AWAITING_LIVE_RECONCILIATION');
    if(engine)stateStatus='AWAITING_RECONCILIATION';
    const health=()=>({schema_version:'pulse.health.v1',chain_id:4663,status,run_id:ctx.run_id,
      primary_source:primary,sources:sourceStates,last_complete_block:lastComplete,last_state_block:lastStateBlock,state_status:stateStatus,
      collection_checkpoint_scope:'retained provider block bundles; independent of derived-state acceptance',journal:{records:journal.seq,bytes:journal.bytes,max_bytes:journal.maxBytes},
      state_scope:'provisional core pool marks; execution eligibility requires consumer checks',
      last_complete_age_ms:lastComplete?Math.max(0,Date.now()-Date.parse(lastComplete.observed_at)):null});
    api=await serve({port:config.api_port,health,snapshot:()=>({schema_version:'pulse.pools.v1',health:health(),state:engine?.snapshot()??null,provisional_live_state:live?.snapshot()??null}),
      events:(after,limit)=> after<firstSeq-1?{status:'CURSOR_EXPIRED',earliest_seq:firstSeq,replay:'retained journal'}:
        {status:'OK',records:tail.filter(r=>r.seq>after).slice(0,limit).map(({_bytes,...r})=>r),latest_seq:journal.seq}});
    await onReady({api:api.address,recovery,scope});
    status='COLLECTING';
    let emitTail=Promise.resolve(), emitFailure;
    const emit=obs=>{
      const pending=emitTail.then(async()=>{
        invariant(obs.chain_id===4663&&obs.run_id===ctx.run_id&&obs.clock_id===ctx.clock_id,'collector context mismatch');
        let fastReady;
        if(live&&obs.source===primary&&obs.delivery==='live'&&['head','log'].includes(obs.stage)) {
          const update=live.applyObservation(obs);
          if(obs.stage==='log'&&update.status==='OBSERVED') {
            fastReady=observation(ctx,primary,'state_ready',obs.event_id,
              {kind:'provisional_pool_update',result:update,scope:'PROVISIONAL_UNRECONCILED'},
              {delivery:'live',block_number:obs.block_number,block_hash:obs.block_hash,transaction_hash:obs.transaction_hash,log_index:obs.log_index});
            fastReady.processing_delay_ns=(BigInt(fastReady.observed_mono_ns)-BigInt(obs.observed_mono_ns)).toString();
          }
        }
        const checkpoint=obs.stage==='health'&&obs.payload?.kind==='checkpoint';
        const seq=await journal.append(obs,{durable:checkpoint});remember(obs,seq);
        if(obs.stage==='health') {
          sourceStates[obs.source]={kind:obs.payload?.kind,observed_at:obs.observed_at,
            ...(obs.payload?.block?{block_number:obs.payload.block.number}:{}),
            ...(checkpoint?{next_block:obs.payload.next_block}:{})};
          if(obs.source===primary&&['source_disconnected','source_failed_closed','source_stopped','gap_detected','reorg_detected',
            'live_reorg_hint','removed_log_hint','recovery_retry','rpc_lag_detected'].includes(obs.payload?.kind)) {
            engine?.invalidate?.(obs.payload.kind);live?.invalidate?.(obs.payload.kind);
            if(engine)stateStatus='INVALIDATED';
          }
        }
        if(fastReady) remember(fastReady,await journal.append(fastReady));
        apply(obs);
        if(obs.source===primary && obs.stage==='health'&&obs.payload?.kind==='block_complete'&&engine) {
          const b=obs.payload.block;
          const valid=['APPLIED','DUPLICATE'].includes(latestState.status);
          const ready=observation(ctx,primary,valid?'state_ready':'health','block:'+b.hash,
            {kind:valid?'pool_state_update':'state_rejected',result:latestState,scope:'core_marks',chain_id:4663},
            {delivery:obs.delivery,block_number:b.number,block_hash:b.hash});
          remember(ready,await journal.append(ready));
        }
      });
      emitTail=pending.catch(error=>{emitFailure??=error;});
      return pending;
    };
    let result;
    try {result=await collectImpl({...config,...ctx,resume},{emit,signal});}
    finally {await emitTail;}
    if(emitFailure) throw emitFailure;
    status=result?.fatal?'FAILED':result?.any_source_failed?'DEGRADED':'STOPPED';
    engine?.invalidate?.('COLLECTION_STOPPED');
    live?.invalidate?.('COLLECTION_STOPPED');
    const final=health();
    const stopped=observation(ctx,'pulse','health','stop:'+ctx.run_id,{kind:'run_stop',result});
    remember(stopped,await journal.append(stopped,{durable:true}));
    return {schema_version:'pulse.run.v1',...ctx,status,collector:result,health:final};
  } catch(error) {status='FAILED';engine?.invalidate?.('COLLECTION_FAILED');live?.invalidate?.('COLLECTION_FAILED');throw error;}
  finally {if(api) await api.close();await journal.close();}
}
