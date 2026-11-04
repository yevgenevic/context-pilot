const copyLabels:Record<string,string>={checking:'Проверяется',passed:'Пройдена',failed:'Ошибка',blocked:'Заблокирована',interrupted:'Прервана'};
import type {Pipeline, Stage} from '../../model';
export function WorkflowDetails({flow,stage,onPick}:{flow:Pipeline;stage:Stage;onPick:(stage:Stage)=>void}) {
  const workflow=flow.workflow;
  if(!workflow)return null;
  return <section className="facts">
    <h2>{stage.name}</h2><p>{stage.summary || 'Этот этап ещё не завершён.'}</p>
    {stage.phase==='requirements' && <ol>{workflow.requirements?.map(r=><li key={r.id}><b>{r.id}</b> {r.text}</li>)}</ol>}
    {stage.phase==='spec' && <><p>{workflow.specification?.summary}</p><p>{workflow.specificationReview?.passed?'G2 · Независимый читатель подтвердил полноту.':workflow.specificationReview?.issues.join(' · ')}</p></>}
    {stage.phase==='plan' && <dl>{workflow.coverage?.map(row=><div key={row.requirement}><dt>{row.requirement}</dt><dd>{row.tasks.join(', ')}</dd></div>)}</dl>}
    {stage.phase==='build' && <div className="workflow-tasks">{flow.stages.filter(s=>s.ticket).map(s=><button className="subtle" key={s.id} onClick={()=>onPick(s)}>{s.name} →</button>)}</div>}
    {stage.phase==='accept' && <><p>Агент получил исходную идею с ответами, снимок файлов до разработки и отдельную итоговую копию. Это позволяет проверить и новые функции, и сохранение прежнего поведения. Память Pilot, история Git и инструкции авторов исключены. После проверки временная копия удаляется.</p>
      {workflow.blindCopies.map((copy,index)=><details className="disclosure" key={copy.id} open={index===workflow.blindCopies.length-1}><summary>Копия {index+1} · {copyLabels[copy.state] ?? copy.state} · {copy.files} файлов</summary><dl><div><dt>SHA-256 дерева</dt><dd><code style={{overflowWrap:'anywhere'}}>{copy.digest}</code></dd></div><div><dt>Создана</dt><dd>{copy.created}</dd></div><div><dt>Исключено</dt><dd>{copy.excluded.join(', ') || 'Служебные каталоги не входили в список файлов.'}</dd></div></dl></details>)}</>}
  </section>;
}
