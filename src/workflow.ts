export const phases = [
  ['prepare','Подготовка'], ['requirements','Требования'], ['brief','Брифинг'],
  ['spec','Спецификация'], ['plan','План'], ['build','Разработка'],
  ['review','Код-ревью'], ['accept','Приёмка']
] as const;
export type PhaseId = typeof phases[number][0];
export type Requirement = {id:string;text:string};
export type Phase = {id:PhaseId;name:string;state:'pending'|'running'|'done'|'failed'|'interrupted'|'awaiting_answers';started?:string;ended?:string;summary?:string};
export type BlindCopy = {id:string;digest:string;files:number;excluded:string[];created:string;state:'checking'|'passed'|'failed'|'blocked'|'interrupted'};
export type Workflow = {
  version:1; phases:Phase[]; requirements?:Requirement[];
  specification?:{summary:string;requirements:Requirement[]};
  specificationReview?:{passed:boolean;issues:string[]};
  coverage?:{requirement:string;tasks:string[]}[];
  baseline?:{directory:string;digest:string;files:string[]};
  blindCopies:BlindCopy[];
};
export function newWorkflow():Workflow {
  return {version:1,phases:phases.map(([id,name])=>({id,name,state:'pending'})),blindCopies:[]};
}
export function setPhase(workflow:Workflow,id:PhaseId,state:Phase['state'],summary?:string) {
  const phase=workflow.phases.find(p=>p.id===id)!;
  phase.state=state;
  if(state==='running'){phase.started=new Date().toISOString();delete phase.ended;delete phase.summary;}
  if(state==='done'||state==='failed'||state==='interrupted')phase.ended=new Date().toISOString();
  if(summary!==undefined)phase.summary=summary;
}
const string={type:'string'};
export function schema(properties:Record<string,unknown>) {
  return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}
const requirements={type:'array',items:schema({id:string,text:string})};
export const requirementsSchema=schema({requirements});
export const briefingSchema=schema({questions:{type:'array',items:schema({question:string,options:{type:'array',items:string}})}});
export const specificationSchema=schema({summary:string,requirements});
export const auditSchema=schema({passed:{type:'boolean'},issues:{type:'array',items:string}});
export function validateRequirements(value:unknown):Requirement[] {
  if(!Array.isArray(value)||!value.length||value.length>40)throw Error('Нужны от 1 до 40 требований.');
  const seen=new Set<string>();
  return value.map(item=>{
    if(!/^R-[0-9]{1,3}$/.test(item?.id)||seen.has(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>2000)
      throw Error('Некорректное или повторяющееся требование.');
    seen.add(item.id);return {id:item.id,text:item.text.trim()};
  });
}
export function requirementCoverage(requirements:Requirement[],tasks:{id:string;requirementIds?:string[]}[]) {
  const known=new Set(requirements.map(r=>r.id));
  for(const task of tasks)if(!task.requirementIds?.length||task.requirementIds.some(id=>!known.has(id)))
    throw Error('G3: у каждой задачи нужны известные requirementIds.');
  return requirements.map(requirement=>{
    const links=tasks.filter(t=>t.requirementIds!.includes(requirement.id)).map(t=>t.id);
    if(!links.length)throw Error('G3: требование '+requirement.id+' потеряно в плане.');
    return {requirement:requirement.id,tasks:links};
  });
}
