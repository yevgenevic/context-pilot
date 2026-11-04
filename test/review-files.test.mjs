import {toolDirectory} from './support/tool-directory.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
const fake = `#!/usr/bin/env node
if (process.argv[2]==='login' && process.argv[3]==='status') { console.error('Logged in using ChatGPT'); process.exit(0); }
const fs=require('node:fs');
const args=process.argv;
const props=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1])).properties;
let prompt='';
process.stdin.on('data',c=>prompt+=c).on('end',()=>{
  let answer;
  if(props.tasks) answer={questions:[],tasks:[{title:'report',text:'report',files:[],rules:[],checks:['check file']}]};
  else if(!props.checks) answer={status:'done',summary:'ready'};
  else {
    if(!args.includes('read-only')) process.exit(3);
    const fileName=fs.existsSync('bad-name')?'../escape':'rows.json';
    if(!prompt.includes('Координатор подготовил обычные входные файлы')) {
      answer={status:'needs_files',summary:'need rows',checks:[],fixtures:[{name:fileName,content:'[30,45,20]'}]};
    } else {
      const [file]=JSON.parse(prompt.split('\\n\\n').at(-1));
      if(file.path.startsWith(process.cwd()+'/')) process.exit(4);
      const total=JSON.parse(fs.readFileSync(file.path,'utf8')).reduce((a,b)=>a+b,0);
      console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'read '+file.path,exit_code:0,aggregated_output:String(total)}}));
      answer={status:'passed',summary:'file checked',checks:[{requirement:'total',expected:'95',actual:String(total),passed:total===95}],fixtures:[]};
    }
  }
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}}));
});`;
for(const invalid of [false,true])test(invalid?'reject fixture traversal before materialization':'review reads a regular file outside the project and cleans it up', t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'pilot-fixture-test-'));
  const bin=toolDirectory(t);
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync(process.execPath,[cli,'init'],{cwd});
  writeFileSync(path.join(bin,'codex'),fake,{mode:0o755});
  if(invalid) writeFileSync(path.join(cwd,'bad-name'),'');
  const job=spawnSync(process.execPath,[cli,'idea','Test file totals'],{cwd,env:{...process.env,PILOT_CODEX_TRANSPORT:'exec',PATH:bin+path.delimiter+process.env.PATH}});
  const dir=path.join(cwd,'.pilot/ideas');
  const plan=JSON.parse(readFileSync(path.join(dir,readdirSync(dir)[0])));
  if(invalid) {
    assert.equal(job.status,1);assert.match(plan.error,/Некорректный входной файл/);
    return;
  }
  assert.equal(job.status,0,String(job.stderr));
  const verdict=plan.verification.reports.at(-1);
  assert.equal(verdict.commands[0].output,'95');
  const file=verdict.commands[0].command.slice('read '.length);
  assert.equal(existsSync(path.dirname(file)),false);
  const archived=execFileSync(process.execPath,[cli,'packet',plan.id+'-verify','2'],{cwd,encoding:'utf8'});
  assert.ok(archived.includes('[30,45,20]'));
});
