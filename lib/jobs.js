// lib/jobs.js — persistent job queue. Every long operation is a job record on disk.
// Survives restarts: anything left queued/running is re-queued on boot.
'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const U = require('./util');

function createJobs(opts) {
  const DIR = U.ensureDir(opts.dir);
  const log = opts.log || (() => {});
  const concurrency = Math.max(1, opts.concurrency || 1);
  // enabled:false is the WEB half of the runtime. It still records, reads and resolves jobs (the UI
  // needs their state), it just never runs one — heavy work belongs to the worker process, so an
  // HTTP request can never sit behind a render.
  const enabled = opts.enabled !== false;
  const runners = new Map();          // type -> async (job, ctx)
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  let active = 0;
  let ticking = false;
  const claimedByOthers = new Set();   // ids another runner holds, so this loop stops retrying them

  const file = id => path.join(DIR, String(id).replace(/[^A-Za-z0-9_]/g, '') + '.json');
  const lockFile = id => path.join(DIR, String(id).replace(/[^A-Za-z0-9_]/g, '') + '.run');
  const read = id => U.readJson(file(id), null);

  // --------------------------------------------------------------------------------------------
  // Claiming. One job must never be executed by two runners — a second worker that starts while
  // the first is mid-render would otherwise transcode the same clip twice and append two artifacts.
  // The claim is a file created with O_EXCL (atomic on every platform that matters), refreshed as a
  // heartbeat while the job runs. A claim whose heartbeat has gone stale is stealable, which is how
  // a worker that was killed mid-job stops blocking its own work.
  // --------------------------------------------------------------------------------------------
  const STALE_MS = Math.max(60000, Number(opts.staleMs) || 300000);
  const HEARTBEAT_MS = 15000;
  /**
   * pidAlive — is that process still there?
   * mtime alone cannot tell a worker that is quietly rendering from one that was killed, and the
   * difference is a job that waits five minutes for nothing versus one that restarts immediately.
   * signal 0 is a pure existence check; it delivers nothing. EPERM means it exists but is not ours.
   */
  function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(Number(pid), 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }
  function claimOwner(id) {
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile(id), 'utf8'));
      const age = Date.now() - fs.statSync(lockFile(id)).mtimeMs;
      return { owner, age, live: age < STALE_MS && pidAlive(owner && owner.pid) };
    } catch (_) { return null; }
  }
  function claim(id) {
    const lf = lockFile(id);
    try {
      fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const held = claimOwner(id);
      // Held by a live process (including this one's other slot): leave it alone.
      if (held && held.live) return false;
      if (!held) return true;   // the claim file vanished between the write and the stat
      try { fs.unlinkSync(lf); } catch (_) {}
      try { fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, at: Date.now(), stolenFromStale: true }), { flag: 'wx' }); return true; }
      catch (_) { return false; }
    }
  }
  function release(id) { try { fs.unlinkSync(lockFile(id)); } catch (_) {} }
  function touch(id) { try { const now = Date.now(); fs.utimesSync(lockFile(id), now / 1000, now / 1000); } catch (_) {} }
  /** Clear claims left behind by this process's own earlier life, so a restart never waits 5 minutes. */
  function clearStaleClaims() {
    let cleared = 0;
    try {
      for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.run'))) {
        const full = path.join(DIR, f);
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) {}
        const mine = owner && owner.pid === process.pid;
        const stale = (() => { try { return Date.now() - fs.statSync(full).mtimeMs > STALE_MS; } catch (_) { return true; } })();
        if (mine || stale) { try { fs.unlinkSync(full); cleared++; } catch (_) {} }
      }
    } catch (_) {}
    return cleared;
  }
  function write(job) { U.writeJsonAtomic(file(job.id), job); return job; }
  function emit(type, job, extra) {
    const payload = { type, ts: Date.now(), job: publicJob(job), ...(extra || {}) };
    U.appendJsonl(path.join(DIR, '..', 'logs', 'activity.jsonl'), payload);
    bus.emit('event', payload);
    return payload;
  }
  function publicJob(j) {
    if (!j) return null;
    return {
      id: j.id, type: j.type, page: j.page, project: j.project, status: j.status, stage: j.stage,
      pct: j.pct, result: j.result, error: j.error, ts: j.ts, started: j.started, ended: j.ended,
      pausedAt: j.pausedAt || null, waiting: j.status === 'waiting_approval',
      cursor: (j.params || {}).cursor != null ? j.params.cursor : null,
      total: (j.params || {}).ops ? (j.params || {}).ops.length : null,
      log: (j.log || []).slice(-12),
    };
  }
  function list(filter) {
    filter = filter || {};
    // The queue directory can vanish underneath a running process (a volume unmounted, a container
    // started before its mount, a test cleaning up). An unreadable queue must read as EMPTY, never
    // as an exception inside the tick loop — that would stop every future job from running.
    let files = [];
    try { files = fs.readdirSync(DIR); } catch (_) { return []; }
    return files.filter(f => f.endsWith('.json')).map(f => U.readJson(path.join(DIR, f), null)).filter(Boolean)
      .filter(j => (!filter.page || j.page === filter.page) && (!filter.project || j.project === filter.project))
      .sort((a, b) => b.ts - a.ts).slice(0, filter.all===true?undefined:60);
  }

  function register(type, fn) { runners.set(type, fn); }

  function enqueue(spec) {
    const job = {
      id: U.uid('J'), type: spec.type, page: spec.page || '', project: spec.project || '',
      params: spec.params || {}, status: 'queued', stage: 'queued', pct: 0, log: [],
      result: null, error: null, ts: Date.now(), started: null, ended: null,
    };
    write(job);
    log('info', 'job.queued', { job: job.id, type: job.type, project: job.project });
    emit('job.queued', job);
    if (enabled) setImmediate(tick);
    return job;
  }

  function cancel(id) {
    const j = read(id);
    if (!j) throw new Error('unknown job');
    if (j.status === 'queued' || j.status === 'running') {
      j.status = 'cancelled'; j.ended = Date.now(); write(j);
      release(j.id);            // a cancelled job must not keep its claim on the queue
      emit('job.cancelled', j);
    }
    return j;
  }

  /**
   * pause — a runner that needs human approval returns { __pause: {...} }. The job record keeps its
   * params (including a cursor), so resuming re-enters the runner at the right step instead of
   * replaying finished work. Nothing about the pause lives only in memory.
   */
  function pause(job, patch) {
    job.status = 'waiting_approval';
    job.stage = (patch && patch.stage) || 'waiting for approval';
    job.pct = patch && patch.pct != null ? U.clamp(patch.pct, 0, 100, job.pct) : job.pct;
    if (patch && patch.params) job.params = { ...job.params, ...patch.params };
    job.pausedAt = Date.now();
    write(job);
    emit('approval.needed', job, { stage: job.stage, cursor: (job.params || {}).cursor || 0 });
    return job;
  }

  /** resume(id, patch) — put a paused job back in the queue (optionally advancing its cursor). */
  function resumeJob(id, patch) {
    const j = read(id);
    if (!j) throw new Error('unknown job');
    if (j.status !== 'waiting_approval') throw new Error('job is not waiting for approval (status: ' + j.status + ')');
    if (patch && patch.params) j.params = { ...j.params, ...patch.params };
    j.status = 'queued'; j.stage = 'resuming'; j.pausedAt = null;
    write(j);
    emit('job.resumed', j);
    setImmediate(tick);
    return j;
  }

  /**
   * finish(id, result) — complete a PAUSED job whose remaining work is nothing (its step already
   * ran and was just approved). Cancelling it would be a lie: the work succeeded, so the job must
   * end as `done` with its real result attached.
   */
  function finish(id, result) {
    const j = read(id);
    if (!j) throw new Error('unknown job');
    if (j.status !== 'waiting_approval') throw new Error('job is not waiting for approval (status: ' + j.status + ')');
    j.status = 'done'; j.stage = 'done'; j.pct = 100;
    if (result !== undefined) j.result = result;
    j.ended = Date.now();
    write(j);
    emit('job.done', j, { result: j.result });
    return j;
  }

  async function runOne(job) {
    const fn = runners.get(job.type);
    const beat = setInterval(() => touch(job.id), HEARTBEAT_MS);
    if (beat.unref) beat.unref();
    job.status = 'running'; job.started = Date.now(); job.stage = 'starting';
    write(job);
    emit('job.start', job);
    const ctx = {
      progress(stage, pct) {
        if ((read(job.id) || {}).status === 'cancelled') return;
        job.stage = U.sanitizeText(stage, 80);
        job.pct = U.clamp(pct, 0, 100, job.pct);
        write(job);
        emit('job.stage', job, { stage: job.stage, pct: job.pct });
      },
      note(msg) {
        if ((read(job.id) || {}).status === 'cancelled') return;
        job.log = [...(job.log || []), { ts: Date.now(), msg: U.sanitizeText(msg, 300) }].slice(-60);
        write(job);
      },
      get job() { return job; },
    };
    try {
      if (!fn) throw new Error('no runner registered for job type: ' + job.type);
      const result = await fn(job, ctx);
      // A cancel request may arrive while the runner is inside ffmpeg/LLM work. The runner must
      // never resurrect that job as done/running when the awaited operation finally returns.
      const latest = read(job.id);
      if ((latest && latest.status === 'cancelled') || job.status === 'cancelled') {
        job.status = 'cancelled'; job.stage = 'cancelled'; job.ended = job.ended || Date.now();
        write(job);
        return;
      }
      if (result && result.__pause) { pause(job, result.__pause); clearInterval(beat); release(job.id); return; }
      job.status = 'done'; job.stage = 'done'; job.pct = 100; job.result = result == null ? null : result;
      job.ended = Date.now(); write(job);
      log('info', 'job.done', { job: job.id, type: job.type });
      emit('job.done', job, { result: job.result });
    } catch (e) {
      if ((read(job.id) || {}).status === 'cancelled') {
        job.status = 'cancelled'; job.stage = 'cancelled'; job.ended = job.ended || Date.now();
        write(job);
        return;
      }
      job.status = 'failed'; job.stage = 'failed'; job.error = U.sanitizeText(e.message, 400);
      job.ended = Date.now(); write(job);
      log('error', 'job.failed', { job: job.id, type: job.type, error: job.error });
      emit('job.failed', job, { error: job.error });
    } finally {
      // A paused job keeps its claim released: it is waiting for a human, not running.
      clearInterval(beat);
      if (job.status !== 'waiting_approval') release(job.id);
    }
  }

  async function tick() {
    if (!enabled || ticking) return;
    ticking = true;
    try {
      while (active < concurrency) {
        let next = null;
        try {
          // Skip anything another runner holds (and does not appear to have died holding).
          const priorities={ 'campaign.publish':100, 'campaign.page':40, 'campaign.social':40, 'learning.analyze':20, 'pipeline.run':10 };
          next = list({all:true}).filter(j => j.status === 'queued').sort((a, b) => (priorities[b.type] || 0) - (priorities[a.type] || 0) || a.ts - b.ts)
            .find(j => !claimedByOthers.has(j.id) && claim(j.id));
          if (!next) {
            const blocked = list({all:true}).filter(j => j.status === 'queued');
            if (blocked.length) {
              // Everything queued belongs to another runner right now; remember it briefly so this
              // loop does not spin on the same lock a thousand times a second.
              for (const b of blocked) claimedByOthers.add(b.id);
              const retry = setTimeout(() => { for (const b of blocked) claimedByOthers.delete(b.id); }, 30000);
              if (retry.unref) retry.unref();
            }
          }
        }
        catch (e) { log('error', 'queue.unreadable', { error: e.message }); break; }
        if (!next) break;
        active++;
        runOne(next).catch(() => {}).finally(() => { active--; setImmediate(tick); });
        await new Promise(r => setTimeout(r, 25));
      }
    } finally {
      ticking = false;
      // Whatever went wrong above, the queue must keep trying. A tick loop that dies on one bad
      // record (or a missing directory) silently stops running every later job, which looks like
      // "the studio stopped working" with no error anywhere. enqueue() still triggers an immediate
      // tick, so this is a safety net rather than the main driver.
      const t = setTimeout(() => { tick().catch(() => {}); }, 2000);
      if (t.unref) t.unref();
    }
  }

  /** resume — called on boot: a job that was running when the process died goes back to queued. */
  function resume() {
    let n = 0;
    if (!enabled) return 0;   // the web role must not "recover" work it is not allowed to run
    clearStaleClaims();
    try {
      for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
        const j = U.readJson(path.join(DIR, f), null);
        if (!j) continue;
        if (j.status !== 'running') continue;
        // A job that says "running" was either orphaned by a dead process, or is genuinely being
        // run by ANOTHER live worker on the same queue. Only the first is ours to recover —
        // requeueing a job somebody else is running right now is how one clip gets transcoded twice.
        const held = claimOwner(j.id);
        if (held && held.live && held.owner && held.owner.pid !== process.pid) continue;   // another live worker is on it
        j.status = 'queued'; j.stage = 'requeued after restart';
        write(j);
        release(j.id);          // the claim of a process that is gone must not block its own retry
        n++;
      }
    } catch (_) {}
    if (n) log('info', 'jobs.resumed', { count: n });
    setImmediate(tick);
    return n;
  }

  return { register, enqueue, cancel, list, get: read, publicJob, resume, resumeJob, pause, finish, tick, enabled, on: (fn) => bus.on('event', fn), bus };
}

module.exports = { createJobs };
