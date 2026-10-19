'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

function attachUnderstanding(project, result, assetId, source) {
  project.videoUnderstanding = { id: result.id, status: result.status, asset: assetId, source: source.url,
    coverage: result.coverage, timeline: result.timeline, narrationBrief: result.narrationBrief };
  if (result.status === 'completed') {
    project.analysis = {
      scene_descriptions_text: result.timeline.map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}s: ${s.description}`).join(' | '),
      product_visible: source.screening && source.screening.product || 'Smartphone unboxing',
      visible_text: [...new Set(result.timeline.flatMap(s => s.visibleText || []))],
      visual_notes: `Entire ${result.duration}s source inspected by three roles. Timings are model estimates mapped to source playback.`,
      understanding_id: result.id, narration_brief: result.narrationBrief,
    };
    project.truth = U.footageTruth(project.analysis, project.source && project.source.meta && project.source.meta.title) || project.truth;
  }
  project.status = result.status === 'completed' ? 'narration_ready' : result.status;
  return project;
}

function createPipeline(o) {
  const { store, jobs, understanding } = o;
  const routes = {};
  const DEFAULT_KEY = 'phone-unboxing-lab';
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function read(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 16000) throw Error('request too large'); }
    return JSON.parse(text || '{}');
  }
  function projectFor(value) {
    const key = String(value || DEFAULT_KEY);
    const exact = store.project(key);
    if (exact) {
      if (!exact.pipelineKey) throw Error('Choose an unboxing pipeline project to keep its work separate.');
      return exact;
    }
    if (key !== DEFAULT_KEY) throw Error('Unknown pipeline project');
    for (const summary of store.listProjects()) {
      const p = store.project(summary.id);
      if (p && p.pipelineKey === key) return p;
    }
    return store.createProject(store.ORCHESTRATOR, 'Phone Unboxing Lab', {
      pipelineKey: key, pipelineSearches: [], understandingIds: [],
      description: 'Phone unboxing discovery, visual screening, whole-video understanding and grounded narration.',
    });
  }
  const publicAnalysis = a => {
    if (!a) return null;
    const { asset, ...rest } = a;
    return { ...rest, assetId: a.assetId || asset && asset.id || null };
  };
  function queued(p, source) {
    const rec = understanding.save({ id: U.uid('VU'), project: p.id, page: p.page, source,
      status: 'queued', duration: 0, progress: 0, roles: [], timeline: [], errors: [],
      narrationBrief: null, coverage: null, ts: Date.now(), updatedAt: Date.now() });
    p.understandingIds = [...(p.understandingIds || []), rec.id];
    store.saveProject(p);
    return rec;
  }
  function candidateFrom(input) {
    if (!input.searchJobId) return null;
    const job = jobs.get(String(input.searchJobId));
    const hit = job && job.result && Array.isArray(job.result.candidates)
      && job.result.candidates.find(c => String(c.id) === String(input.candidateId));
    if (!hit || (input.sourceUrl && input.sourceUrl !== hit.source)) throw Error('The chosen source does not match the saved search.');
    return hit;
  }
  function rememberSearch(p, snapshot) {
    p = store.project(p.id);
    const list = p.pipelineSearches || [];
    p.pipelineSearches = [snapshot, ...list.filter(x => x.id !== snapshot.id)].slice(0, 24);
    store.saveProject(p);
  }
  async function execute(job, ctx, doSearch) {
    const input = job.params;
    const p = projectFor(job.project);
    const cancelled = () => (jobs.get(job.id) || {}).status === 'cancelled';
    const guard = () => { if (cancelled()) throw Error('Pipeline cancelled'); };
    const id = input.analysisId;
    let rec = understanding.get(id);
    const update = change => { rec = understanding.save({ ...understanding.get(id), ...change, updatedAt: Date.now() }); };
    try {
      guard();
      let candidate = candidateFrom(input);
      let url = input.sourceUrl;
      if (doSearch) {
        update({ status: 'searching' });
        const result = await o.search(input.query, ctx, { project: p.id, page: p.page, limit: 1, vision: true });
        guard();
        rememberSearch(p, { id: job.id, status: result.candidates.length ? 'found' : 'no_match', query: input.query,
          search: result.search, considered: result.considered, dropped: result.dropped, candidates: result.candidates, ts: Date.now() });
        candidate = result.candidates[0];
        if (!candidate) {
          update({ status: 'no_match', errors: ['The automatic search rounds found no verified clean unboxing video.'], progress: 0 });
          return { status: 'no_match', analysisId: id, project: p.id };
        }
        url = candidate.source;
        if (p.automationBatch || p.learningReference || p.assistantProduction) store.markSourceUsed({ url, platformId: candidate.id, project: p.id, page: p.page, reason: 'automatic_source_selected' });
      } else if (candidate) {
        const previous = jobs.get(input.searchJobId);
        rememberSearch(p, { id: previous.id, status: 'found', query: previous.params.query,
          search: previous.result.search, considered: previous.result.considered, dropped: previous.result.dropped,
          candidates: previous.result.candidates, ts: previous.ended || previous.ts });
      }
      if (!/^https:\/\//i.test(String(url || ''))) throw Error('A public HTTPS video source is required');
      const source = { url, title: candidate && candidate.title || input.title || 'Phone unboxing',
        cover: candidate && candidate.cover || '', videoId: candidate && candidate.id || null,
        searchJobId: input.searchJobId || (doSearch ? job.id : null), screening: candidate && candidate.signals || null };
      update({ status: 'importing', source, progress: 2 });
      const imported = await o.importUrl({ page: p.page, project: p.id, url, title: source.title,
        candidate, ctx, skipLegacyAnalysis: true });
      guard();
      if (!source.videoId) source.videoId = imported.source.id;
      if (!source.cover) source.cover = imported.video.cover || '';
      source.title = imported.source.title || source.title;
      const asset = imported.artifact;
      update({ status: 'analyzing', source, assetId: asset.id, asset: { id: asset.id, file: asset.file }, duration: imported.validated.duration });
      const result = await understanding.analyze({ id, asset: { id: asset.id, file: asset.file }, source, project: p.id, page: p.page },
        { ...ctx, shouldStop: cancelled });
      guard();
      store.saveProject(attachUnderstanding(store.project(p.id), result, asset.id, source));
      if (input.campaign && result.status === 'completed') {
        const campaign = o.campaignStart({ analysisId: id, pages: input.pages, publish: input.publish, confirm: input.confirm });
        return { status: 'campaign_queued', analysisId: id, project: p.id, campaign };
      }
      if (input.produce && result.status === 'completed') {
        const production = await o.produce({ project: p.id, analysis: result, ctx, guard });
        return { status: 'assembled', analysisId: id, project: p.id, production };
      }
      return { status: result.status, analysisId: id, project: p.id, scenes: result.timeline.length, coverage: result.coverage };
    } catch (e) {
      if (input.produce) {
        const failedProject = store.project(p.id);
        failedProject.status = cancelled() ? 'cancelled' : 'failed';
        failedProject.productionError = U.sanitizeText(e.message, 400);
        store.saveProject(failedProject);
      }
      const current = understanding.get(id) || rec;
      if (current && !['failed', 'cancelled'].includes(current.status)) {
        update({ status: cancelled() ? 'cancelled' : 'failed', errors: [...(current.errors || []), U.sanitizeText(e.message, 400)] });
      }
      throw e;
    }
  }
  jobs.register('video.understanding', (job, ctx) => execute(job, ctx, false));
  jobs.register('pipeline.run', (job, ctx) => execute(job, ctx, true));
  jobs.register('pipeline.post', async (job, ctx) => o.post({ project: job.project, ctx,
    guard: () => { if (jobs.get(job.id)?.status === 'cancelled') throw Error('Posting cancelled'); } }));
  routes['/api/v2/pipeline/post'] = async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    try {
      const input = await read(req);
      if (input.publish && input.confirm !== true) throw Error('Explicit publication confirmation required');
      if (input.confirm !== true) throw Error('Explicit publish confirmation required');
      const p = projectFor(input.project);
      const pending = jobs.list({ project: p.id }).find(j => ['pipeline.run', 'pipeline.produce', 'pipeline.post'].includes(j.type) && ['queued', 'running'].includes(j.status));
      if (pending) return send(res, 200, { ok: true, coalesced: true, jobId: pending.id });
      const job = jobs.enqueue({ type: 'pipeline.post', project: p.id, page: p.page, params: { confirm: true } });
      return send(res, 202, { ok: true, jobId: job.id });
    } catch (e) { return send(res, 400, { error: U.sanitizeText(e.message, 400) }); }
  };
  jobs.register('pipeline.produce', async (job, ctx) => {
    const analysis = understanding.get(job.params.analysisId);
    if (!analysis || analysis.project !== job.project || analysis.status !== 'completed') throw Error('A completed analysis belonging to this project is required');
    const guard = () => { if (jobs.get(job.id)?.status === 'cancelled') throw Error('Production cancelled'); };
    try {
      const production = await (job.params.revoice ? o.revoice : job.params.style ? o.style : job.params.decorate ? o.decorate : o.produce)({ project: job.project, analysis, ctx, guard });
      if (job.params.publish && job.params.confirm) {
        const publication = await o.post({ project: job.project, ctx, guard });
        return { status: 'published', analysisId: analysis.id, project: job.project, production: store.project(job.project).productionResult, publication };
      }
      return { status: 'assembled', analysisId: analysis.id, project: job.project, production };
    } catch (error) {
      const p = store.project(job.project); p.status = jobs.get(job.id)?.status === 'cancelled' ? 'cancelled' : 'failed'; p.productionError = U.sanitizeText(error.message, 400); store.saveProject(p); throw error;
    }
  });
  routes['/api/v2/pipeline/restore'] = async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    try {
      const input = await read(req), job = jobs.get(input.jobId);
      if (!job || job.status !== 'done' || !job.result?.production) throw Error('Choose a completed production job');
      const p = projectFor(job.project);
      if (jobs.list({ project: p.id }).some(j => ['queued', 'running'].includes(j.status))) throw Error('Wait for active project jobs before restoring');
      const production = job.result.production, video = store.artifact(production.videoId);
      if (!video || video.project !== p.id || !fs.existsSync(video.file)) throw Error('The saved output file is unavailable');
      store.rollback(p.id, video.id);
      const restored = store.project(p.id); restored.productionResult = production; restored.latestRender = video.id;
      restored.productionError = null; restored.status = 'assembled'; store.saveProject(restored);
      return send(res, 200, { ok: true, production });
    } catch (e) { return send(res, 400, { error: U.sanitizeText(e.message, 400) }); }
  };
  routes['/api/v2/pipeline/produce'] = async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    try {
      const input = await read(req), analysis = understanding.get(input.analysisId);
      if (!analysis || analysis.status !== 'completed') throw Error('Choose a completed video analysis');
      const p = projectFor(analysis.project);
      const pending = jobs.list({ project: p.id }).find(j => ['pipeline.run', 'pipeline.produce'].includes(j.type) && ['queued', 'running'].includes(j.status));
      if (pending) return send(res, 200, { ok: true, coalesced: true, jobId: pending.id });
      if (input.publish && input.confirm !== true) throw Error('Explicit publish confirmation required');
      const job = jobs.enqueue({ type: 'pipeline.produce', project: p.id, page: p.page, params: { analysisId: analysis.id, decorate: input.decorate === true, style: input.style === true, revoice: input.revoice === true, publish: input.publish === true, confirm: input.confirm === true } });
      return send(res, 202, { ok: true, jobId: job.id, analysisId: analysis.id });
    } catch (e) { return send(res, 400, { error: U.sanitizeText(e.message, 500) }); }
  };
  jobs.register('video.reconcile', async (job, ctx) => {
    const a = understanding.get(job.params.analysisId);
    if (!a || a.project !== job.project) throw Error('Analysis does not belong to this project');
    const result = await understanding.reconcile({ id: a.id }, { ...ctx,
      shouldStop: () => (jobs.get(job.id) || {}).status === 'cancelled' });
    store.saveProject(attachUnderstanding(store.project(job.project), result, result.assetId, result.source));
    return { status: result.status, analysisId: result.id, project: result.project, scenes: result.timeline.length };
  });

  async function start(req, res, automatic) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    try {
      const input = await read(req);
      if (input.publish && input.confirm !== true) throw Error('Explicit publication confirmation required');
      const p = projectFor(input.project);
      const pending = jobs.list({ project: p.id }).find(x => ['video.understanding', 'video.reconcile', 'pipeline.run'].includes(x.type)
        && ['queued', 'running'].includes(x.status));
      if (pending) return send(res, 200, { ok: true, coalesced: true, jobId: pending.id,
        analysisId: pending.params.analysisId, project: p.id });
      const candidate = automatic ? null : candidateFrom(input);
      const sourceUrl = candidate && candidate.source || String(input.sourceUrl || '');
      if (!automatic && !/^https:\/\//i.test(sourceUrl)) throw Error('A public HTTPS source URL is required');
      const query = U.sanitizeText(input.query || 'smartphone unboxing ASMR hands only no talking no captions', 240);
      const existing = !automatic && understanding.list().find(a => a.project === p.id && a.source && a.source.url === sourceUrl && a.status === 'completed');
      if (existing) return send(res, 200, { ok: true, reused: true, analysisId: existing.id, project: p.id });
      const rec = queued(p, { url: sourceUrl, title: candidate && candidate.title || 'Awaiting source',
        videoId: candidate && candidate.id || null, cover: candidate && candidate.cover || '' });
      const job = jobs.enqueue({ type: automatic ? 'pipeline.run' : 'video.understanding', page: p.page, project: p.id,
        params: { analysisId: rec.id, sourceUrl, searchJobId: input.searchJobId || '', candidateId: input.candidateId || '', query, produce: input.produce === true, campaign: input.campaign === true, pages: input.pages, publish: input.publish === true, confirm: input.confirm === true } });
      understanding.save({ ...rec, jobId: job.id });
      return send(res, 202, { ok: true, jobId: job.id, analysisId: rec.id, project: p.id });
    } catch (e) { return send(res, 400, { error: U.sanitizeText(e.message, 500) }); }
  }
  routes['/api/v2/understanding/start'] = (req, res) => start(req, res, false);
  routes['/api/v2/pipeline/run'] = (req, res) => start(req, res, true);
  routes['/api/v2/understanding/reconcile'] = async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    try {
      const input = await read(req);
      const a = understanding.get(input.id);
      if (!a || !a.assetId) throw Error('An imported analysis is required');
      const p = projectFor(a.project);
      const pending = jobs.list({ project: p.id }).find(x => ['video.understanding', 'video.reconcile', 'pipeline.run'].includes(x.type)
        && ['queued', 'running'].includes(x.status));
      if (pending) return send(res, 200, { ok: true, coalesced: true, jobId: pending.id, analysisId: pending.params.analysisId });
      const job = jobs.enqueue({ type: 'video.reconcile', project: p.id, page: p.page, params: { analysisId: a.id } });
      understanding.save({ ...a, jobId: job.id, status: 'queued', narrationBrief: null });
      return send(res, 202, { ok: true, jobId: job.id, analysisId: a.id, project: p.id });
    } catch (e) { return send(res, 400, { error: U.sanitizeText(e.message, 500) }); }
  };
  routes['/api/v2/pipeline'] = async (req, res, u) => {
    try {
      const p = projectFor(u.searchParams.get('project'));
      const analyses = understanding.list().filter(a => a.project === p.id);
      const ids = new Set(analyses.map(a => a.jobId).filter(Boolean));
      const sourceJobs = jobs.list({ project: p.id }).filter(x => x.type === 'media.search' && x.result)
        .map(x => ({ id: x.id, status: x.result.candidates.length ? 'found' : 'no_match', query: x.params.query, ts: x.ts, ...x.result }));
      const searches = [...(p.pipelineSearches || []), ...sourceJobs];
      const allJobs = jobs.list({ project: p.id }).filter(x => ids.has(x.id) || ['pipeline.run', 'pipeline.produce', 'pipeline.post', 'campaign.page', 'video.understanding', 'video.reconcile', 'media.search'].includes(x.type));
      return send(res, 200, { project: { id: p.id, name: p.title, key: p.pipelineKey, status: p.status, productionResult: p.productionResult || null, productionError: p.productionError || null },
        jobs: allJobs.map(jobs.publicJob), searches, analyses: analyses.map(publicAnalysis),
        assets: (p.artifacts || []).map(id => store.artifact(id)).filter(Boolean).map(a => ({ id: a.id, kind: a.kind, label: a.label, rel: a.rel })),
        posting: o.postingInfo ? await o.postingInfo(p.id) : null,
        server: { local: true, workersEnabled: jobs.enabled, now: Date.now() } });
    } catch (e) { return send(res, 400, { error: U.sanitizeText(e.message, 500) }); }
  };
  routes['/api/v2/understanding'] = (req, res, u) => {
    const a = understanding.get(u.searchParams.get('id'));
    return send(res, a ? 200 : 404, a ? publicAnalysis(a) : { error: 'Analysis not found' });
  };
  routes['/api/v2/understanding/video'] = (req, res, u) => {
    const a = understanding.get(u.searchParams.get('id'));
    const asset = a && store.artifact(a.assetId || a.asset && a.asset.id);
    if (!asset || !asset.file || !U.isInside(store.MEDIA_ROOT, asset.file) || !fs.existsSync(asset.file)) return send(res, 404, { error: 'Source video not yet imported' });
    const size = fs.statSync(asset.file).size;
    const range = req.headers.range;
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (range && !match) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    res.writeHead(match ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    fs.createReadStream(asset.file, { start, end }).pipe(res);
  };
  function startAutomatic(input) {
    const p = projectFor(input.project);
    const pending = jobs.list({ project: p.id }).find(j => j.type === 'pipeline.run' && ['queued','running'].includes(j.status));
    if (pending) return { jobId: pending.id, analysisId: pending.params.analysisId };
    const rec = queued(p, { url: '', title: 'Scheduled source discovery' });
    const job = jobs.enqueue({ type: 'pipeline.run', page: p.page, project: p.id, params: { analysisId: rec.id, query: 'smartphone unboxing ASMR hands only no talking no captions', campaign: true, pages: input.pages, publish: false, confirm: false } });
    understanding.save({ ...rec, jobId: job.id });
    return { jobId: job.id, analysisId: rec.id };
  }
  return { routes, projectFor, understanding, startAutomatic };
}
module.exports = { createPipeline, attachUnderstanding };
