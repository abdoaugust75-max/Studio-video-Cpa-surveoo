'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {createTelegramAgent,redact}=require('../lib/telegram-agent');
const {createStudioMonitor}=require('../lib/studio-monitor');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-telegram-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const token='1234567:'+'a'.repeat(32),config={token,chatId:'123',verifiedAt:Date.now(),agentEnabled:true,enabled:true};fs.writeFileSync(path.join(dir,'telegram-private.json'),JSON.stringify(config));
  let updates=[],answers=0;const sent=[],actions=[];
  const telegram={api:async(method,body)=>{if(method==='sendChatAction'){actions.push(body);return true;}assert.equal(method,'getUpdates');return updates.filter(u=>u.update_id>=(body.offset || 0));},send:async text=>{sent.push(text);return{message_id:sent.length};}};
  const agent=createTelegramAgent({dir,enabled:true,telegram,snapshot:()=>({pages:7,secret:undefined}),answer:async({text,snapshot})=>{answers++;assert.equal(snapshot.pages,7);return 'AI: '+text;},report:async()=> 'LIVE REPORT: 7 pages'});t.after(()=>agent.close());
  const update=(id,text,chat='123',type='private')=>({update_id:id,message:{date:Math.floor(Date.now()/1000),text,chat:{id:chat,type},from:{id:chat,is_bot:false}}});
  return{dir,agent,sent,actions,update,config,setUpdates:x=>updates=x,answers:()=>answers};
}
test('the owner can chat with the AI and request a live report',async t=>{
  const f=fixture(t);f.setUpdates([f.update(1,'شنو واقع فالستوديو؟'),f.update(2,'/report')]);await f.agent.poll();
  assert.equal(f.answers(),1);assert.equal(f.sent.length,2);assert.ok(f.sent[0].startsWith('AI:'));assert.equal(f.sent[1],'LIVE REPORT: 7 pages');assert.equal(f.agent.status().status,'listening');
  await f.agent.poll();assert.equal(f.sent.length,2);
  assert.equal(f.actions.length,2);assert.deepEqual(f.actions[0],{chat_id:'123',action:'typing'});
});
test('messages from other users and group chats never expose studio state',async t=>{
  const f=fixture(t);f.setUpdates([f.update(1,'/report','999'),f.update(2,'/report','123','group')]);await f.agent.poll();assert.equal(f.sent.length,0);assert.equal(f.answers(),0);
});
test('start/help are deterministic and credentials are removed before AI generation',async t=>{
  const f=fixture(t);f.setUpdates([f.update(1,'/start'),f.update(2,'/help'),f.update(3,'token '+f.config.token)]);await f.agent.poll();assert.equal(f.sent.length,3);assert.equal(f.answers(),1);assert.equal(f.sent.some(x=>x.includes(f.config.token)),false);
});
test('uncertain replies are persisted and never sent twice',async t=>{
  const f=fixture(t);f.setUpdates([f.update(1,'hello')]);await f.agent.poll();const file=path.join(f.dir,'telegram-inbox','1.json'),r=JSON.parse(fs.readFileSync(file));r.status='sending';fs.writeFileSync(file,JSON.stringify(r));await f.agent.poll();assert.equal(f.sent.length,1);assert.equal(JSON.parse(fs.readFileSync(file)).status,'unknown');
});
test('paused AI does not consume messages or call the model',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'telegram-private.json'),JSON.stringify({...f.config,agentEnabled:false}));f.setUpdates([f.update(1,'hello')]);await f.agent.poll();assert.equal(f.sent.length,0);assert.equal(f.answers(),0);assert.equal(f.agent.status().status,'paused');
});
test('owner preferences and tool receipts survive a new agent instance',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-memory-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let seen;const make=()=>createTelegramAgent({dir,enabled:false,telegram:{},snapshot:()=>({}),report:async()=>'',answer:async({context})=>{seen=context.memory;context.onToolResult({tool:'studio.inspect',page:'all'},{status:'read'});return 'جواب';}});
  const first=make();await first.preview('فحص الستوديو',{authorized:true});first.close();const second=make();t.after(()=>second.close());await second.preview('شنو درنا؟',{authorized:false});
  assert.equal(seen.preferences.script,'Arabic');assert.equal(seen.recentTasks.length,1);assert.equal(seen.recentTasks[0].tool,'studio.inspect');assert.ok(fs.existsSync(path.join(dir,'telegram-archive.jsonl')));
});
test('model context remains valid JSON beyond 5000 characters and contains no credentials',()=>{
  const secret='1234567:'+'a'.repeat(32);
  const monitor=createStudioMonitor({store:{ORCHESTRATOR:'all',listProjects:()=>[],artifact:()=>null},jobs:{enabled:true,list:()=>[]},campaigns:{list:()=>[],catalog:()=>[{key:'page',label:'Page',idea:'x'.repeat(7000)+secret,writerInstructions:'direction',destinations:[]}]},automation:{status:()=>({enabled:true,schedules:{page:{}},state:{slots:{}},next:[]})},understanding:{list:()=>[]},appearance:{get:()=>({pages:{page:{}}})},llm:{}});
  const data=monitor.snapshot();assert.equal(data.profiles.length,1);assert.equal(JSON.stringify(data).includes(secret),false);assert.ok(data.profiles[0].idea.length>5000);assert.equal(redact(secret),'[private credential removed]');
});
test('the monitor accepts only the final structured answer, never raw model drafting',async()=>{
  let options;
  const monitor=createStudioMonitor({store:{ORCHESTRATOR:'all'},llm:{text:async(model,prompt,task,opts)=>{options=opts;return JSON.stringify({answer:'كاينين 7 بروفايلات و8 صفحات Facebook.'});}}});
  assert.equal(await monitor.reply({text:'status',history:[],snapshot:{totals:{writerProfiles:7,facebookPages:8}}}),'كاينين 7 بروفايلات و8 صفحات Facebook.');assert.equal(options.jsonAnswer,true);
  const invalid=createStudioMonitor({store:{ORCHESTRATOR:'all'},llm:{text:async()=> 'Unstructured drafting that must not be delivered'}});
  await assert.rejects(invalid.reply({text:'status',history:[],snapshot:{}}),/format was invalid/);
});
// DOM unit harness: exercises the real Save click binding without controlling a browser.
test('tool results remain conversational when the explanation model fails or echoes JSON',async()=>{
  for(const mode of ['failure','json-echo']){
    let calls=0,executions=0;
    const monitor=createStudioMonitor({store:{ORCHESTRATOR:'all'},tools:{spec:[{name:'meta.check'}],execute:async()=>{executions++;return{connections:[{ok:true,pageName:'Good'},{ok:false,pageName:'Maghrebly',destinationId:'42'}]};}},llm:{text:async()=>{if(++calls===1)return JSON.stringify({answer:'Checking',tool:'meta.check',page:'all'});if(mode==='failure')throw Error('Model unavailable');return JSON.stringify({answer:'Tool result: {"connections":[]}'});}}});
    const answer=await monitor.reply({text:'wach meta khdam daba',history:[],snapshot:{}});
    assert.equal(executions,1);assert.match(answer,/1 من 2/);assert.match(answer,/Maghrebly/);assert.doesNotMatch(answer,/connections|checkedAt|\{|نتيجة الأداة/);
  }
});
test('top-video analysis requests return actual links and queue the workflow',async()=>{
  let plan;
  const monitor=createStudioMonitor({store:{ORCHESTRATOR:'all'},tools:{spec:[{name:'videos.review'}],execute:async p=>{plan=p;return{videos:[{id:'12345',label:'Test Page',views:123456,analysis:{status:'queued'}}]};}},llm:{text:async()=>JSON.stringify({answer:'I scanned everything',tool:'none',page:'all'})}});
  const answer=await monitor.reply({text:'chof videos jabo views o9ol 3lash scripts khdamin',history:[],snapshot:{},context:{authorized:true,requestId:'test'}});
  assert.equal(plan.tool,'videos.review');assert.match(answer,/123,456/);assert.match(answer,/https:\/\/www.facebook.com\/reel\/12345/);assert.match(answer,/queued/);assert.doesNotMatch(answer,/I scanned everything/);
});
function ui(t,fail=false){
  const elements=new Map();
  class El{
    constructor(){this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.textContent='';this.classList={add(){},remove(){}};this.parentElement={append(){}};}
    set innerHTML(value){for(const m of value.matchAll(/id="([^"]+)"/g))elements.set(m[1],new El());}
    append(){}after(){}replaceChildren(){}setAttribute(){}addEventListener(){}scrollIntoView(){}add(){}
  }
  for(const name of ['writer','facebook','video'])for(const part of ['tab','panel'])elements.set(name+'-settings-'+part,new El());elements.set('settings-check',new El());
  const requests=[],document={getElementById:id=>elements.get(id),createElement:()=>new El(),createTextNode:x=>x};
  const fetch=async(url,opts)=>{requests.push({url,body:opts?.body?JSON.parse(opts.body):null});return{ok:!fail,json:async()=>fail?{error:'Chat ID must be numeric'}:url.endsWith('verify')?{configured:true,bot:{username:'studio_test_bot'}}:{configured:true,enabled:true,chatId:'123'}};};
  const context={document,window:{addEventListener(){},dispatchEvent(){}},fetch,AbortSignal,Event,Option:El,setInterval(){},console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/atlas/automation.js'),'utf8'),context);
  elements.get('telegram-token').value='1234567:'+'a'.repeat(32);elements.get('telegram-chat').value='123';elements.get('telegram-enabled').checked=true;elements.get('telegram-agent-enabled').checked=true;
  return{elements,requests};
}
test('Save Telegram click sends the form, shows success and exposes the verified bot link',async t=>{
  const f=ui(t);await f.elements.get('telegram-save').onclick({preventDefault(){}});assert.equal(f.requests[0].url,'/api/v2/telegram/settings');assert.equal(f.requests[0].body.chatId,'123');assert.equal(f.requests[0].body.agentEnabled,true);assert.match(f.elements.get('telegram-status').textContent,/Saved successfully/);assert.equal(f.elements.get('telegram-bot-link').href,'https://t.me/studio_test_bot');assert.equal(f.elements.get('telegram-token').value,'');
});
test('Save errors appear beside the button and the token stays in the unsaved form',async t=>{
  const f=ui(t,true);await f.elements.get('telegram-save').onclick({preventDefault(){}});assert.match(f.elements.get('telegram-status').textContent,/Chat ID must be numeric/);assert.ok(f.elements.get('telegram-token').value);assert.equal(f.elements.get('telegram-save').disabled,false);
});
