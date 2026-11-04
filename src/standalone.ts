import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runAgent} from './activity.ts';
import {readContextPolicy, runContextStage, type ContextPolicy, type ContextTransfer} from './rotation.ts';

type History = {contextPolicy:ContextPolicy;contextTransfers:ContextTransfer[]};
function directory(logs:string) {return path.join(path.dirname(logs),'standalone');}

export function standaloneContext(logs:string): Record<string, History> {
  const dir=directory(logs);
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter(f=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(f))
    .map(f=>[f.slice(0,-5),JSON.parse(readFileSync(path.join(dir,f),'utf8'))]));
}

export async function runStandalone(root:string, logs:string, stage:string, prompt:string, writable:boolean) {
  const policy=readContextPolicy();
  const dir=directory(logs);
  mkdirSync(dir,{recursive:true,mode:0o700});
  // Planned and manual work share the same working tree and packet numbers.
  const lock=new DatabaseSync(path.join(path.dirname(logs),'coordinator.sqlite'));
  const signal=new AbortController();
  const stop=()=>signal.abort();
  try {
    try { lock.exec('BEGIN IMMEDIATE'); }
    catch { throw Error('У проекта уже есть запуск.'); }
    const file=path.join(dir,stage+'.json');
    const history:History=existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {contextPolicy:policy,contextTransfers:[]};
    history.contextPolicy=policy;
    function save() {
      writeFileSync(file+'.tmp',JSON.stringify(history)+'\n',{mode:0o600});
      renameSync(file+'.tmp',file);
    }
    save();
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
    return await runContextStage({root,logs,stage,prompt,policy,signal:signal.signal,
      assertRunning:()=>signal.signal.throwIfAborted(),
      onTransfer(transfer){history.contextTransfers.push(transfer);save();},
      runAttempt:(packet,attempt,attemptSignal,onContextBoundary)=>runAgent(root,logs,stage,packet,writable,{
        lastMessage:'',attempt,signal:attemptSignal,thresholdPercent:policy.thresholdPercent,onContextBoundary
      })});
  } catch (err) {
    if (signal.signal.aborted) return 130;
    throw err;
  } finally {
    process.off('SIGINT',stop);
    process.off('SIGTERM',stop);
    lock.close();
  }
}
