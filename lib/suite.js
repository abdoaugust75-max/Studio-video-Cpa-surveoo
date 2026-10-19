// lib/suite.js — master edit + page-agent branches. The shared-cleanup / per-page-version workflow.
//
// THE SHAPE OF THE WORK
//
//   SOURCE ──▶ MASTER EDIT ──▶ human approval ──▶ N PAGE BRANCHES ──▶ review queue
//
// A MASTER EDIT is a normal project (role: 'master') holding everything that is true for every page:
// the cut, the framing, the basic audio, the transient-free source. It is approved by a human before
// anything is fanned out, because seven expensive renders from an unapproved master is money burnt
// on a cut the owner was about to change.
//
// A PAGE BRANCH is also a normal project (role: 'branch'). It does NOT re-download the video and it
// does NOT re-transcribe it: it LINKS the master's current artifact (media files here are write-once,
// so a second reference is safe) and SHARES the master's transcription. What makes it a branch is
// that it reuses every existing subsystem — artifacts, versions, timeline, captions, transcript,
// agent chat — under one extra rule: the master's locks are inherited and cannot be released.
//
// HONESTY RULES THIS FILE FOLLOWS
//   * A branch runs only the recipe steps the DATA supports. No hook text configured, no music
//     resolved, no TTS text supplied → that step is SKIPPED and the branch records why. A step is
//     never faked to make the grid look full.
//   * One branch failing never fails the batch. Each branch runs in its own try/catch and carries its
//     own status and error.
//   * A batch correction reports the branches it could not touch and why (locked layer → skipped)
//     instead of quietly editing a locked layer on some of them.
'use strict';
const U = require('./util');
const LOCK = require('./locks');

function createSuite(o) {
  const store = o.store;
  const media = o.media;
  const jobs = o.jobs;
  const log = o.log || (() => {});
  const captions = o.captions;
  const editor = o.editor;

  const round = n => Math.round(Number(n || 0) * 100) / 100;

  // ---------------------------------------------------------------- page recipes
  /**
   * recipeFor — the creative recipe for one page agent, from its stored profile plus any overrides.
   * Every field is optional; a missing field means the branch skips that step and says so.
   */
  function recipeFor(pageKey, overrides) {
    const p = store.page(pageKey);
    const prefs = p.prefs || {};
    const o2 = overrides || {};
    return {
      page: p.key, pageLabel: p.label, lang: p.lang,
      voice: o2.voice || p.voice || null,
      ttsRate: o2.ttsRate != null ? o2.ttsRate : (p.ttsRate || 1),
      captionPreset: o2.captionPreset || prefs.captionPreset || p.captionPreset || 'bold_social',
      // The hook is the page's own text overlay. It comes from an explicit override, the page's CTA,
      // or its knowledge terms — never invented here.
      hook: o2.hook != null ? String(o2.hook).slice(0, 120) : (prefs.cta ? String(prefs.cta).slice(0, 120) : ''),
      hookAt: o2.hookAt != null ? Number(o2.hookAt) : 0.6,
      hookDuration: o2.hookDuration != null ? Number(o2.hookDuration) : 3,
      hookPosition: o2.hookPosition || (prefs.textStyle && prefs.textStyle.position) || 'bottom',
      hookSize: o2.hookSize != null ? Number(o2.hookSize) : ((prefs.textStyle && prefs.textStyle.size) || 44),
      ttsText: o2.ttsText != null ? String(o2.ttsText).slice(0, 1500) : '',
      music: o2.music && o2.music.url ? { url: o2.music.url, title: o2.music.title || 'Music', volume: o2.music.volume != null ? Number(o2.music.volume) : 0.18 } : null,
      audioFactor: o2.audioFactor != null ? Number(o2.audioFactor) : null,
      speed: o2.speed != null ? Number(o2.speed) : null,
      ratio: o2.ratio || p.ratio || '9:16',
      overrides: o2,
    };
  }

  /**
   * branchPlan — the ordered operations this branch would run, and the steps it will SKIP with a
   * reason. Building the plan is pure: no media is touched, so the diff and the UI can be shown
   * before anything is executed.
   */
  function branchPlan(branch, recipe) {
    const r = recipe || (branch.branch && branch.branch.recipe) || {};
    const locks = store.effectiveLocks(branch.id);
    const master = branch.master && branch.master.project ? store.project(branch.master.project) : null;
    const dur = (function () {
      const cur = branch.current ? store.artifact(branch.current) : null;
      return (cur && cur.probe && cur.probe.duration) || (master && master.analysis && master.analysis.duration) || 0;
    })();
    const steps = [];
    const skipped = [];
    const push = (op, args, why, layer) => {
      const blocked = LOCK.blockedOp(locks, op);
      if (blocked) { skipped.push({ op, layer: blocked, reason: LOCK.BY_KEY.get(blocked).label + ' is locked (inherited from the master), so this step was not run.' }); return; }
      steps.push({ op, args, reason: why });
    };

    // 1. framing to the page's own ratio — a page may publish 1:1 where the master is 9:16
    if (r.ratio && master && master.analysis && master.analysis.ratio && master.analysis.ratio !== r.ratio) {
      push('crop_ratio', { ratio: r.ratio }, 'This page publishes ' + r.ratio + ' while the master is ' + master.analysis.ratio + '.', 'framing');
    }
    // 2. hook text
    if (r.hook) {
      const at = r.hookAt, d = r.hookDuration;
      if (dur && at + d > dur) skipped.push({ op: 'overlay_text', layer: 'text', reason: 'the hook would run past the end of the ' + round(dur) + 's clip' });
      else push('overlay_text', { text: r.hook, at, duration: d, position: r.hookPosition, size: r.hookSize }, 'The page\'s own hook text, at its own size and position.', 'text');
    } else skipped.push({ op: 'overlay_text', layer: 'text', reason: 'this page agent has no hook text (no CTA or override set)' });

    // 3. captions from the SHARED transcript, in this page's preset
    const tr = store.transcriptions(branch.id)[0] || null;
    if (tr && (tr.segments || []).length) {
      if (LOCK.blockedService(locks, 'caption.create')) skipped.push({ op: 'burn_subs', layer: 'captions', reason: 'Captions is locked (inherited from the master), so captions were not rebuilt.' });
      else steps.push({ op: '__caption', args: { preset: r.captionPreset, transcription: tr.id, burn: true }, reason: 'Rebuilt from the master\'s transcript in the ' + r.captionPreset + ' preset — no new transcription request.' });
    } else skipped.push({ op: 'burn_subs', layer: 'captions', reason: 'the master has no transcript yet, so this branch has no measured timings to caption from' });

    // 4. voiceover (opt-in: it costs a TTS request)
    if (r.ttsText) push('voiceover', { text: r.ttsText, voice: r.voice, rate: r.ttsRate, bed: 0.15 }, 'The page\'s own script, in its own voice.', 'tts');
    else skipped.push({ op: 'voiceover', layer: 'tts', reason: 'no script supplied for this branch (TTS is opt-in per branch)' });

    // 5. music (opt-in: needs a resolved, licensed track url)
    if (r.music) push('mix_music', { url: r.music.url, title: r.music.title, volume: r.music.volume }, 'The page\'s music preference.', 'music');
    else skipped.push({ op: 'mix_music', layer: 'music', reason: 'no licensed track resolved for this branch' });

    // 6. audio level / speed, when the page differs from the master
    if (r.audioFactor != null && r.audioFactor !== 1) push('volume', { factor: r.audioFactor }, 'This page\'s original-audio level.', 'audio');
    if (r.speed != null && r.speed !== 1) push('speed', { factor: r.speed }, 'This page\'s pacing.', 'timing');

    return { steps, skipped, duration: dur, locks };
  }

  // ---------------------------------------------------------------- master edit
  function masterOf(suiteId) {
    const s = store.suite(suiteId);
    if (!s) throw new Error('unknown suite: ' + suiteId);
    return store.project(s.master);
  }

  /** startMaster — create a suite and its master edit. The master starts as a copy of `from`'s cut. */
  function startMaster({ page, title, from, ctx }) {
    const { suite, master } = store.createSuite(page, title);
    if (from) {
      const src = store.project(from);
      if (!src) throw new Error('unknown source project: ' + from);
      const cur = src.current ? store.artifact(src.current) : null;
      if (!cur) throw new Error('source project ' + from + ' has no current artifact to build a master from');
      store.linkArtifact(master.id, cur.id, { op: cur.op, label: cur.label + ' (master start)', kind: cur.kind, version: 1 });
      // Re-read after linking: linkArtifact appended the artifact and moved the `current` pointer on
      // disk, so saving the stale in-memory object here would silently erase both.
      const m2 = store.project(master.id);
      m2.source = src.source || m2.source;
      m2.analysis = src.analysis || m2.analysis;
      // The master inherits the source project's transcript rather than re-transcribing the same audio.
      const trs = (src.transcriptions || []).slice();
      store.saveProject(m2);
      if (trs.length) store.shareTranscription(master.id, trs);
    }
    ctx && ctx.progress && ctx.progress('master created', 30);
    return { suite: store.suite(suite.id), master: store.project(master.id) };
  }

  // ---------------------------------------------------------------- branches
  function createBranch({ suiteId, page, recipe, requireApproval }) {
    const s = store.suite(suiteId);
    if (!s) throw new Error('unknown suite: ' + suiteId);
    const master = store.project(s.master);
    if (!master) throw new Error('the suite has no master edit');
    const needApproval = requireApproval !== false;
    if (needApproval && master.masterStatus !== 'approved') {
      throw new Error('the master edit is ' + (master.masterStatus || 'draft') + ', not approved — approve the master before generating page versions (or pass requireApproval:false to override)');
    }
    const cur = master.current ? store.artifact(master.current) : null;
    if (!cur) throw new Error('the master edit has no current artifact to branch from');
    const pageKey = String(page || '').replace(/[^a-z0-9_]/gi, '');
    if (!store.pages().some(p => p.key === pageKey)) throw new Error('unknown page agent: ' + page);
    const p = store.page(pageKey);
    const rec = recipe || recipeFor(pageKey);
    const b = store.createProject(pageKey, (master.title || 'Master').replace(/ — master$/, '') + ' — ' + p.label, {
      role: 'branch', suite: s.id,
      master: { suite: s.id, project: master.id, artifact: cur.id },
      branch: { id: U.uid('B'), page: pageKey, pageLabel: p.label, recipe: rec, created: Date.now() },
      source: master.source || null, analysis: master.analysis || null,
      locks: {}, // a branch holds no locks of its own by default; the master's are inherited
    });
    // Lineage, not duplication: the branch points at the master's file instead of copying it.
    store.linkArtifact(b.id, cur.id, { op: 'branch', label: p.label + ' — from master', kind: cur.kind, version: 1 });
    // Shared source understanding: one transcription, N branches. The master may hold the transcript
    // itself OR be sharing it from the project it was built from, so both lists travel down — taking
    // only `transcriptions` silently dropped the transcript one level down the chain.
    const lineageTranscripts = [...new Set([...(master.transcriptions || []), ...(master.sharedTranscriptions || [])])];
    if (lineageTranscripts.length) store.shareTranscription(b.id, lineageTranscripts);
    const withPlan = store.saveProject({ ...store.project(b.id), plan: branchPlan(store.project(b.id), rec) });
    s.branches = [...new Set([...(s.branches || []), b.id])];
    store.saveSuite(s);
    log('info', 'branch.created', { suite: s.id, branch: b.id, page: pageKey });
    return withPlan;
  }

  /**
   * runBranch — execute a branch's plan. Every step is a REAL call into the same services the UI uses.
   * Returns { status, steps, skipped, errors, artifact }.
   */
  async function runBranch({ branchId, ctx }) {
    const branch = store.project(branchId);
    if (!branch) throw new Error('unknown branch project: ' + branchId);
    const plan = (branch.plan && branch.plan.steps) ? branch.plan : branchPlan(branch);
    const skipped = [...(plan.skipped || [])];
    const done = [];
    let last = null;
    for (const step of (plan.steps || [])) {
      ctx && ctx.progress && ctx.progress(branch.branch.pageLabel + ': ' + step.op, 20);
      try {
        if (step.op === '__caption') {
          // caption creation + burn through the caption engine and the media layer (lock-checked)
          const tr = store.transcription(branch.id, step.args.transcription);
          const track = captions.createTrack({ projectId: branch.id, page: branch.page, transcriptionId: tr.id, preset: step.args.preset });
          const art = await o.burnCaptions({ project: branch.id, track: track.id, ctx });
          last = art;
          done.push({ op: 'captions', track: track.id, artifact: art.id, preset: step.args.preset });
          store.appendMessage(branch.page, { role: 'agent', text: '✓ ' + (track.segments || []).length + ' captions burned for ' + branch.branch.pageLabel + ' (' + track.preset + ')', artifacts: [], tools: [{ tool: 'caption.burn', ok: true }], project: branch.id });
          continue;
        }
        const art = await media.applyOp(branch.id, step.op, step.args, ctx);
        last = art;
        done.push({ op: step.op, artifact: art.id });
      } catch (e) {
        // A locked layer discovered mid-run, or a real ffmpeg failure: record it, keep going with the
        // remaining steps only if the failure is a lock; otherwise stop this branch.
        if (e && e.locked) { skipped.push({ op: step.op, layer: e.layer, reason: e.message }); continue; }
        store.setReview(branch.id, 'failed', { note: e.message, artifact: branch.current });
        return { status: 'failed', error: e.message, steps: done, skipped, artifact: last };
      }
    }
    // Fast preview at the end, so the review grid has something real to play.
    try {
      const preview = await o.previewRender({ page: branch.page, project: branch.id, ctx });
      if (preview && preview.artifact) { done.push({ op: 'render', artifact: preview.artifact.id }); last = preview.artifact; }
    } catch (e) {
      skipped.push({ op: 'render', layer: 'output', reason: 'preview render failed: ' + e.message });
    }
    const fresh = store.project(branch.id);
    store.setReview(branch.id, 'waiting', { note: done.length ? (done.length + ' steps applied') : 'nothing to apply', artifact: (last && last.id) || fresh.current, extra: { steps: done } });
    return { status: 'ready', steps: done, skipped, artifact: last };
  }

  /**
   * generate — the batch. Concurrency is the job system's job (1 on this machine), so this loop hands
   * each branch to the queue and reports progress. One branch failing is isolated to that branch.
   */
  async function generate({ suiteId, pages, recipe, ctx, requireApproval }) {
    const s = store.suite(suiteId);
    if (!s) throw new Error('unknown suite: ' + suiteId);
    const list = (Array.isArray(pages) && pages.length ? pages : store.pages().map(p => p.key)).map(x => String(x).replace(/[^a-z0-9_]/gi, ''));
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const pageKey = list[i];
      ctx && ctx.progress('branch ' + (i + 1) + '/' + list.length + ': ' + pageKey, Math.round(100 * i / list.length));
      try {
        const rec = recipe && recipe[pageKey] ? recipe[pageKey] : recipeFor(pageKey);
        const b = createBranch({ suiteId, page: pageKey, recipe: rec, requireApproval });
        const r = await runBranch({ branchId: b.id, ctx });
        out.push({ branch: b.id, page: pageKey, ...r });
      } catch (e) {
        // Failure isolation: the batch keeps going, and this branch reports why it did not happen.
        log('error', 'branch.failed', { suite: suiteId, page: pageKey, error: e.message });
        out.push({ branch: null, page: pageKey, status: 'failed', error: e.message, steps: [], skipped: [] });
      }
    }
    const ready = out.filter(x => x.status === 'ready').length;
    const failed = out.filter(x => x.status === 'failed').length;
    return { suite: suiteId, branches: out, ready, failed, pages: list.length };
  }

  /** Which layer each regenerate target touches, and what data it needs. */
  const REGEN_TARGETS = { hook: 'text', captions: 'captions', tts: 'tts', music: 'music' };

  /**
   * regenerateBranch — one branch, from a chosen checkpoint: 'all' | 'hook' | 'captions' | 'tts' | 'music'.
   *
   * EVERYTHING is validated BEFORE the review state moves. An earlier version set the state to
   * 'regenerating' and then threw on an unsupported target, which left the branch stuck showing
   * "regenerating" forever with no job behind it. A failed request must leave the record exactly as
   * it found it.
   */
  async function regenerateBranch({ branchId, only, ctx }) {
    const branch = store.project(branchId);
    if (!branch) throw new Error('unknown branch: ' + branchId);
    const mode = !only ? 'all' : String(only);
    const recipe = (branch.branch && branch.branch.recipe) || {};
    if (mode === 'all') {
      store.setReview(branchId, 'regenerating', { note: 'full recipe re-applied' });
      const r = await runBranch({ branchId, ctx });
      return { mode: 'all', ...r };
    }
    // ---- validate up front, before anything is written ----
    const layer = REGEN_TARGETS[mode];
    if (!layer) throw new Error('unsupported regenerate target: "' + mode + '" — use all, hook, captions, tts or music');
    const locks = store.effectiveLocks(branchId);
    if (locks[layer]) throw new Error(LOCK.BY_KEY.get(layer).label + ' is locked on this branch, so it cannot be regenerated');
    if (mode === 'captions' && !store.transcriptions(branchId)[0]) throw new Error('this branch has no transcript to rebuild captions from');
    if (mode === 'hook' && !recipe.hook) throw new Error('this branch has no hook text to re-apply');
    if (mode === 'music' && !recipe.music) throw new Error('this branch has no resolved track to re-apply');
    if (mode === 'tts' && !recipe.ttsText) throw new Error('this branch has no script to regenerate a voiceover from');

    store.setReview(branchId, 'regenerating', { note: 'regenerating ' + mode });
    try {
      let art;
      if (mode === 'captions') {
        const tr = store.transcriptions(branchId)[0];
        const track = captions.createTrack({ projectId: branchId, page: branch.page, transcriptionId: tr.id, preset: recipe.captionPreset || 'bold_social' });
        art = await o.burnCaptions({ project: branchId, track: track.id, ctx });
        store.setReview(branchId, 'waiting', { note: 'captions regenerated (' + track.preset + ')', artifact: art.id, extra: { steps: [{ op: 'captions', artifact: art.id }] } });
      } else if (mode === 'hook') {
        art = await media.applyOp(branchId, 'overlay_text', { text: recipe.hook, at: recipe.hookAt, duration: recipe.hookDuration, position: recipe.hookPosition, size: recipe.hookSize }, ctx);
        store.setReview(branchId, 'waiting', { note: 'hook re-applied', artifact: art.id });
      } else if (mode === 'music') {
        art = await media.applyOp(branchId, 'mix_music', { url: recipe.music.url, title: recipe.music.title, volume: recipe.music.volume }, ctx);
        store.setReview(branchId, 'waiting', { note: 'music re-applied', artifact: art.id });
      } else {
        art = await media.applyOp(branchId, 'voiceover', { text: recipe.ttsText, voice: recipe.voice, rate: recipe.ttsRate, bed: 0.15 }, ctx);
        store.setReview(branchId, 'waiting', { note: 'voiceover re-applied', artifact: art.id });
      }
      return { mode, status: 'ready', artifact: art };
    } catch (e) {
      // A real failure mid-render: record it as failed so it can be retried, and never leave the
      // branch claiming to be working when no job is behind it.
      store.setReview(branchId, 'failed', { note: mode + ' regeneration failed: ' + e.message });
      throw e;
    }
  }

  // ---------------------------------------------------------------- comparison
  /** comparison — every branch of a suite as a real, playable card. Nothing synthesised. */
  function comparison(suiteId) {
    const s = store.suite(suiteId);
    if (!s) throw new Error('unknown suite: ' + suiteId);
    const master = store.project(s.master);
    const card = p => {
      const cur = p.current ? store.artifact(p.current) : null;
      const last = (p.review && p.review.steps) || [];
      const skipped = (p.plan && p.plan.skipped) || [];
      return {
        project: p.id, page: p.page, pageLabel: (p.branch && p.branch.pageLabel) || (store.page(p.page).label),
        role: p.role, status: (p.review && p.review.state) || (p.role === 'master' ? (p.masterStatus || 'draft') : 'not generated'),
        note: (p.review && p.review.note) || null,
        current: cur ? { id: cur.id, rel: cur.rel, label: cur.label, op: cur.op, kind: cur.kind, duration: (cur.probe && cur.probe.duration) || null, version: cur.version } : null,
        preview: cur && cur.previewRel ? cur.previewRel : (cur ? cur.rel : null),
        versions: (p.artifacts || []).length,
        steps: last, skipped,
        locks: LOCK.describe(p.locks, store.inheritedLocks(p.id)).filter(l => l.locked).map(l => ({ key: l.key, label: l.label, inherited: l.inherited })),
        branch: p.branch ? { id: p.branch.id, recipe: p.branch.recipe || null } : null,
      };
    };
    return {
      suite: { id: s.id, title: s.title, page: s.page, master: s.master, created: s.created },
      master: master ? card(master) : null,
      branches: (s.branches || []).map(id => store.project(id)).filter(Boolean).map(card),
      note: 'Every card is a real project with its own artifact history; nothing is simulated for the grid.',
    };
  }

  // ---------------------------------------------------------------- batch corrections
  /**
   * CORRECTIONS — a fixed, deterministic vocabulary. A batch correction is NOT seven LLM calls: it is
   * one structured change re-issued against each branch's own current value, which is what makes it
   * predictable and free.
   */
  const CORRECTIONS = {
    music_volume: { layer: 'music', label: 'Music volume', op: 'mix_music' },
    audio_volume: { layer: 'audio', label: 'Original audio level', op: 'volume' },
    text_size: { layer: 'text', label: 'Hook text size', op: 'overlay_text' },
    tts_rate: { layer: 'tts', label: 'Voice speed', op: 'voiceover' },
    speed: { layer: 'timing', label: 'Playback speed', op: 'speed' },
    caption_preset: { layer: 'captions', label: 'Caption preset', op: 'captions' },
  };

  /** Read a branch's current value for a correction, from the last op of that kind. */
  function currentValue(project, kind) {
    const ops = (project.operations || []);
    const lastOf = op => ops.filter(x => x.op === op).pop() || null;
    switch (kind) {
      case 'music_volume': { const m = lastOf('mix_music'); return m ? { value: (m.params && m.params.volume != null ? m.params.volume : 0.22), args: m.params || {} } : null; }
      case 'audio_volume': { const v = lastOf('volume'); return { value: (v && v.params && v.params.factor != null ? v.params.factor : 1), args: {} }; }
      case 'text_size': { const t = lastOf('overlay_text'); return t ? { value: (t.params && t.params.size != null ? t.params.size : 44), args: t.params || {} } : null; }
      case 'tts_rate': { const v = lastOf('voiceover'); return v ? { value: (v.params && v.params.rate != null ? v.params.rate : 1), args: v.params || {} } : null; }
      case 'speed': { const s = lastOf('speed'); return { value: (s && s.params && s.params.factor != null ? s.params.factor : 1), args: {} }; }
      case 'caption_preset': { const t = store.captionTracks(project.id)[0]; return t ? { value: t.preset, args: { track: t.id } } : null; }
      default: return null;
    }
  }

  /**
   * batchCorrect — apply one structured correction across the selected branches.
   * dryRun (the default) returns exactly what WOULD change so the owner can confirm first; nothing is
   * queued until dryRun is false. A branch whose layer is locked is reported as skipped, with the
   * lock named — never quietly edited.
   */
  function batchCorrect({ branches, kind, value, dryRun }) {
    const spec = CORRECTIONS[kind];
    if (!spec) throw new Error('unknown correction "' + kind + '" — known: ' + Object.keys(CORRECTIONS).join(', '));
    const rows = [], skipped = [];
    for (const id of (branches || [])) {
      const p = store.project(id);
      if (!p) { skipped.push({ project: id, reason: 'project not found' }); continue; }
      const locks = store.effectiveLocks(p.id);
      if (locks[spec.layer]) { skipped.push({ project: p.id, page: p.page, reason: LOCK.BY_KEY.get(spec.layer).label + ' is locked on this branch, so it was left alone.' }); continue; }
      const cur = currentValue(p, kind);
      if (!cur) { skipped.push({ project: p.id, page: p.page, reason: 'this branch has no ' + spec.label.toLowerCase() + ' to change' }); continue; }
      rows.push({ project: p.id, page: p.page, pageLabel: p.branch ? p.branch.pageLabel : store.page(p.page).label, from: cur.value, to: value, args: cur.args, op: spec.op });
    }
    const result = {
      kind, label: spec.label, layer: spec.layer, dryRun: dryRun !== false,
      affected: rows, skipped, total: (branches || []).length,
      note: 'One structured change, re-issued per branch against that branch\'s own current value. No model is involved, so the same correction always produces the same result.',
    };
    if (dryRun === false) {
      result.jobs = rows.map(r => {
        if (r.op === 'captions') {
          return jobs.enqueue({ type: 'caption.preset', page: r.page, project: r.project, params: { page: r.page, project: r.project, preset: value, track: r.args.track } }).id;
        }
        const args = { ...r.args };
        if (kind === 'music_volume') args.volume = value;
        else if (kind === 'audio_volume') args.factor = value;
        else if (kind === 'text_size') args.size = value;
        else if (kind === 'tts_rate') args.rate = value;
        else if (kind === 'speed') args.factor = value;
        return jobs.enqueue({ type: 'media.op', page: r.page, project: r.project, params: { page: r.page, project: r.project, op: r.op, args } }).id;
      });
    }
    return result;
  }

  /** batchApprove — record each branch's approval independently (each is its own persisted decision). */
  function batchApprove({ branches, decision, note }) {
    const d = ['approve', 'reject', 'fix'].includes(decision) ? decision : 'approve';
    const done = [], skipped = [];
    for (const id of (branches || [])) {
      const p = store.project(id);
      if (!p) { skipped.push({ project: id, reason: 'project not found' }); continue; }
      const state = d === 'approve' ? 'approved' : d === 'reject' ? 'rejected' : 'fix_requested';
      store.setReview(id, state, { note: note || (d === 'approve' ? 'approved from the review grid' : d === 'reject' ? 'rejected from the review grid' : 'fix requested from the review grid') });
      store.approve(id, 'branch_review', note || d);
      store.appendMessage(p.page, { role: 'user', text: (d === 'approve' ? '✅ Approved' : d === 'reject' ? '❌ Rejected' : '✏️ Fix requested') + ': ' + (p.title || p.id), project: id, decision: { decision: d, note: note || '' } });
      done.push({ project: id, page: p.page, state });
    }
    return { decision: d, done, skipped, count: done.length };
  }

  /** suitesOf — suites touching a page, for the mode switcher. */
  function suitesOf(page) { return store.suites({ page: page || undefined }).map(s => ({ id: s.id, title: s.title, page: s.page, master: s.master, branches: (s.branches || []).length, updated: s.updated })); }

  return { recipeFor, branchPlan, createBranch, runBranch, generate, regenerateBranch, startMaster, masterOf, comparison, batchCorrect, batchApprove, suitesOf, CORRECTIONS, currentValue };
}

module.exports = { createSuite };
