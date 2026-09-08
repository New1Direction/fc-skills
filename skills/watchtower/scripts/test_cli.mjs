import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const cli=fileURLToPath(new URL('./watchtower.mjs',import.meta.url));
function sandbox(t){const dir=mkdtempSync(join(tmpdir(),'watchtower-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function run(dir,args){return spawnSync(process.execPath,[cli,...args],{cwd:dir,encoding:'utf8',timeout:20000});}
test('demo runs outside skill cwd and produces recoverable gap, receipt and replacement evidence',t=>{
 const dir=sandbox(t),out=join(dir,'case');const r=run(dir,['demo','--out',out]);assert.equal(r.status,0,r.stderr);
 const report=JSON.parse(readFileSync(join(out,'report.json')));
 assert.equal(report.synthetic,true);assert.equal(report.while_block_missing.complete_through_head,false);
 assert.equal(report.while_receipts_missing.receipt_complete_through_head,false);assert.equal(report.after_replacement.receipt_complete_through_head,true);
 const status=run(dir,['report','--db',join(out,'watchtower.sqlite')]);assert.equal(status.status,0,status.stderr);
 const parsed=JSON.parse(status.stdout);assert.equal(parsed.execution_detail.internal_calls,'UNTRACED');assert.equal(parsed.coverage.transaction_count,9);
});
test('CLI classifies and exports exact retained transactions without losing revert or unknown type',t=>{
 const dir=sandbox(t),out=join(dir,'case');assert.equal(run(dir,['demo','--out',out]).status,0);
 const input=JSON.parse(readFileSync(join(out,'inputs.synthetic.json')));const block=input.blocks[0].block;
 const r=run(dir,['classifications','--db',join(out,'watchtower.sqlite'),'--block-hash',block.hash]);assert.equal(r.status,0,r.stderr);
 const items=JSON.parse(r.stdout).items;assert.equal(items.length,4);assert(items.some(x=>JSON.stringify(x).includes('0x7f')));assert(items.some(x=>JSON.stringify(x).includes('REVERTED')));
 const events=run(dir,['events','--db',join(out,'watchtower.sqlite'),'--limit','2']);assert.equal(JSON.parse(events.stdout).events.length,2);
 const outbox=run(dir,['outbox','--db',join(out,'watchtower.sqlite')]);assert.equal(outbox.status,0,outbox.stderr);assert(Array.isArray(JSON.parse(outbox.stdout).items));
});
test('missing explicit capture start fails before new database creation',t=>{
 const dir=sandbox(t),config=join(dir,'config.json'),db=join(dir,'new.sqlite');writeFileSync(config,JSON.stringify({chain_id:4663,from_block:null}));
 const r=run(dir,['capture','--config',config,'--db',db]);assert.notEqual(r.status,0);assert.match(r.stderr,/EXPLICIT_FROM_BLOCK_REQUIRED/);assert.equal(existsSync(db),false);
});
test('read commands do not invent a missing database',t=>{
 const dir=sandbox(t),db=join(dir,'absent.sqlite');const r=run(dir,['report','--db',db]);assert.notEqual(r.status,0);assert.equal(existsSync(db),false);
});
test('demo refuses an existing output directory and preserves its contents',t=>{
 const dir=sandbox(t);writeFileSync(join(dir,'keep.txt'),'keep');const r=run(dir,['demo','--out',dir]);assert.notEqual(r.status,0);assert.equal(readFileSync(join(dir,'keep.txt'),'utf8'),'keep');
});
test('synthetic throughput command retains scope and measures full worker completion',t=>{
 const dir=sandbox(t),out=join(dir,'bench.json');const r=run(dir,['bench','--out',out,'--blocks','3','--transactions','4']);assert.equal(r.status,0,r.stderr);
 const b=JSON.parse(readFileSync(out));assert.equal(b.transactions,12);assert.equal(b.coverage.receipt_count,12);assert.equal(b.mainnet_qualified,false);assert(b.durable_capture_ms>0);assert.equal(b.workers.classifications.with_receipts,12);
});
test('CLI rejects unknown options before modifying state',t=>{
 const dir=sandbox(t),out=join(dir,'case');const r=run(dir,['demo','--out',out,'--broadcast','yes']);assert.notEqual(r.status,0);assert.equal(existsSync(out),false);
});
test('probe is a failing preflight when the primary endpoint is absent, while preserving the diagnostic report',t=>{
 const dir=sandbox(t),config=join(dir,'probe.json');writeFileSync(config,JSON.stringify({chain_id:4663,from_block:1,primary_source:'primary',sources:[{name:'primary',http_env:'WATCHTOWER_CLI_TEST_ABSENT_HTTP'}]}));
 const env={...process.env};delete env.WATCHTOWER_CLI_TEST_ABSENT_HTTP;
 const r=spawnSync(process.execPath,[cli,'probe','--config',config],{cwd:dir,env,encoding:'utf8',timeout:10000});assert.equal(r.status,2,r.stderr);
 const p=JSON.parse(r.stdout);assert.equal(p.sources[0].state,'unavailable');assert.equal(p.sources[0].error_code,'missing_endpoint_environment');assert.equal(p.requests,0);
});
