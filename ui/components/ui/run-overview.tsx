import {Activity, ArrowRight, Check, Circle, GitBranch, MessageCircle, ShieldCheck} from 'lucide-react';
import {duration, labels, time, type Pipeline, type Stage} from '../../model';
import {ShortText, stageName} from './stage-content';

type Props = {flow: Pipeline; online: boolean; selected: Stage; onPick: (stage: Stage, view?: 'task'|'transfer'|'result') => void};
type Gate = {title: string; detail: string; state: 'passed'|'waiting'|'failed'};

export function RunOverview({flow, online, selected, onPick}: Props) {
  const report = flow.reports?.at(-1);
  const current = flow.stages.find(s => ['active','needs_answer','failed','interrupted'].includes(s.state)) ?? selected;
  const workers = flow.stages.filter(s => s.role === 'agent' && !s.phase);
  const reviewer = flow.stages.filter(s => s.role === 'verifier').at(-1);
  const questions = flow.clarifications ?? [];
  const answered = questions.filter(q => q.answer?.trim()).length;
  const passed = report?.checks.filter(c => c.passed).length ?? 0;
  const verified = flow.state === 'done' && report?.status === 'passed';
  const stopped = flow.state === 'interrupted';
  const failed = flow.state === 'failed';
  const awaiting = flow.state === 'needs_answer';
  const commands = flow.requiredCommands ?? [];
  const commandResults = commands.map(command => report?.checks.find(c => c.requirement === command));
  const commandsPassed = commands.length > 0 && commandResults.every(c => c?.passed === true);
  const commandsFailed = commandResults.some(c => c && !c.passed);
  const tasksDefined = workers.length > 0 && workers.every(s => (s.ticket?.checks?.length ?? 0) > 0);
  let gates: Gate[] = [
    {title: 'Идея и ответы', detail: questions.length ? `${answered} из ${questions.length} уточнений сохранено` : 'Исходная идея сохранена в проекте', state: answered === questions.length ? 'passed' : 'waiting'},
    {title: 'План и критерии', detail: tasksDefined ? `Задач с условиями приёмки · ${workers.length}` : 'Ждём задачи с критериями проверки', state: tasksDefined ? 'passed' : 'waiting'},
    {title: 'Обязательные команды', detail: commands.length ? `${commandResults.filter(c => c?.passed).length} из ${commands.length} команд завершились с кодом 0` : 'Команды приёмки пока не заданы', state: commandsPassed ? 'passed' : commandsFailed ? 'failed' : 'waiting'},
    {title: 'Независимая приёмка', detail: report ? `${passed} из ${report.checks.length} критериев · ${report.status === 'passed' ? 'проверено' : 'требуется проверка'}` : 'Отдельный агент проверит результат', state: verified ? 'passed' : report && report.status !== 'passed' ? 'failed' : 'waiting'}
  ];
  if(flow.workflow) {
    const workflow=flow.workflow;
    const gate=(id:string)=>workflow.phases.find(p=>p.id===id);
    gates=[
      {title:'G1 · Брифинг',detail:'Все ответы пользователя сохранены',state:gate('brief')?.state==='done'?'passed':'waiting'},
      {title:'G2 · Полнота спецификации',detail:workflow.specificationReview?.issues.join(' · ') || 'Независимый читатель сверяет с брифом',state:workflow.specificationReview?.passed?'passed':workflow.specificationReview?'failed':'waiting'},
      {title:'G3 · Покрытие требований',detail:workflow.coverage?workflow.coverage.length+' требований связаны с задачами':'Каждое требование должно попасть в задачу',state:workflow.coverage?'passed':'waiting'},
      {title:'G4 · Слепая приёмка',detail:workflow.blindCopies.length?'Отдельных копий: '+workflow.blindCopies.length:'Новая копия, исходный бриф, отдельный агент',state:gate('accept')?.state==='done'&&verified?'passed':gate('accept')?.state==='failed'?'failed':'waiting'}
    ];
  }
  const events = flow.stages.filter(s=>s.phase!=='build').flatMap(stage => stage.logs.map(entry => ({...entry, stage})))
    .filter(entry => !entry.text.startsWith('{'))
    .sort((a,b) => Date.parse(b.time) - Date.parse(a.time)).slice(0,5);
  const title = verified ? 'Результат проверен' : awaiting ? 'Нужен твой ответ' : stopped ? 'Можно продолжить с места остановки' : failed ? 'Запуск требует внимания' : flow.state === 'done' ? 'Работа завершена, проверь приёмку' : 'Проект в работе';
  const description = verified ? 'Команды и вывод сохранены. Можно открыть отчёт приёмки и передать проект напарнику.' : awaiting ? 'Ответь на вопросы планировщика ниже. По ответам Pilot составит задачи и запустит исполнителей.' : stopped || failed ? 'Открой проблемный этап. Следующая сессия получит сохранённое задание и изменения предыдущей.' : `Текущий этап — ${stageName(current).toLowerCase()}. События запуска появляются по мере работы.`;
  function inspect(stage: Stage, view?: 'task'|'transfer'|'result') {
    onPick(stage, view);
    requestAnimationFrame(() => document.querySelector('.pipeline')?.scrollIntoView({block:'start'}));
  }
  return <section className="mission" aria-label="Обзор запуска">
    <div className="mission-heading"><span><GitBranch size={15}/> Рабочий проект</span><span className="mission-connection" data-online={online}>{online ? 'Связь с проектом' : 'Нет связи'}</span></div>
    <div className="mission-hero" data-tone={verified ? 'success' : awaiting || stopped ? 'attention' : failed ? 'error' : 'working'}>
      <div className="mission-label"><Activity size={15}/>{verified ? 'Приёмка пройдена' : labels[flow.state ?? current.state]}</div>
      <h2>{title}</h2><p>{description}</p>
      <button className="mission-next" onClick={() => inspect(verified && reviewer ? reviewer : current)}>
        {verified ? 'Посмотреть результат' : awaiting ? 'Ответить на вопросы' : failed ? 'Открыть этап с ошибкой' : stopped ? 'Открыть остановленный этап' : 'Открыть текущий этап'}<ArrowRight size={14}/>
      </button>
      <div className="mission-progress" aria-label="Этапы проекта">{flow.stages.filter(s=>!flow.workflow||s.phase).map((stage,index) => <button key={stage.id} data-state={stage.state} aria-pressed={stage.id === selected.id} onClick={() => inspect(stage)}>
        <span className="mission-track"/><span className="mission-stage-index">{stage.state === 'done' ? <Check size={13}/> : String(index+1).padStart(2,'0')}</span>
        <strong>{stageName(stage)}</strong><small>{labels[stage.state]}</small>
      </button>)}</div>
    </div>
    <div className="mission-metrics">
      <div><span>Задачи</span><strong>{workers.filter(s => s.state === 'done').length}<small> / {workers.length}</small></strong><p>завершено в этом запуске</p></div>
      <div><span>Критерии приёмки</span><strong>{report ? passed : '—'}<small>{report ? ` / ${report.checks.length}` : ''}</small></strong><p>{report ? 'по последней проверке' : 'проверка ещё не проведена'}</p></div>
      <div><span>Сессии агентов</span><strong>{flow.stages.reduce((n,s) => n+s.runs.length,0)}</strong><p>включая повторные попытки</p></div>
      <div><span>Время агентов</span><strong>{duration(flow.stages.reduce((n,s) => n+(s.duration ?? 0),0))}</strong><p>последние попытки этапов</p></div>
    </div>
    <div className="mission-quality"><div className="mission-section-title"><h3><ShieldCheck size={17}/> Проверки запуска</h3><span>{gates.filter(g => g.state === 'passed').length} из 4</span></div>
      <div className="mission-gates">{gates.map((gate,index) => <div key={gate.title} data-state={gate.state}><i>{gate.state === 'passed' ? <Check size={16}/> : <Circle size={14}/>}</i><div><b>{gate.title}</b><p>{gate.detail}</p></div><span>0{index+1}</span></div>)}</div>
      {reviewer && <button className="mission-report" onClick={() => inspect(reviewer,'result')}>Открыть отчёт приёмки <ArrowRight size={15}/></button>}
    </div>
    <details className="mission-feed" open><summary><span><MessageCircle size={16}/> Последние события</span><small>{events.length ? 'Из журналов агентов' : 'Ждём первый запуск'}</small></summary>
      <ol>{events.map((event,index) => <li key={event.time+index}><time dateTime={event.time}>{time(event.time)}</time><div><button onClick={() => inspect(event.stage)}>{stageName(event.stage)}</button><ShortText value={event.text} limit={145}/></div></li>)}</ol>
    </details>
  </section>;
}
