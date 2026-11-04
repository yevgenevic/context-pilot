import {redactSecrets} from './privacy.ts';
import { readGit } from './git-read.ts';
import { homedir } from 'node:os';
import path from 'node:path';
import type { activity, notes } from './activity.ts';
import { ideaBrief, type ideas } from './ideas.ts';
import type { PauseChanges } from './pause-changes.ts';
import type { ContextTransfer } from './rotation.ts';

export type Rule = {id:string; text:string; files:string[]};
export type Task = Rule & {rules:string[]; checks:string[]; base:string | null};
type Plan = ReturnType<typeof ideas>[number];
type Handoff = {
  root:string; stage:string; plan?:Plan; task?:Task; rules:Rule[]; notes:ReturnType<typeof notes>;
  run?:ReturnType<typeof activity>[number]; attempts:number; changes:PauseChanges | null;
  contextTransfers?:ContextTransfer[];
};
const states:Record<string,string> = {
  pending:'в очереди',running:'в работе',done:'завершён',interrupted:'прерван',failed:'остановлен с ошибкой',
  awaiting_answers:'ждёт ответов',planning:'идёт планирование',building:'в работе',verifying:'идёт приёмка',
  passed:'пройдена',blocked:'заблокирована'
};
const changesLabel = {added:'Добавлен',modified:'Изменён',deleted:'Удалён'};

function git(root:string, args:string[]) {
  return readGit(args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024}).trimEnd();
}
function code(text:string) {
  const ticks = '`'.repeat(Math.max(3,...(text.match(/`+/g) || []).map(sequence=>sequence.length+1)));
  return ticks+'\n'+text+'\n'+ticks;
}
function list(values:string[]) { return values.map(value=>'- '+value).join('\n'); }

function workspace(root:string) {
  let head:string | null=null;
  try { head=git(root,['rev-parse','--verify','HEAD']); } catch { /* No commit yet. */ }
  const branch=git(root,['branch','--show-current']) || 'detached HEAD';
  const dirty=git(root,['-c','core.quotepath=false','status','--porcelain=v1','--untracked-files=all','--','.',':(exclude).pilot']);
  return {head,branch,dirty};
}

function pauseSection(changes:PauseChanges | null, relevantFiles:string[]) {
  if (!changes) return [];
  const rows=['## Что изменилось после остановки','Этап '+changes.stage+'.'];
  if (changes.status==='unavailable') return [...rows,'Снимок остановки недоступен. Сравнение выполнить нельзя.'];
  rows.push(changes.status==='archived'
    ? 'Сравнение на момент возобновления '+changes.resumedAt+'.'
    : 'Сравнение остановленной копии с файлами на момент выгрузки.');
  if (changes.base!==changes.head) rows.push('HEAD при остановке → после остановки: '+(changes.base || 'нет коммита')+' → '+(changes.head || 'нет коммита')+'.');
  if (changes.files.length) {
    for (const file of changes.files) {
      rows.push('- '+changesLabel[file.change]+' · '+file.path);
      if (file.preview && relevantFiles.includes(file.path)) rows.push(code(file.preview));
    }
  }
  else rows.push(changes.limited?'Среди проверенных файлов изменений не обнаружено.':'В проверенных файлах изменений нет.');
  if (changes.limited) rows.push('Сравнение неполное. Проверь остальные файлы вручную.');
  return rows;
}

function observed(run:Handoff['run']) {
  if (!run) return [];
  const commands=run.events.map(event=>event.text).filter(line=>/^Код -?\d+ · /.test(line) && line.length<=400 && !line.includes('\n')).slice(-8);
  if (!commands.length) return [];
  return ['## Последние завершившиеся команды этого этапа',
    'Коды завершения из журнала сессии '+run.startedAt+'.',code(commands.join('\n'))];
}

function nextStep(stage:string,state:string,plan?:Plan) {
  if (plan?.state==='awaiting_answers') return 'Ответь на открытые вопросы, чтобы планировщик составил план.';
  if (plan?.state==='failed' && plan.retryStage===stage) return 'Сессия агента завершилась с ошибкой. В исходной рабочей копии запусти `pilot resume '+plan.id+'`, чтобы новый агент продолжил этот этап с сохранённых файлов.';
  if (state==='interrupted') return 'Сверь файлы с изменениями после остановки и продолжи работу с этого этапа. В новом чате передай этот файл вместе с рабочей копией.';
  if (plan?.verification?.reports.at(-1)?.status==='blocked' && stage===plan.id+'-verify') return 'Прочитай причину блокировки в отчёте, подготовь нужные условия и повтори приёмку.';
  if (plan?.state==='done') return 'Сверь текущий коммит и локальные файлы с рабочей копией автора. Итог приёмки запуска приведён ниже.';
  if (state==='failed') return 'Разбери причину ошибки и повтори проверки после исправления.';
  if (state==='done') {
    const next=plan?.tasks.find(task=>task.state!=='done');
    return next ? 'Продолжи с задачи '+next.id+' · '+next.title+'.' : 'Сверь готовую работу с требованиями и результатами проверок.';
  }
  if (state==='running' || state==='planning') return 'У автора ещё выполняется этот этап. Согласуй с ним момент передачи перед продолжением работы.';
  if (plan && stage===plan.id+'-verify') return 'Когда исполнители закончат работу, сверь результат с исходной идеей и проверь команды в полученной рабочей копии.';
  return 'Открой файлы задачи, учти сохранённые решения и выполни указанные проверки.';
}

// Output is a portable description. Do not copy raw command output or private verifier prompts.
export function handoff(input:Handoff) {
  const {root,stage,plan,task,rules,run,attempts,changes}=input;
  const ticketIndex=plan?.tasks.findIndex(t=>t.id===stage) ?? -1;
  const ticket=plan?.tasks[ticketIndex];
  const isVerifier=Boolean(plan && stage===plan.id+'-verify');
  const title=ticket?.title || task?.text || (isVerifier?'Приёмка результата':'План проекта');
  const {branch,head,dirty}=workspace(root);
  const base=task ? task.base : plan?.base !== undefined ? plan.base : plan?.tasks[0]?.base;
  const stageState=ticket?.state || (isVerifier?plan?.verification?.state:plan?.tasks.length?'done':plan?.state) || run?.state || 'pending';
  const state=plan?.state==='interrupted' && stageState==='running'?'interrupted':stageState;
  const rows=['# Передача задачи · '+title,'Проект '+path.basename(root)+' · этап '+stage+' · '+(states[state] || state),
    '**Следующий шаг.** '+nextStep(stage,state,plan),
    '## Рабочая копия','Ветка: '+branch+'\n\nИсходный коммит задачи: '+(base || 'не записан')+'\n\nТекущий коммит: '+(head || 'пока нет коммитов')];
  if (dirty) {
    const files=dirty.split('\n');
    rows.push('Для продолжения понадобятся изменения поверх текущего коммита. Сверь список рабочей копии с задачей и попроси автора передать нужные изменения отдельным коммитом или файлами. Markdown описывает работу, исходные файлы передаются отдельно.',
      'Git помечает новые файлы `??`, изменённые — `M`, удалённые — `D`, добавленные в индекс — `A`. Список может включать работу над другими задачами.',
      code(files.slice(0,200).join('\n')));
    if (files.length>200) rows.push('Показаны первые 200 путей из '+files.length+'. Остальные доступны у автора через git status --short --untracked-files=all.');
  } else rows.push('В коде проекта нет незакоммиченных изменений. Для продолжения используй указанный текущий коммит.');
  if (plan) rows.push('## Идея и решения пользователя',ideaBrief(plan));
  if (task) rows.push('## Задание',task.text);
  const files=[...new Set([...(task?.files || []),...rules.flatMap(r=>r.files)])];
  if (files.length) rows.push('## Файлы задачи',list(files));
  if (rules.length) rows.push('## Сохранённые решения',list(rules.map(r=>r.id+' · '+r.text)));
  const earlier=plan?.tasks.slice(0,ticketIndex>=0 ? ticketIndex : isVerifier ? plan.tasks.length : 0).filter(t=>t.state==='done' && t.summary) || [];
  if (earlier.length) rows.push('## От предыдущих исполнителей',list(earlier.map(t=>t.title+' — '+t.summary)));
  if (ticket?.summary) rows.push('## Сообщение исполнителя этого этапа',ticket.summary);
  if (plan && !task && !isVerifier) {
    if (plan.tasks.length) rows.push('## План работ',list(plan.tasks.map(t=>t.id+' · '+t.title+' ('+(states[t.state] || t.state)+')')));
    const questions=plan.clarifications?.filter(q=>!q.answer);
    if (questions?.length) rows.push('## Открытые вопросы',list(questions.map(q=>q.question)));
  }
  if (input.notes.length) rows.push('## Заметки разработчика',list(input.notes.map(n=>n.text)));
  if (task?.checks?.length) rows.push('## Что требуется проверить',list(task.checks));
  const transfers=(input.contextTransfers ?? []).filter(t=>t.stage===stage);
  if (transfers.length) rows.push('## Автоматическая передача между сессиями',list(transfers.map(t=>
    'Сессия '+t.fromAttempt+' → '+t.toAttempt+' · '+t.used+' из '+t.window+' токенов · порог '+t.thresholdPercent+'%.')));
  rows.push(...pauseSection(changes,files),...observed(run));
  const review=plan?.verification?.reports.at(-1);
  if (review) {
    rows.push('## Последняя независимая приёмка всего запуска','Статус приёмки: '+(review.status==='failed'?'обнаружены расхождения':states[review.status])+'.',review.summary);
    if (review.checks.length) rows.push(list(review.checks.map(c=>(c.passed?'✓':'×')+' '+c.requirement+'\n  Ожидалось: '+c.expected+'\n  Наблюдалось: '+c.actual)));
    const commands=review.commands.filter(c=>c.command.length<=400 && !c.command.includes('\n')).slice(-8);
    if (commands.length) rows.push('Команды приёмки и их коды завершения:',code(commands.map(c=>'Код '+c.exitCode+' · '+c.command).join('\n')));
  } else rows.push('## Независимая приёмка','Отчёт независимой приёмки для этого запуска отсутствует.');
  if (attempts) rows.push('## Сохранённые задания','У автора сохранено попыток: '+attempts+'. Точное последнее задание можно открыть в его рабочей копии.',code('pilot packet '+stage+' '+attempts));
  let document=rows.join('\n\n')+'\n';
  // Make paths in agent responses relocatable without changing relative paths in the brief.
  const roots=process.platform==='darwin' && root.startsWith('/private/') ? [root,root.slice('/private'.length)] : [root];
  for (const directory of roots) document=document.replaceAll(directory+path.sep,'./').replaceAll(directory,'[корень проекта]');
  return redactSecrets(document.replaceAll(homedir()+path.sep,'~/'));
}
