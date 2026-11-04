import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../src/pilot.ts',import.meta.url));

function project(t) {
  const dir = mkdtempSync(path.join(tmpdir(),'pilot-boundary-'));
  const repo = path.join(dir,'project');
  mkdirSync(repo);
  execFileSync('git',['init','-q'],{cwd:repo});
  t.after(() => rmSync(dir,{force:true, recursive:true}));
  const pilot = (...args) => spawnSync(process.execPath,[cli,...args],{cwd:repo,encoding:'utf8'});
  return {repo,dir,pilot};
}

test('versioned memory cannot read or modify files through symlinks or Git options', t => {
  const {repo,dir,pilot} = project(t);
  const target = path.join(dir,'outside.json');
  const sentinel = '{"id":"S","text":"outside-only","files":[]}';
  writeFileSync(target,sentinel);
  symlinkSync(dir,path.join(repo,'.pilot'),'dir');
  assert.notEqual(pilot('init').status,0);
  assert.equal(existsSync(path.join(dir,'tasks')),false);
  rmSync(path.join(repo,'.pilot'));
  assert.equal(pilot('init').status,0);
  assert.equal(pilot('task','T','Goal').status,0);
  const taskPath = path.join(repo,'.pilot/tasks/T.json');
  const task = JSON.parse(readFileSync(taskPath,'utf8'));
  symlinkSync(target,path.join(repo,'.pilot/rules/S.json'));
  writeFileSync(taskPath,JSON.stringify({...task,rules:['S']}));
  const result = pilot('context','T');
  assert.notEqual(result.status,0); assert.doesNotMatch(result.stdout+result.stderr,/outside-only/);

  execFileSync('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-qm','start'],{cwd:repo});
  writeFileSync(taskPath,JSON.stringify({...task,base:'--output='+target}));
  assert.notEqual(pilot('context','T').status,0);
  assert.equal(readFileSync(target,'utf8'),sentinel);
  writeFileSync(taskPath,JSON.stringify(task));

  mkdirSync(path.join(repo,'.pilot/notes'));
  symlinkSync(target,path.join(repo,'.pilot/notes/T.jsonl'));
  assert.notEqual(pilot('note','T','intruder').status,0);
  assert.equal(readFileSync(target,'utf8'),sentinel);
  rmSync(path.join(repo,'.pilot/notes/T.jsonl'));
  linkSync(target,path.join(repo,'.pilot/notes/T.jsonl'));
  assert.notEqual(pilot('note','T','intruder').status,0);
  assert.equal(readFileSync(target,'utf8'),sentinel);
  symlinkSync(dir,path.join(repo,'foreign'),'dir');
  assert.notEqual(pilot('task','OUT','bad','--file','foreign/outside.json').status,0);
  assert.notEqual(pilot('task','OUT','bad','--file','foreign/not-created-yet.js').status,0);
});

test('dashboard survives malformed targets and protects its API from other origins',async t=>{
  const {repo,pilot}=project(t);
  assert.equal(pilot('init').status,0);
  const server=spawn(process.execPath,[cli,'dashboard'],{cwd:repo});
  const closed=once(server,'close');
  t.after(async()=>{server.kill();await closed;});
  const [banner]=await once(server.stdout,'data');
  const url=String(banner).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  function raw(target,headers={}) {
    return new Promise((resolve,reject)=>{
      const req=request(url,{path:target,headers},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject).end();
    });
  }
  assert.equal(await raw('//['),400);
  assert.equal(await raw('/api/state',{Host:'rebound.invalid'}),403);
  assert.equal(await raw('/api/state',{Origin:'http://127.0.0.1:1'}),403);
  assert.equal(await raw('/api/state',{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'}),403);
  assert.equal(await raw('/api/state',{'Sec-Fetch-Site':'same-origin'}),200);
  assert.equal(await raw('/'),200);
});
