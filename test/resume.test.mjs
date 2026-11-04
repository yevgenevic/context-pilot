import {toolDirectory} from './support/tool-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
const fake=`#!/usr/bin/env node
if (process.argv[2]==='login' && process.argv[3]==='status') { console.error('Logged in using ChatGPT'); process.exit(0); }
const fs=require('node:fs');
let prompt='';
process.stdin.on('data',chunk=>prompt+=chunk).on('end',()=>{
  fs.appendFileSync('calls',JSON.stringify({prompt,args:process.argv,pid:process.pid})+'\\n');
  const say=(type,item)=>console.log(JSON.stringify({type,item}));
  let result;
  if(prompt.includes('Ты планировщик')){
    result={questions:[],tasks:['module','command'].map(name=>({title:name,text:'implement '+name,files:['app.js'],rules:[],checks:['run CLI']}))};
  }else if(prompt.includes('Ты независимый проверяющий')){
    if(!fs.existsSync('no-evidence'))say('item.completed',{type:'command_execution',command:'node app.js',exit_code:0,aggregated_output:'42'});
    const mismatch=!fs.existsSync('repaired');
    result={status:mismatch?'failed':'passed',summary:mismatch?'Wrong stdout':'OK',checks:[{requirement:'Output',expected:'42',actual:mismatch?'41':'42',passed:!mismatch}]};
  }else if(prompt.includes('Wrong stdout')){
    fs.writeFileSync('repaired','ok');result={status:'done',summary:'Repaired'};
  }else if(prompt.includes('implement command')&&!prompt.includes('Продолжение после остановки')){
    fs.writeFileSync('app.js','partial');say('item.completed',{type:'file_change',changes:[{path:'app.js'}]});setInterval(()=>{},1000);return;
  }else{
    result={status:'done',summary:prompt.includes('implement module')?'Use compute42':'Used compute42'};
  }
  say('item.completed',{type:'agent_message',text:JSON.stringify(result)});
});`;
for(const noEvidence of [false,true])test('resume from disk, repair and verify '+(noEvidence?'without execution':'with execution'),async t=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'pilot-resume-'));
  const bin=toolDirectory(t);
  t.after(()=>rmSync(cwd,{force:true,recursive:true}));
  const env={...process.env,PILOT_CODEX_TRANSPORT:'exec',PATH:bin+path.delimiter+process.env.PATH};
  const pilot=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  execFileSync('git',['init','-q'],{cwd});pilot('init');
  writeFileSync(path.join(bin,'codex'),fake,{mode:0o755});
  if(noEvidence)writeFileSync(path.join(cwd,'no-evidence'),'');
  const run=spawn(process.execPath,[cli,'idea','Print 42'],{cwd,env,stdio:'ignore'});
  t.after(()=>run.kill());const exit=once(run,'exit');
  for(let n=0;n<300&&!existsSync(path.join(cwd,'app.js'));n++)await delay(20);
  assert.ok(existsSync(path.join(cwd,'app.js')));
  const file=readdirSync(path.join(cwd,'.pilot/ideas'))[0],id=file.slice(0,-5);
  const state=()=>JSON.parse(readFileSync(path.join(cwd,'.pilot/ideas',file),'utf8'));
  assert.throws(()=>pilot('resume',id));
  pilot('stop',id);assert.equal((await exit)[0],130);
  assert.deepEqual(state().tasks.map(t=>t.state),['done','interrupted']);
  const first=pilot('packet',id+'-2','1');
  writeFileSync(path.join(cwd,'app.js'),'updated by teammate during pause');
  writeFileSync(path.join(cwd,'acceptance.md'),'expect 42');
  if(noEvidence)assert.throws(()=>pilot('resume',id));else pilot('resume',id);
  const calls=readFileSync(path.join(cwd,'calls'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const resumed=pilot('packet',id+'-2','2');
  assert.ok(resumed.startsWith(first.trimEnd()));assert.match(resumed,/app\.js/);assert.match(resumed,/Use compute42/);
  const changes=resumed.split('## Что изменилось после остановки')[1];
  assert.match(changes,/Добавлен "acceptance\.md"/);assert.match(changes,/Изменён "app\.js"/);
  assert.equal(calls[3].prompt,resumed);assert.notEqual(calls[2].pid,calls[3].pid);
  assert.equal(calls.filter(c=>c.prompt.includes('Ты планировщик')).length,1);
  const verify=calls.filter(c=>c.prompt.includes('Ты независимый проверяющий'));
  assert.equal(verify.length,2);assert.ok(verify.every(c=>c.args.includes('read-only') && !c.prompt.includes('compute42') && c.args.includes('--ephemeral')));
  assert.equal(state().state,noEvidence?'failed':'done');
  assert.equal(state().verification.reports.at(-1).status,noEvidence?'blocked':'passed');
  if (noEvidence) {
    rmSync(path.join(cwd,'no-evidence'));
    pilot('resume',id);
    const retried=readFileSync(path.join(cwd,'calls'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
    assert.equal(retried.length,calls.length+1);
    assert.match(retried.at(-1).prompt,/Ты независимый проверяющий/);
    assert.equal(state().state,'done');
    assert.deepEqual(state().verification.reports.map(r=>r.status),['failed','blocked','passed']);
  }
});
