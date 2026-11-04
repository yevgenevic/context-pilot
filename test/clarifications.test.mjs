import {toolDirectory} from './support/tool-directory.mjs';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
test('questions survive a restart; only a complete answer starts one plan, worker and review',async t=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'pilot-questions-'));
  const bin=toolDirectory(t);
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync(process.execPath,[cli,'init'],{cwd});
  writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node
if (process.argv[2]==='login' && process.argv[3]==='status') { console.error('Logged in using ChatGPT'); process.exit(0); }
const fs=require('node:fs');let prompt='';
process.stdin.on('data',c=>prompt+=c).on('end',()=>{
  const schema=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--output-schema')+1]));
  const props=schema.properties;
  fs.appendFileSync('calls',JSON.stringify({prompt,writable:process.argv.includes('workspace-write')})+'\\n');
  let result;
  if(props.questions) result={tasks:[],questions:[{question:'Кто создаёт запись?',options:['Клиент','Администратор']},{question:'Куда отправить результат?',options:[]}]};
  else if(props.tasks) result={tasks:[{title:'Регистрация',text:'Реализовать выбранный сценарий',files:[],rules:[],checks:['проверить']} ]};
  else if(props.checks) {
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node app.js',exit_code:0,aggregated_output:'ok'}}));
    result={status:'passed',summary:'ok',checks:[{requirement:'print',expected:'ok',actual:'ok',passed:true}]};
  }else result={status:'done',summary:'ok'};
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
});`,{mode:0o755});
  let server,url;
  async function open(){
    server=spawn(process.execPath,[cli,'dashboard'],{cwd,env:{...process.env,PILOT_CODEX_TRANSPORT:'exec',PATH:bin+path.delimiter+process.env.PATH}});
    const [banner]=await once(server.stdout,'data');url=String(banner).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  }
  async function close(){const ended=once(server,'exit');server.kill();await ended;}
  await open();t.after(()=>server.kill());
  const send=(route,action,body,origin=url)=>fetch(url+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Pilot-Action':action},body:JSON.stringify(body)});
  async function wait(state){
    for(let i=0;i<150;i++){const data=await(await fetch(url+'/api/state')).json();if(data.plans[0]?.state===state)return data.plans[0];await delay(20);}
    assert.fail('No state '+state);
  }
  const response=await send('/api/ideas','start',{idea:'Хочу сервис записи'});assert.equal(response.status,202);
  const {id}=await response.json(), route='/api/ideas/'+id+'/answers';
  const first=await wait('awaiting_answers');assert.equal(first.tasks.length,0);
  assert.equal(first.clarifications.length,2);
  await close();await open();assert.deepEqual((await wait('awaiting_answers')).clarifications,first.clarifications);
  const answers={q1:'Только администратор стойки',q2:'В локальный CSV'};
  assert.equal((await send(route,'answers',{answers},'http://unrelated.local')).status,403);
  for(const invalid of [{q1:'Клиент'},{q1:' ',q2:'CSV'},{q1:'Клиент',other:'CSV'},null]) {
    assert.equal((await send(route,'answers',{answers:invalid})).status,400);
  }
  assert.equal(readFileSync(path.join(cwd,'calls'),'utf8').trim().split('\n').length,1);
  const results=await Promise.all([send(route,'answers',{answers}),send(route,'answers',{answers})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[202,400]);
  const done=await wait('done');assert.equal(done.idea,first.idea);
  assert.deepEqual(done.clarifications.map(q=>q.answer),Object.values(answers));
  const calls=readFileSync(path.join(cwd,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls.map(c=>c.writable),[false,false,true,false]);
  for(const call of calls.slice(1))for(const answer of Object.values(answers))assert.ok(call.prompt.includes(answer));
});
