import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import type {CommandResult} from './activity.ts';

type AcceptanceTask = {checks:string[]; acceptanceCommands?:string[]};
export type AcceptanceCheck = {requirement:string;expected:string;actual:string;passed:boolean};

// Older plans store both prose and command lines in checks. Only promote known
// test runners from prose. New plans declare runnable commands separately.
const testRunner = /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test|test:[\w-]+)(?:\s|$)|node (?:--test(?:\s|$)|[^ ]*[-.]test\.[cm]?[jt]s(?:\s|$))|(?:python3? -m )?pytest(?:\s|$)|go test(?:\s|$)|cargo test(?:\s|$))/;
export function projectTest(root:string):string[] {
  try {
    const manifest=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
    if (typeof manifest.scripts?.test==='string' && manifest.scripts.test.trim()) return ['npm test'];
  } catch { /* A project can use a language or runner without package.json. */ }
  return [];
}

function directCommand(value:string):boolean {
  // Keep a direct argv invocation. Quoted JS or regex arguments may contain
  // punctuation; shell chains and command substitutions may mask a failure.
  if (/^(?:[^\s]*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c(?:\s|$)/.test(value)) return false;
  const word=/(?:[^\s'";&|`$<>\\(){}]+|'[^'\r\n]*'|"(?:[^"\\`$\r\n]|\\.)*"|\\[^\r\n])+/y;
  let cursor=0;
  while (cursor<value.length) {
    word.lastIndex=cursor;
    if (!word.exec(value)) return false;
    cursor=word.lastIndex;
    if (cursor<value.length && !/[ \t]/.test(value[cursor])) return false;
    while (cursor<value.length && /[ \t]/.test(value[cursor])) cursor++;
  }
  return value.length>0;
}

export function requiredCommands(tasks:AcceptanceTask[],suite:string[]):string[] {
  const result=new Set(suite);
  for (const task of tasks) {
    for (const declared of task.acceptanceCommands ?? []) {
      if (!directCommand(declared)) throw Error('Обязательная проверка должна быть отдельной командой, без цепочки или перенаправления: '+declared);
      result.add(declared);
    }
    for (const criterion of task.checks) {
      const quoted=Array.from(criterion.matchAll(/`([^`]+)`/g),match=>match[1].trim());
      for (const command of quoted) {
        if (testRunner.test(command) && directCommand(command)) result.add(command);
      }
      // Legacy unquoted prose can start with "npm test should pass".
      // Preserve plain runner lines, never treat trailing prose as argument text.
      if (!quoted.length) {
        const runner=criterion.match(testRunner)?.[0].trimEnd();
        const args=runner?criterion.slice(runner.length).trim().split(/\s+/).filter(Boolean):[];
        if (runner && directCommand(criterion) &&
            args.every(arg=>arg.startsWith('-') || /[./]/.test(arg))) result.add(criterion);
      }
    }
  }
  return [...result];
}

// Codex renders its argv as e.g. /bin/zsh -lc 'npm test'. Remove only
// one literal shell argument. Never interpret a tool command as shell code.
function invocation(command:string):string {
  const text=command.trim();
  const wrapped=text.match(/^(?:[^\s]*\/)?(?:ba|z|da|k)?sh -(?:lc|c) (.+)$/s);
  if (!wrapped) return text;
  const word=wrapped[1];
  if (word.startsWith("'") && word.endsWith("'")) return word.slice(1,-1).replaceAll("'\"'\"'","'");
  if (word.startsWith('"') && word.endsWith('"')) return word.slice(1,-1).replace(/\\([\\"$`])/g,'$1');
  return word;
}

export function rootPrefix(root:string) {
  return "cd '"+root.replaceAll("'","'\"'\"'")+"' && ";
}

function sameDirectory(root:string,cwd?:string) {
  if (!cwd) return false;
  try {return realpathSync(root)===realpathSync(cwd);} catch {return false;}
}

export function checkEvidence(required:string[],commands:CommandResult[],root:string) {
  const prefix=rootPrefix(root);
  const observed=commands.map(c=>{
    const cmd=invocation(c.command);
    const anchored=cmd.startsWith(prefix);
    return {...c,invocation:anchored?cmd.slice(prefix.length):cmd,inProject:anchored || sameDirectory(root,c.cwd)};
  });
  const names=new Set(required);
  // A failing test witnessed during review must not disappear behind a successful
  // diagnostic command or the reviewer's own "passed" message.
  for (const c of observed) if (testRunner.test(c.invocation) && c.exitCode!==0 && (c.inProject || !c.cwd)) names.add(c.invocation);
  const checks:AcceptanceCheck[]=[];
  const failed:string[]=[],missing:string[]=[];
  for (const cmd of names) {
    // A known failure from an old transport still disproves a pass.
    // Its zero exit alone does not prove which checkout was tested.
    const runs=observed.filter(c=>c.invocation===cmd && (c.inProject || (!c.cwd && c.exitCode!==0)));
    const failure=runs.find(c=>Number.isInteger(c.exitCode) && c.exitCode!==0);
    const incomplete=runs.some(c=>!Number.isInteger(c.exitCode));
    const passed=!!runs.length && !failure && !incomplete;
    const actual=failure ? 'Код '+failure.exitCode+(failure.output?'\n'+failure.output.slice(-700):'')
      : passed ? 'Код 0' : incomplete?'Код завершения неизвестен.':'Нет отдельного запуска этой команды в корне проекта.';
    checks.push({requirement:cmd,expected:'Команда завершается с кодом 0.',actual,passed});
    if (failure) failed.push(cmd+' (код '+failure.exitCode+')');
    else if (!passed) missing.push(cmd);
  }
  return {checks,failed,missing};
}
