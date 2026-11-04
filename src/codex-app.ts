import type {ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';

type Options = {root:string; packet:string; writable:boolean; schema?:unknown; contextWindow?:number; onEvent:(event:any)=>void};
const itemTypes:Record<string,string>={
  agentMessage:'agent_message',commandExecution:'command_execution',fileChange:'file_change',mcpToolCall:'mcp_tool_call',
  dynamicToolCall:'dynamic_tool_call',webSearch:'web_search',collabAgentToolCall:'collab_agent_tool_call',
  imageView:'image_view',imageGeneration:'image_generation'
};

// A dedicated stdio connection for one ephemeral thread. No global session
// files or events from other Codex clients are used.
export function appProtocol(child:ChildProcess, options:Options) {
  let thread='', turn='', dispatched=false, initialized=false, completed=false, success=false, failure='', handshakeTimedOut=false;
  const send=(message:unknown)=>{if(child.stdin?.writable && !child.stdin.destroyed)child.stdin.write(JSON.stringify(message)+'\n');};
  const finish=(ok:boolean, message='')=>{
    if(completed)return;
    completed=true;success=ok;failure=message;
    if(message)options.onEvent({type:'error',message});
    child.stdin?.end();
  };
  // Covers initialize AND thread/start. Never retry a prompt after turn/start
  // was sent, even when its acknowledgement never arrives.
  const timer=setTimeout(()=>{
    handshakeTimedOut=!dispatched;
    finish(false,'Codex не подтвердил подключение к app-server.');
    if(child.pid)child.kill('SIGKILL');
  },12000);
  timer.unref();
  const lines=createInterface({input:child.stdout!});
  lines.on('line',line=>{
    let m:any;
    try { m=JSON.parse(line); } catch { return; }
    if(completed)return;
    if(m.id!=null && m.method) {
      // Noninteractive sessions must never silently approve additional access.
      send({id:m.id,error:{code:-32601,message:'Interactive requests are unavailable in Context Pilot'}});
      return;
    }
    if(m.id!=null) {
      if(m.error){finish(false,m.error.message ?? 'Ошибка протокола Codex');return;}
      if(m.id===1) {
        initialized=true;
        send({method:'initialized'});
        send({id:2,method:'thread/start',params:{cwd:options.root,ephemeral:true,approvalPolicy:'never',
          sandbox:options.writable?'workspace-write':'read-only',
          ...(options.contextWindow?{config:{model_context_window:options.contextWindow}}:{})}});
      } else if(m.id===2) {
        thread=m.result?.thread?.id;
        if(!thread){finish(false,'Codex не вернул ID сессии.');return;}
        options.onEvent({type:'thread.started',thread_id:thread});
        dispatched=true;timer.refresh();
        send({id:3,method:'turn/start',params:{threadId:thread,input:[{type:'text',text:options.packet,text_elements:[]}],
          ...(options.schema ? {outputSchema:options.schema} : {})}});
      } else if(m.id===3) {
        clearTimeout(timer);
        turn=m.result?.turn?.id;
      }
      return;
    }
    const p=m.params;
    if(!thread || p?.threadId!==thread || (turn && p.turnId && p.turnId!==turn))return;
    switch(m.method) {
      case 'turn/started': clearTimeout(timer);turn=p.turn.id;options.onEvent({type:'turn.started'});break;
      case 'thread/tokenUsage/updated': options.onEvent({type:'thread.token_usage.updated',tokenUsage:p.tokenUsage});break;
      case 'item/started':
      case 'item/completed': {
        const i=p.item,type=itemTypes[i?.type];
        if(type)options.onEvent({type:m.method==='item/started'?'item.started':'item.completed',
          item:{type,id:i.id,phase:i.phase,text:i.text,command:i.command,exit_code:i.exitCode,aggregated_output:i.aggregatedOutput,cwd:i.cwd,
            changes:i.changes,tool:i.tool}});
        break;
      }
      case 'turn/completed': {
        if(turn && p.turn?.id!==turn)break;
        const ok=p.turn?.status==='completed';
        options.onEvent({type:ok?'turn.completed':'turn.failed',error:p.turn?.error});
        finish(ok,ok?'':p.turn?.error?.message ?? 'Сессия Codex остановлена.');
        break;
      }
    }
  });
  send({id:1,method:'initialize',params:{clientInfo:{name:'context_pilot',title:'Context Pilot',version:'0.1.3'},
    capabilities:{experimentalApi:false}}});
  return {result:()=>({success,completed,dispatched,initialized,failure,handshakeTimedOut}),close(){clearTimeout(timer);lines.close();}};
}
