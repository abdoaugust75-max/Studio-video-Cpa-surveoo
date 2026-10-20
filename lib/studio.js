// lib/studio.js — the v2 service layer: routes, SSE, URL ingestion, staged search,
// TTS/music bridges, analytics, and the job runners that execute agent tools.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const PAGE_WRITERS = require('./page-writers');
const { createStore } = require('./store');
const { createMedia } = require('./media');
const { createJobs } = require('./jobs');
const { createAgent } = require('./agent');
const { createTranscribe } = require('./transcribe');
const { createCaptions } = require('./captions');
const { createEditor } = require('./editor');
const { createPlan } = require('./plan');
const { createSuite } = require('./suite');
const { createSource } = require('./source');
const { createPublish } = require('./publish');
const { createSaved } = require('./saved');
const { createVideoUnderstanding } = require('./video-understanding');
const { createPipeline } = require('./pipeline');
const { createTimedNarration } = require('./timed-narration');
const { createCampaignProduction } = require('./campaign-production');
const retention = require('./retention');
const LOCK = require('./locks');

function createStudio(o) {
  const root = o.root;
  const DATA = o.dataDir;
  // Roots come from lib/storage when provided (env-configurable), else fall back to the classic
  // layout so the module still works if it is constructed directly.
  const S = o.storage || null;
  const STUDIO = U.ensureDir(S ? S.studioDir : path.join(DATA, 'studio'));
  const MEDIA_ROOT = U.ensureDir(S ? S.mediaDir : path.join(STUDIO, 'media'));
  const LOGDIR = U.ensureDir(S ? S.logsDir : path.join(STUDIO, 'logs'));
  const CACHE = S ? S.cacheDir : path.join(DATA, 'cache');
  const STORAGE = S;
  const legacy = o.legacy;
  const log = U.makeLogger(path.join(LOGDIR, 'studio.jsonl'));
  const j = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readJson = async req => { const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; } };
  // The portable shape of an artifact, as the workspace receives it. `project` matters: a page
  // version shown in the orchestrator belongs to its own project, so Approve has to target THAT
  // project — the open one would be the wrong project to record a decision against.
  // A library record as the workspace receives it: the pointer, what a search measured, and how
  // fresh the availability information actually is. Never presented as if the video were stored.
  const fmtSaved = r => ({
    id: r.id, url: r.url, title: r.title || '', author: r.author || '', platform: r.platform || '',
    duration: r.duration || 0, cover: r.cover || '', play: r.play || '',
    preview: r.play ? ('/proxy?url=' + encodeURIComponent(r.play) + '&id=' + encodeURIComponent(r.id)) : '',
    page: r.page || '', collection: r.collection || '', note: r.note || '', tags: r.tags || [],
    savedAt: r.savedAt, lastSeenAt: r.lastSeenAt, importedProject: r.importedProject || null,
    availability: r.availability || { state: 'unchecked', checkedAt: null },
  });
  const fmtArtifact = a => ({
    id: a.id, op: a.op, label: a.label, rel: a.rel, kind: a.kind, project: a.project || null,
    page: a.page || null, version: a.version || null, ts: a.ts || null, status: a.status || null,
    parent: a.parent || null,
    // Internal orchestration briefs never belong in the user-facing script artifact.
    text: a.kind === 'script' ? String(a.text || '').split('\n\nProduction brief:')[0] : (a.text || null),
    size: a.size || null, params: a.params || null,
    duration: a.probe ? a.probe.duration : null, width: a.probe ? a.probe.width : null, height: a.probe ? a.probe.height : null,
  });

  const store = createStore({ root: STUDIO, mediaRoot: MEDIA_ROOT, legacy: { brands: legacy.brands(), fbPages: legacy.fbPages } });

  // ---------------------------------------------------------------- media + jobs
  async function downloadMusic(url, title) {
    const f = path.join(CACHE, 'mus_' + U.hash16(url) + '.mp3');
    if (!fs.existsSync(f) || fs.statSync(f).size < 2048) {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('music download failed (' + r.status + ')');
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    }
    return f;
  }
  const media = createMedia({
    store, root, log,
    bridge: {
      tts: async (text, voice, rate, pageKey) => {
        // Owner rule (2026-09-23): EVERY profile speaks in Kore (n8n parity) — no caller can
        // substitute another prebuilt voice.
        const v = 'Kore';
        const rel = await legacy.makeTTSFile(pageKey || 'alshihna', text, v, rate);
        return path.join(CACHE, path.basename(rel));
      },
      music: async (url, title) => {
        const f = await downloadMusic(url, title);
        store.addAsset({ kind: 'music', title: title || url.split('/').pop(), url, file: f });
        return f;
      },
    },
  });
  // Concurrency is a runtime decision, not a constant: the media box is small, so by default one
  // heavy job at a time. Configurable for a bigger machine, and forced off in the web role.
  const jobs = createJobs({
    dir: store.DIR.jobs, log, enabled: o.jobsEnabled !== false,
    concurrency: U.clamp(process.env.VS_JOB_CONCURRENCY, 1, 8, 1),
  });

  // ---------------------------------------------------------------- SSE bus
  const clients = new Set();
  function sseWrite(client, payload) {
    try { client.res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch (_) { clients.delete(client); }
  }
  jobs.on(ev => {
    for (const c of [...clients]) {
      if (!c.page || !ev.job || !ev.job.page || c.page === ev.job.page || ev.job.page === '' ) sseWrite(c, ev);
    }
  });
  function broadcast(payload) { for (const c of [...clients]) sseWrite(c, payload); }

  // ---------------------------------------------------------------- activity stream
  /**
   * recordActivity — the operational "what is the agent doing right now" stream.
   * Records FACTS ONLY: which task, which model served it, how long it took, which tool ran,
   * and whether it succeeded. Private model reasoning is never captured, so nothing here can
   * leak chain-of-thought — it is the same information a render queue would show.
   */
  function recordActivity(rec) {
    const entry = { ...rec, ts: rec.ts || Date.now(), type: rec.type || 'model.call' };
    try { U.appendJsonl(path.join(LOGDIR, 'activity.jsonl'), entry); } catch (_) {}
    broadcast({ type: 'activity', ts: entry.ts, page: entry.page || '', activity: entry });
    return entry;
  }

  // ---------------------------------------------------------------- editorial services
  /**
   * ONE transcription path and ONE caption path, shared by the panel and the agent. The agent
   * cannot transcribe differently from the UI, because there is only one implementation to call —
   * which is also what makes "I transcribed the video" checkable against the transcript panel.
   */
  const transcribe = createTranscribe({ store, media, llm: legacy.llm, log, activity: recordActivity, cacheDir: CACHE });
  const captions = createCaptions({ media, store });
  const editor = createEditor({ store });
  /**
   * Source discovery. Provider-independent like the transcription service: it asks for a vision
   * model, the router chooses one, and every candidate carries how each signal was obtained.
   */
  const source = createSource({
    store, media, legacy, llm: legacy.llm, log, activity: recordActivity, cacheDir: CACHE,
    // Re-resolve a video's stream URL when a cached one has expired (see lib/source withFresh).
    refresh: url => legacy.resolveUrl(url),
  });
  /** Publishing. Owns the destination permission check, so the UI filtering is only a convenience. */
  const publish = createPublish({ store, log, activity: recordActivity, accounts: () => legacy.fbPages(),hold:()=>U.readJson(path.join(STUDIO,'publish-hold.json'),{enabled:true}).enabled!==false });
  // The owner's saved sources: pointers with real metadata, no downloads. Global on purpose — a clip
  // found while working on one brand is still useful three projects later.
  const saved = createSaved({ file: path.join(STUDIO, 'saved-sources.json'), log });
  // The most recent searches per query, so a candidate can be imported (or saved) by id. Server-side,
  // so a client cannot inject a stream URL that was never discovered.
  const LAST_SEARCH = new Map();
  const SEARCH_CACHE = path.join(STUDIO, 'last-searches.json');
  /**
   * rememberSearch — keeps a shortlist resolvable across a restart.
   *
   * This was found by using the product: the search results were held only in memory, so restarting the
   * server (or the worker) turned every candidate still on screen into "no longer in a recent search" —
   * Import and Save both dead, from the owner's point of view, for no visible reason. Only the shortlist
   * itself is persisted; import works from the canonical source URL and re-resolves a fresh stream, so an
   * expired CDN link inside a stored record does not matter.
   */
  function rememberSearch(query, r) {
    LAST_SEARCH.set(r.query, { ts: Date.now(), r });
    try {
      const items = [...LAST_SEARCH.entries()]
        .sort((a, b) => b[1].ts - a[1].ts).slice(0, 12)
        .map(([q, v]) => [q, { ts: v.ts, r: { query: v.r.query, candidates: v.r.candidates || [], considered: v.r.considered || 0, notes: v.r.notes || [], intent: v.r.intent || null } }]);
      U.writeJsonAtomic(SEARCH_CACHE, { version: 1, items });
    } catch (e) { log('warn', 'search.cache.failed', { error: e.message }); }
  }
  (function hydrateSearches() {
    const d = U.readJson(SEARCH_CACHE, null);
    const items = d && Array.isArray(d.items) ? d.items : [];
    const now = Date.now();
    for (const [q, v] of items) {
      if (!v || !v.r || !Array.isArray(v.r.candidates) || !v.r.candidates.length) continue;
      if (now - (v.ts || 0) > 48 * 3600 * 1000) continue;   // a two-day-old shortlist is not a shortlist
      LAST_SEARCH.set(q, v);
    }
    if (LAST_SEARCH.size) log('info', 'search.cache.hydrated', { queries: LAST_SEARCH.size });
  })();

  /**
   * burnCaptions — render the project's caption track INTO the video as a new artifact.
   * Lines come from the track's own segments (the owner's corrections included), so what is burned
   * always matches what the panel shows. The artifact also records WHICH track produced it, which is
   * how the timeline can say "these captions are in this cut" with evidence instead of assuming.
   */
  async function burnCaptions({ project, track, ctx }) {
    const p = store.project(project);
    if (!p) throw new Error('unknown project: ' + project);
    const t = track ? store.captionTrack(project, track) : editor.captionState(p).track;
    if (!t) throw new Error('this project has no caption track yet — build one from the transcript first');
    const lines = captions.toLines(t);
    if (!lines.length) throw new Error('caption track ' + t.id + ' has no segments');
    ctx && ctx.progress && ctx.progress('burning ' + lines.length + ' captions', 25);
    const art = await media.applyOp(project, 'burn_subs', {
      lines: JSON.stringify(lines.map(l => ({ start: l.start, end: l.end, text: l.text, position: l.position }))),
      style: JSON.stringify({ ...(t.style || {}) }),
    }, ctx);
    art.params = { ...(art.params || {}), track: t.id, preset: t.preset || null };
    store.saveArtifact(art);
    return { ...art, track: t.id, segments: lines.length };
  }

  /**
   * previewRender — coalesced fast preview.
   * A preview always resolves the project's CURRENT artifact when it runs, so a second request made
   * while one is still waiting would produce a byte-identical file. Returning the pending job instead
   * of enqueueing another is what stops a slider drag from flooding the queue.
   */
  function previewRender({ page, project }) {
    const p = store.project(project);
    if (!p) throw new Error('unknown project: ' + project);
    const pending = jobs.list({}).find(x => x.project === project && x.type === 'media.op'
      && x.params && x.params.op === 'render' && x.params.args && x.params.args.mode === 'preview'
      && (x.status === 'queued' || x.status === 'running'));
    if (pending) return { job: jobs.publicJob(pending), coalesced: true };
    const job = jobs.enqueue({ type: 'media.op', page: page || '', project, params: { project, op: 'render', args: { mode: 'preview' }, page: page || '' } });
    return { job: jobs.publicJob(job), coalesced: false };
  }

  // ---------------------------------------------------------------- agent services
  function projectOf(pageKey, projectId) {
    if (projectId) { const p = store.project(projectId); if (p) return p; }
    const c = store.conversation(pageKey);
    return c.project ? store.project(c.project) : null;
  }
  /** The page's current project, creating one if the page has none yet (never fail the owner). */
  function saveProjectPointer(pageKey) {
    // Never adopt "the page's newest existing project": it may belong to an older video or batch
    // (same hazard delegatedProjectForSource below guards against), and writing it into c.project
    // is what resurrected a dead session's artifacts after NEW CHAT. With no current project the
    // honest state is a NEW empty one.
    const p = projectOf(pageKey) || store.createProject(pageKey, 'Untitled project');
    const c = store.conversation(pageKey);
    c.project = p.id;
    store.saveConversation(c);
    return p;
  }

  // A delegated page turn must use the source the owner is currently looking at.
  // Reusing a page's last project is unsafe: that project may belong to an older video
  // (for example, an A37 fanout followed by an A17 import in the Orchestrator).
  function delegatedProjectForSource(pageKey, source) {
    if (!source || !source.currentPlayable) return null;
    const sourceArt = store.artifact(source.currentPlayable) || (source.current ? store.artifact(source.current) : null);
    if (!sourceArt || sourceArt.kind !== 'video' || !sourceArt.file) return null;
    const sourceKey = source.source && source.source.meta && source.source.meta.id
      ? String(source.source.meta.id) : sourceArt.id;
    const existing = store.listProjects(pageKey).map(x => store.project(x.id)).filter(Boolean)
      .filter(p => p.branch && p.branch.delegated && p.branch.sourceKey === sourceKey)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    if (existing) {
      const conv = store.conversation(pageKey);
      if (conv.project !== existing.id) { conv.project = existing.id; store.saveConversation(conv); }
      return existing;
    }
    const page = store.page(pageKey);
    const p = store.createProject(pageKey, (source.title || 'Video') + ' — ' + page.label, {
      source: source.source || null,
      analysis: source.analysis || null,
      truth: source.truth || U.footageTruth(source.analysis, source.source && source.source.meta && source.source.meta.title) || null,
      role: 'branch',
      branch: { page: pageKey, pageLabel: page.label, delegated: true, sourceKey, sourceProject: source.id, created: Date.now() },
    });
    store.linkArtifact(p.id, sourceArt.id, { op: 'source', label: 'Source for ' + page.label, kind: 'video', version: 1 });
    const lineage = [...new Set([...(source.transcriptions || []), ...(source.sharedTranscriptions || [])])];
    if (lineage.length) store.shareTranscription(p.id, lineage);
    const conv = store.conversation(pageKey); conv.project = p.id; store.saveConversation(conv);
    return p;
  }

  /**
   * ImportError — a failure the owner can act on.
   * "Import failed" is useless; "the platform blocked the download — the link may be region-locked"
   * tells them what to try next. Every import failure is classified into one of these.
   */
  class ImportError extends Error {
    constructor(kind, message, detail) { super(message); this.kind = kind; this.detail = detail || null; }
  }
  function classifyIngestError(e, url) {
    const m = String((e && e.message) || e || '');
    if (/404|not found|no longer exists|unavailable/i.test(m)) return new ImportError('source_unavailable', 'That video is no longer available at that address.', m);
    if (/403|forbidden|blocked|login|sign in|private/i.test(m)) return new ImportError('platform_blocked', 'The platform refused the download — the video may be private, region-locked or protected.', m);
    if (/expired|token/i.test(m)) return new ImportError('expired_link', 'The source link has expired. Open the original page and copy the link again.', m);
    if (/unsupported|audio only|not a video|playlist|live/i.test(m)) return new ImportError('unsupported_media', 'That link is not a downloadable single video.', m);
    if (/timeout|timed out|ETIMEDOUT|socket/i.test(m)) return new ImportError('timeout', 'The source took too long to respond. Try again, or pick a shorter clip.', m);
    if (/resolve|no stream|downloadable/i.test(m)) return new ImportError('no_stream', 'No downloadable video stream could be resolved for ' + String(url || '').slice(0, 80) + '.', m);
    return new ImportError('import_failed', 'Import failed: ' + U.sanitizeText(m, 200), m);
  }

  /**
   * importUrl — ingest a supported video URL into a project as a real, validated source artifact.
   * Nothing is announced as imported until a decodable video file exists on disk and has been probed:
   * the artifact record is created last, from the verified file.
   */
  /**
   * blockedHost — SSRF guard for URL ingestion.
   * The importer fetches whatever URL it is given, from the machine running the studio. Left open,
   * that is a way to reach the machine's own services or anything on the local network. Only public
   * addresses are allowed in.
   */
  function blockedHost(raw) {
    let h;
    try { h = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return 'unparseable'; }
    if (!h) return 'empty';
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return h;
    if (h === '::1' || h === '0.0.0.0') return h;
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (a === 127 || a === 10 || a === 0 || a >= 224) return h;
      if (a === 192 && b === 168) return h;
      if (a === 172 && b >= 16 && b <= 31) return h;
      if (a === 169 && b === 254) return h;          // link-local / cloud metadata
    }
    return null;
  }
  /** A whole-ingest deadline, so one bad source cannot hold the single worker for minutes. */
  const INGEST_BUDGET_MS = 150000;

  async function importUrl({ page, project, url, title, candidate, ctx, skipLegacyAnalysis = false }) {
    ctx = ctx || { progress() {}, note() {} };
    page = String(page || '').replace(/[^a-z0-9_]/gi, '') || store.ORCHESTRATOR;
    if (!/^https?:\/\//i.test(String(url || ''))) throw new ImportError('bad_url', 'Only http(s) links can be imported.');
    const badHost = blockedHost(url);
    if (badHost) {
      throw new ImportError('blocked_host', 'That address points at a local or private machine (' + badHost + '), which this studio will not fetch.');
    }
    const deadline = Date.now() + INGEST_BUDGET_MS;
    const budget = () => { if (Date.now() > deadline) throw new ImportError('timeout', 'Importing took longer than ' + Math.round(INGEST_BUDGET_MS / 1000) + 's and was stopped. The source may be slow or unavailable — try again or pick a different clip.'); };
    let p = project ? store.project(project) : null;
    if (!p) p = store.createProject(page, title || ('Import ' + new Date().toISOString().slice(0, 16)));
    ctx.progress('resolving the video', 8);
    let d = null;
    if (candidate && candidate.play && candidate.id) {
      // Importing straight from a search result: its stream URL was already resolved and measured by
      // the discovery stage, so re-resolving it would only add a failure mode and 30 seconds.
      d = { id: candidate.id, author: candidate.author, title: candidate.title, duration: candidate.duration, cover: candidate.cover, plays: candidate.plays, likes: candidate.likes, play: candidate.play, source: candidate.source || url };
    } else {
      try { d = await legacy.resolveUrl(url); }                      // TikWM first, yt-dlp fallback
      catch (e) { throw classifyIngestError(e, url); }
      budget();
    }
    if (!d || !d.play) throw new ImportError('no_stream', 'No downloadable video stream could be resolved for that link.', 'resolver returned nothing');

    const dir = store.projectDir(p.id);
    // The source file is keyed by the video's own id. A single 'source.mp4' meant that importing a
    // DIFFERENT candidate into the same project silently kept the previous footage while the UI
    // reported the new one as imported — a real import that reported the wrong result.
    const srcKey = U.safeName(String(d.id || U.hash16(String(url))), 32) || 'unknown';
    const target = path.join(dir, 'source_' + srcKey + '.mp4');
    let downloaded = false;
    const fetchToTarget = async playUrl => {
      const tmp = await legacy.downloadVideo(playUrl);
      if (!tmp || !fs.existsSync(tmp) || fs.statSync(tmp).size < 10000) {
        throw new ImportError('download_failed', 'The download produced no usable file — the source URL may have expired.', 'file missing or under 10KB');
      }
      try { fs.copyFileSync(tmp, target); } catch (_) { fs.renameSync(tmp, target); }
    };
    if (!fs.existsSync(target) || fs.statSync(target).size < 10000) {
      ctx.progress('downloading ' + (d.author ? '@' + d.author : 'the video'), 25);
      try { await fetchToTarget(d.play); }
      catch (e) {
        // A candidate's stream URL is captured at search time and these URLs expire within minutes.
        // One re-resolve here turns "import mysteriously fails" into "import works a minute later".
        let fresh = null;
        try { fresh = await legacy.resolveUrl(d.source || url); } catch (_) {}
        if (!fresh || !fresh.play) throw classifyIngestError(e, url);
        ctx.note('the source link had expired — resolved a fresh one');
        d.play = fresh.play;
        if (fresh.cover) d.cover = fresh.cover;
        if (fresh.duration) d.duration = fresh.duration;
        try { await fetchToTarget(fresh.play); } catch (e2) { throw classifyIngestError(e2, url); }
      }
      budget();
      downloaded = true;
    }

    // ---- validation: a playable video stream must actually exist before anything is recorded ----
    ctx.progress('validating the file', 45);
    const info = await media.probe(target);
    if (!info) throw new ImportError('validation_failed', 'The downloaded file could not be read as media.', 'ffprobe returned nothing');
    if (!info.width || !info.height) throw new ImportError('no_video_stream', 'The downloaded file has no video stream (it may be audio or a protected format).', JSON.stringify({ w: info.width, h: info.height }));
    if (!info.duration || info.duration < 0.4) throw new ImportError('validation_failed', 'The downloaded video is empty or unreadable (duration ' + (info.duration || 0) + 's).', 'duration too short');
    if (candidate && candidate.measured && candidate.measured.looksStill) {
      throw new ImportError('not_footage', 'That candidate measured as a still image rather than footage, so it was not imported.', 'looksStill');
    }

    ctx.progress('analysing what happens in the video', 62);
    let analysis = null;
    if (!skipLegacyAnalysis) {
      try { analysis = await legacy.analyzeFile(target); } catch (e) { ctx.note('analysis failed: ' + U.sanitizeText(e.message, 120)); }
    }
    p.source = {
      url: d.source || url, file: target, kind: 'url',
      meta: {
        id: d.id, author: d.author, title: d.title, duration: info.duration,
        plays: d.plays || 0, likes: d.likes || 0, cover: d.cover || '',
        candidate: candidate ? { id: candidate.id, score: candidate.score, why: candidate.why || [], signals: candidate.signals || null } : null,
      },
    };
    // The project title follows the source only while it is still auto-derived. A title the owner
    // typed is never overwritten — but a project holding a different video must not keep advertising
    // the previous one's name in every message.
    const prevSourceTitle = p.source && p.source.meta ? p.source.meta.title : null;
    const autoTitled = !p.title || /^Import /.test(p.title) || (prevSourceTitle && p.title === prevSourceTitle);
    if (autoTitled) p.title = U.sanitizeText(d.title || 'Imported video', 120);
    p.analysis = analysis || null;
    // Ground truth is derived once, from the analysis and the caption as they arrived together.
    // The comparison lives in util so the same rule is available to the agent prompt for projects
    // imported before it existed — grounding must not depend on re-importing the video.
    const truth = U.footageTruth(analysis, d.title);
    p.truth = truth ? { ...truth, at: U.nowIso() } : (p.truth || null);
    p.status = analysis ? 'analysed' : 'imported';
    store.saveProject(p);
    // A new source is a NEW production batch. Every downstream stage (scripts, TTS, renders)
    // resolves through this batch, so an old batch's artifacts can never surface as the current
    // outputs of the new source — that cross-batch leakage was the real "12/14/21 versions" bug.
    try {
      const freshBatch = store.createBatch(p.id);
      store.setCurrentBatch(freshBatch);
      log('info', 'batch.created', { batch: freshBatch.id, source: p.id, truthProduct: truth && truth.product || null, visualConfidence: truth && truth.visualConfidence || null });
    } catch (batchErr) { log('warn', 'batch.create.failed', { error: U.sanitizeText(batchErr.message, 120) }); }
    const art = store.addArtifact({
      project: p.id, op: 'source', file: target, kind: 'video',
      params: { url: p.source.url, sourceId: d.id || null, measured: !!info },
      probe: info, label: 'Source' + (d.id ? ' ' + String(d.id).slice(-6) : ''), attach: true,
    });
    // Something actually fetched this URL and produced a playable artifact, so the library's
    // availability can honestly move off 'unchecked'. No other code path is allowed to do this.
    try { saved.markSeen(url, { state: 'ok', note: 'imported successfully', project: p.id, artifact: art.id }); } catch (_) {}
    log('info', 'import.done', { project: p.id, page, duration: info.duration, downloaded, candidate: candidate ? candidate.id : null });
    if (ctx.emit) ctx.emit('artifact.created', { artifact: art.id, project: p.id });
    return {
      project: { id: p.id, title: p.title },
      source: { id: d.id || null, title: U.sanitizeText(d.title || p.title, 140), author: U.sanitizeText(d.author || '', 60) },
      video: { ...p.source.meta, rel: art.rel, width: info.width, height: info.height },
      analysis, artifact: art,
      validated: { duration: info.duration, width: info.width, height: info.height, hasAudio: !!info.hasAudio },
    };
  }

  /** search — one discovery path for the panel and the agent (lib/source owns the policy). */
  async function search(query, ctx, opts) {
    ctx = ctx || { progress() {}, note() {} };
    ctx.progress('searching for "' + query + '"', 15);
    const r = await source.search({ query, page: (opts && opts.page) || '', project: (opts && opts.project) || '', limit: (opts && opts.limit) || 5, vision: (opts && opts.vision) !== false, visionLimit: (opts && opts.visionLimit), progress: ctx.progress, note: ctx.note,
      shouldStop: () => !!(ctx.job && jobs.get(ctx.job.id) && jobs.get(ctx.job.id).status === 'cancelled') });
    // remember the last result so a candidate card can be imported by id without the client shipping
    // the whole candidate object back (and without trusting anything it sends back either).
    rememberSearch(r.query, r);
    return r;
  }

  /**
   * importCandidate — import a candidate by id from a recent search.
   * The candidate object is looked up HERE. A client (or the model) cannot hand the importer a stream
   * URL that was never discovered or measured, which is what keeps "import" and "search" the same
   * pipeline instead of two paths that can disagree.
   */
  async function importCandidate({ page, project, candidateId, ctx }) {
    const id = String(candidateId || '').replace(/[^a-z0-9_]/gi, '');
    if (!id) throw new ImportError('bad_candidate', 'No candidate was selected.');
    let hit = null;
    for (const [, v] of LAST_SEARCH) { const c = v.r.candidates.find(x => String(x.id) === id); if (c) { hit = c; break; } }
    if (!hit) throw new ImportError('stale_candidate', 'That candidate is no longer in a recent search — search again and pick it from the fresh results.');
    return importUrl({ page, project, url: hit.source, title: hit.title, candidate: hit, ctx });
  }

  // ---------------------------------------------------------------- approval checkpoints
  // Utility outputs (a proxy, a still frame, a re-encode of the same content) are not creative
  // decisions, so they never interrupt the director. Anything that changes the cut does.
  const UTIL_OPS = new Set(['render', 'extract_frame', 'proxy']);
  function approvalMode(pageKey, override) {
    if (override) return override;
    try { return store.page(pageKey).approval || 'ask_before_final'; } catch (_) { return 'ask_before_final'; }
  }
  /**
   * needsCheckpoint — where a human review belongs depends on the page's approval mode:
   *   ask_after_each   → after every content change
   *   ask_before_final → once, after the LAST content change of the run (the review that
   *                      precedes the final export)
   *   auto             → never
   * Utility outputs (proxy / still frame / re-encode) are not creative decisions.
   */
  function needsCheckpoint(pageKey, op, override, isLast) {
    const mode = approvalMode(pageKey, override);
    if (mode === 'auto') return false;
    if (UTIL_OPS.has(op)) return false;
    if (mode === 'ask_after_each') return true;
    return isLast !== false;
  }

  // Friendly aliases so plans can be written (and generated by the agent) with readable op names.
  const OP_ALIAS = {
    trim: 'trim', cut: 'trim', text: 'overlay_text', overlay_text: 'overlay_text',
    ratio: 'crop_ratio', crop: 'crop_ratio', crop_ratio: 'crop_ratio', resize: 'resize',
    speed: 'speed', subtitles: 'burn_subs', burn_subs: 'burn_subs', volume: 'volume', mute: 'mute',
    music: 'mix_music', mix_music: 'mix_music', voiceover: 'voiceover', voice: 'voiceover',
    render: 'render', frame: 'extract_frame', extract_frame: 'extract_frame', proxy: 'proxy',
  };
  const resolveOp = name => OP_ALIAS[String(name || '').trim()] || (media.ops[name] ? name : null);

  // ---------------------------------------------------------------- plan (EDL) + suites
  // Declared after resolveOp (a const in this scope) and after previewRender/burnCaptions, because a
  // branch's recipe recipe-resolves captions through both of them.
  const plan = createPlan({ store, resolveOp });
  const suite = createSuite({ store, media, jobs, log, captions, editor, burnCaptions, previewRender });
  function approvalMessage(pageKey, project, pending, verb) {
    const p = store.project(project);
    const art = pending.artifact ? store.artifact(pending.artifact) : null;
    const n = pending.total ? ' (' + pending.cursor + '/' + pending.total + ')' : '';
    store.appendMessage(pageKey, {
      role: 'agent',
      text: verb + ': ' + (pending.label || pending.op || 'change') + n,
      artifacts: art ? [fmtArtifact(art)] : [],
      tools: [],
      approval: {
        project, checkpoint: pending.checkpoint, artifact: pending.artifact,
        op: pending.op, cursor: pending.cursor || 0, total: pending.total || null,
        mode: p ? (p.pending ? 'waiting' : '') : '', status: 'waiting',
      },
      project,
    });
  }

  async function tts({ page, project, text, voice, rate, scriptId, profileKey, isolated = false }) {
    // Owner rule (2026-09-23): the ONLY voice is Kore, on every profile (n8n parity). The `voice`
    // argument is accepted for compatibility but can never substitute another prebuilt voice.
    const v = 'Kore';
    const rel = await legacy.makeTTSFile(page, text, v, rate);
    const file = path.join(CACHE, path.basename(rel));
    if (!fs.existsSync(file) || fs.statSync(file).size < 200) throw new Error('tts produced no usable audio file');
    const info = await media.probe(file);
    if (!project) return { url: rel, voice: v, probe: info, note: 'preview only (no project open)' };
    if (!profileKey && scriptId) { const s = store.artifact(scriptId); if (s && s.params && s.params.profileKey) profileKey = s.params.profileKey; }
    const batch = isolated ? null : store.currentBatch();
    const art = store.addArtifact({ project, op: 'tts', file, kind: 'audio', parent: scriptId || null,
      params: { text: text.slice(0, 100), voice: v, rate, profileKey: profileKey || page || null, scriptArtifactId: scriptId || null, batchId: batch ? batch.id : null },
      probe: info, attach: false, label: 'Voice ' + v });
    // The batch pointer is what makes this THE current TTS for its profile — without it a real
    // audio file can exist while every stage resolver still says "no TTS yet".
    const pk = profileKey || page;
    if (batch && batch.profiles && batch.profiles[pk]) store.setBatchArtifact(batch, pk, 'tts', art.id, 'tts');
    return { artifact: art, url: rel, voice: v };
  }

  /**
   * verifyTtsArtifact — the ONLY definition of "TTS exists": a TTS artifact bound to this profile
   * (+ this script when known) whose real audio file exists, is non-empty and probes as playable
   * media. A chat line claiming "already generated" is never evidence — anything that fails a
   * check does NOT exist and gets regenerated.
   */
  async function verifyTtsArtifact(art, expect) {
    expect = expect || {};
    if (!art) return { ok: false, why: 'no artifact recorded' };
    if (!(art.op === 'tts' || art.kind === 'audio')) return { ok: false, why: 'not a TTS artifact (' + (art.op || art.kind) + ')' };
    if (expect.profileKey && art.params && art.params.profileKey && art.params.profileKey !== expect.profileKey) return { ok: false, why: 'spoken for profile ' + art.params.profileKey };
    if (expect.batch && art.params && art.params.batchId && art.params.batchId !== expect.batch.id) return { ok: false, why: 'belongs to an older batch' };
    if (expect.scriptId && art.parent && art.parent !== expect.scriptId) return { ok: false, why: 'spoken from an older script' };
    // Owner rule: the ONLY voice is Kore. A TTS recorded in any other prebuilt voice does NOT
    // count as current — it is regenerated in Kore on the next TTS run.
    if (art.params && art.params.voice && art.params.voice !== 'Kore') return { ok: false, why: 'spoken in voice "' + art.params.voice + '" — the owner mandated Kore for every profile' };
    const f = art.file;
    if (!f || !fs.existsSync(f)) return { ok: false, why: 'audio file missing on disk' };
    if (fs.statSync(f).size < 200) return { ok: false, why: 'audio file empty' };
    try {
      const info = await media.probe(f);
      if (!info || !(Number(info.duration) > 0.2)) return { ok: false, why: 'audio probe failed' };
    } catch (e) { return { ok: false, why: 'audio probe failed: ' + e.message }; }
    return { ok: true, file: f };
  }

  const MUSIC_SEARCHES = new Map();
  async function musicSearch(query) {
    // Archive's search ANDs every word inside title:(...) — "clean instrumental tech" matched
    // nothing while "instrumental" alone matched 40k tracks. OR the words so a style phrase
    // widens the pool instead of emptying it; the per-track filter below still weeds junk out.
    const words = String(query || '').split(/\s+/).filter(Boolean).slice(0, 6);
    const q = words.length ? words.join(' OR ') : 'instrumental';
    const s = await legacy.fetchJson('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(`mediatype:(audio) AND format:(MP3) AND NOT collection:(podcasts*) AND NOT title:(radio OR podcast OR broadcast OR news) AND (title:(${q}) OR subject:(${q}))`) + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=collection&rows=32&page=1&output=json&sort[]=downloads desc', { timeout: 25000 });
    let docs = ((s.response && s.response.docs) || []).slice();
    const out = [];
    await Promise.all(docs.slice(0, 8).map(async d => {
      try {
        const m = await legacy.fetchJson('https://archive.org/metadata/' + d.identifier, { timeout: 20000 }, 1);
        const f = (m.files || []).find(x => /\.mp3$/i.test(x.name || ''));
        // Archive.org reports MP3 length either as seconds ("2783.58") or as "MM:SS" clock text
        // ("03:45"). The old /1000 (millisecond assumption) turned every real track into 0-4s and
        // rejected them all — music search permanently returned [].
        const rawLen = f ? String(f.length || '') : '';
        const mmss = rawLen.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
        const seconds = mmss
          ? Math.round(Number(mmss[1]) * 60 + Number(mmss[2]) + (mmss[3] ? Number('0.' + mmss[3]) : 0))
          : Math.round(Number(rawLen) || 0);
        const title = String(d.title || d.identifier);
        // Broadcast-looking items hide behind innocent titles ("WARM UP! 11"): also weigh the
        // collection/subject tags and prefer real MUSIC collections. Length bounds keep a 20-minute
        // radio hour or a 9-second blip out of a short-form background bed.
        const subjects = ((m.metadata && (m.metadata.subject || m.metadata.collection)) || '');
        const subjText = Array.isArray(subjects) ? subjects.join(' ') : String(subjects || '');
        const junky = /(radio|podcast|broadcast|news|lecture|interview|episode|show|talk|stream|recording of|hour|kbps|mixtape\s*\d)/i;
        const looksMusic = /music|audio_music|netlabels|jamendo|ccplus|audio_freemusic/i.test(subjText + ' ' + String(d.collection || ''));
        if (f && seconds >= 30 && seconds <= 480 && !junky.test(title) && !junky.test(subjText) && (looksMusic || /music|instrumental|beat|theme|soundtrack|score|loop/i.test(title))) out.push({
          id: 'M_' + U.hash16(d.identifier + ':' + f.name), identifier: d.identifier,
          title: U.sanitizeText(d.title || d.identifier, 100), creator: U.sanitizeText((d.creator && d.creator[0]) || '', 60),
          provider: 'Internet Archive', url: `https://archive.org/download/${d.identifier}/${encodeURIComponent(f.name)}`,
          duration: seconds,
          style: U.sanitizeText(query, 80), mood: U.sanitizeText(query, 80), license: U.sanitizeText((m.metadata && (m.metadata.licenseurl || m.metadata.rights)) || '', 180),
        });
      } catch (_) {}
    }));
    // Too few survivors? The downloads-sorted head of 32 rows can be all audiobooks/spa-hours.
    // Pull ONE more page before giving up — the deeper tail holds the real music uploads.
    if (out.length < 4) {
      try {
        const s2 = await legacy.fetchJson('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(`mediatype:(audio) AND format:(MP3) AND NOT collection:(podcasts*) AND NOT title:(radio OR podcast OR broadcast OR news) AND (title:(${q}) OR subject:(${q}))`) + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=collection&rows=32&page=2&output=json&sort[]=downloads desc', { timeout: 25000 });
        const seen = new Set(docs.map(d => d.identifier));
        docs = docs.concat(((s2.response && s2.response.docs) || []).filter(d => !seen.has(d.identifier)));
        await Promise.all(docs.slice(32).slice(0, 16).map(async d => {
          try {
            const m = await legacy.fetchJson('https://archive.org/metadata/' + d.identifier, { timeout: 20000 }, 1);
            const f = (m.files || []).find(x => /\.mp3$/i.test(x.name || ''));
            const rawLen = f ? String(f.length || '') : '';
            const mmss = rawLen.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
            const seconds = mmss
              ? Math.round(Number(mmss[1]) * 60 + Number(mmss[2]) + (mmss[3] ? Number('0.' + mmss[3]) : 0))
              : Math.round(Number(rawLen) || 0);
            const title = String(d.title || d.identifier);
            const subjects = ((m.metadata && (m.metadata.subject || m.metadata.collection)) || '');
            const subjText = Array.isArray(subjects) ? subjects.join(' ') : String(subjects || '');
            const junky2 = /(radio|podcast|broadcast|news|lecture|interview|episode|show|talk|stream|recording of|hour|kbps|mixtape\s*\d)/i;
            const looksMusic2 = /music|audio_music|netlabels|jamendo|ccplus|audio_freemusic/i.test(subjText + ' ' + String(d.collection || ''));
            if (f && seconds >= 30 && seconds <= 480 && !junky2.test(title) && !junky2.test(subjText) && (looksMusic2 || /music|instrumental|beat|theme|soundtrack|score|loop/i.test(title))) out.push({
              id: 'M_' + U.hash16(d.identifier + ':' + f.name), identifier: d.identifier,
              title: U.sanitizeText(d.title || d.identifier, 100), creator: U.sanitizeText((d.creator && d.creator[0]) || '', 60),
              provider: 'Internet Archive', url: `https://archive.org/download/${d.identifier}/${encodeURIComponent(f.name)}`,
              duration: seconds,
              style: U.sanitizeText(query, 80), mood: U.sanitizeText(query, 80), license: U.sanitizeText((m.metadata && (m.metadata.licenseurl || m.metadata.rights)) || '', 180),
            });
          } catch (_) {}
        }));
      } catch (_) {}
    }
    const results = out.slice(0, 6);
    const searchId = 'MS_' + U.hash16(query + ':' + Date.now());
    MUSIC_SEARCHES.set(searchId, new Map(results.map(x => [x.id, x])));
    while (MUSIC_SEARCHES.size > 20) MUSIC_SEARCHES.delete(MUSIC_SEARCHES.keys().next().value);
    return { query, searchId, results };
  }
  function musicCandidate(id) {
    for (const m of MUSIC_SEARCHES.values()) if (m.has(String(id))) return m.get(String(id));
    return null;
  }
  async function saveMusic({ id, candidate, page, project }) {
    const c = candidate || musicCandidate(id);
    if (!c) throw new Error('music candidate expired — search again');
    const existing = store.musicAssets().find(x => x.meta && x.meta.candidateId === c.id);
    const asset = existing || store.addAsset({ kind: 'music', title: c.title, creator: c.creator, url: c.url, meta: { ...c, candidateId: c.id, page: page || '', project: project || '' } });
    return { music: asset, candidate: c, note: 'Saved reference metadata; the audio is downloaded only when you use it.' };
  }
  async function useMusic({ id, page, project, volume }) {
    const c = musicCandidate(id) || store.musicAsset(id);
    if (!c) throw new Error('music candidate not found — search again');
    const saved = await saveMusic({ candidate: c, page, project });
    if (!project) return saved;
    const file = await downloadMusic(c.url, c.title);
    const probe = await media.probe(file);
    const art = store.addArtifact({ project, op: 'music', kind: 'music', file, probe, attach: false, label: 'Music · ' + c.title, params: { ...c, volume: Number(volume) || 0.22, assetId: saved.music.id } });
    return { ...saved, artifact: fmtArtifact(art), note: 'MusicArtifact is ready to preview. Use it to mix this track into the current video.' };
  }

  async function analyticsPage(pageKey) {
    const p = store.page(pageKey);
    const data = await legacy.stats();
    const ids = new Set((p.pageIds || []).map(x => x.id));
    return {
      pages: (data.pages || []).filter(x => ids.size ? ids.has(x.id) : true),
      posts: (data.posts || []).filter(x => (x.page_id && ids.has(x.page_id)) || true).slice(0, 30),
      updated_at: data.updated_at,
      note: 'Only metrics returned by the platform API are shown.',
    };
  }

  // ---------------------------------------------------------------- agent
  const agentServices = {
    store,
    importUrl, importCandidate, search, tts, musicSearch, saveMusic, useMusic, analyticsPage, transcribe, captions, editor,
    burnCaptions, previewRender, suite, plan, analyticsIntel, source, publish, saved,
    // The candidate lookup lives here so a tool and an HTTP route resolve a candidate the same way:
    // by id, in a search the server itself ran.
    findCandidate: id => {
      for (const [, v] of LAST_SEARCH) { const c = v.r.candidates.find(x => String(x.id) === String(id)); if (c) return c; }
      return null;
    },
    // Importing a saved source is the SAME job as importing a candidate — one validated path.
    savedImport: ({ page, project, id, ctx }) => {
      const rec = saved.get(String(id || '').replace(/[^a-z0-9_]/gi, ''));
      if (!rec) return { ok: false, error: 'that saved source is not in the library' };
      const job = jobs.enqueue({
        type: 'media.import', page: page || rec.page || '', project: project || '',
        params: { page: page || rec.page || '', project: project || '', url: rec.url, title: rec.title || '' },
      });
      if (ctx && ctx.progress) ctx.progress('importing the saved source', 10);
      return { ok: true, job: job.id, source: { id: rec.id, title: rec.title || rec.url }, note: 'The import runs as a job; the source becomes a playable artifact when it finishes.' };
    },
  };
  const agent = createAgent({
    store, media, jobs, log, llm: legacy.llm, knowledgeBlock: legacy.knowledgeBlock, locks: LOCK,
    services: agentServices,
  });
  /**
   * delegate — the orchestrator handing work to ONE page agent.
   * It runs that page's own turn: its memory, its rules, its voice, its language. The result comes
   * back to the orchestrator, which reports it. That is what lets the owner experience a single
   * agent while the page contexts stay isolated.
   */
  agentServices.delegate = async ({ page, message, ctx }) => {
    const key = String(page || '').replace(/[^a-z0-9_]/gi, '');
    if (!store.pages().some(p => p.key === key)) throw new Error('unknown page: ' + page);
    if (store.isOrchestrator(key)) throw new Error('the orchestrator cannot delegate to itself');
    const source = ctx && ctx.page === store.ORCHESTRATOR && ctx.projectId ? store.project(ctx.projectId) : null;
    const target = delegatedProjectForSource(key, source) || projectOf(key) || saveProjectPointer(key);
    const delegatedMessage = source
      ? message + '\n\nUse the CURRENT source project above as the only source of truth. Ignore older page-history products or branches; they may belong to a different video.'
      : message;
    const r = await agent.runTurn({
      page: key, project: target.id, message: delegatedMessage,
      progress: ctx && ctx.progress, emit: ctx && ctx.emit,
    });
    if (!r.ok) throw new Error(r.error || 'the page agent failed');
    return { page: key, label: store.page(key).label, reply: r.reply, artifacts: r.artifacts, tools: r.tools, project: r.project };
  };

  /**
   * fanout — the orchestrator's one-call multi-page production path. Every page gets its own
   * project, script artifact, voice artifact, music artifact and rendered lineage. The source bytes
   * are linked, never copied, while all creative outputs remain page-scoped and independently
   * editable. This also prevents the model from emitting seven pretend page.ask JSON snippets as
   * owner-facing prose.
   */
  agentServices.fanout = async ({ pages, sourceProject, brief, mode = 'production', music = true, render = true, ctx }) => {
    // The CURRENT batch owns stage resolution. Scripts belong to the batch's source — never to a
    // "newest project anywhere" guess, which is how old batches used to leak into new work.
    const batch = store.currentBatch();
    const source = (batch && store.project(batch.sourceProjectId)) || (sourceProject ? store.project(sourceProject) : null);
    if (!source) throw new Error('import a source video first — there is no current production batch to produce from');
    const sourceArt = source.currentPlayable ? store.artifact(source.currentPlayable) : (source.current ? store.artifact(source.current) : null);
    if (!sourceArt || sourceArt.kind !== 'video' || !sourceArt.file) throw new Error('the source project has no playable video artifact');
    const keys = (Array.isArray(pages) && pages.length ? pages : store.pages().filter(p => p.role !== 'orchestrator').map(p => p.key))
      .map(x => String(x).replace(/[^a-z0-9_]/gi, '')).filter((x, i, a) => a.indexOf(x) === i);
    if (!keys.length) throw new Error('no page agents selected');
    const truth = source.truth || U.footageTruth(source.analysis, source.source && source.source.meta && source.source.meta.title) || {};
    const product = U.sanitizeText(truth.product || (source.analysis && (source.analysis.suggested_product || source.analysis.product_visible)) || 'the product shown in the footage', 120);
    // Owner price policy (2026-09-23): every page opens with a LOW offer price from
    // page-writers.priceFor (Moroccan one-time pages 100/200 DH, Tashilat the MONTHLY installment,
    // USD pages the dollar tiers). An owner price override recorded on the batch wins outright.
    const resolvePrice = (key) => {
      const override = (batch.priceOverrides || {})[key] || null;
      const marketHint = (source.analysis && (source.analysis.market_price || source.analysis.market_price_mad)) || null;
      const p = PAGE_WRITERS.priceFor(key, { product, marketHint, override });
      if (!p) return null;
      const label = p.monthly ? p.amount + ' ' + p.currency + '/شهر' : p.amount + ' ' + p.currency;
      return { ...p, label };
    };
    const scenes = U.sanitizeText(source.analysis && (source.analysis.scene_descriptions_text || source.analysis.visual_notes) || 'clean close-up product footage', 260);
    const pageAngle = {
      alshihna: 'قدّم العرض بوضوح وبالفصحى، وركز على ما يظهر فعلاً في اللقطات.',
      maghrebtechstore: 'خليه تسويقي وتقني لمتجر، مع دعوة بسيطة للتواصل.',
      maghrebly: 'خليه قريب من الجالية وبدارجة مفهومة وبلا مبالغة.',
      mubadara: 'ركز على القيمة والاستعمال اليومي والثمن فقط إذا كان مؤكداً في المشروع.',
      tashilat: 'خليه مباشر وتقني، وذكر غير التفاصيل اللي باينة أو مؤكدة.',
      vouchteck: 'Make it concise, credible and useful for an English-speaking tech audience.',
      amazon_liquidation: 'ركز على التوفر والعرض، ولا تخترع الثمن إذا ما كانش مسجل في المشروع.',
    };
    // The fallback script honours the SAME production contract the writer prompt demands: price
    // first (only the confirmed project price — never invented), the profile's own sourcing angle
    // from the REAL n8n contract, the comment-CTA word from the engagement rule, and the COD
    // inspect-before-pay line for Moroccan COD profiles. A malformed model reply must still leave
    // every page with a contract-shaped draft instead of unbound prose.
    const fallbackScript = (pageKey, p, runAngle) => {
      const w = PAGE_WRITERS.writerFor(pageKey);
      // owner override 4: one natural sourcing angle per script, stripped of the parenthetical
      // gloss so the spoken line stays natural — never the same angle across all 7.
      const angle = String(runAngle || (w && w.sourcingAngles ? String(w.sourcingAngles).split('/')[0].trim() : (pageAngle[pageKey] || ''))).replace(/\s*\([^)]*\)/g, '').trim();
      const ctaWord = w && w.engagement && w.engagement.word ? w.engagement.word.split('/')[0].trim() : 'مهتم';
      // price first — the RESOLVED offer (owner override > page policy > n8n tier table), never a
      // made-up number: if nothing resolves, the script says the price is on the page instead.
      const offer = resolvePrice(pageKey);
      const selling = offer ? (offer.currency === '$' ? '$' + offer.amount : offer.label) : null;
      const market = offer && offer.market ? (offer.currency === '$' ? '$' + offer.market : String(offer.market)) : null;
      const priceLine = selling
        ? (pageKey === 'vouchteck'
          ? 'Only ' + selling + (market ? ' instead of ' + market : '') + ' for this ' + product + '.'
          : 'غير بـ' + selling + (market ? ' بدل ' + market : '') + '، هاد ' + product + ' غادي يفاجئك.')
        : (pageKey === 'vouchteck'
          ? 'This ' + product + ' is on the page at the current offer price.'
          : 'ثمن ' + product + ' الحالي باين فالصفحة، والعرض اللي معاه صعب تتخطاه.');
      const whyCheap = pageKey === 'vouchteck'
        ? 'It comes from ' + (angle || 'import surplus') + ' — that is why the price is this low.'
        : 'علاش بهاد الثمن؟ حيت جاي من ' + (angle || 'فائض الاستيراد') + '.';
      const body = pageKey === 'vouchteck'
        ? 'You see the phone itself in the footage: the unboxing, the finish, the ports and the camera detail.\nEverything shown stays grounded in what the clip actually displays.'
        : 'فلقطات كتشوف الهاتف بوحدو: فتح العلبة، الشكل، المنافذ وتفاصيل الكاميرا.\nكلشي اللي كنقولو مبني على اللي باين فعلاً فالفيديو.';
      const cod = pageKey === 'vouchteck' ? '' : '\nما تخلصش قبل ما يوصلك: تقلبو وتتأكد منو بعينيك، ومن بعد عاد تخلص.';
      const cta = pageKey === 'vouchteck'
        ? 'Write INTERESTED in the comments and the link reaches you directly.'
        : 'اكتب ' + ctaWord + ' فالتعليق وغادي يوصلك الرابط مباشرة.';
      return [priceLine, whyCheap, body, cod, cta].filter(Boolean).join('\n');
    };
    const writePageScript = async (pageKey, page, projectId, runAngle, runHooks) => {
      const writer = PAGE_WRITERS.writerFor(pageKey);
      // The REAL n8n production contract, with the per-run values injected the way the workflow's
      // {{$json.*}} expressions were. The output contract also asks for the page's real title
      // field (title_arabic / title_darija / title_english) and both captions.
      const offer = resolvePrice(pageKey);
      if (offer) offer.ctaStyle = (batch.ctaStyles || {})[pageKey] || null;
      const contract = PAGE_WRITERS.writerPromptBlock(pageKey, {
        product,
        brand: U.sanitizeText((source.analysis && source.analysis.brand) || (truth && truth.brand) || '', 60),
        category: U.sanitizeText((source.analysis && source.analysis.suggested_category) || 'product', 60),
        duration: (source.analysis && source.analysis.duration) || (sourceArt.probe && Math.round(sourceArt.probe.duration)) || '',
        firstAppearance: (source.analysis && source.analysis.product_first_appearance_sec) || '',
        scenes: U.sanitizeText(String((source.analysis && (source.analysis.scene_descriptions_text || source.analysis.visual_notes)) || 'unboxing and visible product details'), 900),
        sellingPrice: offer ? offer.label : null,
        monthly: !!(offer && offer.monthly),
        ctaStyle: offer && offer.ctaStyle || null,
        marketPrice: offer ? offer.market : null,
        // owner override 4: this run's ONE sourcing angle + the hooks already used by sibling
        // pages, so 7 scripts never come out near-identical.
        angle: runAngle || null,
        recentHooks: (runHooks && runHooks.length ? runHooks.slice(-6).join(' | ') : null),
      });
      const context = [
        contract,
        '',
        '=== GROUNDED INPUT ===',
        'product shown: ' + product,
        'category: ' + U.sanitizeText((source.analysis && source.analysis.suggested_category) || 'product', 60),
        'measured duration: ' + U.sanitizeText(String((source.analysis && source.analysis.duration) || sourceArt.probe && sourceArt.probe.duration || ''), 20),
        'visible footage summary: ' + U.sanitizeText(String((source.analysis && (source.analysis.scene_descriptions_text || source.analysis.visual_notes)) || 'unboxing and visible product details'), 900),
        'owner brief: ' + U.sanitizeText(String(brief || ''), 800),
        '',
        '=== OUTPUT CONTRACT ===',
        'Return JSON only: {"script_text":"...","sentences":["..."],"hook_style_used":"...","title_' + (writer ? writer.titleField.replace('title_', '') : 'darija') + '":"...","caption_social":"...","caption_social_ig":"..."}.',
        'Write spoken script text only. Do not dump timestamps, JSON, internal rules or English scene labels into the spoken script.',
        'Use only facts visible in the footage. Do not invent specifications, prices, stock, discounts or sourcing claims.',
      ].join('\n');
      const configuredWriter = legacy.providers && legacy.providers.pickOne('script', { page: pageKey });
      const chain = configuredWriter ? [configuredWriter] : [...new Set([(writer && writer.writerModel), page.model].filter(Boolean))];
      for (const writerModel of chain) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const raw = await legacy.llm.text(writerModel, context, 'script', { page: pageKey, project: projectId });
            const parsed = U.extractJSON(raw) || {};
            const text = String(parsed.script_text || (Array.isArray(parsed.sentences) ? parsed.sentences.join(' ') : '')).trim();
            // n8n parity: the workflow re-checks the language before accepting a draft (languageOk).
            // Owner rule (2026-09-23): the PRICE policy is enforced the same way — the draft must
            // open with the RESOLVED offer price and must not invent any other price ("no random
            // prices like 299 DH"). A violating draft is rejected and retried; the contract-shaped
            // fallback below always carries the correct price.
            const priceCheck = PAGE_WRITERS.priceContractOk(pageKey, text, offer);
            if (text.length >= 80 && text.length <= 1800 && PAGE_WRITERS.languageOk(pageKey, text) && priceCheck.ok) {
              const titleRaw = String(parsed[writer && writer.titleField || 'title_darija'] || '').trim() || null;
              return { text, mode: 'n8n-writer-contract', model: writerModel,
                // a title that invents a price is DROPPED (the title stage then derives one from
                // the price-first opening line) — a wrong number is never burned into the video.
                title: titleRaw && !PAGE_WRITERS.foreignPrices(titleRaw, offer).length ? titleRaw : null,
                caption_social: String(parsed.caption_social || '').trim() || null,
                caption_social_ig: String(parsed.caption_social_ig || '').trim() || null,
                hookStyle: String(parsed.hook_style_used || '').trim() || null };
            }
            log('warn', 'page.writer.bad_draft', { page: pageKey, model: writerModel, attempt, length: text.length, priceIssues: priceCheck.reasons });
          } catch (e) {
            log('warn', 'page.writer.failed', { page: pageKey, model: writerModel, attempt, error: e.message });
          }
        }
      }
      return { text: fallbackScript(pageKey, page, runAngle), mode: 'n8n-writer-contract-fallback', model: chain[0] || null };
    };
    const usedMusic = new Set();
    const output = [];
    const hooksUsed = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const page = store.page(key);
      const writer = PAGE_WRITERS.writerFor(key);
      // owner override 4: each page takes its OWN sourcing angle and sees the hooks its sibling
      // pages already used — the 7 scripts must never read near-identical.
      const runAngle = PAGE_WRITERS.angleFor(key, i);
      if (!page || page.role === 'orchestrator') { output.push({ page: key, status: 'failed', error: 'unknown page agent' }); continue; }
      ctx && ctx.progress && ctx.progress('building ' + page.label + ' (' + (i + 1) + '/' + keys.length + ')', Math.round(i * 100 / keys.length));
      let p = null;
      const artifacts = [];
      try {
        p = store.createProject(key, (source.title || 'Video') + ' — ' + page.label, {
          source: source.source || null, analysis: source.analysis || null, truth: source.truth || null,
          role: 'branch', branch: { page: key, pageLabel: page.label, fanout: true, mode, created: Date.now(),
            // The branch is pinned to the batch it was produced for: approvals, revisions and
            // renders resolve through THIS batch, so a newer import can never re-point it.
            batchId: batch ? batch.id : null },
        });
        store.linkArtifact(p.id, sourceArt.id, { op: 'source', label: 'Source for ' + page.label, kind: 'video', version: 1 });
        const lineage = [...new Set([...(source.transcriptions || []), ...(source.sharedTranscriptions || [])])];
        if (lineage.length) store.shareTranscription(p.id, lineage);
        const conv = store.conversation(key); conv.project = p.id; store.saveConversation(conv);

        // Script creation is deterministic at the orchestration boundary: it uses the persisted
        // footage truth and the page profile, so a slow/malformed model response can never leave a
        // page with prose but no artifact. Each page gets a distinct angle and durable record.
        const written = await writePageScript(key, page, p.id, runAngle, hooksUsed);
        const scriptText = written.text;
        hooksUsed.push(String(written.title || scriptText.split(/[.!?؟\n]/)[0] || '').replace(/\s+/g, ' ').trim().slice(0, 70));
        const script = store.addArtifact({ project: p.id, kind: 'script', op: 'script', attach: false,
          parent: store.project(p.id).current || null, text: scriptText, label: page.label + ' Script',
          params: { language: page.lang, generatedBy: 'page-profile-fanout', groundedProduct: product,
            // Stable profile binding: every downstream revision targets THIS profile by key,
            // never by fuzzy label matching, so 'change profile 3' can never touch profile 4.
            profileKey: key, profileLabel: page.label,
            writerMode: written.mode, writerModel: written.model,
            // n8n parity fields: the workflow's Parse Writer Output extracts exactly these.
            titleSuggested: written.title || null, titleField: writer ? writer.titleField : null,
            hookStyle: written.hookStyle || null,
            caption_social: written.caption_social || null,
            caption_social_ig: written.caption_social_ig || null,
            angle: String(runAngle || pageAngle[key] || 'page profile').replace(/\s*\([^)]*\)/g, '').trim(),
            writerContract: writer ? { language: writer.language, audience: writer.audience, landingPage: writer.landingPage, rules: writer.rules, engagement: writer.engagement && writer.engagement.word } : null } });
        artifacts.push({ kind: 'script', id: script.id });
        if (batch) store.setBatchArtifact(batch, key, 'script', script.id, mode === 'scripts_only' ? 'scripts' : batch.stage);

        // A scripts-first request is a hard stop after the ScriptArtifact. It must never
        // spend TTS/music/render quota or silently turn a review request into production.
        if (mode === 'scripts_only') {
          store.appendMessage(key, { role: 'agent', text: '✓ ' + page.label + ' ScriptArtifact ready for review.', artifacts: artifacts.map(x => x.id ? fmtArtifact(store.artifact(x.id)) : x), tools: [{ tool: 'pages.fanout', mode: 'scripts_only', ok: true }], project: p.id });
          output.push({ page: key, label: page.label, project: p.id, status: 'ready', artifacts });
          continue;
        }

        const voice = await tts({ page: key, project: p.id, text: script.text, voice: page.voice, rate: page.ttsRate || 1 });
        if (voice.artifact) artifacts.push({ kind: 'tts', id: voice.artifact.id });
        const voiceVideo = await media.applyOp(p.id, 'voiceover', { text: script.text, voice: page.voice, rate: page.ttsRate || 1, bed: 0.15 }, ctx || { progress() {}, note() {} });
        artifacts.push({ kind: 'video', id: voiceVideo.id, op: 'voiceover' });

        if (music) {
          const style = (page.prefs && page.prefs.musicStyle) || 'clean instrumental tech';
          const ms = await musicSearch(style + ' ' + key);
          const candidate = (ms.results || []).find(c => !usedMusic.has(c.id));
          if (candidate) {
            usedMusic.add(candidate.id);
            const mu = await useMusic({ id: candidate.id, page: key, project: p.id, volume: 0.18 });
            if (mu.artifact) artifacts.push({ kind: 'music', id: mu.artifact.id });
            const mixed = await media.applyOp(p.id, 'mix_music', { url: candidate.url, title: candidate.title, volume: 0.18 }, ctx || { progress() {}, note() {} });
            artifacts.push({ kind: 'video', id: mixed.id, op: 'mix_music' });
          } else artifacts.push({ kind: 'music', skipped: 'no unused licensed track was resolved for this page' });
        }
        let final = store.currentArtifact(p.id);
        if (render) {
          final = await media.applyOp(p.id, 'render', { mode: 'final' }, ctx || { progress() {}, note() {} });
          artifacts.push({ kind: 'video', id: final.id, op: 'render' });
        }
        // Description artifact — built from the n8n description template (landing link + CTA
        // line + the writer's captions), one per page, the way Meta_Publish_FB assembled it.
        const writerMeta = PAGE_WRITERS.writerFor(key);
        const scriptArt = store.artifact(artifacts.find(x => x.kind === 'script') && artifacts.find(x => x.kind === 'script').id);
        const descText = [
          writerMeta ? writerMeta.landingPage : '',
          '',
          '👇 للتوصل بالرابط اكتب ' + (writerMeta && writerMeta.engagement ? writerMeta.engagement.word.split('/')[0].trim() : 'مهتم'),
          (scriptArt && scriptArt.params && scriptArt.params.caption_social) || '',
        ].join('\n');
        const descIg = [
          writerMeta ? writerMeta.landingPage : '',
          '',
          '👇 للتوصل بالرابط اكتب ' + (writerMeta && writerMeta.engagement ? writerMeta.engagement.word.split('/')[0].trim() : 'مهتم'),
          (scriptArt && scriptArt.params && scriptArt.params.caption_social_ig) || '',
        ].join('\n');
        const descArt = store.addArtifact({ project: p.id, kind: 'description', op: 'description', attach: false,
          text: descText, label: page.label + ' Description',
          params: { platform: 'facebook', caption_ig: descIg, landingPage: writerMeta ? writerMeta.landingPage : null,
            engagementWord: writerMeta && writerMeta.engagement ? writerMeta.engagement.word : 'مهتم' } });
        artifacts.push({ kind: 'description', id: descArt.id });
        store.appendMessage(key, { role: 'agent', text: '✓ ' + page.label + ' production artifacts ready: script, voice' + (music ? ', music' : '') + (render ? ', final render' : '') + ', description', artifacts: artifacts.map(x => x.id ? fmtArtifact(store.artifact(x.id)) : x), tools: [{ tool: 'pages.fanout', ok: true }], project: p.id });
        output.push({ page: key, label: page.label, project: p.id, status: 'ready', artifacts });
      } catch (e) {
        output.push({ page: key, label: page.label, project: p && p.id || null, status: 'failed', error: U.sanitizeText(e.message, 300), artifacts });
      }
    }
    return { status: output.every(x => x.status === 'ready') ? 'ready' : 'partial', total: output.length, ready: output.filter(x => x.status === 'ready').length, failed: output.filter(x => x.status === 'failed').length, pages: output };
  };
  /**
   * finalVideoQC — deterministic delivery checks for a composed final VideoArtifact. Every check
   * here maps to an owner rule: file integrity, A/V streams, sane duration, no TTS truncation,
   * title burned, CTA card confined to the tail, the profile's OWN card.
   */
  function finalVideoQC(art, expect) {
    const issues = [];
    const p = (art && art.probe) || {};
    if (!art || !art.file || !fs.existsSync(art.file)) issues.push('final file missing on disk');
    else if (fs.statSync(art.file).size < 100000) issues.push('final file suspiciously small');
    if (!(p.duration > 3 && p.duration < 600)) issues.push('duration out of sane range (' + p.duration + 's)');
    if (p.hasVideo === false) issues.push('no video stream');
    if (p.hasAudio === false) issues.push('no audio stream');
    // TTS never cut: the composed duration must cover the voice (± tail/card allowance).
    if (expect.ttsDuration > 0 && p.duration > 0 && p.duration + 0.35 < expect.ttsDuration) issues.push('final video is shorter than the voice — TTS would be cut (' + p.duration + 's < ' + expect.ttsDuration + 's)');
    // Title: owner rule — every final shows one.
    if (!expect.titleText) issues.push('no title text to burn');
    const burned = art && art.params && art.params.burnedTitle;
    if (expect.titleText && burned !== expect.titleText) issues.push('title was not burned into the final render');
    // CTA card timing: card must NOT start at 0 — it belongs to the CTA tail only.
    const ovStart = expect.ctaOverlayStart;
    if (ovStart != null && p.duration > 0 && ovStart < p.duration * 0.4) issues.push('CTA card starts too early (' + ovStart + 's of ' + p.duration + 's)');
    return {
      ok: issues.length === 0,
      issues,
      summary: { duration: p.duration, width: p.width, height: p.height, title: burned || null, ctaStart: ovStart != null ? ovStart : null },
    };
  }

  /**
   * ctaStartSec — the second the spoken CTA begins, for ONE profile branch. Source of truth: the
   * profile's caption track (built from the real transcript). The CTA is the LAST script sentence,
   * so the last caption segment whose text shares words with the CTA line marks the card start.
   * Falls back to null → the append_cta op uses its bounded tail window.
   */
  function ctaStartSec(batch, key, projId) {
    try {
      const capArt = batchArtifactOf(batch, key, 'currentCaptionArtifactId');
      const track = capArt && capArt.params && capArt.params.track ? store.captionTrack(projId, capArt.params.track) : null;
      const segs = track && Array.isArray(track.segments) ? track.segments : null;
      if (segs && segs.length) {
        const scriptId = batch.profiles[key].currentScriptArtifactId;
        const script = scriptId ? store.artifact(scriptId) : null;
        const ctaLine = script ? String(script.text || '').trim().split(/[\n.!?؟]/).filter(Boolean).pop() : '';
        const words = w => String(w || '').toLowerCase().replace(/[^\u0600-\u06ff\w]+/g, ' ').split(/\s+/).filter(x => x.length > 2);
        const ctaWords = words(ctaLine);
        for (let i = segs.length - 1; i >= Math.max(0, segs.length - 4); i--) {
          const seg = segs[i];
          const overlap = words(seg.text).filter(w => ctaWords.includes(w)).length;
          if (ctaWords.length && overlap >= Math.max(2, Math.ceil(ctaWords.length * 0.4))) return Number(seg.start) || null;
        }
        // No textual match: the CTA is still the final sentence — the LAST caption segment starts it.
        return Number(segs[segs.length - 1].start) || null;
      }
    } catch (_) {}
    return null;
  }

  /**
   * agentServices.setPrice — the owner's explicit price override ("dir 200dh", "bdel taman l 100dh",
   * "tashilat 150 dh f chhar"). Records the override on the CURRENT batch for ONE profile (or all),
   * invalidates that branch's downstream artifacts, and reports the new offer. Money handling only:
   * no generation, no media, no render.
   */
  agentServices.setPrice = async ({ profile, amount, monthly, ctx }) => {
    const value = Number(amount);
    if (!isFinite(value) || value <= 0 || value > 100000) throw new Error('a valid price is required (e.g. 100, 200, 150 f chhar)');
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const all = ['all', 'ga3', 'kolchi', 'كلهم', 'الجميع', 'ga3chi'].includes(String(profile || '').trim().toLowerCase()) || !profile;
    const keys = Object.keys(batch.profiles);
    let targets;
    if (all) targets = keys;
    else {
      const wanted = norm(profile);
      targets = keys.filter(k => norm(k).includes(wanted) || norm(store.page(k).label).includes(wanted));
      if (targets.length > 1) throw new Error('"' + profile + '" matches several profiles (' + targets.join(', ') + ') — name one');
      if (!targets.length) throw new Error('no page profile matches "' + profile + '"');
    }
    batch.priceOverrides = batch.priceOverrides || {};
    const results = [];
    for (const k of targets) {
      const pol = PAGE_WRITERS.priceFor(k, { override: { amount: value, monthly: !!monthly } });
      batch.priceOverrides[k] = { amount: Math.round(value), monthly: !!monthly, at: Date.now() };
      // Downstream invalidation: the offer changed, so this branch's current script/TTS/etc are no
      // longer valid expressions of the price. Pointers are DROPPED for script and downstream so a
      // later stage re-resolves from regenerated work; nothing is deleted — versions remain history.
      const prof = batch.profiles[k] || {};
      prof.currentScriptArtifactId = null;
      prof.approvedScriptArtifactId = null;
      prof.currentTtsArtifactId = null;
      prof.currentTitleArtifactId = null;
      prof.currentCaptionArtifactId = null;
      prof.currentCtaArtifactId = null;
      prof.currentDescriptionArtifactId = null;
      prof.currentVideoArtifactId = null;
      prof.approvedVideoArtifactId = null;
      results.push({ page: k, label: store.page(k).label, price: pol.amount + ' ' + pol.currency + (pol.monthly ? '/شهر' : ''), overridden: true });
    }
    batch.stage = 'scripts';
    batch.updated = Date.now();
    store.saveBatch(batch);
    store.appendMessage(ctx && ctx.page || 'studio', { role: 'agent',
      text: '✓ Price set to ' + value + (monthly ? ' per month' : '') + ' for: ' + results.map(r => r.label).join(', ') + '. Say "create the 7 scripts" to regenerate with the new price.',
      tools: [{ tool: 'pages.setPrice', ok: true }], project: null });
    return { ok: true, updated: results, note: 'Only these branches were invalidated. Regenerate their scripts next.' };
  };

  /**
   * agentServices.setCtaStyle — the owner's explicit CTA preference for ONE profile or all
   * ("use link in bio", "bdel CTA l link f bio", "comment CTA"). Configuration only: nothing is
   * generated here; the NEXT script generation honours it through the writer contract.
   */
  agentServices.setCtaStyle = async ({ profile, style, ctx }) => {
    const s = String(style || '').toLowerCase();
    const kind = /link|bio|بايو|bayo/.test(s) ? 'link_bio' : /comment|كومنت|مهتم|interested/.test(s) ? 'comment' : null;
    if (!kind) throw new Error('CTA style must be "link_bio" or "comment"');
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const norm = w => String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = Object.keys(batch.profiles);
    let targets;
    if (!profile || ['all', 'ga3', 'kolchi'].includes(String(profile).trim().toLowerCase())) targets = keys;
    else {
      const wanted = norm(profile);
      targets = keys.filter(k => norm(k).includes(wanted) || norm(store.page(k).label).includes(wanted));
      if (targets.length > 1) throw new Error('"' + profile + '" matches several profiles — name one');
      if (!targets.length) throw new Error('no profile matches "' + profile + '"');
    }
    batch.ctaStyles = batch.ctaStyles || {};
    for (const k of targets) batch.ctaStyles[k] = kind;
    batch.updated = Date.now();
    store.saveBatch(batch);
    store.appendMessage(ctx && ctx.page || 'studio', { role: 'agent',
      text: '✓ CTA style set to ' + kind + ' for: ' + targets.map(k => store.page(k).label).join(', ') + '. New scripts will use it.',
      tools: [{ tool: 'pages.setCtaStyle', ok: true }], project: null });
    return { ok: true, pages: targets, style: kind };
  };

  /**
   * agentServices.ttsAll — the GENERATE_TTS stage.
   * Resolves each profile's CURRENT script artifact (its newest fanout project) and produces
   * exactly one TTSArtifact per profile. HARD BOUNDARY: no applyOp of any kind runs here — no
   * voiceover video, no music, no render. A failing profile records the real error and the others
   * still complete. Nothing is claimed to exist on trust: an existing TTS is reused ONLY after
   * verifyTtsArtifact proves a real playable file for THIS profile + THIS script.
   */
  agentServices.ttsAll = async ({ pages, ctx }) => {
    const keys = (Array.isArray(pages) && pages.length ? pages : store.pages().filter(p => p.role !== 'orchestrator').map(p => p.key))
      .map(x => String(x).replace(/[^a-z0-9_]/gi, '')).filter((x, i, a) => a.indexOf(x) === i);
    // Batch-first resolution: the scripts to speak are the CURRENT batch's approved-or-current
    // scripts. A newest-fanout-scan here is exactly what let an older batch's scripts get spoken.
    const batch = store.currentBatch();
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const page = store.page(key);
      if (!page || page.role === 'orchestrator') { out.push({ page: key, status: 'failed', error: 'unknown profile' }); continue; }
      ctx && ctx.progress && ctx.progress('voice for ' + page.label + ' (' + (i + 1) + '/' + keys.length + ')', Math.round(i * 100 / keys.length));
      let proj = null, script = null;
      if (batch) {
        const scriptId = (batch.profiles[key] || {}).approvedScriptArtifactId || (batch.profiles[key] || {}).currentScriptArtifactId;
        script = scriptId ? store.artifact(scriptId) : null;
        if (script) proj = store.project(script.project);
      }
      if (!proj) {
        // No batch (or the batch has no script for this profile yet): fall back to the profile's
        // newest fanout project so TTS still works for pre-batch sessions, but ONLY from a
        // fanout/delegated branch — never from an arbitrary unrelated project.
        proj = store.listProjects(key).map(x => store.project(x.id))
          .filter(p => p && p.branch && p.branch.fanout)
          .sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
        script = proj ? [...(proj.artifacts || [])].map(id => store.artifact(id)).filter(a => a && a.op === 'script')
          .sort((a, b) => (b.version || 0) - (a.version || 0))[0] : null;
      }
      if (!script || !script.text) { out.push({ page: key, label: page.label, status: 'failed', error: 'no script artifact for this profile yet — create the 7 scripts first' }); continue; }
      try {
        // fix: NEVER trust a pointer or a chat line saying "already generated" — reuse an existing
        // TTS ONLY when it verifies as a real playable file for THIS profile + THIS script.
        const pointed = batch && batch.profiles[key] && batch.profiles[key].currentTtsArtifactId
          ? store.artifact(batch.profiles[key].currentTtsArtifactId) : null;
        const check = await verifyTtsArtifact(pointed, { profileKey: key, scriptId: script.id, batch });
        if (check.ok) {
          out.push({ page: key, label: page.label, project: pointed.project, status: 'ready', reused: true, script: script.id, tts: pointed.id, version: pointed.version, artifacts: [pointed] });
          continue;
        }
        const voice = await tts({ page: key, project: proj.id, text: script.text, voice: page.voice, rate: page.ttsRate || 1, scriptId: script.id, profileKey: key });
        if (!voice.artifact) throw new Error('tts produced no artifact');
        const art = store.artifact(voice.artifact.id);
        out.push({ page: key, label: page.label, project: proj.id, status: 'ready', script: script.id, tts: art.id, version: art.version, artifacts: [art] });
      } catch (e) {
        out.push({ page: key, label: page.label, project: proj.id, status: 'failed', script: script && script.id, error: U.sanitizeText(e.message, 240) });
      }
    }
    const ready = out.filter(x => x.status === 'ready');
    const failed = out.filter(x => x.status === 'failed');
    return { ok: true, status: failed.length ? (ready.length ? 'partial' : 'failed') : 'ready',
      total: out.length, ready: ready.length, reused: out.filter(x => x.reused).length, failed: failed.length,
      errors: failed.map(f => f.label + ': ' + f.error), pages: out };
  };

  /**
   * agentServices.titlesAll — the GENERATE_TITLES stage.
   * Titles already exist on the approved scripts (the n8n writer contract returns title_darija /
   * title_english etc. alongside the script). This stage promotes those owner-suggested titles
   * into batch title pointers — NO model call, NO media, NO render. A profile whose script has
   * no suggested title (rare) gets a deterministic fallback built from the product + price so
   * the owner always has something to approve or edit.
   */
  agentServices.titlesAll = async ({ pages, ctx }) => {
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const keys = (Array.isArray(pages) && pages.length ? pages : Object.keys(batch.profiles))
      .map(x => String(x).replace(/[^a-z0-9_]/gi, '')).filter((x, i, a) => a.indexOf(x) === i);
    const out = [];
    for (const key of keys) {
      const prof = batch.profiles[key];
      const scriptId = prof && (prof.approvedScriptArtifactId || prof.currentScriptArtifactId);
      const script = scriptId ? store.artifact(scriptId) : null;
      if (!script) { out.push({ page: key, status: 'failed', error: 'no script for this profile yet' }); continue; }
      let title = (script.params && script.params.titleSuggested) || null;
      if (!title) {
        const first = String(script.text || '').split(/[.!\n]/)[0].trim().slice(0, 60);
        title = first || store.page(key).label;
      }
      const art = store.addArtifact({ project: script.project, kind: 'title', op: 'title', attach: false,
        text: title, label: store.page(key).label + ' Title',
        params: { profileKey: key, language: script.params && script.params.language, sourceScript: script.id, suggestedBy: 'n8n-writer-contract' } });
      store.setBatchArtifact(batch, key, 'title', art.id, 'titles');
      out.push({ page: key, label: store.page(key).label, status: 'ready', title: art.id, text: title });
      ctx && ctx.progress && ctx.progress('title for ' + store.page(key).label, Math.round(out.length * 100 / keys.length));
    }
    const ready = out.filter(x => x.status === 'ready').length;
    return { ok: true, status: ready === keys.length ? 'ready' : 'partial', total: keys.length, ready, failed: keys.length - ready, pages: out,
      note: 'Titles are SUGGESTIONS. Nothing is burned into any video until you approve them ("all titles are good") or ask to change one.' };
  };

  /**
   * stageKeys — the 7 profile keys for a batch-stage operation, validating that each profile has
   * the upstream artifacts the stage needs. Returns { keys, missing } where missing maps profile
   * → reason it cannot run yet; the stage reports those honestly instead of failing silently.
   */
  function stageKeys(batch, need, pages) {
    // `pages` = the EXPLICIT subset the caller asked for. One command = one stage, and a retry
    // runs only the profiles named (owner rule 2026-09-23) — without this filter a "retry
    // mubadara" silently re-transcribed all 7 profiles.
    const wanted = (Array.isArray(pages) && pages.length)
      ? pages.map(x => String(x).replace(/[^a-z0-9_]/gi, '')).filter((x, i, a) => a.indexOf(x) === i)
      : null;
    const keys = Object.keys(batch.profiles).filter(k => !wanted || wanted.includes(k));
    const missing = {};
    for (const key of keys) {
      const prof = batch.profiles[key];
      for (const [field, label] of need) {
        if (!prof[field]) { missing[key] = 'no ' + label + ' for this profile yet'; break; }
      }
    }
    return { keys, missing };
  }
  /** batchArtifactOf — resolve a batch pointer to a live artifact record (or null). */
  function batchArtifactOf(batch, key, field) {
    const id = (batch.profiles[key] || {})[field];
    return id ? store.artifact(id) : null;
  }

  /**
   * agentServices.musicAll — the ADD_MUSIC stage. Picks ONE distinct licensed track per profile
   * (no track reused across profiles in the batch) and records a durable playable MusicArtifact.
   * HARD BOUNDARY: no mixing into any video — that happens at render. The chosen track/URL is
   * stored in the artifact params so the render stage can mix it without re-searching.
   */
  agentServices.musicAll = async ({ pages, ctx }) => {
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const { keys, missing } = stageKeys(batch, [['currentTtsArtifactId', 'TTS artifact']], pages);
    const out = [];
    const usedMusic = new Set();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (missing[key]) { out.push({ page: key, status: 'failed', error: missing[key] }); continue; }
      const page = store.page(key);
      ctx && ctx.progress && ctx.progress('music for ' + page.label + ' (' + (i + 1) + '/' + keys.length + ')', Math.round(i * 100 / keys.length));
      try {
        // Owner rule 2026-09-23: ad-appropriate, instrumental, calm commercial beds. Rotate the
        // style phrasing per profile AND per run so each profile gets a fitting (and distinct)
        // track — never one static query for every page.
        const MUSIC_STYLES = [
          'ambient technology instrumental', 'soft upbeat commercial instrumental',
          'minimal electronic background', 'clean corporate ambient',
          'light product showcase instrumental', 'modern neutral tech background',
        ];
        const run = Math.floor(Date.now() / 86400000);
        const style = (page.prefs && page.prefs.musicStyle)
          || MUSIC_STYLES[(keys.indexOf(key) + run) % MUSIC_STYLES.length];
        let ms = await musicSearch(style);
        // Same-track protection across the batch: skip anything already used this run.
        const free = r => (ms.results || []).filter(c => !usedMusic.has(c.id));
        let candidate = free().find(c => /instrumental|ambient|background|loop|theme/i.test(c.title)) || free()[0] || null;
        if (!candidate) {
          // Style pool dry — fall through the remaining styles before failing.
          for (const alt of MUSIC_STYLES) {
            if (alt === style) continue;
            ms = await musicSearch(alt);
            candidate = free().find(c => /instrumental|ambient|background|loop|theme/i.test(c.title)) || free()[0] || null;
            if (candidate) break;
          }
        }
        if (!candidate) { out.push({ page: key, label: page.label, status: 'failed', error: 'no unused ad-appropriate music track found' }); continue; }
        usedMusic.add(candidate.id);
        // 0.12 gain: the voice must stay clearly dominant (owner rule 16) — previously 0.18.
        const mu = await useMusic({ id: candidate.id, page: key, project: batchArtifactOf(batch, key, 'currentScriptArtifactId') ? store.artifact(batch.profiles[key].currentScriptArtifactId).project : null, volume: 0.12 });
        if (!mu.artifact) throw new Error('music artifact was not created');
        store.setBatchArtifact(batch, key, 'music', mu.artifact.id, 'music');
        out.push({ page: key, label: page.label, status: 'ready', music: mu.artifact.id, title: candidate.title, url: candidate.url, artifacts: [store.artifact(mu.artifact.id)] });
      } catch (e) {
        out.push({ page: key, label: page.label, status: 'failed', error: U.sanitizeText(e.message, 240) });
      }
    }
    const ready = out.filter(x => x.status === 'ready');
    const failed = out.filter(x => x.status === 'failed');
    return { ok: true, status: failed.length ? (ready.length ? 'partial' : 'failed') : 'ready', total: out.length, ready: ready.length, failed: failed.length,
      errors: failed.map(f => f.label + ': ' + f.error), pages: out };
  };

  /**
   * agentServices.captionsAll — the ADD_CAPTIONS stage. Transcribes each profile's ACTUAL TTS
   * audio (owner rule: the subtitle source of truth is the TTS file itself — never the music-only
   * source clip, never model-invented text), builds a real timed caption track, and burns it into
   * a preview so the owner can SEE the captions. verify-then-reuse: a healthy caption for the
   * CURRENT TTS is reused; anything missing, garbage (ASR apology text) or stale is regenerated
   * (force=true always regenerates). HARD BOUNDARY: no final render, no CTA card, no publish.
   * The burned preview becomes the profile's currentCaptionArtifactId.
   */
  agentServices.captionsAll = async ({ pages, force, ctx }) => {
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const { keys, missing } = stageKeys(batch, [['currentTtsArtifactId', 'TTS artifact']], pages);
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (missing[key]) { out.push({ page: key, status: 'failed', error: missing[key] }); continue; }
      const page = store.page(key);
      ctx && ctx.progress && ctx.progress('captions for ' + page.label + ' (' + (i + 1) + '/' + keys.length + ')', Math.round(i * 100 / keys.length));
      try {
        // Subtitle source of truth = the ACTUAL TTS audio (owner rule 2026-09-23):
        // TTSArtifact → transcription → timed caption track → burn. The TTS wav starts at t=0 of
        // the voiceover mix, so its timings map 1:1 onto the final video. Transcribing the
        // music-only source clip is what once burned the ASR's apology as a subtitle.
        const ttsId = batch.profiles[key].currentTtsArtifactId;
        const ttsArt = store.artifact(ttsId);
        const projId = ttsArt.project;
        // verify-then-reuse (never trust a pointer or a chat line): reuse ONLY a caption whose
        // track has real (non-refusal) segments AND was transcribed from the CURRENT TTS audio.
        if (!force) {
          const cur = batchArtifactOf(batch, key, 'currentCaptionArtifactId');
          const curTrack = cur && cur.params && cur.params.track ? store.captionTrack(projId, cur.params.track) : null;
          const curTr = curTrack && curTrack.sourceTranscription ? store.transcription(projId, curTrack.sourceTranscription) : null;
          const segsReal = !!(curTrack && Array.isArray(curTrack.segments) && curTrack.segments.length
            && !(transcribe.isRefusalText && curTrack.segments.some(s => transcribe.isRefusalText(s.text))));
          const fromCurrentTts = !!(curTr && !curTr.unsegmented && curTr.sourceArtifact === ttsId);
          if (cur && cur.file && fs.existsSync(cur.file) && segsReal && fromCurrentTts) {
            out.push({ page: key, label: page.label, status: 'ready', reused: true, caption: cur.id });
            continue;
          }
        }
        // Language hint from the page recipe so the transcript (and therefore the burned
        // subtitles) stay in the profile's real language — no cross-language drift.
        const w = PAGE_WRITERS.writerFor(key);
        const asrLang = w && w.outputLang === 'english' ? 'en' : 'ar';
        const tr = await transcribe.run({ projectId: projId, artifactId: ttsId, language: asrLang, force: !!force, progress() {}, note() {} });
        if (tr.transcription.unsegmented || !tr.transcription.segments.length) {
          throw new Error('the transcription returned no timed segments — captions need real timings, never invented ones');
        }
        const track = captions.createTrack({ projectId: projId, page: key, transcriptionId: tr.transcription.id, preset: (page.production && page.production.captionPreset) || 'bold_social' });
        const art = await burnCaptions({ project: projId, track: track.id, ctx: { progress() {}, note() {} } });
        store.setBatchArtifact(batch, key, 'caption', art.id, 'captions');
        out.push({ page: key, label: page.label, status: 'ready', caption: art.id, segments: art.segments, artifacts: [art] });
      } catch (e) {
        out.push({ page: key, label: page.label, status: 'failed', error: U.sanitizeText(e.message, 240) });
      }
    }
    const ready = out.filter(x => x.status === 'ready');
    const failed = out.filter(x => x.status === 'failed');
    return { ok: true, status: failed.length ? (ready.length ? 'partial' : 'failed') : 'ready', total: out.length, ready: ready.length, failed: failed.length,
      errors: failed.map(f => f.label + ': ' + f.error), pages: out };
  };

  /**
   * agentServices.ctaAll — the APPLY_CTA stage. Appends each profile's OWN production CTA card
   * (from page.production.ctaAssets — the n8n-derived asset) to that profile's current video.
   * HARD BOUNDARY: no description generation, no render, no publish.
   */
  agentServices.ctaAll = async ({ pages, ctx }) => {
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const { keys, missing } = stageKeys(batch, [['currentTtsArtifactId', 'TTS artifact']], pages);
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (missing[key]) { out.push({ page: key, status: 'failed', error: missing[key] }); continue; }
      const page = store.page(key);
      ctx && ctx.progress && ctx.progress('CTA card for ' + page.label + ' (' + (i + 1) + '/' + keys.length + ')', Math.round(i * 100 / keys.length));
      try {
        const projId = store.artifact(batch.profiles[key].currentScriptArtifactId).project;
        // Owner rule: the card appears WHEN the spoken CTA starts. The CTA start second comes from
        // the profile's real caption/transcript timing (the last caption segment that matches the
        // CTA words), falling back to a bounded tail when timing is unavailable.
        const ctaStart = ctaStartSec(batch, key, projId);
        const art = await media.applyOp(projId, 'append_cta', { platform: 'facebook', ctaStartSec: ctaStart }, { progress() {}, note() {} });
        store.setBatchArtifact(batch, key, 'cta', art.id, 'cta');
        out.push({ page: key, label: page.label, status: 'ready', cta: art.id, ctaStartSec: ctaStart, overlayStart: art.params && art.params.overlayStart });
      } catch (e) {
        out.push({ page: key, label: page.label, status: 'failed', error: U.sanitizeText(e.message, 240) });
      }
    }
    const ready = out.filter(x => x.status === 'ready');
    const failed = out.filter(x => x.status === 'failed');
    return { ok: true, status: failed.length ? (ready.length ? 'partial' : 'failed') : 'ready', total: out.length, ready: ready.length, failed: failed.length,
      errors: failed.map(f => f.label + ': ' + f.error), pages: out };
  };

  /**
   * agentServices.descriptionsAll — the DESCRIPTIONS stage. One DescriptionArtifact per profile,
   * from the profile's OWN n8n description template (landing link + engagement CTA + the writer's
   * social captions), with the Instagram variant carried alongside. HARD BOUNDARY: text only.
   */
  agentServices.descriptionsAll = async ({ pages, ctx }) => {
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    const { keys, missing } = stageKeys(batch, [['currentScriptArtifactId', 'script']], pages);
    const out = [];
    for (const key of keys) {
      if (missing[key]) { out.push({ page: key, status: 'failed', error: missing[key] }); continue; }
      const page = store.page(key);
      try {
        const script = store.artifact(batch.profiles[key].currentScriptArtifactId);
        const writerMeta = PAGE_WRITERS.writerFor(key);
        const word = writerMeta && writerMeta.engagement ? writerMeta.engagement.word.split('/')[0].trim() : 'مهتم';
        const descText = [writerMeta ? writerMeta.landingPage : '', '', '👇 للتوصل بالرابط اكتب ' + word, (script.params && script.params.caption_social) || ''].join('\n');
        const descIg = [writerMeta ? writerMeta.landingPage : '', '', '👇 للتوصل بالرابط اكتب ' + word, (script.params && script.params.caption_social_ig) || ''].join('\n');
        const art = store.addArtifact({ project: script.project, kind: 'description', op: 'description', attach: false,
          text: descText, label: page.label + ' Description',
          params: { profileKey: key, platform: 'facebook', caption_ig: descIg, landingPage: writerMeta ? writerMeta.landingPage : null, engagementWord: word, sourceScript: script.id } });
        store.setBatchArtifact(batch, key, 'description', art.id, 'descriptions');
        out.push({ page: key, label: page.label, status: 'ready', description: art.id });
      } catch (e) {
        out.push({ page: key, label: page.label, status: 'failed', error: U.sanitizeText(e.message, 240) });
      }
    }
    const ready = out.filter(x => x.status === 'ready').length;
    return { ok: true, status: ready === keys.length ? 'ready' : 'partial', total: keys.length, ready, failed: keys.length - ready,
      errors: out.filter(x => x.status === 'failed').map(f => (f.label || f.page) + ': ' + f.error), pages: out };
  };

  /**
   * agentServices.renderAll — the RENDER_FINAL stage, the ONLY path that creates VideoArtifacts
   * for the batch. Each profile branch composes from ITS OWN current pointers: source + voiceover
   * (the script's TTS is spoken again through the deterministic cache — same text/voice = same
   * file, zero new model calls) + music mix + captions burn + CTA card + final encode. A profile
   * whose composition fails is reported FAILED and the others still complete; retry runs only
   * what is asked. No publish of any kind happens here.
   */
  agentServices.renderAll = async ({ pages, ctx }) => {
    const batch = store.currentBatch();
    if (!batch) throw new Error('no current production batch — import a source first');
    // Owner rule 2026-09-23 (partial-failure recovery): a retry runs ONLY the profiles asked for
    // — never a costly full-batch re-render because one profile failed (stageKeys filters).
    const { keys, missing } = stageKeys(batch, [['currentScriptArtifactId', 'script'], ['currentTtsArtifactId', 'TTS artifact']], pages);
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (missing[key]) { out.push({ page: key, status: 'failed', error: missing[key] }); continue; }
      const page = store.page(key);
      ctx && ctx.progress && ctx.progress('final render for ' + page.label + ' (' + (i + 1) + '/' + keys.length + ')', Math.round(i * 100 / keys.length));
      try {
        const script = store.artifact(batch.profiles[key].currentScriptArtifactId);
        const projId = script.project;
        const cctx = { progress() {}, note() {} };
        // 1. voiceover mix (source + THIS profile's already-generated TTS file; the audioFile path
        //    makes the op reuse it verbatim — zero new model calls, zero new quota spent)
        const ttsArt = store.artifact(batch.profiles[key].currentTtsArtifactId);
        if (!ttsArt || !ttsArt.file || !fs.existsSync(ttsArt.file)) throw new Error('the TTS file for this profile is missing on disk — regenerate the TTS first');
        let cur = await media.applyOp(projId, 'voiceover', { text: script.text, voice: ttsArt.params && ttsArt.params.voice || page.voice, rate: page.ttsRate || 1, bed: 0.15, audioFile: ttsArt.file }, cctx);
        // 2. music mix, ONLY from this profile's recorded batch music. 0.12 keeps the TTS clearly
        // dominant (owner rule: music must sit behind the voice).
        const musicArt = batchArtifactOf(batch, key, 'currentMusicArtifactId');
        if (musicArt && musicArt.params && musicArt.params.url) cur = await media.applyOp(projId, 'mix_music', { url: musicArt.params.url, title: musicArt.params.title || 'music', volume: Math.min(Number(musicArt.params.volume) || 0.12, 0.15) }, cctx);
        // 3. captions: re-burn from this profile's caption track if it exists (idempotent via the
        //    artifact already carrying the burn); otherwise render without burning.
        const capArt = batchArtifactOf(batch, key, 'currentCaptionArtifactId');
        if (capArt && capArt.params && capArt.params.track) {
          const track = store.captionTrack(projId, capArt.params.track);
          if (track) {
            const lines = captions.toLines(track);
            // Owner fix (2026-09-27): burn the WRAPPED display text, never the raw segment — raw
            // lines are what pushed subtitles off the sides of 9:16 frames.
            if (lines.length) {
              // Owner fix (2026-09-28): cap the burned caption size for 9:16 — old tracks saved
              // size 72 which overflowed the frame width and was cut at both sides.
              const safeStyle = { ...(track.style || {}), size: Math.min(Number((track.style || {}).size) || 64, 56) };
              cur = await media.applyOp(projId, 'burn_subs', { lines: JSON.stringify(lines.map(l => ({ start: l.start, end: l.end, text: captions.wrap(l.text, safeStyle.maxCharsPerLine || 18, safeStyle.maxLines || 2) }))), style: JSON.stringify(safeStyle) }, cctx);
            }
          }
        }
        // 4. the TITLE — owner rule: every final video shows one. From the profile's own
        //    TitleArtifact (writer-suggested, owner-approved). Owner fix (2026-09-27): the title
        //    sits CENTER of frame (ass an5 middle-center) with a dark box, not near the top.
        const titleArt = batchArtifactOf(batch, key, 'currentTitleArtifactId');
        const titleText = titleArt && titleArt.text ? String(titleArt.text).trim() : null;
        // 5. this profile's OWN CTA card (never another page's card), timed to the spoken CTA.
        //    The existing overlay is reused ONLY while its timing still matches the spoken CTA —
        //    a re-transcribed caption track moves the CTA start, and blindly reusing the old
        //    overlay is what put the card at 4.5s mid-video (2026-09-23 bug).
        //    Owner rule (2026-09-27): reuse is FORBIDDEN for the owner-refreshed bio-link cards —
        //    a stale pre-2026-09-27 card must never survive into a new final.
        const ctaStart = ctaStartSec(batch, key, projId);
        let ctaArt = batchArtifactOf(batch, key, 'currentCtaArtifactId');
        const ctaTimingCurrent = !!(ctaArt && ctaArt.op === 'append_cta' && ctaArt.params && ctaArt.params.overlayStart != null
          && ctaArt.params.recipe === 'cta-timed-card-concat'
          && (ctaStart == null || Math.abs(Number(ctaArt.params.overlayStart) - Number(ctaStart)) <= 0.75));
        if (!ctaTimingCurrent) {
          const cta = await media.applyOp(projId, 'append_cta', { platform: 'facebook', ctaStartSec: ctaStart }, cctx).catch(() => null);
          if (cta) { store.setBatchArtifact(batch, key, 'cta', cta.id, 'cta'); ctaArt = cta; cur = cta; }
        }
        // Owner fix (2026-09-27, part 2): a CTA whose window was cut off by the OLD 4.5s card
        // (EOF-repeat showed a black tail) must be re-applied against the new 12s card.
        if (ctaArt && ctaArt.params && Number(ctaArt.params.cardDuration) <= 5) {
          const cta2 = await media.applyOp(projId, 'append_cta', { platform: 'facebook', ctaStartSec: ctaStart }, cctx).catch(() => null);
          if (cta2) { store.setBatchArtifact(batch, key, 'cta', cta2.id, 'cta'); ctaArt = cta2; cur = cta2; }
        }
        // 6. final encode with the title burned CENTER (position:center → ass an5)
        cur = await media.applyOp(projId, 'render', { mode: 'final',
          title: titleText ? JSON.stringify({ text: titleText, at: 0.2, duration: 3.4 }) : '',
          titleStyle: JSON.stringify({ position: 'center', size: 58 }) }, cctx);
        // 7. FINAL QC GATE (owner rule 26) — the video is only READY when the composition facts
        //    hold: real file, both streams, sane duration, TTS present (never cut), title burned,
        //    CTA card only in the tail window, correct profile card. A failed check marks this
        //    profile FAILED instead of registering a fake-ready artifact.
        // QC sees the CTA artifact that was ACTUALLY applied (fresh one when re-timed, existing
        // one when reused) and the REAL TTS duration — the stale read is what let a mid-video
        // card pass QC on first render.
        const qc = finalVideoQC(cur, { titleText, key,
          ttsDuration: (ttsArt.params && ttsArt.params.ttsDuration) || (ttsArt.probe && ttsArt.probe.duration) || 0,
          ctaOverlayStart: ctaArt && ctaArt.params && ctaArt.params.overlayStart });
        if (!qc.ok) {
          out.push({ page: key, label: page.label, status: 'failed', error: 'QC failed: ' + qc.issues.join('; ') });
          continue;
        }
        store.setBatchArtifact(batch, key, 'video', cur.id, 'final_render');
        // artifacts array: the agent turn's card collector reads result.pages[*].artifacts —
        // without it the finished videos never appear as playable cards in the chat (the
        // TTS stage rows carry the same field; the render stage must too).
        out.push({ page: key, label: page.label, status: 'ready', video: cur.id, artifacts: [cur], file: cur.file, duration: cur.probe && cur.probe.duration, qc: qc.summary });
      } catch (e) {
        out.push({ page: key, label: page.label, status: 'failed', error: U.sanitizeText(e.message, 300) });
      }
    }
    const ready = out.filter(x => x.status === 'ready');
    const failed = out.filter(x => x.status === 'failed');
    return { ok: true, status: failed.length ? (ready.length ? 'partial' : 'failed') : 'ready', total: out.length, ready: ready.length, failed: failed.length,
      errors: failed.map(f => f.label + ': ' + f.error), pages: out };
  };

  /**
   * agentServices.appendArtifacts — post a chat message that carries REAL artifact cards (the same
   * format the conversation renderer already plays). Used by display-only commands like "show the
   * final videos": the batch pointers resolve, the cards attach, nothing regenerates.
   */
  agentServices.appendArtifacts = ({ owner, text, artifacts }) => {
    store.appendMessage(owner || 'studio', {
      role: 'agent', text: text || '',
      artifacts: (artifacts || []).map(fmtArtifact), tools: [{ tool: 'batch.show', ok: true }], project: null,
    });
    return { attached: (artifacts || []).length };
  };

  agentServices.fanoutAttach = ({ pages, owner }) => {
    const keys = (Array.isArray(pages) && pages.length ? pages : store.pages().filter(p => p.role !== 'orchestrator').map(p => p.key))
      .map(x => String(x).replace(/[^a-z0-9_]/gi, '')).filter((x, i, a) => a.indexOf(x) === i);
    const batch = store.currentBatch();
    const rows = [];
    for (const key of keys) {
      let arts = [], scriptsOnly = false, projId = null;
      const prof = batch && batch.profiles && batch.profiles[key];
      if (prof) {
        // CURRENT pointers only — history versions never surface as current outputs: one current
        // script / TTS / title / … per profile, never 14 or 21 cards.
        const ids = [prof.currentScriptArtifactId, prof.currentTtsArtifactId, prof.currentTitleArtifactId, prof.currentMusicArtifactId,
          prof.currentCaptionArtifactId, prof.currentCtaArtifactId, prof.currentDescriptionArtifactId, prof.currentVideoArtifactId];
        arts = [...new Set(ids.filter(Boolean))].map(id => store.artifact(id)).filter(Boolean);
        projId = arts.length ? arts[0].project : null;
      } else {
        const candidates = store.listProjects(key).map(x => store.project(x.id)).filter(p => p && p.branch && p.branch.fanout);
        const p = candidates.sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
        if (!p) continue;
        projId = p.id;
        scriptsOnly = p.branch.mode === 'scripts_only';
        const all = (p.artifacts || []).map(id => store.artifact(id)).filter(Boolean);
        // one CURRENT artifact per kind (highest version) — never every historical version
        const byKind = new Map();
        for (const a of all.slice().sort((x, y) => (x.version || 0) - (y.version || 0))) byKind.set(a.kind + ':' + a.op, a);
        arts = [...byKind.values()];
        if (scriptsOnly) arts = arts.filter(a => a.kind === 'script');
      }
      rows.push({ page: key, label: store.page(key).label, project: projId, scriptsOnly, artifacts: arts });
    }
    const flat = rows.flatMap(r => r.artifacts);
    const allScriptsOnly = rows.length > 0 && rows.every(r => r.scriptsOnly);
    store.appendMessage(owner || 'studio', {
      role: 'agent',
      text: allScriptsOnly
        ? '✓ Attached ' + flat.length + ' ScriptArtifacts to the Studio: ' + rows.map(r => r.label).join(', ')
        : '✓ Attached ' + rows.length + ' page productions to the Studio: ' + rows.map(r => r.label).join(', '),
      artifacts: flat.map(fmtArtifact), tools: [{ tool: 'pages.fanout.attach', ok: true }], project: null,
    });
    // Keep the script deliverables independently addressable in chat. This avoids making a
    // mixed media comparison grid the only place where text artifacts can be discovered.
    const scripts = flat.filter(a => a && a.kind === 'script');
    if (scripts.length && !allScriptsOnly) store.appendMessage(owner || 'studio', {
      role: 'agent',
      text: '✓ ' + scripts.length + ' ScriptArtifacts ready — one grounded script for each page.',
      artifacts: scripts.map(fmtArtifact), tools: [{ tool: 'pages.fanout.scripts', ok: true }], project: null,
    });
    return { attached: rows.length, pages: rows.map(r => ({ page: r.page, project: r.project, artifacts: r.artifacts.map(a => a.id) })) };
  };

  /**
   * reviseScript — the deterministic single-profile script revision path.
   *
   * The orchestrator previously handled "change profile 3's hook" with page.ask, which runs a free
   * page turn and can rewrite sibling scripts or spawn label-less duplicates. This service pins the
   * revision to ONE profile's latest ScriptArtifact: it resolves the profile by key (or unique
   * label fragment), rewrites with the REAL n8n writer contract plus the owner's instruction as
   * the brief, verifies the language the way n8n's languageOk does, and appends a v2+ artifact in
   * the SAME project. Nothing else in the batch is touched — the other six projects are never
   * opened.
   */
  agentServices.reviseScript = async ({ profile, instruction, ctx }) => {
    const wanted = String(profile || '').trim();
    if (!wanted) throw new Error('name the profile whose script should change');
    const instructionText = U.sanitizeText(String(instruction || ''), 1200);
    if (!instructionText) throw new Error('say what should change in the script');
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = store.pages().filter(p => p.role !== 'orchestrator').map(p => p.key);
    // Exact key match first; then unique key or label substring. Ambiguity fails loudly instead of
    // silently rewriting the wrong profile.
    let key = keys.find(k => k === norm(wanted));
    if (!key) key = keys.find(k => norm(k).includes(norm(wanted)) || norm(store.page(k).label).includes(norm(wanted)));
    if (!key) throw new Error('no page profile matches "' + wanted + '"');
    const clashes = keys.filter(k => norm(k).includes(norm(wanted)) || norm(store.page(k).label).includes(norm(wanted)));
    if (clashes.length > 1) throw new Error('"' + wanted + '" matches several profiles (' + clashes.join(', ') + ') — name one');

    // The profile's LATEST fanout script, wherever it lives: the fanout created one project per
    // profile, so resolve the profile's most recent project that has a script artifact. Fanout
    // projects (branch.mode scripts_only) outrank free-form delegated turns: a stray page.ask can
    // create a newer project full of duplicate unprofiled drafts, and the owner's reviewed batch
    // is the fanout one. The scripts-only mode IS the reviewed deliverable.
    const projects = store.listProjects(key).map(x => store.project(x.id)).filter(Boolean)
      .filter(p => p.branch && (p.branch.fanout || p.branch.delegated))
      .sort((a, b) => {
        const ao = a.branch && a.branch.mode === 'scripts_only' ? 1 : 0;
        const bo = b.branch && b.branch.mode === 'scripts_only' ? 1 : 0;
        return (bo - ao) || ((b.updated || 0) - (a.updated || 0));
      });
    let proj = null, scriptArt = null;
    for (const p of projects) {
      const arts = (p.artifacts || []).map(id => store.artifact(id)).filter(a => a && a.kind === 'script');
      if (arts.length) { proj = p; scriptArt = arts.sort((a, b) => (b.version || 0) - (a.version || 0))[0]; break; }
    }
    if (!proj || !scriptArt) throw new Error('no script artifact exists yet for ' + key + ' — create the 7 scripts first');

    const page = store.page(key);
    const writer = PAGE_WRITERS.writerFor(key);
    const truth = proj.truth || U.footageTruth(proj.analysis, proj.source && proj.source.meta && proj.source.meta.title) || {};
    const product = U.sanitizeText(truth.product || (proj.analysis && (proj.analysis.suggested_product || proj.analysis.product_visible)) || 'the product shown in the footage', 120);
    const sourceArt = proj.currentPlayable ? store.artifact(proj.currentPlayable) : (proj.current ? store.artifact(proj.current) : null);

    // Owner rule (2026-09-23): the revision speaks the SAME resolved offer as the fanout (owner
    // price override > page policy > n8n tiers). It used to pass `analysis.approved_price`, which
    // is usually unset — that is exactly how a revision invented "299 درهم".
    const revBatch = store.currentBatch();
    const priceOverride = (revBatch && revBatch.priceOverrides || {})[key] || null;
    const marketHint = (proj.analysis && (proj.analysis.market_price || proj.analysis.market_price_mad)) || null;
    const offer = PAGE_WRITERS.priceFor(key, { product, marketHint, override: priceOverride });
    const offerLabel = offer ? (offer.monthly ? offer.amount + ' ' + offer.currency + '/شهر' : offer.amount + ' ' + offer.currency) : null;

    // Same contract the fanout used, plus the owner's instruction as the revision brief and the
    // previous draft as the base to preserve.
    const contract = PAGE_WRITERS.writerPromptBlock(key, {
      product,
      brand: U.sanitizeText((proj.analysis && proj.analysis.brand) || (truth && truth.brand) || '', 60),
      category: U.sanitizeText((proj.analysis && proj.analysis.suggested_category) || 'product', 60),
      duration: (proj.analysis && proj.analysis.duration) || (sourceArt && sourceArt.probe && Math.round(sourceArt.probe.duration)) || '',
      firstAppearance: (proj.analysis && proj.analysis.product_first_appearance_sec) || '',
      scenes: U.sanitizeText(String((proj.analysis && (proj.analysis.scene_descriptions_text || proj.analysis.visual_notes)) || 'unboxing and visible product details'), 900),
      sellingPrice: offerLabel,
      monthly: !!(offer && offer.monthly),
      marketPrice: offer ? offer.market : (proj.analysis && proj.analysis.market_price) || null,
      ctaStyle: (revBatch && revBatch.ctaStyles || {})[key] || null,
      recentHooks: null,
    });
    const context = [
      contract,
      '',
      '=== REVISION BRIEF (the owner reviewed the previous draft) ===',
      'PREVIOUS DRAFT (keep everything the owner did not ask to change):',
      U.sanitizeText(scriptArt.text, 2000),
      '',
      'OWNER INSTRUCTION (apply ONLY this change; preserve the rest of the draft):',
      instructionText,
      '',
      '=== OUTPUT CONTRACT ===',
      'Return JSON only: {"script_text":"...","sentences":["..."],"hook_style_used":"...","title_' + (writer ? writer.titleField.replace('title_', '') : 'darija') + '":"...","caption_social":"...","caption_social_ig":"..."}.',
      'Write spoken script text only. Keep the same language and the same structure as the previous draft unless the instruction says otherwise.',
      'Use only facts visible in the footage. Do not invent specifications, prices, stock, discounts or sourcing claims.',
    ].join('\n');
    // owner override A: revisions run on the same newer-Gemini writer chain as first drafts.
    // Owner rule (2026-09-23): a revision must obey the PRICE contract too (the offer price in
    // the first sentence, no invented prices) — a violating draft is retried, then rejected
    // WITHOUT touching the previous script.
    const configuredWriter = legacy.providers && legacy.providers.pickOne('script', { page: key });
    const revChain = configuredWriter ? [configuredWriter] : [...new Set([(writer && writer.writerModel), page.model].filter(Boolean))];
    let parsed = {}, text = '', priceCheck = { ok: false, reasons: ['no draft produced'] };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await legacy.llm.text(revChain[0], context, 'script', { page: key, project: proj.id });
      parsed = U.extractJSON(raw) || {};
      text = String(parsed.script_text || (Array.isArray(parsed.sentences) ? parsed.sentences.join(' ') : '')).trim();
      priceCheck = PAGE_WRITERS.priceContractOk(key, text, offer);
      if (text.length >= 40 && text.length <= 1800 && PAGE_WRITERS.languageOk(key, text) && priceCheck.ok) break;
    }
    if (!(text.length >= 40 && text.length <= 1800 && PAGE_WRITERS.languageOk(key, text) && priceCheck.ok)) {
      throw new Error('the revised draft failed the ' + key + ' contract ('
        + (priceCheck.reasons.join('; ') || 'language/length check') + ') — nothing was changed');
    }
    const prev = scriptArt.params || {};
    // a revised title that invents a price is dropped — the previous (checked) title stays.
    const revTitleRaw = String(parsed[writer && writer.titleField || 'title_darija'] || '').trim() || null;
    const revTitle = revTitleRaw && !PAGE_WRITERS.foreignPrices(revTitleRaw, offer).length ? revTitleRaw : null;
    const rev = store.addArtifact({ project: proj.id, kind: 'script', op: 'script', attach: false,
      parent: scriptArt.id, text,
      label: (prev.profileLabel || page.label) + ' Script v' + (scriptArt.version + 1),
      params: { ...prev, language: page.lang, generatedBy: 'page-profile-revision',
        groundedProduct: product,
        revisionOf: scriptArt.id,
        revisionInstruction: instructionText,
        titleSuggested: revTitle || prev.titleSuggested || null,
        titleField: writer ? writer.titleField : prev.titleField || null,
        hookStyle: String(parsed.hook_style_used || '').trim() || prev.hookStyle || null,
        caption_social: String(parsed.caption_social || '').trim() || prev.caption_social || null,
        caption_social_ig: String(parsed.caption_social_ig || '').trim() || prev.caption_social_ig || null } });
    // Report into the orchestrator conversation with the full artifact card.
    store.appendMessage(ctx && ctx.page || 'studio', { role: 'agent',
      text: '✓ ' + (prev.profileLabel || page.label) + ' script updated (v' + rev.version + '). Only this profile changed.',
      artifacts: [fmtArtifact(rev)], tools: [{ tool: 'pages.reviseScript', ok: true, page: key }], project: proj.id });
    return { page: key, label: prev.profileLabel || page.label, project: proj.id,
      artifact: { id: rev.id, version: rev.version, label: rev.label },
      previous: { id: scriptArt.id, version: scriptArt.version }, unchanged: true };
  };

  // ---------------------------------------------------------------- job runners
  jobs.register('agent.tool', async (job, ctx) => {
    const r = await agent.executeTool(job.params.tool, job.params.args || {}, {
      page: job.params.page, projectId: job.params.project || null,
      progress: (stage, pct) => ctx.progress(stage, pct), note: m => ctx.note(m),
      emit: (type, extra) => broadcast({ type, ts: Date.now(), page: job.params.page, ...extra }),
    });
    // executeTool wraps the tool payload as { ok, tool, result: { ok, tool, result: payload } }.
    // Unwrap it here so aggregate tools such as pages.fanout cannot lose their child artifacts.
    let payload = r;
    for (let depth = 0; depth < 4 && payload && payload.result && !payload.pages && !payload.artifact; depth++) payload = payload.result;
    const fanoutArtifacts = payload && Array.isArray(payload.pages)
      ? payload.pages.flatMap(x => (x.artifacts || []).map(a => typeof a === 'string' ? store.artifact(a) : (a && a.id ? store.artifact(a.id) : null))).filter(Boolean)
      : [];
    const directArtifacts = payload && payload.artifact ? [payload.artifact] : [];
    const visibleArtifacts = [...directArtifacts, ...fanoutArtifacts];
    store.appendMessage(job.params.page, {
      role: 'agent',
      text: r.ok && payload && payload.pages
        ? (payload.ready != null ? '✓ ' + payload.ready + '/' + payload.total : '✓ Attached ' + payload.pages.length + ' page productions') + ' — scripts, voiceovers and renders are attached below.'
        : (r.ok ? '✓ ' + job.params.tool : '✕ ' + job.params.tool + ': ' + r.error),
      artifacts: visibleArtifacts.map(fmtArtifact),
      tools: [{ tool: job.params.tool, ok: r.ok, error: r.error || null }],
      project: job.params.project || null, tool_direct: true,
    });
    if (!r.ok) throw new Error(r.error);
    return { ...r, result: payload, artifacts: visibleArtifacts.map(fmtArtifact) };
  });
  /**
   * media.import — ingest, then ANNOUNCE the result.
   * An import that produces a file but no message leaves the owner with nothing to look at, so the
   * real artifact is posted to the conversation (or the orchestrator's) as soon as it exists. The
   * text reports the measured duration because that is the fact the probe returned.
   */
  jobs.register('media.import', async (job, ctx) => {
    let r;
    try {
      r = await importUrl({ page: job.params.page, project: job.params.project, url: job.params.url, title: job.params.title, candidate: job.params.candidate || null, ctx });
    } catch (e) {
      // A failed import is reported where the owner asked for it, with the classified reason.
      const owner = job.params.page || store.ORCHESTRATOR;
      if (owner) store.appendMessage(owner, {
        role: 'agent', text: '✕ Import failed — ' + e.message,
        artifacts: [], tools: [{ tool: 'media.import', ok: false, error: e.message }],
        project: null, importError: { kind: e.kind || 'import_failed', message: e.message, url: job.params.url || '' },
      });
      broadcast({ type: 'import.failed', ts: Date.now(), page: owner, kind: e.kind || 'import_failed', error: e.message });
      throw e;
    }
    const owner = job.params.page || (store.project(r.project.id) || {}).page || store.ORCHESTRATOR;
    if (owner) store.appendMessage(owner, {
      role: 'agent',
      text: '✓ Source imported — ' + ((r.source && r.source.title) || r.project.title || 'untitled') + ' (' + (r.validated ? r.validated.duration + 's, ' + r.validated.width + '×' + r.validated.height : 'validated') + ')'
        + (r.analysis ? '\nIt watched the footage: ' + U.sanitizeText(String((r.analysis.scene_descriptions_text || '').split('|')[0] || ''), 180) : '')
        + '\nTell me what you want done with it.',
      artifacts: [fmtArtifact(r.artifact)], tools: [{ tool: 'media.import', ok: true }], project: r.project.id,
    });
    broadcast({ type: 'import.ready', ts: Date.now(), page: owner, project: r.project.id, artifact: r.artifact.id });
    return r;
  });
  jobs.register('media.search', async (job, ctx) => search(job.params.query, ctx, { page: job.params.page, project: job.params.project, limit: job.params.limit, vision: job.params.vision !== false, visionLimit: job.params.visionLimit }));
  /**
   * performOp — run one media operation, post the real artifact to the page conversation, and
   * (when the page's approval mode demands it) pause the job on a human checkpoint.
   * Returns { art } or { paused: true, art }.
   */
  async function performOp({ job, ctx, pageKey, projectId, op, args, checkpointMode, cursor, total, planId, isLast }) {
    const before = (store.project(projectId) || {}).current || null;
    const art = await media.applyOp(projectId, op, args || {}, ctx);
    broadcast({ type: 'artifact.created', ts: Date.now(), page: pageKey, artifact: art.id, rel: art.rel, label: art.label });
    const owner = pageKey || (store.project(projectId) || {}).page;
    if (owner) store.appendMessage(owner, {
      role: 'agent', text: '✓ ' + art.label + ' (' + (art.probe && art.probe.duration) + 's)',
      artifacts: [fmtArtifact(art)], tools: [{ tool: 'media.' + art.op, ok: true }], project: art.project,
    });
    const mode = approvalMode(owner, checkpointMode);
    if (needsCheckpoint(owner, op, checkpointMode, isLast)) {
      const pending = {
        checkpoint: mode === 'ask_after_each' ? 'step' : 'review',
        label: art.label + ' — ' + op, artifact: art.id, before, job: job.id, op, args,
        planId: planId || null, cursor: cursor || 0, total: total || null,
      };
      store.setWaiting(projectId, pending);
      approvalMessage(owner, projectId, pending, '⏸ Needs your review');
      broadcast({ type: 'approval.needed', ts: Date.now(), page: owner, project: projectId, artifact: art.id, op, checkpoint: pending.checkpoint, cursor: pending.cursor, total: pending.total, label: pending.label });
      return { paused: true, art };
    }
    return { paused: false, art };
  }

  jobs.register('media.op', async (job, ctx) => {
    const r = await performOp({
      job, ctx, pageKey: job.params.page, projectId: job.params.project,
      op: job.params.op, args: job.params.args || {},
    });
    if (r.paused) return { __pause: { stage: 'waiting for your review: ' + job.params.op, pct: 100, params: { done: true } } };
    return { artifact: fmtArtifact(r.art) };
  });

  /**
   * edit.plan — an explicit Edit Decision List executed step by step.
   * The cursor is part of the job's persisted params, so approving resumes at the next step
   * instead of replaying the ones already approved and paid for.
   */
  jobs.register('edit.plan', async (job, ctx) => {
    const ops = Array.isArray(job.params.ops) ? job.params.ops : [];
    if (!ops.length) throw new Error('plan has no operations');
    const projectId = job.params.project;
    const pageKey = job.params.page || ((store.project(projectId) || {}).page);
    let cursor = Number(job.params.cursor) || 0;
    for (; cursor < ops.length; cursor++) {
      const step = ops[cursor] || {};
      // The model writes plans with readable names ('text', 'ratio', 'voice'). Each step is resolved
      // to the real operation here — passing 'text' straight to the media layer failed the whole plan
      // with "unknown operation: text" after the earlier steps had already run.
      const op = resolveOp(step.op);
      if (!op) throw new Error('unknown operation in plan: ' + step.op + ' — known: ' + Object.keys(OP_ALIAS).join(', '));
      ctx.progress('step ' + (cursor + 1) + '/' + ops.length + ': ' + op, 8 + Math.round(80 * cursor / ops.length));
      const r = await performOp({
        job, ctx, pageKey, projectId, op, args: step.args || {},
        checkpointMode: job.params.checkpoint, cursor: cursor + 1, total: ops.length, planId: job.id,
        isLast: cursor === ops.length - 1,
      });
      if (r.paused) return { __pause: { stage: 'waiting for your review after ' + op, pct: 100, params: { cursor: cursor + 1 } } };
    }
    return { done: true, ops: ops.length, project: projectId };
  });
  jobs.register('agent.turn', async (job, ctx) => {
    const r = await agent.runTurn({
      page: job.params.page, project: job.params.project, message: job.params.message,
      focus: job.params.focus || null, refs: job.params.refs || null,
      progress: (stage, pct) => ctx.progress(stage, pct),
      emit: (type, extra) => broadcast({ type, ts: Date.now(), page: job.params.page, ...extra }),
    });
    if (!r.ok) throw new Error(r.error || 'agent turn failed');
    return { reply: r.reply, artifacts: r.artifacts, tools: r.tools, project: r.project };
  });
  jobs.register('tts.generate', async (job, ctx) => {
    ctx.progress('generating voice', 30);
    const r = await tts(job.params);
    if (r.artifact) broadcast({ type: 'artifact.created', ts: Date.now(), page: job.params.page, artifact: r.artifact.id, rel: r.artifact.rel });
    return r;
  });
  /**
   * transcription.run — audio preparation, transcription through the router, validation, persist.
   * The service owns the cache rule, so asking twice for unchanged audio costs one API request.
   */
  jobs.register('transcription.run', async (job, ctx) => {
    const r = await transcribe.run({
      projectId: job.params.project, artifactId: job.params.artifact || null,
      language: job.params.language || 'auto', force: !!job.params.force,
      progress: (stage, pct) => ctx.progress(stage, pct), note: m => ctx.note(m),
    });
    broadcast({
      type: 'transcript.ready', ts: Date.now(), page: job.params.page, project: job.params.project,
      transcription: r.transcription.id, cached: r.cached, segments: r.transcription.segments.length,
    });
    return { transcription: r.transcription, cached: r.cached };
  });
  jobs.register('caption.burn', async (job, ctx) => {
    const art = await burnCaptions({ project: job.params.project, track: job.params.track || null, ctx });
    const owner = job.params.page || (store.project(job.params.project) || {}).page;
    broadcast({ type: 'artifact.created', ts: Date.now(), page: owner, artifact: art.id, rel: art.rel, label: art.label });
    if (owner) store.appendMessage(owner, {
      role: 'agent', text: '✓ ' + art.segments + ' captions burned into ' + art.label + ' (' + (art.probe && art.probe.duration) + 's)',
      artifacts: [fmtArtifact(art)], tools: [{ tool: 'caption.burn', ok: true }], project: art.project,
    });
    return { artifact: fmtArtifact(art), track: art.track, segments: art.segments };
  });
  /**
   * branch.generate — fan one approved master out into page versions.
   * Runs on the single-concurrency queue, so branches render one at a time: seven simultaneous
   * ffmpeg processes is how a laptop stops responding. Each branch is isolated by suite.generate.
   */
  jobs.register('branch.generate', async (job, ctx) => {
    const r = await suite.generate({
      suiteId: job.params.suite, pages: job.params.pages, recipe: job.params.recipe || null,
      requireApproval: job.params.requireApproval !== false, ctx,
    });
    broadcast({ type: 'branches.ready', ts: Date.now(), page: job.params.page, suite: job.params.suite, ready: r.ready, failed: r.failed });
    const owner = job.params.page || '';
    if (owner) store.appendMessage(owner, {
      role: 'agent',
      text: '▤ ' + r.ready + ' page version(s) ready' + (r.failed ? ', ' + r.failed + ' failed' : '') + ' — waiting in Review.',
      artifacts: [], tools: [], project: null,
    });
    return r;
  });
  /**
   * caption.preset — re-apply a caption style preset as a new track version.
   * Used by batch corrections: one deterministic call per branch, no model involved.
   */
  jobs.register('caption.preset', async (job, ctx) => {
    const cur = job.params.track ? store.captionTrack(job.params.project, job.params.track) : store.captionTracks(job.params.project)[0];
    if (!cur) throw new Error('this project has no caption track');
    const next = captions.updateTrack({ projectId: job.params.project, trackId: cur.id, preset: job.params.preset });
    ctx.progress('preset ' + job.params.preset + ' → ' + next.id, 60);
    store.setReview(job.params.project, 'waiting', { note: 'caption preset ' + job.params.preset, artifact: next.id });
    return { track: next.id, preset: next.preset, version: next.version };
  });

  // self-heal stale artifact paths before anything can be served
  const repaired = store.repairArtifacts();
  if (repaired) log('info', 'store.repaired_artifacts', { count: repaired });

  const understanding = createVideoUnderstanding({ dir: path.join(STUDIO, 'video-understanding'),
    media, llm: legacy.llm, log, activity: recordActivity });
  async function produceUnboxing({ project, analysis, ctx, guard }) {
    if (!analysis.coverage || !analysis.coverage.complete || !analysis.timeline.length) throw Error('Complete visual evidence is required before writing');
    const p = store.project(project);
    const setStage = stage => { guard(); const current = store.project(project); current.status = stage; store.saveProject(current); ctx.note(stage); };
    setStage('writing_script');
    const model = legacy.providers.pickOne('script', { page: p.page });
    const maxWords = Math.max(25, Math.floor(analysis.duration * 1.8));
    const prompt = `Write ONLY a Moroccan Darija voiceover in Arabic letters for this actual phone unboxing video, duration ${analysis.duration} seconds, maximum ${maxWords} words and 1450 characters. Strong natural opening, describe only observed actions in chronological order, matching the pace of the timed evidence. No invented phone specifications. Finish with a transparent invitation to visit the link and check Surveoo survey eligibility and conditions. Do not promise a free phone, guaranteed money, rewards or approval. No headings, timestamps, Markdown or stage directions. This is spoken narration, not a production brief. Evidence: ${JSON.stringify({ timeline: analysis.timeline, brief: analysis.narrationBrief })}`;
    const text = String(await legacy.llm.text(model, prompt, 'script', { page: p.page, project })).trim();
    guard();
    if (!text || text.length > 1500) throw Error('Writer produced an empty or oversized narration');
    const script = store.addArtifact({ project, kind: 'script', op: 'script', attach: false, text, label: 'Darija unboxing narration', parent: analysis.assetId,
      params: { writerModel: model, language: 'darija', understandingId: analysis.id, timeline: analysis.timeline } });
    setStage('generating_tts');
    const voice = await tts({ page: p.page, project, text, voice: 'Kore', rate: 1, scriptId: script.id });
    guard();
    setStage('assembling_video');
    await media.applyOp(project, 'voiceover', { text, voice: 'Kore', rate: 1, bed: 0, audioFile: voice.artifact.file }, ctx);
    guard();
    const final = await media.applyOp(project, 'render', { mode: 'final' }, ctx);
    setStage('assembled');
    const production = { scriptId: script.id, ttsId: voice.artifact.id, videoId: final.id, url: final.rel, music: 'awaiting_owner_tracks', published: false };
    const current = store.project(project); current.productionResult = production; current.presentationBaseVideo = final.id; store.saveProject(current);
    if (current.presentation) return styleExistingNarration({ project, analysis, ctx, guard });
    return production;
  }
  const timedNarration = createTimedNarration({ store, media, legacy, tts, transcribe });
  async function decorateNarration({ project, analysis, ctx, guard }) {
    const p = store.project(project), production = p.productionResult;
    if (!production?.timingPlan) throw Error('A timed production is required before updating subtitle style');
    const audio = store.artifact(production.ttsId), script = store.artifact(production.scriptId);
    if (script?.params?.understandingId !== analysis.id) throw Error('Production belongs to a different source analysis');
    const plan = U.readJson(path.join(store.projectDir(project), path.basename(production.timingPlan)), null);
    if (!plan?.captions?.length || !audio) throw Error('Saved timing plan or narration audio is missing');
    guard(); store.rollback(project, analysis.assetId);
    await media.applyOp(project, 'voiceover', { text: script.text, voice: 'Kore', rate: 1, bed: 0, audioFile: audio.file, preserveDuration: true }, ctx);
    guard();
    await media.applyOp(project, 'burn_subs', { lines: JSON.stringify(plan.captions), style: JSON.stringify({ ...media.CAPTION_PRESETS.karaoke, size: 76, highlight: '#ffe04b', color: '#ffffff', outline: 5, shadow: 2, y: 74, safeMarginX: 105 }) }, ctx);
    guard();
    const final = await media.applyOp(project, 'render', { mode: 'final', title: JSON.stringify({ text: plan.title, at: 0, duration: 3 }), titleStyle: JSON.stringify({ position: 'top', y: 12, size: 62, background: '#121212' }) }, ctx);
    guard();
    if (final.params.burnedTitle !== plan.title) throw Error('Opening title could not be rendered');
    const next = { ...production, videoId: final.id, url: final.rel };
    const current = store.project(project); current.productionResult = next; current.productionError = null; current.status = 'assembled'; store.saveProject(current); return next;
  }
  async function styleExistingNarration({ project, analysis, ctx, guard, productionOverride }) {
    const p = store.project(project), production = productionOverride || p.productionResult;
    const audio = production && store.artifact(production.ttsId), base = production && store.artifact(production.videoId);
    if (!audio || !base) throw Error('A finished video and its original narration are required');
    const profile = p.presentation?.profile || 'maghrebtechstore';
    const cardPage = store.page(profile);
    if (!cardPage?.production?.ctaAssets?.facebook) throw Error('The selected profile has no Facebook card');
    ctx.note('Transcribing narration audio; preserving the script');
    const { transcription } = await transcribe.run({ projectId: project, artifactId: audio.id, language: 'Moroccan Darija', progress: ctx.progress, note: ctx.note });
    guard();
    const lines = [];
    for (const segment of transcription.segments) {
      const spokenWords = String(segment.text || '').trim().split(/\s+/).filter(Boolean);
      if (segment.words?.length >= Math.ceil(spokenWords.length * 0.9)) {
        for (let i = 0; i < segment.words.length; i += 4) {
          const words = segment.words.slice(i, i + 4);
          lines.push({ start: words[0].start, end: words[words.length - 1].end, text: captions.wrap(words.map(w => w.text).join(' '), 22, 2) });
        }
      } else {
        // Partial word timestamps must not discard the rest of the sentence. Keep all text,
        // deriving short caption intervals inside the measured segment and label the estimate.
        const groups = [];
        for (let i = 0; i < spokenWords.length; i += 4) groups.push(spokenWords.slice(i, i + 4).join(' '));
        const characters = groups.reduce((sum, text) => sum + text.length, 0);
        let cursor = segment.start;
        groups.forEach((text, i) => {
          const end = i === groups.length - 1 ? segment.end : cursor + (segment.end - segment.start) * text.length / characters;
          lines.push({ start: cursor, end, text: captions.wrap(text, 22, 2), derived: 'interpolated_from_transcript_segment' }); cursor = end;
        });
      }
    }
    if (!lines.length) throw Error('The existing narration returned no timed subtitles');
    store.rollback(project, analysis.assetId);
    const matched = await media.applyOp(project, 'voiceover', { text: store.artifact(production.scriptId).text, voice: 'Kore', rate: 1, bed: 0, audioFile: audio.file }, ctx);
    guard();
    const title = p.presentation?.title || 'شنو كاين فهاد الباكي؟';
    const titleStyle = { position: 'center', singleLine: true, size: 80, widthFraction: 0.90, color: '#000000', background: '#ffffff', backgroundOpacity: 1, outline: 6, outlineColor: '#ffffff', shadow: 0 };
    await media.applyOp(project, 'burn_subs', { lines: JSON.stringify(lines), style: JSON.stringify({ ...media.CAPTION_PRESETS.bold_social, size: 54, y: 77, uppercase: false, safeMarginX: 100, outline: 4, shadow: 1 }) }, ctx);
    guard();
    const total = Number(matched.probe.duration);
    const originalCard = path.join(root, path.dirname(cardPage.production.ctaAssets.facebook), 'facebook.MOV');
    const cardDuration = Number((await media.probe(originalCard)).duration);
    const card = await media.applyOp(project, 'append_cta', { platform: 'facebook', profile, variant: 'profile', ctaStartSec: Math.max(0.5, total - cardDuration) }, ctx);
    guard();
    const final = await media.applyOp(project, 'render', { mode: 'final', title: JSON.stringify({ text: title, at: 0, duration: 3 }), titleStyle: JSON.stringify(titleStyle) }, ctx);
    guard();
    if (final.params.burnedTitle !== title) throw Error('The centered title did not render');
    const next = { ...production, videoId: final.id, url: final.rel, title, subtitles: true, karaoke: false, profileCard: profile, profileCardAsset: card.params.card, cardStart: card.params.overlayStart, durationPolicy: matched.params.durationPolicy, sourceDuration: matched.params.sourceDuration, ttsDuration: audio.probe.duration, outputDuration: final.probe.duration, transcriptionId: transcription.id };
    const current = store.project(project); current.presentationBaseVideo = p.presentationBaseVideo || base.id; current.presentation = { profile, title, titleStyle };
    current.productionResult = next; current.productionError = null; current.status = 'assembled'; store.saveProject(current); return next;
  }
  async function revoiceNarration({ project, analysis, ctx, guard }) {
    const p = store.project(project), production = p.productionResult;
    const script = production && store.artifact(production.scriptId);
    if (!script?.text || script.params?.understandingId !== analysis.id) throw Error('The current source script is required');
    guard(); ctx.note('Generating warm conversational Moroccan Darija with Kore; unchanged script');
    ctx.progress('generating conversational Kore voice', 15);
    const voice = await tts({ page: p.page, project, text: script.text, voice: 'Kore', rate: 1, scriptId: script.id });
    guard();
    return styleExistingNarration({ project, analysis, ctx, guard, productionOverride: { ...production, ttsId: voice.artifact.id, voiceStyle: 'exciting_moroccan_marketing' } });
  }
  async function postPipelineVideo({ project, ctx, guard }) {
    let p = store.project(project);
    const production = p.productionResult;
    if (!production?.videoId) throw Error('Assemble a video before publishing');
    const profile = p.presentation?.profile || production.profileCard;
    const destination = publish.destinations(profile).find(d => d.enabled && d.connected);
    if (!destination) throw Error('No connected Facebook destination for the selected profile');
    if (p.posting?.videoId === production.videoId && p.posting.status === 'posted') return p.posting.result;
    if (p.posting?.videoId === production.videoId && p.posting.status === 'uploading') throw Error('An earlier upload has an unknown outcome; verify Facebook before retrying');
    const update = change => { p = store.project(project); p.posting = { ...p.posting, profile, pageName: destination.name, pageId: destination.id, videoId: production.videoId, updatedAt: Date.now(), ...change }; store.saveProject(p); };
    update({ status: 'checking_token', error: null }); ctx.progress('checking Facebook connection', 15);
    const connection = await publish.checkConnection(profile, destination.id);
    guard(); update({ connection });
    if (!connection.ok) { update({ status: 'failed', error: connection.error }); throw Error(connection.error || 'Facebook token check failed'); }
    const branch = store.createProject(profile, 'Unboxing · ' + destination.name, { sourcePipelineProject: project,
      caption: 'شوف هاد فتح علبة G-tab G11. للاستبيانات ديال Surveoo، شوف شروط المشاركة والأهلية فالرابط ديال البروفيل.' });
    const linked = store.linkArtifact(branch.id, production.videoId, { op: 'render', params: { mode: 'final' }, label: 'Video for ' + destination.name });
    const delivery = appearance.get();
    const website = delivery.pages[profile]?.website;
    if (website && delivery.common.includeWebsiteInCaption) { const savedBranch = store.project(branch.id); savedBranch.caption += '\n\n' + website; store.saveProject(savedBranch); }
    store.approve(branch.id, 'owner-publish-request', 'Owner explicitly requested posting this studio video to Facebook');
    const selection = { artifacts: [linked.id], destinations: [destination.id] };
    const plan = publish.plan(selection);
    if (!plan.ok) { update({ status: 'failed', error: plan.error || plan.blockedSummary?.join('; ') }); throw Error(p.posting.error); }
    guard(); update({ status: 'uploading', branchId: branch.id, attempts: (p.posting.attempts || 0) + 1 });
    ctx.progress('uploading video to ' + destination.name, 60);
    const result = await publish.execute({ ...selection, token: plan.token, confirm: true });
    const posted = result.results?.find(r => r.ok);
    update({ status: posted ? 'posted' : 'failed', result, postId: posted?.postId || null,
      postUrl: posted ? 'https://www.facebook.com/' + posted.postId : null, verified: !!posted?.verification?.verified,
      error: posted ? null : result.results?.find(r => !r.ok)?.error || result.error || 'Facebook upload failed' });
    p = store.project(project); p.status = posted ? 'published' : 'publish_failed'; p.productionResult.published = !!posted; store.saveProject(p);
    if (!posted) throw Error(p.posting.error);
    return result;
  }
  async function pipelinePostingInfo(project) {
    let p = store.project(project);
    const profile = p.presentation?.profile || p.productionResult?.profileCard;
    const destination = profile && publish.destinations(profile).find(d => d.enabled && d.connected);
    if (destination && p.posting?.postId && p.posting.platformStatus?.video_status !== 'ready' && Date.now() - (p.posting.statusCheckedAt || 0) > 20000) {
      const checked = await publish.checkVideo(profile, destination.id, p.posting.postId);
      p = store.project(project); p.posting.statusCheckedAt = checked.checkedAt; p.posting.verificationError = checked.error || null;
      if (checked.ok) { p.posting.platformStatus = checked.status; if (checked.permalink) p.posting.postUrl = checked.permalink; }
      store.saveProject(p);
    }
    const posts = store.listProjects(profile).flatMap(s => store.project(s.id)?.posts || []);
    const unique = [...new Map(posts.map(post => [post.post_id, post])).values()];
    return { ...p.posting, profile, pageName: p.posting?.pageName || destination?.name || profile || 'Not selected', pageId: destination?.id || null,
      status: p.posting?.status || 'not_posted', totalPosted: unique.length, posts: unique.map(post => ({ id: post.post_id, at: post.published_at, page: post.page, verified: !!post.verification?.verified, url: 'https://www.facebook.com/' + post.post_id })).slice(-12).reverse() };
  }
  // Keep the original continuous Darija production active. The segmented experiment is isolated.
  const pipeline = createPipeline({ store, jobs, understanding, media, importUrl, search, log, produce: produceUnboxing, decorate: decorateNarration, style: styleExistingNarration, revoice: revoiceNarration, post: postPipelineVideo, postingInfo: pipelinePostingInfo, campaignStart: input => campaigns.start(input) });
  const appearance = require('./campaign-appearance').createCampaignAppearance({ root, dir: STUDIO });
  require('./social-compositor').installSocialOps({ media, root, store });
  media.opNames.push('tutorial_insert', 'social_style');
  const campaigns = createCampaignProduction({ dir: path.join(STUDIO, 'campaigns'), store, jobs, understanding, media,
    legacy: { ...legacy, root }, tts, transcribe, captions, publish, appearance });
  campaigns.configure();
  const routes = { ...pipeline.routes };
  let automation, monitor;
  const telegram = require('./telegram-reports').createTelegramReports({ dir: STUDIO, report: () => monitor.smartReport() });
  automation = require('./automation').createAutomation({ dir: STUDIO, jobs, store, campaigns, pipeline, telegram, publish, dailyReport:()=>monitor.smartReport() });
  const learning=require('./page-learning').createPageLearning({dir:path.join(STUDIO,'page-learning'),store,jobs,campaigns,publish,media,understanding,transcribe,pipeline,llm:legacy.llm,telegram});
  const videoReview=require('./telegram-video-review').createTelegramVideoReview({dir:STUDIO,campaigns,store,jobs,telegram,llm:legacy.llm});
  campaigns.setLearningProvider(page=>{const learned=learning.context(page),example=videoReview.context(page);return example?{...(learned||{}),ownerSelectedExample:example}:learned;});
  const storage=require('./storage-retention').createStorageRetention({dir:STUDIO,mediaRoot:MEDIA_ROOT,store,jobs,campaigns,telegram,enabled:jobs.enabled});
  const studioTools=require('./studio-tools').createStudioTools({dir:path.join(STUDIO,'assistant-tools'),campaigns,learning,jobs,llm:legacy.llm,store,automation,appearance,pipeline,storage,videoReview,providers:legacy.providers,publicationHeld:()=>U.readJson(path.join(STUDIO,'publish-hold.json'),{enabled:true}).enabled!==false});
  const nanobot=require('./nanobot-bridge').createNanobotBridge({root:legacy.root || process.cwd(),dir:STUDIO,llm:legacy.llm,tools:studioTools});
  monitor = require('./studio-monitor').createStudioMonitor({ store, jobs, campaigns, automation, understanding, appearance, llm:legacy.llm,tools:studioTools,learning,nanobot });
  const telegramAgent=require('./telegram-agent').createTelegramAgent({dir:STUDIO,enabled:jobs.enabled,telegram,snapshot:monitor.snapshot,answer:monitor.reply,report:monitor.smartReport,capabilities:()=>studioTools.spec,resolveReply:videoReview.reply});
  const integrationRoute = fn => async (req, res) => {
    if (!['GET','POST'].includes(req.method)) return j(res,405,{error:'GET or POST required'});
    if (req.method === 'POST' && req.headers.origin && !['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin)) return j(res,403,{error:'Use the studio Settings form'});
    try { return j(res,200,await fn(req,req.method==='POST'?await readJson(req):{})); }
    catch(e) { return j(res,400,{error:U.sanitizeText(e.message,250)}); }
  };
  routes['/api/v2/storage/retention']=integrationRoute(req=>{if(req.method!=='GET')throw Error('Read-only storage status');return storage.inspect();});
  routes['/api/v2/storage/cleanup']=integrationRoute(req=>{if(req.method!=='POST')throw Error('POST required');return storage.clean();});
  routes['/api/v2/automation/settings'] = integrationRoute((req,input)=>req.method==='GET'?automation.status():automation.save(input));
  routes['/api/v2/telegram/settings'] = integrationRoute((req,input)=>({...(req.method==='GET'?telegram.settings():telegram.save(input)),agent:telegramAgent.status()}));
  routes['/api/v2/telegram/video'] = integrationRoute((req,input)=>{
    if(req.method!=='POST')throw Error('POST required');
    if(!campaigns.catalog().some(p=>p.key===input.page))throw Error('Choose one existing page');
    return videoReview.send(input.page,input.videoId||'');
  });
  routes['/api/v2/examples'] = integrationRoute(req=>{
    if(req.method!=='GET')throw Error('GET required');
    return{examples:campaigns.catalog().map(p=>videoReview.inspect(p.key))};
  });
  routes['/api/v2/telegram/preview'] = integrationRoute(async(req,input)=>{
    if(req.method!=='POST'||typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('Enter a question of up to 2000 characters');
    return{reply:await telegramAgent.preview(input.text),observedAt:Date.now()};
  });
  routes['/api/v2/learning']=(req,res,u)=>{try{if(req.method!=='GET')return j(res,405,{error:'GET required'});const page=u.searchParams.get('page');return j(res,200,{...learning.get(page),writerRevisions:studioTools.history(page)});}catch(e){return j(res,400,{error:U.sanitizeText(e.message,250)});}};
  routes['/api/v2/learning/tool']=integrationRoute(async(req,input)=>{
    if(req.method!=='POST')throw Error('POST required');
    if(!['studio.inspect','page.inspect','video.check','learning.improve','learning.undo','videos.scan','videos.top','videos.review','reference.analyze','reference.status','reference.report','learning.apply','production.like','writer.history','writer.undo'].includes(input.tool))throw Error('Unsupported dashboard learning action');
    return studioTools.execute(input,{authorized:true,channel:'dashboard',requestId:input.requestId || U.uid('dashboard'),text:input.tool==='learning.improve'?'apply improvements '+input.page+' pages':input.tool==='learning.undo'?'undo '+input.page:(input.tool==='writer.undo'?'undo ':input.tool==='production.like'?'make ':input.tool==='learning.apply'?'apply ':'analyze ')+input.page});
  });
  for(const action of ['verify','chats','test','report']) routes['/api/v2/telegram/'+action]=integrationRoute(req=>{
    if(req.method!=='POST')throw Error('POST required');return telegram[action]();
  });

  routes['/api/v2/video/settings'] = async (req, res) => {
    if (req.method === 'GET') return j(res, 200, appearance.get());
    if (req.method !== 'POST') return j(res, 405, { error: 'GET or POST required' });
    if (req.headers.origin && !['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin)) return j(res, 403, { error: 'Use the local studio.' });
    try { j(res, 200, appearance.save(await readJson(req))); } catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  routes['/api/v2/campaign/apply-style'] = async (req, res) => {
    if (req.method !== 'POST') return j(res, 405, { error: 'POST required' });
    try { j(res, 202, campaigns.applyStyle(await readJson(req))); } catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  routes['/api/v2/writers/settings'] = async (req, res) => {
    if (req.method === 'GET') return j(res, 200, campaigns.settings());
    if (req.method !== 'POST') return j(res, 405, { error: 'GET or POST required' });
    if (req.headers.origin && !['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin)) return j(res, 403, { error: 'Use the local settings form.' });
    try { j(res, 200, campaigns.saveSettings(await readJson(req))); } catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  routes['/api/v2/writers/preview'] = (req, res, u) => {
    try { j(res, 200, campaigns.preview({ page: u.searchParams.get('page'), analysisId: u.searchParams.get('analysisId') })); }
    catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  routes['/api/v2/campaign/enlarge-titles'] = async (req, res) => {
    if (req.method !== 'POST') return j(res, 405, { error: 'POST required' });
    try { j(res, 202, campaigns.enlargeTitles(await readJson(req))); } catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  const atlasPreviews = new Map();
  routes['/api/v2/campaign/thumbnail'] = async (req, res, u) => {
    const art = store.artifact(u.searchParams.get('id'));
    if (!art?.file || art.kind !== 'video' || !U.isInside(store.MEDIA_ROOT, art.file) || !fs.existsSync(art.file)) return j(res, 404, { error: 'Video not found' });
    const st = fs.statSync(art.file);
    const out = path.join(STUDIO, 'cache', 'atlas_' + U.hash16(art.id + '|' + st.size + '|' + st.mtimeMs) + '.jpg');
    try {
      if (!fs.existsSync(out)) {
        if (!atlasPreviews.has(out)) atlasPreviews.set(out, media.ff(['-ss', '0.5', '-i', art.file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', out], 60).finally(() => atlasPreviews.delete(out)));
        await atlasPreviews.get(out);
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); fs.createReadStream(out).pipe(res);
    } catch (_) { j(res, 500, { error: 'Preview extraction failed' }); }
  };

  jobs.resume();

  // ---------------------------------------------------------------- routes
  routes['/api/v2/campaigns'] = (req, res) => j(res, 200, { profiles: campaigns.catalog(), runs: campaigns.list() });
  routes['/api/v2/campaign/run'] = (req, res, u) => { const run = campaigns.inspect(u.searchParams.get('id')); j(res, run ? 200 : 404, run || { error: 'Campaign not found' }); };
  routes['/api/v2/campaign/start'] = async (req, res) => {
    if (req.method !== 'POST') return j(res, 405, { error: 'POST required' });
    try { j(res, 202, campaigns.start(await readJson(req))); } catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  routes['/api/v2/campaign/retry'] = async (req, res) => {
    if (req.method !== 'POST') return j(res, 405, { error: 'POST required' });
    try { j(res, 202, campaigns.retry(await readJson(req))); } catch (e) { j(res, 400, { error: U.sanitizeText(e.message, 250) }); }
  };
  routes['/api/v2/campaign/connections/check'] = async (req, res) => {
    if (req.method !== 'POST') return j(res, 405, { error: 'POST required' });
    const connections=await campaigns.checkConnections(); automation.refreshConnections();
    j(res, 200, { connections });
  };
  routes['/api/v2/campaign/card'] = (req, res, u) => {
    const profile = campaigns.catalog().find(p => p.key === u.searchParams.get('page'));
    const clip = profile?.card && path.join(root, profile.card);
    if (!clip || !U.isInside(root, clip) || !fs.existsSync(clip)) return j(res, 404, { error: 'Profile clip not found' });
    const size = fs.statSync(clip).size, range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size || req.headers.range && !range) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    fs.createReadStream(clip, { start, end }).pipe(res);
  };
  routes['/api/v2/tools'] = (req, res) => j(res, 200, { tools: agent.toolNames(), spec: agent.toolSpecText });
  /**
   * The storage audit, as data. Generated from the resolved roots rather than remembered, so it
   * is always true of THIS process — including when the roots were overridden by env vars.
   */
  routes['/api/v2/storage'] = (req, res) => {
    const described = STORAGE && STORAGE.describe ? STORAGE.describe() : {
      roots: {
        data: { path: DATA, class: 'persistent' }, studio: { path: STUDIO, class: 'persistent' },
        media: { path: MEDIA_ROOT, class: 'persistent' }, logs: { path: LOGDIR, class: 'persistent' },
        cache: { path: CACHE, class: 'cache' },
      },
      locations: [], volumesForContainer: ['VS_DATA_DIR'],
    };
    // add live sizes so the owner can see what is actually consuming disk
    const sizeOf = dir => { let n = 0, files = 0; try { for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); const st = fs.statSync(fp); if (st.isFile()) { n += st.size; files++; } } } catch (_) {} return { files, bytes: n }; };
    const usage = {};
    for (const [k, r] of Object.entries(described.roots)) usage[k] = { ...r, ...sizeOf(r.path) };
    j(res, 200, { ...described, usage, mediaRoot: MEDIA_ROOT, studioRoot: STUDIO, cacheRoot: CACHE });
  };
  routes['/api/v2/pages'] = (req, res) => {
    const running = jobs.list({}).filter(x => x.status === 'running' || x.status === 'queued');
    j(res, 200, {
      pages: store.pages().map(p => ({
        key: p.key, label: p.label, lang: p.lang, color: p.color, voice: p.voice, ratio: p.ratio,
        template: p.template, pageIds: p.pageIds || [], model: p.model || '', rules: p.rules.length,
        state: store.waitingApprovals(p.key).length ? 'waiting'
          : running.some(x => x.page === p.key) ? 'working' : 'idle',
        running: running.filter(x => x.page === p.key).map(x => ({ id: x.id, type: x.type, stage: x.stage, pct: x.pct })),
        awaiting: store.waitingApprovals(p.key).length,
        messages: store.conversation(p.key).messages.length,
        // The rail is history, so it needs to be able to say WHEN this conversation last changed.
        updated: store.conversation(p.key).updated || null,
        projects: store.listProjects(p.key).length,
      })),
    });
  };
  routes['/api/v2/page'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.key) return j(res, 400, { error: 'key required' });
    j(res, 200, { page: store.savePage(b.key, b.patch || {}) });
  };
  /**
   * hydrateMessages — fill in what an older message's artifact entries did not carry.
   *
   * Messages are append-only records: a message written before artifacts started travelling with
   * their project/page/version keeps that shape forever, and a card rendered from it could not
   * target the right project when the owner clicks Approve. The stored artifact is the source of
   * truth, so anything missing on the message is read from the record here, on the way out.
   */
  function hydrateMessages(msgs) {
    return (msgs || []).map(m => {
      if (!m || !Array.isArray(m.artifacts) || !m.artifacts.length) return m;
      return {
        ...m,
        artifacts: m.artifacts.map(a => {
          if (!a || a.project) return a;
          const rec = store.artifact(a.id);
          if (!rec) return a;
          return {
            ...a, project: rec.project || null, page: rec.page || null, version: rec.version || a.version || null,
            ts: rec.ts || null, status: rec.status || null, parent: rec.parent || null,
            text: a.text || rec.text || null, size: rec.size || null, params: a.params || rec.params || null,
          };
        }),
      };
    });
  }

  routes['/api/v2/state'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    if (!pageKey) return j(res, 400, { error: 'page required' });
    const c = store.conversation(pageKey);
    let projectId = u.searchParams.get('project') || c.project || null;
    let p = projectId ? store.project(projectId) : null;
    // Self-heal: a conversation pointer that no longer resolves (project deleted, or a message
    // sent before the project existed) falls back to the page's newest project — but NEVER right
    // after NEW CHAT: a fresh session must start empty and stay empty until new work restarts.
    if (!p && !c.freshStart) {
      const list = store.listProjects(pageKey);
      projectId = list.length ? list[0].id : null;
      p = projectId ? store.project(projectId) : null;
      if (p && c.project !== p.id) { c.project = p.id; store.saveConversation(c); }
    }
    j(res, 200, {
      page: store.page(pageKey),
      conversation: hydrateMessages(c.messages.slice(-60)),
      projects: store.listProjects(pageKey),
      project: p,
      // The CURRENT production batch: what the pipeline resolves against. History never leaks in
      // because the batch holds explicit per-profile pointers, and the UI shows exactly these.
      batch: store.currentBatch() ? {
        id: store.currentBatch().id, stage: store.currentBatch().stage, status: store.currentBatch().status,
        sourceProjectId: store.currentBatch().sourceProjectId, createdAt: store.currentBatch().createdAt,
        sourceTruth: store.currentBatch().sourceTruth || null,
        profiles: store.currentBatch().profiles || {},
      } : null,
      pending: (p && p.pending) || null,
      approvals: (p && p.approvals || []).slice(-20),
      artifacts: p ? store.artifactsOf(p.id) : [],
      jobs: jobs.list({ page: pageKey }).slice(0, 20).map(jobs.publicJob),
      waiting: store.waitingApprovals(pageKey),
      tools: agent.toolNames(),
      templates: store.templates().map(t => t.name),
      assets: store.assets().slice(0, 40),
    });
  };
  routes['/api/v2/events'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    const client = { res, page: pageKey }; clients.add(client);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(client); });
  };
  routes['/api/v2/activity'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    const file = path.join(LOGDIR, 'activity.jsonl');
    let events = [];
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-800);
      events = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
        .filter(e => {
          if (!pageKey) return true;
          const owner = e.page || (e.job && e.job.page) || '';
          return !owner || owner === pageKey;   // unowned events are global (router internals)
        })
        .slice(-80).reverse()
        // compact, uniform shape whatever produced the event
        .map(e => (e.type === 'model.call' ? {
          ts: e.ts, kind: 'model', label: e.label || e.task, task: e.task, capability: e.capability,
          workload: e.workload, policy: e.policy, model: e.model, provider: e.provider,
          ms: e.ms, status: e.status, error: e.error || null, fallbackFrom: e.fallbackFrom || null,
          attempts: e.attempts || 1, credential: e.credential || null,
        } : {
          ts: e.ts, kind: 'job', label: e.type, job: e.job ? e.job.id : null, status: e.job ? e.job.status : null,
          stage: (e.job && e.job.stage) || e.stage || null, pct: e.job ? e.job.pct : (e.pct != null ? e.pct : null),
          error: e.error || null,
        }));
    } catch (_) {}
    j(res, 200, { events, count: events.length });
  };

  routes['/api/v2/conversation/clear'] = async (req, res) => {
    const b = await readJson(req);
    // NEW CHAT / CLEAR CHAT is a REAL session reset: visible history → archive (nothing deleted),
    // brand-new session id, project pointer + current ProductionBatch detached.
    const c = store.resetSession(b.page);
    j(res, 200, { ok: true, sessionId: c.sessionId, batchDetached: true });
  };
  routes['/api/v2/conversation/new'] = routes['/api/v2/conversation/clear'];
  routes['/api/v2/project'] = async (req, res, u, method) => {
    if (method === 'GET') {
      const p = store.project(u.searchParams.get('id'));
      if (!p) return j(res, 404, { error: 'project not found' });
      return j(res, 200, { project: p, artifacts: store.artifactsOf(p.id), pages: store.pages().filter(x => x.key === p.page).map(x => ({ key: x.key, label: x.label, color: x.color })) });
    }
    const b = await readJson(req);
    if (!b.page) return j(res, 400, { error: 'page required' });
    j(res, 200, { project: store.createProject(b.page, b.title) });
  };
  routes['/api/v2/project/approve'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, { project: store.approve(b.project, b.checkpoint || 'manual', b.note) }); }
    catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- approval checkpoints
  routes['/api/v2/approvals'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    j(res, 200, { approvals: store.waitingApprovals(pageKey || null) });
  };
  /**
   * POST /api/v2/approval/decision — approve | reject | regenerate | modify
   * Approve resumes the paused job from its cursor; reject rolls the project pointer back to the
   * state before the flagged operation; regenerate asks for the same operation again.
   */
  routes['/api/v2/approval/decision'] = async (req, res) => {
    const b = await readJson(req);
    const decision = ['approve', 'reject', 'regenerate', 'modify'].includes(b.decision) ? b.decision : null;
    if (!b.project || !decision) return j(res, 400, { error: 'project + decision (approve|reject|regenerate|modify) required' });
    const project = store.project(b.project);
    if (!project) return j(res, 404, { error: 'project not found' });
    const pending = project.pending || null;
    if (!pending) return j(res, 409, { error: 'nothing is waiting for approval on this project' });
    try {
      const { pending: wasPending } = store.resolveWaiting(b.project, decision, b.note || '');
      const page = wasPending.page || project.page;
      const label = wasPending.label || wasPending.op || 'change';
      if (decision === 'reject' || decision === 'regenerate') {
        if (wasPending.before) store.rollback(b.project, wasPending.before);
        if (wasPending.job) { try { jobs.cancel(wasPending.job); } catch (_) {} }
      }
      let resumed = null;
      if (decision === 'approve' && wasPending.job) {
        const job = jobs.get(wasPending.job);
        if (job && job.status === 'waiting_approval') {
          // A single op already did its work before pausing, so approving simply completes it.
          // Only a plan with steps left is genuinely re-queued from its cursor.
          if (job.params && job.params.done) { resumed = jobs.finish(wasPending.job, { approved: true, artifact: wasPending.artifact }); }
          else { resumed = jobs.resumeJob(wasPending.job, { params: { cursor: wasPending.cursor || (job.params || {}).cursor || 0 } }); }
        }
      }
      if (decision === 'regenerate' && wasPending.op && wasPending.args) {
        const re = jobs.enqueue({ type: 'media.op', page, project: b.project, params: { page, project: b.project, op: wasPending.op, args: wasPending.args } });
        resumed = re;
      }
      store.appendMessage(page, {
        role: 'user', text: decision === 'approve' ? '✅ Approved: ' + label
          : decision === 'reject' ? '❌ Rejected: ' + label
          : decision === 'regenerate' ? '🔁 Regenerate: ' + label
          : '✏️ Change requested: ' + label,
        project: b.project, decision: { decision, note: b.note || '' },
      });
      broadcast({ type: 'approval.resolved', ts: Date.now(), page, project: b.project, decision, artifact: wasPending.artifact });
      j(res, 200, { ok: true, decision, resumed: resumed ? jobs.publicJob(resumed) : null, project: store.project(b.project) });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  /**
   * POST /api/v2/plan — run an Edit Decision List.
   * The plan is validated against locks BEFORE a job is queued. A locked operation is refused with a
   * reason and the rest of the plan still runs; the owner's own `enabled: false` markers are skipped.
   * The response always names what was refused and what was skipped, so nothing is silently dropped.
   */
  routes['/api/v2/plan'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.project) return j(res, 400, { error: 'project required' });
    const p = store.project(b.project);
    if (!p) return j(res, 404, { error: 'project not found' });
    const v = plan.validate(p, b.ops || []);
    if (v.unknown.length) return j(res, 400, { error: 'unknown operation(s): ' + v.unknown.join(', ') + ' — known: ' + Object.keys(OP_ALIAS).join(', '), unknown: v.unknown });
    if (!v.accepted.length) {
      if (v.blocked.length) return j(res, 409, { error: v.blocked.length + ' operation(s) refused because the layer is locked.', blocked: v.blocked, skipped: v.skipped });
      return j(res, 400, { error: 'nothing to run: every operation was disabled or skipped', blocked: v.blocked, skipped: v.skipped });
    }
    const job = jobs.enqueue({
      type: 'edit.plan', page: b.page || p.page, project: b.project,
      params: { page: b.page || p.page, project: b.project, ops: v.accepted.map(x => ({ op: x.op, args: x.args })), cursor: 0, checkpoint: b.checkpoint || null },
    });
    j(res, 200, {
      ok: true, jobId: job.id, steps: v.accepted.length,
      ops: v.accepted.map(o => o.op), blocked: v.blocked, skipped: v.skipped,
      diff: plan.diff(p, v.accepted),
    });
  };
  routes['/api/v2/ops'] = (req, res) => j(res, 200, {
    ops: media.opNames, aliases: OP_ALIAS,
    schemas: Object.fromEntries(Object.entries(media.ops).map(([k, v]) => [k, { label: v.label, desc: v.desc, params: v.params }])),
    utilOps: [...UTIL_OPS],
  });
  routes['/api/v2/artifacts/rollback'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, { project: store.rollback(b.project, b.artifact) }); }
    catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/import'] = async (req, res) => {
    const b = await readJson(req);
    if (!b?.url) return j(res, 400, { error: 'url required' });
    const job = jobs.enqueue({ type: 'media.import', page: b.page || '', project: b.project || '', params: { page: b.page || '', project: b.project || '', url: b.url, title: b.title } });
    j(res, 200, { ok: true, jobId: job.id });
  };
  // One search job type; /source/search is the documented name, /search is the older alias.
  const startSearch = async (req, res) => {
    const b = await readJson(req);
    if (!b.query) return j(res, 400, { error: 'query required' });
    const job = jobs.enqueue({ type: 'media.search', page: b.page || '', project: b.project || '', params: { query: b.query, limit: b.limit, vision: b.vision !== false, visionLimit: b.visionLimit, page: b.page || '', project: b.project || '' } });
    j(res, 200, { ok: true, jobId: job.id, intent: source.parseIntent(b.query) });
  };
  routes['/api/v2/source/search'] = startSearch;
  routes['/api/v2/search'] = startSearch;
  /**
   * GET /api/v2/source/interpret?q= — what the discovery layer understood from the request.
   * Exposed so a bad ranking can be blamed on a bad reading instead of being a mystery.
   */
  routes['/api/v2/source/interpret'] = (req, res, u) => j(res, 200, { intent: source.parseIntent(u.searchParams.get('q') || '') });
  /**
   * POST /api/v2/source/import — import a candidate the owner selected.
   * The candidate is looked up server-side by id in the last search for that query: a client cannot
   * hand the importer an arbitrary stream URL that was never discovered or measured.
   */
  routes['/api/v2/source/import'] = async (req, res) => {
    const b = await readJson(req);
    const id = String(b.candidate || '').replace(/[^a-z0-9_]/gi, '');
    if (!id) return j(res, 400, { error: 'candidate id required' });
    let hit = null;
    for (const [, v] of LAST_SEARCH) { const c = v.r.candidates.find(x => String(x.id) === id); if (c) { hit = c; break; } }
    if (!hit) return j(res, 409, { error: 'that candidate is no longer in a recent search — search again and pick it from the results', code: 'stale_candidate' });
    const job = jobs.enqueue({
      type: 'media.import', page: b.page || '', project: b.project || '',
      params: { page: b.page || '', project: b.project || '', url: hit.source, title: hit.title, candidate: hit },
    });
    j(res, 200, { ok: true, jobId: job.id, candidate: { id: hit.id, title: hit.title, author: hit.author, duration: hit.duration } });
  };
  /**
   * POST /api/v2/source/save — keep a candidate in the library WITHOUT downloading it.
   * The same server-side lookup as import: the client names a candidate, the server decides what the
   * URL is. Saving stores a pointer plus what a search really measured, never a copy of the video.
   */
  routes['/api/v2/source/save'] = async (req, res) => {
    const b = await readJson(req);
    try {
      const id = String(b.candidate || '').replace(/[^a-z0-9_]/gi, '');
      let input = null;
      if (id) {
        let hit = null;
        for (const [, v] of LAST_SEARCH) { const c = v.r.candidates.find(x => String(x.id) === id); if (c) { hit = c; break; } }
        if (!hit) return j(res, 409, { error: 'that candidate is no longer in a recent search — search again and pick it from the fresh results', code: 'stale_candidate' });
        input = { url: hit.source, title: hit.title, author: hit.author, play: hit.play, cover: hit.cover, duration: hit.duration, platform: hit.source, page: b.page, collection: b.collection, note: b.note, tags: b.tags };
      } else if (b.url) {
        input = { url: b.url, title: b.title, author: b.author, duration: b.duration, page: b.page, collection: b.collection, note: b.note, tags: b.tags };
      } else {
        return j(res, 400, { error: 'a candidate id or a url is required to save a source' });
      }
      const r = saved.save(input);
      log('info', 'source.save', { id: r.record.id, created: r.created, page: b.page || '' });
      j(res, 200, { ok: true, created: r.created, source: fmtSaved(r.record), collections: saved.collections(), stats: saved.stats() });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  /** GET /api/v2/saved?q=&collection=&page= — the library, searched the way the owner talks to it. */
  routes['/api/v2/saved'] = (req, res, u) => {
    const r = saved.search({
      q: u.searchParams.get('q') || '', collection: u.searchParams.get('collection') || '',
      page: u.searchParams.get('page') || '', limit: u.searchParams.get('limit') || 50,
    });
    j(res, 200, { ...r, items: r.items.map(fmtSaved), collections: saved.collections(), stats: saved.stats() });
  };
  /** POST /api/v2/saved/forget — remove one saved source from the library. */
  routes['/api/v2/saved/forget'] = async (req, res) => {
    const b = await readJson(req);
    const id = String(b.id || '').replace(/[^a-z0-9_]/gi, '');
    const r = saved.remove(id);
    if (!r.removed) return j(res, 404, { error: 'that saved source is not in the library' });
    log('info', 'saved.forget', { id });
    j(res, 200, { ok: true, removed: r.record.id, collections: saved.collections(), stats: saved.stats() });
  };
  /**
   * POST /api/v2/saved/import — import a saved source through the SAME import job as a fresh
   * candidate, so a saved clip cannot take a second, less-validated path into a project.
   */
  routes['/api/v2/saved/import'] = async (req, res) => {
    const b = await readJson(req);
    const id = String(b.id || '').replace(/[^a-z0-9_]/gi, '');
    const rec = saved.get(id);
    if (!rec) return j(res, 404, { error: 'that saved source is not in the library' });
    const job = jobs.enqueue({
      type: 'media.import', page: b.page || rec.page || '', project: b.project || '',
      params: { page: b.page || rec.page || '', project: b.project || '', url: rec.url, title: rec.title || '' },
    });
    j(res, 200, { ok: true, jobId: job.id, source: fmtSaved(rec) });
  };

  /**
   * GET /api/v2/agent/context?page=&project= — the exact context block the agent is given.
   *
   * An answer can only be argued with when you can see what the agent was told. This exists so that
   * grounding (the footage versus the caption), locks and the real project state are INSPECTABLE
   * rather than a matter of trust. Read-only, no model call, so it is safe to hit while debugging.
   */
  routes['/api/v2/agent/context'] = (req, res, u) => {
    const key = String(u.searchParams.get('page') || 'studio').replace(/[^a-z0-9_]/gi, '');
    const pg = store.page(key);
    if (!pg) return j(res, 404, { error: 'unknown page: ' + key });
    const pid = String(u.searchParams.get('project') || '').replace(/[^a-z0-9_]/gi, '');
    const project = pid ? store.project(pid) : projectOf(key);
    const text = agent.contextBlock(pg, project, store.memory(key), { focus: u.searchParams.get('focus') || null });
    j(res, 200, {
      page: key, project: project ? project.id : null, workloadHints: null,
      chars: text.length, context: text,
    });
  };

  // ---------------------------------------------------------------- destinations + publishing
  routes['/api/v2/destinations'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    if (!pageKey || !store.pages().some(p => p.key === pageKey)) return j(res, 400, { error: 'unknown page' });
    j(res, 200, { page: pageKey, label: store.page(pageKey).label, destinations: publish.destinations(pageKey) });
  };
  // Names and connected-page identities can change in Meta. This is read-only at Graph and only
  // reconciles the local destination label after the returned id matches the configured id.
  routes['/api/v2/destinations/refresh'] = async (req, res) => {
    if (!legacy.refreshFacebookPages) return j(res, 501, { error: 'destination refresh is unavailable in this runtime' });
    try {
      const report = await legacy.refreshFacebookPages();
      j(res, 200, { ...report, destinations: store.pages().map(p => ({ page: p.key, destinations: publish.destinations(p.key) })) });
    } catch (e) { j(res, 502, { error: U.sanitizeText(e.message, 180) }); }
  };
  /** The owner's permission list for an agent. Only the owner can change it. */
  routes['/api/v2/destinations/set'] = async (req, res) => {
    const b = await readJson(req);
    const pageKey = String(b.page || '').replace(/[^a-z0-9_]/gi, '');
    if (!pageKey || !store.pages().some(p => p.key === pageKey)) return j(res, 400, { error: 'unknown page' });
    if (!Array.isArray(b.destinations)) return j(res, 400, { error: 'destinations array required' });
    const next = b.destinations.map(d => ({
      id: String(d.id || '').replace(/[^0-9a-z_.-]/gi, ''), name: U.sanitizeText(d.name || d.id, 80),
      platform: 'facebook', enabled: d.enabled !== false, source: 'owner',
    })).filter(d => d.id);
    const page = store.savePage(pageKey, { allowedDestinations: next });
    log('info', 'destinations.set', { page: pageKey, count: next.length });
    j(res, 200, { page: page.key, allowedDestinations: page.allowedDestinations, destinations: publish.destinations(pageKey) });
  };
  /** POST /api/v2/publish/plan — dry run. Nothing is posted. */
  routes['/api/v2/publish/plan'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, publish.plan({ artifacts: b.artifacts || [], destinations: b.destinations || [] })); }
    catch (e) { j(res, 400, { error: e.message }); }
  };
  /**
   * POST /api/v2/publish — the only thing that can put a video on a page. Requires the plan's token
   * plus an explicit confirm, and the permission check runs again here.
   */
  routes['/api/v2/publish'] = async (req, res) => {
    const b = await readJson(req);
    try {
      const r = await publish.execute({ artifacts: b.artifacts || [], destinations: b.destinations || [], token: b.token, confirm: b.confirm === true });
      // 400 = the request itself was wrong (no confirmation, stale token, nothing postable).
      // 502 = we genuinely tried to post and the platform refused. Conflating them made a client-side
      // confirmation mistake look like a server outage.
      if (!r.ok && !r.attempted) return j(res, 400, r);
      if (!r.ok && !r.plan) return j(res, 400, r);
      const owner = (b.artifacts || []).map(id => (store.artifact(String(id)) || {}).page).find(Boolean);
      if (owner) store.appendMessage(owner, {
        role: 'agent',
        text: r.ok ? '📤 Posted ' + r.posted + ' video(s)' + (r.failed ? ', ' + r.failed + ' failed' : '') : '✕ Publishing failed: ' + (r.error || 'no destinations accepted'),
        artifacts: [], tools: [], project: null, publish: { posted: r.posted || 0, failed: r.failed || 0, at: Date.now() },
      });
      j(res, r.ok ? 200 : 502, r);
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/publish/retry-failed'] = async (req, res) => {
    const b = await readJson(req);
    try {
      const r = await publish.retryFailed({ artifacts: b.artifacts || [], destinations: b.destinations || [], token: b.token, confirm: b.confirm === true });
      if (!r.ok && !r.attempted) return j(res, 400, r);
      j(res, r.ok ? 200 : 502, r);
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/agent/message'] = async (req, res) => {
    const b = await readJson(req);
    const pageKey = String(b.page || '').replace(/[^a-z0-9_]/gi, '');
    if (!store.pages().some(p => p.key === pageKey)) return j(res, 400, { error: 'unknown page: ' + b.page });
    const msg = U.sanitizeText(b.message, 2000);
    if (!msg) return j(res, 400, { error: 'empty message' });
    // A client can still hold a project id whose project is gone (deleted, or superseded while
    // the tab was open). Ignoring it here keeps a stale pointer from failing the owner's turn.
    const asked = String(b.project || '').replace(/[^a-z0-9_]/gi, '');
    // The orchestrator owns no media, so it never creates a project just to talk to the owner.
    const orchestrator = store.isOrchestrator(pageKey);
    const projectId = asked && store.project(asked) ? asked
      : orchestrator ? ''
      : (projectOf(pageKey) || saveProjectPointer(pageKey)).id;
    // `focus` is the artifact the owner was looking at when they typed. Keeping it on the message is
    // what makes "make the title shorter" mean the artifact on screen instead of the newest one.
    const focus = String(b.focus || '').replace(/[^a-z0-9_]/gi, '');
    const refs = (Array.isArray(b.refs) ? b.refs : []).map(x => String(x).replace(/[^a-z0-9_]/gi, '')).filter(Boolean).slice(0, 20);
    store.appendMessage(pageKey, { role: 'user', text: msg, project: projectId, focus: focus || null, refs: refs.length ? refs : null });
    const job = jobs.enqueue({ type: 'agent.turn', page: pageKey, project: projectId, params: { page: pageKey, project: projectId, message: msg, focus: focus || null, refs: refs.length ? refs : null } });
    j(res, 200, { ok: true, jobId: job.id, project: projectId, replacedStale: !!(asked && asked !== projectId) });
  };
  routes['/api/v2/agent/tool'] = async (req, res) => {
    const b = await readJson(req);
    const pageKey = String(b.page || '').replace(/[^a-z0-9_]/gi, '');
    if (!agent.toolNames().includes(b.tool)) return j(res, 400, { error: 'unknown tool ' + b.tool, available: agent.toolNames() });
    if (b.tool === 'media.search') { const job = jobs.enqueue({ type: 'media.search', page: pageKey, params: { query: (b.args || {}).query } }); return j(res, 200, { ok: true, jobId: job.id }); }
    const job = jobs.enqueue({ type: 'agent.tool', page: pageKey, project: b.project || '', params: { page: pageKey, project: b.project || '', tool: b.tool, args: b.args || {} } });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/tts'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.text) return j(res, 400, { error: 'text required' });
    const job = jobs.enqueue({ type: 'tts.generate', page: b.page || '', project: b.project || '', params: b });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/music/search'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, await musicSearch(String(b.query || '').slice(0, 120))); } catch (e) { j(res, 502, { error: e.message }); }
  };
  routes['/api/v2/music/save'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, await saveMusic({ id: b.id, page: b.page, project: b.project })); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/music/use'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, await useMusic({ id: b.id, page: b.page, project: b.project, volume: b.volume })); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/music/select'] = async (req, res) => {
    const b = await readJson(req);
    const job = jobs.enqueue({ type: 'media.op', page: b.page || '', project: b.project, params: { project: b.project, op: 'mix_music', args: { url: b.url, title: b.title, volume: b.volume }, page: b.page } });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/render'] = async (req, res) => {
    const b = await readJson(req);
    const job = jobs.enqueue({ type: 'media.op', page: b.page || '', project: b.project, params: { project: b.project, op: 'render', args: { mode: b.mode || 'preview' }, page: b.page } });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/op'] = async (req, res) => {
    const b = await readJson(req);
    const job = jobs.enqueue({ type: 'media.op', page: b.page || '', project: b.project, params: { project: b.project, op: b.op, args: b.args || {}, page: b.page } });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/job'] = (req, res, u) => {
    const job = jobs.get(u.searchParams.get('id'));
    if (!job) return j(res, 404, { error: 'job not found' });
    j(res, 200, jobs.publicJob(job));
  };
  routes['/api/v2/job/cancel'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, jobs.publicJob(jobs.cancel(b.id))); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/analytics/page'] = async (req, res, u) => {
    try { j(res, 200, await analyticsPage((u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, ''))); }
    catch (e) { j(res, 502, { error: e.message }); }
  };
  routes['/api/v2/templates'] = async (req, res, u, method) => {
    if (method === 'GET') return j(res, 200, { templates: store.templates() });
    const b = await readJson(req);
    try { j(res, 200, { template: store.saveTemplate(b) }); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/assets'] = (req, res, u) => j(res, 200, { assets: store.assets({ kind: u.searchParams.get('kind') }) });
  // ---------------------------------------------------------------- transcription / captions / timeline
  /** GET /api/v2/transcript?project=&id= — the panel and the agent's transcription.get read the same records. */
  routes['/api/v2/transcript'] = (req, res, u) => {
    const project = String(u.searchParams.get('project') || '').replace(/[^a-z0-9_]/gi, '');
    if (!project || !store.project(project)) return j(res, 400, { error: 'project required' });
    const id = u.searchParams.get('id');
    if (id) {
      const t = store.transcription(project, id);
      return t ? j(res, 200, { transcription: t }) : j(res, 404, { error: 'transcription not found' });
    }
    j(res, 200, {
      transcriptions: store.transcriptions(project),
      note: 'Segment times are produced by the transcription model and are not word-verified. Corrections are stored beside the original, never over it.',
    });
  };
  routes['/api/v2/transcribe'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.project || !store.project(b.project)) return j(res, 400, { error: 'project required' });
    const job = jobs.enqueue({
      type: 'transcription.run', page: b.page || '', project: b.project,
      params: { page: b.page || '', project: b.project, artifact: b.artifact || null, language: b.language || 'auto', force: !!b.force },
    });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/transcript/correct'] = async (req, res) => {
    const b = await readJson(req);
    try {
      const t = transcribe.correct(b.project, b.transcription, { segmentId: b.segment, text: b.text });
      broadcast({ type: 'transcript.corrected', ts: Date.now(), page: t.page, project: b.project, transcription: t.id });
      j(res, 200, { transcription: t });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/transcript/reset'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, { transcription: transcribe.clearCorrections(b.project, b.transcription) }); }
    catch (e) { j(res, 400, { error: e.message }); }
  };
  /** Caption tracks plus the presets the RENDERER honours — same source, so panel and output cannot drift. */
  routes['/api/v2/captions'] = (req, res, u) => {
    const project = String(u.searchParams.get('project') || '').replace(/[^a-z0-9_]/gi, '');
    const p = project ? store.project(project) : null;
    const cs = p ? editor.captionState(p) : { track: null, state: 'none' };
    j(res, 200, {
      tracks: p ? store.captionTracks(project) : [],
      active: cs.track ? { id: cs.track.id, state: cs.state, preset: cs.track.preset, version: cs.track.version, burnedTrack: cs.burnedTrack || null } : null,
      presets: captions.presets(),
      styleDefaults: media.STYLE_DEFAULTS,
      timing: cs.track ? captions.timingReport(cs.track) : null,
      safeZones: { vertical: { top: 12, bottom: 14, kind: 'guide', note: 'Typical platform UI on 9:16 posts. A guide, not a restriction.' } },
    });
  };
  routes['/api/v2/caption/create'] = async (req, res) => {
    const b = await readJson(req);
    const p = b.project ? store.project(b.project) : null;
    if (!p) return j(res, 400, { error: 'project required' });
    const trId = b.transcription || ((store.transcriptions(b.project)[0] || {}).id);
    if (!trId) return j(res, 409, { error: 'transcribe the video first — captions are built from measured transcript timings, never invented' });
    try {
      const track = captions.createTrack({ projectId: b.project, page: p.page, transcriptionId: trId, preset: b.preset || 'bold_social', options: b.options || {} });
      broadcast({ type: 'caption.created', ts: Date.now(), page: p.page, project: b.project, track: track.id, segments: track.segments.length });
      j(res, 200, { track, timing: captions.timingReport(track) });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/caption/update'] = async (req, res) => {
    const b = await readJson(req);
    try {
      const track = captions.updateTrack({ projectId: b.project, trackId: b.track, segments: b.segments || null, style: b.style || null, preset: b.preset || null });
      broadcast({ type: 'caption.updated', ts: Date.now(), page: track.page, project: b.project, track: track.id, version: track.version });
      j(res, 200, { track, timing: captions.timingReport(track) });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/caption/burn'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.project) return j(res, 400, { error: 'project required' });
    const job = jobs.enqueue({ type: 'caption.burn', page: b.page || '', project: b.project, params: { page: b.page || '', project: b.project, track: b.track || null } });
    j(res, 200, { ok: true, jobId: job.id });
  };
  routes['/api/v2/caption/preset'] = async (req, res) => {
    const b = await readJson(req);
    try { j(res, 200, { preset: store.saveCaptionStyle(b.name, b.style || {}) }); }
    catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/caption/preset/delete'] = async (req, res) => {
    const b = await readJson(req);
    try { store.deleteCaptionStyle(b.name); j(res, 200, { ok: true }); } catch (e) { j(res, 400, { error: e.message }); }
  };
  const needProject = (u, res) => {
    const project = String(u.searchParams.get('project') || '').replace(/[^a-z0-9_]/gi, '');
    if (!project || !store.project(project)) { j(res, 400, { error: 'project required' }); return null; }
    return project;
  };
  routes['/api/v2/timeline'] = (req, res, u) => {
    const project = needProject(u, res); if (!project) return;
    try { j(res, 200, editor.timeline(project)); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/versiontree'] = (req, res, u) => {
    const project = needProject(u, res); if (!project) return;
    try { j(res, 200, editor.versionTree(project)); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/drawer'] = (req, res, u) => {
    const project = needProject(u, res); if (!project) return;
    try { j(res, 200, editor.drawer(project)); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/suggestions'] = (req, res, u) => {
    const project = needProject(u, res); if (!project) return;
    try { j(res, 200, editor.suggestions(project)); } catch (e) { j(res, 400, { error: e.message }); }
  };
  routes['/api/v2/preview'] = async (req, res) => {
    const b = await readJson(req);
    try { const r = previewRender({ page: b.page, project: b.project }); j(res, 200, { ok: true, jobId: r.job.id, coalesced: r.coalesced }); }
    catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- edit locks
  routes['/api/v2/locks'] = (req, res, u) => {
    const project = needProject(u, res); if (!project) return;
    const p = store.project(project);
    if (!p) return j(res, 404, { error: 'project not found' });
    j(res, 200, {
      project: p.id, role: p.role, suite: p.suite || null,
      layers: LOCK.describe(p.locks, store.inheritedLocks(p.id)),
      inheritedFrom: p.master ? p.master.project : null,
      note: 'Locks are persisted on the project and enforced in the media layer before any file is written.',
    });
  };
  /** POST /api/v2/locks/set — {project, layer, locked} toggles one; {project, locks} replaces all. */
  routes['/api/v2/locks/set'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.project) return j(res, 400, { error: 'project required' });
    const p = store.project(b.project);
    if (!p) return j(res, 404, { error: 'project not found' });
    try {
      let next = { ...(p.locks || {}) };
      if (b.layer) {
        if (!LOCK.BY_KEY.has(b.layer)) return j(res, 400, { error: 'unknown layer: ' + b.layer + ' — known: ' + LOCK.LAYERS.map(l => l.key).join(', ') });
        // A branch cannot release a lock its master holds: only the master can. Saying so is more
        // useful than silently ignoring the click.
        const inh = store.inheritedLocks(p.id);
        if (inh[b.layer] && b.locked === false) {
          return j(res, 409, { error: LOCK.BY_KEY.get(b.layer).label + ' is locked on the master edit, so this branch inherits it. Change it on the master to release it here.', layer: b.layer, inherited: true });
        }
        if (b.locked === false) delete next[b.layer]; else next[b.layer] = true;
      } else if (b.locks) next = b.locks;
      const saved = store.setLocks(p.id, next);
      broadcast({ type: 'locks.changed', ts: Date.now(), page: saved.page, project: saved.id, locks: saved.locks });
      j(res, 200, { project: saved.id, locks: saved.locks, layers: LOCK.describe(saved.locks, store.inheritedLocks(saved.id)) });
    } catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- plan: validate + diff
  /**
   * POST /api/v2/plan/preview — what a plan WOULD do. Pure: nothing is queued, no media is touched.
   * Returns the structured operations, the locked ones that will be refused (with the reason), and a
   * real before→after diff built from the project's current state.
   */
  routes['/api/v2/plan/preview'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.project) return j(res, 400, { error: 'project required' });
    const p = store.project(b.project);
    if (!p) return j(res, 404, { error: 'project not found' });
    try {
      const v = plan.validate(p, b.ops || []);
      if (v.unknown.length) return j(res, 400, { error: 'unknown operation(s): ' + v.unknown.join(', ') + ' — known: ' + media.opNames.join(', '), unknown: v.unknown });
      const willRun = [...v.accepted];
      j(res, 200, {
        project: p.id, role: p.role,
        ops: willRun.map((x, i) => ({
          index: i, op: x.op, args: x.args, reason: x.reason,
          layer: (plan.opEffect(p, x.op, x.args) || {}).layer || null,
          requiresApproval: needsCheckpoint(p.page, x.op, b.checkpoint, i === willRun.length - 1),
        })),
        skippedByUser: v.skipped,
        blocked: v.blocked,
        diff: plan.diff(p, willRun),
        note: 'Preview only — nothing was queued and no file was written.',
      });
    } catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- suites: master + branches
  routes['/api/v2/suites'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    j(res, 200, { suites: suite.suitesOf(pageKey || null) });
  };
  routes['/api/v2/suite'] = (req, res, u) => {
    const id = u.searchParams.get('suite');
    if (!id) return j(res, 400, { error: 'suite required' });
    try { j(res, 200, suite.comparison(id)); } catch (e) { j(res, 404, { error: e.message }); }
  };
  /** POST /api/v2/suite/create — {page, title, from?} → a suite with a master edit. */
  routes['/api/v2/suite/create'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.page) return j(res, 400, { error: 'page required' });
    try {
      const r = suite.startMaster({ page: b.page, title: b.title, from: b.from || null, ctx: { progress() {} } });
      broadcast({ type: 'suite.created', ts: Date.now(), page: String(b.page).replace(/[^a-z0-9_]/gi, ''), suite: r.suite.id, master: r.master.id });
      j(res, 200, { suite: r.suite, master: r.master });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  /** POST /api/v2/suite/master/approve — {project, status, note}. Human approval before branching. */
  routes['/api/v2/suite/master/approve'] = async (req, res) => {
    const b = await readJson(req);
    try {
      const p = store.setMasterStatus(b.project, b.status || 'approved', b.note || '');
      store.setReview(p.id, p.masterStatus === 'approved' ? 'approved' : p.masterStatus === 'rejected' ? 'rejected' : 'waiting', { note: b.note || '' });
      broadcast({ type: 'master.approved', ts: Date.now(), page: p.page, project: p.id, status: p.masterStatus });
      j(res, 200, { project: store.project(p.id) });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  /**
   * POST /api/v2/suite/branch — {suite, page, recipe?} create ONE branch and its plan (no renders).
   * The plan is returned so the owner can see exactly which steps will run and which will be skipped.
   */
  routes['/api/v2/suite/branch'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.suite || !b.page) return j(res, 400, { error: 'suite + page required' });
    try {
      const br = suite.createBranch({ suiteId: b.suite, page: b.page, recipe: b.recipe || null, requireApproval: b.requireApproval !== false });
      const recipe = (br.branch && br.branch.recipe) || suite.recipeFor(b.page);
      j(res, 200, { branch: br, plan: suite.branchPlan(br, recipe), recipe });
    } catch (e) { j(res, 400, { error: e.message }); }
  };
  /** POST /api/v2/suite/generate — {suite, pages[], recipes?, requireApproval?} → a real batch job. */
  routes['/api/v2/suite/generate'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.suite) return j(res, 400, { error: 'suite required' });
    const jobs0 = jobs.enqueue({
      type: 'branch.generate', page: b.page || '', project: '',
      params: { page: b.page || '', suite: b.suite, pages: b.pages || null, recipe: b.recipes || null, requireApproval: b.requireApproval !== false },
    });
    j(res, 200, { ok: true, jobId: jobs0.id });
  };
  /** POST /api/v2/branch/regenerate — {branch, only} where only = all|hook|tts|music|captions. */
  routes['/api/v2/branch/regenerate'] = async (req, res) => {
    const b = await readJson(req);
    if (!b.branch) return j(res, 400, { error: 'branch required' });
    const p = store.project(b.branch);
    if (!p || p.role !== 'branch') return j(res, 400, { error: 'that project is not a page branch' });
    try {
      const r = await suite.regenerateBranch({ branchId: b.branch, only: b.only || 'all', ctx: { progress() {}, note() {} } });
      broadcast({ type: 'branch.regenerated', ts: Date.now(), page: p.page, project: p.id, mode: r.mode });
      j(res, 200, { ok: true, mode: r.mode, status: r.status, artifact: r.artifact ? fmtArtifact(r.artifact) : null, skipped: r.skipped || [] });
    } catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- review queue
  routes['/api/v2/review'] = (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    const items = store.reviewQueue({ page: pageKey || null, state: u.searchParams.get('state') || null });
    const counts = {};
    for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;
    j(res, 200, { items, counts, total: items.length, note: 'The queue is derived from persisted project state, so it survives a refresh and a restart.' });
  };
  /** POST /api/v2/review/decision — {project, state, note} for one item. */
  routes['/api/v2/review/decision'] = async (req, res) => {
    const b = await readJson(req);
    const state = ['waiting', 'approved', 'fix_requested', 'regenerating', 'rejected', 'done', 'failed'].includes(b.state) ? b.state : null;
    if (!b.project || !state) return j(res, 400, { error: 'project + state (waiting|approved|fix_requested|regenerating|rejected|done|failed) required' });
    const p = store.project(b.project);
    if (!p) return j(res, 404, { error: 'project not found' });
    try {
      if (b.artifact) {
        const target = store.artifact(b.artifact);
        if (!target || target.project !== p.id) return j(res, 400, { error: 'artifact does not belong to this project' });
      }
      const rec = store.setReview(p.id, state, { note: b.note || '', artifact: b.artifact || p.current || null });
      store.appendMessage(p.page, {
        role: 'user',
        text: (state === 'approved' ? '✅ Approved' : state === 'rejected' ? '❌ Rejected' : state === 'fix_requested' ? '✏️ Fix requested' : '• ' + state) + ': ' + (p.title || p.id) + (b.note ? ' — ' + b.note : ''),
        project: p.id, decision: { decision: state === 'approved' ? 'approve' : state, note: b.note || '' },
      });
      broadcast({ type: 'review.decided', ts: Date.now(), page: p.page, project: p.id, state });
      j(res, 200, { project: rec.id, review: rec.review });
    } catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- batch operations
  /** POST /api/v2/batch/correct — {branches[], kind, value, dryRun} — dry run by default. */
  routes['/api/v2/batch/correct'] = async (req, res) => {
    const b = await readJson(req);
    if (!Array.isArray(b.branches) || !b.branches.length) return j(res, 400, { error: 'branches (array of project ids) required' });
    try { j(res, 200, suite.batchCorrect({ branches: b.branches, kind: b.kind, value: b.value, dryRun: b.dryRun !== false })); }
    catch (e) { j(res, 400, { error: e.message }); }
  };
  /** POST /api/v2/batch/approve — {branches[], decision, note} */
  routes['/api/v2/batch/approve'] = async (req, res) => {
    const b = await readJson(req);
    if (!Array.isArray(b.branches) || !b.branches.length) return j(res, 400, { error: 'branches (array of project ids) required' });
    const r = suite.batchApprove({ branches: b.branches, decision: b.decision || 'approve', note: b.note || '' });
    broadcast({ type: 'batch.decided', ts: Date.now(), page: b.page || '', decision: r.decision, count: r.count });
    j(res, 200, r);
  };
  /** POST /api/v2/batch/restore — TEST SUPPORT ONLY. Writes an exact batch snapshot through the
   * LIVE server's own store, so a test-process restore can never lose the race against the
   * server's in-memory batch. Refuses anything that is not the current batch. */
  routes['/api/v2/batch/restore'] = async (req, res) => {
    const b = await readJson(req);
    const snap = b && b.batch;
    const cur = store.currentBatch();
    if (!snap || !snap.id || !snap.profiles) return j(res, 400, { error: 'batch snapshot required' });
    if (!cur || cur.id !== snap.id) return j(res, 409, { error: 'snapshot is not the current batch' });
    try {
      store.saveBatch(snap);
      j(res, 200, { ok: true, id: snap.id, stage: store.currentBatch().stage });
    } catch (e) { j(res, 400, { error: e.message }); }
  };

  // ---------------------------------------------------------------- performance + variation
  /**
   * GET /api/v2/analytics/intel — observations from the metrics the platform ACTUALLY returned.
   * No model is asked to "analyse" anything, and nothing is claimed that the numbers do not show.
   * With too small a sample the endpoint says so instead of inventing a pattern.
   */
  routes['/api/v2/analytics/intel'] = async (req, res, u) => {
    const pageKey = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    if (!pageKey) return j(res, 400, { error: 'page required' });
    try { j(res, 200, await analyticsIntel(pageKey)); }
    catch (e) { j(res, 400, { error: e.message }); }
  };
  /**
   * analyticsIntel — extracted so the agent tool and the HTTP route run the same arithmetic.
   * Every line it emits is computed from values the platform returned, and it carries its own sample
   * size so a two-post "pattern" cannot be mistaken for a finding.
   */
  async function analyticsIntel(pageKey) {
    {
      const data = await analyticsPage(pageKey);
      const posts = (data.posts || []).filter(x => x && (x.id || x.post_id));
      const num = v => (isFinite(Number(v)) ? Number(v) : null);
      const views = p => num(p.views != null ? p.views : p.video_views != null ? p.video_views : p.impressions);
      const likes = p => num(p.likes != null ? p.likes : p.reactions);
      const shares = p => num(p.shares);
      const comments = p => num(p.comments);
      // Only the fields this build can actually read are named as available.
      const readers = { views, likes, shares, comments };
      const metricsAvailable = Object.keys(readers).filter(k => posts.some(p => readers[k](p) != null));
      const items = [];
      const withViews = posts.map(p => ({ p, v: views(p) })).filter(x => x.v != null);
      if (posts.length && !metricsAvailable.length) {
        items.push({ kind: 'data', severity: 'info', label: 'The platform returned no per-post metrics', detail: 'The API responded with ' + posts.length + ' post(s) but none of the fields this build can read (views, likes, shares, comments). Nothing is inferred from that.', evidence: 'GET page analytics → ' + posts.length + ' posts, 0 readable metric fields' });
      }
      if (withViews.length >= 4) {
        withViews.sort((a, b) => b.v - a.v);
        const best = withViews[0], worst = withViews[withViews.length - 1];
        const median = withViews[Math.floor(withViews.length / 2)].v;
        items.push({ kind: 'top', severity: 'info', label: 'Top post by views: ' + best.v, detail: 'In the ' + withViews.length + ' posts that returned a view count, the highest is ' + best.v + ' and the median is ' + median + '.', evidence: 'view counts from the platform API, sample size ' + withViews.length, sample: withViews.length, post: best.p.id || best.p.post_id || null });
        if (best.v >= median * 2) items.push({ kind: 'spread', severity: 'info', label: 'One post is well above the rest', detail: 'The top post has about ' + (Math.round((best.v / Math.max(1, median)) * 10) / 10) + '× the median views. With a sample this size that is a possible pattern, not a proven cause — the post may simply have been promoted or published at a better time.', evidence: 'top ' + best.v + ' vs median ' + median + ' over ' + withViews.length + ' posts', sample: withViews.length, post: best.p.id || best.p.post_id || null });
      } else if (posts.length) {
        items.push({ kind: 'sample', severity: 'info', label: 'Not enough view data to compare posts', detail: withViews.length + ' of ' + posts.length + ' post(s) returned a view count. Comparing fewer than four posts would not mean anything, so no comparison is drawn.', evidence: 'sample size ' + withViews.length });
      }
      const lowEngagement = posts.map(p => ({ p, l: likes(p), v: views(p) })).filter(x => x.l != null && x.v);
      if (lowEngagement.length >= 4) {
        const rates = lowEngagement.map(x => x.l / x.v).sort((a, b) => a - b);
        items.push({ kind: 'engagement', severity: 'info', label: 'Like rate by post', detail: 'Across ' + rates.length + ' posts with both counts, likes-per-view ranges from ' + (Math.round(rates[0] * 10000) / 100) + '% to ' + (Math.round(rates[rates.length - 1] * 10000) / 100) + '%. This is a correlation in the available sample only.', evidence: 'likes ÷ views over ' + rates.length + ' posts', sample: rates.length });
      }
      return {
        page: pageKey, posts: posts.length, metricsAvailable,
        items,
        disclaimer: 'Every line above is arithmetic over values the platform actually returned. No causation is claimed and no metric is estimated.',
        updated_at: data.updated_at || null,
      };
    }
  }
  /**
   * POST /api/v2/variation — start a variation from a real content item.
   * It NEVER touches the original. It opens a new project on the same page, and it is explicit about
   * whether it could find the local master/branch behind that post — inventing a link would be worse
   * than admitting there is none.
   */
  routes['/api/v2/variation'] = async (req, res) => {
    const b = await readJson(req);
    const pageKey = String(b.page || '').replace(/[^a-z0-9_]/gi, '');
    if (!pageKey) return j(res, 400, { error: 'page required' });
    try {
      // Look for a local project that could be the ancestor of that post: an approved branch or a
      // published project on this page. We only claim a link when an id actually matches.
      const candidates = store.listProjects(pageKey).map(x => store.project(x.id)).filter(Boolean);
      const owned = candidates.filter(p => (p.approvals || []).some(a => a.checkpoint === 'branch_review' && a.decision === 'approve'))
        .concat(candidates.filter(p => p.role === 'branch'));
      const distinct = [...new Map(owned.map(p => [p.id, p])).values()];
      const source = b.project ? store.project(b.project) : (distinct[0] || null);
      const postId = b.postId ? String(b.postId).slice(0, 64) : null;
      const from = source && source.current ? store.artifact(source.current) : null;
      if (!source || !from) {
        // No local media to vary: create the project anyway, tagged with the insight, so the owner can
        // import or search a new source into it. Saying "no local source" is the honest outcome.
        const p = store.createProject(pageKey, 'Variation' + (postId ? ' of post ' + postId : ''));
        p.analysis = { variation_of: postId, note: 'No local master or branch on this page could be matched to that post, so this project has no source yet. Import or search for a video to build the variation on.' };
        store.saveProject(p);
        return j(res, 200, { project: p.id, linked: false, note: p.analysis.note });
      }
      const p = store.createProject(pageKey, 'Variation — ' + (source.title || source.id), {
        role: 'branch', suite: source.suite || null,
        master: source.master || null,
        source: source.source || null, analysis: { ...(source.analysis || {}), variation_of: postId, variation_of_project: source.id, note: 'A variation created from ' + source.id + '. The original is untouched.' },
        locks: {},
        branch: { id: U.uid('B'), page: pageKey, pageLabel: store.page(pageKey).label, recipe: null, variationOf: source.id },
      });
      store.linkArtifact(p.id, from.id, { op: 'branch', label: 'Variation source — ' + (from.label || from.op), kind: from.kind, version: 1 });
      if ((source.transcriptions || []).length) store.shareTranscription(p.id, source.transcriptions);
      store.setReview(p.id, 'waiting', { note: 'Variation created from ' + source.id + '; nothing has been rendered yet.' });
      j(res, 200, { project: p.id, linked: true, from: { project: source.id, artifact: from.id }, note: 'The original project and its versions are unchanged.' });
    } catch (e) { j(res, 400, { error: e.message }); }
  };

  /**
   * GET /api/v2/retention — the disk report: what is stored, what is referenced, what is only
   * scratch, and what a cleanup would remove. Reads only. `POST /api/v2/retention/sweep` is the
   * destructive half and is a dry run unless the caller passes confirm:true.
   */
  routes['/api/v2/retention'] = (req, res, u) => {
    j(res, 200, retention.mediaReport(store, { mediaDir: MEDIA_ROOT, cacheDir: CACHE, legacyMediaDir: (STORAGE && STORAGE.legacyMediaDir) || path.join(DATA, 'media') }, {
      cacheHours: Number(u.searchParams.get('cacheHours')) || undefined,
      scratchHours: Number(u.searchParams.get('scratchHours')) || undefined,
    }));
  };
  routes['/api/v2/retention/sweep'] = async (req, res) => {
    const b = await readJson(req);
    const r = retention.sweep(store, { mediaDir: MEDIA_ROOT, cacheDir: CACHE, legacyMediaDir: (STORAGE && STORAGE.legacyMediaDir) || path.join(DATA, 'media') }, {
      confirm: b.confirm === true,
      cacheHours: Number(b.cacheHours) || undefined,
      scratchHours: Number(b.scratchHours) || undefined,
    });
    if (!r.dryRun) log('info', 'retention.sweep', { deleted: r.deleted, bytes: r.bytes });
    j(res, 200, r);
  };
  routes['/api/v2/health'] = (req, res) => j(res, 200, {
    ok: true, pages: store.pages().length, projects: store.listProjects().length,
    jobs: jobs.list({}).length, tools: agent.toolNames().length, ffmpeg: media.FFMPEG,
    suites: store.suites().length, locks: LOCK.LAYERS.length,
  });
  /**
   * GET /api/v2/projects — the library: every project, across pages, with what makes it usable.
   * The left rail needs one honest list of what exists, rather than making the owner remember
   * which page agent a piece of work belongs to. `versions` is the real artifact count.
   */
  routes['/api/v2/projects'] = (req, res, u) => {
    const page = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '');
    const all = store.listProjects(page || undefined);
    j(res, 200, {
      projects: all.map(p => ({
        id: p.id, page: p.page, title: p.title, role: p.role || 'standalone',
        masterStatus: p.masterStatus || null, current: p.current || null, status: p.status || null,
        approvedArtifact: p.approvedArtifact || null,
        versions: (p.artifacts || []).length, updated: p.updated || null, created: p.created || null,
        review: (p.review && p.review.state) || null, suite: p.suite || null,
        locks: Object.keys(p.locks || {}).filter(k => p.locks[k]).length,
      })),
      total: all.length,
    });
  };

  // ---------------------------------------------------------------- static media
  function serveStudioMedia(req, res, u) {
    const parts = u.pathname.replace('/studio-media/', '').split('/').map(s => U.safeName(decodeURIComponent(s), 120));
    const projectId = parts[0], name = parts[1];
    const dir = path.join(MEDIA_ROOT, projectId);
    const f = path.join(dir, name);
    if (!U.isInside(MEDIA_ROOT, f) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    const stat = fs.statSync(f), range = req.headers.range;
    // correct MIME per extension — a .wav served as audio/mpeg makes some browsers refuse to play it
    const ct = /\.png$/i.test(f) ? 'image/png'
      : /\.jpe?g$/i.test(f) ? 'image/jpeg'
      : /\.webp$/i.test(f) ? 'image/webp'
      : /\.wav$/i.test(f) ? 'audio/wav'
      : /\.mp3$/i.test(f) ? 'audio/mpeg'
      : /\.(m4a|aac)$/i.test(f) ? 'audio/mp4'
      : /\.(ass|srt)$/i.test(f) ? 'text/plain; charset=utf-8'
      : /\.webm$/i.test(f) ? 'video/webm'
      : 'video/mp4';
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = m ? +m[1] : 0, end = m && m[2] ? +m[2] : stat.size - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': ct });
      fs.createReadStream(f, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': ct, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(f).pipe(res);
    }
  }

  // Log rotation happens once at boot and then hourly: activity.jsonl gained a record per model
  // call with nothing ever trimming it, which is a full disk waiting to happen.
  const housekeeping = retention.install({ LOGDIR }, {
    logMaxBytes: (Number(process.env.VS_LOG_MAX_MB) || 8) * 1024 * 1024,
    logKeep: Number(process.env.VS_LOG_KEEP) || 5,
    intervalMinutes: 60,
  });
  if (housekeeping.rotated.length) log('info', 'logs.rotated', { n: housekeeping.rotated.length });

  return {
    routes, serveStudioMedia, store, media, jobs, agent, log, broadcast, recordActivity,
    services: { importUrl, search, tts, musicSearch, analyticsPage, transcribe, captions, editor, burnCaptions, previewRender },
    transcribe, captions, editor, retention, understanding, pipeline, automation, telegram, telegramAgent, monitor, learning, studioTools,
    STUDIO, MEDIA_ROOT, LOGDIR, CACHE, STORAGE,
  };
}

module.exports = { createStudio };
