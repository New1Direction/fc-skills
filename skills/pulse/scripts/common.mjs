import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, stat, unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {dirname, resolve} from 'node:path';

export const CHAIN_ID = 4663;
export function invariant(ok, message) { if (!ok) throw new Error(message); }
export function boundedInteger(value, min, max, label) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, `invalid ${label}`);
  return value;
}
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
export function context() { return {run_id:randomUUID(), clock_id:randomUUID()}; }
export function observation(ctx, source, stage, event_id, payload, extra={}) {
  return {schema_version:'pulse.observation.v1', chain_id:CHAIN_ID, run_id:ctx.run_id, clock_id:ctx.clock_id, source, stage, event_id,
    observed_mono_ns:process.hrtime.bigint().toString(), observed_at:new Date().toISOString(), delivery:'live', payload, ...extra};
}

/** Stream retained JSONL, preserving the offset of the last complete record. */
export async function readJournal(path, onRecord, {maxLineBytes=4*1024*1024, allowTornTail=false}={}) {
  let pending=Buffer.alloc(0), offset=0, count=0;
  for await (const chunk of createReadStream(path)) {
    pending=Buffer.concat([pending,chunk]);
    let end;
    while ((end=pending.indexOf(10)) !== -1) {
      invariant(end <= maxLineBytes, 'journal line exceeds limit');
      const line=pending.subarray(0,end);
      invariant(line.length>0,'empty journal record');
      let record;
      try { record=JSON.parse(line.toString('utf8')); } catch { throw new Error('corrupt complete journal record'); }
      await onRecord(record,++count);
      offset+=end+1; pending=pending.subarray(end+1);
    }
    invariant(pending.length <= maxLineBytes,'journal line exceeds limit');
  }
  invariant(allowTornTail || pending.length===0,'incomplete final journal record');
  return {bytes:offset,count,torn_bytes:pending.length};
}

/** Single writer, bounded disk spool. Await append before publishing a checkpoint. */
export class Journal {
  constructor(path,{maxBytes=256*1024*1024,maxLineBytes=4*1024*1024}={}) {
    this.path=resolve(path); this.lockPath=this.path+'.lock'; this.maxBytes=maxBytes; this.maxLineBytes=maxLineBytes;
    boundedInteger(maxBytes,1024,1024**4,'journal byte limit');
    this.bytes=0; this.seq=0; this.tail=Promise.resolve(); this.failed=false;
  }
  async start(onRecord=()=>{}) {
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});
    this.lock=await open(this.lockPath,'wx',0o600);
    try {
      await this.lock.writeFile(JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));
      this.file=await open(this.path,'a+',0o600);
      const size=(await this.file.stat()).size;
      invariant(size<=this.maxBytes,'existing journal exceeds byte limit');
      const result=await readJournal(this.path,async(record,seq)=>{
        invariant(record?.schema_version==='pulse.journal.v1' && record.seq===seq,'journal sequence/schema mismatch');
        await onRecord(record.observation,seq);
      },{maxLineBytes:this.maxLineBytes,allowTornTail:true});
      if(result.torn_bytes) await this.file.truncate(result.bytes);
      this.bytes=result.bytes; this.seq=result.count;
      return {recovered_records:this.seq,truncated_tail_bytes:result.torn_bytes};
    } catch(error) { await this.close(); throw error; }
  }
  append(obs,{durable=false}={}) {
    const task=this.tail.then(async()=>{
      invariant(this.file && !this.failed,'journal unavailable');
      const seq=this.seq+1;
      const line=Buffer.from(JSON.stringify({schema_version:'pulse.journal.v1',seq,observation:obs})+'\n');
      invariant(line.length<=this.maxLineBytes,'journal record exceeds limit');
      invariant(this.bytes+line.length<=this.maxBytes,'journal full; rotate retained spool before restart');
      await this.file.writeFile(line);
      if(durable) await this.file.datasync();
      this.bytes+=line.length; this.seq=seq; return seq;
    });
    this.tail=task.catch(()=>{this.failed=true;});
    return task;
  }
  async close() {
    await this.tail;
    if(this.file) {await this.file.datasync();await this.file.close();this.file=null;}
    if(this.lock) {await this.lock.close();this.lock=null;await unlink(this.lockPath);}
  }
}

export function validateConfig(input) {
  invariant(input && input.chain_id===CHAIN_ID,'PULSE requires chain 4663');
  invariant(Array.isArray(input.sources)&&input.sources.length>0&&input.sources.length<=8,'configure 1–8 sources');
  const names=new Set();
  for(const source of input.sources) {
    invariant(/^[a-zA-Z0-9_-]{1,48}$/.test(source.name) && !names.has(source.name),'invalid or duplicate source name');
    names.add(source.name);
    for(const key of ['http_env','ws_env','feed_env']) if(source[key]!==undefined)
      invariant(/^[A-Z][A-Z0-9_]{0,127}$/.test(source[key]),'endpoint must name an environment variable');
    invariant(source.http_env&&source.ws_env,'each source requires HTTP and WS environment names');
    invariant(Object.keys(source).every(k=>['name','http_env','ws_env','feed_env'].includes(k)),'unknown source option');
  }
  invariant(Array.isArray(input.addresses)&&input.addresses.length>0&&input.addresses.length<=64,'configure explicit log addresses');
  invariant(input.addresses.every(a=>/^0x[0-9a-fA-F]{40}$/.test(a)),'invalid log address');
  const c={max_backfill_blocks:200,reorg_depth:32,request_timeout_ms:10000,reconnect_ms:1000,max_reconnects:10,
    queue_limit:1000,max_message_bytes:2097152,duration_seconds:60,journal_max_bytes:268435456,api_port:0,...input};
  for(const [key,min,max] of [['max_backfill_blocks',1,10000],['reorg_depth',1,256],['request_timeout_ms',100,60000],
    ['reconnect_ms',10,60000],['max_reconnects',0,100],['queue_limit',1,100000],['max_message_bytes',1024,16777216],
    ['duration_seconds',0,86400],['journal_max_bytes',1024,1024**4],['api_port',0,65535]]) boundedInteger(c[key],min,max,key);
  if(c.from_block!==undefined) boundedInteger(c.from_block,0,Number.MAX_SAFE_INTEGER,'from_block');
  if(c.primary_source!==undefined) invariant(names.has(c.primary_source),'unknown primary source');
  return c;
}

export function scopeFingerprint(config,registry) {
  return digest({chain_id:config.chain_id,sources:config.sources,addresses:config.addresses.map(a=>a.toLowerCase()).sort(),
    primary_source:config.primary_source??config.sources[0].name,registry:registry??null});
}
