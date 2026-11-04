import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {handoff} from '../src/handoff.ts';
import {packets} from '../src/packets.ts';
import {redactSecrets} from '../src/privacy.ts';
import {runContextStage} from '../src/rotation.ts';
import {pauseChanges, recordPause} from '../src/pause-changes.ts';

test('credentials in a previous command, task, or note do not travel with the next session or Markdown export', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pilot-redaction-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  execFileSync('git', ['init','-q'], {cwd:root});
  const logs = path.join(root,'.git','context-pilot','runs');
  mkdirSync(logs, {recursive:true});
  const stage = 'retry';
  const credential = 'synthetic-demo-value';
  const command = 'Код 0 · curl -H "Authorization: Bearer '+credential+'" https://example.invalid/status';
  const inputs = [];
  await runContextStage({
    root, logs, stage, policy:{thresholdPercent:85, maxTransfers:3},
    prompt:'Inspect status. Example: postgresql://alice:'+credential+'@example.invalid/db',
    signal:new AbortController().signal, assertRunning:()=>{}, onTransfer:()=>{},
    runAttempt:async (prompt, attempt, _signal, measure) => {
      inputs.push(prompt);
      if (attempt === 1) {
        // An old raw log can still be present after an upgrade.
        const entry={time:new Date().toISOString(), state:'running', pid:process.pid, task:stage,
          attempt, text:command, itemType:'command_execution'};
        writeFileSync(path.join(logs,'old.jsonl'), JSON.stringify(entry)+'\n');
        measure({used:88, window:100});
        return 130;
      }
      return 0;
    }
  });
  assert.equal(inputs.length,2);
  assert.deepEqual(packets(logs,stage), inputs);
  assert.ok(inputs.every(p => !p.includes(credential)));
  assert.match(inputs[1], /example\.invalid\/status/);
  const md = handoff({root, stage, rules:[], attempts:2, changes:null,
    notes:[{text:'Set API_KEY='+credential, time:'2026-01-01'}],
    run:{state:'done', events:[{text:command}]}});
  assert.ok(!md.includes(credential));
  assert.match(md,/Код 0 · curl/);
  assert.match(md,/API_KEY=\[скрыто\]/);
  assert.equal(redactSecrets(md),md);
});

test('an ordinary config file containing URL credentials gets only a path-level change after a pause',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'pilot-private-preview-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root});
  git('init','-q');
  const file=path.join(root,'settings.js');
  writeFileSync(file,"export const connection='postgresql://localhost/db';\n");
  git('add','settings.js');
  git('-c','user.name=Dev','-c','user.email=dev@local','commit','-qm','baseline');
  const logs=path.join(root,'.git/context-pilot/runs');
  const plan={id:'P-abc12345',session:'15da9931-1688-4914-927d-cdf17fbe5a0c',tasks:[],state:'interrupted'};
  plan.pauses=[recordPause(root,logs,plan.id,plan.session,plan.id+'-plan',1)];
  writeFileSync(file,"export const connection='postgresql://reader:synthetic-password@example.invalid/db';\n");
  const changes=pauseChanges(root,logs,plan);
  assert.deepEqual(changes.files,[{path:'settings.js',change:'modified'}]);
  assert.doesNotMatch(JSON.stringify(changes),/synthetic-password/);
});

test('agent output with a synthetic credential is masked in the journal and tracked verification report',t=>{
  const base=mkdtempSync(path.join(tmpdir(),'pilot-private-report-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'project'),bin=path.join(base,'bin');
  mkdirSync(root);mkdirSync(bin);
  execFileSync('git',['init','-q'],{cwd:root});
  const secret='synthetic-unit-canary';
  writeFileSync(path.join(bin,'codex'), `#!${process.execPath}
const fs=require('fs');
if(process.argv[2]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
const prompt=fs.readFileSync(0,'utf8');
const emit=item=>console.log(JSON.stringify({type:'item.completed',item}));
let reply;
if (prompt.includes('Ты планировщик')) reply={questions:[],tasks:[{title:'Read file',text:'Inspect',files:[],rules:[],checks:['Output'],acceptanceCommands:[]}]};
else if(prompt.includes('Ты независимый проверяющий')){
  emit({type:'command_execution',command:'node inspect.js',cwd:process.cwd(),exit_code:0,aggregated_output:'Output OK; API_KEY=${secret}'});
  reply={status:'passed',summary:'Output OK',checks:[{requirement:'Output',expected:'OK',actual:'OK',passed:true}]};
} else reply={status:'done',summary:'Output OK; Authorization: Bearer ${secret}'};
emit({type:'agent_message',text:JSON.stringify(reply)});
`,{mode:0o755});
  const cli=new URL('../src/pilot.ts',import.meta.url).pathname;
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,PILOT_CODEX_TRANSPORT:'exec'};
  const pilot=(...args)=>execFileSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8'});
  pilot('init');
  assert.ok(!pilot('idea','Read the sample').includes(secret));
  const plans=path.join(root,'.pilot/ideas');
  const plan=JSON.parse(readFileSync(path.join(plans,readdirSync(plans)[0]),'utf8'));
  assert.equal(plan.state,'done');
  assert.match(plan.verification.reports[0].commands[0].output,/Output OK/);
  assert.ok(!JSON.stringify(plan).includes(secret));
  const logs=path.join(root,'.git/context-pilot/runs');
  for(const log of readdirSync(logs)) assert.ok(!readFileSync(path.join(logs,log),'utf8').includes(secret));
});
