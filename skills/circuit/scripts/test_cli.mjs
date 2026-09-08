import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRoute, validateBuilt } from './routes.mjs';
import { runCandidate } from './circuit.mjs';
const cli=fileURLToPath(new URL('./circuit.mjs',import.meta.url));
const example=JSON.parse(await readFile(new URL('../assets/route-example.json',import.meta.url),'utf8'));
const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000});
async function dir(fn){const p=await mkdtemp(join(tmpdir(),'circuit-cli-'));try{return await fn(p);}finally{await rm(p,{recursive:true,force:true});}}

test('CLI build and validate produce exact self-contained call',()=>dir(async p=>{
  const input=join(p,'route.json'),output=join(p,'built.json');await writeFile(input,JSON.stringify(example));
  const r=run(['build','--in',input,'--out',output]);assert.equal(r.status,0,r.stderr);
  validateBuilt(JSON.parse(await readFile(output,'utf8')));
  const v=run(['validate','--in',output,'--out',join(p,'validation.json')]);assert.equal(v.status,0,v.stderr);
}));
test('CLI does not overwrite retained evidence',()=>dir(async p=>{
  const input=join(p,'route.json'),output=join(p,'built.json');await writeFile(input,JSON.stringify(example));await writeFile(output,'retained');
  const r=run(['build','--in',input,'--out',output]);assert.equal(r.status,1);assert.equal(await readFile(output,'utf8'),'retained');
}));
test('unsupported flags and extra commands fail closed',()=>{
  for(const args of [['build','--submit'],['build','--in','x','--out','y','--anvil','x'],['build','simulate'],['send','--in','x','--out','y']])
    assert.equal(run(args).status,1);
});
test('demo uses new directory, builds candidates, and labels synthetic context',()=>dir(async p=>{
  const out=join(p,'new');const r=run(['demo','--out',out]);assert.equal(r.status,0,r.stderr);
  const b=JSON.parse(await readFile(join(out,'built.json'),'utf8'));assert.equal(b.route.wallet_context,'synthetic');
  assert.equal(JSON.parse(await readFile(join(out,'paths.json'),'utf8')).paths.length,2);
  assert.equal(run(['demo','--out',out]).status,1);
}));
test('source failure stops before any fork or local process attempt',async()=>{
  let reads=0;const output=await runCandidate(buildRoute(example),{
    rpc:async()=>{reads++;throw new Error('secret-url-token');},rpcUrl:'not-a-valid-url',anvilPath:'/must-not-run'});
  assert.equal(output.status,'INCOMPLETE');assert.equal(output.fork_report,null);assert.equal(output.cost_collection,null);
  assert.equal(reads,1);assert.ok(!JSON.stringify(output).includes('secret-url-token'));
});
test('CLI help names research operations and existing-approval requirement',()=>{
  const r=run(['--help']);assert.equal(r.status,0);assert.match(r.stdout,/sweep/);assert.match(r.stdout,/No live execution/);
});
