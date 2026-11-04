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

const cli = fileURLToPath(new URL('../src/pilot.ts', import.meta.url));
test('one idea starts fresh processes, hands off results and stops at a blocked task', async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pilot-idea-'));
  const bin=toolDirectory(t);
  t.after(() => rmSync(cwd, {force:true,recursive:true}));
  execFileSync('git', ['init','-q'], {cwd});
  execFileSync(process.execPath, [cli,'init'], {cwd});
  const fake = `#!/usr/bin/env node
if (process.argv[2]==='login' && process.argv[3]==='status') { console.error('Logged in using ChatGPT'); process.exit(0); }
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync('calls', JSON.stringify({args,prompt,pid:process.pid})+'\\n');
  const planner = args.includes('read-only');
  const result = planner
    ? {questions:[],tasks:['one','two','three'].map(title => ({title,text:'implement '+title,files:['app.js'],rules:[],checks:['verify']}))}
    : prompt.includes('implement two') ? {status:'blocked',summary:'Need a missing dependency'}
    : {status:'done',summary:'Import total from app.js'};
  setTimeout(() => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}})),150);
});`;
  writeFileSync(path.join(bin,'codex'),fake,{mode:0o755});
  const server = spawn(process.execPath,[cli,'dashboard'],{cwd,env:{...process.env,PILOT_CODEX_TRANSPORT:'exec',PATH:bin+path.delimiter+process.env.PATH}});
  t.after(()=>server.kill());
  const [banner] = await once(server.stdout,'data');
  const url = String(banner).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const submit = (origin) => fetch(url+'/api/ideas',{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Pilot-Action':'start'},body:JSON.stringify({idea:'Build a calculator'})});
  assert.equal((await submit('http://unrelated.local')).status,403);
  assert.equal((await submit(url)).status,202);
  assert.notEqual((await submit(url)).status,202);
  let state;
  for(let i=0;i<150;i++){
    state=await (await fetch(url+'/api/state')).json();
    if(state.plans[0]?.state==='failed') break;
    await delay(30);
  }
  const plan=state.plans[0];
  assert.deepEqual(plan.tasks.map(t=>t.state),['done','failed','pending']);
  assert.match(plan.error,/missing dependency/);
  const calls=readFileSync(path.join(cwd,'calls'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(new Set(calls.map(c=>c.pid)).size,3);
  assert.ok(calls.every(c=>c.args.includes('--ephemeral') && !c.args.includes('resume')));
  assert.equal(calls[1].args.includes('workspace-write'),true);
  assert.match(calls[2].prompt,/Import total from app.js/);
  assert.doesNotMatch(calls[2].prompt,/Ты планировщик/);
  assert.equal(execFileSync(process.execPath,[cli,'context',plan.tasks[1].id],{cwd,encoding:'utf8'}),calls[2].prompt);
});
