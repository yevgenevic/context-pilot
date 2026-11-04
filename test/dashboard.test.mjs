import {toolDirectory} from './support/tool-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
test('dashboard follows a Codex event stream, keeps failed runs and serves the CLI handoff',async t=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'dashboard-test-'));
  const bin=toolDirectory(t);
  t.after(()=>rmSync(cwd,{force:true,recursive:true}));
  execFileSync('git',['init','-q'],{cwd});
  const pilot=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd,encoding:'utf8'});
  pilot('init');
  const server=spawn(process.execPath,[cli,'dashboard'],{cwd});
  t.after(()=>server.kill());
  const [banner]=await once(server.stdout,'data');
  const url=String(banner).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const state=async()=> (await fetch(url+'/api/state')).json();
  assert.deepEqual((await state()).tasks,[]);
  pilot('task','A','Check transfer');
  pilot('note','A','Review the failing check');
  assert.equal((await state()).packet,pilot('context','A'));
  writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node
if (process.argv[2]==='login' && process.argv[3]==='status') { console.error('Logged in using ChatGPT'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end',()=>{
  console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'npm test'}}));
  const fs=require('node:fs'), path=require('node:path');
  const release=path.join(__dirname,'finish-run');
  const timeout=setTimeout(()=>process.exit(2),15000);
  const poll=setInterval(()=>{
    if(!fs.existsSync(release))return;
    clearInterval(poll); clearTimeout(timeout);
    console.log(JSON.stringify({type:'turn.failed',error:{message:'Test failure'}}));
    process.exitCode=1;
  },20);
});`,{mode:0o755});
  const run=spawn(process.execPath,[cli,'run','A'],{cwd,env:{...process.env,PILOT_CODEX_TRANSPORT:'exec',PATH:bin+path.delimiter+process.env.PATH}});
  const exit=once(run,'close');
  try {
    let active;
    const deadline=Date.now()+10000;
    do {
      active=(await state()).runs[0];
      if(active?.events.some(e=>e.text.includes('npm test')))break;
      await delay(25);
    } while(Date.now()<deadline);
    assert.equal(active?.state,'running');
    assert.match(active.events.at(-1).text,/npm test/);
  } finally {
    writeFileSync(path.join(bin,'finish-run'),'');
  }
  assert.equal((await exit)[0],1);
  assert.equal((await state()).runs[0].state,'failed');
  assert.equal((await fetch(url+'/api/state?task=missing')).status,400);
  assert.equal((await fetch(url+'/.git/config')).status,404);
});
