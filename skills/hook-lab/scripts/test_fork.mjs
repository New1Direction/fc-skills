import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { anvilArguments, simulateFork, validateForkEvidence } from './fork.mjs';
import { digestValue } from './simulation.mjs';

const address=n=>'0x'+n.toString(16).padStart(40,'0');
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const q=n=>'0x'+BigInt(n).toString(16);
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const sender=address(1),router=address(2),token0=address(3),token1=address(4),ZERO=address(0);
const seal=r=>{delete r.evidence_digest;r.evidence_digest=digestValue(r);return r;};
const request=()=>({schema_version:'hook-lab.call.v1',chain_id:4663,block:{number:100,hash:hash(100)},
  transaction:{from:sender,to:router,data:'0x12345678',value:'0x0',gas:q(100000)},
  balance_tokens:[{address:token0,owner:sender},{address:token1,owner:sender}],
  context:{identity_digest:hash(77),route_id:'synthetic-test',source_mapping:'unverified',wallet_context:'synthetic'},
  expectations:[{token:token0,owner:sender,minimum_delta:'-100',maximum_delta:'-100'},
    {token:token1,owner:sender,minimum_delta:'200',maximum_delta:'200'},
    {token:ZERO,owner:sender,minimum_delta:'-21000',maximum_delta:'-21000'}]});

function fixture() {
  const r=request(),tx={hash:hash(9),from:sender,to:router,input:r.transaction.data,value:'0x0',gas:q(100000),nonce:'0x0',gasPrice:'0x1',blockHash:hash(101),blockNumber:q(101),chainId:q(4663)};
  const rawReceipt={transactionHash:tx.hash,blockHash:hash(101),blockNumber:q(101),status:'0x1',gasUsed:q(21000),effectiveGasPrice:'0x1',logs:[]};
  const observations=[];
  const add=(method,params,result,scope='local')=>observations.push({scope,method,params,result});
  add('eth_chainId',[],q(4663),'source');add('eth_getBlockByNumber',[q(100),false],{number:q(100),hash:hash(100)},'source');
  add('anvil_nodeInfo',[],{environment:{chainId:4663},currentBlockNumber:100,currentBlockHash:hash(100),forkConfig:{forkBlockNumber:100},hardFork:'Prague'});
  add('anvil_metadata',[],{forkedNetwork:{chainId:4663,forkBlockNumber:100,forkBlockHash:hash(100)},instanceId:hash(88)});
  add('eth_getBlockByNumber',[q(100),false],{number:q(100),hash:hash(100)});
  add('web3_clientVersion',[],'anvil/v1.7.1');add('eth_getCode',[sender,'latest'],'0x');
  for(const [token,before] of [[token0,1000],[token1,0]])add('eth_call',[{to:token,data:'0x70a08231'+sender.slice(2).padStart(64,'0')},'latest'],word(before));
  add('eth_getBalance',[sender,'latest'],q(1000000));add('eth_gasPrice',[],'0x1');add('evm_snapshot',[],'0x0');
  add('anvil_impersonateAccount',[sender],null);add('eth_sendTransaction',[{...r.transaction,gasPrice:'0x1'}],tx.hash);
  add('eth_getTransactionReceipt',[tx.hash],rawReceipt);add('eth_getTransactionByHash',[tx.hash],tx);
  add('eth_getBlockByNumber',[q(101),false],{number:q(101),hash:hash(101),parentHash:hash(100),timestamp:q(1001)});
  for(const [token,after] of [[token0,900],[token1,200]])add('eth_call',[{to:token,data:'0x70a08231'+sender.slice(2).padStart(64,'0')},q(101)],word(after));
  add('eth_getBalance',[sender,q(101)],q(979000));
  add('eth_chainId',[],q(4663),'source');add('eth_getBlockByNumber',[q(100),false],{number:q(100),hash:hash(100)},'source');
  return seal({schema_version:'hook-lab.fork.v1',request:r,call_digest:digestValue(r),status:'FORK_EXECUTED_AT_BLOCK',
    execution_environment:'local-anvil-next-block',state_overrides:false,sender_substitution:false,impersonated_sender:sender,
    canonical_source_rechecked:true,fork_origin:{chain_id:4663,block:r.block,anvil_version:'anvil/v1.7.1',hardfork:'Prague',instance_id:hash(88)},
    local_transaction:{hash:tx.hash,from:sender,to:router,data:tx.input,value:tx.value,gas:tx.gas,nonce:tx.nonce,gas_price:tx.gasPrice},
    local_block:{number:101,hash:hash(101),parent_hash:hash(100),timestamp:1001},
    receipt:{transaction_hash:tx.hash,block_hash:hash(101),block_number:101,status:1,gas_used:'21000',effective_gas_price:'1',logs:[]},
    token_balances:[{token:token0,owner:sender,before_raw:'1000',after_raw:'900',delta_raw:'-100'},
      {token:token1,owner:sender,before_raw:'0',after_raw:'200',delta_raw:'200'}],
    native_balances:[{owner:sender,before_raw:'1000000',after_raw:'979000',delta_raw:'-21000'}],
    expectations:r.expectations.map(e=>({...e,observed_delta:e.minimum_delta,pass:true})),
    costs:{local_execution_gas_wei:'21000',robinhood_l1_data_fee_wei:null,total_robinhood_execution_cost_wei:null},
    observations,issues:['SYNTHETIC_WALLET_CONTEXT','SOURCE_MAPPING_UNVERIFIED']});
}

test('valid retained local execution checks raw balances, gas and native expectation',()=>{
  const r=fixture();assert.deepEqual(validateForkEvidence(r),r);assert.notEqual(validateForkEvidence(r),r);
});
test('recomputed outer digest cannot hide altered raw token delta',()=>{
  const r=fixture();r.token_balances[0].delta_raw='-99';assert.throws(()=>validateForkEvidence(seal(r)),/BALANCE_DELTA/);
});
test('recomputed deltas cannot hide changed raw prebalance',()=>{
  const r=fixture();r.token_balances[0].before_raw='1001';r.token_balances[0].delta_raw='-101';assert.throws(()=>validateForkEvidence(seal(r)),/RAW_TOKEN_BALANCE/);
});
test('wrong wallet, router, calldata and amount remain distinct request failures',()=>{
  for(const [field,value] of [['from',address(88)],['to',address(88)],['data','0xdeadbeef'],['value','0x1'],['gas','0x1']]) {
    const r=fixture();r.local_transaction[field]=value;assert.throws(()=>validateForkEvidence(seal(r)),/TRANSACTION_/);
  }
});
test('wrong chain or canonical source block prevents complete evidence',()=>{
  for(const mutate of [r=>r.observations[0].result='0x1',r=>r.observations[1].result.hash=hash(88),r=>r.canonical_source_rechecked=false]) {
    const r=fixture();mutate(r);assert.throws(()=>validateForkEvidence(seal(r)),/SOURCE_/);
  }
});
test('node metadata binds fork state and instance',()=>{
  const r=fixture();r.observations.find(x=>x.method==='anvil_metadata').result.forkedNetwork.forkBlockHash=hash(88);
  assert.throws(()=>validateForkEvidence(seal(r)),/FORK_METADATA/);
});
test('contract sender and substituted impersonation are rejected',()=>{
  for(const mutate of [r=>r.observations.find(x=>x.method==='eth_getCode').result='0x6000',r=>r.observations.find(x=>x.method==='anvil_impersonateAccount').params[0]=address(88)]) {
    const r=fixture();mutate(r);assert.throws(()=>validateForkEvidence(seal(r)),/CONTRACT_SENDER|SENDER_SUBSTITUTED/);
  }
});
test('state seeding or source writes cannot appear in complete transcript',()=>{
  for(const observation of [{scope:'local',method:'anvil_setBalance',params:[sender,'0x1'],result:null},
    {scope:'source',method:'eth_sendTransaction',params:[],result:null},
    {scope:'local',method:'hardhat_impersonateAccount',params:[address(88)],result:null}]) {
    const r=fixture();r.observations.push(observation);assert.throws(()=>validateForkEvidence(seal(r)),/STATE_OVERRIDE|UNEXPECTED_/);
  }
});
test('raw tx and receipt require exactly the retained local transaction and next block',()=>{
  for(const mutate of [r=>r.local_block.parent_hash=hash(88),r=>r.receipt.block_number=102,
    r=>r.observations.find(x=>x.method==='eth_getTransactionByHash').result.nonce='0x1',
    r=>r.observations.find(x=>x.method==='eth_getTransactionReceipt').result.status='0x0']) {
    const r=fixture();mutate(r);assert.throws(()=>validateForkEvidence(seal(r)),/BLOCK_|RAW_TRANSACTION|RAW_RECEIPT/);
  }
});
test('missing, duplicated or altered native balance evidence is rejected',()=>{
  for(const mutate of [r=>r.native_balances=[],r=>r.native_balances.push({...r.native_balances[0]}),r=>r.native_balances[0].delta_raw='0']) {
    const r=fixture();mutate(r);assert.throws(()=>validateForkEvidence(seal(r)),/NATIVE_/);
  }
});
test('expectation success is recomputed including gas-inclusive native change',()=>{
  const r=fixture();r.expectations[2].pass=false;assert.throws(()=>validateForkEvidence(seal(r)),/EXPECTATION_RESULT/);
});
test('gas arithmetic never becomes a complete Robinhood fee claim',()=>{
  for(const mutate of [r=>r.costs.local_execution_gas_wei='1',r=>r.costs.robinhood_l1_data_fee_wei='0']) {
    const r=fixture();mutate(r);assert.throws(()=>validateForkEvidence(seal(r)),/GAS_COST|UNSUPPORTED_CHAIN_FEE/);
  }
});
test('receipt log substitution is rejected even with recomputed evidence digest',()=>{
  const r=fixture();r.receipt.logs=[{address:router,topics:[hash(1)],data:'0x',transactionHash:r.local_transaction.hash,blockHash:hash(101),blockNumber:q(101),removed:false}];
  assert.throws(()=>validateForkEvidence(seal(r)),/RAW_LOGS/);
});
test('outer digest is required and binds original request',()=>{
  const r=fixture();r.request.transaction.data='0x';assert.throws(()=>validateForkEvidence(r),/CALL_DIGEST/);
  const r2=fixture();r2.issues=[];assert.throws(()=>validateForkEvidence(r2),/EVIDENCE_DIGEST/);
});
test('rehashing cannot drop context issues or smuggle transaction authorization fields',()=>{
  const r=fixture();r.issues=[];assert.throws(()=>validateForkEvidence(seal(r)),/MISSING_SYNTHETIC_CONTEXT/);
  const r2=fixture();r2.observations.find(x=>x.method==='eth_sendTransaction').params[0].authorizationList=[];
  assert.throws(()=>validateForkEvidence(seal(r2)),/LOCAL_SEND_EXTRA_FIELDS/);
});
test('fork arguments fix host, disable default funded accounts and carry no shell code',()=>{
  const args=anvilArguments('https://rpc.example/path?key=secret',100,8545);
  assert.deepEqual(args.slice(0,4),['--host','127.0.0.1','--port','8545']);
  assert.equal(args[args.indexOf('--accounts')+1],'0');assert.ok(args.includes('--no-storage-caching'));
  assert.throws(()=>anvilArguments('file:///etc/passwd',100,8545));
  assert.throws(()=>anvilArguments('https://user:pass@example.com',100,8545));
  assert.throws(()=>anvilArguments('https://rpc.example',100,0));
});

async function withSource(handler,run) {
  const calls=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);calls.push(call.method);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result:handler(call)}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {await run('http://127.0.0.1:'+server.address().port,calls);}finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('source chain mismatch stops before spawning and never writes to source',async()=>{
  await withSource(()=>q(1),async(rpcUrl,calls)=>{
    const r=await simulateFork(request(),{rpcUrl,anvilPath:'/definitely/missing/anvil'});
    assert.equal(r.status,'INCOMPLETE');assert.deepEqual(r.issues,['SOURCE_CHAIN_MISMATCH']);assert.deepEqual(calls,['eth_chainId']);
    assert.equal(validateForkEvidence(r).status,'INCOMPLETE');
  });
});
test('source header mismatch is retained and prevents local writes',async()=>{
  await withSource(c=>c.method==='eth_chainId'?q(4663):{number:q(100),hash:hash(88)},async(rpcUrl,calls)=>{
    const r=await simulateFork(request(),{rpcUrl,anvilPath:'/definitely/missing/anvil'});
    assert.deepEqual(r.issues,['SOURCE_BLOCK_MISMATCH']);assert.deepEqual(calls,['eth_chainId','eth_getBlockByNumber']);
  });
});
test('missing Anvil produces bounded incomplete report without leaking endpoint',async()=>{
  await withSource(c=>c.method==='eth_chainId'?q(4663):{number:q(100),hash:hash(100)},async(rpcUrl,calls)=>{
    const r=await simulateFork(request(),{rpcUrl:rpcUrl+'/?key=secret',anvilPath:'/definitely/missing/anvil'});
    assert.equal(r.status,'INCOMPLETE');assert.ok(r.issues.includes('ANVIL_START_FAILED'));assert.ok(!JSON.stringify(r).includes('secret'));
    assert.deepEqual(calls,['eth_chainId','eth_getBlockByNumber']);
  });
});
