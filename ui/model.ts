import type {Workflow, PhaseId} from '../src/workflow';
interface CliStatus {state:'ready'|'missing'|'signed_out'|'unknown';label:string;instruction:string;commands:string[]}
export type State = 'needs_answer' | 'waiting' | 'active' | 'done' | 'failed' | 'interrupted';
export const labels: Record<State,string> = {needs_answer:'Ждёт ответа',waiting:'В очереди',active:'В работе',done:'Завершён',failed:'Ошибка',interrupted:'Прерван'};
const statuses: Record<string,State> = {awaiting_answers:'needs_answer',planning:'active',building:'active',verifying:'active',running:'active',done:'done',failed:'failed',interrupted:'interrupted',rotated:'interrupted',pending:'waiting'};
export interface Entry {time:string; text:string; state?:string; level?:'error'|'info'}
export interface ContextUsage {used:number;window:number;thresholdPercent:number;measuredAt:string}
export interface ContextTransfer {stage:string;fromAttempt:number;toAttempt:number;used:number;window:number;thresholdPercent:number;at:string}
export interface ContextPolicy {thresholdPercent:number;maxTransfers:number}
interface ContextHistory {contextTransfers?:ContextTransfer[];contextPolicy?:ContextPolicy}
export interface Run {id:string; task:string; state:string; time:string; startedAt:string; events:Entry[];attempt?:number;contextUsage?:ContextUsage}
export interface Ticket {id:string;title:string;text?:string;files?:string[];checks?:string[];state:string;summary:string}
export interface PauseChanges {
  status:'live'|'archived'|'unavailable';stage:string;pausedAt:string|null;resumedAt:string|null;
  base:string|null;head:string|null;files:{path:string;change:'added'|'modified'|'deleted';preview?:string}[];limited:boolean;
}
export type View = 'task' | 'transfer' | 'result';
export interface Report {kind?:'blind';copyId?:string;status:string;summary:string;checks:{requirement:string;expected:string;actual:string;passed:boolean}[];commands:{command:string;output:string;exitCode:number|null}[]}
export interface Question {id:string;question:string;options:string[];answer?:string}
export interface Plan extends ContextHistory {workflow?:Workflow;clarifications?:Question[];verification?:{state:string;reports:Report[];requiredCommands?:string[]};session?:string;retryStage?:string;id:string;idea:string;created:string;state:string;tasks:Ticket[];error:string}
export interface Snapshot {codex?:CliStatus;claude?:CliStatus;standaloneContext?:Record<string,ContextHistory>;pauseChanges?:PauseChanges|null;attempts?:string[];project:string;branch:string;plans:Plan[];tasks:{id:string;text:string}[];runs:Run[];selected?:string;packet:string;notes:Entry[]}
export interface Stage extends ContextHistory {phase?:PhaseId;id:string;name:string;label:string;role:'planner'|'agent'|'verifier';state:State;logs:Entry[];runs:Run[];duration?:number;summary:string;ticket?:Ticket}
export interface Pipeline {workflow?:Workflow;requiredCommands?:string[];clarifications?:Question[];retryReview?:boolean;retryStage?:string;action?:'resume'|'stop';reports?:Report[];id:string;title:string;manual:boolean;stages:Stage[];state?:State;started?:string;elapsed?:number;error?:string}
export const MANUAL = 'manual-tasks';
export function duration(ms?:number) {
  if(ms==null || !Number.isFinite(ms)) return '—';
  const sec = Math.max(0,Math.floor(ms/1000));
  return sec>=3600 ? Math.floor(sec/3600)+' ч '+Math.floor(sec%3600/60)+' мин' : sec>=60 ? Math.floor(sec/60)+' мин '+sec%60+' с' : sec+' с';
}
export const time = (date:string, day=false) => new Intl.DateTimeFormat('ru-RU',day ? {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'} : {hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(date));
export function pipelines(s:Snapshot,now:number):Pipeline[] {
  const stage = (history:ContextHistory|undefined,id:string,name:string,label:string,role:Stage['role'],state?:State,summary=''):Stage => {
    const runs=s.runs.filter(r=>r.task===id), last=runs[0];
    const elapsed=last && (last.state==='running' ? now : Date.parse(last.time))-Date.parse(last.startedAt || last.events[0]?.time);
    return {id,name,label,role,state:state ?? statuses[last?.state] ?? 'waiting',duration:elapsed,
      logs:runs.slice().reverse().flatMap(r=>r.events),runs,summary,contextPolicy:history?.contextPolicy,
      contextTransfers:history?.contextTransfers?.filter(transfer=>transfer.stage===id)};
  };
  const out:Pipeline[]=s.plans.map(p=>{
    const plannerState = p.tasks.length ? 'done' : statuses[p.state];
    let stages=[stage(p,p.id+'-plan','Планировщик','ПЛАН','planner',plannerState),
      ...p.tasks.map((t,i)=>({...stage(p,t.id,t.title,'Агент '+String(i+1).padStart(2,'0'),'agent',p.state==='interrupted' && t.state==='running' ? 'interrupted' : statuses[t.state],t.summary),ticket:t}))];
    if (p.verification) {
      const state = p.state==='interrupted' && p.verification.state==='running' ? 'interrupted' : statuses[p.verification.state];
      stages.push(stage(p,p.id+'-verify','Проверка результата','Проверка','verifier',state));
    }
    if(p.workflow) {
      const workers=stages.filter(t=>t.role==='agent');
      const phases=p.workflow.phases.map(phase=>{
        const suffix=phase.id==='review'?'verify':phase.id==='accept'?'blind':phase.id;
        const role=phase.id==='review'||phase.id==='accept'?'verifier':phase.id==='build'?'agent':'planner';
        const state=p.state==='interrupted'&&phase.state==='running'?'interrupted':statuses[phase.state] ?? 'waiting';
        const item={...stage(p,p.id+'-'+suffix,phase.name,phase.name,role,state,phase.summary),phase:phase.id};
        if(phase.id==='spec') {
          const audit=stage(p,p.id+'-spec-review','Читатель','Читатель','planner');
          item.logs.push(...audit.logs);item.runs.push(...audit.runs);
        }
        if(phase.id==='build')item.logs=workers.flatMap(w=>w.logs);
        return item;
      });
      stages=[...phases.slice(0,6),...workers,...phases.slice(6)];
    }
    const runs=s.runs.filter(r=>stages.some(t=>r.task===t.id));
    const end=statuses[p.state]==='active' ? now : runs.length ? Math.max(...runs.map(r=>Date.parse(r.time))) : undefined;
    const retryReview = p.state==='failed' && p.verification?.reports.at(-1)?.status==='blocked' && p.tasks.every(t=>t.state==='done');
    const retryStage = p.state==='failed' ? p.retryStage : undefined;
    return {workflow:p.workflow,requiredCommands:p.verification?.requiredCommands,clarifications:p.clarifications,retryReview,retryStage,id:p.id,title:p.idea,manual:false,stages,reports:p.verification?.reports,action:(retryStage || retryReview || p.state==='interrupted')?'resume':p.session && statuses[p.state]==='active'?'stop':undefined,state:statuses[p.state],started:p.created,elapsed:end==null ? undefined : end-Date.parse(p.created),error:p.error};
  });
  const ids=new Set(s.plans.flatMap(p=>p.tasks.map(t=>t.id)));
  const manual=s.tasks.filter(t=>!ids.has(t.id));
  if(manual.length) out.push({id:MANUAL,title:'Отдельные задачи',manual:true,stages:manual.map(t=>stage(s.standaloneContext?.[t.id],t.id,t.text,t.id,'agent'))});
  return out;
}
export function defaultStage(p:Pipeline,s:Snapshot){
  return p.stages.find(t=>t.state==='active' || t.state==='needs_answer') ?? p.stages.find(t=>t.state==='failed' || t.state==='interrupted') ??
    (p.manual ? p.stages.find(t=>t.id===s.selected) : undefined) ?? p.stages.at(-1);
}
export function saveFile(text:string,name:string,type:string){
  const url=URL.createObjectURL(new Blob([text],{type})), a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1200);
}
