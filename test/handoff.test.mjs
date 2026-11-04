import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordPause,freezePause} from '../src/pause-changes.ts';

const cli=fileURLToPath(new URL('../src/pilot.ts',import.meta.url));
test('portable Markdown identifies code needed by the recipient and separates requirements from real checks',async t=>{
  const cwd=mkdtempSync(path.join(tmpdir(),'pilot-handoff-test-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  const pilot=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',stdio:'pipe'});
  const write=(name,body)=>writeFileSync(path.join(cwd,name),body);
  const commit=()=>git('-c','user.name=Dev','-c','user.email=dev@local','commit','-qm','rev');
  git('init','-qb','main');write('app.js','module.exports = 1;');git('add','app.js');commit();
  const base=git('rev-parse','HEAD');
  pilot('init');pilot('rule','R1','Use calendar days');pilot('task','TASK','Add totals','--rule','R1','--file','app.js','--check','node test-total.js');
  write('app.js','module.exports = 2;');write('format.js','const unit = "hours";\n');git('add','app.js','format.js');commit();const head=git('rev-parse','HEAD');
  write('app.js','module.exports = 3;');write('untracked file.txt','DO_NOT_EXPORT_CONTENT');
  let md=pilot('handoff','TASK');
  for (const needle of [base,head,'main','Use calendar days','node test-total.js','?? "untracked file.txt"','M app.js','отсутствует']) assert.ok(md.includes(needle),needle);
  assert.doesNotMatch(md,/DO_NOT_EXPORT_CONTENT|\.pilot\/rules\/R1/);

  const id='P-12345678',stage=id+'-2',summary='use computeTotal from totals.js';
  const report={status:'passed',summary:'CLI returned 21',checks:[{passed:true,requirement:'two days',expected:'21',actual:'21 minutes'}],
    commands:[{command:'node test-total.js',exitCode:0,output:'UNRELATED_RAW_OUTPUT'}]};
  mkdirSync(path.join(cwd,'.pilot','ideas'));
  const session='14da9931-1688-4914-927d-cdf17fbe5a0c';
  const logs=path.join(cwd,'.git','context-pilot','runs');
  const plan={id,created:'2026-11-01',pid:0,state:'interrupted',idea:'Report totals',error:'',session,
    tasks:[{id:id+'-1',title:'Compute',text:'Compute',state:'done',summary,base,files:['totals.js'],checks:[],rules:[]},
           {id:stage,title:'Print totals',text:'Print from CLI',state:'interrupted',summary:'Result from '+cwd+'/app.js',base,files:['app.js','format.js'],checks:['node test-total.js'],rules:['R1']}],
    verification:{state:'pending',reports:[]}};
  plan.pauses=[recordPause(cwd,logs,id,session,stage,1)];
  write('format.js','const unit = "minutes";\n');
  const save=()=>write('.pilot/ideas/'+id+'.json',JSON.stringify(plan));save();
  const paused=pilot('handoff',stage);
  assert.match(paused,/Сверь файлы с изменениями после остановки/);assert.match(paused,/\+ const unit = "minutes"/);
  freezePause(cwd,logs,plan);plan.state='done';plan.tasks[1].state='done';plan.verification={state:'done',reports:[report]};save();
  write('format.js','const unit = "days";\n');
  md=pilot('handoff',stage);
  assert.match(md,/\+ const unit = "minutes"/);assert.doesNotMatch(md,/"days"/);
  assert.ok(md.includes(summary));assert.ok(md.includes('Наблюдалось: 21 minutes'));assert.ok(md.includes('Код 0 · node test-total.js'));
  assert.ok(!md.includes(cwd));assert.ok(!md.includes('UNRELATED_RAW_OUTPUT'));
  assert.ok(pilot('handoff',id+'-plan').includes('План работ'));
  assert.ok(pilot('handoff',id+'-verify').includes('Приёмка результата'));

  const server=spawn(process.execPath,[cli,'dashboard'],{cwd});t.after(()=>server.kill());
  const [banner]=await once(server.stdout,'data');
  const url=String(banner).match(/http:\/\/127\.0\.0\.1:\d+/)[0]+'/api/handoff?task=';
  const res=await fetch(url+stage);
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/markdown/);
  assert.match(res.headers.get('content-disposition'),/attachment; filename="handoff-P-12345678-2.md"/);
  assert.equal(await res.text(),md);
  assert.equal((await fetch(url+'UNKNOWN')).status,400);
  assert.equal((await fetch(url+'..%2Fsecret')).status,400);
  assert.equal((await fetch(url+stage,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
});
