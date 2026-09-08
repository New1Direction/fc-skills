/** Exact-call Nitro estimates. RPC observations are retained evidence, not authentication. */
import { validateBuilt } from './routes.mjs';
import { digestValue } from './simulation.mjs';
import { keccakHex } from './keccak.mjs';

const ZERO = '0x'+'0'.repeat(40);
export const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';
const METHOD = 'NodeInterface.gasEstimateComponents';
const MAX_BYTES = 1_048_576;
const check = (ok, code) => { if (!ok) throw new TypeError(code); };
const eq = (a,b) => digestValue(a) === digestValue(b);
const q = n => '0x'+BigInt(n).toString(16);
function keys(v, required, optional = []) {
  check(v && typeof v==='object' && !Array.isArray(v), 'COST_OBJECT_REQUIRED');
  check(required.every(k=>Object.hasOwn(v,k)) && Object.keys(v).every(k=>[...required,...optional].includes(k)), 'COST_FIELDS_INVALID');
}
function raw(v, positive=false, bits=256) {
  check(typeof v==='string' && v.length<=78 && /^(0|[1-9][0-9]*)$/.test(v), 'COST_INTEGER_INVALID');
  const n=BigInt(v); check(n<(1n<<BigInt(bits)) && (!positive||n>0n), 'COST_INTEGER_RANGE'); return n;
}
function header(h,b) {
  check(h && h.number===q(b.number) && typeof h.hash==='string' && h.hash.toLowerCase()===b.hash && h.timestamp===q(b.timestamp), 'COST_BLOCK_MISMATCH');
}
function bounded(v) { check(Buffer.byteLength(JSON.stringify(v))<=MAX_BYTES,'COST_EVIDENCE_TOO_LARGE'); }
const word = n => BigInt(n).toString(16).padStart(64,'0');
export function costCall(builtInput) {
  const {transaction:tx,route}=validateBuilt(builtInput);
  const bytes=tx.data.slice(2);
  const data=keccakHex(Buffer.from('gasEstimateComponents(address,bool,bytes)')).slice(0,10)
    +tx.to.slice(2).padStart(64,'0')+word(0)+word(96)+word(bytes.length/2)+bytes.padEnd(Math.ceil(bytes.length/64)*64,'0');
  return [{from:tx.from,to:NODE_INTERFACE,data,value:tx.value,gas:tx.gas}, {blockHash:route.block.hash,requireCanonical:true}];
}
function decode(value) {
  check(typeof value==='string' && /^0x[0-9a-fA-F]{256}$/.test(value),'COST_RESULT_INVALID');
  const words=Array.from({length:4},(_,i)=>BigInt('0x'+value.slice(2+i*64,66+i*64)));
  check(words[0]>0n && words[0]<(1n<<64n) && words[1]<=words[0] && words[2]>0n,'COST_COMPONENTS_INVALID');
  check(words[0]*words[2]<(1n<<256n),'COST_OVERFLOW');
  return {gas_units:String(words[0]),l1_gas_units:String(words[1]),gas_price_wei:String(words[2]),
    l1_base_fee_estimate_wei:String(words[3]),total_native_cost_wei:String(words[0]*words[2])};
}
function validateConversion(conversion,route) {
  keys(conversion,['currency','numerator_input_raw','denominator_native_wei','block']);
  check(route.currency_in!==ZERO && conversion.currency===route.currency_in,'COST_CONVERSION_CURRENCY');
  raw(conversion.numerator_input_raw,true); raw(conversion.denominator_native_wei,true);
  check(eq(conversion.block,{number:route.block.number,hash:route.block.hash}),'COST_CONVERSION_BLOCK');
}

/** Validate consistency against the exact route and retained NodeInterface call. No freshness promotion. */
export function validateCostEvidence(builtInput,cost) {
  const built=validateBuilt(builtInput),route=built.route;
  keys(cost,['schema_version','route_digest','chain_id','block','transaction_digest','basis','method','gas_units','l1_gas_units',
    'gas_price_wei','l1_base_fee_estimate_wei','total_native_cost_wei','includes_l1_data_fee','observed_at','expires_at','observations','evidence_digest'],['conversion']);
  bounded(cost);
  check(cost.schema_version==='circuit.cost.v1' && cost.route_digest===built.route_digest && cost.chain_id===4663,'COST_IDENTITY_MISMATCH');
  check(eq(cost.block,{number:route.block.number,hash:route.block.hash}) && cost.transaction_digest===digestValue(built.transaction),'COST_CALL_MISMATCH');
  check(cost.basis==='estimate' && cost.method===METHOD && cost.includes_l1_data_fee===true,'COST_BASIS_INVALID');
  for(const k of ['gas_units','l1_gas_units','gas_price_wei','l1_base_fee_estimate_wei','total_native_cost_wei'])raw(cost[k]);
  check(Number.isSafeInteger(cost.observed_at) && cost.observed_at>=route.block.timestamp && Number.isSafeInteger(cost.expires_at)
    && cost.expires_at>cost.observed_at && cost.expires_at-cost.observed_at<=300,'COST_CLOCK_INVALID');
  check(Array.isArray(cost.observations) && cost.observations.length===5,'COST_TRANSCRIPT_INVALID');
  const requests=[['eth_chainId',[]],['eth_getBlockByNumber',[q(route.block.number),false]],['eth_call',costCall(built)],
    ['eth_chainId',[]],['eth_getBlockByNumber',[q(route.block.number),false]]];
  cost.observations.forEach((o,i)=>{
    keys(o,['method','params','result']); check(o.method===requests[i][0] && eq(o.params,requests[i][1]),'COST_TRANSCRIPT_CALL_MISMATCH');
  });
  check(cost.observations[0].result==='0x1237' && cost.observations[3].result==='0x1237','COST_CHAIN_MISMATCH');
  header(cost.observations[1].result,route.block); header(cost.observations[4].result,route.block);
  const decoded=decode(cost.observations[2].result);
  for(const [k,v] of Object.entries(decoded))check(cost[k]===v,'COST_ARITHMETIC_MISMATCH');
  check(BigInt(cost.gas_units)<=BigInt(built.transaction.gas),'COST_EXCEEDS_GAS_LIMIT');
  if(cost.conversion!==undefined)validateConversion(cost.conversion,route);
  const {evidence_digest,...unsigned}=cost;
  check(evidence_digest===digestValue(unsigned),'COST_DIGEST_MISMATCH');
  return structuredClone(cost);
}

/** At most five reads. Unsupported archive/NodeInterface responses preserve unknown costs. */
export async function collectCostEstimate(builtInput,{rpc,conversion,nowSeconds=Math.floor(Date.now()/1000)}={}) {
  const built=validateBuilt(builtInput),route=built.route;
  check(typeof rpc==='function','COST_RPC_REQUIRED');
  check(Number.isSafeInteger(nowSeconds) && nowSeconds>=route.block.timestamp,'COST_CLOCK_INVALID');
  if(conversion!==undefined)validateConversion(conversion,route);
  const report={schema_version:'circuit.cost-collection.v1',route_digest:built.route_digest,status:'INCOMPLETE',cost_evidence:null,
    observations:[],issues:[],limitations:['NodeInterface support is probed, not assumed.','A retained RPC transcript does not authenticate the provider.',
      'This is a pinned-state fee estimate; future execution cost can differ.','Supplied native-to-token conversion is an assumption, not an independently verified exit quote.']};
  const call=async(method,params)=>{
    const result=await rpc(method,params); bounded(result);
    report.observations.push({method,params,result}); bounded(report); return result;
  };
  try {
    check(await call('eth_chainId',[])==='0x1237','COST_CHAIN_MISMATCH');
    header(await call('eth_getBlockByNumber',[q(route.block.number),false]),route.block);
    const result=await call('eth_call',costCall(built));
    const values=decode(result);
    check(await call('eth_chainId',[])==='0x1237','COST_CHAIN_MISMATCH');
    header(await call('eth_getBlockByNumber',[q(route.block.number),false]),route.block);
    const cost={schema_version:'circuit.cost.v1',route_digest:built.route_digest,chain_id:4663,
      block:{number:route.block.number,hash:route.block.hash},transaction_digest:digestValue(built.transaction),basis:'estimate',method:METHOD,
      ...values,includes_l1_data_fee:true,observed_at:nowSeconds,expires_at:nowSeconds+120,observations:structuredClone(report.observations),
      ...(conversion===undefined?{}:{conversion:structuredClone(conversion)})};
    cost.evidence_digest=digestValue(cost);
    report.cost_evidence=validateCostEvidence(built,cost); report.status='ESTIMATE_OBSERVED';
  } catch(e) {
    report.issues.push(e instanceof TypeError&&/^[A-Z_]{3,80}$/.test(e.message)?e.message:'COST_RPC_UNAVAILABLE');
    if(Number.isInteger(e?.code))report.rpc_error_code=e.code;
  }
  report.evidence_digest=digestValue(report);
  return report;
}
