import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRpc} from './rpc.mjs';
const fake=fn=>async(_url,opts)=>new Response(JSON.stringify(fn(JSON.parse(opts.body))));
test('read transport preserves exact params and ids',async()=>{
 const p=[{to:'0x1234'},{blockHash:'0x4567',requireCanonical:true}];
 const rpc=makeRpc('https://rpc.example/key',{fetchImpl:fake(r=>{assert.deepEqual(r.params,p);return{jsonrpc:'2.0',id:r.id,result:'0x01'};})});
 assert.equal(await rpc('eth_call',p),'0x01');
});
test('writes are rejected before network activity',async()=>{
 const rpc=makeRpc('http://localhost',{fetchImpl:()=>{throw Error('called');}});
 for(const m of ['eth_sendTransaction','eth_sendRawTransaction','anvil_impersonateAccount','anvil_setBalance','personal_sign'])await assert.rejects(rpc(m,[]),/allowlist/);
});
test('credentials and provider prose do not leak on errors',async()=>{
 const rpc=makeRpc('https://rpc.example/SECRET',{fetchImpl:fake(r=>({jsonrpc:'2.0',id:r.id,error:{code:3,message:'https://rpc.example/SECRET',data:'0xdeadbeef'}}))});
 await assert.rejects(rpc('eth_call',[]),e=>e.message==='RPC error 3'&&e.data==='0xdeadbeef');
});
test('oversized responses and invalid envelopes are rejected',async()=>{
 await assert.rejects(makeRpc('https://rpc.example',{maxBytes:20,fetchImpl:fake(r=>({jsonrpc:'2.0',id:r.id,result:'x'.repeat(100)}))})('eth_chainId'),/byte limit/);
 await assert.rejects(makeRpc('https://rpc.example',{fetchImpl:fake(()=>({jsonrpc:'2.0',id:999,result:'0x1237'}))})('eth_chainId'),/envelope/);
});
test('redirects and URL credentials are disallowed',async()=>{
 assert.throws(()=>makeRpc('https://user:password@rpc.example'),/Unsupported/);
 await assert.rejects(makeRpc('https://rpc.example',{fetchImpl:async()=>{throw new Error('secret');}})('eth_chainId'),/^Error: RPC transport failed$/);
});
