import {time, type ContextTransfer, type Run, type Stage} from '../../model';

const numbers = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const percent = (value:number) => numbers.format(value)+'%';

function reading(run?:Run) {
  const usage=run?.contextUsage;
  if (!usage || !Number.isFinite(usage.window) || usage.window<=0 || !Number.isFinite(usage.used) || usage.used<0) return;
  return {...usage, ratio:usage.used / usage.window * 100};
}

function Meter({used,window,ratio,threshold}:{used:number;window:number;ratio:number;threshold?:number}) {
  const thresholdValid=threshold!==undefined && threshold>0 && threshold<=100;
  return <span className="context-track" data-high={thresholdValid && ratio>=threshold}
    role="meter" aria-label="Заполнение контекстного окна" aria-valuemin={0} aria-valuemax={window}
    aria-valuenow={Math.min(used,window)} aria-valuetext={percent(ratio)+' · '+numbers.format(used)+' из '+numbers.format(window)+' токенов'}>
    <span className="context-fill" style={{width:Math.min(100,ratio)+'%'}}/>
    {thresholdValid && <span className="context-limit" style={{left:threshold+'%'}}/>}
  </span>;
}

export function RouteContext({stage}:{stage:Stage}) {
  const run=stage.runs[0];
  const usage=reading(run);
  return <span className="route-context">
    <span>{usage ? 'Окно '+percent(usage.ratio) : run ? 'Окно · нет данных' : 'Окно —'}</span>
    {usage && <Meter {...usage} threshold={usage.thresholdPercent}/>}
  </span>;
}

function transferNote(transfer:ContextTransfer,stage:Stage) {
  const nextStarted=stage.runs.some(run=>run.attempt===transfer.toAttempt);
  const action=nextStarted ? 'Задачу продолжила сессия '+transfer.toAttempt+'.' : 'Подготовлена передача в сессию '+transfer.toAttempt+'.';
  return 'Сессия '+transfer.fromAttempt+' достигла порога '+percent(transfer.thresholdPercent)+'. '+action;
}

export function AgentContext({stage,attempt}:{stage:Stage;attempt?:number}) {
  // Old journals may lack attempt numbers. Never assign their measurements to a selected packet by position.
  const run=attempt===undefined ? stage.runs[0] : stage.runs.find(item=>item.attempt===attempt);
  const usage=reading(run);
  const n=attempt ?? run?.attempt;
  const transfers=stage.contextTransfers ?? [];
  const related=attempt===undefined ? transfers : transfers.filter(t=>t.fromAttempt===attempt || t.toAttempt===attempt);
  const threshold=usage?.thresholdPercent ?? (run?.state==='running' || stage.state==='waiting' ? stage.contextPolicy?.thresholdPercent : undefined);
  const missing=!n && !stage.runs.length && stage.state==='waiting' ? 'Появится после запуска сессии.' :
    run?.state==='running' ? 'Ждём измерения от Codex.' : 'Для этой сессии измерение недоступно.';

  return <section className="agent-context" aria-label="Контекст агента">
    <div className="context-heading"><h3>Контекст{n ? ' сессии '+n : ' агента'}</h3>
      {usage && <strong className="context-ratio">{percent(usage.ratio)}</strong>}
    </div>
    {usage ? <>
      <Meter {...usage} threshold={threshold}/>
      <p className="token-values"><span>{numbers.format(usage.used)} из {numbers.format(usage.window)} токенов</span>
        <span>Свободно {numbers.format(Math.max(0,usage.window-usage.used))}</span></p>
      <p className="meter-caption">{threshold!=null && 'Порог передачи '+percent(threshold)+' · '}Измерено в {time(usage.measuredAt)}</p>
    </> : <p className="meter-caption">{missing}{threshold!=null && ' Порог передачи '+percent(threshold)+'.'}</p>}
    {related.length>0 && <div className="rotation-note"><b>Автопередача</b>
      {related.map(t=><p key={t.fromAttempt}>{transferNote(t,stage)}</p>)}</div>}
    {run?.state==='rotated' && !related.some(t=>t.fromAttempt===n) && <p className="meter-caption">Сессия остановлена при достижении порога.</p>}
  </section>;
}
