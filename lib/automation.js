'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

function localParts(ts, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function instant(date, time, zone) {
  const wanted = Date.parse(date + 'T' + time + ':00Z'); let ts = wanted;
  for (let i = 0; i < 4; i++) { const p = localParts(ts, zone); const delta = wanted - Date.parse(p.date + 'T' + p.time + ':00Z'); if (!delta) return ts; ts += delta; }
  return null; // A nonexistent local time during a DST jump is skipped, never guessed.
}
function defaultSchedules(profiles) {
  return Object.fromEntries(profiles.map(p => [p.key, { enabled: true, slots: p.key === 'vouchteck' ? [{ time: '19:00', zone: 'Europe/London' }, { time: '19:00', zone: 'America/New_York' }] : ['13:00','20:00'].map(time => ({ time, zone: p.key === 'alshihna' ? 'Asia/Riyadh' : 'Africa/Casablanca' })) } ]));
}
function upcoming(schedules, now) {
  const result = [];
  for (const [page, c] of Object.entries(schedules)) if (c.enabled) c.slots.forEach((slot, index) => {
    const date = localParts(now, slot.zone).date;
    for (let d = -1; d <= 2; d++) {
      const day = new Date(Date.parse(date+'T12:00:00Z') + d*86400000).toISOString().slice(0,10);
      const dueAt = instant(day, slot.time, slot.zone);
      if (dueAt !== null && dueAt >= now - 86400000 && dueAt < now + 36*3600000) result.push({ id: `${page}:${day}:${index}`, batch: `${day}:${index}`, page, day, index, ...slot, dueAt });
    }
  });
  return result.sort((a,b) => a.dueAt-b.dueAt);
}
function createAutomation({ dir, jobs, store, campaigns, pipeline, telegram, publish, dailyReport, now = Date.now }) {
  const file = path.join(dir, 'automation-settings.json'), stateFile = path.join(dir, 'automation-state.json');
  const defaults = () => ({ enabled: false, schedules: defaultSchedules(campaigns.catalog()), activatedAt: now(), updatedAt: now() });
  function config() { const c=U.readJson(file, defaults()); c.activatedAt=c.activatedAt || c.updatedAt || now(); return c; }
  function save(input) {
    const c = config();
    if (input.enabled !== undefined) c.enabled = input.enabled === true;
    if (input.schedules) for (const [key, value] of Object.entries(input.schedules)) {
      if (!c.schedules[key] || !Array.isArray(value.slots) || value.slots.length !== 2) throw Error('Each known profile requires exactly two slots');
      for (const slot of value.slots) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) throw Error('Use a valid HH:MM time');
        try { new Intl.DateTimeFormat('en', { timeZone: slot.zone }).format(); } catch (_) { throw Error('Invalid IANA timezone'); }
      }
      if (value.slots[0].time === value.slots[1].time && value.slots[0].zone === value.slots[1].zone) throw Error('The two daily slots must differ');
      c.schedules[key] = { enabled: value.enabled !== false, slots: value.slots.map(s => ({ time: s.time, zone: s.zone })) };
    }
    c.updatedAt = now(); U.writeJsonAtomic(file,c); return status();
  }
  let busy = false, lastConnections = 0, runtimeError=null;
  const instance=U.uid('scheduler');
  const read = () => U.readJson(stateFile, { batches: {}, slots: {}, connections: [], updatedAt: 0 });
  function status() {
    const c = config(), state = read();
    return { ...c, workerEnabled: jobs.enabled, runtimeError, next: upcoming(c.schedules, now()).filter(s => s.dueAt >= now()).slice(0,28),
      state, timingNote: 'Editable trial slots, not verified audience peaks. Dispatch starts on the slot; Meta processing may finish later. Late slots expire after 30 minutes. No missed-day backfill.' };
  }
  async function tick() {
    if (busy || !jobs.enabled) return; busy = true;
    const lock = path.join(dir, 'automation.tick.lock'); let claim;
    try {
      try { claim = fs.openSync(lock, 'wx'); fs.writeFileSync(claim, JSON.stringify({pid:process.pid,instance})); }
      catch (_) {
        try {
          const raw=fs.readFileSync(lock,'utf8'), owner=JSON.parse(raw);
          const pid=typeof owner==='number'?owner:owner.pid;
          if(pid===process.pid && owner.instance!==instance) fs.unlinkSync(lock); // PID reuse after a single-worker/container restart.
          else process.kill(pid,0);
        } catch (e) { if(e.code==='ESRCH')fs.unlinkSync(lock); }
        return;
      }
      const c = config(); if (!c.enabled) return;
      const ts = now(), state = read();
      const previousTick=state.updatedAt || null;
      if(previousTick && ts-previousTick>5*60000)state.workerGaps=[...(state.workerGaps || []),{from:previousTick,to:ts,durationMs:ts-previousTick,note:'Scheduler did not record ticks; sleep, shutdown, suspension or a blocked worker are possible.'}].slice(-20);
      if (ts-lastConnections > 15*60000) { state.connections = await campaigns.checkConnections(); lastConnections = ts; }
      const activatedAt=c.activatedAt || c.updatedAt;
      state.slots=Object.fromEntries(Object.entries(state.slots).filter(([,s])=>s.dueAt>=activatedAt));
      const slots = upcoming(c.schedules,ts).filter(s => s.dueAt>=activatedAt && s.dueAt <= ts+18*3600000);
      for (const slot of slots) {
        let item = state.slots[slot.id];
        if (!item) {
          item = state.slots[slot.id] = { ...slot, status: slot.dueAt < ts ? 'missed' : 'waiting', createdAt: ts,...(slot.dueAt<ts?{error:'Scheduler first observed this slot after its due time; no automatic backfill',failureReason:'late_first_observation'}:{}) };
        }
        if(!item.jobId && !['published','partial'].includes(item.status) && item.dueAt!==slot.dueAt) Object.assign(item,slot,{status:slot.dueAt<ts?'missed':'waiting',error:null});
        if (['published','missed','failed','partial','unknown_upload'].includes(item.status)) continue;
        // Reconcile an already dispatched job before deadline/connection checks. A token
        // can expire after Facebook has accepted the video.
        const sent = item.jobId && jobs.get(item.jobId);
        if (sent?.result) {
          item.status=sent.result.status; item.deliveries=sent.result.deliveries; item.error=sent.result.error || null;
          if(item.status==='needs_connection') { item.status=item.deliveries?.some(d=>d.ok)?'partial':'failed';item.error=(item.deliveries || []).filter(d=>!d.ok).map(d=>d.error).join('; '); }
          continue;
        }
        if (sent?.status==='failed') { item.status='failed'; item.error='Publication job failed; inspect delivery results'; continue; }
        if (sent && ['queued','running'].includes(sent.status)) { item.status='publishing'; continue; }
        if (slot.dueAt < ts-30*60000) { const priorStatus=item.status;item.status = 'missed';const gap=previousTick && previousTick<slot.dueAt && ts>slot.dueAt+30*60000;item.failureReason=gap?'worker_tick_gap':priorStatus;item.error=gap?'No scheduler ticks recorded across the posting window; inspect worker availability/sleep':'Preparation or connection did not complete within the posting window';item.lastWorkerTickBeforeCheck=previousTick;continue; }
        const connected = state.connections.filter(x => x.page === slot.page);
        if (!connected.length || connected.some(x => !x.ok)) { item.status = 'blocked_credentials'; item.error = 'Renew Facebook access in Settings'; continue; }
        let batch = state.batches[slot.batch];
        if (!batch) { batch = state.batches[slot.batch] = { createdAt: ts }; U.writeJsonAtomic(stateFile,state); }
        if (!batch.project) {
          // Recover a project created just before a process restart.
          const existing = store.listProjects().map(p=>store.project(p.id)).find(p=>p.automationBatch===slot.batch);
          const project = existing || store.createProject(store.ORCHESTRATOR, 'Automatic unboxing '+slot.batch, { pipelineKey: 'automatic-'+slot.batch, automationBatch: slot.batch });
          batch.project = project.id; U.writeJsonAtomic(stateFile,state);
        }
        let job = batch.jobId && jobs.get(batch.jobId);
        if (!job) {
          job = jobs.list({ project: batch.project }).find(j=>j.type==='pipeline.run');
          if (job) { batch.jobId=job.id; batch.analysisId=job.params.analysisId; }
          else { Object.assign(batch,pipeline.startAutomatic({project:batch.project,pages:Object.keys(c.schedules).filter(k=>c.schedules[k].enabled)})); job=jobs.get(batch.jobId); }
          U.writeJsonAtomic(stateFile,state);
        }
        if (job?.result?.campaign?.runId) batch.runId=job.result.campaign.runId;
        if (!batch.runId && batch.analysisId) batch.runId=campaigns.list().find(r=>r.analysisId===batch.analysisId)?.id;
        if (!batch.runId) {
          if (job?.status==='failed' || (job?.status==='done' && job.result?.status!=='campaign_queued') || job?.result?.status==='no_match') {
            const attempts=jobs.list({project:batch.project}).filter(j=>j.type==='pipeline.run').length;
            if (attempts<3 && (!batch.retryAt || ts>=batch.retryAt)) { Object.assign(batch,pipeline.startAutomatic({project:batch.project,pages:Object.keys(c.schedules).filter(k=>c.schedules[k].enabled)})); batch.retryAt=ts+20*60000; }
            item.status='search_retry'; item.error='Source search/analysis not yet successful';
          } else item.status='preparing';
          continue;
        }
        const row=campaigns.inspect(batch.runId)?.profiles.find(p=>p.key===slot.page);
        item.runId=batch.runId; item.videoId=row?.videoId || null;
        if (row?.status==='failed' && (item.productionRetries || 0)<2 && ts>=(item.retryAt || 0)) {
          campaigns.retry({runId:batch.runId,pages:[slot.page],confirm:false});item.productionRetries=(item.productionRetries || 0)+1;item.retryAt=ts+30*60000;
        }
        if (!row?.videoId || !['ready','published','needs_connection'].includes(row.status)) { item.status='preparing'; item.error=row?.error || null; continue; }
        if (ts<slot.dueAt) { item.status='ready'; continue; }
        let delivery=item.jobId && jobs.get(item.jobId);
        if (!delivery) {
          delivery=jobs.list({project:batch.project}).find(j=>j.type==='campaign.publish' && j.params.slotId===slot.id);
          if (!delivery) delivery=jobs.enqueue({type:'campaign.publish',page:slot.page,project:batch.project,params:{runId:batch.runId,page:slot.page,slotId:slot.id,scheduledTime:slot.time,scheduledZone:slot.zone,expiresAt:slot.dueAt+30*60000}});
          item.jobId=delivery.id; item.dispatchedAt=ts;
        }
        if (delivery.status==='failed') { item.status='failed'; item.error='Publication job failed; inspect campaign delivery results'; }
        else if (delivery.result) { item.status=delivery.result.status; item.deliveries=delivery.result.deliveries; }
        else item.status='publishing';
      }
      state.updatedAt=ts;
      state.slots=Object.fromEntries(Object.entries(state.slots).filter(([,v])=>v.dueAt>ts-7*86400000));
      state.batches=Object.fromEntries(Object.entries(state.batches).filter(([,v])=>v.createdAt>ts-7*86400000));
      U.writeJsonAtomic(stateFile,state);
      state.notifiedStatuses=state.notifiedStatuses || {};
      const changes=Object.values(state.slots).filter(s=>['published','failed','partial','missed','unknown_upload','blocked_credentials'].includes(s.status) && state.notifiedStatuses[s.id]!==s.status);
      if(changes.length){
        const text=changes.map(item=>`${item.page} · ${item.day} ${item.time} ${item.zone}\nStatus: ${item.status}${item.error?' · '+item.error:''}\n${(item.deliveries || []).filter(d=>d.ok).map(d=>d.destination.name+' https://www.facebook.com/'+d.postId).join('\n')}`).join('\n\n');
        const result=await telegram.notify('slots:'+U.hash16(changes.map(s=>s.id+':'+s.status).join('|')),text);
        if(!result.skipped){for(const item of changes)state.notifiedStatuses[item.id]=item.status;U.writeJsonAtomic(stateFile,state);}
      }
      const local=localParts(ts,'Africa/Casablanca');
      if(local.time>='23:00' && telegram.settings().enabled && state.dailyReport!==local.date) {
        const result=await telegram.notify('daily:'+local.date,await (dailyReport?dailyReport():report()));
        if(!result.skipped) {state.dailyReport=local.date;U.writeJsonAtomic(stateFile,state);}
      }
    } finally { if(claim!==undefined) { fs.closeSync(claim); fs.unlinkSync(lock); } busy=false; }
  }
  async function report() {
    const cutoff=now()-86400000;
    const lines=['VideoStudio · last 24 hours'];
    for (const p of campaigns.catalog()) {
      const posts=store.listProjects(p.key).flatMap(x=>store.project(x.id)?.posts || []).filter(x=>x.published_at>=cutoff);
      const unique=[...new Map(posts.map(x=>[x.post_id,x])).values()];
      lines.push(`${p.label}: ${unique.length} Facebook uploads`);
      for (const post of unique.slice(-4)) {
        const m=await publish.metrics(p.key,post.page_id,post.post_id);
        lines.push(`  ${post.page}: likes ${m.likes ?? 'unavailable'}, comments ${m.comments ?? 'unavailable'}, shares ${m.shares ?? 'unavailable'}, views ${m.views ?? 'unavailable'}`);
      }
    }
    const slots=Object.values(read().slots).filter(s=>s.dueAt>=cutoff&&s.dueAt<=now());
    lines.push(`Schedule: ${slots.filter(s=>s.status==='published').length} complete, ${slots.filter(s=>['failed','partial','unknown_upload'].includes(s.status)).length} failed/partial/uncertain, ${slots.filter(s=>s.status==='missed').length} missed, ${slots.filter(s=>s.status==='blocked_credentials').length} blocked.`);
    return lines.join('\n').slice(0,4000);
  }
  if (!fs.existsSync(file)) U.writeJsonAtomic(file,defaults());
  const timer=jobs.enabled ? setInterval(()=>tick().then(()=>{runtimeError=null;}).catch(e=>{runtimeError=String(e.message).slice(0,200);}),15000) : null;
  timer?.unref();
  return { status, save, tick, report, refreshConnections:()=>{lastConnections=0;}, close:()=>timer&&clearInterval(timer) };
}
module.exports={ createAutomation, localParts, instant, upcoming, defaultSchedules };
