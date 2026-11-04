import {useState} from 'react';
import {ArrowDownToLine, ArrowRight, CornerDownRight, Plus} from 'lucide-react';
import {duration, labels, time, type Pipeline, type Snapshot, type Stage, type View} from '../../model';
import {Changes, Journal, ReportContent, ShortText, stageName, TaskFacts, Transfer} from './stage-content';
import {AgentContext, RouteContext} from './context-meter';
import {RunOverview} from './run-overview';

function ClarificationPanel({flow, busy, onAnswered}: {
  flow: Pipeline; busy: boolean; onAnswered: () => void;
}) {
  const [draft, setDraft] = useState<Record<string,string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const questions = flow.clarifications;
  if (!questions?.length) return null;
  if (flow.state !== 'needs_answer') return <details className="decision-log">
    <summary>Ответы на уточнения · {questions.length}</summary>
    <dl>{questions.map(q=><div key={q.id}><dt>{q.question}</dt><dd>{q.answer}</dd></div>)}</dl>
  </details>;
  const complete = questions.every(q=>draft[q.id]?.trim());
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending || busy || !complete) return;
    setSending(true);
    setError('');
    try {
      const response = await fetch('/api/ideas/'+flow.id+'/answers',{
        method:'POST',headers:{'Content-Type':'application/json','X-Pilot-Action':'answers'},
        body:JSON.stringify({answers:draft})
      });
      if (!response.ok) throw Error((await response.json()).error);
      onAnswered();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить ответы.');
      setSending(false);
    }
  }
  function update(id:string,value:string) {
    setDraft(previous=>({...previous,[id]:value}));
  }
  return <form className="questions" onSubmit={submit}>
    <h2>Уточним идею</h2>
    <p>Выбери вариант или напиши свой ответ. По твоим решениям планировщик составит задачи.</p>
    {questions.map((q,i)=><fieldset key={q.id} disabled={sending}>
      <legend>{i+1}. {q.question}</legend>
      <div className="answers">{q.options.map(option=><button type="button" key={option}
        aria-pressed={draft[q.id]===option} onClick={()=>update(q.id,option)}>{option}</button>)}</div>
      <label htmlFor={flow.id+q.id}>Твой ответ</label>
      <textarea id={flow.id+q.id} value={draft[q.id]??''} maxLength={2000} required rows={2}
        onChange={e=>update(q.id,e.target.value)}/>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    {busy && <p>Другой запуск работает с проектом. Ответы можно отправить после его завершения.</p>}
    <button className="primary" disabled={busy || sending || !complete}>{sending ? 'Составляем план…' : 'Составить план по ответам'}</button>
  </form>;
}

function Route({flow,stage,onPick}: {flow:Pipeline;stage:Stage;onPick:(stage:Stage)=>void}) {
  const [list,setList]=useState(false);
  return <aside className="side" aria-label="Маршрут проекта"><div className="side-head"><h2>Ход работы</h2>
    <button className="route-mode" title={list?'Показать кубики':'Показать номера этапов'} aria-label="Вид списка" aria-pressed={list} onClick={()=>setList(!list)}>{list?'3D':'Список'}</button></div>
    <ol className="route">{flow.stages.map((s,i)=><li key={s.id}><button className="route-stop" data-status={s.state}
      title={stageName(s)} aria-pressed={s.id===stage.id} onClick={()=>onPick(s)}>
      {list ? <span className="number">{String(i+1).padStart(2,'0')}</span> :
        <svg className="cube" viewBox="0 0 32 32" aria-hidden="true">
          <path fill="var(--top)" d="M1 10 16 2l15 8-15 8z"/><path fill="var(--left)" d="m1 10 15 8v13L1 23z"/><path fill="var(--right)" d="m31 10-15 8v13l15-8z"/>
        </svg>}
      <span className="route-copy"><strong>{stageName(s)}</strong><small>{s.state==='done'?'Готово':s.state==='interrupted'?'На паузе':labels[s.state]}</small><RouteContext stage={s}/></span>
    </button></li>)}</ol>
  </aside>;
}

export function Masthead({children}: {children?:React.ReactNode}) {
  return <div className="meta"><div className="wordmark"><span className="logo"><CornerDownRight size={19}/></span><b>Context Pilot</b></div>{children}</div>;
}

interface PipelineProps {
  flow:Pipeline;flows:Pipeline[];stage:Stage;snapshot:Snapshot;view:View;busy:boolean;online:boolean;
  onChange:(id:string)=>void;onPick:(stage:Stage,view?:View)=>void;onCreate:()=>void;onRefresh:()=>void;
}

function stageStatus(flow:Pipeline,stage:Stage,view:View) {
  const report=flow.reports?.at(-1);
  if (view==='result' && report && stage.state!=='active') {
    if (report.status==='passed') return 'Проверено · '+report.checks.filter(c=>c.passed).length+' из '+report.checks.length;
    if (report.status==='blocked') return 'Проверка заблокирована';
    return 'Нужны исправления';
  }
  if (stage.state==='interrupted') return 'Задача на паузе';
  if (stage.state==='needs_answer') return 'Нужен твой ответ';
  if (stage.state==='done') return 'Этап завершён';
  return labels[stage.state];
}

function introduction(flow:Pipeline,stage:Stage,view:View) {
  if (view==='transfer') return 'Здесь можно проверить задание агента и скачать файл для напарника.';
  if (stage.id===flow.retryStage) return 'Сессия завершилась с ошибкой. Новый агент получит задание, последние действия и текущее состояние файлов.';
  if (stage.role==='verifier') return 'Отдельный агент сверяет поведение проекта с исходными условиями.';
  if (stage.state==='interrupted') return 'Сессия остановлена. При продолжении агент получит задание и сведения об изменениях в проекте.';
  if (stage.role==='planner') return stage.state==='done' ? flow.title : stage.state==='needs_answer'?'Планировщик ждёт твоих ответов, прежде чем создавать задачи.':'Планировщик читает проект и готовит задания для исполнителей.';
  if (stage.state==='done') return stage.label+' завершил работу над задачей.';
  if (stage.state==='waiting') return flow.manual?'Задача готова к запуску из терминала.':'Исполнитель начнёт работу, когда предыдущие этапы завершатся.';
  if (stage.state==='failed') return 'Исполнитель завершил работу с ошибкой. Подробности сохранены в журнале.';
  return 'Агент работает в отдельной сессии. События и состояние файлов обновляются во время работы.';
}

export function BuildPipeline({flow,flows,stage,snapshot,view,busy,online,onCreate,onPick,onChange,onRefresh}:PipelineProps) {
  const [changing,setChanging]=useState(false),[actionError,setActionError]=useState('');
  const ready=snapshot.selected===stage.id;
  const drift=snapshot.pauseChanges && flow.stages.some(s=>s.id===snapshot.pauseChanges?.stage) ? snapshot.pauseChanges : null;
  const archived=ready ? snapshot.attempts ?? [] : [];
  const verifier=flow.stages.find(s=>s.role==='verifier');
  const task=stage.role!=='verifier'?stage:flow.stages.find(s=>s.id===drift?.stage && s.role!=='verifier') ?? flow.stages.filter(s=>s.role==='agent').at(-1) ?? flow.stages[0];
  const transferTarget=stage.role==='verifier' && task ? task : stage;
  const liveEvent=stage.state==='active' ? stage.logs.filter(entry=>!entry.text.startsWith('{')).at(-1) : undefined;
  const title=view==='result'?'Проверка результата':stage.role==='planner' && view==='task'?'План проекта':stageName(stage);
  async function control() {
    if(!flow.action || changing || !online)return;
    setChanging(true);setActionError('');
    try {
      const res=await fetch('/api/ideas/'+flow.id+'/'+flow.action,{method:'POST',headers:{'Content-Type':'application/json','X-Pilot-Action':flow.action},body:'{}'});
      if(!res.ok)throw Error((await res.json()).error || 'Не удалось изменить состояние запуска.');
      onChange(flow.id);onRefresh();
    } catch(err) {setActionError((err as Error).message);}
    finally {setChanging(false);}
  }
  return <><Masthead><div className="workspace-tools">
    <label className="run-picker"><span className="sr-only">Выбрать запуск</span><select aria-label="Выбрать запуск" value={flow.id} onChange={e=>onChange(e.target.value)}>
      {flows.map(f=><option key={f.id} value={f.id}>{f.manual?f.title:f.id+' · '+f.title.slice(0,70)}</option>)}
    </select></label><button className="create" disabled={!online||busy||snapshot.codex?.state!=='ready'} onClick={onCreate}><Plus size={14}/>Новая идея</button>
  </div></Masthead>
    <RunOverview flow={flow} online={online} selected={stage} onPick={onPick}/>
    <article className="card pipeline">
      <header className="topbar"><span className="project">{snapshot.project} <span>/ {snapshot.branch}</span></span>
        <nav aria-label="Раздел запуска">
          <button aria-pressed={view==='task'} onClick={()=>onPick(task,'task')}>{task.state==='interrupted'?'Пауза':'Задача'}</button>
          <button aria-pressed={view==='transfer'} onClick={()=>onPick(transferTarget,'transfer')}>Передача</button>
          {verifier && <button aria-pressed={view==='result'} onClick={()=>onPick(verifier,'result')}>Результат</button>}
        </nav>
      </header>
      <div className="panel"><section className="main-panel">
        <span className="status" data-status={stage.state}>{stageStatus(flow,stage,view)}</span>
        <h1>{title}</h1><p className="lead"><ShortText value={introduction(flow,stage,view)} limit={215}/></p>
        <div className="action-row">
          {flow.action && <button className={flow.action==='resume'?'primary':'subtle'} disabled={!online || changing || (flow.action==='resume' && (busy || snapshot.codex?.state!=='ready'))} onClick={control}>
            {changing?'Обновляем…':flow.action==='stop'?'Остановить':flow.retryStage?'Повторить этап с ошибкой':flow.retryReview?'Повторить проверку':'Продолжить запуск'}{flow.action==='resume'&&<ArrowRight size={16}/>}
          </button>}
          <a className={flow.action==='resume'?'subtle':'primary'} href={'/api/handoff?task='+encodeURIComponent(stage.id)} download>
            <ArrowDownToLine size={15}/>Скачать для напарника
          </a>
        </div>
        {actionError && <p className="alert" role="alert">{actionError}</p>}
        {flow.error && flow.error!=='Запуск остановлен. Задание и файлы сохранены.' && <p className="alert">{flow.error}</p>}
        {flow.clarifications?.length && (flow.state==='needs_answer' || (view==='task' && stage.role==='planner')) ?
          <ClarificationPanel key={'questions-'+flow.id} flow={flow} busy={busy || !online || snapshot.codex?.state!=='ready'} onAnswered={()=>{onChange(flow.id);onRefresh();}}/> : null}
        {view!=='transfer' && <AgentContext stage={stage}/>}
        {liveEvent && view==='task' && <div className="live-event"><span>Сейчас · {time(liveEvent.time)}</span><ShortText value={liveEvent.text} limit={145}/></div>}
        {drift?.files.length ? <Changes drift={drift} flow={flow} stage={stage}/> : null}
        {view==='result' ? <ReportContent flow={flow}/> : view==='transfer' ?
          <Transfer key={'transfer-'+stage.id} stage={stage} flow={flow} attempts={archived} packet={ready?snapshot.packet:''} notes={ready?snapshot.notes:[]} loading={!ready}/> :
          <TaskFacts stage={stage} flow={flow} packet={ready?snapshot.packet:''}/>}
        {drift && !drift.files.length && <Changes drift={drift} flow={flow} stage={stage}/>}
        {view==='result' && archived.length>0 && <details className="disclosure"><summary>Задание проверяющего</summary>
          <Transfer stage={stage} flow={flow} attempts={archived} packet="" notes={[]} loading={false}/></details>}
        {stage.role!=='planner' && !flow.manual && <details className="disclosure"><summary>Исходная идея</summary><p>{flow.title}</p></details>}
        <Journal key={'journal-'+stage.id} stage={stage}/>
      </section><Route flow={flow} stage={stage} onPick={s=>onPick(s)}/></div>
      <footer className="end"><span>{flow.started?'Начало '+time(flow.started,true):'Отдельные задачи'}{flow.elapsed!=null?' · '+duration(flow.elapsed):''}</span>
        <span>{flow.manual?stage.id:flow.id} · {flow.stages.filter(s=>s.state==='done').length} / {flow.stages.length}</span></footer>
    </article></>;
}
