import {toolDirectory} from './support/tool-directory.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkEvidence,requiredCommands,rootPrefix} from '../src/acceptance.ts';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
const fake=`#!/usr/bin/env node
if(process.argv[2]==='login' && process.argv[3]==='status'){console.error('Logged in using ChatGPT');process.exit(0);}
const {spawnSync}=require('node:child_process');
let prompt='';
process.stdin.on('data',c=>prompt+=c).on('end',()=>{
  let result;
  if(prompt.includes('Ты планировщик')) result={questions:[],tasks:[{title:'One',text:'Build it',files:[],rules:[],checks:['behaviour'],acceptanceCommands:[]}]};
  else if (prompt.includes('Ты независимый проверяющий')) {
    if(!prompt.includes('npm test')) process.exit(8);
    delete process.env.NODE_TEST_CONTEXT;
    const proc=spawnSync('npm',['test'],{encoding:'utf8'});
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:"/bin/zsh -lc 'npm test'",cwd:process.cwd(),exit_code:proc.status,aggregated_output:proc.stdout+proc.stderr}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'pwd',cwd:process.cwd(),exit_code:0,aggregated_output:process.cwd()}}));
    result={status:'passed',summary:'All green',checks:[{requirement:'total',expected:'95',actual:'95',passed:true}]};
  } else result={status:'done',summary:'Work complete'};
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
});`;

test('a real failed npm test overrides the verifier twice, even when the plan omits npm test',t=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'pilot-acceptance-'));
  const bin=toolDirectory(t);
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync(process.execPath,[cli,'init'],{cwd});
  writeFileSync(path.join(bin,'codex'),fake,{mode:0o755});
  writeFileSync(path.join(cwd,'package.json'),JSON.stringify({name:'pilot-trial',scripts:{test:'node --test actual.test.cjs'}}));
  writeFileSync(path.join(cwd,'actual.test.cjs'),"require('node:test')('correct total',()=>require('node:assert/strict').equal(94,95));");
  const result=spawnSync(process.execPath,[cli,'idea','Calculate totals'],{cwd,encoding:'utf8',env:{...process.env,
    PILOT_CODEX_TRANSPORT:'exec',PATH:bin+path.delimiter+process.env.PATH,npm_config_cache:path.join(cwd,'npm-cache')}});
  assert.equal(result.status,1,result.stdout+result.stderr);
  const dir=path.join(cwd,'.pilot/ideas');
  const plan=JSON.parse(readFileSync(path.join(dir,readdirSync(dir)[0])));
  assert.equal(plan.state,'failed');
  assert.deepEqual(plan.verification.requiredCommands,['npm test']);
  assert.deepEqual(plan.verification.reports.map(r=>r.status),['failed','failed']);
  for(const report of plan.verification.reports) {
    assert.match(report.summary,/npm test \(код 1\)/);
    assert.match(report.checks[0].actual,/94 !== 95/);
  }
});

test('an unrelated command, wrong directory, masked failure, or absent exit code cannot satisfy an exact gate',()=>{
  const root=process.cwd();
  const command=(command,exitCode,cwd=root)=>({command,output:'',exitCode,cwd});
  assert.deepEqual(requiredCommands([{checks:['Run `npm test` before delivery','verify the output'],acceptanceCommands:['node negative-input.test.js']}],[]),
    ['node negative-input.test.js','npm test']);
  const inline=`node -e "const n=2; require('node:assert').equal(n,2)"`;
  assert.deepEqual(requiredCommands([{checks:[],acceptanceCommands:[inline]}],[]),[inline]);
  assert.throws(()=>requiredCommands([{checks:[],acceptanceCommands:['npm test || true']}],[]),/отдельной командой/);
  for (const invalid of [
    command('true',0),command("bash -lc 'npm test || true'",0),
    command("bash -lc 'npm test'",0,path.dirname(root)),command('npm test',null),{command:'npm test',exitCode:0,output:''}
  ]) assert.deepEqual(checkEvidence(['npm test'],[invalid],root).missing,['npm test']);
  assert.equal(checkEvidence(['npm test'],[{command:rootPrefix(root)+'npm test',exitCode:0,output:''}],root).checks[0].passed,true);
  assert.deepEqual(checkEvidence(['npm test'],[command('npm test',1),command('npm test',0)],root).failed,['npm test (код 1)']);
  // A test that asserts expected errors via its own zero exit is valid.
  assert.equal(checkEvidence(['node negative-input.test.js'],[command('node app.js bad-input',2),command('/bin/bash -lc "node negative-input.test.js"',0)],root).checks[0].passed,true);
});
