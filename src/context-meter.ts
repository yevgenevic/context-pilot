// App-server reports a fresh sample after model responses. The total across
// responses is billing usage and does not describe the current context.
export type ContextUsage = {used:number; window:number; thresholdPercent:number; measuredAt:string};
export type Sample = Pick<ContextUsage,'used'|'window'>;

export function usageSample(usage:any):Sample | undefined {
  const used=usage?.last?.totalTokens, window=usage?.modelContextWindow;
  if (!Number.isSafeInteger(used) || used<=0 || !Number.isSafeInteger(window) || window<=0) return;
  return {used,window};
}

const actions = new Set(['command_execution','file_change','mcp_tool_call','dynamic_tool_call','web_search','collab_agent_tool_call','image_generation','image_view']);

// A measurement may arrive while a command is writing or just before a final
// answer. Notify the coordinator only after an action has actually finished.
export function contextBoundaries(onBoundary?: (sample:Sample)=>void) {
  const open = new Set<string>();
  let last:Sample|undefined, worked=false, final=false, pending:NodeJS.Immediate|undefined;
  const schedule=()=>{
    if (pending || !onBoundary) return;
    pending=setImmediate(()=>{
      pending=undefined;
      if (last && worked && !open.size && !final) onBoundary(last);
    });
  };
  return {
    measure(sample:Sample) {last=sample;schedule();},
    event(e:any) {
      if (e.type==='turn.completed' || e.type==='turn.failed') {final=true;return;}
      const item=e.item;
      if (!item || e.type!=='item.started' && e.type!=='item.completed') return;
      const action=actions.has(item.type);
      const message=item.type==='agent_message';
      if (!action && !message) return;
      const key=item.id ?? item.type+':'+(item.command ?? '');
      if (e.type==='item.started') {open.add(key);return;}
      open.delete(key);
      if (action) worked=true;
      if (message && (item.phase==='final_answer' || item.final===true)) final=true;
      schedule();
    },
    close(){final=true;if(pending)clearImmediate(pending);}
  };
}
