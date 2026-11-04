import {useEffect,useRef,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowUpRight,Plus,Route,X} from 'lucide-react';
import {BuildPipeline,Masthead} from './components/ui/build-pipeline';
import {defaultStage,pipelines,type Snapshot,type View} from './model';
import './dashboard.css';

type CliStatus = NonNullable<Snapshot['codex']>;
function ClaudeHandoff({claude}: {claude?: CliStatus}) {
  if (!claude || claude.state === 'missing') return null;
  return <p>{claude.label}. {claude.instruction}{claude.commands.map(command => <code key={command}> {command}</code>)}</p>;
}
function SetupNotice({codex, claude}: {codex: CliStatus; claude?: CliStatus}) {
  return <aside className="setup-notice" aria-label="Настройка агентов">
    <strong>{codex.label}</strong><p>Автоматический запуск работает через Codex. {codex.instruction}</p>
    <pre>{codex.commands.join('\n')}</pre>
    <ClaudeHandoff claude={claude}/>
  </aside>;
}
function ReadyProviders({codex, claude}: {codex: CliStatus; claude?: CliStatus}) {
  return <><p className="codex-ready">{codex.label} для автоматического запуска.</p><ClaudeHandoff claude={claude}/></>;
}
type Pin={flow?:string;task?:string;view?:View};
function initialPin():Pin {const p=new URLSearchParams(location.search);const view=p.get('view');return {flow:p.get('plan')||undefined,task:p.get('task')||undefined,view:view==='transfer'||view==='result'?view:undefined};}
function Composer({dialog,busy,online,codex,claude,onStart}:{codex?:CliStatus;claude?:CliStatus;dialog:React.RefObject<HTMLDialogElement|null>;busy:boolean;online:boolean;onStart:(id:string)=>void}){
  const [idea,setIdea]=useState(''),[posting,setPosting]=useState(false),[error,setError]=useState('');const sending=useRef(false);
  async function submit(e:FormEvent){
    e.preventDefault();if(!idea.trim()||busy||!online||codex?.state!=='ready'||sending.current)return;sending.current=true;setPosting(true);setError('');
    try{const res=await fetch('/api/ideas',{method:'POST',headers:{'Content-Type':'application/json','X-Pilot-Action':'start'},body:JSON.stringify({idea:idea.trim()})});
      const data=await res.json();if(!res.ok)throw Error(data.error || 'Не удалось запустить планировщик.');
      setIdea('');onStart(data.id);dialog.current?.close();
    }catch(e){setError(e instanceof Error?e.message:'Не удалось подключиться.');}finally{sending.current=false;setPosting(false);}
  }
  return <dialog ref={dialog} aria-labelledby="form-title" onCancel={e=>{if(posting)e.preventDefault();}} onClose={()=>setError('')}><form onSubmit={submit}>
    <div className="dialog-top"><span className="emblem"><Route size={19}/></span><button type="button" aria-label="Закрыть" className="icon-btn" disabled={posting} onClick={()=>dialog.current?.close()}><X size={17}/></button></div>
    <h2 id="form-title">Новая идея</h2><p>Опиши результат. Если для плана понадобится твоё решение, здесь появятся вопросы. Затем агенты начнут работу.</p>
    {codex && (codex.state==='ready' ? <ReadyProviders codex={codex} claude={claude}/> : <SetupNotice codex={codex} claude={claude}/>)}
    <label className="field" htmlFor="idea">Что хочешь сделать?</label><textarea autoFocus required maxLength={12000} id="idea" value={idea} onChange={e=>setIdea(e.target.value)} placeholder="Опиши желаемый результат" rows={5}/>
    <small>Агенты смогут изменять файлы этого проекта.</small><div className="form-foot"><span role="status">{error || (busy?'Сначала дождись текущего запуска.':!online?'Нет связи с проектом.':'')}</span><button type="submit" className="primary" disabled={!idea.trim()||busy||!online||codex?.state!=='ready'||posting}>{posting?'Запускаем…':'Составить план и запустить'}<ArrowUpRight size={15}/></button></div>
    </form></dialog>;
}
function Empty({create,online,codex,claude}:{create:()=>void;online:boolean;codex?:CliStatus;claude?:CliStatus}){
  return <section className="card empty"><div className="empty-illustration" aria-hidden="true"><svg viewBox="0 0 230 76"><path d="M44 38H190" stroke="#b1bfb5" strokeDasharray="3 4"/>{[45,115,185].map((x,i)=><g key={x} transform={'translate('+x+' 30)'} stroke={i===0?'#508969':'#a6b9ad'} strokeLinejoin="round"><path d="M-20 0 0-10 20 0 0 10Z" fill={i===0?'#bde3c5':'#e6eee8'}/><path d="m-20 0 20 10v15l-20-10z" fill={i===0?'#96c6a3':'#d1dfd4'}/><path d="M20 0 0 10v15l20-10Z" fill={i===0?'#69a37c':'#b6c9bb'}/></g>)}</svg></div><h2>В проекте пока нет задач</h2><p>Опиши, что нужно сделать. Когда запуск начнётся, здесь появятся этапы и результаты проверки.</p>{codex?.state==='ready' && <ReadyProviders codex={codex} claude={claude}/>}<button className="secondary" disabled={!online||codex?.state!=='ready'} onClick={create}><Plus size={15}/>Добавить первую идею</button></section>;
}
function App(){
  const [pin,setPin]=useState<Pin>(initialPin),[state,setState]=useState<Snapshot|null>(null),[connection,setConnection]=useState<'loading'|'ok'|'error'>('loading'),[epoch,setEpoch]=useState(0),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null), flows=state?pipelines(state,Date.now()):[];
  const flow=flows.find(f=>f.stages.some(s=>s.id===pin.task)) ?? flows.find(f=>f.id===pin.flow) ?? flows[0];
  const stage=flow&&state ? flow.stages.find(s=>s.id===pin.task) ?? defaultStage(flow,state) : undefined;
  const query=stage?.id ?? pin.task;
  function choose(next:Pin){setPin(next);const url=new URL(location.href);url.search='';if(next.task)url.searchParams.set('task',next.task);if(next.flow)url.searchParams.set('plan',next.flow);if(next.view && next.view!=='task')url.searchParams.set('view',next.view);window.history.replaceState(null,'',url);}
  useEffect(()=>{let alive=true,timer:ReturnType<typeof setTimeout>;const ctrl=new AbortController();
    async function poll(){try{const res=await fetch('/api/state'+(query?'?task='+encodeURIComponent(query):''),{cache:'no-store',signal:ctrl.signal}),data=await res.json();
      if(!alive)return;if(!res.ok){if(query&&data.error==='Задача не найдена.'){choose({});setState(null);return;}throw Error(data.error||'Ошибка чтения проекта.');}
      setState(data);setConnection('ok');setError('');
    }catch(e){if(alive){setConnection('error');setError(e instanceof Error?e.message:'');}}finally{if(alive)timer=setTimeout(poll,2000);}}
    poll();return()=>{alive=false;clearTimeout(timer);ctrl.abort();};},[query,epoch]);
  const busy=!!state && (state.plans.some(p=>p.state==='planning'||p.state==='building'||p.state==='verifying') ||
    !!flows.find(f=>f.manual)?.stages.some(s=>s.runs.some(r=>r.state==='running'))),online=connection==='ok';
  const open=()=>dialog.current?.showModal();
  return <><main className="shell">
    {connection==='error' && <p className="alert" role="alert" title={error}>Нет связи с проектом. Проверь команду <code>pilot dashboard</code>.</p>}
    {state?.codex && state.codex.state!=='ready' && <SetupNotice codex={state.codex} claude={state.claude}/>}
    {flow && stage && state ? <BuildPipeline key={flow.id} flow={flow} flows={flows} stage={stage} snapshot={state}
      busy={busy} online={online} onCreate={open} view={pin.view==='transfer'?'transfer':stage.role==='verifier'?'result':'task'}
      onChange={id=>choose({flow:id})} onRefresh={()=>setEpoch(v=>v+1)}
      onPick={(s,view)=>choose({flow:flow.id,task:s.id,view:view ?? (s.role==='verifier'?'result':'task')})}/>
      : <><Masthead/>{state ? <Empty create={open} online={online} codex={state.codex} claude={state.claude}/> :
        <div className="card empty">{connection==='error'?'Не удалось открыть проект.':'Открываем проект…'}</div>}</>}
  </main>
    <Composer dialog={dialog} busy={busy} online={online} codex={state?.codex} claude={state?.claude} onStart={id=>{choose({flow:id});setEpoch(v=>v+1);}}/></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
