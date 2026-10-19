// lib/store.js — domain model. One JSON file per record, atomic writes, per-page isolation.
// Entities: pages, memory, projects, artifacts, conversations, templates, assets.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const L = require('./locks');

function createStore(opts) {
  const ROOT = opts.root;                    // data/studio
  const MEDIA_ROOT = opts.mediaRoot;         // data/studio/media
  const LEGACY = opts.legacy || {};          // { brands, fbPages(), models() }
  const DIR = {
    pages: U.ensureDir(path.join(ROOT, 'pages')),
    memory: U.ensureDir(path.join(ROOT, 'memory')),
    projects: U.ensureDir(path.join(ROOT, 'projects')),
    artifacts: U.ensureDir(path.join(ROOT, 'artifacts')),
    jobs: U.ensureDir(path.join(ROOT, 'jobs')),
    convos: U.ensureDir(path.join(ROOT, 'conversations')),
    templates: U.ensureDir(path.join(ROOT, 'templates')),
    assets: U.ensureDir(path.join(ROOT, 'assets')),
    analytics: U.ensureDir(path.join(ROOT, 'analytics')),
    transcriptions: U.ensureDir(path.join(ROOT, 'transcriptions')),
    captions: U.ensureDir(path.join(ROOT, 'captions')),
    suites: U.ensureDir(path.join(ROOT, 'suites')),
    reviews: U.ensureDir(path.join(ROOT, 'reviews')),
    batches: U.ensureDir(path.join(ROOT, 'batches')),
  };
  const CURRENT_BATCH_FILE = path.join(ROOT, 'current-batch.json');
  const USED_FILE = path.join(ROOT, 'used-sources.json');
  const GLOBAL_MEMORY_FILE = path.join(ROOT, 'global-memory.json');
  U.ensureDir(MEDIA_ROOT);

  const key = k => String(k || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
  const brands = () => LEGACY.brands || {};

  // ---------------- production batches ----------------
  /**
   * A ProductionBatch is ONE source video taken through the stage pipeline (scripts → tts →
   * render → …) by the 7 page recipes. It is the product-level answer to the duplicate/history
   * failure: "current" used to mean "scan the whole store for the newest fanout project per
   * profile", which old batches silently kept winning whenever a profile had no newer branch.
   * A batch pins each profile to exactly one CURRENT artifact per type via explicit pointers;
   * everything else in the store is history and never surfaces as a current output.
   *
   * The batch pointer lives on the ORCHESTRATOR conversation, like a project pointer, and every
   * stage write goes through the batch — never through a global newest-scan.
   */
  function batch(id) { return U.readJson(path.join(DIR.batches, key(id) + '.json'), null); }
  function saveBatch(b) {
    b.updated = Date.now();
    U.writeJsonAtomic(path.join(DIR.batches, key(b.id) + '.json'), b);
    return b;
  }
  const PROFILE_KEYS = () => Object.keys(brands()).filter(k => !isOrchestrator(k));
  function createBatch(sourceProjectId) {
    const id = U.uid('B');
    const src = sourceProjectId ? project(sourceProjectId) : null;
    const profiles = {};
    for (const k of PROFILE_KEYS()) {
      profiles[k] = {
        currentScriptArtifactId: null, approvedScriptArtifactId: null,
        currentTtsArtifactId: null, currentTitleArtifactId: null, currentMusicArtifactId: null,
        currentCaptionArtifactId: null, currentCtaArtifactId: null, currentDescriptionArtifactId: null,
        currentVideoArtifactId: null, approvedVideoArtifactId: null, publishState: 'idle',
      };
    }
    const b = {
      id, createdAt: Date.now(), updated: Date.now(), status: 'source_imported',
      sourceProjectId: src ? src.id : (sourceProjectId || null),
      sourceArtifactId: src ? (src.currentPlayable || src.sourceArtifact || src.current || null) : null,
      sourceAnalysis: src ? (src.analysis || null) : null,
      sourceTruth: src ? (src.truth || null) : null,
      stage: 'source',
      profiles,
    };
    return saveBatch(b);
  }
  function currentBatch() { const ptr = U.readJson(CURRENT_BATCH_FILE, null); return ptr && ptr.id ? batch(ptr.id) : null; }
  function setCurrentBatch(b) {
    U.writeJsonAtomic(CURRENT_BATCH_FILE, { id: b.id, at: Date.now() });
    return b;
  }
  /**
   * detachCurrentBatch — NEW CHAT: drop the "current" pointer so a fresh session can never
   * inherit the previous session's outputs. The batch record itself stays in data/studio/batches
   * as history — nothing is deleted.
   */
  function detachCurrentBatch() {
    U.writeJsonAtomic(CURRENT_BATCH_FILE, { id: null, at: Date.now() });
    return { detached: true };
  }
  /** batchForSource — the batch a source project belongs to, if any. */
  function batchForSource(sourceProjectId) {
    const target = key(sourceProjectId);
    for (const f of fs.readdirSync(DIR.batches).filter(x => x.endsWith('.json'))) {
      const b = U.readJson(path.join(DIR.batches, f), null);
      if (b && String(b.sourceProjectId || '') === target) return b;
    }
    return null;
  }
  /**
   * setBatchArtifact — record the CURRENT artifact for batch+profile+type. Older versions stay
   * in the store as history; only the pointer moves. Profile keys and types are whitelisted so a
   * typo can never silently create a parallel structure.
   */
  const BATCH_TYPES = {
    script: 'currentScriptArtifactId', approve_script: 'approvedScriptArtifactId',
    tts: 'currentTtsArtifactId', title: 'currentTitleArtifactId', music: 'currentMusicArtifactId',
    caption: 'currentCaptionArtifactId', cta: 'currentCtaArtifactId', description: 'currentDescriptionArtifactId',
    video: 'currentVideoArtifactId', approve_video: 'approvedVideoArtifactId',
  };
  function setBatchArtifact(batchOrId, profileKey, type, artifactId, stage) {
    const b = typeof batchOrId === 'string' ? batch(batchOrId) : batchOrId;
    if (!b) throw new Error('unknown batch');
    const field = BATCH_TYPES[type];
    if (!field) throw new Error('unknown batch artifact type: ' + type);
    const k = key(profileKey);
    if (!b.profiles[k]) b.profiles[k] = {};
    b.profiles[k][field] = artifactId || null;
    if (type === 'video' && artifactId) b.profiles[k].publishState = 'rendered';
    if (stage) b.stage = stage;
    return saveBatch(b);
  }
  function batchArtifact(bOrId, profileKey, type) {
    const b = typeof bOrId === 'string' ? (bOrId ? batch(bOrId) : null) : bOrId;
    if (!b) return null;
    const field = BATCH_TYPES[type];
    if (!field) return null;
    const id = ((b.profiles || {})[key(profileKey)] || {})[field];
    // The pointer is the fact the UI resolves; the artifact record may legitimately not exist yet
    // (an id registered before its artifact, or a test pointer). Returning the id keeps the
    // batch contract verifiable even when the record lookup comes up empty.
    if (!id) return null;
    return artifact(id) || { id, missing: true };
  }

  // ---------------- pages (page agents) ----------------
  /**
   * ORCHESTRATOR — the studio-level agent the owner talks to by default.
   * It is a real page record (so conversations, memory and the message log all work unchanged) but
   * it owns no media: it resolves references, chooses which page agent should do the work, and
   * reports back. Keeping it in the same table is what lets ONE chat drive everything without a
   * second conversation system.
   */
  const ORCHESTRATOR = 'studio';
  const isOrchestrator = k => key(k) === ORCHESTRATOR;
  function orchestratorPage() {
    return {
      key: ORCHESTRATOR, label: 'Studio', role: 'orchestrator', lang: 'auto', color: '#7c9cff',
      voice: 'Kore', ttsRate: 1, ratio: '9:16', terms: [], identity: 'Studio Orchestrator',
      rules: [
        'You are the single point of contact: the owner describes an outcome and you make it happen.',
        'Never claim an edit, import or post happened unless a tool result confirms it.',
        'Ask before spending the owner\u2019s quota on something expensive and ambiguous.',
      ],
      prefs: { musicStyle: '', textStyle: { size: 44, color: 'white', position: 'bottom' }, cta: '', duration: '' },
      instructions: '', template: '', approval: 'ask_before_final',
      checkpoint: { ask_after_each: false, ask_before_final: true },
      pageIds: [], allowedDestinations: [], updated: Date.now(),
    };
  }
  function defaultPage(k) {
    if (isOrchestrator(k)) return orchestratorPage();
    const b = brands()[k] || {};
    const pageIds = (LEGACY.fbPages ? LEGACY.fbPages() : []).filter(p => p.brand === k).map(p => ({ id: p.id, name: p.name }));
    return {
      key: k, label: b.label || k, lang: b.lang || 'Darija', color: b.color || '#6d5cff',
      // Owner rule (2026-09-23): ALL 7 profiles use the Kore voice (n8n parity) — the old
      // per-page Puck/Charon/Fenrir/Algenib/Aoede/Iapetus split is gone.
      voice: 'Kore', ttsRate: 1.05, ratio: '9:16',
      terms: b.terms || [],
      identity: b.label || k,
      rules: [
        'Never invent prices, offers or policies — use only approved knowledge or ask the owner.',
        'Never claim an edit was made unless a tool result confirms it.',
        'Always match the page language and accent.',
      ],
      prefs: { musicStyle: '', textStyle: { size: 44, color: 'white', position: 'bottom' }, cta: '', duration: '30-40 seconds' },
      instructions: '',
      template: '',
      approval: 'ask_before_final',
      checkpoint: { ask_after_each: false, ask_before_final: true },
      pageIds,
      // The destinations this agent is ALLOWED to publish to. Separate from pageIds (what the
      // account link happens to offer) because permission is a decision, not a discovery: a newly
      // connected page must be added here deliberately before any agent can post to it.
      allowedDestinations: pageIds.map(x => ({ id: String(x.id), name: x.name, platform: 'facebook', enabled: true, source: 'account-link' })),
      updated: Date.now(),
    };
  }
  function page(k) {
    k = key(k);
    const f = path.join(DIR.pages, k + '.json');
    const saved = U.readJson(f, null);
    if (!saved) { const d = defaultPage(k); U.writeJsonAtomic(f, d); return d; }
    // Owner rule 2026-09-23 heal: every profile speaks Kore — migrate records saved under the old
    // per-page voice split (Puck/Charon/…) so Settings and artifacts can never show them again.
    if (saved.voice !== 'Kore') { saved.voice = 'Kore'; U.writeJsonAtomic(f, saved); }
    return saved;
  }
  function savePage(k, patch) {
    const cur = page(k);
    const next = { ...cur, ...(patch || {}), key: key(k), updated: Date.now() };
    if (patch && patch.prefs) next.prefs = { ...cur.prefs, ...patch.prefs };
    U.writeJsonAtomic(path.join(DIR.pages, key(k) + '.json'), next);
    return next;
  }
  function pages() { return [page(ORCHESTRATOR), ...Object.keys(brands()).map(page)]; }

  // ---------------- memory (global, page, project, template) ----------------
  const emptyMemory = keyName => ({
    key: keyName, version: 2, rules: [], hooks: [], products: [], style: {}, corrections: [],
    preferences: { voice: null, music: null, captions: null, text: null, source: null, publishing: null },
    evidence: [], stats: { messages: 0, edits: 0, observations: 0 }, updated: Date.now(),
  });
  function normalizeMemory(raw, keyName) {
    const m = { ...emptyMemory(keyName), ...(raw || {}) };
    m.key = keyName;
    m.rules = Array.isArray(m.rules) ? m.rules : [];
    m.corrections = Array.isArray(m.corrections) ? m.corrections : [];
    m.preferences = { ...emptyMemory(keyName).preferences, ...(m.preferences || {}) };
    m.evidence = Array.isArray(m.evidence) ? m.evidence : [];
    m.stats = { ...emptyMemory(keyName).stats, ...(m.stats || {}) };
    return m;
  }
  function globalMemory() { return normalizeMemory(U.readJson(GLOBAL_MEMORY_FILE, null), 'global'); }
  function saveGlobalMemory(m) { m = normalizeMemory(m, 'global'); m.updated = Date.now(); U.writeJsonAtomic(GLOBAL_MEMORY_FILE, m); return m; }
  function memory(k) {
    k = key(k);
    return normalizeMemory(U.readJson(path.join(DIR.memory, k + '.json'), null), k);
  }
  function saveMemory(k, m) {
    m = normalizeMemory(m, key(k)); m.updated = Date.now();
    U.writeJsonAtomic(path.join(DIR.memory, key(k) + '.json'), m);
    return m;
  }
  /** writeMemory merges structured knowledge; never mixes across pages (path is keyed). */
  function writeMemory(k, patch) {
    const m = memory(k);
    if (patch.rule) m.rules = [...new Set([...m.rules, U.sanitizeText(patch.rule, 300)])].slice(-40);
    if (patch.correction) m.corrections = [...m.corrections, { text: U.sanitizeText(patch.correction, 300), ts: Date.now() }].slice(-60);
    if (patch.hook) m.hooks = [...new Set([...m.hooks, U.sanitizeText(patch.hook, 200)])].slice(-60);
    if (patch.product) m.products = [...new Set([...m.products, U.sanitizeText(patch.product, 80)])].slice(-200);
    if (patch.style) m.style = { ...m.style, ...patch.style };
    if (patch.preferences) m.preferences = { ...m.preferences, ...patch.preferences };
    if (patch.stats) m.stats = { ...m.stats, ...patch.stats };
    return saveMemory(k, m);
  }
  /** Record a successful owner choice immediately, promoting it to a durable rule only after it repeats. */
  function recordLearning(k, observation) {
    const o = observation || {}, text = U.sanitizeText(o.text || '', 300);
    if (!text) return memory(k);
    const m = memory(k), kind = String(o.kind || 'preference'), name = String(o.name || 'general').slice(0, 40);
    const prior = [...(m.evidence || [])].reverse().find(x => x.kind === kind && x.name === name && x.text === text);
    const count = Number(prior && prior.count || 0) + 1;
    m.evidence = [...(m.evidence || []), { kind, name, text, count, source: o.source || 'owner-action', ts: Date.now() }].slice(-80);
    m.stats = { ...(m.stats || {}), edits: Number(m.stats && m.stats.edits || 0) + 1 };
    if (count >= 2) {
      if (kind === 'preference') m.preferences[name] = text;
      else if (kind === 'correction') m.corrections = [...(m.corrections || []), { text, ts: Date.now(), count }].slice(-60);
      else m.rules = [...new Set([...(m.rules || []), text])].slice(-40);
      m.stats.observations = Number(m.stats.observations || 0) + 1;
    }
    return saveMemory(k, m);
  }
  function projectMemory(id) {
    const p = project(id);
    return normalizeMemory(p && p.memory, 'project:' + key(id));
  }
  function saveProjectMemory(id, patch) {
    const p = project(id); if (!p) throw new Error('unknown project ' + id);
    p.memory = { ...projectMemory(id), ...patch, key: 'project:' + key(id), updated: Date.now() };
    return saveProject(p).memory;
  }
  function memoryContext(pageKey, projectId) {
    return { global: globalMemory(), page: memory(pageKey), project: projectId ? projectMemory(projectId) : null };
  }
  /** Store only repeated/explicitly durable observations; one-off chat text is never learned here. */
  function consolidateMemory(input) {
    input = input || {};
    const scope = input.scope === 'global' ? 'global' : input.scope === 'project' ? 'project' : 'page';
    const target = scope === 'global' ? globalMemory() : scope === 'project' ? projectMemory(input.project) : memory(input.page);
    const observations = Array.isArray(input.observations) ? input.observations : [];
    const durable = observations.filter(o => o && o.durable !== false && (Number(o.count || 1) >= 2 || o.explicit === true));
    for (const o of durable.slice(0, 30)) {
      const text = U.sanitizeText(o.text || o.rule || '', 300);
      if (!text) continue;
      const kind = String(o.kind || 'rule');
      if (kind === 'preference') target.preferences[String(o.name || 'general').slice(0, 40)] = text;
      else if (kind === 'correction') target.corrections = [...target.corrections, { text, ts: Date.now(), count: Number(o.count || 1) }].slice(-60);
      else target.rules = [...new Set([...target.rules, text])].slice(-40);
      target.evidence = [...target.evidence, { kind, text, count: Number(o.count || 1), ts: Date.now() }].slice(-80);
    }
    target.stats.observations = Number(target.stats.observations || 0) + durable.length;
    if (scope === 'global') return saveGlobalMemory(target);
    if (scope === 'project') return saveProjectMemory(input.project, target);
    return saveMemory(input.page, target);
  }

  // ---------------- projects ----------------
  const projectDir = id => U.ensureDir(path.join(MEDIA_ROOT, key(id)));
  function project(id) {
    const p = U.readJson(path.join(DIR.projects, key(id) + '.json'), null);
    if (!p) return null;
    p.artifacts = p.artifacts || [];
    p.operations = p.operations || [];
    // Records written before locks/suites existed are healed in place, so every reader can rely on
    // these fields being present rather than guarding at every call site.
    p.locks = L.normalize(p.locks);
    p.role = p.role || 'standalone';
    if (p.suite === undefined) p.suite = null;
    if (p.master === undefined) p.master = null;
    if (p.branch === undefined) p.branch = null;
    if (p.review === undefined) p.review = null;
    p.sourceArtifact = p.sourceArtifact || null;
    p.currentPlayable = p.currentPlayable || p.current || null;
    p.latestRender = p.latestRender || null;
    p.approvedArtifact = p.approvedArtifact || null;
    p.publishedArtifacts = Array.isArray(p.publishedArtifacts) ? p.publishedArtifacts : [];
    return p;
  }
  function saveProject(p) {
    p.updated = Date.now();
    U.writeJsonAtomic(path.join(DIR.projects, key(p.id) + '.json'), p);
    return p;
  }
  function createProject(pageKey, title, extra) {
    const id = U.uid('P');
    const p = {
      id, page: key(pageKey), title: U.sanitizeText(title || 'Untitled project', 120),
      status: 'draft', source: null, analysis: null, current: null,
      artifacts: [], operations: [], approvals: [], template: '',
      transcriptions: [], captions: [], createdAt: Date.now(), updated: Date.now(),
      sourceArtifact: null, currentPlayable: null, latestRender: null,
      approvedArtifact: null, publishedArtifacts: [],
      // role: how this project sits in a suite. 'standalone' is a normal project the owner started;
      // 'master' is the shared cleanup pass; 'branch' is one page agent's creative version of a master.
      role: 'standalone', suite: null, master: null, branch: null,
      // locks: persisted edit constraints, enforced in media.applyOp (see lib/locks.js).
      locks: {}, masterStatus: null, review: null, plan: null,
      ...(extra || {}),
    };
    projectDir(id);
    return saveProject(p);
  }

  // ---------------- edit locks ----------------
  /** setLocks — replace the project's own lock map. Inherited locks are separate (see effectiveLocks). */
  function setLocks(projectId, locks) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project ' + projectId);
    p.locks = L.normalize(locks);
    p.operations = [...(p.operations || []), { op: 'locks', params: { locks: p.locks }, artifact: p.current, ts: Date.now() }];
    return saveProject(p);
  }
  /**
   * effectiveLocks — this project's locks merged with the master's locks, when it is a branch.
   * A branch inherits: unlocking on the branch cannot release something the master locked (that is
   * the entire value of locking a cut before fanning out to seven pages).
   */
  function effectiveLocks(projectId) {
    const p = project(projectId);
    if (!p) return {};
    const inherited = p.master && p.master.project ? (project(p.master.project) || {}).locks || {} : {};
    return L.effective(p.locks, inherited);
  }
  /** inheritedLocks — only the master's share, for display ('Cuts 🔒 inherited'). */
  function inheritedLocks(projectId) {
    const p = project(projectId);
    if (!p || !p.master || !p.master.project) return {};
    const m = project(p.master.project);
    return m ? L.normalize(m.locks) : {};
  }

  // ---------------- lineage-linked artifacts ----------------
  /**
   * linkArtifact — register an artifact in `projectId` that REUSES an existing file.
   *
   * Seven branches of one master must not mean seven copies of the same source video. Media files in
   * this pipeline are write-once (every operation produces a NEW file and never rewrites an existing
   * one), so a file that already exists is safe to reference from more than one project. The record
   * carries `linked` plus `linkedFrom` so the UI, the repair pass and any future garbage collector
   * can all tell a reference from an owned file.
   */
  function linkArtifact(projectId, sourceArtifactId, patch) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project ' + projectId);
    const src = artifact(sourceArtifactId);
    if (!src) throw new Error('unknown source artifact ' + sourceArtifactId);
    if (src.file && !path.isAbsolute(src.file)) src.file = path.resolve(src.file);
    if (!fs.existsSync(src.file)) throw new Error('source artifact file is missing on disk');
    const id = U.uid('A');
    const rec = {
      ...src, id, project: p.id, page: p.page,
      parent: null, linked: true, linkedFrom: { project: src.project, artifact: src.id },
      version: ((patch && patch.version) || 1),
      label: (patch && patch.label) || (src.label || src.op),
      op: (patch && patch.op) || src.op || 'source',
      kind: (patch && patch.kind) || src.kind || 'video',
      params: (patch && patch.params) || {},
      // rel stays pointed at the OWNING project's directory: that is where the bytes are.
      rel: '/studio-media/' + key(src.project) + '/' + path.basename(src.file),
      previewRel: src.preview ? '/studio-media/' + key(src.project) + '/' + path.basename(src.preview) : null,
      status: 'ready', ts: Date.now(),
    };
    U.writeJsonAtomic(path.join(DIR.artifacts, id + '.json'), rec);
    p.artifacts = [...p.artifacts, id];
    if ((patch && patch.attach) !== false) p.current = id;
    p.operations = [...(p.operations || []), { op: rec.op, params: rec.params, artifact: id, ts: rec.ts }];
    saveProject(p);
    return rec;
  }

  // ---------------- suites (master + page branches) ----------------
  const suiteFile = id => path.join(DIR.suites, key(id) + '.json');
  function suite(id) { return U.readJson(suiteFile(id), null); }
  function saveSuite(s) {
    if (!s || !s.id) throw new Error('suite id required');
    s.updated = Date.now();
    U.writeJsonAtomic(suiteFile(s.id), s);
    return s;
  }
  function suites(filter) {
    return fs.readdirSync(DIR.suites).filter(f => f.endsWith('.json'))
      .map(f => U.readJson(path.join(DIR.suites, f), null)).filter(Boolean)
      .filter(s => !filter || (!filter.page || s.page === key(filter.page)))
      .sort((a, b) => b.updated - a.updated);
  }
  /** createSuite — a master project plus room for its page branches. The master is a real project. */
  function createSuite(pageKey, title) {
    const id = U.uid('SU');
    const master = createProject(pageKey, (title || 'Untitled') + ' — master', { role: 'master', masterStatus: 'draft', suite: id });
    const s = { id, page: key(pageKey), title: U.sanitizeText(title || 'Untitled suite', 120), master: master.id, branches: [], created: Date.now(), updated: Date.now() };
    saveSuite(s);
    return { suite: s, master };
  }
  function setMasterStatus(projectId, status, note) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project ' + projectId);
    if (p.role !== 'master') throw new Error('project ' + projectId + ' is not a master edit (role: ' + p.role + ')');
    if (!['draft', 'approved', 'rejected'].includes(status)) throw new Error('status must be draft|approved|rejected');
    p.masterStatus = status;
    p.approvals = [...(p.approvals || []), { checkpoint: 'master', decision: status, note: U.sanitizeText(note || '', 300), artifact: p.current, ts: Date.now() }];
    return saveProject(p);
  }

  // ---------------- review queue ----------------
  // The queue is DERIVED from persisted project state (pending approvals + branch review states),
  // not held in a separate in-memory list, so it cannot disagree with the projects it describes and
  // it survives a restart for free.
  function setReview(projectId, state, patch) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project ' + projectId);
    p.review = {
      state, note: U.sanitizeText((patch && patch.note) || '', 400),
      requested: (p.review && p.review.requested) || Date.now(),
      decided: ['waiting'].includes(state) ? null : Date.now(),
      artifact: (patch && patch.artifact) || p.current || null,
      kind: (patch && patch.kind) || (p.review && p.review.kind) || (p.role === 'master' ? 'master' : 'branch'),
      ...(patch && patch.extra ? patch.extra : {}),
    };
    if (state === 'approved') {
      p.approvedArtifact = p.review.artifact || p.current || null;
      p.approvals = [...(p.approvals || []), { checkpoint: 'review', decision: 'approve', note: p.review.note, artifact: p.approvedArtifact, ts: Date.now() }];
      if (p.source && p.source.url && p.approvedArtifact) markSourceUsed({ url: p.source.url, platformId: p.source.meta && p.source.meta.id, project: p.id, page: p.page, artifact: p.approvedArtifact, reason: 'approved' });
      // Batch bookkeeping: an approval is a PRODUCTION fact, not just a project note. Record it on
      // the batch the project belongs to so the next stage (TTS, render) resolves the APPROVED
      // artifact, and the stage advance survives refresh and restart. A fanout branch carries its
      // batch in p.branch.batchId (set when the fanout ran); the source project is matched by id.
      try {
        const batchId = (p.branch && p.branch.batchId) || (batchForSource(p.id) || {}).id || (currentBatch() || {}).id;
        const batchRec = batchId ? batch(batchId) : null;
        if (batchRec && p.branch && p.branch.page && (p.branch.fanout || p.branch.delegated)) {
          const approvedArt = p.approvedArtifact ? artifact(p.approvedArtifact) : null;
          if (approvedArt && approvedArt.kind === 'script') setBatchArtifact(batchRec, p.branch.page, 'approve_script', approvedArt.id, 'scripts_approved');
          else if (approvedArt && approvedArt.kind === 'video') setBatchArtifact(batchRec, p.branch.page, 'approve_video', approvedArt.id, 'final_approved');
          else if (approvedArt && approvedArt.kind !== 'video') setBatchArtifact(batchRec, p.branch.page, 'script', approvedArt.id, batchRec.stage);
        } else if (batchRec && batchRec.sourceProjectId === p.id) {
          batchRec.status = 'source_approved';
          saveBatch(batchRec);
        }
      } catch (_) { /* approval must not fail because batch bookkeeping does */ }
    }
    return saveProject(p);
  }
  /**
   * reviewQueue — everything waiting on a human decision.
   *
   * SCOPING RULE: a page's queue also contains the page versions generated from a suite that page
   * owns. A branch project belongs to its OWN page agent (that is what makes it a page version), so
   * filtering strictly by `p.page` hid every branch from the master's page — you would generate six
   * versions and see an empty Review. So an item is in scope when the project is on the page, or
   * when the suite it was fanned out from is.
   */
  function reviewQueue(filter) {
    filter = filter || {};
    const out = [];
    const suiteCache = new Map();
    const suiteOnPage = id => {
      if (!id) return false;
      if (!suiteCache.has(id)) suiteCache.set(id, suite(id));
      const s = suiteCache.get(id);
      return !!(s && s.page === filter.page);
    };
    for (const x of listProjects()) {
      const p = project(x.id);
      if (!p) continue;
      if (filter.page && p.page !== filter.page && !suiteOnPage(p.suite)) continue;
      if (p.pending && p.pending.status === 'waiting') {
        out.push({ project: p.id, page: p.page, title: p.title, role: p.role, kind: 'approval', state: 'waiting', pending: p.pending, current: p.current, suite: p.suite || null, ts: p.pending.requested });
      } else if (p.review && p.review.state && p.review.state !== 'done') {
        out.push({ project: p.id, page: p.page, title: p.title, role: p.role, kind: p.review.kind || 'branch', state: p.review.state, note: p.review.note, current: p.current, suite: p.suite || null, ts: p.review.requested });
      } else if (p.role === 'master' && p.masterStatus === 'draft') {
        out.push({ project: p.id, page: p.page, title: p.title, role: 'master', kind: 'master', state: 'waiting', note: 'Master edit is waiting for approval.', current: p.current, suite: p.suite || null, ts: p.updated });
      }
    }
    return out.filter(r => !filter.state || r.state === filter.state).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  function listProjects(pageKey) {
    return fs.readdirSync(DIR.projects).filter(f => f.endsWith('.json')).map(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(DIR.projects, f), 'utf8'));
        if (pageKey && p.page !== key(pageKey)) return null;
        return { id: p.id, page: p.page, title: p.title, status: p.status, current: p.current, artifacts: (p.artifacts || []).length, updated: p.updated };
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => b.updated - a.updated);
  }

  // ---------------- artifacts (version graph) ----------------
  /**
   * materialize — guarantee the artifact's file lives inside the project's media directory.
   * Producers such as TTS and music write into a shared cache; an artifact whose `rel` points at
   * a file that was never copied into the project directory would 404 in the browser (this was a
   * real, shipped bug). Copying here makes every artifact durable and its URL always resolvable.
   */
  function materialize(projectId, file) {
    const dir = projectDir(projectId);
    // Resolve to an absolute path first. A producer that hands over a RELATIVE path (a task run
    // from the project root, a script, a tool) used to be recorded verbatim — playback still worked
    // because the browser only needs the basename, but ffmpeg was handed a relative path with
    // backslashes and failed with a mangled filename. Records must be absolute to outlive any cwd.
    file = path.resolve(file);
    if (U.isInside(dir, file)) return file;
    const dest = path.resolve(path.join(dir, U.safeName(path.basename(file), 90)));
    if (!fs.existsSync(dest)) {
      try { fs.copyFileSync(file, dest); } catch (_) { fs.renameSync(file, dest); }
    }
    return dest;
  }

  const relFor = (projectId, file) => '/studio-media/' + key(projectId) + '/' + path.basename(file);

  /**
   * repairArtifacts — boot-time self-heal. Records written before materialize() existed point at
   * cache paths that were never copied into the project directory, so their rel 404s in the
   * browser. Healing them here means existing projects play correctly without a manual migration.
   * Idempotent: files already in the right place are only re-pointed, never re-copied.
   */
  function repairArtifacts() {
    let fixed = 0;
    for (const f of fs.readdirSync(DIR.artifacts).filter(x => x.endsWith('.json'))) {
      const a = U.readJson(path.join(DIR.artifacts, f), null);
      if (!a || !a.file || !a.project) continue;
      const dir = projectDir(a.project);
      if (U.isInside(dir, a.file)) {
        if (a.rel !== relFor(a.project, a.file)) {
          a.rel = relFor(a.project, a.file);
          if (a.preview) a.previewRel = relFor(a.project, a.preview);
          U.writeJsonAtomic(path.join(DIR.artifacts, f), a); fixed++;
        }
        continue;
      }
      if (!fs.existsSync(a.file)) continue;
      // Linked artifacts intentionally reference a file in ANOTHER project's directory; copying
      // them in would defeat the reference and quietly multiply the same video per branch.
      if (a.linked) continue;
      try {
        const dest = materialize(a.project, a.file);
        a.file = dest;
        a.rel = relFor(a.project, dest);
        if (a.preview) a.previewRel = relFor(a.project, a.preview);
        U.writeJsonAtomic(path.join(DIR.artifacts, f), a); fixed++;
      } catch (_) {}
    }
    return fixed;
  }

  function artifact(id) { return U.readJson(path.join(DIR.artifacts, key(id) + '.json'), null); }
  /**
   * artifactComments — the conversation entries that were aimed AT this artifact.
   * Derived from the messages themselves rather than a second comment table, so a comment can never
   * exist without the message that made it (and reload/restart keep them together for free).
   */
  function artifactComments(artifactId) {
    const art = artifact(artifactId);
    if (!art) return [];
    const c = conversation(art.page);
    return (c.messages || []).filter(m => m.focus === artifactId)
      .map(m => ({ ts: m.ts, role: m.role, text: m.text, decision: m.decision || null }));
  }
  function artifactsOf(projectId) {
    return (project(projectId) || { artifacts: [] }).artifacts.map(id => artifact(id)).filter(Boolean);
  }
  /**
   * saveArtifact — rewrite an artifact record in place. Used for metadata that is learned AFTER the
   * render (e.g. "this video was produced from caption track T"), so the timeline can resolve which
   * caption data a given version was actually built from. Not for changing the file itself.
   */
  function saveArtifact(rec) {
    if (!rec || !rec.id) throw new Error('artifact id required');
    U.writeJsonAtomic(path.join(DIR.artifacts, key(rec.id) + '.json'), rec);
    return rec;
  }
  /**
   * addArtifact — registers a produced media file. Verifies the file exists and is non-empty
   * before writing the record: no artifact can exist without a real file.
   */
  function addArtifact(a) {
    // Script/title/description artifacts are text-first: they have no media file and are
    // validated on their text content instead.
    const textual = a.kind === 'script' || a.kind === 'title' || a.kind === 'description';
    if (!textual && (!a.file || !fs.existsSync(a.file) || fs.statSync(a.file).size < 512)) throw new Error('artifact file missing or empty: ' + (a.file || 'n/a'));
    if (textual && !String(a.text || '').trim()) throw new Error('script artifact text required');
    const p = project(a.project);
    if (!p) throw new Error('unknown project ' + a.project);
    a = { ...a, file: textual ? null : materialize(p.id, a.file) };
    const lineage = artifactsOf(a.project).filter(x => x.op === a.op);
    const version = a.version || (lineage.reduce((m, x) => Math.max(m, x.version || 0), 0) + 1);
    const id = a.id || U.uid('A');
    const isSource = (a.op === 'import' || a.op === 'source');
    const parent = Object.prototype.hasOwnProperty.call(a, 'parent') ? a.parent : (isSource ? null : (p.current || null));
    const rec = {
      id, project: p.id, page: p.page, kind: a.kind || 'video', op: a.op || 'op',
      params: a.params || {}, parent, version,
      file: a.file, rel: textual ? null : '/studio-media/' + p.id + '/' + path.basename(a.file),
      preview: a.preview || null, previewRel: a.preview ? '/studio-media/' + p.id + '/' + path.basename(a.preview) : null,
      probe: a.probe || null, label: a.label || (a.op + ' v' + version),
      text: textual ? U.sanitizeText(a.text, 12000) : null,
      size: textual ? Buffer.byteLength(String(a.text || ''), 'utf8') : fs.statSync(a.file).size, status: 'ready', ts: Date.now(),
      layerId: a.layerId || (a.params && a.params.layerId) || null,
      supersedes: a.supersedes || null, qa: a.qa || null,
    };
    U.writeJsonAtomic(path.join(DIR.artifacts, id + '.json'), rec);
    p.artifacts = [...p.artifacts, id];
    // side artifacts (audio, frames, proxies) are attached to the project but must not
    // become the editing pointer — only timeline outputs do.
    if (a.attach !== false) {
      p.current = id;
      if (rec.kind === 'video') p.currentPlayable = id;
    }
    if (isSource) {
      p.sourceArtifact = id;
      p.latestRender = null;
      p.approvedArtifact = null;
      p.review = null;
    }
    if (rec.op === 'render' && rec.params && rec.params.mode === 'final') p.latestRender = id;
    p.operations = [...p.operations, { op: rec.op, params: rec.params, artifact: id, ts: rec.ts }];
    saveProject(p);
    return rec;
  }
  /** rollback — pointer move only; zero rendering, nothing destroyed. */
  function rollback(projectId, artifactId) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project');
    if (!p.artifacts.includes(artifactId)) throw new Error('artifact does not belong to this project');
    p.current = artifactId;
    const target = artifact(artifactId);
    if (target && target.kind === 'video') p.currentPlayable = artifactId;
    p.operations = [...p.operations, { op: 'rollback', params: { to: artifactId }, artifact: artifactId, ts: Date.now() }];
    return saveProject(p);
  }
  function currentArtifact(projectId) {
    const p = project(projectId);
    return p && p.current ? artifact(p.current) : null;
  }
  function approve(projectId, checkpoint, note) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project');
    p.approvedArtifact = p.current || null;
    p.approvals = [...(p.approvals || []), { checkpoint, decision: 'approve', note: U.sanitizeText(note, 300), artifact: p.approvedArtifact, ts: Date.now() }];
    if (p.source && p.source.url && p.approvedArtifact) markSourceUsed({ url: p.source.url, platformId: p.source.meta && p.source.meta.id, project: p.id, page: p.page, artifact: p.approvedArtifact, reason: 'approved' });
    return saveProject(p);
  }

  // ---------------- approval checkpoints (human-in-the-loop) ----------------
  // A pending approval is PROJECT state, not process state: it survives a browser refresh and a
  // backend restart, because both the record here and the paused job record live on disk.
  function setWaiting(projectId, pending) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project ' + projectId);
    p.pending = {
      checkpoint: U.sanitizeText(pending.checkpoint || 'approval', 60),
      label: U.sanitizeText(pending.label || '', 240),
      artifact: pending.artifact || p.current || null,
      before: pending.before || null,
      job: pending.job || null,
      op: U.sanitizeText(pending.op || '', 40),
      args: pending.args || {},
      planId: pending.planId || null,
      cursor: pending.cursor || 0,
      total: pending.total || null,
      status: 'waiting',
      requested: Date.now(),
    };
    return saveProject(p);
  }
  /** resolveWaiting — records the director's decision. Returns the pending record so the caller can resume. */
  function resolveWaiting(projectId, decision, note) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project');
    const pending = p.pending || null;
    const rec = { checkpoint: (pending && pending.checkpoint) || 'approval', decision, note: U.sanitizeText(note || '', 300), artifact: (pending && pending.artifact) || p.current, ts: Date.now() };
    p.approvals = [...(p.approvals || []), rec].slice(-200);
    p.pending = null;
    saveProject(p);
    return { project: p, pending, decision: rec };
  }
  /** waitingApprovals — every project currently paused, optionally scoped to one page agent. */
  function waitingApprovals(pageKey) {
    return listProjects(pageKey).map(x => project(x.id)).filter(Boolean)
      .filter(p => p.pending && p.pending.status === 'waiting')
      .map(p => ({ project: p.id, page: p.page, title: p.title, pending: p.pending }));
  }

  // ---------------- conversations ----------------
  function conversation(k) {
    k = key(k);
    const c = U.readJson(path.join(DIR.convos, k + '.json'), null) || { page: k, messages: [], project: null, updated: Date.now() };
    if (!c.sessionId) { c.sessionId = U.uid('S'); c.sessionAt = Date.now(); }
    return c;
  }
  function saveConversation(c) {
    c.messages = (c.messages || []).slice(-200);
    c.updated = Date.now();
    U.writeJsonAtomic(path.join(DIR.convos, key(c.page) + '.json'), c);
    return c;
  }
  function appendMessage(pageKey, msg) {
    const c = conversation(pageKey);
    c.messages.push({ ts: Date.now(), ...msg });
    if (msg.project) c.project = msg.project;
    // freshStart is intentionally NOT cleared here: it marks a session born from NEW CHAT /
    // CLEAR CHAT, and such a session must NEVER re-adopt a previous session's project. Clearing
    // it on the first message is exactly what let the state self-heal resurrect the page's newest
    // OLD project mid-session and flood a fresh chat with history. The flag describes how the
    // session STARTED; real work adopts projects explicitly (msg.project above).
    return saveConversation(c);
  }
  function clearConversation(pageKey) {
    return saveConversation({ page: key(pageKey), messages: [], project: null, sessionId: U.uid('S'), sessionAt: Date.now(), freshStart: true, updated: Date.now() });
  }
  /**
   * resetSession — the NEW CHAT / CLEAR CHAT contract: the visible conversation empties into the
   * archive (history is preserved, never deleted), a brand-new session id is minted, and the
   * project pointer + current ProductionBatch are detached. The next production flow starts a
   * fresh batch at import time.
   */
  function resetSession(pageKey) {
    const k = key(pageKey);
    const prev = conversation(k);
    if ((prev.messages || []).length) {
      U.writeJsonAtomic(path.join(DIR.convos, 'history', k + '-' + Date.now() + '.json'), prev);
    }
    detachCurrentBatch();
    return clearConversation(k);
  }

  // ---------------- transcriptions ----------------
  // Indexed on the project so a transcript is reachable from the project that produced it, while
  // the records themselves stay separate files (a transcript can be large).
  function saveTranscription(t) {
    if (!t || !t.project) throw new Error('transcription needs a project');
    const p = project(t.project);
    if (!p) throw new Error('unknown project ' + t.project);
    const isNew = !t.id;
    const rec = {
      ...t, id: t.id || U.uid('T'), status: t.status || 'ready',
      createdAt: t.createdAt || Date.now(), updated: Date.now(),
      segments: (t.segments || []).slice(0, 800).map((s, i) => ({
        id: s.id || 'S' + (i + 1),
        start: U.clamp(Number(s.start) || 0, 0, 7200, 0),
        end: U.clamp(Number(s.end) || 0, 0, 7200, 0),
        text: U.sanitizeText(s.text, 600),
        words: Array.isArray(s.words) && s.words.length ? s.words.slice(0, 200).map(w => ({ text: U.sanitizeText(w.text, 60), start: U.clamp(Number(w.start) || 0, 0, 7200, 0), end: U.clamp(Number(w.end) || 0, 0, 7200, 0) })) : null,
      })).filter(s => s.text),
      corrections: t.corrections || {},
    };
    U.writeJsonAtomic(path.join(DIR.transcriptions, key(rec.id) + '.json'), rec);
    if (isNew) { p.transcriptions = [...(p.transcriptions || []), rec.id]; saveProject(p); }
    return rec;
  }
  /**
   * shareTranscription — let a branch reference a transcription the master already paid for.
   * A branch transcript is the SAME speech in the SAME audio, so re-running the model seven times
   * would burn seven requests to learn one thing. The record keeps its original owner; the branch
   * lists it in `sharedTranscriptions`, which is what the ownership checks below accept.
   */
  function shareTranscription(projectId, transcriptionIds) {
    const p = project(projectId);
    if (!p) throw new Error('unknown project ' + projectId);
    const ids = (Array.isArray(transcriptionIds) ? transcriptionIds : [transcriptionIds]).filter(Boolean);
    p.sharedTranscriptions = [...new Set([...(p.sharedTranscriptions || []), ...ids])];
    return saveProject(p);
  }
  function ownsTranscription(p, id) {
    if (!p) return false;
    return (p.transcriptions || []).includes(id) || (p.sharedTranscriptions || []).includes(id);
  }
  function transcription(projectId, id) {
    const t = U.readJson(path.join(DIR.transcriptions, key(id) + '.json'), null);
    if (!t) return null;
    if (projectId) {
      const p = project(projectId);
      if (!ownsTranscription(p, t.id) && t.project !== key(projectId)) throw new Error('transcription does not belong to this project');
    }
    return t;
  }
  function transcriptions(projectId) {
    const p = project(projectId);
    if (!p) return [];
    const ids = [...(p.transcriptions || []), ...(p.sharedTranscriptions || []).filter(x => !(p.transcriptions || []).includes(x))];
    return ids.map(id => U.readJson(path.join(DIR.transcriptions, key(id) + '.json'), null)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------------- caption tracks ----------------
  function saveCaptionTrack(t) {
    if (!t || !t.project) throw new Error('caption track needs a project');
    const p = project(t.project);
    if (!p) throw new Error('unknown project ' + t.project);
    const isNew = !t.id;
    // An edit passes an explicit version forward (so a new record continues the same line of work);
    // a rewrite of an existing record increments. Without this, every caption edit claimed to be v1
    // and the version history the UI shows was meaningless.
    const version = Number(t.version) > 0 ? Number(t.version) : (isNew ? 1 : (Number(t.version) || 1) + 1);
    const rec = {
      ...t, id: t.id || U.uid('C'), version, parent: t.parent || null,
      status: t.status || 'draft', createdAt: t.createdAt || Date.now(), updated: Date.now(),
      // `display` (the wrapped on-screen form) and `derived` (whether the boundary was measured or
      // interpolated) MUST survive persistence. Dropping `derived` silently relabelled interpolated
      // boundaries as measured, which is exactly the kind of quiet dishonesty this pipeline is
      // built to avoid; dropping `display` threw away the line wrapping on every save.
      segments: (t.segments || []).slice(0, 800).map((s, i) => ({
        id: s.id || 'C' + (i + 1),
        start: U.clamp(Number(s.start) || 0, 0, 7200, 0),
        end: U.clamp(Number(s.end) || 0, 0, 7200, 0),
        text: U.sanitizeText(s.text, 300),
        display: s.display ? String(s.display).slice(0, 600) : undefined,
        derived: s.derived === 'interpolated' ? 'interpolated' : 'measured',
        sourceSegmentId: s.sourceSegmentId || null,
        words: Number(s.words) || undefined,
        style: s.style && typeof s.style === 'object' ? s.style : null,
        position: s.position || null,
        emphasis: s.emphasis || null,
      })).filter(s => s.text),
    };
    U.writeJsonAtomic(path.join(DIR.captions, key(rec.id) + '.json'), rec);
    if (isNew) { p.captions = [...(p.captions || []), rec.id]; saveProject(p); }
    return rec;
  }
  function captionTrack(projectId, id) {
    const t = U.readJson(path.join(DIR.captions, key(id) + '.json'), null);
    if (!t) return null;
    if (projectId && t.project !== key(projectId)) throw new Error('caption track does not belong to this project');
    return t;
  }
  function captionTracks(projectId) {
    const p = project(projectId);
    if (!p) return [];
    return (p.captions || []).map(id => U.readJson(path.join(DIR.captions, key(id) + '.json'), null)).filter(Boolean).sort((a, b) => b.updated - a.updated);
  }

  // ---------------- editable caption style presets ----------------
  function captionStyles() { return U.readJson(path.join(ROOT, 'caption_styles.json'), {}); }
  function saveCaptionStyle(name, style) {
    const all = captionStyles();
    const k = key(name);
    if (!k) throw new Error('style name required');
    all[k] = { ...(all[k] || {}), ...(style || {}), updated: Date.now() };
    U.writeJsonAtomic(path.join(ROOT, 'caption_styles.json'), all);
    return all[k];
  }
  function deleteCaptionStyle(name) {
    const all = captionStyles();
    delete all[key(name)];
    U.writeJsonAtomic(path.join(ROOT, 'caption_styles.json'), all);
    return all;
  }

  // ---------------- used sources (separate from saved bookmarks) ----------------
  function canonicalSourceUrl(raw) {
    try {
      const u = new URL(String(raw || ''));
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (/^(utm_|x-|token|expires|signature|sig|auth)/i.test(k)) u.searchParams.delete(k);
      return u.origin.toLowerCase() + u.pathname.replace(/\/$/, '') + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
    } catch (_) { return String(raw || '').trim(); }
  }
  function usedSources() {
    const d = U.readJson(USED_FILE, { version: 1, items: [] });
    return Array.isArray(d.items) ? d.items : [];
  }
  function isSourceUsed(input) {
    const obj = typeof input === 'string' ? { url: input } : (input || {});
    const url = canonicalSourceUrl(obj.url);
    const pid = String(obj.platformId || '');
    const fp = String(obj.fingerprint || '');
    return usedSources().find(x => (url && x.canonicalUrl === url) || (pid && x.platformId === pid) || (fp && x.fingerprint === fp)) || null;
  }
  function markSourceUsed(input) {
    input = input || {};
    const items = usedSources();
    const existing = isSourceUsed(input);
    const rec = {
      id: existing && existing.id || U.uid('US'), canonicalUrl: canonicalSourceUrl(input.url),
      platformId: String(input.platformId || existing && existing.platformId || ''),
      fingerprint: String(input.fingerprint || existing && existing.fingerprint || ''),
      usedAt: Date.now(), project: input.project || null, page: input.page || null,
      artifact: input.artifact || null, publishedArtifact: input.publishedArtifact || null,
      reason: input.reason || 'used',
    };
    const next = existing ? items.map(x => x.id === existing.id ? { ...x, ...rec } : x) : [...items, rec];
    U.writeJsonAtomic(USED_FILE, { version: 1, items: next });
    return rec;
  }

  // ---------------- templates (editing recipes) ----------------
  function templates() {
    return fs.readdirSync(DIR.templates).filter(f => f.endsWith('.json'))
      .map(f => U.readJson(path.join(DIR.templates, f), null)).filter(Boolean);
  }
  function template(name) {
    return U.readJson(path.join(DIR.templates, key(name) + '.json'), null);
  }
  function saveTemplate(t) {
    t.name = key(t.name);
    if (!t.name) throw new Error('template name required');
    U.writeJsonAtomic(path.join(DIR.templates, t.name + '.json'), { ...t, updated: Date.now() });
    return t;
  }

  // ---------------- asset vault ----------------
  function assets(filter) {
    return fs.readdirSync(DIR.assets).filter(f => f.endsWith('.json'))
      .map(f => U.readJson(path.join(DIR.assets, f), null)).filter(Boolean)
      .filter(a => !filter || !filter.kind || a.kind === filter.kind)
      .sort((a, b) => b.ts - a.ts);
  }
  function addAsset(a) {
    const id = a.id || U.uid('AS');
    const rec = { id, kind: a.kind || 'music', title: U.sanitizeText(a.title || '', 120), creator: U.sanitizeText(a.creator || '', 80), url: a.url || '', file: a.file || null, meta: a.meta || {}, ts: Date.now() };
    U.writeJsonAtomic(path.join(DIR.assets, id + '.json'), rec);
    return rec;
  }
  function musicAssets(filter) { return assets({ kind: 'music' }).filter(a => !filter || !filter.query || (String(a.title) + ' ' + String(a.creator) + ' ' + JSON.stringify(a.meta || {})).toLowerCase().includes(String(filter.query).toLowerCase())); }
  function musicAsset(id) { return U.readJson(path.join(DIR.assets, key(id) + '.json'), null); }

  return {
    DIR, MEDIA_ROOT, dirFor: projectDir, projectDir,
    batch, saveBatch, createBatch, currentBatch, setCurrentBatch, batchForSource, setBatchArtifact, batchArtifact, BATCH_TYPES, PROFILE_KEYS,
    page, pages, savePage, memory, saveMemory, writeMemory, recordLearning, globalMemory, saveGlobalMemory, projectMemory, saveProjectMemory, memoryContext, consolidateMemory,
    project, saveProject, createProject, listProjects,
    artifact, artifactsOf, addArtifact, saveArtifact, materialize, repairArtifacts, rollback, currentArtifact, approve,
    setWaiting, resolveWaiting, waitingApprovals,
    conversation, saveConversation, appendMessage, clearConversation, resetSession, detachCurrentBatch,
    saveTranscription, transcription, transcriptions, shareTranscription,
    saveCaptionTrack, captionTrack, captionTracks,
    setLocks, effectiveLocks, inheritedLocks, linkArtifact,
    suite, suites, saveSuite, createSuite, setMasterStatus,
    setReview, reviewQueue,
    captionStyles, saveCaptionStyle, deleteCaptionStyle,
    templates, template, saveTemplate, assets, addAsset, musicAssets, musicAsset,
    usedSources, isSourceUsed, markSourceUsed, canonicalSourceUrl,
    ORCHESTRATOR, isOrchestrator, artifactComments,
  };
}

module.exports = { createStore };
