#!/usr/bin/env node
import {phases} from './workflow.ts';
import {redactSecrets} from './privacy.ts';
import { readGit } from './git-read.ts';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ideas, ideaBrief, findTicket, startIdea, stopIdea, resumeIdea, answerIdea } from './ideas.ts';
import { agentPreflight } from './preflight.ts';
import { packets } from './packets.ts';
import { memoryDirectory, memoryFile, readMemoryFile, recordId as id, projectFile } from './memory-path.ts';
import { handoff, type Rule, type Task } from './handoff.ts';
import { pauseChanges } from './pause-changes.ts';
import { dashboard } from './server.ts';
import { activity, addNote, notes } from './activity.ts';
import { runStandalone, standaloneContext } from './standalone.ts';

const help = `Context Pilot · передача задач в новый чат
pilot init
pilot doctor                     найти Codex и Claude Code, проверить вход
pilot rule ID "Решение и его причина" [--file путь]
pilot task ID "Следующая задача" [--rule ID] [--file путь] [--check "команда"]
pilot tasks                      вывести список задач в JSON
pilot context ID                 собрать задание для нового агента
pilot idea "Идея проекта"        составить план и реализовать по задачам
pilot stop ID / pilot resume ID   остановить или продолжить запуск идеи
pilot packet ID [попытка]        показать сохранённое задание этапа
pilot handoff ID                 вывести Markdown для передачи напарнику
pilot dashboard [--port N]       открыть панель текущего проекта
pilot run ID [--workspace-write] запустить Codex; флаг разрешает изменения в проекте
pilot note ID "Что сделано"      оставить запись для следующего чата
Флаги можно повторять. Пути отсчитываются от корня Git.`;

function git(args: string[], cwd = process.cwd()) {
  return readGit(args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
async function main(args: string[]) {
  const [command, key, description, ...rest] = args;
  if (!command || ['--help', '-h', 'help'].includes(command)) return console.log(help);
  const providers = agentPreflight();
  if (command === 'doctor' && args.length === 1) {
    const {codex, claude} = await providers.status();
    console.log(['Автоматический запуск через Codex', codex.label, codex.instruction, ...codex.commands].join('\n'));
    console.log('\n' + ['Ручная передача в Claude Code', claude.label, claude.instruction, ...claude.commands].filter(Boolean).join('\n'));
    process.exitCode = codex.state === 'ready' ? 0 : 1;
    return;
  }
  let root: string;
  try { root = git(['rev-parse', '--show-toplevel']); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error('Установите Git и откройте терминал в папке своего проекта.');
    if (/not a git repository/i.test((error as Error).message)) throw Error('Перейдите в папку своего Git-проекта. Для нового проекта выполните git init в его папке.');
    throw error;
  }
  const memory = path.join(root, '.pilot');
  if (command === 'init') {
    for (const kind of ['rules', 'tasks'] as const) mkdirSync(memoryDirectory(memory, kind), { recursive: true });
    return console.log('Память проекта: .pilot/. Добавьте её в Git для передачи в новый клон.');
  }
  if (!existsSync(memoryDirectory(memory, 'tasks'))) throw Error('Сначала выполните pilot init.');
  const file = (kind: 'tasks' | 'rules', key: string) => memoryFile(memory, kind, key);
  function read<T>(kind: 'tasks' | 'rules', key: string): T {
    const name = file(kind, key);
    if (!existsSync(name)) throw Error('Нет записи: ' + kind + '/' + key);
    return JSON.parse(readMemoryFile(name));
  }
  function listTasks() {
    const keys = readdirSync(memoryDirectory(memory, 'tasks'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5))
      .sort();
    const tasks = keys.map(key => {
      const { id, text } = read<Task>('tasks', key);
      return { id, text };
    });
    const planned = ideas(memory).flatMap(plan => plan.tasks.map(({id,text}) => ({id,text})));
    return [...tasks,...planned].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  if (command === 'tasks') {
    if (args.length !== 1) throw Error('Использование: pilot tasks');
    return console.log(JSON.stringify({schemaVersion: 1, tasks: listTasks()}));
  }
  if (command === 'rule' || command === 'task') {
    id(key);
    if (!description?.trim()) throw Error('Требуется описание.');
    const files: string[] = [], rules: string[] = [], checks: string[] = [];
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i], value = rest[i + 1];
      if (!value?.trim()) throw Error('Нет значения для ' + flag);
      if (flag === '--file') {
        files.push(projectFile(root, value));
      } else if (flag === '--rule' && command === 'task') {
        read<Rule>('rules', value);
        rules.push(value);
      } else if (flag === '--check' && command === 'task') checks.push(value);
      else throw Error('Неизвестный флаг: ' + flag);
    }
    const record: Rule = { id: key, text: description, files };
    if (command === 'task') {
      let base: string | null = null;
      try { base = git(['rev-parse', '--verify', 'HEAD'], root); } catch { /* New repository */ }
      Object.assign(record, { rules, checks, base });
    }
    writeFileSync(file(command === 'rule' ? 'rules' : 'tasks', key), JSON.stringify(record, null, 2) + '\n', {flag: 'wx'});
    return console.log('Сохранено: ' + key);
  }
  function context(key: string) {
    const linked = findTicket(ideas(memory), key);
    const task = linked?.task ?? read<Task>('tasks', key);
    const rules = task.rules.map(k => read<Rule>('rules', k));
    const files = [...new Set([...task.files, ...rules.flatMap(r => r.files)].map(value => projectFile(root, value)))];
    const list = (values: string[]) => values.length ? values.map(v => '- ' + v).join('\n') : '—';
    let history = 'Исходный коммит не записан.';
    if (task.base) {
      if (typeof task.base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(task.base)) throw Error('Некорректный исходный коммит задачи.');
      try { history = git(['diff', '--name-only', task.base, 'HEAD', '--', ...files], root) || 'Изменений между коммитами нет.'; }
      catch { history = 'Исходный коммит недоступен. Сверь указанные файлы с текущим кодом.'; }
    }
    const dirty = git(['status', '--porcelain=v1', '--', ...files], root);
    const saved = notes(memory, key);
    return [
      '# Задача ' + task.id, task.text,
      ...(linked ? ['## Идея проекта', ideaBrief(linked.plan), '## Результаты предыдущих задач',
        list(linked.preceding.filter(t=>t.state==='done').map(t=>t.id+' · '+t.title+' — '+t.summary))] : []),
      '## Сохранённые решения', list(rules.map(r => r.id + ': ' + r.text)),
      '## Открой в текущей рабочей копии', list(files),
      '## Изменения после постановки задачи', history,
      '## Незакоммиченные изменения', dirty || 'Нет.',
      ...(saved.length ? ['## Заметки для передачи', list(saved.map(n => n.text))] : []),
      '## Проверки', list(task.checks), linked ? 'Выполни только эту задачу в рабочей копии. Не редактируй .pilot. Проведи указанные проверки. В summary укажи изменённые файлы, интерфейсы, результаты проверок и что нужно следующему исполнителю. Если работу или обязательную проверку не удалось завершить, верни status blocked.' : 'Выполни задачу и сообщи фактические результаты проверок.'
    ].join('\n\n') + '\n';
  }
  if (command === 'context' && args.length === 2) return process.stdout.write(redactSecrets(context(key)));
  const logs = git(['rev-parse', '--path-format=absolute', '--git-path', 'context-pilot/runs'], root);
  async function agentProject() {
    await providers.requireReady();
    return project();
  }
  function project() {
    let base: string | null = null;
    try { base = git(['rev-parse','--verify','HEAD'],root); } catch { /* Empty Git repo */ }
    return {root,memory,logs,base,context};
  }
  type Plan = ReturnType<typeof ideas>[number];
  function stagePlan(plans:Plan[], key:string) {
    return plans.find(plan=>key===plan.id+'-plan' || (plan.verification && key===plan.id+'-verify') || plan.tasks.some(task=>task.id===key) || Boolean(plan.workflow && phases.some(([phase])=>key===plan.id+'-'+(phase==='review'?'verify':phase==='accept'?'blind':phase))));
  }
  function changesFor(plan?:Plan) { return plan ? pauseChanges(root,logs,plan) : null; }
  function exportHandoff(key:string) {
    id(key);
    const plan=stagePlan(ideas(memory),key);
    const task=plan ? plan.tasks.find(task=>task.id===key) : read<Task>('tasks',key);
    const transfers=[...(plan?.contextTransfers ?? []),...(standaloneContext(logs)[key]?.contextTransfers ?? [])].sort((a,b)=>a.fromAttempt-b.fromAttempt);
    return handoff({root,stage:key,plan,task,contextTransfers:transfers,rules:(task?.rules || []).map(k=>read<Rule>('rules',k)),
      notes:notes(memory,key),run:activity(logs).find(run=>run.task===key),attempts:packets(logs,key).length,changes:changesFor(plan)});
  }
  if (command==='handoff') {
    if (args.length!==2) throw Error('Использование: pilot handoff ID');
    return process.stdout.write(exportHandoff(key));
  }
  if (command === 'packet' && (args.length===2 || args.length===3)) {
    const attempts=packets(logs,id(key));
    const packet=description ? attempts[Number(description)-1] : attempts.at(-1);
    if (!packet) throw Error('Нет сохранённой попытки.');
    return process.stdout.write(redactSecrets(packet));
  }
  if (command==='stop' && args.length===2) return console.log('Остановка '+stopIdea(project(),key));
  if (['idea','resume'].includes(command) && args.length === 2) {
    const ready = await agentProject();
    const job = command==='resume' ? resumeIdea(ready,key) : startIdea(ready,key);
    console.log('Идея '+job.id+' · прогресс доступен через pilot dashboard');
    process.exitCode = await job.finished;
    return;
  }
  if (command === 'run') {
    const writable = args.length === 3 && args[2] === '--workspace-write';
    if (args.length !== 2 && !writable) throw Error('Использование: pilot run ID [--workspace-write]');
    const packet = context(key);
    await providers.requireReady();
    process.exitCode = await runStandalone(root, logs, id(key), packet, writable);
    return;
  }
  if (command === 'note' && args.length === 3 && description.trim()) {
    if (!findTicket(ideas(memory),key)) read<Task>('tasks', key);
    addNote(memory, key, description);
    console.log('Запись добавлена в контекст.');
    return;
  }
  if (command === 'dashboard') {
    if (args.length !== 1 && !(args.length === 3 && key === '--port' && /^\d{1,5}$/.test(description) && Number(description) <= 65535))
      throw Error('Использование: pilot dashboard [--port N]');
    return dashboard(Number(description || 0), async selected => {
      const detected = await providers.status();
      const tasks = listTasks();
      const runs = activity(logs);
      const plans = ideas(memory);
      const special = selected && stagePlan(plans,selected) && !plans.some(p=>p.tasks.some(t=>t.id===selected));
      const manual=standaloneContext(logs);
      if (special) return {...detected,standaloneContext:manual,project:path.basename(root),branch:git(['branch','--show-current'],root)||'detached HEAD',pauseChanges:changesFor(stagePlan(plans,selected!)),
        plans,tasks,runs,selected,packet:'',attempts:packets(logs,selected),notes:[]};
      const latest = plans[0];
      const focus = latest?.tasks.find(t=>t.state==='running' || t.state==='failed') || latest?.tasks.at(-1);
      const task = selected || focus?.id || runs.find(r => r.state === 'running')?.task || runs[0]?.task || tasks[0]?.id;
      if (task && !tasks.some(t => t.id === task)) {
        if (selected) throw Error('Задача не найдена.');
      }
      const current = tasks.find(t => t.id === task) || tasks[0];
      return {...detected,standaloneContext:manual,project: path.basename(root), branch: git(['branch','--show-current'], root) || 'detached HEAD',
        plans, tasks, runs, selected: current?.id, pauseChanges:changesFor(current ? stagePlan(plans,current.id) : latest), packet: current ? context(current.id) : '',
        attempts: current ? packets(logs,current.id) : [], notes: current ? notes(memory,current.id) : []};
    }, async idea => startIdea(await agentProject(),idea).id,
      async (action,id) => action==='stop' ? stopIdea(project(),id) : resumeIdea(await agentProject(),id).id,
      async (id,answers) => answerIdea(await agentProject(),id,answers).id, exportHandoff);
  }
  throw Error('Неизвестная команда: ' + command);
}
main(process.argv.slice(2)).catch(err => {
  console.error('pilot: ' + redactSecrets(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
