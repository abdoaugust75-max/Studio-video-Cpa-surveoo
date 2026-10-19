'use strict';
// No credentials are persisted here: IDs are one-way fingerprints. Unknown project
// ownership is treated as ONE shared quota scope, never N keys worth of allowance.
const crypto=require('crypto');
function createKeyPoolHealth({settings,save,keys,now=Date.now}){
  settings.keyHealth ||= {}; settings.requestUsage ||= {}; settings.keyTrackingSince ||= now();
  const idFor=key=>'pool_'+crypto.createHash('sha256').update(key).digest('hex').slice(0,16);
  const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));
  function state(id){const s=settings.keyHealth[id] ||= {attempts:0,ok:0,fail:0};if(s.day!==day()){s.day=day();s.today=0;s.tokensToday=0;}return s;}
  function budget(model){let b=settings.requestUsage[model];if(!b||b.day!==day())b=settings.requestUsage[model]={day:day(),attempts:0,ok:0,fail:0,tokens:0,minute:[]};b.minute=b.minute.filter(t=>now()-t<60000);return b;}
  function candidates(){return [...new Set(keys().filter(Boolean))].map((key,index)=>({key,id:idFor(key),index}));}
  function pick(model){
    const m=settings.models.find(m=>m.id===model),b=model&&budget(model),u=settings.usage[model];
    if(model&&((u?.cooldownUntil||0)>now()||(m?.limits?.rpm&&b.minute.length>=m.limits.rpm)||(m?.limits?.rpd&&b.attempts>=m.limits.rpd)))return null;
    const eligible=candidates().filter(c=>{const s=state(c.id);return !s.quarantined&&!(s.cooldownUntil>now());}).sort((a,b)=>state(a.id).attempts-state(b.id).attempts||(state(a.id).lastAttempt||0)-(state(b.id).lastAttempt||0));
    if(!eligible.length)return null;
    const c=eligible[0],s=state(c.id);s.attempts++;s.today++;s.lastAttempt=now();s.lastModel=model||null;
    if(b){b.attempts++;b.minute.push(now());}save();
    return {key:c.key,credential:c.id,source:'pool',index:c.index};
  }
  function record(id,info){
    const s=state(id),model=info.model||s.lastModel,b=model&&budget(model);s.checkedAt=now();s.lastStatus=info.status;
    if(info.status==='ok'){s.ok++;s.lastError=null;if(b)b.ok++;}
    else{s.fail++;s.lastError=String(info.error||'').replace(/AIza[\w-]+/g,'[REDACTED]').replace(/(api[_-]?key[\s:=]+)\S+/gi,'$1[REDACTED]').slice(0,220);if(b)b.fail++;
      if(/suspended|API key not valid|API_KEY_INVALID|key.*(?:disabled|revoked|expired)/i.test(info.error||''))s.quarantined=true;
      if(info.rateLimited){s.cooldownUntil=now()+(info.retryAfterMs||60000);if(model){settings.usage[model] ||= {};settings.usage[model].cooldownUntil=s.cooldownUntil;}}
    }
    const tokens=Number(info.tokens)||0;s.tokensToday+=tokens;if(b)b.tokens+=tokens;save();return s;
  }
  function probe(key,result){const s=state(idFor(key));s.authCheckedAt=now();s.authOk=!!result.ok;s.authStatus=result.status;if(/SUSPENDED|INVALID/.test(result.status||''))s.quarantined=true;save();}
  function inspect(){const list=candidates().map(c=>{const s=state(c.id);return{id:c.id,label:'API '+(c.index+1),health:s.quarantined?'quarantined':s.cooldownUntil>now()?'cooling_down':s.lastStatus==='ok'?'ready':s.authOk?'authentication_verified':'unverified',attemptsToday:s.today,successes:s.ok,failures:s.fail,tokensToday:s.tokensToday,lastModel:s.lastModel,lastError:s.lastError,checkedAt:s.checkedAt,authCheckedAt:s.authCheckedAt};});return{total:list.length,ready:list.filter(x=>x.health==='ready').length,quarantined:list.filter(x=>x.health==='quarantined').length,keys:list,models:Object.entries(settings.requestUsage).map(([model])=>{const b=budget(model),limits=settings.models.find(m=>m.id===model)?.limits||{};return{model,requests:b.attempts,successes:b.ok,failures:b.fail,tokens:b.tokens,configuredRpd:limits.rpd||null,remainingEstimate:limits.rpd?Math.max(0,limits.rpd-b.attempts):null};}),estimated:true,trackingSince:settings.keyTrackingSince ||= now(),quotaScope:'Unknown keys share one conservative model budget. Google quotas are per project, not per key. Counts cover this studio since tracking began; external usage and actual provider balance are unknown.',resetZone:'America/Los_Angeles'};}
  return {pick,record,probe,inspect,idFor};
}
module.exports={createKeyPoolHealth};
