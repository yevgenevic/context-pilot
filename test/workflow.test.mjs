import test from 'node:test';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toolDirectory} from './support/tool-directory.mjs';
import {createBlindCopy,prepareBlindDependencies} from '../src/blind-copy.ts';
import {requirementCoverage,newWorkflow,setPhase} from '../src/workflow.ts';
const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));

for(const failure of ['repair','G2','G3','evidence','pause','source-drift','copy-write','baseline-write','review-copy-write','review-source-drift','temporary-output'])test('eight stages and acceptance gate '+failure,async t=>{
  const success=failure==='repair'||failure==='temporary-output';
  const root=mkdtempSync(path.join(tmpdir(),'pilot-eight-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=toolDirectory(t), audit=path.join(bin,'audit');
  const env={...process.env,PILOT_WORKFLOW:'eight',PILOT_CODEX_TRANSPORT:'exec',PILOT_EIGHT_AUDIT:audit,PILOT_EIGHT_FAILURE:failure,PILOT_EIGHT_SOURCE:root,PATH:bin+path.delimiter+process.env.PATH};
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync(process.execPath,[cli,'init'],{cwd:root,env});
  writeFileSync(path.join(root,'app.js'),'console.log(41)');
  writeFileSync(path.join(root,'AGENTS.md'),'AUTHOR_ONLY_SECRET');
  writeFileSync(path.join(root,'.env'),'PRIVATE=hidden');
  writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
if(process.argv[2]==='login'){console.error('Logged in using ChatGPT');process.exit(0)}
let p='';process.stdin.on('data',c=>p+=c).on('end',()=>{
 const req=[{id:'R-1',text:'Print 42'}];let r;const mode=process.env.PILOT_EIGHT_FAILURE;
 const event=item=>console.log(JSON.stringify({type:'item.completed',item}));
 fs.appendFileSync(process.env.PILOT_EIGHT_AUDIT,JSON.stringify({cwd:process.cwd(),args:process.argv,p})+'\\n');
 if(mode==='temporary-output' && (p.includes('Ты проводишь слепую')||p.includes('Ты независимый проверяющий'))){fs.writeFileSync('.test-output','temporary');fs.unlinkSync('.test-output');}
 if(p.includes('Ты аналитик требований'))r={requirements:req};
 else if(p.includes('Ты проводишь брифинг'))r={questions:[]};
 else if(p.includes('Ты проектируешь спецификацию'))r={summary:'CLI app.js prints 42',requirements:req};
 else if(p.includes('Ты независимый читатель'))r={passed:mode!=='G2',issues:mode==='G2'?['lost original requirement']:[]};
 else if(p.includes('Ты планировщик'))r={tasks:[{title:'output',text:'implement output',files:['app.js'],rules:[],checks:['Print 42'],acceptanceCommands:[],requirementIds:mode==='G3'?[]:['R-1']}]};
 else if(p.includes('Ты проводишь слепую')){
  if(mode==='pause'){setInterval(()=>{},1000);return;}
  if(fs.existsSync('.pilot')||fs.existsSync('AGENTS.md')||fs.existsSync('.env'))throw Error('leaked memory');
  if(p.includes('CLI app.js prints 42')||p.includes('AUTHOR_ONLY_SECRET'))throw Error('leaked author output');
  if(mode==='source-drift')fs.writeFileSync(require('path').join(process.env.PILOT_EIGHT_SOURCE,'app.js'),'console.log(42)');
  if(mode==='copy-write')fs.writeFileSync('app.js','console.log(42)');
  if(mode==='baseline-write'){const baseline=p.match(/здесь: (.+?)\\. Это исходная/)[1];fs.writeFileSync(require('path').join(baseline,'app.js'),'console.log(42)');}
  const actual=cp.execFileSync(process.execPath,['app.js'],{encoding:'utf8'}).trim();
  if(mode!=='evidence')event({type:'command_execution',command:'node app.js',exit_code:0,aggregated_output:actual});
  r={status:actual==='42'?'passed':'failed',summary:actual==='42'?'OK':'Wrong stdout',checks:[{requirement:'Print 42',expected:'42',actual,passed:actual==='42'}],fixtures:[]};
 }else if(p.includes('Ты независимый проверяющий')){
  if(process.cwd()===process.env.PILOT_EIGHT_SOURCE)throw Error('review must use a separate copy');
  if(mode==='review-copy-write')fs.writeFileSync('app.js','console.log(42)');
  if(mode==='review-source-drift')fs.writeFileSync(require('path').join(process.env.PILOT_EIGHT_SOURCE,'app.js'),'console.log(42)');
  event({type:'command_execution',command:'node app.js',exit_code:0,aggregated_output:'41'});
  r={status:'passed',summary:'Code reviewed',checks:[{requirement:'code',expected:'exists',actual:'exists',passed:true}],fixtures:[]};
 }else {if(p.includes('Wrong stdout'))fs.writeFileSync('app.js','console.log(42)');r={status:'done',summary:'AUTHOR_ONLY_SECRET'};}
 event({type:'agent_message',text:JSON.stringify(r)});
});`,{mode:0o755});
  const run=()=>execFileSync(process.execPath,[cli,'idea','Print 42 from node app.js'],{cwd:root,env,stdio:'pipe'});
  if(failure==='pause') {
    const child=spawn(process.execPath,[cli,'idea','Print 42 from node app.js'],{cwd:root,env,stdio:'ignore'});
    t.after(()=>child.kill());const exited=once(child,'exit');
    let state;
    for(let n=0;n<300;n++) {
      const folder=path.join(root,'.pilot/ideas');
      const files=existsSync(folder)?readdirSync(folder).filter(f=>f.endsWith('.json')):[];
      if(files.length){state=JSON.parse(readFileSync(path.join(root,'.pilot/ideas',files[0])));if(state.workflow.blindCopies.length)break;}
      await delay(20);
    }
    assert.ok(state.workflow.blindCopies.length);
    execFileSync(process.execPath,[cli,'stop',state.id],{cwd:root,env,stdio:'pipe'});
    assert.equal((await exited)[0],130);
    const paused=JSON.parse(readFileSync(path.join(root,'.pilot/ideas',state.id+'.json')));
    assert.equal(paused.workflow.phases.at(-1).state,'interrupted');
    assert.equal(paused.workflow.blindCopies.at(-1).state,'interrupted');
    execFileSync(process.execPath,[cli,'resume',state.id],{cwd:root,env:{...env,PILOT_EIGHT_FAILURE:'repair'},stdio:'pipe'});
    const done=JSON.parse(readFileSync(path.join(root,'.pilot/ideas',state.id+'.json')));
    assert.equal(done.state,'done');assert.ok(done.workflow.blindCopies.length>=2);
    return;
  }
  if(success)run();else assert.throws(run);
  const plan=JSON.parse(readFileSync(path.join(root,'.pilot/ideas',readdirSync(path.join(root,'.pilot/ideas'))[0])));
  if(!success) {
    assert.equal(plan.state,'failed');
    const point=failure==='G2'?'spec':failure==='G3'?'plan':failure.startsWith('review-')?'review':'accept';
    assert.equal(plan.workflow.phases.find(p=>p.id===point).state,'failed');
    if(failure==='G2'||failure==='G3')assert.ok(plan.tasks.every(t=>t.state==='pending'));
    else assert.equal(plan.verification.reports.at(-1).status,'blocked');
    if(failure==='G2'||failure==='evidence') {
      execFileSync(process.execPath,[cli,'resume',plan.id],{cwd:root,env:{...env,PILOT_EIGHT_FAILURE:'repair'},stdio:'pipe'});
      const resumed=JSON.parse(readFileSync(path.join(root,'.pilot/ideas',plan.id+'.json')));
      assert.equal(resumed.state,'done');
      assert.ok(resumed.workflow.phases.every(p=>p.state==='done'));
    }
    return;
  }
  assert.equal(plan.state,'done');
  assert.equal(plan.workflow.phases.length,8);
  assert.ok(plan.workflow.phases.every(p=>p.state==='done'));
  assert.deepEqual(plan.verification.reports.filter(r=>r.kind==='blind').map(r=>r.status),['failed','passed']);
  assert.equal(plan.workflow.blindCopies.length,2);
  assert.notEqual(plan.workflow.blindCopies[0].digest,plan.workflow.blindCopies[1].digest);
  const attempts=readFileSync(audit,'utf8').trim().split('\n').map(x=>JSON.parse(x));
  const blind=attempts.filter(x=>x.p.includes('Ты проводишь слепую'));
  assert.equal(blind.length,2);
  const reviews=attempts.filter(x=>x.p.includes('Ты независимый проверяющий'));
  assert.ok(reviews.every(x=>x.cwd!==root && !existsSync(x.cwd)));
  assert.ok([...blind,...reviews].every(x=>x.args.includes('workspace-write')));
  assert.notEqual(blind[0].cwd,root);assert.notEqual(blind[0].cwd,blind[1].cwd);
  assert.ok(blind.every(x=>!existsSync(x.cwd)));
  assert.match(readFileSync(path.join(root,'app.js'),'utf8'),/42/);
});

test('G3 rejects forgotten and unknown requirements',()=>{
  const req=[{id:'R-1',text:'one'},{id:'R-2',text:'two'}];
  assert.throws(()=>requirementCoverage(req,[{id:'one',requirementIds:['R-1']}]),/R-2/);
  assert.throws(()=>requirementCoverage(req,[{id:'one',requirementIds:['R-3']}]),/G3/);
});

test('blind copy includes uncommitted work, excludes memory, and detects writes',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'pilot-copy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});writeFileSync(path.join(root,'app.js'),'before');
  writeFileSync(path.join(root,'.env'),'SECRET');writeFileSync(path.join(root,'AGENTS.md'),'author');
  const copy=createBlindCopy(root);t.after(copy.cleanup);
  assert.equal(readFileSync(path.join(copy.root,'app.js'),'utf8'),'before');
  assert.equal(existsSync(path.join(copy.root,'.env')),false);
  writeFileSync(path.join(copy.root,'app.js'),'after');
  assert.equal(copy.unchanged(),false);assert.equal(readFileSync(path.join(root,'app.js'),'utf8'),'before');
});


test('blind copy rejects an external symlink',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'pilot-copy-link-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});
  symlinkSync('/etc/passwd',path.join(root,'app.js'));
  assert.throws(()=>createBlindCopy(root),/символические ссылки/);
});

test('locked copy dependencies are installed without lifecycle scripts',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'pilot-copy-deps-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});
  const vendor=path.join(root,'vendor/demo');mkdirSync(vendor,{recursive:true});
  writeFileSync(path.join(vendor,'package.json'),JSON.stringify({name:'pilot-fixture-local',version:'1.0.0',scripts:{install:'node -e "require(\\\'fs\\\').writeFileSync(\\\'BAD_SCRIPT\\\',\\\'bad\\\')"'}}));
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{'pilot-fixture-local':'file:vendor/demo'}}));
  const npmEnv={...process.env};
  for(const key of Object.keys(npmEnv))if(/^npm_config_allow_scripts$/i.test(key))delete npmEnv[key];
  execFileSync('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,env:npmEnv,stdio:'pipe'});
  const copy=createBlindCopy(root);t.after(copy.cleanup);
  await prepareBlindDependencies(copy.root,new AbortController().signal);
  assert.ok(existsSync(path.join(copy.root,'node_modules/pilot-fixture-local/package.json')));
  assert.equal(existsSync(path.join(copy.root,'vendor/demo/BAD_SCRIPT')),false);
  assert.equal(existsSync(path.join(root,'node_modules')),false);
  assert.equal(copy.unchanged(),true);
});


test('new projects can preserve an empty baseline without accepting an empty result',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'pilot-empty-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});
  const copy=createBlindCopy(root,{allowEmpty:true});t.after(copy.cleanup);
  assert.equal(copy.record.files,0);assert.equal(copy.unchanged(),true);
  const restored=createBlindCopy(copy.root,{files:copy.files,allowEmpty:true});t.after(restored.cleanup);
  assert.equal(restored.record.digest,copy.record.digest);
  assert.throws(()=>createBlindCopy(root),/нет файлов/);
});


test('retry clears the previous phase failure from its live status',()=>{
  const workflow=newWorkflow();
  setPhase(workflow,'review','failed','previous failure');
  setPhase(workflow,'review','running');
  const phase=workflow.phases.find(p=>p.id==='review');
  assert.equal(phase.summary,undefined);assert.equal(phase.ended,undefined);
});
