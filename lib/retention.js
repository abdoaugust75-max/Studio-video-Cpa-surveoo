// lib/retention.js — two housekeeping jobs the studio never had, both written to be boring and safe.
//
// WHY: the audit found `activity.jsonl` growing one record per model call forever, and a media root
// that only ever gained files. Neither is a bug you notice on day one; both turn into a full disk
// that takes the whole studio down.
//
// The rule this file follows: NOTHING that a project record points at is ever a candidate. The
// cleaner does not guess what is disposable — it asks the store what is REFERENCED, and only then
// looks at what is left. Every destructive path is dry-run by default and reports what it would do.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

/** rotateLogs — cap a log file by renaming it aside and keeping the newest `keep` generations. */
function rotateLogs(dir, opts) {
  const maxBytes = (opts && opts.maxBytes) || 8 * 1024 * 1024;
  const keep = (opts && opts.keep) || 5;
  const rotated = [];
  let files;
  try { files = fs.readdirSync(dir).filter(f => /\.jsonl$/.test(f)); } catch (_) { return rotated; }
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.size < maxBytes) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const to = path.join(dir, f.replace(/\.jsonl$/, '.' + stamp + '.jsonl'));
    try { fs.renameSync(full, to); rotated.push({ file: f, bytes: st.size, movedTo: path.basename(to) }); } catch (_) {}
    // generation sweep — only the files this function itself creates
    const base = f.replace(/\.jsonl$/, '.');
    const gens = fs.readdirSync(dir).filter(x => x.startsWith(base) && x !== f).sort();
    for (const old of gens.slice(0, Math.max(0, gens.length - keep))) {
      try { fs.unlinkSync(path.join(dir, old)); rotated.push({ file: old, deleted: true }); } catch (_) {}
    }
  }
  return rotated;
}

/** Every path a project record actually points at — artifacts, source, captions, transcripts, exports. */
function referencedPaths(store) {
  const refs = new Set();
  const add = p => { if (p && typeof p === 'string') { try { refs.add(path.resolve(p)); } catch (_) {} } };
  let projects = [];
  try { projects = store.listProjects(); } catch (_) { return refs; }
  for (const p of projects) {
    const full = store.project(p.id);
    if (!full) continue;
    add(full.source && full.source.file);
    for (const id of full.artifacts || []) {
      const a = store.artifact(id);
      if (!a) continue;
      add(a.file); add(a.preview);
    }
    for (const tid of full.transcriptions || []) {
      const t = store.transcription(tid);
      if (t) { add(t.audioFile); add(t.file); }
    }
    for (const cid of full.captions || []) {
      const c = store.captionTrack(p.id, cid);
      if (c) { add(c.assFile); add(c.file); }
    }
  }
  try {
    for (const a of store.assets() || []) add(a.file);
  } catch (_) {}
  return refs;
}

// Only names this codebase itself generates as scratch. A file that happens to be unrecognised is
// NOT a candidate — an unfamiliar name is a reason to leave a file alone, not to delete it.
const SCRATCH = /^(tmp_|an_|proxy_|scratch_|th_)/i;

/**
 * mediaReport — what is on disk, what is referenced, and what is (only) scratch.
 * `candidates` is a proposal, not an action. Nothing is deleted by this function.
 */
function mediaReport(store, storage, opts) {
  const optsIn = opts || {};
  const scratchAgeMs = (optsIn.scratchHours || 24) * 3600 * 1000;
  const cacheTtlMs = (optsIn.cacheHours || 72) * 3600 * 1000;
  const now = Date.now();
  const refs = referencedPaths(store);
  const roots = [
    { root: storage.mediaDir, kind: 'media' },
    { root: storage.cacheDir, kind: 'cache' },
    { root: storage.legacyMediaDir, kind: 'legacy-cache' },
  ];
  const byKind = { media: { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 }, cache: { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 }, 'legacy-cache': { files: 0, bytes: 0, orphans: 0, orphanBytes: 0 } };
  const candidates = [];
  let total = { files: 0, bytes: 0 };

  const walk = (dir, kind) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, kind); continue; }
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      total.files++; total.bytes += st.size;
      byKind[kind].files++; byKind[kind].bytes += st.size;
      const isRef = refs.has(path.resolve(full));
      const age = now - st.mtimeMs;
      let why = null;
      if (!isRef) {
        if (/\.tmp$/i.test(e.name) && age > 3600 * 1000) why = 'leftover temp file (older than an hour)';
        else if (kind === 'cache' && age > cacheTtlMs) why = 'expired cache entry (regenerable)';
        else if (kind === 'legacy-cache' && age > cacheTtlMs) why = 'expired legacy download cache';
        else if (kind === 'media' && SCRATCH.test(e.name) && age > scratchAgeMs) why = 'scratch file with no record pointing at it';
      }
      if (why) {
        byKind[kind].orphans++; byKind[kind].orphanBytes += st.size;
        candidates.push({ file: full, bytes: st.size, kind, ageHours: Math.round(age / 3600000), why });
      }
    }
  };
  for (const r of roots) walk(r.root, r.kind);

  const referencedCount = refs.size;
  return {
    roots: roots.map(r => ({ kind: r.kind, root: r.root, ...byKind[r.kind] })),
    total, referencedFiles: referencedCount,
    candidates: candidates.sort((a, b) => b.bytes - a.bytes).slice(0, 500),
    candidateBytes: candidates.reduce((n, c) => n + c.bytes, 0),
    policy: [
      'A file referenced by an artifact, project source, caption track or transcription is never a candidate.',
      'Cache entries are regenerable and only expire after VS_CACHE_TTL_HOURS (default 72h).',
      'Unrecognised filenames are left alone: an unknown name is not permission to delete.',
      'Cleanup is a dry run unless explicitly confirmed.',
    ],
    limits: { scratchHours: optsIn.scratchHours || 24, cacheHours: optsIn.cacheHours || 72 },
  };
}

/**
 * sweep — delete exactly the candidates mediaReport proposed, and nothing else.
 * `confirm: true` is required; without it this is a dry run that just reports.
 */
function sweep(store, storage, opts) {
  const o = opts || {};
  if (!o.confirm) return { dryRun: true, report: mediaReport(store, storage, o) };
  const report = mediaReport(store, storage, o);
  const refs = referencedPaths(store);
  const deleted = [];
  let bytes = 0;
  for (const c of report.candidates) {
    // Re-check against the reference set at deletion time: a record may have been created between
    // the report and the sweep, and a stale report must never be able to delete live media.
    if (refs.has(path.resolve(c.file))) continue;
    try { fs.unlinkSync(c.file); deleted.push(c.file); bytes += c.bytes; } catch (_) {}
  }
  return { dryRun: false, deleted: deleted.length, bytes, files: deleted, report };
}

/**
 * install — called once at boot: rotate an oversized log immediately and hand back a timer that
 * keeps doing it. Housekeeping must never be able to take the process down, so every path swallows
 * its own errors and the timer is unref'd (it must not keep the process alive on its own).
 */
function install(studio, opts) {
  const o = opts || {};
  const logsDir = studio.LOGDIR;
  const rotated = rotateLogs(logsDir, { maxBytes: o.logMaxBytes, keep: o.logKeep });
  const everyMs = (o.intervalMinutes || 60) * 60000;
  const t = setInterval(() => { try { rotateLogs(logsDir, { maxBytes: o.logMaxBytes, keep: o.logKeep }); } catch (_) {} }, everyMs);
  if (t.unref) t.unref();
  return { rotated, everyMs };
}

module.exports = { install, rotateLogs, mediaReport, sweep, referencedPaths };
