import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./hook-lab.mjs',import.meta.url));
test('CLI help exposes supported operations',()=>{const r=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/pons-discover/);assert.match(r.stdout,/qualify/);});
test('CLI rejects write commands, duplicate flags, and missing RPC configuration',()=>{
 for(const args of [['send'],['call','--input','x','--input','y'],['call','--input','x','--rpc-env','HOOKLAB_UNSET_TEST','--out','x']]){const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(r.status,1);assert.match(r.stderr,/HOOK LAB:/);}
});
