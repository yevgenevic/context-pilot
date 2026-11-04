import {redactJsonString, redactSecrets} from './privacy.ts';
import { checkEvidence, projectTest, requiredCommands, rootPrefix } from './acceptance.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { activity, runAgent, type CommandResult } from './activity.ts';
import { DatabaseSync } from 'node:sqlite';
import { packets } from './packets.ts';
import { memoryDirectory, memoryFile, readMemoryFile, projectFile, recordId } from './memory-path.ts';
import { describePause, freezePause, recordPause, type PauseChanges, type PauseRef } from './pause-changes.ts';
import {ContextCapacityError, readContextPolicy, runContextStage, workspaceStatus, type ContextPolicy, type ContextTransfer} from './rotation.ts';

type Ticket = {
  id: string; title: string; text: string; files: string[]; rules: string[];
  checks: string[]; acceptanceCommands?:string[]; base: string | null;
  state: 'pending' | 'running' | 'done' | 'failed' | 'interrupted'; summary: string;
};
export type Clarification = {id: string; question: string; options: string[]; answer?: string};
type Idea = {
  clarifications?: Clarification[];
  id: string; idea: string; pid: number; created: string;
  state: 'awaiting_answers' | 'planning' | 'building' | 'verifying' | 'done' | 'failed' | 'interrupted';
  tasks: Ticket[]; error: string;
  session?: string; childPid?: number; repairId?: string; retryStage?: string;
  base?: string | null; pauses?: PauseRef[];
  contextPolicy?:ContextPolicy; contextTransfers?:ContextTransfer[];
  verification?: {state: Ticket['state']; reports: Report[]; requiredCommands?:string[]};
};
type Project = {
  root: string; memory: string; logs: string; base: string | null;
  context: (id: string) => string;
};

class SessionFailure extends Error {}

export function ideas(memory: string): Idea[] {
  const dir = memoryDirectory(memory, 'ideas');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const plan: Idea = JSON.parse(readMemoryFile(memoryFile(memory, 'ideas', name.slice(0,-5))));
    if (plan.id + '.json' !== name || !/^P-[a-f0-9]{8}$/.test(plan.id) || !Array.isArray(plan.tasks)) throw Error('Некорректная запись плана.');
    for (const task of plan.tasks) recordId(task.id);
    // Older versions stored the agent process error without its stage.
    if (plan.state==='failed' && !plan.retryStage && [
      'Сеанс Codex завершился с ошибкой. Подробности в журнале.',
      'Агент не вернул структурированный результат.'
    ].includes(plan.error)) {
      plan.retryStage = plan.tasks.find(task=>task.state==='failed')?.id
        ?? plan.id+(plan.tasks.length ? '-verify' : '-plan');
    }
    if (['planning','building','verifying'].includes(plan.state)) {
      try { process.kill(plan.pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          plan.state = 'interrupted';
          plan.error = 'Координатор остановлен. Можно продолжить с сохранённого этапа.';
        }
      }
    }
    return plan;
  }).sort((a,b) => b.created.localeCompare(a.created));
}

export function findTicket(plans: Idea[], id: string) {
  for (const plan of plans) {
    const index = plan.tasks.findIndex(task => task.id === id);
    if (index >= 0) return {plan, task: plan.tasks[index], preceding: plan.tasks.slice(0, index)};
  }
}

const string = {type: 'string'};
const strings = {type: 'array', items: string};
function object(properties: Record<string, unknown>) {
  return {type: 'object', properties, required: Object.keys(properties), additionalProperties: false};
}
const taskArray = {type:'array', items:object({
  title: string, text: string, files: strings, rules: strings, checks: strings, acceptanceCommands: strings
})};
const planSchema = object({tasks:taskArray});
const intakeSchema = object({tasks:taskArray,questions:{type:'array',items:object({question:string,options:strings})}});
const resultSchema = object({status:{type:'string',enum:['done','blocked']}, summary:string});

function cleanText(value: unknown, limit = 5000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw Error('Некорректный текст в ответе агента.');
  return value.trim();
}
function clarificationQuestions(input: unknown): Clarification[] {
  if (!Array.isArray(input) || input.length > 3) throw Error('Планировщик должен вернуть не более трёх вопросов.');
  return input.map((item,index) => {
    if (!Array.isArray(item?.options) || item.options.length > 3) throw Error('Некорректные варианты ответа.');
    return {id:'q'+(index+1),question:cleanText(item.question,700),
      options:[...new Set<string>(item.options.map((option:unknown)=>cleanText(option,300)))]};
  });
}
function answeredQuestions(questions: Clarification[], input: unknown): Clarification[] {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== questions.length) throw Error('Нужен ответ на каждый вопрос.');
  const answers = input as Record<string,unknown>;
  return questions.map(q => {
    const answer = answers[q.id];
    if (!Object.hasOwn(answers,q.id) || typeof answer !== 'string' || !answer.trim()) throw Error('Нужен ответ на каждый вопрос.');
    if (answer.length > 2000) throw Error('Ответ должен содержать не более 2000 символов.');
    return {...q,answer:answer.trim()};
  });
}
export function ideaBrief(plan: Idea) {
  const answers = plan.clarifications?.filter(q => q.answer);
  if (!answers?.length) return plan.idea;
  return [plan.idea,'## Уточнения пользователя',
    ...answers.map(q=>q.question+'\nОтвет: '+q.answer)].join('\n\n');
}
function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw Error('Некорректный список в плане.');
  return value.map(item => cleanText(item, 500));
}

function tickets(raw: unknown, prefix: string, base: string | null, knownRules: Set<string>, root:string): Ticket[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw Error('План должен содержать от 1 до 12 задач.');
  return raw.map((item, i) => {
    const files = stringList(item.files).map(file => projectFile(root, file));
    const rules = stringList(item.rules);
    if (rules.some(rule => !knownRules.has(rule))) throw Error('План ссылается на неизвестное правило.');
    const checks = stringList(item.checks);
    if (!checks.length) throw Error('У задачи нет проверки результата.');
    return {id: prefix + '-' + (i+1), title:cleanText(item.title, 180), text:cleanText(item.text),
      files, rules, checks, acceptanceCommands:item.acceptanceCommands===undefined?undefined:stringList(item.acceptanceCommands), base, state:'pending', summary:''};
  });
}

type Report = {
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  checks: {requirement: string; expected: string; actual: string; passed: boolean}[];
  commands: CommandResult[];
};
const reviewSchema = object({
  status: {type:'string',enum:['passed','failed','blocked','needs_files']}, summary:string,
  fixtures: {type:'array',items:object({name:string,content:string})},
  checks: {type:'array',items:object({requirement:string,expected:string,actual:string,passed:{type:'boolean'}})}
});
function reviewerPrompt(plan: Idea, project: Project) {
  const runs = activity(project.logs);
  const trace = plan.tasks.map((task,index) => {
    const inputs = packets(project.logs,task.id);
    const preceding = plan.tasks.slice(0,index).filter(earlier => earlier.summary);
    return {
      task: task.id,
      sessions: runs.filter(r=>r.task===task.id).map(r=>({log:r.id,state:r.state,started:r.startedAt,ended:r.time})),
      archivedInputs: inputs.length,
      handoffs: preceding.map(earlier=>({from:earlier.id,
        receivedOnAttempts:inputs.flatMap((packet,i)=>packet.includes(earlier.summary) ? [i+1] : [])
      }))
    };
  });
  return [
    'Ты независимый проверяющий. Получаешь исходное требование и доступ к готовому проекту только для чтения.',
    'Проверь каждое требование через нормальный вход в продукт. Сам запусти реальные команды и граничные сценарии. Не используй отчёты авторов для проверки поведения продукта. Для каждого сценария запиши наблюдаемый вывод. Не меняй файлы.',
    'Если для проверки обычного файла нет подходящих тестовых данных, верни status needs_files и fixtures — список до 6 входных текстовых файлов с простыми именами и точным содержимым. Координатор создаст их во временном каталоге вне проекта, затем ты запустишь продукт с их путями. Файлы могут быть пустыми или некорректными для негативных сценариев. Запрашивай только синтетические входные данные, не тестовые программы. Если файлы не нужны, верни fixtures=[].',
    'По каждому требованию укажи ожидаемое и наблюдаемое. passed допустим только после фактической проверки всех требований. Расхождение — failed. Невозможность проверить — blocked.',
    'Обязательные команды приёмки перечислены ниже. Запусти каждую дословно отдельным вызовом в корне проекта. Не объединяй команды, не скрывай код выхода. Отрицательные сценарии проверяй тестом, который ожидает нужную ошибку и сам возвращает 0. Не подменяй упавшую команду альтернативой. При коде, отличном от 0, верни failed. Если полноценный запуск недоступен, верни blocked.',
    'Для подтверждения каталога в старых версиях Codex можно добавить перед каждой командой точный префикс: '+rootPrefix(project.root),
    JSON.stringify(plan.verification?.requiredCommands ?? []),
    'Для требований о процессе ниже факты координатора. Каждая попытка запускается в отдельной сессии Codex. receivedOnAttempts вычислено поиском полного итога предыдущего агента в сохранённом входе. Если требуется проверить передачу конкретного примера, можешь прочитать соответствующий вход в каталоге '+path.join(path.dirname(project.logs),'packets')+'/<task>/<attempt>.md. Для функциональных требований сам запусти продукт.',
    JSON.stringify(trace),'Исходное требование пользователя с учётом его ответов:',ideaBrief(plan)
  ].join('\n\n');
}
type Verdict = Omit<Report,'commands'>;
type ReviewResponse = Verdict | {status:'needs_files';summary:string;fixtures:{name:string;content:string}[]};
function report(raw: Verdict, commands: CommandResult[], required:string[], root:string): Report {
  const summary = cleanText(raw.summary,16000);
  if (!['passed','failed','blocked'].includes(raw.status) || !Array.isArray(raw.checks)) throw Error('Проверяющий вернул некорректный отчёт.');
  const checks = raw.checks.map(check => {
    if (typeof check.passed !== 'boolean') throw Error('Нет результата проверки.');
    return {requirement:cleanText(check.requirement),expected:cleanText(check.expected),actual:cleanText(check.actual),passed:check.passed};
  });
  const evidence=checkEvidence(required,commands,root);
  const allChecks=[...evidence.checks,...checks];
  if (evidence.failed.length) {
    return {status:'failed',summary:'Обязательная проверка завершилась с ошибкой: '+evidence.failed.join(', '),checks:allChecks,commands};
  }
  if (raw.status==='passed' && evidence.missing.length) {
    return {status:'blocked',summary:'Нет подтверждения обязательной проверки: '+evidence.missing.join(', '),checks:allChecks,commands};
  }
  if (raw.status==='passed' && (!commands.some(c=>c.exitCode===0) || !checks.length || checks.some(c=>!c.passed))) {
    return {status:'blocked',summary:'Приёмка не подтверждена командами и успешными сценариями.',checks:allChecks,commands};
  }
  return {status:raw.status,summary,checks:allChecks,commands};
}
// The coordinator writes input data; both review sessions retain the read-only sandbox.
async function verifyProduct(plan: Idea, project: Project, run: (prompt:string, commands:CommandResult[]) => Promise<ReviewResponse>): Promise<Report> {
  const required=plan.verification?.requiredCommands ?? [];
  const prompt = reviewerPrompt(plan,project);
  let commands:CommandResult[] = [];
  let raw = await run(prompt,commands);
  if (raw.status !== 'needs_files') return report(raw,commands,required,project.root);

  const files: {name:string;content:string}[] = raw.fixtures;
  if (!Array.isArray(files) || files.length < 1 || files.length > 6) throw Error('Нужны от 1 до 6 входных файлов.');
  const names = new Set<string>();
  for (const file of files) {
    if (typeof file?.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(file.name) ||
        names.has(file.name.toLowerCase()) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 48*1024)
      throw Error('Некорректный входной файл для проверки.');
    names.add(file.name.toLowerCase());
  }
  const temp = realpathSync(tmpdir());
  const relative = path.relative(realpathSync(project.root),temp);
  if (!(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))) {
    throw Error('Для проверки нужен временный каталог вне проекта.');
  }
  const dir = mkdtempSync(path.join(temp,'pilot-review-'));
  try {
    for (const file of files) writeFileSync(path.join(dir,file.name),file.content,{flag:'wx',mode:0o600});
    const inputs = files.map(file=>({path:path.join(dir,file.name),content:file.content}));
    commands = [];
    raw = await run([prompt,'Координатор подготовил обычные входные файлы. Используй их прямо по абсолютным путям. Сам запусти команду продукта и сравни фактический вывод с ожидаемым. В отчёте укажи использованные данные и результат. Это финальный проход.',
      JSON.stringify(inputs)].join('\n\n'),commands);
    if (raw.status==='needs_files') return {status:'blocked',summary:'Подготовленных файлов оказалось недостаточно. '+cleanText(raw.summary),checks:[],commands};
    return report(raw,commands,required,project.root);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
}
function alive(pid?:number) {
  if (!pid || pid<=0) return false;
  try { process.kill(pid,0); return true; }
  catch (err) {return (err as NodeJS.ErrnoException).code!=='ESRCH';}
}
function stopFile(project:Project, plan:Idea) {
  if (!/^P-[a-f0-9]{8}$/.test(plan.id) || !/^[a-f0-9-]{36}$/.test(plan.session ?? '')) throw Error('Некорректный идентификатор сессии.');
  return path.join(path.dirname(project.logs), plan.id + '.' + plan.session + '.stop');
}
export function stopIdea(project:Project, id:string) {
  const plan = ideas(project.memory).find(p=>p.id===id);
  if (!plan?.session || !['planning','building','verifying'].includes(plan.state)) throw Error('Этот запуск сейчас не выполняется.');
  writeFileSync(stopFile(project,plan),'',{mode:0o600});
  return id;
}
function progressPacket(project: Project, stage: string, original: string, failure?: string) {
  const run = activity(project.logs).find(r=>r.task===stage);
  const recent = run?.events.filter(e=>!e.contextUsage && !e.text.trimStart().startsWith('{')).slice(-8).map(e=>e.time+' '+e.text.slice(0,600)).join('\n');
  const heading = failure ? '## Продолжение после сбоя' : '## Продолжение после остановки';
  return [original.trimEnd(),heading,
    ...(failure ? ['Предыдущая попытка этого этапа завершилась с ошибкой. '+failure] : []),
    'Сверь уже сделанное с файлами на диске, сохрани готовые изменения и закончи оставшуюся работу. Повтори проверки.',
    'Состояние рабочей копии (включает изменения других этапов):\n'+workspaceStatus(project.root),
    'Последние события предыдущей попытки:\n'+(recent || 'нет записей')].join('\n\n')+'\n';
}
export function startIdea(project:Project,input:string) {
  const plan:Idea = {id:'P-'+randomUUID().slice(0,8),idea:cleanText(input,12000),created:new Date().toISOString(),base:project.base,pid:process.pid,state:'planning',tasks:[],error:''};
  return coordinate(project,plan.id,{kind:'start',plan});
}
export function resumeIdea(project:Project,id:string) {
  if (!/^P-[0-9a-f]{8}$/.test(id)) throw Error('Некорректный ID запуска.');
  return coordinate(project,id);
}
export function answerIdea(project:Project,id:string,answers:unknown) {
  if (!/^P-[0-9a-f]{8}$/.test(id)) throw Error('Некорректный ID запуска.');
  return coordinate(project,id,{kind:'answer',answers});
}
type Request = {kind:'start';plan:Idea} | {kind:'resume'} | {kind:'answer';answers:unknown};
function coordinate(project:Project,id:string,request:Request={kind:'resume'}) {
  const {root,memory,logs} = project;
  const dir = memoryDirectory(memory, 'ideas');
  mkdirSync(dir,{recursive:true});
  mkdirSync(logs,{recursive:true,mode:0o700});
  // SQLite's process lock is released by the OS even if the coordinator crashes.
  const lock = new DatabaseSync(path.join(path.dirname(logs),'coordinator.sqlite'));
  try { lock.exec('BEGIN IMMEDIATE'); }
  catch { lock.close(); throw Error('У проекта уже есть запуск.'); }
  let plan:Idea;
  let resuming:PauseChanges|null=null;
  let recovering:{stage:string;reason:string}|undefined;
  let currentStage:string;
  function save() {
    const filename = memoryFile(memory, 'ideas', id);
    const temp = path.join(path.dirname(filename), '.'+randomUUID()+'.tmp');
    writeFileSync(temp,JSON.stringify(plan,redactJsonString,2)+'\n',{flag:'wx',mode:0o600});
    renameSync(temp,filename);
  }
  try {
    const legacy = path.join(path.dirname(logs),'idea.lock');
    if (existsSync(legacy) && alive(Number(readFileSync(legacy,'utf8')))) throw Error('Работает предыдущая версия координатора.');
    const previous = request.kind==='start' ? request.plan : ideas(memory).find(p=>p.id===id);
    if (!previous) throw Error('Запуск не найден.');
    const retryReview = previous?.state==='failed' && previous.verification?.reports.at(-1)?.status==='blocked'
      && previous.tasks.every(task=>task.state==='done');
    if (request.kind==='resume' && previous.state==='failed' && previous.retryStage) {
      recovering={stage:previous.retryStage,reason:previous.error};
    }
    if (request.kind==='resume' && previous.state!=='interrupted' && !retryReview && !recovering) {
      throw Error('У запуска нет прерванного этапа или доступной повторной проверки.');
    }
    if (request.kind!=='start' && alive(previous.childPid)) throw Error('Прежний процесс агента ещё работает. Дождись его завершения перед продолжением.');
    if (request.kind==='answer') {
      if (previous.state!=='awaiting_answers' || !previous.clarifications?.length) throw Error('Этот запуск уже не ждёт ответов.');
      previous.clarifications=answeredQuestions(previous.clarifications,request.answers);
    }
    plan = previous;
    if (request.kind==='resume' && (previous.state==='interrupted' || (recovering && previous.pauses?.some(ref=>ref.session===previous.session)))) {
      resuming=freezePause(root,logs,previous);
    }
    plan.contextPolicy ??= readContextPolicy();
    plan.pid = process.pid;
    plan.session = randomUUID();
    plan.error = '';
    delete plan.retryStage;
    plan.verification ??= {state:'pending',reports:[]};
    plan.state = plan.tasks.length ? 'building' : 'planning';
    save();
  } catch (err) { lock.close(); throw err; }
  const signal = new AbortController();
  const marker = stopFile(project,plan);
  const stop = () => signal.abort();
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  const poll = setInterval(()=>{if (existsSync(marker)) stop();},150);
  // Explicit resume starts a new retry allowance. Within one run it remains bounded across review passes.
  const transfersThisRun:ContextTransfer[]=[];
  function assertRunning() {
    if (existsSync(marker)) stop();
    signal.signal.throwIfAborted();
  }
  async function agent(stage:string,prompt:string,schema:object,writable:boolean,commands?:CommandResult[]) {
    currentStage=stage;
    assertRunning();
    if (recovering?.stage===stage) {
      prompt=progressPacket(project,stage,prompt,recovering.reason);
      recovering=undefined;
    }
    if (resuming?.stage===stage) {
      prompt=prompt.trimEnd()+'\n\n'+describePause(resuming)+'\n';
      resuming=null;
    }
    const schemaPath = path.join(path.dirname(logs),id+'.schema');
    writeFileSync(schemaPath,JSON.stringify(schema));
    let lastMessage='';
    const code=await runContextStage({
      root,logs,stage,prompt,policy:plan.contextPolicy!,signal:signal.signal,transfers:transfersThisRun,assertRunning,
      onTransfer(transfer) {
        (plan.contextTransfers??=[]).push(transfer);
        transfersThisRun.push(transfer);
        save();
      },
      async runAttempt(input,attempt,attemptSignal,onContextBoundary) {
        // A fresh verifier must establish its own evidence.
        if(commands) commands.length=0;
        const output={schema:schemaPath,lastMessage:'',signal:attemptSignal,attempt,commands,onContextBoundary,
          thresholdPercent:plan.contextPolicy!.thresholdPercent,onSpawn(pid:number){plan.childPid=pid;save();}};
        try {
          const code=await runAgent(root,logs,stage,input,writable,output);
          lastMessage=output.lastMessage;
          return code;
        } finally {delete plan.childPid;}
      }
    });
    assertRunning();
    if (code!==0) throw new SessionFailure('Сеанс Codex завершился с ошибкой. Подробности в журнале.');
    try {return JSON.parse(lastMessage);}
    catch {throw new SessionFailure('Агент не вернул структурированный результат.');}
  }
  async function execute() {
    let active:Ticket | undefined;
    const verification = plan.verification!;
    try {
      if (!plan.tasks.length) {
        const ruleDir = memoryDirectory(memory,'rules');
        const rules = readdirSync(ruleDir).filter(f=>f.endsWith('.json')).map(f=>{
          const {id,text} = JSON.parse(readMemoryFile(memoryFile(memory, 'rules', f.slice(0,-5))));return {id,text};
        });
        const hasAnswers = Boolean(plan.clarifications?.length);
        const instruction = hasAnswers
          ? 'Пользователь ответил на все уточнения. Составь план по исходной идее и ответам. Перенеси решения в задания и проверяемые критерии.'
          : 'Сначала реши, есть ли в идее существенная развилка, которую не разрешают запрос, правила и файлы проекта. Если от ответа зависит, кто пользуется продуктом, что он делает или какой результат нужен, верни только 1–3 коротких вопроса на языке пользователя и tasks=[]. Дай до трёх вариантов на вопрос, рекомендуемый первым, или пустой список для свободного ответа. Не задавай вопросы о мелочах реализации. Если цель и результат достаточно ясны, верни questions=[] и готовые задачи сразу.';
        const prompt = ['Ты планировщик. Изучи рабочую копию только для чтения. Разбей идею на компактные задачи в порядке зависимостей. Не создавай файлы.',
          'Для маленького проекта обычно достаточно двух задач. Максимум 12. Укажи название, точное задание, относительные пути к коду, ID подходящих существующих правил и конкретные проверки.',
          'В acceptanceCommands перечисли известные конкретные команды обязательной приёмки. Они запускаются из корня готового проекта и должны завершиться с кодом 0. Для каждой команды используй отдельную строку без цепочек, перенаправлений, шаблонов или заполнителей. Для ожидаемой ошибки укажи тест, который сам проверяет её. Словесные критерии оставь в checks. Если конкретной команды пока нет — acceptanceCommands=[].',
          'Каждый исполнитель начнёт в новой сессии. Укажи общие интерфейсы и критерии успеха.',
          instruction,'Правила проекта: '+JSON.stringify(rules),'Идея пользователя:',ideaBrief(plan)].join('\n\n');
        const result = await agent(id+'-plan',prompt,hasAnswers ? planSchema : intakeSchema,false);
        if (!hasAnswers) {
          const questions=clarificationQuestions(result.questions);
          if (questions.length) {
            if (!Array.isArray(result.tasks) || result.tasks.length) throw Error('Планировщик одновременно вернул вопросы и задачи.');
            plan.clarifications=questions;
            plan.state='awaiting_answers';
            save();
            console.log('Нужны уточнения. Откройте pilot dashboard и ответьте на вопросы.');
            return 0;
          }
        }
        // Validate the executable acceptance contract before recording tasks.
        // If planning output is malformed, a retry starts a fresh planner.
        try {
          const tasks=tickets(result.tasks,id,plan.base===undefined?project.base:plan.base,new Set(rules.map(r=>r.id)),root);
          verification.requiredCommands=requiredCommands(tasks,projectTest(root));
          plan.tasks=tasks;
        } catch (err) {
          throw new SessionFailure((err as Error).message);
        }
        save();
      }
      // Freeze the plan's gates before any worker starts or resumes. A repair
      // cannot remove a command by changing the manifest or restating a task.
      verification.requiredCommands ??= requiredCommands(plan.tasks.filter(t=>t.id!==plan.repairId),projectTest(root));
      for (;;) {
        plan.state='building';
        save();
        for (const task of plan.tasks) {
          if (task.state==='done') continue;
          active=task;
          task.state='running';
          save();
          const original=packets(logs,task.id)[0];
          const prompt=original && recovering?.stage!==task.id ? progressPacket(project,task.id,original) : project.context(task.id);
          const result=await agent(task.id,prompt,resultSchema,true);
          task.summary=cleanText(result.summary,16000);
          if (result.status!=='done') throw Error(task.summary);
          task.state='done';
          active=undefined;
          save();
        }
        plan.state='verifying';
        // A new project may have gained its first test suite during building.
        verification.requiredCommands=[...new Set([...verification.requiredCommands,...projectTest(root)])];
        verification.state='running';
        save();
        const verdict=await verifyProduct(plan,project,(prompt,commands)=>
          agent(id+'-verify',prompt,reviewSchema,false,commands));
        verification.reports.push(verdict);
        if (verdict.status==='passed') {
          verification.state='done';plan.state='done';save();return 0;
        }
        if (verdict.status==='blocked' || plan.repairId) throw Error(verdict.summary);
        // Bound the repair loop. A fresh verifier reruns acceptance from the original brief.
        plan.repairId=id+'-repair';
        plan.tasks.push({id:plan.repairId,title:'Исправить расхождения при проверке',text:verdict.summary,
          files:[],rules:[],checks:verdict.checks.map(c=>c.requirement+' — '+c.expected+'; получено: '+c.actual),
          base:project.base,state:'pending',summary:''});
        verification.state='pending';
        save();
      }
    } catch (err) {
      const capacityReached=err instanceof ContextCapacityError;
      const paused=signal.signal.aborted || capacityReached;
      if (paused || err instanceof SessionFailure) {
        const stage=currentStage ?? active?.id ?? id+(plan.state==='verifying'?'-verify':'-plan');
        if (!paused) plan.retryStage=stage;
        const ref=recordPause(root,logs,id,plan.session!,stage,packets(logs,stage).length);
        (plan.pauses??=[]).push(ref);
      }
      const state=paused?'interrupted':'failed';
      if (active) active.state=state;
      if (plan.state==='verifying') verification.state=state;
      plan.state=state;
      plan.error=signal.signal.aborted?'Запуск остановлен. Задание и файлы сохранены.':(err as Error).message;
      save();
      console.error('pilot: '+redactSecrets(plan.error));return paused?130:1;
    } finally {
      clearInterval(poll);
      process.off('SIGINT',stop);process.off('SIGTERM',stop);
      try { for (const file of [marker,path.join(path.dirname(logs),id+'.schema')]) if (existsSync(file)) unlinkSync(file); }
      finally { lock.close(); }
    }
  }
  return {id,finished:execute()};
}
