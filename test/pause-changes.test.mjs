import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync,truncateSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recordPause,pauseChanges,freezePause,describePause} from '../src/pause-changes.ts';

function project(t) {
  const dir=mkdtempSync(path.join(tmpdir(),'cp-pause-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'project');
  mkdirSync(root);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.email','test@example.invalid');git('config','user.name','Test');
  const logs=path.join(root,'.git','context-pilot','runs');
  const write=(name,txt)=>writeFileSync(path.join(root,name),txt);
  const id='P-abcdef01',stage=id+'-1';
  const plan={id,state:'interrupted',session:randomUUID(),tasks:[{id:stage,state:'interrupted'}],pauses:[]};
  return {root,logs,write,git,plan,stage};
}

test('paused content of tracked and existing untracked files is compared and freezes on resume',t=>{
  const {root,logs,write,git,plan,stage}=project(t);
  write('.gitignore','cache/\n');
  write('format.md','CSV uses comma\n');write('removed.md','removed later\n');write('unchanged.txt','old');write('partial.md','committed');
  git('add','.');git('commit','-qm','before pause');
  const before=git('rev-parse','HEAD');
  write('already-dirty.js','version one');write('unchanged.txt','same uncommitted work');write('partial.md','partial before pause');
  const ref=recordPause(root,logs,plan.id,plan.session,stage,1);
  plan.pauses.push(ref);
  write('already-dirty.js','version two');write('format.md','CSV uses semicolon\n');write('another.md','new');write('partial.md','partial after pause');
  unlinkSync(path.join(root,'removed.md'));
  mkdirSync(path.join(root,'cache'));write('cache/private','ignored text');
  mkdirSync(path.join(root,'.pilot'));write('.pilot/private','metadata');
  git('add','format.md');git('commit','-qm','during pause');
  const changes=pauseChanges(root,logs,plan,stage);
  assert.equal(changes.status,'live');assert.equal(changes.base,before);assert.equal(changes.head,git('rev-parse','HEAD'));
  assert.equal(changes.limited,false);
  assert.deepEqual(changes.files.map(f=>[f.path,f.change]),[['already-dirty.js','modified'],['another.md','added'],['format.md','modified'],['partial.md','modified'],['removed.md','deleted']]);
  assert.equal(changes.files.find(f=>f.path==='format.md').preview,'- CSV uses comma\n+ CSV uses semicolon');
  assert.ok(changes.files.filter(f=>f.path!=='format.md').every(f=>f.preview===undefined));
  const frozen=freezePause(root,logs,plan);
  assert.equal(frozen.status,'archived');assert.equal(frozen.resumedAt,ref.resumedAt);
  write('another.md','modified after restart');write('later.md','must not appear');
  plan.state='done';plan.session=randomUUID();
  assert.deepEqual(pauseChanges(root,logs,plan),frozen);
  assert.match(describePause(frozen),/already-dirty\.js/);
  const pauseDir=path.join(root,'.git/context-pilot/pauses',plan.id);
  const baseline=readFileSync(path.join(pauseDir,readdirSync(pauseDir).find(n=>n.endsWith('baseline.json'))),'utf8');
  assert.doesNotMatch(baseline,/same uncommitted work|CSV uses comma|version one|ignored text/);
});

test('unreadable or unsupported snapshots never imply an empty change set; symlinks are not followed',t=>{
  const {root,logs,write,git,plan,stage}=project(t);
  assert.equal(pauseChanges(root,logs,plan,stage).status,'unavailable');
  const outside=path.join(path.dirname(root),'outside.md');writeFileSync(outside,'before');
  symlinkSync(outside,path.join(root,'link.md'));
  write('large.bin','');truncateSync(path.join(root,'large.bin'),9*1024*1024);
  mkdirSync(path.join(root,'docs'));write('docs/note.md','old');
  git('add','docs/note.md');git('commit','-qm','baseline');
  plan.pauses=[recordPause(root,logs,plan.id,plan.session,stage,1)];
  writeFileSync(outside,'after');
  renameSync(path.join(root,'docs'),path.join(path.dirname(root),'docs-old'));
  symlinkSync(path.dirname(root),path.join(root,'docs'),'dir');
  const changes=pauseChanges(root,logs,plan);
  assert.equal(changes.limited,true);
  assert.ok(!changes.files.some(f=>f.path==='link.md'||f.path==='docs/note.md'));
  assert.match(describePause(changes),/неполное/);
  assert.equal(changes.files.find(f=>f.path==='docs')?.change,'added');
  rmSync(path.join(root,'.git/context-pilot/pauses'),{recursive:true});
  assert.equal(pauseChanges(root,logs,plan,stage).status,'unavailable');
});
