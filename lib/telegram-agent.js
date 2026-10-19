'use strict';
const fs=require('fs'),path=require('path');
const U=require('./util');
function redact(text,max=5000){return String(text || '').replace(/AIza[A-Za-z0-9_-]{25,}|EAA[A-Za-z0-9]{60,}|\d{5,16}:[A-Za-z0-9_-]{20,100}|gh[pousr]_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9_-]{20,}/g,'[private credential removed]').slice(0,max);}
function createTelegramAgent({dir,enabled,telegram,snapshot,answer,report,capabilities=()=>[],now=Date.now}){
  const configFile=path.join(dir,'telegram-private.json'),stateFile=path.join(dir,'telegram-agent-state.json');
  const memoryFile=path.join(dir,'telegram-memory.json');
  const memory=()=>U.readJson(memoryFile,{version:1,preferences:{language:'Moroccan Darija',script:'Arabic',tone:'natural, clear, organised; no robotic status dumps'},projectRules:['Keep all seven page ideas, languages, names, voices and cards unchanged.','Publication remains held until the owner explicitly requests enabling it.'],recentTasks:[]});
  if(!fs.existsSync(memoryFile))U.writeJsonAtomic(memoryFile,memory());
  const inbox=U.ensureDir(path.join(dir,'telegram-inbox')),historyFile=path.join(dir,'telegram-conversation.json');
  const config=()=>U.readJson(configFile,{}),state=()=>U.readJson(stateFile,{offset:0,lastPollAt:null,lastReplyAt:null,error:null});
  const instance=U.uid('TA');let busy=false,closed=false;
  const records=()=>fs.readdirSync(inbox).filter(f=>/^\d+\.json$/.test(f)).map(f=>U.readJson(path.join(inbox,f),null)).filter(Boolean).sort((a,b)=>a.updateId-b.updateId);
  const archiveFile=path.join(dir,'telegram-archive.jsonl');
  if(!fs.existsSync(archiveFile)){fs.writeFileSync(archiveFile,'');for(const r of records().filter(r=>r.status==='replied'))U.appendJsonl(archiveFile,{at:r.repliedAt || r.at,user:redact(r.text),assistant:redact(r.reply)});}
  const saveRecord=r=>U.writeJsonAtomic(path.join(inbox,r.updateId+'.json'),r);
  function status(){const c=config(),s=state();return{enabled:c.agentEnabled!==false,workerEnabled:!!enabled,ready:!!(c.token&&c.chatId&&c.verifiedAt),
    status:!c.token?'not_configured':!c.chatId?'chat_required':!c.verifiedAt?'verification_required':c.agentEnabled===false?'paused':s.error?'error':s.lastPollAt?'listening':'starting',
    botUsername:c.bot?.username || null,lastPollAt:s.lastPollAt,lastReplyAt:s.lastReplyAt,lastTypingAt:s.lastTypingAt || null,typingError:s.typingError || null,error:s.error,capabilities:capabilities().map(t=>t.name),engine:U.readJson(path.join(dir,'agent-runtime.json'),{}).engine || 'legacy',
    messages:records().slice(-10).map(r=>({at:r.at,status:r.status,text:r.text,reply:r.reply || null,error:r.error || null}))};}
  async function preview(text,context={}){
    const onToolResult=(plan,result)=>{
      if(!context.authorized)return;
      const m=memory();m.recentTasks=[...(m.recentTasks || []),{at:now(),request:redact(text,500),tool:plan.tool,page:plan.page,status:result.ok===false?'failed':result.status || 'tool_completed',error:result.ok===false?redact(result.error,200):null}].slice(-50);U.writeJsonAtomic(memoryFile,m);
    };
    return answer({text:redact(text),history:U.readJson(historyFile,[]).slice(-8),snapshot:await snapshot(),context:{...context,memory:memory(),onToolResult}});
  }
  async function drain(){
    const c=config();
    for(const r of records().filter(r=>r.status==='pending').slice(0,3)){
      if(String(r.chatId)!==String(c.chatId)||r.identity!==U.hash16(c.token+'|'+c.chatId)||c.agentEnabled===false){r.status='cancelled';saveRecord(r);continue;}
      r.status='thinking';saveRecord(r);
      let typingBusy=false;
      const showTyping=async()=>{
        const latest=config();
        if(typingBusy||closed||latest.token!==c.token||String(latest.chatId)!==String(r.chatId)||latest.agentEnabled===false)return;
        typingBusy=true;
        try{await telegram.api('sendChatAction',{chat_id:r.chatId,action:'typing'},c.token);const s=state();s.lastTypingAt=now();s.typingError=null;U.writeJsonAtomic(stateFile,s);}catch(e){const s=state();s.typingError=redact(e.message,250);U.writeJsonAtomic(stateFile,s);}finally{typingBusy=false;}
      };
      await showTyping();
      const typingTimer=setInterval(()=>showTyping(),4000);typingTimer.unref?.();
      const workingTimer=setTimeout(()=>{telegram.send('كنخدم على طلبك دابا، كنستعمل أدوات الستوديو باش نجيب النتائج الفعلية…').catch(()=>{});},12000);workingTimer.unref?.();
      let reply;
      try{
        if(/^\/start(?:@\w+)?(?:\s|$)/i.test(r.text))reply='مرحبا! أنا مساعد VideoStudio. كنقرا الحالة الحالية ديال الصفحات، البحث، السكريبتات، الصوت، الفيديوهات، مواعيد النشر والأخطاء. سولني عادي بالدارجة.\n/report تقرير مباشر\n/status ملخص الحالة\n/help المساعدة\nنقدر نفحص Meta مباشرة، نرتب فيديوهاتك القديمة بالمشاهدات، ونحلل الصوت والصورة. إلى طلبتي تعديل تعليمات صفحة بالاسم نقدر نبدل غير تعليماتها مع سجل الرجوع. الأفكار واللغات السبعة محفوظين، والنشر الزائد ما كنديروش من المحادثة.';
        else if(/^\/(report|status)(?:@\w+)?(?:\s|$)/i.test(r.text))reply=await report();
        else if(/^\/memory(?:@\w+)?(?:\s|$)/i.test(r.text)){const m=memory();reply='اللي محفوظ عندي دابا:\n• نهضر معاك بالدارجة بالحروف العربية وبكلام واضح ومنظم.\n• الأفكار واللغات السبعة يبقاو محفوظين.\n• نرجع للحالة الحية قبل ما نقول شي مهمة سالات.\n• '+(m.recentTasks?.length || 0)+' طلبات أدوات محفوظة فذاكرة المهام.\nوزدت أرشيف المحادثات اللي باقين محفوظين واللي غادي يجيو. إلا شي محادثة قديمة تمسحات قبل الأرشيف، ما نقدرش نسترجعها.';}
        else if(/^\/tools(?:@\w+)?(?:\s|$)/i.test(r.text))reply='الصلاحيات المتاحة دابا:\n• فحص Meta والمشاهدات والفيديوهات القديمة.\n• مراقبة الطابور والأخطاء ومواعيد النشر.\n• قراءة فكرة كل صفحة، السكريبت والصوت والفيديو النهائي.\n• فحص metadata ديال الفيديو وsubtitles.\n• تحليل الصوت والصورة وتعلّم تحسينات مستقلة لكل فكرة.\n• تعديل تعليمات الصفحة بأمرك والرجوع للنسخة السابقة.\n• إطلاق إنتاج جديد أو إعادة الإنتاج الفاشل بلا نشر.\nالنشر الزائد، حذف الملفات، تغيير الكود، إظهار التوكنات وتغيير هوية الصفحات ماشي من أدواتي.';
        else if(/^\/help(?:@\w+)?(?:\s|$)/i.test(r.text))reply='هضر معايا عادي: «شنو واقع فالستوديو؟»، «علاش ما تنشر والو؟»، «شنو سكريبت Maghrebly؟»، «شحال من فيديو واجد؟»، «فحص توكنات Meta دابا»، «حلل أحسن فيديو فـMaghrebTech»، «بدل تعليمات Maghrebly وخلي البداية سؤال قصير»، «رجع آخر تعديل ديال Maghrebly». /report كيعطيك تقرير مباشر. ما تصيفطش التوكنات ولا كلمات السر فالمحادثة.';
        else reply=await preview(r.text,{authorized:true,channel:'telegram',requestId:r.identity+':'+r.updateId});
        reply=redact(reply).slice(0,3900);
        if(!reply.trim())throw Error('The AI returned an empty answer');
      }catch(_){reply='ما قدرتش نولد جواب AI دابا. '+await report().catch(()=> 'التقرير حتى هو ما توفرش؛ شوف حالة الربط فالداشبورد.');}
      finally{clearInterval(typingTimer);clearTimeout(workingTimer);}
      // Persist before sending: a process restart never repeats an uncertain reply.
      r.status='sending';r.reply=reply;saveRecord(r);
      try{
        const latest=config();if(latest.token!==c.token||String(latest.chatId)!==String(r.chatId)||latest.agentEnabled===false){r.status='cancelled';saveRecord(r);continue;}
        const sent=await telegram.send(reply);r.status='replied';r.messageId=sent.message_id;r.repliedAt=now();
        const h=U.readJson(historyFile,[]);h.push({role:'user',text:r.text},{role:'assistant',text:reply});U.writeJsonAtomic(historyFile,h.slice(-16));
        U.appendJsonl(path.join(dir,'telegram-archive.jsonl'),{at:now(),user:redact(r.text),assistant:redact(reply)});
        const s=state();s.lastReplyAt=now();s.error=null;U.writeJsonAtomic(stateFile,s);
      }catch(e){r.status=e.definite?'failed':'unknown';r.error=redact(e.message);}
      saveRecord(r);
    }
  }
  async function poll(){
    if(busy||closed||!enabled)return;const c=config();if(!c.token||!c.chatId||!c.verifiedAt||c.agentEnabled===false)return;
    busy=true;let claim;const lock=path.join(dir,'telegram-agent.lock');
    try{
      try{claim=fs.openSync(lock,'wx');fs.writeFileSync(claim,JSON.stringify({pid:process.pid,instance}));}
      catch(_){try{const owner=JSON.parse(fs.readFileSync(lock,'utf8'));if(owner.pid===process.pid&&owner.instance!==instance)fs.unlinkSync(lock);else process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')fs.unlinkSync(lock);}return;}
      let s=state();const identity=U.hash16(c.token+'|'+c.chatId);
      if(s.identity!==identity){s={identity,offset:0,lastPollAt:null,lastReplyAt:null,error:null};U.writeJsonAtomic(stateFile,s);U.writeJsonAtomic(historyFile,[]);}
      const updates=await telegram.api('getUpdates',{offset:s.offset,limit:50,timeout:0,allowed_updates:['message']},c.token);
      for(const update of updates.sort((a,b)=>a.update_id-b.update_id)){
        if(!Number.isSafeInteger(update.update_id)||update.update_id<s.offset)continue;
        const message=update.message;
        if(message?.chat?.type==='private' && String(message.chat.id)===String(c.chatId) && !message.from?.is_bot && typeof message.text==='string'){
          const at=message.date*1000;
          if(at>=now()-5*60000 && !fs.existsSync(path.join(inbox,update.update_id+'.json'))){
            const recent=records().filter(r=>r.at>now()-60000).length;
            saveRecord({updateId:update.update_id,identity,chatId:String(c.chatId),at,text:redact(message.text),status:recent<6?'pending':'rate_limited'});
          }
        }
        s.offset=update.update_id+1;U.writeJsonAtomic(stateFile,s);
      }
      s.lastPollAt=now();s.error=null;U.writeJsonAtomic(stateFile,s);
      // Recover interrupted generation, but never replay a send whose acceptance is unknown.
      for(const r of records())if(r.status==='thinking'){r.status='pending';saveRecord(r);}else if(r.status==='sending'){r.status='unknown';r.error='Delivery interrupted; automatic resend disabled';saveRecord(r);}
      await drain();
      for(const old of records().slice(0,-200))fs.unlinkSync(path.join(inbox,old.updateId+'.json'));
    }catch(e){const s=state();s.error=redact(e.message);s.lastErrorAt=now();U.writeJsonAtomic(stateFile,s);}
    finally{if(claim!==undefined){fs.closeSync(claim);fs.unlinkSync(lock);}busy=false;}
  }
  const timer=enabled?setInterval(()=>poll().catch(()=>{}),3000):null;timer?.unref();
  return{status,poll,preview,close:()=>{closed=true;if(timer)clearInterval(timer);}};
}
module.exports={createTelegramAgent,redact};
