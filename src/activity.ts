import {redactSecrets} from './privacy.ts';
import { spawn } from 'node:child_process';
import { externalCommand } from './executable.ts';
import { randomUUID } from 'node:crypto';
import { appendMemoryNote, memoryDirectory, memoryFile, readMemoryFile } from './memory-path.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { appProtocol } from './codex-app.ts';
import { contextBoundaries, usageSample, type Sample, type ContextUsage } from './context-meter.ts';

type Entry = { time: string; text: string };
type Event = Entry & { state: 'running' | 'done' | 'failed' | 'interrupted' | 'rotated'; pid: number; task: string; attempt?:number; codexThreadId?:string; contextUsage?:ContextUsage; itemType?:string };

function records<T>(file: string, readText: (file: string) => string = name => readFileSync(name,'utf8')): T[] {
  if (!existsSync(file)) return [];
  const lines = readText(file).split('\n');
  lines.pop(); // An append in progress becomes visible on the next refresh.
  return lines.filter(Boolean).map(line => {
    const entry = JSON.parse(line);
    // Legacy events may contain a credential. Mask it before callers shorten a line for replay.
    if (typeof entry.text === 'string') entry.text = redactSecrets(entry.text);
    return entry;
  });
}
export function notes(memory: string, task: string) {
  return records<Entry>(memoryFile(memory, 'notes', task), readMemoryFile);
}
export function addNote(memory: string, task: string, text: string) {
  const dir = memoryDirectory(memory, 'notes');
  mkdirSync(dir, { recursive: true });
  appendMemoryNote(memory, task, JSON.stringify({time: new Date().toISOString(), text: redactSecrets(text)}) + '\n');
}
export function activity(dir: string, eventLimit = 80) {
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.jsonl'))) {
    const events = records<Event>(path.join(dir, file));
    const last = events.at(-1);
    if (!last) continue;
    let state: string = last.state;
    if (state === 'running') {
      try { process.kill(last.pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') state = 'interrupted';
      }
    }
    const contextUsage=events.findLast(e=>e.contextUsage)?.contextUsage;
    const codexThreadId=events.find(e=>e.codexThreadId)?.codexThreadId;
    runs.push({id:file,task:last.task,attempt:events[0].attempt,codexThreadId,contextUsage,state, startedAt:events[0].time, time:last.time, events:events.slice(-eventLimit)});
  }
  return runs.sort((a,b) => b.time.localeCompare(a.time));
}

function describe(event: any): string | undefined {
  const item = event.item;
  if (event.type === 'turn.started') return 'Codex приступил к задаче';
  if (event.type === 'turn.failed' || event.type === 'error') return event.error?.message || event.message || 'Ошибка Codex';
  if (!item || !['item.started','item.completed'].includes(event.type)) return;
  const done = event.type === 'item.completed';
  if (item.type === 'command_execution') return (done ? 'Код ' + item.exit_code + ' · ' : 'Выполняет · ') + item.command;
  if (item.type === 'file_change') return 'Файлы · ' + (item.changes || []).map((c: any) => c.path).join(', ');
  if (item.type === 'agent_message') return item.text;
  if (item.type === 'mcp_tool_call') return (done ? 'Вызван' : 'Вызывает') + ' инструмент · ' + item.tool;
}

export type CommandResult = {command: string; output: string; exitCode: number|null; cwd?:string};
export type AgentOutput = {
  schema?: string; lastMessage: string; signal?: AbortSignal; attempt?: number;
  thresholdPercent?:number; onContextBoundary?:(sample:Sample)=>void;
  commands?: CommandResult[]; onSpawn?: (pid: number) => void;
};
export async function runAgent(root: string, dir: string, task: string, packet: string, writable = false, output?: AgentOutput) {
  mkdirSync(dir, {recursive:true,mode:0o700});
  const file = path.join(dir, randomUUID() + '.jsonl');
  let codexThreadId:string|undefined;
  function record(text: string, state: Event['state'] = 'running', issue = false, contextUsage?:ContextUsage, itemType?:string) {
    const entry = {task,attempt:output?.attempt,pid:process.pid,time:new Date().toISOString(),state,contextUsage,codexThreadId,itemType,
      ...(issue || state==='failed' ? {level:'error'} : {}),text:redactSecrets(text).slice(0,2400)};
    appendFileSync(file, JSON.stringify(entry) + '\n', {mode:0o600});
    if(!contextUsage) console.log(entry.text);
  }
  record(output?.attempt && output.attempt>1 ? 'Продолжение · новая сессия '+output.attempt : 'Запуск Codex CLI');
  const thresholdPercent=output?.thresholdPercent ?? 85;
  const signal=output?.signal;
  const boundaries=contextBoundaries(sample=>{
    if (!signal?.aborted) output?.onContextBoundary?.(sample);
  });
  let failed=false;
  const requestedWindow=Number(process.env.PILOT_MODEL_CONTEXT_WINDOW);
  const contextWindow=writable && Number.isSafeInteger(requestedWindow) && requestedWindow>0 ? requestedWindow : undefined;
  function handle(event:any) {
    if(event.type==='thread.started' && typeof event.thread_id==='string' && /^[\w-]{1,100}$/.test(event.thread_id)) {
      codexThreadId=event.thread_id;
      record('Сессия Codex · '+codexThreadId);
      return;
    }
    if(event.type==='thread.token_usage.updated') {
      const sample=usageSample(event.tokenUsage);
      if(sample) {
        record('Контекст · '+sample.used+' / '+sample.window+' токенов','running',false,{
          ...sample,thresholdPercent,measuredAt:new Date().toISOString()
        });
        boundaries.measure(sample);
      }
      return;
    }
    // A valid structured result is final on exec versions without message phase.
    if (output && event.type==='item.completed' && event.item?.type==='agent_message') {
      output.lastMessage=event.item.text;
      if(output.schema && !event.item.phase) try {JSON.parse(event.item.text);event.item.final=true;} catch {}
    }
    boundaries.event(event);
    if(event.type==='turn.failed')failed=true;
    if (output?.commands && event.type==='item.completed' && event.item?.type==='command_execution') {
      if (typeof event.item.command==='string') output.commands.push({command:event.item.command,
        output:redactSecrets(String(event.item.aggregated_output ?? '')).slice(-8000),
        exitCode:Number.isInteger(event.item.exit_code)?event.item.exit_code:null,
        ...(typeof event.item.cwd==='string'?{cwd:event.item.cwd}:{})});
    }
    const message=describe(event);
    if(message)record(message,'running',event.type==='error' || event.type==='turn.failed' ||
      (event.type==='item.completed' && event.item?.type==='command_execution' && typeof event.item.exit_code==='number' && event.item.exit_code!==0),
      undefined,event.type==='item.completed'?event.item?.type:undefined);
  }
  const grouped=process.platform!=='win32';
  async function execute(useApp:boolean) {
    if(signal?.aborted) return {code:130,unsupported:false};
    const args=useApp ? ['app-server','--listen','stdio://'] : ['exec','--json','--ephemeral','--sandbox',writable?'workspace-write':'read-only'];
    if(!useApp && output?.schema)args.push('--output-schema',output.schema);
    if(!useApp)args.push('-');
    const schema=useApp && output?.schema ? JSON.parse(readFileSync(output.schema,'utf8')) : undefined;
    const {file:executable,env}=externalCommand('codex',root,root);
    const child=spawn(executable,args,{cwd:root,env,detached:grouped,stdio:['pipe','pipe','inherit']});
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    let killTimer:ReturnType<typeof setTimeout>|undefined, stopped=false;
    function terminate(sig:NodeJS.Signals) {
      if(!child.pid)return;
      try { if(grouped)process.kill(-child.pid,sig);else child.kill(sig); }
      catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    }
    function stop(){
      stopped=true;terminate('SIGTERM');killTimer??=setTimeout(()=>terminate('SIGKILL'),2500);
    }
    if(child.pid)output?.onSpawn?.(child.pid);
    signal?.addEventListener('abort',stop,{once:true});
    if(!signal){process.once('SIGTERM',stop);process.once('SIGINT',stop);}
    child.stdin.on('error',()=>{});
    const protocol=useApp ? appProtocol(child,{root,packet,writable,schema,contextWindow,onEvent:handle}) : undefined;
    const lines=!useApp ? createInterface({input:child.stdout}) : undefined;
    lines?.on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}handle(event);});
    if(!useApp)child.stdin.end(packet);
    if(signal?.aborted)stop();
    try {
      const exit=await exited;
      const exitCode=exit.code ?? 1;
      const result=protocol?.result();
      // Only a failed handshake *before* sending user input can be retried on exec.
      const unsupported=!!result && !stopped && !result.dispatched && (result.handshakeTimedOut || !result.initialized || /method not found|unknown method/i.test(result.failure));
      const code=result ? (result.success && exitCode===0 ? 0 : 1) : exitCode;
      const termination=exit.signal ? 'сигнал '+exit.signal : exit.code ? 'код '+exit.code : undefined;
      return {code,unsupported,termination};
    } finally {
      protocol?.close();lines?.close();clearTimeout(killTimer);
      signal?.removeEventListener('abort',stop);process.off('SIGTERM',stop);process.off('SIGINT',stop);
    }
  }
  try {
    let result=await execute(process.env.PILOT_CODEX_TRANSPORT!=='exec');
    if(result.unsupported && !signal?.aborted) {
      record('Версия Codex без протокола телеметрии. Запускаем через codex exec.');
      result=await execute(false);
    }
    if(signal?.aborted) {
      const rotation=signal.reason==='context-rotation';
      const stopMessage=signal.reason==='context-capacity-limit'?'Лимит автопередач исчерпан. Этап остановлен.':'Сеанс остановлен. Задание сохранено.';
      record(rotation?'Порог контекста достигнут. Задание сохранено для новой сессии.':stopMessage,rotation?'rotated':'interrupted');
      return 130;
    }
    const ok=result.code===0 && !failed;
    const failure=result.termination ? 'Сеанс завершился с ошибкой ('+result.termination+').' : 'Сеанс завершился с ошибкой';
    record(ok?'Сеанс Codex завершён':failure,ok?'done':'failed');
    return ok?0:result.code || 1;
  } catch(err) {
    record('Не удалось запустить Codex: '+(err as Error).message,'failed');return 1;
  } finally {
    boundaries.close();
  }
}
