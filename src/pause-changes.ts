import { readGit } from './git-read.ts';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { previewPausedEdit } from './pause-preview.ts';

export type PauseRef = {session:string; stage:string; at:string; attempt:number; resumedAt?:string};
type Pausable = {id:string; state:string; session?:string; pauses?:PauseRef[]; tasks?:{id:string;state:string}[]};
type Change = {path:string; change:'added'|'modified'|'deleted';preview?:string};
export type PauseChanges = {
  status:'live'|'archived'|'unavailable'; stage:string; pausedAt:string|null; resumedAt:string|null;
  base:string|null; head:string|null; files:Change[]; limited:boolean;
};
type Snapshot = {head:string|null; files:[string,string|null][]; partialList:boolean; limited:boolean};

const maxFiles = 2048;
const maxFileBytes = 8 * 1024 * 1024;
const maxScanBytes = 32 * 1024 * 1024;
const maxChanges = 200;

function git(root:string,args:string[]) {
  return readGit(args,{cwd:root,encoding:null,timeout:3000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
}

// Hash bytes locally. Keep names and fingerprints only, never file contents or symlink targets.
function fingerprint(root:string, name:string, budget:{bytes:number}, chunk:Buffer): string | null | undefined {
  const filename = path.join(root,name);
  try {
    // A tracked directory can have been replaced by a symlink during the pause.
    if (realpathSync(path.dirname(filename)) !== path.dirname(filename)) return null;
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink()) return 'link:'+createHash('sha256').update(readlinkSync(filename,{encoding:null})).digest('hex');
    if (!stat.isFile() || stat.size > maxFileBytes || stat.size > budget.bytes) return null;
    const fd = openSync(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd,{bigint:true});
      if (!opened.isFile() || opened.size!==BigInt(stat.size)) return null;
      budget.bytes-=stat.size;
      const hash=createHash('sha256');
      let offset=0;
      while (offset<stat.size) {
        const read=readSync(fd,chunk,0,Math.min(chunk.length,stat.size-offset),offset);
        if (!read) return null;
        hash.update(chunk.subarray(0,read));
        offset+=read;
      }
      const end=fstatSync(fd,{bigint:true});
      if (end.mtimeNs!==opened.mtimeNs || end.size!==opened.size) return null;
      return (stat.mode & 0o111 ? 'x:' : 'f:')+hash.digest('hex');
    } finally { closeSync(fd); }
  } catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    return code==='ENOENT' || code==='ENOTDIR' ? undefined : null;
  }
}

function snapshot(cwd:string): Snapshot {
  const root=realpathSync(cwd);
  let head:string|null=null;
  try {head=git(root,['rev-parse','--verify','HEAD']).toString().trim();} catch { /* Unborn branch. */ }
  const listed=git(root,['ls-files','-z','--cached','--others','--exclude-standard','--','.',':(exclude).pilot']);
  const files=new Map<string,string|null>(), budget={bytes:maxScanBytes}, chunk=Buffer.allocUnsafe(64*1024);
  let limited=false;
  const names=[...new Set(listed.toString().split('\0').filter(Boolean))].sort();
  const partialList=names.length>maxFiles || !Buffer.from(listed.toString()).equals(listed);
  for (const name of names.slice(0,maxFiles)) {
    if (path.isAbsolute(name) || name.split('/').some(component=>['.','..','.git','.pilot',''].includes(component))) {
      limited=true;continue;
    }
    const value=fingerprint(root,name,budget,chunk);
    if (value!==undefined) files.set(name,value);
    if (value===null) limited=true;
  }
  return {head,files:[...files],partialList,limited:limited||partialList};
}

function compare(root:string,before:Snapshot, after:Snapshot, ref:PauseRef): PauseChanges {
  const oldFiles=new Map(before.files),newFiles=new Map(after.files);
  const paths=new Set([...oldFiles.keys(),...newFiles.keys()]);
  const files:Change[]=[];
  let limited=before.limited||after.limited;
  let previews=0;
  for (const name of [...paths].sort()) {
    const old=oldFiles.get(name), current=newFiles.get(name);
    if (old===current || old===null || current===null) continue;
    if ((old===undefined && before.partialList) || (current===undefined && after.partialList)) continue;
    if (files.length===maxChanges) {limited=true;break;}
    const file:Change={path:name,change:old===undefined?'added':current===undefined?'deleted':'modified'};
    if (previews<6 && old && current && /^[fx]:/.test(old) && /^[fx]:/.test(current)) {
      ++previews;
      const preview=previewPausedEdit(root,before.head,name,old.slice(2));
      if (preview) file.preview=preview;
    }
    files.push(file);
  }
  return {status:'live',stage:ref.stage,pausedAt:ref.at,resumedAt:null,base:before.head,head:after.head,files,limited};
}

function location(logs:string,id:string,session:string,kind:'baseline'|'changes') {
  if (!/^P-[a-f0-9]{8}$/.test(id) || !/^[a-f0-9-]{36}$/.test(session)) throw Error('Некорректная запись остановки.');
  return path.join(path.dirname(logs),'pauses',id,session+'.'+kind+'.json');
}
function store(file:string,data:unknown) {
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});
  renameSync(file+'.tmp',file);
}
function unavailable(stage:string, ref?:PauseRef):PauseChanges {
  return {status:'unavailable',stage,pausedAt:ref?.at ?? null,resumedAt:ref?.resumedAt ?? null,base:null,head:null,files:[],limited:true};
}
export function recordPause(root:string,logs:string,id:string,session:string,stage:string,attempt:number):PauseRef {
  const ref={session,stage,attempt,at:new Date().toISOString()};
  try {store(location(logs,id,session,'baseline'),snapshot(root));} catch { /* The pause itself still succeeds. */ }
  return ref;
}
function interruptedStage(plan:Pausable) {
  const task=plan.tasks?.find(task=>task.state==='running' || task.state==='interrupted' || task.state==='pending');
  return task?.id ?? plan.id+(plan.tasks?.length ? '-verify' : '-plan');
}
export function pauseChanges(root:string,logs:string,plan:Pausable,stage?:string,session?:string):PauseChanges|null {
  const ref=plan.pauses?.findLast(item=>(!stage || item.stage===stage) && (!session || item.session===session));
  // A killed coordinator cannot record the true pause boundary retrospectively.
  if (!session && plan.state==='interrupted' && (!stage || stage===interruptedStage(plan)) && (!ref || ref.session!==plan.session)) {
    return unavailable(stage ?? interruptedStage(plan));
  }
  if (!ref) return null;
  try {
    if (ref.resumedAt) return JSON.parse(readFileSync(location(logs,plan.id,ref.session,'changes'),'utf8'));
    const before:Snapshot=JSON.parse(readFileSync(location(logs,plan.id,ref.session,'baseline'),'utf8'));
    return compare(root,before,snapshot(root),ref);
  } catch {return unavailable(ref.stage,ref);}
}

// Called under the coordinator lock, before dispatching any new process.
export function freezePause(root:string,logs:string,plan:Pausable):PauseChanges|null {
  const ref=plan.pauses?.findLast(item=>item.session===plan.session && !item.resumedAt);
  if (!ref) return unavailable(interruptedStage(plan));
  const result=pauseChanges(root,logs,plan,ref.stage,ref.session)!;
  ref.resumedAt=new Date().toISOString();
  result.resumedAt=ref.resumedAt;
  if (result.status==='live') result.status='archived';
  try {store(location(logs,plan.id,ref.session,'changes'),result);} catch {return unavailable(ref.stage,ref);}
  return result;
}
export function describePause(changes:PauseChanges) {
  if (changes.status==='unavailable') return '## Что изменилось после остановки\n\nСнимок этой остановки недоступен. Сверь состояние рабочей копии с заданием.';
  const labels={added:'Добавлен',modified:'Изменён',deleted:'Удалён'};
  const lines=['## Что изменилось после остановки'];
  if (changes.base!==changes.head) lines.push('HEAD при остановке: '+(changes.base ?? 'без коммита')+'. HEAD при продолжении: '+(changes.head ?? 'без коммита')+'.');
  if (changes.files.length) {
    lines.push('Эти изменения внесены в рабочую копию между остановкой и продолжением. Открой актуальные файлы и сохрани совместимые правки.',
      ...changes.files.map(file=>'- '+labels[file.change]+' '+JSON.stringify(file.path)));
  } else lines.push(changes.limited?'Среди сравнённых файлов изменений нет.':'Файлы рабочей копии не изменились.');
  if (changes.limited) lines.push('Сравнение неполное. Некоторые файлы недоступны или превышают лимит снимка.');
  return lines.join('\n');
}
