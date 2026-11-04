import {toolDirectory} from './support/tool-directory.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runContextStage,ContextCapacityError} from '../src/rotation.ts';
import {savePacket} from '../src/packets.ts';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
const fake=`#!/usr/bin/env node
if (process.argv[2]==='login' && process.argv[3]==='status') { console.error('Logged in using ChatGPT'); process.exit(0); }
const fs=require('node:fs');
let prompt='';
process.stdin.on('data',chunk=>prompt+=chunk).on('end',()=>{
  const say=(type,extra)=>console.log(JSON.stringify({type,...extra}));
  const result=value=>say('item.completed',{item:{type:'agent_message',phase:'final_answer',text:JSON.stringify(value)}});
  const command=(id,cmd)=>say('item.completed',{item:{id,type:'command_execution',command:cmd,exit_code:0,aggregated_output:'ok'}});
  fs.appendFileSync('sessions',JSON.stringify({prompt,pid:process.pid})+'\\n');
  if(prompt.includes('Ты планировщик')){
    result({questions:[],tasks:[{title:'Format',text:'Continue formatting',files:['format.js'],rules:[],checks:['node format.js']}]});
  }else if(prompt.includes('Ты независимый проверяющий')){
    command('verification','node format.js');
    result({status:'passed',summary:'ran CLI',fixtures:[],checks:[{requirement:'works',expected:'ok',actual:'ok',passed:true}]});
  }else if(!prompt.includes('Автопередача по заполнению контекста')){
    fs.writeFileSync('format.js','// partial implementation\\n');
    command('edit','node edit-format.js');
    say('thread.token_usage.updated',{tokenUsage:{last:{totalTokens:85},total:{totalTokens:8000},modelContextWindow:100}});
    setInterval(()=>{},1000);
  }else{
    if(!fs.readFileSync('format.js','utf8').includes('partial implementation'))process.exit(2);
    fs.appendFileSync('format.js',"console.log('ok');\\n");
    result({status:'done',summary:'finished implementation'});
  }
});
`;

function project(t) {
  const root=mkdtempSync(path.join(tmpdir(),'pilot-context-rotate-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});
  return root;
}

test('a real threshold event rotates only the unfinished task and preserves its exact next input',t=>{
  const root=project(t);
  const bin=toolDirectory(t);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,PILOT_CODEX_TRANSPORT:'exec',PILOT_CONTEXT_THRESHOLD_PERCENT:'85'};
  const pilot=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',timeout:15000});
  writeFileSync(path.join(bin,'codex'),fake,{mode:0o755});
  pilot('init');
  pilot('idea','Implement formatting');
  const [file]=readdirSync(path.join(root,'.pilot/ideas'));
  const plan=JSON.parse(readFileSync(path.join(root,'.pilot/ideas',file),'utf8'));
  const [task]=plan.tasks;
  const sessions=readFileSync(path.join(root,'sessions'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(plan.state,'done');assert.equal(task.state,'done');assert.equal(sessions.length,4);
  assert.notEqual(sessions[1].pid,sessions[2].pid);
  const [transfer]=plan.contextTransfers;
  assert.equal(plan.contextTransfers.length,1);
  assert.deepEqual([transfer.stage,transfer.fromAttempt,transfer.toAttempt,transfer.used,transfer.window],[task.id,1,2,85,100]);
  assert.match(sessions[2].prompt,/Автопередача по заполнению контекста/);
  assert.match(sessions[2].prompt,/node edit-format\.js/);
  assert.match(sessions[2].prompt,/\?\? format\.js/);
  assert.equal(pilot('packet',task.id,'2'),sessions[2].prompt);
});

test('pilot run archives a separate task across attempts and exports its actual context transfer',t=>{
  const root=project(t);
  const bin=toolDirectory(t);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,PILOT_CODEX_TRANSPORT:'exec',PILOT_CONTEXT_THRESHOLD_PERCENT:'85'};
  const pilot=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',timeout:15000});
  writeFileSync(path.join(bin,'codex'),fake,{mode:0o755});
  pilot('init');
  pilot('task','FORMAT','Format output','--file','format.js');
  pilot('run','FORMAT','--workspace-write');
  const sessions=readFileSync(path.join(root,'sessions'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(sessions.length,2);
  assert.match(sessions[1].prompt,/node edit-format\.js/);
  assert.equal(pilot('packet','FORMAT','2'),sessions[1].prompt);
  assert.match(pilot('handoff','FORMAT'),/Сессия 1 → 2 · 85 из 100 токенов/);
});

test('stop takes priority over a simultaneous capacity handoff, and repeated full attempts are bounded',async t=>{
  const root=project(t),logs=path.join(root,'.git','context-pilot','runs');
  mkdirSync(logs,{recursive:true});
  const manual=new AbortController();
  const options={
    root,logs,stage:'ticket',prompt:'Original objective',policy:{thresholdPercent:85,maxTransfers:1},
    signal:manual.signal,assertRunning:()=>manual.signal.throwIfAborted(),onTransfer:()=>assert.fail('manual stop should win'),
    runAttempt:async(prompt,n,signal,measure)=>{measure({used:85,window:100});manual.abort('user stop');return 130;}
  };
  await assert.rejects(runContextStage(options),reason=>reason==='user stop');
  let count=0,transfers=0;
  const stable=new AbortController();
  await assert.rejects(runContextStage({...options,stage:'other',signal:stable.signal,
    assertRunning:()=>stable.signal.throwIfAborted(),onTransfer:()=>{transfers++;},
    runAttempt:async(prompt,n,signal,measure)=>{
      measure({used:84,window:100});assert.equal(signal.aborted,false);
      measure({used:85,window:100});assert.equal(signal.reason,count===0?'context-rotation':'context-capacity-limit');
      count++;return 130;
    }}),ContextCapacityError);
  assert.equal(count,2);assert.equal(transfers,1);
});

test('third session receives unique observations from both earlier attempts in this chain only',async t=>{
  const root=project(t),logs=path.join(root,'.git','context-pilot','runs'),stage='research';
  mkdirSync(logs,{recursive:true});
  const signal=new AbortController().signal;
  function record(attempt,notes) {
    const entries=notes.map(([text,itemType])=>({
      task:stage,state:'running',attempt,pid:process.pid,time:new Date().toISOString(),text,itemType
    }));
    writeFileSync(path.join(logs,attempt+'.jsonl'),entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  }
  savePacket(logs,stage,1,'earlier separate dispatch');
  record(1,[['PRIVATE EARLIER TASK','agent_message']]);
  let final='';
  const code=await runContextStage({root,logs,stage,prompt:'Inspect monthly totals',policy:{thresholdPercent:85,maxTransfers:3},
    signal,assertRunning:()=>{},onTransfer:()=>{},runAttempt:async(prompt,attempt,_signal,measure)=>{
      if(attempt===4){final=prompt;return 0;}
      record(attempt,[[attempt===2?'January has 27 invoices':'March has 19 invoices','agent_message'],
        ['Код 0 · node totals.js','command_execution'],['Файлы · totals.js','file_change'],['{"debug":"RAW PAYLOAD"}','agent_message']]);
      measure({used:91,window:100});return 130;
    }});
  assert.equal(code,0);
  assert.match(final,/January has 27 invoices/);assert.match(final,/March has 19 invoices/);
  assert.equal(final.split('node totals.js').length,2);
  assert.equal(final.split('Автопередача по заполнению контекста').length,2);
  assert.doesNotMatch(final,/PRIVATE EARLIER TASK|RAW PAYLOAD/);
});
