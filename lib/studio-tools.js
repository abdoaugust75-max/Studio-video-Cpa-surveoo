'use strict';
const fs=require('fs'),path=require('path');
const U=require('./util');
const {PROFILES}=require('./campaign-profiles');
const {redact}=require('./telegram-agent');
const SPEC=[
  {name:'video.send',description:'Send one page assembled MP4 directly to the owner private Telegram chat for review. videoId selects an exact output; blank means latest. Telegram reply context can select an earlier delivered video. No social publishing.'},
  {name:'example.save',description:'On explicit owner request, remember a selected assembled video as the permanent same-page writer style for future productions. Require videoId or Telegram reply to the delivered video. Preserve identity/language and never reuse product claims. Does not enable scheduling or publishing.'},
  {name:'example.inspect',description:'Read the permanent owner-selected example and reusable writer style for one page.'},
  {name:'example.undo',description:'On explicit owner request undo the last saved example for one page.'},
  {name:'api.inspect',description:'Read redacted API-key health, quarantined credentials, local request/token usage and configured remaining estimates. Never reveals secrets; unknown provider balance is not zero. Google quotas are per project, not per key.'},
  {name:'storage.inspect',description:'Read local storage size, daily retention policy and cleanup history. Does not delete files.'},
  {name:'memory.inspect',description:'Read saved owner preferences, project rules and historical task receipts. These do not override tool authorization or current live task state.'},
  {name:'memory.search',description:'Search retained private conversation archive for earlier owner requests and answers. Returns historical excerpts with dates, not current-state evidence.'},
  {name:'studio.inspect',description:'Inspect worker queue, failures and progress, automation gaps and publication hold, for all pages or one. Redacted operational data only.'},
  {name:'page.inspect',description:'Inspect one page identity, owner instructions, learned refinements, output scripts, narration, subtitles and final video metadata. No secrets.'},
  {name:'video.check',description:'Read-only technical checks of one page latest assembled video: file, dimensions, audio metadata, script and subtitle alignment provenance. Does not claim visual perfection or publish.'},
  {name:'production.retry',description:'On explicit owner request retry FAILED production only for one named page. Cannot retry publishing campaigns, cannot publish or change identity.'},
  {name:'production.start',description:'On explicit owner request, run normal fresh footage search, vision, page script, TTS and assembly for one named page. No reference required. Never publishes.'},
  {name:'learning.improve',description:'On explicit owner request, refine additive writer prompts for one page or all seven. Preserve identity/language/owner instructions. Analyze a same-page reference first if needed, then automatically add bounded improvements. Never publishes.'},
  {name:'learning.undo',description:'On owner request, undo the latest additive learning refinement for one page. Does not change the original writer instructions.'},
  {name:'reference.report',description:'Build and return the complete timestamped evidence report for an already completed reference, including recognised speech, scenes, OCR, uncertainties and evidence models. One page only. Does not apply learning or edit prompts.'},
  {name:'videos.review',description:'Scan all pages or one page, return the five highest-view videos with links, and queue independent transcription and full-video vision analysis for each. Use for requests to show top videos AND understand their scripts/visuals. Does not edit prompts or publish.'},
  {name:'meta.check',description:'Fresh read-only Meta token/page identity checks. page may be all.'},
  {name:'videos.scan',description:'Read historical Facebook videos/reels and rank observed views per page. Bounded scan; page may be all.'},
  {name:'videos.top',description:'Read cached historical ranking and scan coverage for one page.'},
  {name:'reference.analyze',description:'Queue owned historical video download, independent ASR, full-source vision review and reusable observations. One page; blank videoId selects highest known views.'},
  {name:'learning.apply',description:'Enable completed learning observations for the same page only, on owner request.'},
  {name:'production.like',description:'On explicit owner request, analyze the selected winning reference if needed, then search fresh clean footage and assemble with the unchanged pipeline for this one profile. Does not publish an extra post.'},
  {name:'writer.update',description:'On explicit owner instruction, edit ONLY this page writer instructions. Keep its fixed idea, language, audience, card, voice and other pages intact. Creates a reversible revision.'},
  {name:'writer.history',description:'Read recent writer revisions for one page.'},
  {name:'writer.undo',description:'On explicit owner request, restore this page latest AI writer edit if its current text still matches that revision.'},
  {name:'reference.status',description:'Read reference-analysis progress, saved transcript, visual summary, observations and production jobs for one page.'}
];
const aliases={maghrebly:['maghrebly','maghrbly','marghbly','amghrebly','مغربلي'],maghrebtechstore:['maghrebtech','maghrebtechstore','مغربتيك'],alshihna:['alshihna','alshiuhna','الشحنة','الشحنه'],vouchteck:['vouchteck','vouchtech','vouch','فوتش'],mubadara:['mubadara','مبادرة','مبادره'],tashilat:['tashilat','tasshilat','تسهيلات'],amazon_liquidation:['amazonliquidation','smartwarehouse','مستودعالاجهزة','مستودعالأجهزة','amazon']};
const normal=x=>String(x||'').toLowerCase().replace(/[\s_\-ـًٌٍَُِّْ]/g,'');
function namedPages(text){const n=normal(text);return Object.keys(aliases).filter(k=>aliases[k].some(a=>n.includes(normal(a))));}
function explicitMutation(text){
  if(/^(?:how (?:do|can|to)|can (?:i|we)|what (?:if|does|would|should)|explain|كيفاش|واش نقدر|شنو (?:ندير|خاصني|خاص)|واش نقدر|شرح)/i.test(String(text).trim()))return false;
  return /\b(start|launch|update|change|edit|rewrite|adjust|set|add|remove|apply|use|make|create|produce|generate|restore|undo|rollback|revert|retry|3awd|bdel|bdal|dir|zid|7ayd|rje3|sawb|khali|khelli|3del|sift|send|remember|save)\b|(?:^|\s)(?:صيفط|سيفط|حفظ|سجل|شغل|بدا|عاود|بدل|بدّل|غير|غيّر|زيد|حيد|رجع|طبق|دير|صاوب|خدم|عدل|عدّل|خلي|خلّي|استعمل|أنشئ|انتج|حدث|حدّث|تحديث|قادي|قاد|وجد|جهز|جهّز)/i.test(String(text));
}
function createStudioTools({dir,campaigns,learning,jobs,llm,store,automation,appearance,publicationHeld,pipeline,storage,providers,videoReview}){
  U.ensureDir(dir);const revisions=U.ensureDir(path.join(dir,'writer-revisions')),actions=U.ensureDir(path.join(dir,'actions'));
  const history=page=>fs.readdirSync(revisions).filter(f=>f.endsWith('.json')).map(f=>U.readJson(path.join(revisions,f),null)).filter(r=>r?.page===page).sort((a,b)=>b.at-a.at).slice(0,20);
  function pageFor(plan,ctx,mutating){
    const page=plan.page;
    if(!PROFILES.some(p=>p.key===page))throw Error('خصك تحدد بروفايل واحد من السبعة بالاسم.');
    if(mutating){
      if(!ctx.authorized || !ctx.requestId || !explicitMutation(ctx.text))throw Error('هاد التغيير كيحتاج طلب واضح منك فالمحادثة الخاصة مع البوت.');
      let named=namedPages(ctx.text);
      if(!named.length&&ctx.repliedVideo?.page)named=[ctx.repliedVideo.page];
      if(!named.length)for(const prior of [...(ctx.history || [])].reverse())if(prior.role==='user'){named=namedPages(prior.text);if(named.length)break;}
      if(named.length!==1 || named[0]!==page)throw Error('باش ما نخلطش الأفكار، سمّي بروفايل واحد بالضبط فطلب التغيير.');
    }
    return page;
  }
  async function execute(plan,ctx={}){
    if(!SPEC.some(t=>t.name===plan.tool))throw Error('Unsupported studio tool');
    const mutating=['example.save','example.undo','video.send','writer.update','writer.undo','learning.apply','production.like','learning.improve','learning.undo','production.retry','production.start'].includes(plan.tool);
    if(plan.tool==='learning.improve'&&plan.page==='all'&&(!ctx.authorized||!ctx.requestId||!explicitMutation(ctx.text)||!/(all|seven|7|كامل|كول|كل|سبع)/i.test(ctx.text)))throw Error('Improving all pages requires an explicit owner request for all seven.');
    if(['reference.analyze','videos.review'].includes(plan.tool) && (!ctx.authorized || !ctx.requestId))throw Error('Queue reference analysis from your private bot conversation or its dashboard control.');
    const page=plan.page==='all' && ['api.inspect','storage.inspect','memory.inspect','memory.search','studio.inspect','meta.check','videos.scan','videos.review','learning.improve'].includes(plan.tool)?'all':pageFor(plan,ctx,mutating);
    const actionId=ctx.authorized&&ctx.requestId?U.hash16(ctx.requestId+'|'+plan.tool):null;
    const actionFile=actionId?path.join(actions,actionId+'.json'):null;
    if(mutating&&actionFile){
      const prior=U.readJson(actionFile,null);if(prior?.status==='completed')return prior.result;
      if(prior?.status==='running'){
        const rev=history(page).find(r=>r.requestId===ctx.requestId);
        if(rev && campaigns.settings().pages.find(p=>p.key===page)?.instructions===rev.after){rev.status='applied';U.writeJsonAtomic(path.join(revisions,rev.id+'.json'),rev);const result={ok:true,page,revisionId:rev.id,status:'applied',recovered:true};U.writeJsonAtomic(actionFile,{...prior,status:'completed',result});return result;}
        throw Error('الطلب السابق توقف أثناء التنفيذ. راجع سجل الصفحة قبل إعادة نفس التغيير.');
      }
      U.writeJsonAtomic(actionFile,{tool:plan.tool,page,status:'running',at:Date.now(),requestId:ctx.requestId});
    }
    let result;
    try{
      switch(plan.tool){
        case 'video.send':result=await videoReview.send(page,plan.videoId||'',ctx.replyToMessageId);break;
        case 'example.save':result=await videoReview.remember({page,videoId:plan.videoId||'',replyToMessageId:ctx.replyToMessageId,requestId:ctx.requestId});break;
        case 'example.inspect':result=videoReview.inspect(page);break;
        case 'example.undo':result=videoReview.undo(page);break;
        case 'api.inspect':result=providers.poolHealth.inspect();break;
        case 'storage.inspect':result=storage.inspect();break;
        case 'memory.inspect':result=U.readJson(path.join(dir,'..','telegram-memory.json'),{preferences:{},recentTasks:[]});break;
        case 'memory.search':{
          const root=path.resolve(dir,'..'),archive=path.join(root,'telegram-archive.jsonl');let records=[];
          if(fs.existsSync(archive)){const fd=fs.openSync(archive,'r');try{const size=fs.fstatSync(fd).size,start=Math.max(0,size-2*1024*1024),buf=Buffer.alloc(size-start);fs.readSync(fd,buf,0,buf.length,start);let lines=buf.toString('utf8').split('\n');if(start)lines.shift();records=lines.flatMap(s=>{try{return[JSON.parse(s)];}catch(_){return[];}});}finally{fs.closeSync(fd);}}
          const terms=String(ctx.text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
          const history=U.readJson(path.join(root,'telegram-conversation.json'),[]);records.push(...history.filter(x=>x.role==='user').map(x=>({user:x.text,at:null})));
          result={historical:true,matches:records.map(r=>({...r,score:terms.filter(t=>(r.user+' '+r.assistant).toLowerCase().includes(t)).length})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||(b.at || 0)-(a.at || 0)).slice(0,6).map(r=>({at:r.at,user:redact(r.user,500),answer:redact(r.assistant,650)})),note:'Archive begins when enabled; older deleted history cannot be recovered.'};break;
        }
        case 'production.start':{
          let project=store.listProjects().map(p=>store.project(p.id)).find(p=>p.assistantRequest===ctx.requestId);
          if(!project)project=store.createProject(store.ORCHESTRATOR,'Assistant production · '+page,{pipelineKey:'assistant-'+U.uid('AP'),assistantProduction:true,assistantRequest:ctx.requestId});
          const old=jobs.list({project:project.id,all:true}).find(j=>j.type==='pipeline.run');
          result={...(old?{jobId:old.id,status:old.status}:pipeline.startAutomatic({project:project.id,pages:[page]})),page,publish:false,note:'Uses existing normal production pipeline; no upload requested.'};break;
        }
        case 'studio.inspect':{
          const list=jobs.list({all:true}).filter(j=>page==='all'||j.page===page),a=automation?.status();
          result={page,workerEnabled:jobs.enabled,publishingHeld:publicationHeld?.() ?? true,automationEnabled:a?.enabled,workerGaps:a?.state?.workerGaps || [],active:list.filter(j=>['queued','running'].includes(j.status)).map(j=>({type:j.type,page:j.page,status:j.status,stage:j.stage,pct:j.pct,started:j.started,queuedAt:j.ts})),failures:list.filter(j=>j.status==='failed').slice(0,10).map(j=>({type:j.type,page:j.page,error:redact(j.error,300),ended:j.ended})),slots:Object.values(a?.state?.slots || {}).slice(-28).map(s=>({page:s.page,day:s.day,time:s.time,status:s.status,error:s.error,reason:s.failureReason})),note:'Read-only diagnostics; unknown is not zero.'};break;
        }
        case 'page.inspect':{
          const p=campaigns.catalog().find(p=>p.key===page),rows=campaigns.list().map(r=>r.profiles?.find(x=>x.key===page)).filter(Boolean),latest=rows.find(x=>x.videoId)||rows[0],r=learning.get(page);
          result={page,name:p.label,idea:p.idea,language:p.language,audience:p.audience,voice:p.voice,card:p.card,writerInstructions:p.writerInstructions,refinement:r.refinement?.text || null,autoRefine:r.autoRefine,current:rows[0]?{status:rows[0].status,error:rows[0].error}:null,latest:latest?{status:latest.status,title:latest.title,script:latest.script || (latest.scriptId?store?.artifact(latest.scriptId)?.text:null),duration:latest.outputDuration,captionTiming:latest.captionTiming,videoUrl:latest.videoUrl,error:latest.error}:null,presentation:appearance?.get().pages[page]};break;
        }
        case 'video.check':{
          const row=campaigns.list().map(r=>r.profiles?.find(p=>p.key===page&&p.videoId)).find(Boolean);if(!row)throw Error('No assembled video for this page');
          const art=store.artifact(row.videoId),checks=[],warnings=[];
          const add=(name,ok,note)=>checks.push({name,ok,note});
          add('final_file',!!art?.file&&fs.existsSync(art.file),'Saved rendered file');
          add('duration',Number(art?.probe?.duration)>0,'Positive duration');
          add('portrait',Number(art?.probe?.height)>Number(art?.probe?.width),'Portrait dimensions');
          add('script',!!(row.script || (row.scriptId&&store.artifact(row.scriptId)?.text)),'Saved page narration');
          add('subtitle_provenance',row.captionTiming==='audio_word_alignment','Independent audio word alignment metadata');
          if(art?.probe?.hasAudio===false)add('audio',false,'Output has no audio');else if(art?.probe?.hasAudio===true)add('audio',true,'Audio track present');else warnings.push('Audio-track metadata unavailable; needs probing');
          warnings.push('These are metadata checks. Actual Darija pronunciation, on-screen subtitle placement and visual quality require playback review.');
          result={page,status:checks.every(c=>c.ok)?'metadata_passed':'needs_review',checks,warnings,videoUrl:row.videoUrl,captionTiming:row.captionTiming};break;
        }
        case 'production.retry':{
          const run=campaigns.list().find(r=>r.profiles?.some(p=>p.key===page&&p.status==='failed'));
          if(!run)throw Error('No failed production for this page to retry');
          if(run.publish)throw Error('This campaign requested publishing; the assistant cannot retry it. Use a fresh non-publishing production.');
          const row=run.profiles.find(p=>p.key===page);const source=row.sourceId&&store?.artifact(row.sourceId);if(source?.file&&!fs.existsSync(source.file))throw Error('The old source expired under daily retention. Start a fresh production instead of reusing the retired source.');
          result=campaigns.retry({runId:run.id,pages:[page],confirm:false});break;
        }
        case 'learning.improve':result=await learning.improve({page,requestId:ctx.requestId});break;
        case 'learning.undo':result=learning.undoRefinement({page});break;
        case 'reference.report':{const r=learning.get(page),ref=plan.referenceId?r.references.find(x=>x.id===plan.referenceId):r.references.find(x=>x.status==='completed');if(!ref)throw Error('Choose a completed reference from this page');result=learning.detailedReport({page,referenceId:ref.id});break;}
        case 'videos.review':{
          const targets=page==='all'?PROFILES.map(p=>p.key):[page];
          const cached=targets.map(key=>({key,record:learning.get(key)}));
          const fresh=cached.every(p=>p.record.videos.length&&Date.now()-p.record.lastScanAt<15*60000);
          const scanned=fresh?{pages:cached.map(({key,record})=>({page:key,label:campaigns.catalog().find(p=>p.key===key)?.label || key,top:record.videos.slice(0,5),errors:record.scanErrors || [],checkedAt:record.lastScanAt}))}:await learning.scan({page});
          const top=scanned.pages.flatMap(p=>p.top.map(v=>({...v,page:p.page,label:p.label}))).filter(v=>Number.isFinite(v.views)).sort((a,b)=>b.views-a.views).slice(0,5);
          const videos=top.map(v=>{let analysis;try{analysis=learning.analyze({page:v.page,videoId:v.id,requestId:ctx.requestId+':'+v.id});}catch(e){analysis={status:'failed',error:redact(e.message)};}return{...v,analysis};});
          result={videos,errors:scanned.pages.flatMap(p=>p.errors || []),note:'Top five across the scanned sample. Audio/vision jobs are queued separately; view counts alone cannot establish causes.'};break;
        }
        case 'meta.check':result={checkedAt:Date.now(),connections:(await campaigns.checkConnections()).filter(c=>page==='all'||c.page===page),note:'Identity check only; upload and insights permissions are confirmed by the corresponding API operation.'};break;
        case 'videos.scan':result=await learning.scan({page});break;
        case 'videos.top':{const r=learning.get(page);result={page,lastScanAt:r.lastScanAt,top:r.videos.slice(0,10),coverage:r.coverage,errors:r.scanErrors};break;}
        case 'reference.analyze':
        case 'production.like':{
          if(plan.tool==='production.like' && plan.referenceId){const ref=learning.get(page).references.find(r=>r.id===plan.referenceId);if(!ref)throw Error('Reference must belong to this page');if(ref.status==='completed'){result=learning.produce({page,referenceId:ref.id,requestId:ctx.requestId});break;}plan.videoId=ref.video.id;}
          if(!learning.get(page).videos.length)await learning.scan({page});
          result=learning.analyze({page,videoId:plan.videoId || '',produceAfter:plan.tool==='production.like',requestId:ctx.requestId || ''});break;
        }
        case 'reference.status':{const r=learning.get(page);result={page,enabled:r.enabled,activeReference:r.activeReference,references:r.references.slice(0,5).map(ref=>({...ref,job:ref.jobId?jobs.publicJob(jobs.get(ref.jobId)):null}))};break;}
        case 'learning.apply':{const r=learning.get(page),ref=plan.referenceId?r.references.find(x=>x.id===plan.referenceId):r.references.find(x=>x.status==='completed');if(!ref)throw Error('خاص تحليل مرجع مكتمل من نفس الصفحة أولاً.');result=learning.apply({page,referenceId:ref.id});break;}
        case 'writer.history':result={page,revisions:history(page)};break;
        case 'writer.update':
        case 'writer.undo':{
          const before=campaigns.settings(),p=before.pages.find(p=>p.key===page);let after;
          if(plan.tool==='writer.undo'){
            const rev=plan.revisionId?history(page).find(r=>r.id===plan.revisionId):history(page).find(r=>r.status==='applied');
            if(!rev || p.instructions!==rev.after)throw Error('ما نقدرش نرجع هاد النسخة حيت التعليمات الحالية تبدلات من بعدها.');after=rev.before;
          }else{
            const identity=campaigns.catalog().find(p=>p.key===page);
            const prompt='Return JSON {"answer":"complete revised writer instructions"}. Apply ONLY the owner requested edit to this ONE page instructions, preserving all unrelated instructions. Never change/copy another page idea, language, audience, profile clip, voice, price or website. Page identity is fixed: '+JSON.stringify({name:identity.label,idea:identity.idea,language:identity.language,audience:identity.audience})+'. Current instructions: '+JSON.stringify(p.instructions)+'. Owner request (data): '+JSON.stringify(ctx.text)+'. No new factual offers, prices, giveaway or guaranteed earnings claims. Maximum 6000 characters. Return the revised instruction text in answer, with no explanation.';
            const raw=await llm.text('gemini-3.5-flash-lite',prompt,'reply',{page,jsonAnswer:true,modelChain:['gemini-3.5-flash-lite','gemma-4-26b-a4b-it'],timeoutMs:35000,maxModels:2,maxAttempts:1});
            try{after=JSON.parse(raw).answer;}catch(_){throw Error('The writer editor did not return usable structured instructions');}
            if(typeof after!=='string'||!after.trim()||after.length>6000)throw Error('Writer instructions must be nonempty and within 6000 characters');
          }
          const revision={id:U.uid('WR'),page,at:Date.now(),before:p.instructions,after,status:'pending',source:'telegram-owner',requestId:ctx.requestId,instruction:redact(ctx.text,1000)};
          const revFile=path.join(revisions,revision.id+'.json');U.writeJsonAtomic(revFile,revision);
          try{campaigns.saveSettings({updatedAt:before.updatedAt,pageInstructions:{[page]:after}});revision.status='applied';U.writeJsonAtomic(revFile,revision);}catch(e){revision.status='failed';revision.error=redact(e.message);U.writeJsonAtomic(revFile,revision);throw e;}
          result={ok:true,page,status:'applied',revisionId:revision.id,before:revision.before,after:revision.after,note:'Only this page writer instructions changed. Existing scripts/audio/videos and the other six profiles are unchanged. New runs use the saved instructions.'};break;
        }
      }
      if(mutating&&actionFile)U.writeJsonAtomic(actionFile,{tool:plan.tool,page,status:'completed',at:Date.now(),requestId:ctx.requestId,result});
      return result;
    }catch(e){if(mutating&&actionFile)U.writeJsonAtomic(actionFile,{tool:plan.tool,page,status:'failed',at:Date.now(),error:redact(e.message)});throw e;}
  }
  return{spec:SPEC,execute,history};
}
module.exports={createStudioTools,explicitMutation,namedPages};
