import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../src/pilot.ts', import.meta.url));

test('preflight explains what is missing before any work is saved; local handoff remains usable', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pilot-onboarding-'));
  t.after(() => rmSync(root, {force:true, recursive:true}));
  const cwd = path.join(root, 'project'), bin = path.join(root, 'bin');
  mkdirSync(cwd); mkdirSync(bin);
  execFileSync('git',['init','-q'],{cwd});
  symlinkSync(execFileSync('which',['git'],{encoding:'utf8'}).trim(),path.join(bin,'git'));
  const env = {...process.env,PATH:bin};
  writeFileSync(path.join(bin,'claude'),'#!'+process.execPath+'\n'+
    'if(process.argv.slice(2).join(" ") !== "auth status --json") process.exit(92);\n'+
    'console.log(JSON.stringify({loggedIn:true,email:"claude-sensitive-marker"}));\n',{mode:0o755});
  const pilot = (...args) => spawnSync(process.execPath,[cli,...args],{cwd,env,encoding:'utf8'});
  assert.equal(pilot('init').status,0);
  assert.equal(pilot('task','A','Check a report').status,0);
  const onlyClaude = pilot('doctor');
  assert.match(onlyClaude.stdout,/npm install -g @openai\/codex/);
  assert.match(onlyClaude.stdout,/Ручная передача в Claude Code\nClaude Code найден, вход выполнен/);
  assert.doesNotMatch(onlyClaude.stdout,/claude-sensitive-marker/);
  assert.match(pilot('idea','Test my report').stderr,/Нужен Codex CLI/);
  assert.match(pilot('run','A').stderr,/Нужен Codex CLI/);
  const server=spawn(process.execPath,[cli,'dashboard'],{cwd,env,stdio:['ignore','pipe','inherit']});
  const closed=once(server,'close');
  t.after(async()=>{server.kill();await closed;});
  const [banner]=await once(server.stdout,'data');
  const url=String(banner).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const state=await (await fetch(url+'/api/state')).json();
  assert.equal(state.codex.state,'missing');
  assert.equal(state.claude.state,'ready');
  assert.doesNotMatch(JSON.stringify(state),/claude-sensitive-marker/);
  assert.match(await (await fetch(url+'/api/handoff?task=A')).text(), /Check a report/);
  function fakeLogin(output, code) {
    writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+'\n'+
      'if(process.argv.slice(2).join(" ") !== "login status") process.exit(92);\n'+
      'console.error('+JSON.stringify(output)+');process.exit('+code+');\n',{mode:0o755});
  }
  fakeLogin('Not logged in',1);
  const res=await fetch(url+'/api/ideas',{method:'POST',headers:{
    Origin:url,'Content-Type':'application/json','X-Pilot-Action':'start'
  },body:JSON.stringify({idea:'Test my report'})});
  assert.equal(res.status,400);
  assert.match((await res.json()).error,/codex login/);
  assert.equal((await (await fetch(url+'/api/state')).json()).codex.state,'signed_out');
  assert.equal(existsSync(path.join(cwd,'.pilot','ideas')),false);
  assert.equal(existsSync(path.join(cwd,'.git','context-pilot','runs')),false);
  fakeLogin('Logged in using API key - sensitive-test-marker',0);
  const doctor=pilot('doctor');
  assert.equal(doctor.status,0);
  assert.match(doctor.stdout,/Codex готов/);
  assert.match(doctor.stdout,/Claude Code найден, вход выполнен/);
  assert.doesNotMatch(doctor.stdout+doctor.stderr,/sensitive-test-marker/);
});
