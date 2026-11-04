import {redactSecrets} from './privacy.ts';
import { readGit } from './git-read.ts';
import {activity} from './activity.ts';
import {packets, savePacket} from './packets.ts';

export type ContextPolicy = {thresholdPercent:number;maxTransfers:number};
export type WindowUsage = {used:number;window:number};
export type ContextTransfer = WindowUsage & {
  stage:string;fromAttempt:number;toAttempt:number;at:string;thresholdPercent:number;
};

export function readContextPolicy(): ContextPolicy {
  const raw=process.env.PILOT_CONTEXT_THRESHOLD_PERCENT;
  const thresholdPercent=raw===undefined?85:Number(raw);
  if (!Number.isFinite(thresholdPercent) || thresholdPercent<=0 || thresholdPercent>100)
    throw Error('PILOT_CONTEXT_THRESHOLD_PERCENT должен быть числом больше 0 и не больше 100.');
  return {thresholdPercent,maxTransfers:3};
}

export class ContextCapacityError extends Error {
  constructor(maxTransfers:number) {
    super('Достигнут предел автопередач ('+maxTransfers+'). Задача сохранена. Уменьши объём входных данных или раздели задачу перед продолжением.');
  }
}

function headAndTail(values:string[],limit:number) {
  return values.length<=limit ? values : [values[0],...values.slice(1-limit)];
}

function chainEvidence(logs:string,stage:string,first:number,last:number) {
  const runs=activity(logs,Infinity).filter(run=>run.task===stage && run.attempt!==undefined && run.attempt>=first && run.attempt<=last)
    .sort((a,b)=>a.attempt!-b.attempt!);
  const sections:string[]=[], seen=new Set<string>(), paths=new Set<string>();
  for (const run of runs) {
    const notes:string[]=[],commands:string[]=[];
    for (const event of run.events) {
      if (event.state!=='running') continue;
      if (event.text.startsWith('Файлы · ')) {
        for (const file of event.text.slice(8).split(', ')) if (file) paths.add(file);
        continue;
      }
      const command=/^Код -?\d+ · /.test(event.text);
      if (!command && event.itemType!=='agent_message') continue;
      const text=event.text.trim().replace(/\s+/g,' ').slice(0,330);
      if (!text || /^(?:```(?:json)?\s*)?[\[{]/i.test(text) || seen.has(text)) continue;
      seen.add(text);
      (command ? commands : notes).push(text);
    }
    const lines=[...headAndTail(notes,4).map(t=>'Заметка: '+t),...headAndTail(commands,4)];
    if (lines.length) sections.push('Попытка '+run.attempt+'\n'+lines.map(t=>'- '+t).join('\n'));
  }
  if (paths.size) sections.push('Файлы из событий правки:\n'+Array.from(paths).slice(0,28).map(p=>'- '+p.slice(0,180)).join('\n'));
  return sections.join('\n\n') || 'Завершённые действия не записаны.';
}

export function workspaceStatus(root:string) {
  let files:string;
  try {
    const status=readGit(['status','--short','--untracked-files=all','--','.',':(exclude).pilot'],{
      cwd:root,encoding:'utf8',timeout:2500,maxBuffer:2*1024*1024,stdio:['ignore','pipe','ignore']
    }).trimEnd().split('\n');
    files=status.slice(0,30).map(line=>line.slice(0,300)).join('\n') || 'Чисто.';
    if(status.length>30) files+='\n… Остальные пути доступны через git status --short.';
  } catch {files='Не удалось прочитать Git. Проверь состояние рабочей копии.';}
  return files;
}

function handoffPrompt(root:string,logs:string,transfer:ContextTransfer,original:string,firstAttempt:number) {
  const evidence=chainEvidence(logs,transfer.stage,firstAttempt,transfer.fromAttempt);
  const files=workspaceStatus(root);
  return [
    original.trimEnd(),'## Автопередача по заполнению контекста',
    'Продолжи тот же этап '+transfer.stage+' с попытки '+transfer.fromAttempt+'. Codex сообщил '+transfer.used+' из '+transfer.window+' токенов окна. Порог передачи '+transfer.thresholdPercent+'%.',
    'Наблюдения и действия по этому этапу с начала текущей цепочки (сверь их с проектом):\n'+evidence,
    ...(transfer.stage.endsWith('-verify')?['Чтобы подтвердить результат, самостоятельно повтори проверки. Команды и заметки предыдущей попытки приёмки помогают выбрать сценарии.']:[]),
    'Рабочая копия на момент передачи (может включать работу других этапов):\n'+files,
    'Следующий шаг: сверь отмеченные выше действия и файлы с исходным заданием. Продолжи с первого незавершённого пункта и проведи его проверки. Большие журналы и файлы читай выборочно по нужным строкам, чтобы не заполнять новую сессию повторно.'
  ].join('\n\n')+'\n';
}

type ContextStage = {
  root:string;logs:string;stage:string;prompt:string;policy:ContextPolicy;signal:AbortSignal;
  transfers?:readonly ContextTransfer[];
  assertRunning:()=>void;
  onTransfer:(transfer:ContextTransfer)=>void;
  runAttempt:(prompt:string,attempt:number,signal:AbortSignal,onContextBoundary:(usage:WindowUsage)=>void)=>Promise<number>;
};

export async function runContextStage(options:ContextStage):Promise<number> {
  const {root,logs,stage,policy,signal}=options;
  const firstAttempt=packets(logs,stage).length+1;
  let attempt=firstAttempt;
  const original=redactSecrets(options.prompt);
  let prompt=original;
  let transfers=options.transfers?.filter(transfer=>transfer.stage===stage).length ?? 0;
  let pending:ContextTransfer | undefined;
  for (;;) {
    options.assertRunning();
    signal.throwIfAborted();
    savePacket(logs,stage,attempt,prompt);
    if (pending) options.onTransfer(pending);

    const rotation=new AbortController();
    const attemptSignal=AbortSignal.any([signal,rotation.signal]);
    let crossed:WindowUsage | undefined;
    const code=await options.runAttempt(prompt,attempt,attemptSignal,usage=>{
      if (attemptSignal.aborted || !Number.isSafeInteger(usage.used) || usage.used<0 ||
          !Number.isSafeInteger(usage.window) || usage.window<=0 || usage.used*100<policy.thresholdPercent*usage.window) return;
      crossed={used:usage.used,window:usage.window};
      rotation.abort(transfers>=policy.maxTransfers?'context-capacity-limit':'context-rotation');
    });
    options.assertRunning();
    signal.throwIfAborted();
    if (!crossed) return code;
    if (transfers>=policy.maxTransfers) throw new ContextCapacityError(policy.maxTransfers);
    pending={...crossed,stage,fromAttempt:attempt,toAttempt:attempt+1,at:new Date().toISOString(),thresholdPercent:policy.thresholdPercent};
    // Start from the stable assignment on each transfer, never append to an earlier handoff.
    prompt=redactSecrets(handoffPrompt(root,logs,pending,original,firstAttempt));
    attempt++;
    transfers++;
  }
}
