import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoute, ZERO } from './routes.mjs';
import { collectCostEstimate, validateCostEvidence, costCall, NODE_INTERFACE } from './costs.mjs';
import { digestValue } from './simulation.mjs';
import { selector } from './abi.mjs';

const example=JSON.parse(readFileSync(new URL('../assets/route-example.json',import.meta.url)));
const built=()=>buildRoute(example);
const q=n=>'0x'+BigInt(n).toString(16);
const words=values=>'0x'+values.map(v=>BigInt(v).toString(16).padStart(64,'0')).join('');
const hdr=b=>({number:q(b.route.block.number),hash:b.route.block.hash,timestamp:q(b.route.block.timestamp)});
const sign=c=>{delete c.evidence_digest;c.evidence_digest=digestValue(c);return c;};
async function collect(b=built(),options={}) {
  const seen=[];
  const rpc=async(method,params)=>{
    seen.push({method,params});
    if(method==='eth_chainId')return '0x1237';
    if(method==='eth_getBlockByNumber')return hdr(b);
    assert.equal(method,'eth_call');return words([100000,20000,10,900]);
  };
  return {report:await collectCostEstimate(b,{rpc,nowSeconds:110,...options}),seen};
}

test('NodeInterface wrapper binds wallet, value, gas, destination, inner calldata and exact block',()=>{
  const b=built(),[tx,tag]=costCall(b);
  assert.equal(tx.from,b.route.wallet);assert.equal(tx.to,NODE_INTERFACE);assert.equal(tx.value,b.transaction.value);assert.equal(tx.gas,b.transaction.gas);
  assert.equal(tx.data.slice(0,10),selector('gasEstimateComponents(address,bool,bytes)'));
  const body=tx.data.slice(10),word=i=>body.slice(i*64,(i+1)*64);
  assert.equal('0x'+word(0).slice(24),b.route.router);assert.equal(BigInt('0x'+word(1)),0n);assert.equal(BigInt('0x'+word(2)),96n);
  const n=Number(BigInt('0x'+word(3)));assert.equal('0x'+body.slice(256,256+n*2),b.transaction.data);
  assert.deepEqual(tag,{blockHash:b.route.block.hash,requireCanonical:true});
});
test('collects exactly five readonly observations and includes L1 only once',async()=>{
  const b=built(),{report,seen}=await collect(b);
  assert.equal(report.status,'ESTIMATE_OBSERVED');assert.equal(seen.length,5);
  assert.equal(report.cost_evidence.total_native_cost_wei,'1000000');
  assert.equal(report.cost_evidence.l1_gas_units,'20000');
  assert.deepEqual(validateCostEvidence(b,report.cost_evidence),report.cost_evidence);
});
test('missing Nitro method preserves unknown cost and omits provider prose',async()=>{
  const {report}=await collect(built(),{rpc:async()=>{throw Object.assign(new Error('private-key-in-url'),{code:-32601});}});
  assert.equal(report.status,'INCOMPLETE');assert.equal(report.cost_evidence,null);
  assert.equal(report.rpc_error_code,-32601);assert.ok(!JSON.stringify(report).includes('private-key'));
});
test('wrong chain stops before estimating',async()=>{
  let calls=0;const {report}=await collect(built(),{rpc:async()=>{calls++;return '0x1';}});
  assert.equal(calls,1);assert.deepEqual(report.issues,['COST_CHAIN_MISMATCH']);
});
test('reorg after estimate discards cost',async()=>{
  const b=built();let headers=0;
  const {report}=await collect(b,{rpc:async(m)=>m==='eth_chainId'?'0x1237':m==='eth_call'?words([100000,1,10,1]):
    {...hdr(b),hash:++headers===1?b.route.block.hash:'0x'+'f'.repeat(64)}});
  assert.equal(report.cost_evidence,null);assert.ok(report.issues.includes('COST_BLOCK_MISMATCH'));
});
test('ABI with missing return word cannot masquerade as zero L1 cost',async()=>{
  const b=built();const {report}=await collect(b,{rpc:async(m)=>m==='eth_chainId'?'0x1237':m==='eth_call'?words([100000,1,10]):hdr(b)});
  assert.equal(report.cost_evidence,null);assert.ok(report.issues.includes('COST_RESULT_INVALID'));
});
test('L1 gas above total, zero basefee and uint64 overflow rejected',async()=>{
  for(const w of [[1,2,10,1],[10,1,0,1],[1n<<64n,1,10,1]]) {
    const b=built();const {report}=await collect(b,{rpc:async(m)=>m==='eth_chainId'?'0x1237':m==='eth_call'?words(w):hdr(b)});
    assert.equal(report.cost_evidence,null);
  }
});
test('zero L1 component valid if actual response says so',async()=>{
  const b=built();const {report}=await collect(b,{rpc:async(m)=>m==='eth_chainId'?'0x1237':m==='eth_call'?words([100000,0,10,0]):hdr(b)});
  assert.equal(report.status,'ESTIMATE_OBSERVED');assert.equal(report.cost_evidence.l1_gas_units,'0');
});
test('cost evidence binds exact amount and calldata',async()=>{
  const {report}=await collect();const changed=buildRoute({...example,amount_in:'1001'});
  assert.throws(()=>validateCostEvidence(changed,report.cost_evidence),/IDENTITY/);
});
test('rehashing cannot hide a changed RPC sender or fee arithmetic',async()=>{
  const b=built(),{report}=await collect(b);
  for(const mutate of [c=>c.observations[2].params[0].from=b.route.router,c=>c.total_native_cost_wei='0',c=>c.gas_units='1',c=>c.includes_l1_data_fee=false]) {
    const c=structuredClone(report.cost_evidence);mutate(c);sign(c);
    assert.throws(()=>validateCostEvidence(b,c));
  }
});
test('no latest fallback accepted in retained transcript',async()=>{
  const b=built(),{report}=await collect(b),c=structuredClone(report.cost_evidence);
  c.observations[2].params[1]='latest';sign(c);
  assert.throws(()=>validateCostEvidence(b,c),/TRANSCRIPT/);
});
test('conversion must use exact input currency and pinned block',async()=>{
  const b=built();const conversion={currency:b.route.currency_in,numerator_input_raw:'1',denominator_native_wei:'300',block:{number:1,hash:b.route.block.hash}};
  const {report}=await collect(b,{conversion});assert.deepEqual(report.cost_evidence.conversion,conversion);
  for(const c of [{...conversion,currency:ZERO},{...conversion,numerator_input_raw:'0'},{...conversion,block:{number:2,hash:b.route.block.hash}}])
    await assert.rejects(()=>collect(b,{conversion:c}));
});
test('clock limits and oversized observations are explicit',async()=>{
  await assert.rejects(()=>collect(built(),{nowSeconds:99}),/CLOCK/);
  const b=built(),{report}=await collect(b),c=structuredClone(report.cost_evidence);c.expires_at=c.observed_at+301;sign(c);
  assert.throws(()=>validateCostEvidence(b,c),/CLOCK/);
  const big=await collect(b,{rpc:async()=> 'a'.repeat(1048577)});
  assert.ok(big.report.issues.includes('COST_EVIDENCE_TOO_LARGE'));
});
test('estimate exceeding exact transaction gas limit cannot qualify',async()=>{
  const b=buildRoute({...example,gas:'50000'}),{report}=await collect(b);
  assert.equal(report.cost_evidence,null);assert.ok(report.issues.includes('COST_EXCEEDS_GAS_LIMIT'));
});
