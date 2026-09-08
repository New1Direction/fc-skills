import { createHash, randomUUID } from 'node:crypto';

/**
 * Durable research coordination; Node 24 built-ins, same store.db as capture.
 * Policy: {version, max_queue=2048, max_attempts=3, lease_ms=30000,
 * timeout_ms=10000, max_result_bytes=4194304, rules=[]}.
 * Each rule: {id, skill, target:{chain_id:4663, token_address? OR
 * contract_address?, pool_id?}, match:{transaction_to? OR log_address+topic0,
 * topic1?}}. A pool target requires its exact topic1 match. A token target
 * must equal log_address; a contract target must equal the matched address.
 * Version identifies immutable normalized policy contents. New versions replay
 * retained events with separate idempotent task identities and durable cursors.
 * Injected handlers.research(job,{signal,evidence,dispatch}) must honor abort and
 * return JSON; it cannot write an execution result or authorize a trade. The
 * returned object is retained only as consumer_extension on the built-in intent.
 */
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const SKILLS = new Set(['pressure','ignition','hook-lab','autopsy','undertow','exit-doctor','scout-network','second-wind','lp-edge','meme-scout']);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const initialized=new WeakSet();
const integer = (n,low,high,name) => { if(!Number.isSafeInteger(n)||n<low||n>high)throw new Error(`invalid ${name}`);return n; };
const object = (x,name) => {if(!x||typeof x!=='object'||Array.isArray(x))throw new Error(`invalid ${name}`);return x;};
const keys = (x,allowed,name) => {for(const k of Object.keys(x))if(!allowed.includes(k))throw new Error(`unknown ${name} field`);};
const lower = (s,re,name) => {if(typeof s!=='string'||!re.test(s.toLowerCase()))throw new Error(`invalid ${name}`);return s.toLowerCase();};
const stable = x => Array.isArray(x)?`[${x.map(stable).join(',')}]`:x&&typeof x==='object'?`{${Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')}}`:JSON.stringify(x);
const hash = x => createHash('sha256').update(stable(x)).digest('hex');
const time = now => integer(typeof now==='function'?now():now??Date.now(),0,Number.MAX_SAFE_INTEGER,'time');

export function normalizePolicy(input={version:'v1'}) {
  object(input,'policy');keys(input,['version','max_queue','max_attempts','lease_ms','timeout_ms','max_result_bytes','rules'],'policy');
  if(typeof input.version!=='string'||!/^[-a-zA-Z0-9_.]{1,80}$/.test(input.version))throw new Error('invalid policy version');
  const p={version:input.version,max_queue:integer(input.max_queue??2048,1,100000,'max_queue'),
    max_attempts:integer(input.max_attempts??3,1,10,'max_attempts'),lease_ms:integer(input.lease_ms??30000,2,3600000,'lease_ms'),
    timeout_ms:integer(input.timeout_ms??10000,1,60000,'timeout_ms'),max_result_bytes:integer(input.max_result_bytes??4194304,1024,67108864,'max_result_bytes'),rules:[]};
  if(p.lease_ms<=p.timeout_ms)throw new Error('lease_ms must exceed timeout_ms');
  if(!Array.isArray(input.rules??[])||(input.rules??[]).length>256)throw new Error('invalid rules');
  const ids=new Set();
  for(const raw of input.rules??[]) {
    object(raw,'rule');keys(raw,['id','skill','target','match'],'rule');
    if(typeof raw.id!=='string'||!/^[-a-zA-Z0-9_.]{1,80}$/.test(raw.id)||ids.has(raw.id))throw new Error('invalid or duplicate rule id');
    ids.add(raw.id);if(!SKILLS.has(raw.skill))throw new Error('unsupported skill hint');
    const t=object(raw.target,'target'),m=object(raw.match,'match');
    keys(t,['chain_id','token_address','contract_address','pool_id'],'target');
    keys(m,['transaction_to','log_address','topic0','topic1'],'match');
    if(t.chain_id!==4663)throw new Error('target chain must be 4663');
    if(Boolean(t.token_address)===Boolean(t.contract_address))throw new Error('exact token or contract target required');
    const target={chain_id:4663},match={};
    if(t.token_address)target.token_address=lower(t.token_address,HEX_ADDRESS,'token_address');
    if(t.contract_address)target.contract_address=lower(t.contract_address,HEX_ADDRESS,'contract_address');
    if(t.pool_id)target.pool_id=lower(t.pool_id,HEX_HASH,'pool_id');
    if(m.transaction_to) {
      if(m.log_address||m.topic0||m.topic1||target.token_address||target.pool_id)throw new Error('transaction match requires only contract target');
      match.transaction_to=lower(m.transaction_to,HEX_ADDRESS,'transaction_to');
    } else {
      match.log_address=lower(m.log_address,HEX_ADDRESS,'log_address');
      match.topic0=lower(m.topic0,HEX_HASH,'topic0');
      if(m.topic1)match.topic1=lower(m.topic1,HEX_HASH,'topic1');
    }
    if((target.token_address??target.contract_address)!==(match.log_address??match.transaction_to))throw new Error('target does not match evidence address');
    if(target.pool_id&&target.pool_id!==match.topic1)throw new Error('pool target needs matching topic1');
    p.rules.push({id:raw.id,skill:raw.skill,target,match});
  }
  p.rules.sort((a,b)=>a.id.localeCompare(b.id));return p;
}

function init(store) {
  if(!store?.db||typeof store.mutate!=='function')throw new Error('workers require store.db and store.mutate');
  if(initialized.has(store))return;
  store.mutate(()=>store.db.exec(`
    CREATE TABLE IF NOT EXISTS wt_policies(version TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,policy_json TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS wt_jobs(id TEXT PRIMARY KEY,policy_version TEXT NOT NULL,kind TEXT NOT NULL,block_hash TEXT NOT NULL,block_number INTEGER NOT NULL,
      payload_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,timeout_ms INTEGER NOT NULL,lease_ms INTEGER NOT NULL,
      max_result_bytes INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,result_json TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS wt_jobs_pending ON wt_jobs(status,created_at,id);
    CREATE INDEX IF NOT EXISTS wt_jobs_block ON wt_jobs(block_hash,status);
    CREATE INDEX IF NOT EXISTS wt_worker_branch_lookup ON wt_blocks(canonical,hash);
    CREATE INDEX IF NOT EXISTS wt_worker_event_lookup ON wt_events(block_hash,kind,seq);
    CREATE INDEX IF NOT EXISTS wt_worker_invalidation_lookup ON wt_events(kind,seq);
    CREATE TABLE IF NOT EXISTS wt_worker_control(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    INSERT OR IGNORE INTO wt_worker_control(key,value) VALUES('invalidation_cursor',0);
    CREATE TABLE IF NOT EXISTS wt_classifications(block_hash TEXT NOT NULL,transaction_hash TEXT NOT NULL,transaction_index INTEGER NOT NULL,
      receipt_present INTEGER NOT NULL,canonical INTEGER NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(block_hash,transaction_hash));
    CREATE TABLE IF NOT EXISTS wt_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL UNIQUE,block_hash TEXT NOT NULL,
      canonical INTEGER NOT NULL,kind TEXT NOT NULL,body_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS wt_outbox_block ON wt_outbox(block_hash,canonical);
  `));
  initialized.add(store);
}

function invalidateOrphans(store,now=Date.now()) {
  // Independent durable cursor consumes only new invalidation events. This is
  // indexed and bounded even when ordinary capture history contains millions
  // of blocks. Current-branch checks still apply at claim, completion and read.
  const cursor=store.db.prepare("SELECT value FROM wt_worker_control WHERE key='invalidation_cursor'").get().value;
  const events=store.db.prepare("SELECT seq,payload FROM wt_events WHERE kind='invalidate' AND seq>? ORDER BY seq LIMIT 128").all(cursor);
  for(const event of events)store.mutate(()=>{
    const payload=JSON.parse(event.payload);
    for(const h of payload.hashes) {
      // Append retractions so a consumer that already advanced its outbox cursor
      // learns that previously published evidence has lost canonical status.
      const published=store.db.prepare(`SELECT o.job_id FROM wt_outbox o JOIN wt_jobs j ON j.id=o.job_id WHERE o.block_hash=? AND o.canonical=1
        AND json_extract(j.payload_json,'$.canonical_generation')<?`).all(h,event.seq);
      for(const row of published){store.db.prepare('INSERT OR IGNORE INTO wt_outbox(job_id,block_hash,canonical,kind,body_json,created_at) VALUES(?,?,0,?,?,?)')
        .run('invalidate:'+row.job_id,h,'evidence_invalidated',JSON.stringify({schema_version:'watchtower.evidence-invalidation.v1',invalidated_job_id:row.job_id,block_hash:h,reason:'ORPHANED_BLOCK'}),now);
        store.db.prepare('UPDATE wt_outbox SET canonical=0 WHERE job_id=?').run(row.job_id);
      }
      store.db.prepare(`UPDATE wt_jobs SET status='INVALIDATED',lease_until=NULL,lease_token=NULL,error_code='ORPHANED_BLOCK',updated_at=?
        WHERE block_hash=? AND status!='INVALIDATED' AND json_extract(payload_json,'$.canonical_generation')<?`).run(now,h,event.seq);
      if(!store.isCanonical(h))store.db.prepare('UPDATE wt_classifications SET canonical=0 WHERE block_hash=?').run(h);
    }
    store.db.prepare("UPDATE wt_worker_control SET value=? WHERE key='invalidation_cursor'").run(event.seq);
  });
  return events.length;
}

function matches(rule,block,receipts) {
  if(rule.match.transaction_to)return block.transactions.filter(tx=>tx.to?.toLowerCase()===rule.match.transaction_to).map(tx=>({transaction_hash:tx.hash.toLowerCase(),transaction_index:Number(BigInt(tx.transactionIndex)),evidence_kind:'top_level_call',receipt_status:'UNKNOWN'}));
  if(!receipts)return [];
  const found=[];
  for(const receipt of receipts)for(const log of receipt.logs??[])if(log.address.toLowerCase()===rule.match.log_address&&log.topics?.[0]?.toLowerCase()===rule.match.topic0&&(!rule.match.topic1||log.topics?.[1]?.toLowerCase()===rule.match.topic1))
    found.push({transaction_hash:receipt.transactionHash.toLowerCase(),transaction_index:Number(BigInt(receipt.transactionIndex)),log_index:Number(BigInt(log.logIndex)),evidence_kind:'receipt_log',receipt_status:receipt.status==='0x0'?'REVERTED':'SUCCESS',address:log.address.toLowerCase(),topics:log.topics,data:log.data});
  return found;
}

/** Consume ordered durable events atomically; capacity exhaustion pauses cursor. */
export function routeEvents(store,{policy={version:'v1'},limit=100}={}) {
  init(store);integer(limit,1,10000,'limit');const p=normalizePolicy(policy),fingerprint=hash(p),now=Date.now();
  invalidateOrphans(store,now);
  let saved=store.db.prepare('SELECT * FROM wt_policies WHERE version=?').get(p.version);
  if(saved&&saved.fingerprint!==fingerprint)throw new Error('policy version reused with different contents');
  if(!saved){store.mutate(()=>store.db.prepare('INSERT INTO wt_policies(version,fingerprint,policy_json) VALUES(?,?,?)').run(p.version,fingerprint,JSON.stringify(p)));saved={cursor:0};}
  let cursor=saved.cursor,processed=0,enqueued=0,paused=false,reason=null;
  for(const event of store.readEvents(cursor,limit)) {
    const jobs=[];
    if(['block','receipts'].includes(event.kind)&&store.isCanonical(event.block_hash)) {
      const generation=store.db.prepare("SELECT max(seq) AS seq FROM wt_events WHERE block_hash=? AND kind='block'").get(event.block_hash).seq;
      // Prior occurrences of a block that was orphaned and later restored must
      // not manufacture repeated current signals when a new policy replays it.
      if(event.seq<generation) {
        store.mutate(()=>store.db.prepare('UPDATE wt_policies SET cursor=? WHERE version=?').run(event.seq,p.version));
        cursor=event.seq;processed++;continue;
      }
      const raw=event.kind==='block'?event.payload:findBlock(store,event.block_hash,event.payload);
      if(!raw)throw new Error('event references unavailable full block');
      const number=Number(BigInt(raw.number)),kind=event.kind==='block'?'classify_block':'classify_receipts';
      jobs.push({kind,block_hash:event.block_hash,block_number:number,generation,payload:{stage:event.kind,canonical_generation:generation}});
      const receiptEvent=store.db.prepare("SELECT max(seq) AS seq FROM wt_events WHERE block_hash=? AND kind='receipts'").get(event.block_hash).seq;
      const receipts=event.kind==='receipts'?event.payload.receipts:receiptEvent!==null&&receiptEvent<generation?store.receipts(event.block_hash):null;
      for(const rule of p.rules) {
        if(rule.match.transaction_to&&event.kind!=='block'||!rule.match.transaction_to&&!receipts)continue;
        if(matches(rule,raw,receipts).length)jobs.push({kind:'research',block_hash:event.block_hash,block_number:number,generation,payload:{stage:rule.match.transaction_to?'block':'receipts',canonical_generation:generation,rule}});
      }
    }
    const pending=store.db.prepare("SELECT count(*) AS n FROM wt_jobs WHERE status IN ('QUEUED','RUNNING')").get().n;
    const fresh=jobs.map(j=>({...j,id:hash({policy_version:p.version,kind:j.kind,block_hash:j.block_hash,canonical_generation:j.generation,rule_id:j.payload.rule?.id??null})})).filter(j=>!store.db.prepare('SELECT id FROM wt_jobs WHERE id=?').get(j.id));
    if(pending+fresh.length>p.max_queue){paused=true;reason='QUEUE_CAPACITY';break;}
    store.mutate(()=>{
      for(const j of fresh)store.db.prepare(`INSERT INTO wt_jobs(id,policy_version,kind,block_hash,block_number,payload_json,status,max_attempts,timeout_ms,lease_ms,max_result_bytes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?)`).run(j.id,p.version,j.kind,j.block_hash,j.block_number,JSON.stringify(j.payload),p.max_attempts,p.timeout_ms,p.lease_ms,p.max_result_bytes,now,now);
      store.db.prepare('UPDATE wt_policies SET cursor=? WHERE version=?').run(event.seq,p.version);
    });
    cursor=event.seq;processed++;enqueued+=fresh.length;
  }
  return {schema_version:'watchtower.routing.v1',policy_version:p.version,cursor,processed_events:processed,enqueued_jobs:enqueued,paused,reason,coverage:store.progress?.()??store.coverage()};
}

function findBlock(store,blockHash,payload={}) {
  if(typeof store.blockByHash==='function')return store.blockByHash(blockHash);
  const number=payload.block_number??payload.blockNumber??payload.receipts?.[0]?.blockNumber??store.transactions(blockHash)?.[0]?.blockNumber;
  if(number!==undefined){const b=store.block(Number(BigInt(number)));if(b?.hash?.toLowerCase()===blockHash)return b;}
  // Empty blocks have no tx/receipt-derived number. Coverage bounds are not
  // scanned: preserve an explicit unresolved task rather than doing unbounded I/O.
  return null;
}

export function requeueExpired(store,{now=Date.now}={}) {
  init(store);const current=time(now);invalidateOrphans(store,current);
  let requeued=0,failed=0;
  store.mutate(()=>{
    const expired=store.db.prepare("SELECT * FROM wt_jobs WHERE status='RUNNING' AND lease_until<=?").all(current);
    for(const j of expired){const terminal=j.attempts>=j.max_attempts;
      store.db.prepare("UPDATE wt_jobs SET status=?,lease_until=NULL,lease_token=NULL,error_code='LEASE_EXPIRED',updated_at=? WHERE id=?").run(terminal?'FAILED':'QUEUED',current,j.id);
      terminal?failed++:requeued++;
    }
  });return {requeued,failed};
}

function classify(block,receipts) {
  const byHash=new Map((receipts??[]).map(r=>[r.transactionHash.toLowerCase(),r]));
  return block.transactions.map((tx,index)=>{
    const receipt=byHash.get(tx.hash.toLowerCase()),rawType=tx.type??null;let numericType;
    try{numericType=BigInt(rawType);}catch{numericType=-1n;}
    const input=tx.input??tx.data??null;
    return {schema_version:'watchtower.transaction-classification.v1',chain_id:4663,block_hash:block.hash.toLowerCase(),block_number:Number(BigInt(block.number)),
      transaction_hash:tx.hash.toLowerCase(),transaction_index:index,raw_type:rawType,type_status:numericType>=0n&&numericType<=4n?'KNOWN_ENVELOPE_TYPE':'UNKNOWN_ENVELOPE_TYPE',
      top_level_kind:tx.to===null?'CONTRACT_CREATION':input===null?'UNKNOWN_CALL_DATA':input==='0x'?'VALUE_OR_EMPTY_CALL':'CONTRACT_CALL',has_native_value:tx.value===undefined?null:BigInt(tx.value)>0n,
      value_raw:tx.value??null,from:tx.from,to:tx.to,raw_input:input,receipt_present:Boolean(receipt),
      execution_status:receipt?(BigInt(receipt.status)===0n?'REVERTED':'SUCCESS'):'UNKNOWN',created_contract:receipt?.contractAddress??null,
      logs:(receipt?.logs??[]).map(log=>({address:log.address,topics:log.topics,data:log.data,log_index:Number(BigInt(log.logIndex)),
        topic_class:log.topics?.[0]?.toLowerCase()===TRANSFER?'TRANSFER_SIGNATURE':log.topics?.[0]?.toLowerCase()===APPROVAL?'APPROVAL_SIGNATURE':'UNKNOWN_TOPIC'})),
      coverage:{included_top_level_transaction:true,internal_calls:'NOT_COLLECTED',protocol_semantics:'NOT_ESTABLISHED',provider_derived:true}};
  });
}

function evidenceFor(store,job) {
  const block=store.block(job.block_number);
  const generation=store.db.prepare("SELECT max(seq) AS seq FROM wt_events WHERE block_hash=? AND kind='block'").get(job.block_hash).seq;
  if(!block||block.hash.toLowerCase()!==job.block_hash||generation!==job.payload.canonical_generation)throw new Error('ORPHANED_BLOCK');
  const receipts=typeof store.receipts==='function'?store.receipts(job.block_hash):null;
  if(job.kind==='classify_receipts'&&!receipts)throw new Error('RECEIPTS_UNAVAILABLE');
  return {block,receipts};
}

function intent(store,job,evidence) {
  const rule=job.payload.rule,matched=matches(rule,evidence.block,job.payload.stage==='receipts'?evidence.receipts:null);
  if(!matched.length)throw new Error('MATCH_EVIDENCE_UNAVAILABLE');
  return {schema_version:'watchtower.research-dispatch.v1',dispatch_state:'PENDING_CONSUMER_REVIEW',job_id:job.id,policy_version:job.policy_version,
    skill_hint:rule.skill,rule_id:rule.id,target:rule.target,block:{number:job.block_number,hash:job.block_hash},matches:matched,
    evidence_scope:job.payload.stage==='receipts'?'RPC_RECEIPTS_FOR_EXACT_BLOCK':'RPC_INCLUDED_TOP_LEVEL_TRANSACTIONS',
    coverage_at_dispatch:store.progress?.()??store.coverage(),limitations:['Dispatch intent only; no skill analysis has been executed.','No internal-call trace coverage.','No route qualification, executable quote, trading instruction or profitability claim.']};
}

/** Runs bounded leased jobs. Classification is built-in; research handlers are optional. */
export async function runJobs(store,{limit=10,now=Date.now,handlers={}}={}) {
  init(store);integer(limit,1,10000,'limit');object(handlers,'handlers');keys(handlers,['research'],'handlers');
  if(handlers.research!==undefined&&typeof handlers.research!=='function')throw new Error('invalid research handler');
  requeueExpired(store,{now});const summary={schema_version:'watchtower.jobs-run.v1',attempted:0,completed:0,retried:0,failed:0,invalidated:0};
  for(let i=0;i<limit;i++) {
    const current=time(now);invalidateOrphans(store,current);let job;
    store.mutate(()=>{
      const row=store.db.prepare("SELECT * FROM wt_jobs WHERE status='QUEUED' ORDER BY created_at,id LIMIT 1").get();
      if(!row)return;const token=randomUUID();
      store.db.prepare("UPDATE wt_jobs SET status='RUNNING',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=? AND status='QUEUED'").run(current+row.lease_ms,token,current,row.id);
      job={...row,payload:JSON.parse(row.payload_json),attempts:row.attempts+1,lease_token:token};
    });
    if(!job)break;summary.attempted++;let result,errorCode;
    const controller=new AbortController();let timer;
    try {
      const evidence=evidenceFor(store,job);
      if(job.kind==='research') {
        result=intent(store,job,evidence);
        if(handlers.research) {
          const dispatch=structuredClone(result);
          const handlerPromise=Promise.resolve().then(()=>handlers.research(structuredClone(job),{signal:controller.signal,evidence:structuredClone(evidence),dispatch}));
          const extension=await Promise.race([handlerPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('HANDLER_TIMEOUT'));},job.timeout_ms);})]);
          if(extension!==undefined)result.consumer_extension=extension;
        }
      } else result={schema_version:'watchtower.classification-batch.v1',block_hash:job.block_hash,transactions:classify(evidence.block,evidence.receipts)};
      const encoded=JSON.stringify(result);
      if(!encoded||Buffer.byteLength(encoded)>job.max_result_bytes)throw new Error('RESULT_BYTE_LIMIT');
      // JSON round-trip prevents hidden non-JSON values in durable machine output.
      result=JSON.parse(encoded);
    } catch(error) {errorCode=['ORPHANED_BLOCK','RECEIPTS_UNAVAILABLE','MATCH_EVIDENCE_UNAVAILABLE','HANDLER_TIMEOUT','RESULT_BYTE_LIMIT'].includes(error?.message)?error.message:'HANDLER_FAILED';}
    finally {if(timer)clearTimeout(timer);controller.abort();}
    const finished=time(now);
    store.mutate(()=>{
      const live=store.db.prepare('SELECT * FROM wt_jobs WHERE id=?').get(job.id);
      if(live.status!=='RUNNING'||live.lease_token!==job.lease_token){summary.invalidated++;return;}
      const generation=store.db.prepare("SELECT max(seq) AS seq FROM wt_events WHERE block_hash=? AND kind='block'").get(job.block_hash).seq;
      if(!store.isCanonical(job.block_hash)||generation!==job.payload.canonical_generation) {
        store.db.prepare("UPDATE wt_jobs SET status='INVALIDATED',lease_token=NULL,lease_until=NULL,error_code='ORPHANED_BLOCK',updated_at=? WHERE id=?").run(finished,job.id);summary.invalidated++;return;
      }
      if(finished>=live.lease_until)errorCode='LEASE_EXPIRED';
      if(errorCode) {
        const terminal=job.attempts>=job.max_attempts;
        store.db.prepare('UPDATE wt_jobs SET status=?,error_code=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(terminal?'FAILED':'QUEUED',errorCode,finished,job.id);
        terminal?summary.failed++:summary.retried++;return;
      }
      if(job.kind!=='research')for(const row of result.transactions)store.db.prepare(`INSERT INTO wt_classifications(block_hash,transaction_hash,transaction_index,receipt_present,canonical,body_json)
        VALUES(?,?,?,?,1,?) ON CONFLICT(block_hash,transaction_hash) DO UPDATE SET receipt_present=excluded.receipt_present,canonical=1,body_json=excluded.body_json
        WHERE excluded.receipt_present>=wt_classifications.receipt_present`).run(job.block_hash,row.transaction_hash,row.transaction_index,row.receipt_present?1:0,JSON.stringify(row));
      store.db.prepare('INSERT OR IGNORE INTO wt_outbox(job_id,block_hash,canonical,kind,body_json,created_at) VALUES(?,?,1,?,?,?)').run(job.id,job.block_hash,job.kind==='research'?'research_dispatch':'classification_complete',JSON.stringify(job.kind==='research'?result:{schema_version:'watchtower.classification-summary.v1',block_hash:job.block_hash,transaction_count:result.transactions.length,receipt_count:result.transactions.filter(r=>r.receipt_present).length,internal_calls:'NOT_COLLECTED'}),finished);
      store.db.prepare("UPDATE wt_jobs SET status='COMPLETED',result_json=?,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(JSON.stringify(job.kind==='research'?result:{transaction_count:result.transactions.length}),finished,job.id);
      summary.completed++;
    });
  }
  return summary;
}

export function workerStatus(store) {
  init(store);invalidateOrphans(store);
  const jobs=Object.fromEntries(store.db.prepare('SELECT status,count(*) AS n FROM wt_jobs GROUP BY status').all().map(r=>[r.status,r.n]));
  return {schema_version:'watchtower.workers-status.v1',jobs,pending_jobs:jobs.QUEUED??0,leased_jobs:jobs.RUNNING??0,failed_jobs:jobs.FAILED??0,
    policies:store.db.prepare('SELECT version,cursor,fingerprint FROM wt_policies ORDER BY version').all(),
    classifications:store.db.prepare('SELECT count(*) AS total,coalesce(sum(CASE WHEN c.canonical=1 AND b.canonical=1 THEN 1 ELSE 0 END),0) AS canonical,coalesce(sum(CASE WHEN c.canonical=1 AND b.canonical=1 AND receipt_present=1 THEN 1 ELSE 0 END),0) AS with_receipts FROM wt_classifications c JOIN wt_blocks b ON b.hash=c.block_hash').get(),
    outbox:store.db.prepare('SELECT count(*) AS total,coalesce(sum(CASE WHEN o.canonical=1 AND b.canonical=1 THEN 1 ELSE 0 END),0) AS canonical FROM wt_outbox o JOIN wt_blocks b ON b.hash=o.block_hash').get(),coverage:store.coverage()};
}

export function readOutbox(store,{after=0,limit=100,includeInvalidated=false}={}) {
  init(store);integer(after,0,Number.MAX_SAFE_INTEGER,'after');integer(limit,1,10000,'limit');invalidateOrphans(store);
  return store.db.prepare(`SELECT o.*,b.canonical AS branch_canonical FROM wt_outbox o JOIN wt_blocks b ON b.hash=o.block_hash LEFT JOIN wt_jobs j ON j.id=o.job_id WHERE seq>? ${includeInvalidated?'':"AND ((o.canonical=1 AND b.canonical=1 AND json_extract(j.payload_json,'$.canonical_generation')=(SELECT max(seq) FROM wt_events WHERE block_hash=o.block_hash AND kind='block')) OR o.kind='evidence_invalidated')"} ORDER BY seq LIMIT ?`).all(after,limit).map(r=>({...r,canonical:Boolean(r.canonical&&r.branch_canonical),branch_canonical:undefined,body:JSON.parse(r.body_json),body_json:undefined}));
}

export function readClassifications(store,{blockHash,includeInvalidated=false}={}) {
  init(store);const h=lower(blockHash,HEX_HASH,'blockHash');invalidateOrphans(store);
  return store.db.prepare(`SELECT c.body_json FROM wt_classifications c JOIN wt_blocks b ON b.hash=c.block_hash WHERE block_hash=? ${includeInvalidated?'':'AND c.canonical=1 AND b.canonical=1'} ORDER BY transaction_index`).all(h).map(r=>JSON.parse(r.body_json));
}
