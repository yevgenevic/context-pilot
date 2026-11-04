import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setImmediate as tick} from 'node:timers/promises';
import {contextBoundaries, usageSample} from '../src/context-meter.ts';
import {appProtocol} from '../src/codex-app.ts';

test('uses the most recent measurement, waits for all tools, gives a final answer priority',async()=>{
  const response={modelContextWindow:1000,total:{totalTokens:4300},last:{totalTokens:880}};
  const sample=usageSample(response);
  assert.deepEqual(sample,{used:880,window:1000});
  assert.equal(usageSample({...response,modelContextWindow:null}),undefined);
  assert.equal(usageSample({modelContextWindow:1000,total:response.total}),undefined);
  let calls=0;const boundary=contextBoundaries(value=>{calls++;assert.deepEqual(value,sample);});
  const command=(type,id)=>boundary.event({type,item:{type:'command_execution',id}});
  boundary.measure(sample);await tick();assert.equal(calls,0);
  command('item.started','read');command('item.started','write');
  command('item.completed','read');await tick();assert.equal(calls,0);
  command('item.completed','write');await tick();assert.equal(calls,1);
  boundary.measure(sample);
  boundary.event({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'done'}});
  await tick();assert.equal(calls,1);boundary.close();
});

test('stdio protocol uses an isolated read-only thread, routes only its events and checks the turn result',()=>{
  const stdin=new PassThrough(),stdout=new PassThrough(),requests=[],events=[];
  stdin.on('data',chunk=>requests.push(JSON.parse(String(chunk))));
  const protocol=appProtocol({stdin,stdout},{root:'/repo',packet:'the packet',writable:false,schema:{type:'string'},onEvent:e=>events.push(e)});
  const send=m=>stdout.write(JSON.stringify(m)+'\n');
  assert.equal(requests[0].method,'initialize');
  send({id:1,result:{}});
  assert.equal(requests[2].params.ephemeral,true);assert.equal(requests[2].params.sandbox,'read-only');
  send({id:2,result:{thread:{id:'our'}}});
  assert.equal(requests[3].params.input[0].text,'the packet');assert.deepEqual(requests[3].params.outputSchema,{type:'string'});
  send({id:3,result:{turn:{id:'turn'}}});
  const usage=(threadId,turnId)=>send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{last:{totalTokens:44},modelContextWindow:100}}});
  usage('other','turn');usage('our','other');usage('our','turn');
  send({method:'item/completed',params:{threadId:'our',turnId:'turn',item:{type:'commandExecution',id:'tool',command:'test',exitCode:0,aggregatedOutput:'OK'}}});
  send({method:'turn/completed',params:{threadId:'our',turn:{id:'turn',status:'completed'}}});
  assert.deepEqual(events.map(e=>e.type),['thread.started','thread.token_usage.updated','item.completed','turn.completed']);
  assert.equal(events[0].thread_id,'our');assert.equal(events[2].item.aggregated_output,'OK');assert.equal(protocol.result().success,true);protocol.close();
});

test('a stalled handshake can fall back only before the actual prompt was dispatched',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const dispatch of [false,true]){
    const stdin=new PassThrough(),stdout=new PassThrough(),killed=[];
    const protocol=appProtocol({stdin,stdout,pid:1,kill:s=>killed.push(s)},{root:'/repo',packet:'task',writable:true,onEvent:()=>{}});
    stdout.write(JSON.stringify({id:1,result:{}})+'\n');
    if(dispatch)stdout.write(JSON.stringify({id:2,result:{thread:{id:'isolated'}}})+'\n');
    t.mock.timers.tick(12001);
    assert.deepEqual(killed,['SIGKILL']);
    assert.equal(protocol.result().handshakeTimedOut,!dispatch);
    assert.equal(protocol.result().dispatched,dispatch);
    protocol.close();
  }
});
