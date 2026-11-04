import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../src/pilot.ts', import.meta.url));

test('a checkout cannot supply the health checks, worker or git through PATH, including symlinks', t => {
  const dir = mkdtempSync(path.join(tmpdir(),'pilot-external-tools-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'checkout'), nested=path.join(root,'src'), modules=path.join(root,'node_modules','.bin');
  const good=path.join(dir,'installed'), aliases=path.join(dir,'aliases'), badNode=path.join(dir,'unsafe-interpreter');
  const marker=path.join(dir,'unexpected'), calls=path.join(dir,'calls');
  for(const d of [nested,modules,good,aliases,badNode]) mkdirSync(d,{recursive:true});
  execFileSync('git',['init','-q'],{cwd:root});
  function script(file,body) { writeFileSync(file,'#!'+process.execPath+'\n'+body,{mode:0o755}); }
  const malicious = 'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"executed");process.exit(66)';
  for(const name of ['codex','claude','git']) {
    for(const d of [root,nested,modules]) script(path.join(d,name),malicious);
    symlinkSync(path.join(root,name),path.join(aliases,name));
  }
  script(path.join(root,'node'),malicious);
  symlinkSync(path.join(root,'node'),path.join(badNode,'node'));
  symlinkSync(modules,path.join(dir,'bin-alias'));
  symlinkSync(execFileSync('which',['git'],{encoding:'utf8'}).trim(),path.join(good,'git'));
  const env={...process.env,PILOT_CODEX_TRANSPORT:'exec',PATH:['.', '', 'node_modules/.bin', root,root.toUpperCase(),modules,path.join(dir,'bin-alias'),badNode,aliases,good].join(path.delimiter)};
  const pilot=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:nested,env,encoding:'utf8'});
  const unavailable=pilot('doctor');
  assert.equal(unavailable.status,1);assert.match(unavailable.stdout,/Нужен Codex CLI/);
  assert.match(unavailable.stdout,/Claude Code не найден/);
  assert.equal(pilot('init').status,0);
  assert.equal(pilot('task','A','Remember the change').status,0);
  assert.equal(pilot('run','A').status,1);
  assert.equal(existsSync(marker),false);
  for(const name of ['codex','claude']) {
    script(path.join(good,name),
      'const fs=require("node:fs");fs.appendFileSync('+JSON.stringify(calls)+',JSON.stringify([process.argv[2],process.env.PATH])+"\\n");'+
      'if(process.argv[2]==="login")console.log("Logged in using ChatGPT");'+
      'if(process.argv[2]==="auth")console.log(JSON.stringify({loggedIn:true}));'+
      'if(process.argv[2]==="exec"){fs.readFileSync(0);console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}))}');
  }
  assert.equal(pilot('doctor').status,0);
  const result=pilot('run','A');assert.equal(result.status,0,result.stderr);
  const rows=readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(rows.map(([cmd])=>cmd)),new Set(['login','auth','exec']));
  assert.ok(rows.every(([,p])=>!p.split(path.delimiter).some(entry=>entry==='.' || entry.startsWith(root) || entry.includes('unsafe-interpreter') || entry.endsWith('/aliases'))));
  assert.equal(existsSync(marker),false);
});
