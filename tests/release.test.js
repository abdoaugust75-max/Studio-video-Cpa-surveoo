'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),{spawn,spawnSync}=require('child_process');
const {createGate}=require('../lib/process-budget');
test('a timed-out local helper cannot leave its descendant running',{timeout:10000},async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'studio-process-')),pidFile=path.join(tmp,'child.pid');let pid;
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch(_){}assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));assert.ok(path.basename(tmp).startsWith('studio-process-'));fs.rmSync(tmp,{recursive:true,force:true});});
  const code=`const {spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
  await assert.rejects(require('../lib/util').run(process.execPath,['-e',code],{timeoutSec:.8}),/timeout after/);
  pid=Number(fs.readFileSync(pidFile,'utf8'));assert.ok(pid>0);let alive=true;
  for(let i=0;i<30;i++){try{process.kill(pid,0);}catch(_){alive=false;break;}await new Promise(r=>setTimeout(r,80));}
  assert.equal(alive,false,'Descendant survived the helper timeout');pid=null;
});
const {scopedCommercialFacts,scriptPriceError}=require('../lib/commercial-facts');
test('writer validation reports the specific fix without relaxing dialect or scene grounding',()=>{
  const {writerValidationIssues}=require('../lib/writer-brief');
  const bad={script_text:'A'.repeat(100),title:'x'.repeat(46),scene_links:[{scene_index:9,line:'not in narration',connection:'bad'}]};
  const errors=writerValidationIssues(bad,{timeline:[{}]},{languageValid:false});
  assert.ok(errors.some(e=>e.includes('language/dialect')));assert.ok(errors.some(e=>e.includes('title')));assert.ok(errors.some(e=>e.includes('EXACTLY')));
  const text='This is the opening. '+ 'Here is the visible phone. '.repeat(4);
  assert.deepEqual(writerValidationIssues({script_text:text,title:'Phone unboxing',scene_links:[{scene_index:0,line:'This is the opening.',connection:'Opening scene'}]},{timeline:[{}]}),[]);
});
test('only evidenced scene quotations survive normalization; nonexistent actions are never fabricated',()=>{
  const {sanitizeSceneLinks,validSceneLinks}=require('../lib/writer-brief'),analysis={timeline:[{},{}]};
  const s=sanitizeSceneLinks({script_text:'Let’s open the box. Here is the phone.',scene_links:[{scene_index:0,line:"Let's open the box.",connection:'Opening'},{scene_index:1,line:'Invented words',connection:'Wrong'},{scene_index:90,line:'Here is the phone.',connection:'Unknown scene'}]},analysis);
  assert.equal(s.discarded,2);assert.equal(s.written.scene_links[0].line,'Let’s open the box.');assert.ok(validSceneLinks(s.written,analysis));
  const bad=sanitizeSceneLinks({script_text:'Actual narration.',scene_links:[{scene_index:0,line:'Imagined action',connection:'Unsupported'}]},analysis);assert.equal(bad.written.scene_links.length,0);assert.equal(validSceneLinks(bad.written,analysis),false);
});
const speechPython=path.resolve(__dirname,'../tools/speech-runtime/Scripts/python.exe');
const testPython=process.env.VS_TEST_PYTHON|| (fs.existsSync(speechPython)?speechPython:process.env.pythonLocation?path.join(process.env.pythonLocation,'python.exe'):null);
test('overlapping alignment windows use recognised acoustic evidence or remain rejected',{skip:!testPython},()=>{
  const r=spawnSync(testPython,['-X','utf8',path.resolve(__dirname,'../tools/alignment_boundaries.py')],{windowsHide:true,timeout:10000,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/no inferred timestamps/);
});
test('a price for another phone cannot leak into script, caption or a cached output',()=>{
  const analysis={timeline:[{description:'OnePlus Ace 3 unboxing'}]};
  const scope=scopedCommercialFacts({analysis,approvedFacts:'[1] iPhone 15 = 7200 DH\n[2] PS5 = 3500 DH',presentation:{prices:[]}});
  assert.equal(scope.text.includes('7200'),false);assert.equal(scope.amounts.length,0);
  assert.ok(scriptPriceError('ثمن هاد الهاتف هو 7200 درهم',scope));assert.ok(scriptPriceError('الثمن هو 7200',scope));
  assert.equal(scriptPriceError('نفتحو العلبة ونشوفو الهاتف',scope),null);assert.equal(scriptPriceError('This unboxing is mad!',scope),null);
  const matched=scopedCommercialFacts({analysis,approvedFacts:'OnePlus Ace 3 = 1200 DH'});
  assert.equal(scriptPriceError('الثمن 1200 درهم',matched),null);assert.ok(scriptPriceError('الثمن 3 درهم',matched));assert.ok(scriptPriceError('الثمن 7200 درهم',matched));
  const prices=scopedCommercialFacts({analysis,presentation:{prices:[{product:'iPhone 15',price:'7200 DH'},{product:'OnePlus Ace 3',price:'1200 DH'}]}});
  assert.equal(prices.prices.length,1);assert.deepEqual(prices.amounts,['1200.00']);
  const decimal=scopedCommercialFacts({analysis,presentation:{prices:[{product:'OnePlus Ace 3',price:'$199.99'}]}});assert.equal(scriptPriceError('Price $199.99',decimal),null);assert.ok(scriptPriceError('Price $19999',decimal));
});
test('metadata gate bounds simultaneous downloaders and releases slots after failure',async()=>{const gate=createGate(2);let active=0,peak=0;await Promise.allSettled(Array.from({length:8},(_,i)=>gate(async()=>{active++;peak=Math.max(active,peak);try{await new Promise(r=>setTimeout(r,5));if(i===1)throw Error('fixture failure');}finally{active--;}})));assert.equal(peak,2);assert.equal(active,0);});
test('fresh source boots with isolated empty state and publishing held by default',{timeout:45000},async t=>{
  const root=process.env.VS_RELEASE_ROOT||path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'studio-fresh-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  let output='';const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,windowsHide:true,env:{...process.env,VS_PORT:String(port),VS_HOST:'127.0.0.1',VS_ROLE:'web',VS_DATA_DIR:tmp,VS_STUDIO_DIR:path.join(tmp,'studio'),VS_MEDIA_DIR:path.join(tmp,'media'),VS_CACHE_DIR:path.join(tmp,'cache'),VS_LOGS_DIR:path.join(tmp,'logs'),VS_AUTH_USER:'',VS_AUTH_PASSWORD:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exited=new Promise(r=>child.once('exit',r));
  t.after(async()=>{child.kill();await exited;const target=path.resolve(tmp);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('studio-fresh-'));fs.rmSync(target,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;let live;
  for(let n=0;n<70;n++){try{const r=await fetch(base+'/health/live',{signal:AbortSignal.timeout(1000)});if(r.ok){live=await r.json();break;}}catch(_){}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,150));}
  assert.ok(live?.ok,'Fresh process did not boot: '+output.slice(-1500));assert.equal(live.role,'web');
  assert.equal((await fetch(base+'/pipeline.html')).status,200);
  for(const endpoint of ['/api/v2/writers/settings','/api/v2/video/settings']){
    const invalid={pages:{unknown_profile:{}}};
    const options=origin=>({method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(invalid)});
    assert.ok([200,400].includes((await fetch(base+endpoint,options('https://127.0.0.1:'+port))).status),'Same-host HTTPS must reach normal settings validation');
    assert.equal((await fetch(base+endpoint,options('https://other.invalid'))).status,403,'Cross-host writes stay forbidden');
  }
  const catalog=await(await fetch(base+'/api/v2/campaigns')).json();assert.equal(catalog.profiles.length,7);assert.ok(catalog.profiles.every(p=>p.configured));
  const automation=await(await fetch(base+'/api/v2/automation/settings')).json();assert.equal(automation.enabled,false);
  const held=await fetch(base+'/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});assert.equal(held.status,409);assert.match(await held.text(),/paused/);
  const usage=await(await fetch(base+'/api/v2/provider-usage')).json();assert.equal(usage.total,0);
});
