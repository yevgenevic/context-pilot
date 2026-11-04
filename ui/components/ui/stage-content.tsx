import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Check, ChevronDown, ClipboardCopy, Download} from 'lucide-react';
import {saveFile, time, type Entry, type PauseChanges, type Pipeline, type Stage} from '../../model';
import {AgentContext} from './context-meter';

export function stageName(stage: Stage) {
  if (stage.role === 'planner') return 'План';
  if (stage.role === 'verifier') return 'Приёмка';
  return stage.name.replace(/^\d+[.)]\s+/, '');
}

export function ShortText({value, limit=200}: {value:string; limit?:number}) {
  const [expanded, setExpanded] = useState(false);
  const short = value.slice(0,limit).replace(/\s+\S*$/, '').trim() || value.slice(0,limit);
  if (value.length <= limit) return <span>{value}</span>;
  return <span>{expanded ? value : short+'…'}{' '}
    <button className="inline-button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      {expanded ? 'Свернуть' : 'Целиком'}
    </button></span>;
}

function Fact({name,children}: {name:string;children:ReactNode}) {
  return <div className="fact"><dt>{name}</dt><dd>{children}</dd></div>;
}

function section(packet:string, title:string) {
  return packet.split(/^## /m).slice(1).find(piece=>piece.startsWith(title+'\n'))?.slice(title.length).trim() ?? '';
}

export function TaskFacts({flow,stage,packet}: {flow:Pipeline;stage:Stage;packet:string}) {
  const idx = flow.stages.findIndex(s=>s.id===stage.id);
  const previous = flow.stages.slice(0,idx).reverse().find(s=>s.role==='agent' && s.state==='done' && s.summary);
  const checks = stage.ticket?.checks ?? section(packet,'Проверки').split('\n').filter(x=>x.startsWith('- ')).map(x=>x.slice(2));
  const files = stage.ticket?.files ?? section(packet,'Открой в текущей рабочей копии').split('\n').filter(x=>x.startsWith('- ')).map(x=>x.slice(2));
  const lastCommand = stage.logs.filter(e=>/^Код [-\d]+ ·/.test(e.text)).at(-1);
  if (stage.role==='planner') return <section className="facts">
    <h2>{flow.stages.some(s=>s.role==='agent')?'План работ':'Исходная идея'}</h2>
    {flow.stages.some(s=>s.role==='agent') ? <ol className="plan-list">{flow.stages.filter(s=>s.role==='agent').map(s=><li key={s.id}>{stageName(s)}</li>)}</ol> : <p>{flow.title}</p>}
    {!!flow.requiredCommands?.length && <details className="disclosure">
      <summary>Обязательные команды приёмки · {flow.requiredCommands.length}</summary>
      {flow.requiredCommands.map(command=><pre key={command}>{command}</pre>)}
      <p className="muted">Для каждой команды нужен подтверждённый код 0.</p>
    </details>}
  </section>;
  return <section className="facts">
    <h2>{stage.state==='interrupted'?'С чем продолжит новый агент':stage.state==='done'?'Результат этапа':'Что входит в задачу'}</h2>
    <dl>
      {stage.summary && <Fact name={stage.state==='done'?'Что готово':'Итог агента'}><ShortText value={stage.summary}/></Fact>}
      {previous && <Fact name="От прошлого агента"><ShortText value={previous.summary}/></Fact>}
      {stage.state==='interrupted' && <Fact name="Где остановились">
        {lastCommand ? <code>{lastCommand.text}</code> : 'Сессия остановлена до записи результата.'}
      </Fact>}
      {stage.ticket?.text && <Fact name={stage.state==='done'?'Что требовалось':'Задание'}><ShortText value={stage.ticket.text} limit={180}/></Fact>}
      {!!files.length && <Fact name="Файлы задачи"><span className="tags">{files.map(f=><code key={f}>{f}</code>)}</span></Fact>}
      {!!checks.length && <Fact name={stage.state==='interrupted'?'Что проверить':'Критерии'}><ShortText value={checks[0]} limit={150}/>
        {checks.length>1 && <details className="more-checks"><summary>Ещё {checks.length-1}</summary><ul>{checks.slice(1).map((c,i)=><li key={i}>{c}</li>)}</ul></details>}
      </Fact>}
      {!stage.ticket && !stage.summary && !files.length && !checks.length && <Fact name="Задание">{stage.name}</Fact>}
    </dl>
  </section>;
}

const changeLabels = {added:'Добавлен',modified:'Изменён',deleted:'Удалён'};
export function Changes({drift, flow, stage}: {drift:PauseChanges;flow:Pipeline;stage:Stage}) {
  const origin=flow.stages.find(s=>s.id===drift.stage);
  const scope=origin && origin.id!==stage.id ? 'Этап «'+stageName(origin)+'». ' : '';
  const caption=drift.status==='live'?'Сравнение со снимком на момент паузы.':drift.status==='archived'?'Эти изменения были зафиксированы при продолжении.':'Для этой остановки нет доступного снимка рабочей копии.';
  return <section className="facts drift"><h2>Что изменилось после остановки</h2>
    <p className="muted">{scope}{caption}</p>
    {drift.files.length>0 ? <ul className="file-delta">{drift.files.map(f=><li key={f.path}>
      <span className={'change-label '+f.change}>{changeLabels[f.change]}</span><div><code>{f.path}</code>{f.preview && <details className="diff-preview"><summary>Посмотреть правку</summary><pre>{f.preview}</pre></details>}</div>
    </li>)}</ul> : drift.status!=='unavailable' && <p>{drift.limited?'Среди доступных файлов изменений не обнаружено.':'Файлы не изменились.'}</p>}
    {drift.base!==drift.head && <p>Коммит <code>{drift.base?.slice(0,9) || 'без коммита'}</code> → <code>{drift.head?.slice(0,9) || 'без коммита'}</code></p>}
    {drift.limited && drift.status!=='unavailable' && <p className="muted">Сравнение охватывает часть рабочей копии.</p>}
  </section>;
}

function Packet({text,name}: {text:string;name:string}) {
  const [copied,setCopied]=useState(''), ref=useRef<HTMLPreElement>(null);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(''),1800);return()=>clearTimeout(timer);},[copied]);
  async function copy() {
    try {await navigator.clipboard.writeText(text);setCopied('Скопировано');}
    catch {if(ref.current){const range=document.createRange();range.selectNodeContents(ref.current);getSelection()?.removeAllRanges();getSelection()?.addRange(range);setCopied('Текст выделен');}}
  }
  return <><div className="packet-tools"><button className="subtle" onClick={copy}>{copied?<Check size={14}/>:<ClipboardCopy size={14}/>}<span role="status">{copied || 'Копировать'}</span></button>
    <button className="subtle" onClick={()=>saveFile(text,name+'.md','text/markdown;charset=utf-8')}><Download size={14}/>Скачать задание</button></div>
    <pre ref={ref} tabIndex={0}>{text}</pre></>;
}

export function Transfer({stage,flow,attempts,packet,notes,loading}: {stage:Stage;flow:Pipeline;attempts:string[];packet:string;notes:Entry[];loading:boolean}) {
  const [picked,setPicked] = useState<number>();
  const index = picked==null ? attempts.length-1 : Math.min(picked,attempts.length-1);
  const archived = attempts[index] || '';
  const previous = section(archived,'Результаты предыдущих задач');
  const files = section(archived,'Открой в текущей рабочей копии').split('\n').filter(s=>s.startsWith('- ')).map(s=>s.slice(2));
  return <section className="facts">
    <h2>{attempts.length?'Что получил агент':'Задание для передачи'}</h2>
    {loading ? <p className="muted">Загружаем задание…</p> : <>
      {attempts.length>0 && <><label className="attempt-picker">Отправленная попытка
        <select aria-label="Сессия агента" value={index} onChange={e=>setPicked(Number(e.target.value))}>
          {attempts.map((_,i)=><option key={i} value={i}>{i+1}{i===0?' · первый запуск':stage.contextTransfers?.some(t=>t.toAttempt===i+1)?' · автопередача':''}</option>)}</select></label>
        <AgentContext stage={stage} attempt={index+1}/>
        <dl>{previous && previous!=='—' && <Fact name="Переданный итог"><ShortText value={previous.replace(/^- /,'')}/></Fact>}
          {!!files.length && <Fact name="Пути в задании"><span className="tags">{files.map(f=><code key={f}>{f}</code>)}</span></Fact>}
        </dl>
        <details className="disclosure"><summary>Открыть точное задание · попытка {index+1}</summary>
          <Packet text={archived} name={stage.id+'-attempt-'+(index+1)}/></details></>}
      {!attempts.length && <><p className="muted">{stage.state==='waiting'?'Исполнитель ещё не получил это задание.':'Отправленная попытка для этого этапа не сохранена.'}</p><AgentContext stage={stage}/></>}
      {packet && <details className="disclosure"><summary>Контекст по текущему состоянию проекта</summary><Packet text={packet} name={'context-'+stage.id}/></details>}
      {notes.length>0 && <details className="disclosure"><summary>Заметки · {notes.length}</summary>{notes.map((n,i)=><p key={i}>{n.text}</p>)}</details>}
      {stage.role==='planner' && <details className="disclosure"><summary>Исходная идея</summary><p>{flow.title}</p></details>}
    </>}
  </section>;
}

export function ReportContent({flow}: {flow:Pipeline}) {
  const reports=flow.reports ?? [], current=reports.at(-1);
  if (!current) return <section className="facts"><h2>Независимая проверка</h2><p>Здесь появятся критерии, фактический вывод и команды проверяющего.</p></section>;
  return <section className="facts"><h2>Что проверили</h2>
    <p><ShortText value={current.summary} limit={180}/></p>
    {reports.slice().reverse().map((r,i)=><details key={reports.length-i} className="disclosure"><summary>
      Приёмка {reports.length-i} · {r.status==='passed'?'Проверено':r.status==='failed'?'Нужны исправления':'Проверка заблокирована'} · {r.checks.filter(c=>c.passed).length} из {r.checks.length}
    </summary>
      {i>0 && <p>{r.summary}</p>}
      <dl>{r.checks.map((c,j)=><div className="check" key={j}><dt>{c.passed?'✓':'×'} {c.requirement}</dt><dd><b>Ожидалось</b> {c.expected}</dd><dd><b>Получено</b> {c.actual}</dd></div>)}</dl>
      {!!r.commands.length && <details><summary>Команды и фактический вывод · {r.commands.length}</summary>
        {r.commands.map((c,j)=><pre key={j}>{c.command}{'\n'}Код {c.exitCode ?? 'неизвестен'}{'\n'}{c.output}</pre>)}</details>}
    </details>)}
  </section>;
}

function isError(entry:Entry) {
  return entry.level==='error' || entry.state==='failed' || /^Код (?!0\s)-?\d+ ·/.test(entry.text);
}
function message(entry:Entry) {
  if (entry.text.startsWith('{')) try {
    const json=JSON.parse(entry.text);
    if (typeof json.summary==='string') return json.summary;
    if (json.questions?.length) return 'Планировщик запросил уточнения.';
    if (Array.isArray(json.tasks)) return 'План составлен · задач '+json.tasks.length;
  } catch {}
  return entry.text;
}
export function Journal({stage}: {stage:Stage}) {
  const [errors,setErrors]=useState(false);
  const logs=errors?stage.logs.filter(isError):stage.logs;
  return <details className="disclosure journal"><summary>Журнал этапа · {stage.logs.length}</summary>
    <div className="packet-tools"><label>Показать <select aria-label="Фильтр журнала" value={errors?'errors':'all'} onChange={e=>setErrors(e.target.value==='errors')}>
      <option value="all">Все события</option><option value="errors">Ошибки</option></select></label>
      <button className="subtle" disabled={!stage.logs.length} onClick={()=>saveFile(stage.logs.map(e=>'['+e.time+'] '+e.text).join('\n')+'\n',stage.id+'.log','text/plain;charset=utf-8')}><Download size={14}/>Скачать журнал</button></div>
    <div className="logpaper">{logs.map((entry,i)=><div className="logline" key={entry.time+i}><time dateTime={entry.time}>{time(entry.time)}</time><span><ShortText value={message(entry)} limit={180}/></span></div>)}
      {!logs.length && <p>{errors?'Ошибок в журнале нет.':'Событий пока нет.'}</p>}</div>
  </details>;
}
