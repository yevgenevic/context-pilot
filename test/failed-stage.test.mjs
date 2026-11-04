import {toolDirectory} from './support/tool-directory.mjs';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
const executable = `#!/usr/bin/env node
const fs=require('node:fs');
if (process.argv[2]==='login' && process.argv[3]==='status') {console.error('Logged in using ChatGPT');process.exit(0);}
const emit = item => console.log(JSON.stringify({type:'item.completed',item}));
const message = text => emit({type:'agent_message',text});
const command = command => emit({type:'command_execution',command,exit_code:0,aggregated_output:'ok'});
let prompt='';
process.stdin.on('data',chunk=>prompt+=chunk).on('end',()=>{
  const role=prompt.includes('Ты планировщик')?'plan':prompt.includes('Ты независимый проверяющий')?'verify':prompt.includes('Implement two')?'second':'first';
  fs.appendFileSync('.git/calls',role+' '+process.pid+'\\n');
  const marker='.git/failed-'+role;
  if(role!=='first' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker,'1');
    if(role==='second') {fs.writeFileSync('partial.js','saved before crash');emit({type:'file_change',changes:[{path:'partial.js'}]});}
    command('node read-'+role+'.js');
    process.exitCode=23;
    return;
  }
  let result;
  if(role==='plan') result={questions:[],tasks:['one','two'].map(name=>({title:name,text:'Implement '+name,files:['partial.js'],rules:[],checks:['Inspect output']}))};
  if(role==='first') result={status:'done',summary:'Stable first-stage contract'};
  if(role==='second') {
    if(fs.readFileSync('partial.js','utf8')!=='saved before crash') throw Error('lost partial work');
    result={status:'done',summary:'Recovered'};
  }
  if(role==='verify') {
    command('node run.js');
    result={status:'passed',summary:'Checked',fixtures:[],checks:[{requirement:'Output',expected:'ok',actual:'ok',passed:true}]};
  }
  message(JSON.stringify(result));
});`;

test('retry from disk repeats only the failed planner, worker or verifier with its own saved actions',t=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'pilot-failed-stage-'));
  const bin=toolDirectory(t);
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,PILOT_CODEX_TRANSPORT:'exec'};
  const pilot=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd,env,encoding:'utf8',timeout:15000});
  writeFileSync(path.join(bin,'codex'),executable,{mode:0o755});
  assert.equal(pilot('init').status,0);
  assert.equal(pilot('idea','Build a pair of modules').status,1);
  const directory=path.join(cwd,'.pilot','ideas');
  const file=path.join(directory,readdirSync(directory)[0]);
  const plan=()=>JSON.parse(readFileSync(file,'utf8'));
  const id=plan().id;
  const expectCrash=stage=>{
    assert.equal(plan().state,'failed');
    assert.equal(plan().retryStage,id+'-'+stage);
    assert.equal(plan().childPid,undefined);
  };

  expectCrash('plan');
  // Archives made before the retry feature contain only the process error.
  const legacy=plan();
  delete legacy.retryStage;
  writeFileSync(file,JSON.stringify(legacy));
  assert.equal(pilot('resume',id).status,1);
  expectCrash('2');
  assert.deepEqual(plan().tasks.map(task=>task.state),['done','failed']);
  writeFileSync(path.join(cwd,'teammate.md'),'A change since the failure');
  assert.equal(pilot('resume',id).status,1);
  expectCrash('verify');
  assert.deepEqual(plan().tasks.map(task=>task.state),['done','done']);
  assert.equal(pilot('resume',id).status,0);
  assert.equal(plan().state,'done');
  assert.equal(pilot('resume',id).status,1);

  const calls=readFileSync(path.join(cwd,'.git','calls'),'utf8').trim().split('\n').map(line=>line.split(' '));
  assert.deepEqual(calls.map(([role])=>role),['plan','plan','first','second','second','verify','verify']);
  assert.equal(new Set(calls.map(([,pid])=>pid)).size,calls.length);
  for (const [stage,role] of [['plan','plan'],['2','second'],['verify','verify']]) {
    const packet=pilot('packet',id+'-'+stage,'2').stdout;
    assert.match(packet,/Продолжение после сбоя/);
    assert.match(packet,/код 23/);
    assert.ok(packet.includes('node read-'+role+'.js'));
    if(stage==='2') {
      assert.match(packet,/partial\.js/);
      assert.match(packet,/Stable first-stage contract/);
      assert.match(packet,/Добавлен "teammate\.md"/);
    }
  }
  assert.deepEqual(plan().verification.reports[0].commands.map(c=>c.command),['node run.js']);
});
