'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const {createStudioTools}=require('../lib/studio-tools');
const {explicitMutation,namedPages}=require('../lib/studio-tools');
const {requestedWriterUpdate,requestedWriterAndProduction}=require('../lib/nanobot-bridge');
const {createPageLearning}=require('../lib/page-learning');
const {createPublish}=require('../lib/publish');
const {PROFILES}=require('../lib/campaign-profiles');
const {composeWriterBrief}=require('../lib/writer-brief');
const clone=x=>JSON.parse(JSON.stringify(x));
const agentPython=process.env.VS_AGENT_PYTHON||path.join(__dirname,'../tools/agent-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('Nanobot uses only the studio bridge tool and executes a full tool-result loop',{skip:!fs.existsSync(agentPython)},async()=>{
  const {spawn}=require('child_process'),readline=require('readline');const ws=fs.mkdtempSync(path.join(os.tmpdir(),'studio-nanobot-test-'));let modelCalls=0,toolCalls=0,final;
  const child=spawn(agentPython,['-X','utf8',path.join(__dirname,'../tools/studio-nanobot.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.on('data',()=>{});
  const timer=setTimeout(()=>child.kill(),20000);
  try{await new Promise((resolve,reject)=>{readline.createInterface({input:child.stdout}).on('line',line=>{const x=JSON.parse(line);if(x.kind==='model'){modelCalls++;child.stdin.write(JSON.stringify({id:x.id,result:modelCalls===1?{tool:'studio.inspect',page:'all',answer:''}:{tool:'none',answer:'الفحص كمل بلا نشر'}})+'\n');}else if(x.kind==='tool'){toolCalls++;assert.equal(x.payload.tool,'studio.inspect');child.stdin.write(JSON.stringify({id:x.id,result:{publishingHeld:true}})+'\n');}else if(x.kind==='final'){final=x;child.stdin.end();resolve();}else if(x.kind==='failure')reject(Error(x.error));});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Runtime exit '+code)));child.stdin.write(JSON.stringify({workspace:ws,text:'فحص الستوديو'})+'\n');});assert.equal(modelCalls,2);assert.equal(toolCalls,1);assert.deepEqual(final.tools,['studio_action']);assert.match(final.answer,/بلا نشر/);}finally{clearTimeout(timer);child.kill();fs.rmSync(ws,{recursive:true,force:true});}
});
test('daily cleanup archives identity first and protects current, active and uncertain uploads',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const media=path.join(root,'media'),artifacts=path.join(root,'artifacts'),assets=path.join(root,'assets');for(const d of [media,artifacts,assets])fs.mkdirSync(d);
  const projects=['old','active','latest','unknown'].map(id=>({id,page:'maghrebly',source:{url:'https://example.com/'+id},...(id==='unknown'?{publishPairs:{x:{status:'unknown'}}}:{})}));const marked=[];
  for(const p of projects){fs.mkdirSync(path.join(media,p.id));const file=path.join(media,p.id,'video.mp4');fs.writeFileSync(file,'test');fs.utimesSync(file,new Date(Date.now()-2*86400000),new Date(Date.now()-2*86400000));fs.writeFileSync(path.join(artifacts,p.id+'.json'),JSON.stringify({id:p.id,project:p.id,file}));}
  const r=require('../lib/storage-retention').createStorageRetention({dir:root,mediaRoot:media,enabled:false,store:{DIR:{artifacts,assets},listProjects:()=>projects,project:id=>projects.find(p=>p.id===id),markSourceUsed:x=>marked.push(x)},jobs:{list:()=>[{project:'active',status:'running'}]},campaigns:{list:()=>[{profiles:[{key:'maghrebly',project:'latest',videoId:'latest'}]}]},telegram:{notify:async()=>{}}});
  assert.equal(r.inspect().eligibleFiles,1);const cleaned=await r.clean();assert.equal(cleaned.removedFiles,1);assert.equal(fs.existsSync(path.join(media,'old','video.mp4')),false);for(const key of ['active','latest','unknown'])assert.ok(fs.existsSync(path.join(media,key,'video.mp4')));const ledger=JSON.parse(fs.readFileSync(path.join(root,'retired-media.json')));assert.equal(ledger.projects.old.source,'https://example.com/old');assert.equal(Object.values(ledger.files)[0].status,'purged');assert.equal(Object.values(ledger.files)[0].sha256.length,64);assert.equal(marked.length,1);
});
test('queue inspection includes old jobs beyond the UI sixty-record window',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-queue-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(let i=0;i<75;i++)fs.writeFileSync(path.join(dir,'J'+i+'.json'),JSON.stringify({id:'J'+i,ts:i,status:'queued'}));
  const jobs=require('../lib/jobs').createJobs({dir,enabled:false});assert.equal(jobs.list({}).length,60);assert.equal(jobs.list({all:true}).length,75);assert.ok(jobs.list({all:true}).some(j=>j.id==='J0'));
});
test('assistant fresh production is authorized, idempotent and cannot request publishing',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-start-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;const projects=[];
  const tools=createStudioTools({dir,campaigns:{},learning:{},llm:{},jobs:{list:()=>[]},store:{ORCHESTRATOR:'studio',listProjects:()=>projects,project:id=>projects.find(p=>p.id===id),createProject:(page,title,extra)=>{const p={id:'p',page,...extra};projects.push(p);return p;}},pipeline:{startAutomatic:args=>{calls++;assert.deepEqual(args.pages,['maghrebly']);assert.equal(args.publish,undefined);return{jobId:'j',status:'queued'};}}});
  const plan={tool:'production.start',page:'maghrebly'},ctx={authorized:true,requestId:'once',text:'make a Maghrebly video'};
  await assert.rejects(tools.execute(plan,{...ctx,authorized:false}));await tools.execute(plan,ctx);await tools.execute(plan,ctx);assert.equal(calls,1);assert.equal(projects.length,1);
  await assert.rejects(tools.execute({tool:'shell.execute',page:'all'},ctx),/Unsupported/);
});
test('Arabic owner command updates one writer then requests one fresh non-publishing production',async t=>{
  const text='حدث كتابة MaghrebTechStore وقاد فيديو جديد';
  assert.equal(explicitMutation(text),true);assert.deepEqual(namedPages(text),['maghrebtechstore']);
  assert.equal(requestedWriterUpdate('Update MaghrebTechStore writer instructions only. Add accurate Surveyoo CTA.'),'maghrebtechstore');
  assert.equal(requestedWriterAndProduction(text),'maghrebtechstore');
  assert.equal(requestedWriterUpdate('What should I change in MaghrebTechStore writing?'),null);
  assert.equal(requestedWriterAndProduction('شرح ليا كيفاش نحدث كتابة MaghrebTechStore'),null);
  assert.equal(requestedWriterAndProduction('حدث كتابة MaghrebTechStore'),null);
});
test('website agent reads the mapped connection and writes only after a named owner request',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-website-tools-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];
  const siteIntegrations={settings:()=>({github:{connected:true},cloudflare:{connected:true},sites:[{id:'maghrebtechstore',domain:'maghrebtechstore.com'}]}),updateFile:async x=>{calls.push(x);return{ok:true,commit:'abc123'};}};
  const tools=createStudioTools({dir,campaigns:{},learning:{},jobs:{list:()=>[]},llm:{},store:{},siteIntegrations,tracking:{settings:()=>({sites:[{id:'maghrebtechstore',enabled:true}]})}});
  const inventory=await tools.execute({tool:'website.list'},{authorized:false});assert.equal(inventory.sites[0].tracking,true);
  await assert.rejects(tools.execute({tool:'website.file.update',site:'maghrebtechstore',path:'index.html',content:'new'},{authorized:false}));
  const result=await tools.execute({tool:'website.file.update',site:'maghrebtechstore',path:'index.html',content:'new'},{authorized:true,requestId:'site-edit-1',text:'edit maghrebtechstore website'});
  assert.equal(result.commit,'abc123');assert.equal(calls.length,1);assert.equal(calls[0].id,'maghrebtechstore');
});
test('owner publishing hold prevents any upload even with confirm enabled',async()=>{
  const api=createPublish({store:{},hold:()=>true});await assert.rejects(api.execute({confirm:true}),/paused by the owner/);
});
test('reference reports join timed speech and vision without claiming exact cuts or verified prices',()=>{
  const report=require('../lib/reference-report').buildReferenceReport({id:'r',page:'maghrebly',status:'completed',video:{id:'123',views:10},transcript:{text:'hello later',segments:[{start:0,end:5,text:'hello later',words:[{start:0,end:1,text:'hello'},{start:4,end:5,text:'later'}]}]}},{duration:5,coverage:{complete:true},timeline:[{id:'s1',start:0,end:5,description:'box',visibleText:['Galaxy A05s'],evidence:[{role:'actions',model:'vision',start:0,end:5}]}]});
  assert.equal(report.scenes[0].speech,'hello later');assert.equal(report.opening[0].speech,'hello');assert.equal(report.opening[0].end,3);assert.equal(report.transcript.verified,false);assert.ok(report.warnings.some(w=>w.includes('Galaxy A05s')));assert.match(report.markdown,/ماشي عدّاد تقطيع/);
  assert.throws(()=>require('../lib/reference-report').buildReferenceReport({status:'completed'},{coverage:{complete:false}}),/completed full-source/);
});
test('Facebook reconnect refreshes both authorized Maghrebly destinations without touching unrelated pages',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-reconnect-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'fb_config.json'),pagesDir=path.join(dir,'studio','pages');fs.mkdirSync(pagesDir,{recursive:true});
  fs.writeFileSync(file,JSON.stringify({pages:[{id:'11',brand:'maghrebly',page_token:'old1'},{id:'22',brand:'',page_token:'old2'},{id:'33',brand:'',page_token:'untouched'}]}));
  fs.writeFileSync(path.join(pagesDir,'maghrebly.json'),JSON.stringify({allowedDestinations:[{id:'11',enabled:true},{id:'22',enabled:true}]}));
  const original=global.fetch;t.after(()=>{global.fetch=original;});
  global.fetch=async(url,opts)=>{const token=opts.headers.Authorization.slice(6);let body;
    if(url.includes('/me/accounts?'))body={data:[{id:'11',name:'Primary',access_token:'new-one'},{id:'22',name:'Secondary',access_token:'new-two'},{id:'33',name:'Unrelated',access_token:'do-not-save'}]};
    else body=token==='new-one'?{id:'11',name:'Primary'}:token==='new-two'?{id:'22',name:'Secondary'}:{id:'owner',name:'Owner'};
    return{ok:true,json:async()=>body};};
  const result=await require('../lib/facebook-reconnect').createFacebookReconnect({file}).reconnect('owner-token-'.repeat(4),'maghrebly');
  assert.equal(result.updated.length,2);const saved=JSON.parse(fs.readFileSync(file));assert.deepEqual(saved.pages.map(p=>p.page_token),['new-one','new-two','untouched']);assert.equal(JSON.stringify(result).includes('new-one'),false);
});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-tools-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t){
  const dir=temp(t);let version=1,writes=0,modelCalls=0,checks=0;
  const profiles=PROFILES.map(p=>({...p,label:p.key,writerInstructions:'Original '+p.key,destinations:[{id:'123456',enabled:true}]}));
  const campaigns={catalog:()=>clone(profiles),settings:()=>({updatedAt:version,sharedInstructions:'Shared unchanged',pages:profiles.map(p=>({key:p.key,instructions:p.writerInstructions}))}),saveSettings:input=>{assert.equal(input.updatedAt,version);for(const [key,value]of Object.entries(input.pageInstructions)){profiles.find(p=>p.key===key).writerInstructions=value;writes++;}version++;return campaigns.settings();},checkConnections:async()=>{checks++;return[{page:'maghrebly',ok:true,checkedAt:Date.now()}];}};
  const llm={text:async()=>{modelCalls++;return JSON.stringify({answer:'New instructions for this profile only'});}};
  const tools=createStudioTools({dir,campaigns,learning:{get:()=>({videos:[],references:[]})},jobs:{},llm});
  return{dir,tools,campaigns,profiles,stats:()=>({writes,modelCalls,checks})};
}
test('writer updates are page-scoped, preserve all seven identities, and are reversible',async t=>{
  const f=fixture(t),before=clone(f.profiles),ctx={authorized:true,requestId:'message1',text:'بدل تعليمات Maghrebly وخلي البداية سؤال قصير',history:[]};
  const result=await f.tools.execute({tool:'writer.update',page:'maghrebly'},ctx);
  assert.equal(result.status,'applied');assert.equal(f.stats().writes,1);
  for(const p of f.profiles){const old=before.find(x=>x.key===p.key);assert.equal(p.idea,old.idea);assert.equal(p.language,old.language);assert.equal(p.audience,old.audience);if(p.key!=='maghrebly')assert.deepEqual(p,old);}
  assert.equal(f.campaigns.settings().sharedInstructions,'Shared unchanged');
  await f.tools.execute({tool:'writer.update',page:'maghrebly'},ctx);assert.equal(f.stats().writes,1);assert.equal(f.stats().modelCalls,1);
  await f.tools.execute({tool:'writer.undo',page:'maghrebly'},{authorized:true,requestId:'message2',text:'رجع آخر تعديل ديال Maghrebly',history:[]});
  assert.deepEqual(f.profiles,before);assert.equal(f.tools.history('maghrebly').length,2);
});
test('wrong-page plans, ambiguous edits, read-only previews and informational questions cannot mutate writers',async t=>{
  const f=fixture(t);for(const [page,text,authorized]of [['vouchteck','change Maghrebly prompt',true],['maghrebly','update Maghrebly and VouchTech',true],['maghrebly','update Maghrebly',false],['maghrebly','how to change Maghrebly prompt?',true],['all','change all prompts',true]])await assert.rejects(f.tools.execute({tool:'writer.update',page},{authorized,requestId:'test-'+text,text,history:[]}));
  assert.equal(f.stats().writes,0);
  await assert.rejects(f.tools.execute({tool:'reference.analyze',page:'maghrebly'},{authorized:false,text:'analyze'}));
});
test('Meta checks are fresh on every request and do not rely on the saved snapshot',async t=>{
  const f=fixture(t);await f.tools.execute({tool:'meta.check',page:'all'});await f.tools.execute({tool:'meta.check',page:'maghrebly'});assert.equal(f.stats().checks,2);
});
function learningFixture(t){
  const dir=temp(t),runners={},bus=new EventEmitter(),projects=[],queued=[];let seq=0;
  const campaigns={catalog:()=>PROFILES.map(p=>({...p,label:p.key,destinations:[{id:p.key==='maghrebly'?'123456':'234567',enabled:true}]}))};
  const jobs={enabled:false,bus,register:(type,fn)=>runners[type]=fn,enqueue:spec=>{const job={...spec,id:'job'+(++seq),status:'queued'};queued.push(job);return job;},get:id=>queued.find(j=>j.id===id),publicJob:x=>x};
  const store={ORCHESTRATOR:'studio',createProject:(page,title,extra)=>{const p={id:'project'+(++seq),page,title,...extra};projects.push(p);return p;},project:id=>projects.find(p=>p.id===id),artifact:()=>({id:'asset',file:path.join(dir,'fixture.mp4'),probe:{duration:30,hasAudio:true}})};
  const publish={listVideos:async(page,id,{edge})=>({videos:[{id:'1000001',destinationId:id,title:'Winner',views:1000,duration:30},{id:'1000002',destinationId:id,title:'Other',views:10,duration:30}],hasMore:true,nextCursor:'cursor'})};
  const pipeline={startAutomatic:input=>({jobId:'production-'+input.pages[0],analysisId:'fresh-analysis',pages:input.pages})};
  const learning=createPageLearning({dir,store,jobs,campaigns,publish,media:{ff:async args=>fs.writeFileSync(args[args.length-1],'audio')},understanding:{get:()=>null,analyze:async()=>({id:'analysis',status:'completed',coverage:{complete:true},timeline:[{start:0,end:3,description:'Box opening'}]})},transcribe:{run:async()=>({transcription:{id:'transcript',text:'Recognised spoken content',segments:[{start:0,end:2,text:'Recognised spoken content'}],timing:'speech_recognition'}})},pipeline,llm:{transcribe:async()=>JSON.stringify({transcript:'Recognised spoken content',language:'Darija',hook:'hook',argument:'order',cta:'cta',delivery:'voice',uncertainty:'ASR uncertain',segments:[{start:0,end:2,quote:'Recognised spoken content',purpose:'hook',delivery:'voice',uncertainty:''}]}),text:async()=>JSON.stringify({answer:'Open on the phone reveal, then show packaging. Performance causality unknown.'})},telegram:{notify:async()=>({skipped:true})}});t.after(()=>learning.close());
  return{dir,learning,jobs,runners,projects,queued};
}
test('historical scanning deduplicates edges, ranks actual views and declares partial coverage',async t=>{
  const f=learningFixture(t),r=await f.learning.scan({page:'maghrebly'});assert.equal(r.pages[0].scanned,2);assert.equal(r.pages[0].top[0].views,1000);assert.equal(r.pages[0].coverage[0].hasMore,true);assert.equal(f.learning.context('maghrebly'),null);assert.equal(f.learning.get('vouchteck').videos.length,0);
});
test('full reference job combines independent transcription, vision and page-only learning before fresh production',async t=>{
  const f=learningFixture(t);await f.learning.scan({page:'maghrebly'});const q=f.learning.analyze({page:'maghrebly',produceAfter:true,requestId:'owner1'}),job=f.queued.find(j=>j.id===q.jobId);
  const record=f.learning.get('maghrebly');record.references[0].project=f.storeProject || 'fixture-project';record.references[0].assetId='asset';
  f.projects.push({id:'fixture-project',page:'maghrebly'});fs.writeFileSync(path.join(f.dir,'maghrebly.json'),JSON.stringify(record));
  job.status='running';const result=await f.runners['learning.analyze'](job,{job,progress(){},note(){}});
  assert.equal(result.status,'completed');assert.equal(result.transcription,'ready');assert.equal(f.learning.get('maghrebly').references[0].transcript.text,'Recognised spoken content');assert.equal(f.learning.context('maghrebly').page,'maghrebly');assert.equal(f.learning.context('vouchteck'),null);assert.equal(result.production.publish,false);assert.deepEqual(result.production.pages,['maghrebly']);
  await assert.rejects(Promise.resolve().then(()=>f.learning.apply({page:'vouchteck',referenceId:q.referenceId})),/same page/);
  const refined=await f.learning.refine({page:'maghrebly',referenceId:q.referenceId});assert.equal(refined.status,'applied');assert.match(f.learning.context('maghrebly').refinement,/phone reveal/);assert.equal(f.learning.get('vouchteck').refinement,undefined);
  assert.equal((await f.learning.refine({page:'maghrebly',referenceId:q.referenceId})).reused,true);
  assert.equal(f.learning.undoRefinement({page:'maghrebly'}).status,'restored');assert.equal(f.learning.get('maghrebly').autoRefine,false);assert.equal(f.learning.get('maghrebly').refinement,null);
});
test('reference retries reuse the same scoped record and queued analysis',async t=>{
  const f=learningFixture(t);await f.learning.scan({page:'maghrebly'});const first=f.learning.analyze({page:'maghrebly'}),second=f.learning.analyze({page:'maghrebly',produceAfter:true,requestId:'new-owner-command'});assert.equal(first.referenceId,second.referenceId);assert.equal(f.queued.length,1);assert.equal(f.learning.get('maghrebly').references[0].produceAfter,true);
});
test('Meta historical listing never returns credentials or signed pagination URLs',async t=>{
  const original=global.fetch;t.after(()=>global.fetch=original);const token='private-page-token';let authorization;
  const api=createPublish({store:{page:()=>({allowedDestinations:[{id:'123456',enabled:true}]})},accounts:()=>[{id:'123456',brand:'maghrebly',page_token:token}]});
  global.fetch=async(url,opts)=>{authorization=opts.headers.Authorization;return{ok:true,status:200,json:async()=>({data:[{id:'999999',views:55,length:30}],paging:{next:'https://graph.facebook.com/next?access_token='+token,cursors:{after:'cursor'}}})};};
  const r=await api.listVideos('maghrebly','123456');assert.equal(r.videos[0].views,55);assert.equal(JSON.stringify(r).includes(token),false);assert.equal(authorization,'OAuth '+token);
  global.fetch=async()=>({ok:true,status:200,json:async()=>({id:'999999',from:{id:'123456'},source:'https://127.0.0.1/private.mp4'})});await assert.rejects(api.videoSource('maghrebly','123456','999999'),/supported CDN/);
});
test('learning text is separate from the fixed writer identity and current footage',()=>{
  const brief=composeWriterBrief({profile:{label:'Maghrebly',idea:'Moroccan families',language:'Darija',learning:{page:'maghrebly',patterns:'Fast opening reveal'}},analysis:{duration:30,timeline:[{start:0,end:2,description:'Actual box opening'}]},pageInstructions:'Owner instructions'});
  assert.match(brief,/Moroccan families/);assert.match(brief,/Darija/);assert.match(brief,/Fast opening reveal/);assert.match(brief,/Actual box opening/);assert.match(brief,/Do not copy the reference product claims/);
});
