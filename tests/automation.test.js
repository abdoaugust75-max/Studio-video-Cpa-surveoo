'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createTelegramReports}=require('../lib/telegram-reports');
const {createPublish}=require('../lib/publish');
const {createCampaignProduction}=require('../lib/campaign-production');
const {instant,localParts,upcoming,createAutomation}=require('../lib/automation');
const clone=x=>JSON.parse(JSON.stringify(x));
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-automation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('timezone conversion follows Morocco, Riyadh, UK and US DST',()=>{
  assert.equal(new Date(instant('2026-10-15','13:00','Africa/Casablanca')).toISOString(),'2026-10-15T12:00:00.000Z');
  assert.equal(new Date(instant('2026-10-15','20:00','Asia/Riyadh')).toISOString(),'2026-10-15T17:00:00.000Z');
  assert.equal(new Date(instant('2026-10-15','19:00','Europe/London')).toISOString(),'2026-10-15T18:00:00.000Z');
  assert.equal(new Date(instant('2026-12-15','19:00','America/New_York')).toISOString(),'2026-12-16T00:00:00.000Z');
  assert.equal(instant('2026-03-08','02:30','America/New_York'),null);
});
test('a repeated DST hour has one stable slot identity',()=>{
  const s={p:{enabled:true,slots:[{time:'01:30',zone:'America/New_York'},{time:'19:00',zone:'America/New_York'}]}};
  const rows=upcoming(s,Date.parse('2026-11-01T00:00Z')).filter(x=>x.day==='2026-11-01');
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(x=>x.id)).size,2);
});
test('Telegram keeps credentials out of settings, validates input and preserves saved token',async t=>{
  const dir=temp(t),calls=[];
  const tg=createTelegramReports({dir,request:async(url,opts)=>{
    calls.push({url,body:JSON.parse(opts.body)});
    return {ok:true,status:200,json:async()=>({ok:true,result:url.endsWith('getMe')?{id:123,username:'test_bot'}:{message_id:10}})};
  }});
  const token='123456789:'+'x'.repeat(32);tg.save({token,chatId:'1234567',enabled:true});
  assert.equal(JSON.stringify(tg.settings()).includes(token),false);tg.save({token:'',enabled:true});await tg.test();
  assert.equal(tg.settings().bot.username,'test_bot');assert.equal(calls[1].body.chat_id,'1234567');
  await tg.notify('one','hello');await tg.notify('one','hello');assert.equal(calls.filter(c=>c.body.text==='hello').length,1);
  assert.throws(()=>tg.save({chatId:'https://bad'}));assert.throws(()=>tg.save({token:'bad'}));
});
test('uncertain Telegram sends are not duplicated, errors cannot leak token URLs',async t=>{
  let calls=0;const tg=createTelegramReports({dir:temp(t),request:async(url)=>{calls++;throw Error(url);}});
  const token='123456789:'+'x'.repeat(32);tg.save({token,chatId:'1',enabled:true});
  const result=await tg.notify('one','hello');assert.equal(result.status,'unknown');assert.equal(JSON.stringify(result).includes(token),false);await tg.notify('one','hello');assert.equal(calls,1);
});
function publishing(t){
  const dir=temp(t);const file=path.join(dir,'video.mp4');fs.writeFileSync(file,'fixture');
  let project={id:'project',page:'maghrebly',title:'phone',caption:'caption',approvedArtifact:'video',artifacts:['video'],posts:[]};
  const destinations=['1','2'].map(id=>({id,name:'Page '+id,enabled:true}));
  const store={page:()=>({label:'Maghrebly',allowedDestinations:destinations}),artifact:id=>id==='video'?{id,project:'project',kind:'video',file,label:'video'}:null,
    project:()=>clone(project),saveProject:p=>{project=clone(p);return p;},listProjects:()=>[{id:'project'}],markSourceUsed:()=>{}};
  const api=createPublish({store,accounts:()=>destinations.map(d=>({...d,brand:'maghrebly',page_token:'private'}))});
  return{api,project:()=>project};
}
test('both Maghrebly destinations publish; repeat execution never uploads twice',async t=>{
  const {api,project}=publishing(t);const original=global.fetch;t.after(()=>global.fetch=original);let uploads=0;
  global.fetch=async(url,opts)=>{if(opts.method==='POST'){uploads++;return{ok:true,status:200,json:async()=>({id:'post'+uploads})};}return{ok:true,status:200,json:async()=>({id:url.match(/\/([^/?]+)\?/)[1]})};};
  const selection={artifacts:['video'],destinations:['1','2']};const opts={...selection,token:api.plan(selection).token,confirm:true};
  let result=await api.execute(opts);assert.equal(result.posted,2);await api.execute(opts);assert.equal(uploads,2);assert.equal(project().posts.length,2);
});
test('partial Facebook failure retries only failed destination and keeps accepted ID',async t=>{
  const {api,project}=publishing(t);const original=global.fetch;t.after(()=>global.fetch=original);let fail=true;const uploads=[];
  global.fetch=async(url,opts)=>{if(opts.method==='POST'){uploads.push(url);if(url.includes('/2/')&&fail)return{ok:false,status:400,json:async()=>({error:{message:'expired'}})};return{ok:true,status:200,json:async()=>({id:url.includes('/1/')?'p1':'p2'})};}return{ok:true,status:200,json:async()=>({id:url.includes('p1')?'p1':'p2'})};};
  const selection={artifacts:['video'],destinations:['1','2']};const opts={...selection,token:api.plan(selection).token,confirm:true};
  let result=await api.execute(opts);assert.equal(result.posted,1);fail=false;result=await api.retryFailed(opts);assert.equal(result.posted,1);assert.equal(uploads.length,3);assert.equal(project().posts.length,2);
});
test('Facebook timeout blocks automatic reupload of uncertain pair',async t=>{
  const {api}=publishing(t);const original=global.fetch;t.after(()=>global.fetch=original);let calls=0;global.fetch=async()=>{calls++;throw Error('timeout');};
  const selection={artifacts:['video'],destinations:['1']},opts={...selection,token:api.plan(selection).token,confirm:true};
  await api.execute(opts);const result=await api.execute(opts);assert.equal(calls,1);assert.equal(result.results[0].unknown,true);
});
test('campaign publisher fans a Maghrebly video out to both configured destinations',async t=>{
  const dir=temp(t),calls=[];
  const destinations=[{id:'1243447985522334',name:'Maghrebly A',enabled:true},{id:'449514468236889',name:'Maghrebly B',enabled:true}];
  let project={id:'branch',caption:'caption',posts:[]};
  const store={page:()=>({label:'test',campaign:{}}),project:()=>clone(project),saveProject:p=>{project=clone(p);},artifact:()=>({id:'video'}),rollback:()=>{},approve:()=>{}};
  const publish={destinations:page=>page==='maghrebly'?destinations:[],checkConnection:async()=>({ok:true}),plan:()=>({ok:true,token:'approved'}),execute:async selection=>{calls.push(selection);return{results:[{ok:true,postId:'post'+selection.destinations[0],destination:destinations.find(d=>d.id===selection.destinations[0])}]};}};
  const campaign=createCampaignProduction({dir,store,jobs:{register:()=>{}},understanding:{},media:{},legacy:{root:dir,providers:{pickOne:()=>'',pick:()=>({candidates:[]})}},publish,appearance:{get:()=>({pages:{maghrebly:{website:''}},common:{includeWebsiteInCaption:true}})}});
  fs.writeFileSync(path.join(dir,'CRtest--maghrebly.json'),JSON.stringify({runId:'CRtest',key:'maghrebly',project:'branch',videoId:'video'}));
  const result=await campaign.publishPage({runId:'CRtest',page:'maghrebly'});
  assert.equal(result.status,'published');assert.deepEqual(calls.map(c=>c.destinations[0]),destinations.map(d=>d.id));
});
function scheduler(t,valid=true){
  const dir=temp(t);let clock=Date.parse('2026-10-15T09:00Z'),seq=0;const records=[],projects=[],runs=[];
  const jobs={enabled:true,enqueue:spec=>{const j={...spec,id:'j'+(++seq),status:'queued'};records.unshift(j);return j;},get:id=>records.find(x=>x.id===id),list:filter=>records.filter(x=>!filter?.project||x.project===filter.project)};
  const store={ORCHESTRATOR:'all',listProjects:page=>projects.filter(p=>!page||p.page===page),project:id=>projects.find(p=>p.id===id),createProject:(page,title,extra)=>{const p={id:'p'+(++seq),page,title,...extra};projects.push(p);return p;}};
  const campaigns={catalog:()=>[{key:'maghrebly',label:'Maghrebly'}],checkConnections:async()=>[{page:'maghrebly',ok:valid}],list:()=>runs,inspect:id=>runs.find(x=>x.id===id),retry:()=>{}};
  const pipeline={startAutomatic:input=>{const j=jobs.enqueue({type:'pipeline.run',project:input.project,params:{analysisId:'a'+seq}});return{jobId:j.id,analysisId:j.params.analysisId};}};
  const telegram={settings:()=>({enabled:false}),notify:async()=>({skipped:true})};
  const automation=createAutomation({dir,jobs,store,campaigns,pipeline,telegram,publish:{},now:()=>clock});t.after(()=>automation.close());automation.save({enabled:true});
  const restart=()=>{automation.close();const next=createAutomation({dir,jobs,store,campaigns,pipeline,telegram,publish:{},now:()=>clock});t.after(()=>next.close());return next;};
  return{automation,jobs,records,runs,restart,setTime:ts=>clock=Date.parse(ts),dir};
}
test('scheduler prepares two daily batches once, dispatches once, survives restart state',async t=>{
  const f=scheduler(t);await f.automation.tick();assert.equal(f.records.filter(j=>j.type==='pipeline.run').length,2);
  await f.automation.tick();assert.equal(f.records.length,2);
  for(const job of f.records){job.status='done';job.result={campaign:{runId:'run'+job.id},status:'campaign_queued'};f.runs.push({id:'run'+job.id,analysisId:job.params.analysisId,profiles:[{key:'maghrebly',videoId:'v'+job.id,status:'ready'}]});}
  f.setTime('2026-10-15T12:00Z');await f.automation.tick();assert.equal(f.records.filter(j=>j.type==='campaign.publish').length,1);
  await f.automation.tick();assert.equal(f.records.filter(j=>j.type==='campaign.publish').length,1);
  const delivery=f.records.find(j=>j.type==='campaign.publish');delivery.status='done';delivery.result={status:'published',deliveries:[{ok:true,destination:{name:'one'},postId:'p'}]};
  f.setTime('2026-10-15T13:00Z');await f.automation.tick();assert.equal(f.automation.status().state.slots['maghrebly:2026-10-15:0'].status,'published');
  assert.ok(fs.existsSync(path.join(f.dir,'automation-state.json')));
  const restarted=f.restart();await restarted.tick();assert.equal(f.records.filter(j=>j.type==='campaign.publish').length,1);assert.equal(restarted.status().state.slots['maghrebly:2026-10-15:0'].status,'published');
});
test('expired credentials block paid production and posting',async t=>{
  const f=scheduler(t,false);await f.automation.tick();assert.equal(f.records.length,0);assert.ok(Object.values(f.automation.status().state.slots).some(s=>s.status==='blocked_credentials'));
});
test('scheduler validates settings and does not backfill old slots',async t=>{
  const f=scheduler(t);assert.throws(()=>f.automation.save({schedules:{maghrebly:{slots:[]}}}));
  f.setTime('2026-10-15T14:00Z');await f.automation.tick();assert.equal(f.automation.status().state.slots['maghrebly:2026-10-15:0'].status,'missed');
  assert.equal(f.records.filter(j=>j.type==='campaign.publish').length,0);
});
test('scheduler reports partial destination outcomes as partial, not stuck or fully published',async t=>{
  const f=scheduler(t);await f.automation.tick();
  for(const job of f.records){job.status='done';job.result={campaign:{runId:'run'+job.id},status:'campaign_queued'};f.runs.push({id:'run'+job.id,profiles:[{key:'maghrebly',videoId:'v',status:'ready'}]});}
  f.setTime('2026-10-15T12:00Z');await f.automation.tick();
  const job=f.records.find(j=>j.type==='campaign.publish');job.status='done';job.result={status:'needs_connection',deliveries:[{ok:true,postId:'p',destination:{name:'A'}},{ok:false,error:'Token expired',destination:{name:'B'}}]};
  await f.automation.tick();assert.equal(f.automation.status().state.slots['maghrebly:2026-10-15:0'].status,'partial');await f.automation.tick();assert.equal(f.records.filter(j=>j.type==='campaign.publish').length,1);
});
test('single-worker restart recovers a scheduler claim left by a reused PID',async t=>{
  const f=scheduler(t);fs.writeFileSync(path.join(f.dir,'automation.tick.lock'),JSON.stringify({pid:process.pid,instance:'previous-container'}));
  await f.automation.tick();assert.equal(fs.existsSync(path.join(f.dir,'automation.tick.lock')),false);
  await f.automation.tick();assert.equal(f.records.filter(j=>j.type==='pipeline.run').length,2);
});
