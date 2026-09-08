import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from './collector.mjs';
import {PoolEngine} from './pools.mjs';
import {LivePoolCache} from './live_pools.mjs';
import {runService} from './runtime.mjs';
import {readJournal} from './common.mjs';
import {analyzeRace} from './race.mjs';

test('actual two-source WS/HTTP service retains live, reconciled and replayable V4 evidence',async()=>{
 const registry=JSON.parse(await readFile(new URL('../assets/pools.synthetic.json',import.meta.url))),
   blocks=JSON.parse(await readFile(new URL('../assets/blocks.synthetic.json',import.meta.url)));
 const rpcBlock=b=>({number:'0x'+b.number.toString(16),hash:b.hash,parentHash:b.parent_hash,timestamp:'0x'+b.timestamp.toString(16)});
 const peers=new Set();
 const frame=(payload,opcode=1)=>{const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
  const head=Buffer.alloc(body.length<126?2:4);head[0]=0x80|opcode;if(body.length<126)head[1]=body.length;else{head[1]=126;head.writeUInt16BE(body.length,2);}return Buffer.concat([head,body]);};
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const q=JSON.parse(text);let result;
  if(q.method==='eth_chainId')result='0x1237';
  else if(q.method==='eth_blockNumber')result='0x65';
  else if(q.method==='eth_getBlockByNumber')result=rpcBlock(blocks.find(b=>b.number===Number(BigInt(q.params[0]))));
  else if(q.method==='eth_getLogs')result=blocks.find(b=>b.number===Number(BigInt(q.params[0].fromBlock))).logs;
  else assert.fail(q.method);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 });
 server.on('upgrade',(request,socket)=>{
  peers.add(socket);socket.on('close',()=>peers.delete(socket));
  const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');let pending=Buffer.alloc(0);
  socket.on('data',chunk=>{
   pending=Buffer.concat([pending,chunk]);
   while(pending.length>=2){const opcode=pending[0]&15,masked=Boolean(pending[1]&128);let size=pending[1]&127,offset=2;
    if(size===126){if(pending.length<4)return;size=pending.readUInt16BE(2);offset=4;}assert.notEqual(size,127);
    const start=offset+(masked?4:0);if(pending.length<start+size)return;const data=Buffer.from(pending.subarray(start,start+size));
    if(masked)for(let i=0;i<size;i++)data[i]^=pending[offset+i%4];pending=pending.subarray(start+size);
    if(opcode===8){socket.end(frame(data,8));continue;}if(opcode===9){socket.write(frame(data,10));continue;}
    const q=JSON.parse(data),result=q.id===1?'0x1237':q.id===2?'heads':'logs';socket.write(frame({jsonrpc:'2.0',id:q.id,result}));
    if(q.id===3)setTimeout(()=>{if(socket.destroyed)return;for(const block of blocks){
      socket.write(frame({jsonrpc:'2.0',method:'eth_subscription',params:{subscription:'heads',result:rpcBlock(block)}}));
      for(const log of block.logs)socket.write(frame({jsonrpc:'2.0',method:'eth_subscription',params:{subscription:'logs',result:log}}));
    }},request.url==='/fast'?10:40);
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(join(tmpdir(),'pulse-service-')),out=join(dir,'events.jsonl'),port=server.address().port;
 const names=['PULSE_SERVICE_HTTP','PULSE_SERVICE_FAST_WS','PULSE_SERVICE_SLOW_WS'],before=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 process.env.PULSE_SERVICE_HTTP=`http://127.0.0.1:${port}`;process.env.PULSE_SERVICE_FAST_WS=`ws://127.0.0.1:${port}/fast`;process.env.PULSE_SERVICE_SLOW_WS=`ws://127.0.0.1:${port}/slow`;
 const cfg={chain_id:4663,sources:[{name:'fast',http_env:names[0],ws_env:names[1]},{name:'slow',http_env:names[0],ws_env:names[2]}],
   addresses:[registry.manager],from_block:100,duration_seconds:1,request_timeout_ms:500,reconnect_ms:100,max_reconnects:1};
 let readApi;
 try {
  const result=await runService(cfg,{out,registry,collectImpl:collect,engineFactory:r=>new PoolEngine(r),liveFactory:r=>new LivePoolCache(r),onReady:async info=>{
   readApi=new Promise((resolve,reject)=>setTimeout(()=>fetch(`http://127.0.0.1:${info.api.port}/v1/pools`).then(r=>r.json()).then(resolve,reject),150));
  }});
  const live=await readApi;assert.equal(live.state.pools[0].qualification,'CORE_STATE_OBSERVED');
  assert.equal(live.provisional_live_state.pools[0].qualification,'PROVISIONAL_UNRECONCILED');
  assert.equal(live.provisional_live_state.pools[0].execution_eligible,false);
  assert.equal(result.status,'STOPPED');assert.equal(result.collector.sources.length,2);
  for(const source of result.collector.sources){assert.equal(source.live_logs,2);assert.equal(source.recovered_blocks,2);}
  const observations=[];await readJournal(out,r=>observations.push(r.observation));
  assert.equal(observations.filter(r=>r.stage==='state_ready'&&r.delivery==='live').length,2);
  assert.equal(observations.filter(r=>r.stage==='state_ready'&&r.delivery==='backfill').length,2);
  assert.ok(!observations.some(r=>r.payload?.kind==='state_rejected'));
  const race=analyzeRace(observations,{sources:['fast','slow'],min_matches:2});assert.deepEqual(race.sources,['fast','slow']);assert.equal(race.invalid_rows,0);
  const recovered=[];const second=await runService(cfg,{out,registry,engineFactory:r=>new PoolEngine(r),collectImpl:async c=>{recovered.push(c.resume);return {};}});
  assert.equal(recovered[0].fast.next_block,102);assert.equal(recovered[0].slow.next_block,102);assert.notEqual(result.clock_id,second.clock_id);
 }finally{
  for(const key of names)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];
  for(const socket of peers)socket.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
 }
});
