// lib/providers.js — the single canonical provider + model registry and the capability router.
//
// Why one module: model ids used to be scattered across server.js, the agent, TTS and analysis.
// Every service now asks THIS registry which model to use, so changing a model in Settings
// actually changes what runs — and no provider secret ever leaves the server process.
//
// Google is the only provider implemented today. The shape supports more providers later
// (OpenAI, Anthropic, Groq, OpenRouter, local/OpenAI-compatible) without touching the agent or
// the media pipeline: a provider is a name, a base URL, a key source and a chat/audio transport.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

// ---------------------------------------------------------------- capability taxonomy
const CAPABILITIES = ['llm', 'vision', 'transcription', 'tts', 'embedding', 'live', 'agent'];

/**
 * BIDI_ONLY — models that exist ONLY on the Live API (WebSocket bidiGenerateContent).
 *
 * Verified 2026-09-17: calling generateContent on `gemini-3.5-transcribe-live` answers
 * 400 "...only supports real-time bidirectional streaming via WebSocket (bidiGenerateContent)".
 * These are real, owner-configured models, so they stay in the registry and remain usable by the
 * `live` task — but they must never be offered to a REST call site. Letting the router pick one
 * spends a request to re-learn what is already known here, and the owner sees a failure.
 */
const BIDI_ONLY = /(-live|live-|native-audio)/i;
const isBidiOnly = id => BIDI_ONLY.test(String(id || ''));

/**
 * AUDIO_VERIFIED — models checked (2026-09-17) to accept inline audio through generateContent and
 * return a real transcript. This is a measured fact, not an assumption from the model's name:
 * the dedicated `gemini-3.5-transcribe` answers 200 with EMPTY content for the same request, so it
 * is NOT listed here and is never allowed to lead the transcribe chain.
 */
const AUDIO_VERIFIED = ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];
const EMPTY_ON_GENERATE = ['gemini-3.5-transcribe'];

/**
 * WORKLOAD CLASSES — what KIND of work a call is, independent of which model serves it.
 *
 * The page agent must feel like ONE agent, but it must not spend one model on everything:
 * the free tier gives a handful of requests/day to the strong models and hundreds to the lite
 * ones. So every call site declares a workload, and the router decides who serves it.
 *
 *   chat_light    ordinary conversation, status questions, approvals, small JSON extraction
 *   chat_complex  hard conversation/interpretation that needs a stronger brain
 *   edit_simple   1-2 mechanical operations (trim, mute, volume) — no real reasoning
 *   edit_complex  multi-step edit planning, creative transformation decisions
 *   vision        watching footage / frames
 *   transcription speech → timestamped text
 *   tts           voice synthesis
 *   embedding     memory/search vectors
 *   live          session-based realtime
 */
const WORKLOADS = ['chat_light', 'chat_complex', 'edit_simple', 'edit_complex', 'vision', 'transcription', 'tts', 'embedding', 'live'];

/** Usage policies — how aggressively to preserve the scarce models. */
const POLICIES = ['economy', 'balanced', 'quality'];

/**
 * TASKS — the declared workload of every routing call site, plus the capability it needs.
 * `label` is what the owner sees in the Activity stream (operational wording, never reasoning).
 */
const TASK_DEFS = {
  classify:    { capability: 'llm',           workload: 'chat_light',    label: 'Understanding request' },
  reply:       { capability: 'llm',           workload: 'chat_light',    label: 'Page agent reply' },
  reply_deep:  { capability: 'llm',           workload: 'chat_complex',  label: 'Complex conversation' },
  plan_simple: { capability: 'llm',           workload: 'edit_simple',   label: 'Simple edit plan' },
  plan:        { capability: 'llm',           workload: 'edit_complex',  label: 'Edit planning' },
  script:      { capability: 'llm',           workload: 'edit_complex',  label: 'Script writing' },
  vision:      { capability: 'vision',        workload: 'vision',        label: 'Video analysis' },
  transcribe:  { capability: 'transcription', workload: 'transcription', label: 'Transcription' },
  tts:         { capability: 'tts',           workload: 'tts',           label: 'Voice generation' },
  embed:       { capability: 'embedding',     workload: 'embedding',     label: 'Embedding' },
  live:        { capability: 'live',          workload: 'live',          label: 'Live session' },
};
// derived so nothing that only needs the capability has to change
const TASK_CAPABILITY = Object.fromEntries(Object.entries(TASK_DEFS).map(([k, v]) => [k, v.capability]));

/** Tier ordering used to decide whether a model is "too strong" for a job or the right tool. */
const TIER_RANK = { cheap: 0, agent: 1, standard: 2, strong: 3, vision: 2, transcribe: 2, tts: 2, embed: 1, live: 2, custom: 2 };

/** Workloads that genuinely benefit from a stronger model. */
const DEEP_WORKLOADS = new Set(['chat_complex', 'edit_complex', 'vision']);
const SHALLOW_WORKLOADS = new Set(['chat_light', 'edit_simple']);

/**
 * quotaClass — how scarce a model's configured allowance is.
 * Derived from the owner-supplied limits, because those are the only numbers we have; every
 * surface that shows this labels it an estimate.
 */
function quotaClass(m) {
  const rpd = Number((m && m.limits && m.limits.rpd) || 0);
  if (!rpd) return 'unmetered';        // no fixed RPD reported (e.g. live models)
  if (rpd >= 200) return 'abundant';
  if (rpd >= 21) return 'limited';
  return 'scarce';
}

/**
 * CATALOG — display names the owner listed, resolved to REAL API ids.
 *
 * The ids below were verified against this account's own models endpoint
 * (GET /v1beta/models). The initially derived slugs were partly wrong
 * (`gemini-3.7` vs the real `gemini-3.7-flash`, `antigravity` vs
 * `antigravity-preview-09-2026`, …) — which is exactly why nothing here is invented:
 * an unverified id fails at call time, so the catalog only holds ids the provider confirmed.
 * Re-run "Discover models" in Settings to re-verify or to pick up new releases.
 */
const CATALOG = [
  ['Gemini 3.1 Flash Lite', 'gemini-3.1-flash-lite', ['llm', 'vision', 'agent', 'transcription'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemini 3.1 Flash Lite Preview', 'gemini-3.1-flash-lite-preview', ['llm', 'vision', 'agent', 'transcription'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemini 3.5 Flash Lite', 'gemini-3.5-flash-lite', ['llm', 'vision', 'agent', 'transcription'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemini 2.5 Flash Lite', 'gemini-2.5-flash-lite', ['llm', 'vision'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemini Flash Lite (latest alias)', 'gemini-flash-lite-latest', ['llm', 'vision'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemini 2.5 Flash', 'gemini-2.5-flash', ['llm', 'vision', 'transcription'], { rpm: 10, rpd: 20, tier: 'standard' }],
  ['Gemini 3 Flash', 'gemini-3-flash-preview', ['llm', 'vision'], { rpm: 10, rpd: 20, tier: 'standard' }],
  ['Gemini 3.5 Flash', 'gemini-3.5-flash', ['llm', 'vision', 'transcription'], { rpm: 10, rpd: 20, tier: 'strong' }],
  ['Gemini 3.6', 'gemini-3.6-flash', ['llm', 'vision'], { rpm: 10, rpd: 20, tier: 'strong' }],
  ['Gemini 3.7', 'gemini-3.7-flash', ['llm', 'vision'], { rpm: 10, rpd: 20, tier: 'strong' }],
  ['Gemini 3.8', 'gemini-3.8-flash', ['llm', 'vision'], { rpm: 10, rpd: 20, tier: 'strong' }],
  ['Gemini 2.5 Pro', 'gemini-2.5-pro', ['llm', 'vision'], { rpm: 5, rpd: 20, tier: 'strong' }],
  ['Gemini 3.1 Pro', 'gemini-3.1-pro-preview', ['llm', 'vision'], { rpm: 5, rpd: 20, tier: 'strong' }],
  ['Antigravity', 'antigravity-preview-09-2026', ['agent', 'llm'], { rpm: 5, rpd: 100, tier: 'agent' }],
  ['Antigravity (05-2026)', 'antigravity-preview-05-2026', ['agent', 'llm'], { rpm: 5, rpd: 100, tier: 'agent' }],
  ['Gemma 4 26B', 'gemma-4-26b-a4b-it', ['llm'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemma 4 31B', 'gemma-4-31b-it', ['llm'], { rpm: 15, rpd: 500, tier: 'cheap' }],
  ['Gemini Embedding 1', 'gemini-embedding-001', ['embedding'], { rpm: 60, rpd: 1000, tier: 'embed' }],
  ['Gemini Embedding 2', 'gemini-embedding-2', ['embedding'], { rpm: 60, rpd: 1000, tier: 'embed' }],
  ['Gemini Embedding 2 Preview', 'gemini-embedding-2-preview', ['embedding'], { rpm: 60, rpd: 1000, tier: 'embed' }],
  ['Gemini 3.5 Transcribe', 'gemini-3.5-transcribe', ['transcription'], { rpm: 10, rpd: 25, tier: 'transcribe' }],
  ['Gemini 3.5 Transcribe Live', 'gemini-3.5-transcribe-live', ['transcription', 'live'], { rpm: 10, rpd: 25, tier: 'transcribe' }],
  ['Gemini 3.1 Flash TTS', 'gemini-3.1-flash-tts-preview', ['tts'], { rpm: 5, rpd: 10, tier: 'tts' }],
  ['Gemini 2.5 Flash TTS', 'gemini-2.5-flash-preview-tts', ['tts'], { rpm: 5, rpd: 10, tier: 'tts' }],
  ['Gemini 2.5 Pro TTS', 'gemini-2.5-pro-preview-tts', ['tts'], { rpm: 5, rpd: 10, tier: 'tts' }],
  ['Gemini Robotics ER 2 Preview', 'gemini-robotics-er-2-preview', ['vision'], { rpm: 10, rpd: 100, tier: 'vision' }],
  ['Gemini 2.5 Flash Native Audio Dialog', 'gemini-2.5-flash-native-audio-preview-12-2025', ['live'], { rpm: 5, rpd: 0, tier: 'live' }],
  ['Gemini 3 Flash Live', 'gemini-3.1-flash-live-preview', ['live'], { rpm: 5, rpd: 0, tier: 'live' }],
  ['Gemini 3.5 Live Translate', 'gemini-3.5-live-translate-preview', ['live'], { rpm: 5, rpd: 0, tier: 'live' }],
  ['Gemini 3.8 Live', 'gemini-3.8-live', ['live'], { rpm: 5, rpd: 0, tier: 'live' }],
  ['Gemini 3.8 Live Extended Thinking', 'gemini-3.8-live-extended-thinking', ['live'], { rpm: 5, rpd: 0, tier: 'live' }],
];

/**
 * ID_FIXES — slug corrections discovered against the live API. Applied to any settings file
 * written by an earlier build so an existing install is repaired instead of silently broken.
 * Routing chains and page overrides are rewritten in lockstep, so no chain points at a dead id.
 */
const ID_FIXES = {
  'gemini-3': 'gemini-3-flash-preview',
  'gemini-3.6': 'gemini-3.6-flash',
  'gemini-3.7': 'gemini-3.7-flash',
  'gemini-3.8': 'gemini-3.8-flash',
  'antigravity': 'antigravity-preview-09-2026',
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
  'gemma-4-31b': 'gemma-4-31b-it',
  'gemini-embedding-1': 'gemini-embedding-001',
  'gemini-3.1-flash-tts': 'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-native-audio-dialog': 'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-3-flash-live': 'gemini-3.1-flash-live-preview',
  'gemini-3.5-live-translate': 'gemini-3.5-live-translate-preview',
};

function defaultModels() {
  return CATALOG.map(([displayName, id, capabilities, limits]) => ({
    id, displayName, provider: 'google', capabilities,
    enabled: true, tier: limits.tier, verified: true,   // ids confirmed against the live models endpoint
    limits: { rpm: limits.rpm, rpd: limits.rpd, note: limits.rpd ? 'owner-supplied approximate free-tier limit — editable' : 'RPM/session constrained; no fixed RPD reported' },
    notes: '',
    // Recorded so Settings can explain WHY a model is never chosen, instead of leaving the owner
    // to guess. Both were measured against the account, not inferred from the name.
    liveOnly: isBidiOnly(id),
    audioVerified: AUDIO_VERIFIED.includes(id),
    note: isBidiOnly(id) ? 'Live API only (WebSocket bidiGenerateContent) — cannot serve a REST generateContent call.'
      : EMPTY_ON_GENERATE.includes(id) ? 'Answered 200 with empty content for inline audio via generateContent (measured 2026-09-17) — kept only as a last-resort transcription candidate.'
      : AUDIO_VERIFIED.includes(id) ? 'Verified to transcribe inline audio through generateContent (measured 2026-09-17).'
      : '',
  }));
}

function defaultSettings() {
  return {
    version: 1,
    providers: {
      google: {
        id: 'google', name: 'Google AI (Gemini)', enabled: true,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        keyMode: 'pool',            // 'pool' = reuse the studio's rotated key file (default), 'single' = one key
        apiKey: '',                 // stored server-side only; never returned to the browser
        timeoutMs: 150000,
        retry: { attempts: 3, backoffMs: 1500 },
        rateLimit: { rpm: 0, rpd: 0, note: 'provider-wide cap; 0 = rely on per-model limits' },
        updated: 0,
      },
    },
    models: defaultModels(),
    routing: {
      mode: 'auto',                       // 'auto' | 'manual'
      policy: 'balanced',                 // 'economy' | 'balanced' | 'quality' — affects real ordering
      manual: {},                         // capability -> model id
      // Ordered fallback chains per task. Everything stays inside the enabled provider.
      tasks: {
        // The chain is the owner's PREFERENCE order. The policy may reorder it within the
        // candidates the policy permits — it never invents a model that isn't enabled+capable.
        classify: ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'],
        reply: ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemma-4-26b-a4b-it'],
        reply_deep: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
        plan_simple: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
        plan: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
        // Frame-first benchmark: cheap scout, deep/ambiguous pass, verified fallback.
        vision: ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-flash'],
        // Measured, not assumed: the dedicated transcribe model returns empty content over
        // generateContent, so a verified audio-capable model leads and it is kept as a last resort.
        transcribe: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-transcribe'],
        tts: ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'],
        embed: ['gemini-embedding-001', 'gemini-embedding-2'],
        live: ['gemini-3.8-live', 'gemini-3.5-transcribe-live'],
      },
    },
    // Multiple credential configurations per provider. This exists for legitimate workload/
    // project separation and failover — NOT to rotate past a provider's or a project's rate
    // limit. credentialPick() only ever returns a credential whose OWN configured quota still
    // has room, and returns nothing when none does, so a spent quota degrades to another MODEL
    // instead of being silently worked around.
    credentials: [],                      // [{ id, provider, label, key, enabled, limits{rpm,rpd}, note }]
    credUsage: {},                        // credentialId -> usage record
    pages: {},                            // pageKey -> { brain, vision, transcription, tts, embeddings } ('auto' or a model id)
    usage: {},                            // modelId -> { day, count, minute: [], ok, fail, lastAt, lastError, lastStatus, cooldownUntil, verifiedAt }
    updated: 0,
  };
}

function createProviders(o) {
  const DIR = U.ensureDir(o.dir);
  const FILE = path.join(DIR, 'settings.json');
  const log = o.log || (() => {});
  const keys = o.keys || (() => []);     // () => string[]  live provider keys (never exposed)
  const onActivity = o.onActivity || (() => {});   // (record) => void  routing observability

  let settings = U.readJson(FILE, null);
  if (!settings || settings.version !== 1) { settings = defaultSettings(); save(); }

  // forward-migrate settings files written before workload policy / credentials existed
  if (!settings.routing.policy || !POLICIES.includes(settings.routing.policy)) settings.routing.policy = 'balanced';
  if (!Array.isArray(settings.credentials)) settings.credentials = [];
  if (!settings.credUsage || typeof settings.credUsage !== 'object') settings.credUsage = {};
  {
    const defs = defaultSettings().routing.tasks;
    let addedChains = 0;
    for (const [k, v] of Object.entries(defs)) if (!settings.routing.tasks[k]) { settings.routing.tasks[k] = v; addedChains++; }
    if (addedChains) save();
  }

  // repair slugs written by an earlier build (verified against the live models endpoint)
  let fixedIds = 0;
  const rename = (from, to) => {
    const m = settings.models.find(x => x.id === from);
    if (!m || settings.models.some(x => x.id === to)) return;
    m.id = to; m.verified = true; fixedIds++;
    for (const k of Object.keys(settings.routing.tasks)) settings.routing.tasks[k] = settings.routing.tasks[k].map(x => x === from ? to : x);
    for (const k of Object.keys(settings.routing.manual || {})) if (settings.routing.manual[k] === from) settings.routing.manual[k] = to;
    for (const pg of Object.values(settings.pages || {})) for (const k of Object.keys(pg)) if (pg[k] === from) pg[k] = to;
    if (settings.usage[from]) { settings.usage[to] = settings.usage[from]; delete settings.usage[from]; }
  };
  for (const [from, to] of Object.entries(ID_FIXES)) rename(from, to);

  // merge in any catalog entries added by a newer build
  let added = 0;
  for (const m of defaultModels()) if (!settings.models.some(x => x.id === m.id)) { settings.models.push(m); added++; }

  // ---- sync measured facts from the catalog onto models the owner already has ----
  // Capabilities are a claim about what a model can DO, and this file is the only place that
  // claim is maintained. When measurement changes it (a model turns out to accept inline audio,
  // or to be Live-API only), existing installs must inherit the correction — otherwise the router
  // keeps using a catalogue that no longer matches reality. Owner-edited fields (enabled, limits,
  // tier) are deliberately never touched here.
  let synced = 0;
  for (const def of defaultModels()) {
    const cur = settings.models.find(x => x.id === def.id);
    if (!cur) continue;
    const sameCaps = (cur.capabilities || []).slice().sort().join(',') === def.capabilities.slice().sort().join(',');
    if (!sameCaps || cur.liveOnly !== def.liveOnly || cur.audioVerified !== def.audioVerified || cur.note !== def.note) {
      cur.capabilities = def.capabilities.slice();
      cur.liveOnly = def.liveOnly;
      cur.audioVerified = def.audioVerified;
      cur.note = def.note;
      synced++;
    }
  }

  // ---- transcribe chain: lead with a model that was MEASURED to work ----
  // gemini-3.5-transcribe answers 200 with empty content for inline audio, so leaving it first
  // burns one request out of a ~25/day allowance on every single transcription. Demote it behind
  // a verified audio model. Deterministic, so this settles after one run.
  let chainFixed = 0;
  {
    const t = settings.routing.tasks.transcribe || [];
    const verified = AUDIO_VERIFIED.filter(id => settings.models.some(m => m.id === id));
    const others = t.filter(id => !verified.includes(id) && !EMPTY_ON_GENERATE.includes(id) && !isBidiOnly(id));
    const tail = t.filter(id => EMPTY_ON_GENERATE.includes(id));
    const want = verified.length ? [...verified, ...others, ...tail] : t;
    if (want.length && want.join('|') !== t.join('|')) { settings.routing.tasks.transcribe = want; chainFixed++; }
  }
  {
    const t = settings.routing.tasks.vision || [];
    const preferred = ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-flash'].filter(id => settings.models.some(m => m.id === id));
    const want = [...preferred, ...t.filter(id => !preferred.includes(id))];
    if (want.length && want.join('|') !== t.join('|')) { settings.routing.tasks.vision = want; chainFixed++; }
  }

  if (added || fixedIds || synced || chainFixed) {
    save();
    if (fixedIds) log('info', 'providers.id_migration', { fixed: fixedIds });
    if (synced) log('info', 'providers.capability_sync', { models: synced });
    if (chainFixed) log('info', 'providers.chain_fix', { tasks: ['transcribe', 'vision'] });
  }

  function save() { settings.updated = Date.now(); U.writeJsonAtomic(FILE, settings); return settings; }

  const poolHealth = require('./key-pool-health').createKeyPoolHealth({settings,save,keys});

  // ---------------------------------------------------------------- secrets
  /** Masked, browser-safe view. A stored key is reported as present, never in full. */
  function maskKey(k) {
    const s = String(k || '');
    if (!s) return '';
    return s.length <= 4 ? '••••' : '••••••••' + s.slice(-4);
  }
  function poolInfo() {
    const list = keys();
    return { available: list.length, masked: list.length ? '••••••••' + String(list[0]).slice(-4) : '' };
  }
  // ---------------------------------------------------------------- credentials
  /**
   * credentialPick — choose a credential whose OWN configured allowance still has room.
   *
   * Deliberate constraint: when every enabled credential is spent or cooling down this returns
   * null. We do not rotate around a rate limit, because the point of the registry is legitimate
   * workload/project separation and failover. A null answer makes the router move to another
   * MODEL (which is allowed) and makes the UI say so, instead of quietly working around a quota.
   */
  function credentialPick(providerId) {
    const list = settings.credentials.filter(c => c.provider === providerId && c.enabled);
    if (!list.length) return null;
    const eligible = [];
    for (const c of list) {
      const u = credUsageOf(c.id);
      if (u.cooldownUntil && u.cooldownUntil > Date.now()) continue;
      const rpd = Number((c.limits || {}).rpd || 0);
      const rpm = Number((c.limits || {}).rpm || 0);
      if (rpd && u.count >= rpd) continue;
      if (rpm && (u.minute || []).length >= rpm) continue;
      eligible.push({ c, remaining: rpd ? rpd - u.count : Infinity });
    }
    if (!eligible.length) return null;
    // most headroom first, so separation stays stable instead of round-robining blindly
    eligible.sort((a, b) => b.remaining - a.remaining);
    return eligible[0].c;
  }

  /**
   * keyContext — resolves which secret to use AND where it came from, so the caller can record
   * usage against the right bucket. Returns null when no permitted credential has room.
   */
  function keyContext(providerId, model) {
    const p = settings.providers[providerId];
    if (!p) return null;
    if (p.keyMode === 'credentials') {
      const c = credentialPick(providerId);
      if (!c) return null;                       // honest failure — do not rotate past a quota
      return { key: c.key, credential: c.id, source: 'credentials', label: c.label };
    }
    if (p.keyMode === 'single' && p.apiKey) return { key: p.apiKey, credential: null, source: 'single' };
    return poolHealth.pick(model);
  }
  /** The concrete key this provider should use right now (server-side only). */
  function keyFor(providerId) {
    const kc = keyContext(providerId);
    return kc ? kc.key : null;
  }
  let proxyKeyIndex = 0;

  function credUsageOf(id) {
    let u = settings.credUsage[id];
    if (!u || u.day !== today()) {
      u = { day: today(), count: 0, minute: [], ok: (u && u.ok) || 0, fail: (u && u.fail) || 0, lastAt: u && u.lastAt, lastError: u && u.lastError, lastStatus: u && u.lastStatus, cooldownUntil: (u && u.cooldownUntil) || 0, estimated: true };
      settings.credUsage[id] = u;
    }
    u.minute = (u.minute || []).filter(t => Date.now() - t < 60000);
    return u;
  }
  function recordCredential(id, info) {
    if (!id) return null;
    if (id.startsWith('pool_')) return poolHealth.record(id,info);
    const u = credUsageOf(id);
    u.lastAt = Date.now();
    if (info.status === 'ok') { u.count++; u.ok++; u.lastStatus = 'ok'; u.lastError = null; u.cooldownUntil = 0; }
    else {
      u.fail++; u.lastStatus = info.status || 'error'; u.lastError = U.sanitizeText(scrubSecrets(info.error || ''), 160);
      if (info.rateLimited) u.cooldownUntil = Date.now() + (info.retryAfterMs || 60000);
    }
    u.minute.push(Date.now()); u.minute = u.minute.slice(-120);
    save();
    return u;
  }
  function publicCredential(c) {
    const u = credUsageOf(c.id);
    return {
      id: c.id, provider: c.provider, label: c.label, enabled: !!c.enabled, note: c.note || '',
      keyMasked: maskKey(c.key), hasKey: !!c.key, limits: c.limits || { rpm: 0, rpd: 0 },
      usage: { used: u.count, rpd: Number((c.limits || {}).rpd || 0), remaining: Number((c.limits || {}).rpd || 0) ? Math.max(0, Number((c.limits || {}).rpd || 0) - u.count) : null, estimated: true, lastAt: u.lastAt, lastError: u.lastError, lastStatus: u.lastStatus },
      cooldown: !!(u.cooldownUntil && u.cooldownUntil > Date.now()),
      health: !c.enabled ? 'disabled' : (u.cooldownUntil && u.cooldownUntil > Date.now()) ? 'rate_limited' : (u.lastStatus && u.lastStatus !== 'ok' && u.lastAt && Date.now() - u.lastAt < 600000) ? 'error' : (u.lastStatus === 'ok' ? 'ready' : 'unknown'),
    };
  }
  function saveCredential(c) {
    c = c || {};
    const id = String(c.id || U.uid('C')).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const cur = settings.credentials.find(x => x.id === id);
    const next = cur || { id, provider: 'google', label: 'Google credential', key: '', enabled: true, limits: { rpm: 0, rpd: 0 }, note: '', updated: 0 };
    if (c.label !== undefined) next.label = U.sanitizeText(c.label, 80) || next.label;
    if (c.provider !== undefined) next.provider = U.sanitizeText(c.provider, 40) || 'google';
    if (c.enabled !== undefined) next.enabled = !!c.enabled;
    if (c.note !== undefined) next.note = U.sanitizeText(c.note, 200);
    if (c.limits) next.limits = { rpm: U.clamp((c.limits || {}).rpm, 0, 100000, (next.limits || {}).rpm || 0), rpd: U.clamp((c.limits || {}).rpd, 0, 1000000, (next.limits || {}).rpd || 0) };
    // a write of '' clears the stored secret; omitting the field leaves it untouched
    if (!cur) next.key = U.sanitizeText(c.key || '', 200);
    else if (c.key !== undefined) next.key = U.sanitizeText(c.key, 200);
    next.updated = Date.now();
    if (!cur) settings.credentials.push(next);
    save();
    return publicCredential(next);
  }
  function deleteCredential(id) {
    const before = settings.credentials.length;
    settings.credentials = settings.credentials.filter(c => c.id !== id);
    delete settings.credUsage[String(id)];
    save();
    return { removed: before - settings.credentials.length };
  }

  function publicSettings() {
    const providers = {};
    for (const [id, p] of Object.entries(settings.providers)) {
      const pool = poolInfo();
      providers[id] = {
        ...p,
        apiKey: undefined,
        hasKey: !!(p.apiKey || (p.keyMode === 'pool' && pool.available)),
        keyMasked: p.keyMode === 'pool' ? pool.masked : maskKey(p.apiKey),
        poolKeys: pool.available,
      };
    }
    return {
      providers, models: settings.models.map(publicModel), routing: settings.routing,
      pages: settings.pages, updated: settings.updated,
      credentials: settings.credentials.map(publicCredential),
      workloads: WORKLOADS, policies: POLICIES, tasks: TASK_DEFS,
      providerCatalog: { google: { name: 'Google AI (Gemini)', implemented: true } },
    };
  }
  function publicModel(m) {
    const u = usageOf(m.id);
    return { ...m, health: healthOf(m.id), usage: u };
  }

  // ---------------------------------------------------------------- usage / health
  const today = () => new Date().toISOString().slice(0, 10);
  function usageOf(id) {
    let u = settings.usage[id];
    if (!u || u.day !== today()) {
      u = { day: today(), count: 0, minute: [], ok: (u && u.ok) || 0, fail: (u && u.fail) || 0, lastAt: u && u.lastAt, lastError: u && u.lastError, lastStatus: u && u.lastStatus, cooldownUntil: (u && u.cooldownUntil) || 0, verifiedAt: u && u.verifiedAt, estimated: true };
      settings.usage[id] = u;
    }
    u.minute = (u.minute || []).filter(t => Date.now() - t < 60000);
    return u;
  }
  /**
   * scrubSecrets — provider error bodies sometimes embed the caller's own key
   * ("403 Permission denied: Consumer api_key:AIza… has been suspended"). Storing that verbatim
   * would leak the secret into settings.json, every Settings response and the UI. Keys are
   * replaced with their mask BEFORE anything is persisted; the human-readable cause survives.
   */
  function scrubSecrets(text) {
    let s = String(text || '');
    for (const k of keys()) if (k && s.includes(k)) s = s.split(k).join(maskKey(k));
    for (const c of settings.credentials || []) if (c.key && s.includes(c.key)) s = s.split(c.key).join(maskKey(c.key));
    if (settings.providers.google.apiKey && s.includes(settings.providers.google.apiKey)) s = s.split(settings.providers.google.apiKey).join(maskKey(settings.providers.google.apiKey));
    return s;
  }
  /** record — every real call reports back, so health and quota estimates stay honest. */
  function record(id, info) {
    const u = usageOf(id);
    u.lastAt = Date.now();
    if (info.status === 'ok') { u.count++; u.ok++; u.lastStatus = 'ok'; u.lastError = null; u.cooldownUntil = 0; }
    else {
      u.fail++; u.lastStatus = info.status || 'error'; u.lastError = U.sanitizeText(scrubSecrets(info.error || ''), 200);
      if (info.rateLimited) u.cooldownUntil = Date.now() + (info.retryAfterMs || 60000);
    }
    u.minute.push(Date.now());
    u.minute = u.minute.slice(-120);
    save();
    return u;
  }
  function setVerified(id, ok) {
    const m = find(id);
    if (m) { m.verified = !!ok; usageOf(id).verifiedAt = Date.now(); save(); }
  }
  function healthOf(id) {
    const m = find(id);
    if (!m) return 'unknown';
    if (!m.enabled) return 'disabled';
    if (m.provider && settings.providers[m.provider] && settings.providers[m.provider].enabled === false) return 'disabled';
    const u = usageOf(id);
    if (u.cooldownUntil && u.cooldownUntil > Date.now()) return 'rate_limited';
    const minuteCount = (u.minute || []).length;
    if (m.limits && m.limits.rpd && u.count >= m.limits.rpd) return 'rate_limited';
    if (m.limits && m.limits.rpm && minuteCount > m.limits.rpm) return 'rate_limited';
    const recent = u.lastAt && Date.now() - u.lastAt < 10 * 60000;
    if (recent && u.lastStatus && u.lastStatus !== 'ok') return 'error';
    if (recent && u.lastStatus === 'ok') return 'ready';
    return 'unknown';   // never claim healthy without recent evidence
  }

  const find = id => settings.models.find(m => m.id === id);
  const enabledModels = () => settings.models.filter(m => m.enabled && (settings.providers[m.provider] || {}).enabled !== false);

  // ---------------------------------------------------------------- router
  /**
   * TIER_OF_WORKLOAD — the tier each workload should aim for, per usage policy.
   * This table is the whole "chat brain vs worker brains" idea in one place: ordinary
   * conversation aims at the cheap high-quota models, and only genuinely hard work aims higher —
   * and even then only as far as the policy allows.
   */
  const TIER_OF_WORKLOAD = {
    chat_light:    { economy: 'cheap',    balanced: 'cheap',    quality: 'standard' },
    edit_simple:   { economy: 'cheap',    balanced: 'cheap',    quality: 'standard' },
    chat_complex:  { economy: 'cheap',    balanced: 'standard', quality: 'strong' },
    edit_complex:  { economy: 'cheap',    balanced: 'strong',   quality: 'strong' },
    vision:        { economy: 'cheap',    balanced: 'standard', quality: 'strong' },
    transcription: { economy: 'standard', balanced: 'standard', quality: 'strong' },
    tts:           { economy: 'standard', balanced: 'standard', quality: 'strong' },
    embedding:     { economy: 'cheap',    balanced: 'standard', quality: 'strong' },
    live:          { economy: 'standard', balanced: 'standard', quality: 'strong' },
  };

  /** How much a given quota class costs under a policy. Scarce models are expensive to spend. */
  function scarceCost(quota, policy) {
    if (quota === 'abundant') return 0;
    if (quota === 'unmetered') return 6;                       // live: session-limited, no fixed RPD
    if (quota === 'limited') return policy === 'economy' ? 16 : policy === 'balanced' ? 8 : 4;
    return policy === 'economy' ? 40 : policy === 'balanced' ? 10 : 2;   // scarce
  }
  /** How far a model's tier is from what this workload wants under this policy. */
  function fitCost(m, workload, policy) {
    const want = (TIER_OF_WORKLOAD[workload] || {})[policy] || 'standard';
    const r = TIER_RANK[m.tier || 'custom'];
    const wantRank = TIER_RANK[want] == null ? 2 : TIER_RANK[want];
    return Math.abs((r == null ? 2 : r) - wantRank) * 4;
  }
  /**
   * USABILITY_PENALTY — measured, per workload, and it exists because tier fit alone is not truth.
   *
   * `gemini-3.5-transcribe` has the ideal tier for transcription and would therefore always lead,
   * except that it answers 200 with EMPTY content over generateContent (measured 2026-09-17).
   * Letting it lead burns one request from a ~25/day allowance on every single transcription and
   * shows the owner a failure. On a free tier the wasted request is the most expensive thing in the
   * system, so a model measured not to serve a workload is scored out of the lead instead of being
   * remembered only as a comment.
   */
  const USABILITY_PENALTY = { transcription: { 'gemini-3.5-transcribe': 40 } };
  function usabilityPenalty(id, workload) {
    return (USABILITY_PENALTY[workload] || {})[id] || 0;
  }

  function policyScore(m, workload, policy) {
    return scarceCost(quotaClass(m), policy) + fitCost(m, workload, policy) + usabilityPenalty(m.id, workload);
  }

  /**
   * pick(task, opts) — choose models for a task from enabled + capable + permitted candidates,
   * ordered by the usage policy. Returns an ordered list so the caller can fall back on
   * 429/quota/unavailable without ever silently switching provider. opts.page lets a page agent
   * override with its own model.
   */
  function pick(task, opts) {
    opts = opts || {};
    const def = TASK_DEFS[task] || { capability: 'llm', workload: 'chat_light', label: task };
    const cap = def.capability;
    const workload = opts.workload || def.workload;
    const policy = POLICIES.includes(opts.policy) ? opts.policy : (settings.routing.policy || 'balanced');
    const out = {
      task, capability: cap, workload, policy, label: def.label,
      candidates: [], scored: [], skipped: [], blocked: [], liveOnly: [], reason: '',
      mode: settings.routing.mode, manual: null,
    };
    const isLiveTask = task === 'live';
    // Pinned production tasks keep the owner's exact order and do not append other models.
    if ((settings.routing.pinnedTasks || []).includes(task)) {
      const chain = settings.routing.tasks[task] || [];
      out.candidates = chain.filter(id => {
        const m = find(id);
        return m && m.enabled && m.capabilities.includes(cap) && (isLiveTask || !isBidiOnly(id));
      });
      out.reason = 'owner-pinned model order for ' + task;
      return out;
    }

    // 1. page-level override, then global manual override — a manual pick leads, but the
    //    automatic chain still sits behind it so a spent/invalid model degrades instead of failing.
    const pageCfg = opts.page ? (settings.pages[opts.page] || {}) : {};
    const manualId = opts.model || pageCfg[cap] || settings.routing.manual[cap];
    let leading = [];
    if (manualId && manualId !== 'auto') {
      const m = find(manualId);
      out.manual = manualId;
      if (m && m.enabled && m.capabilities.includes(cap) && (isLiveTask || !isBidiOnly(m.id))) {
        leading = [m.id];
        out.reason = 'manual selection for ' + cap + (opts.model ? ' (requested)' : '') + ' (auto chain kept as fallback)';
      } else if (m && isBidiOnly(m.id) && !isLiveTask) {
        // Refuse it out loud rather than letting the call fail with a transport error later.
        out.reason = 'manual model ' + manualId + ' is Live-API only and cannot serve ' + task + ' — falling back to auto';
        out.liveOnly.push(m.id);
      } else {
        out.reason = 'manual model ' + manualId + ' is unavailable or lacks ' + cap + ' — falling back to auto';
      }
    }

    const chain = (settings.routing.tasks[task] || []).slice();
    // anything capable that is not in the chain is appended as a last resort
    for (const m of enabledModels()) {
      if (m.capabilities.includes(cap) && !chain.includes(m.id)) chain.push(m.id);
    }
    const pool = [];
    chain.forEach((id, idx) => {
      if (leading.includes(id)) return;
      // A bidi-only model cannot answer generateContent at all (400), so offering one to any REST
      // task is a guaranteed wasted request. The `live` task is the only place they belong.
      if (!isLiveTask && isBidiOnly(id)) { if (!out.liveOnly.includes(id)) out.liveOnly.push(id); return; }
      const m = find(id);
      if (!m || !m.enabled) return;
      if (!m.capabilities.includes(cap)) return;
      if (healthOf(id) === 'rate_limited') { out.blocked.push(id); return; }
      pool.push({ m, idx });
    });

    // 2. policy gating. ECONOMY refuses to spend a scarce model on shallow work while any
    //    non-scarce capable model is free. This is a real filter, not a preference.
    let cands = pool;
    if (policy === 'economy' && SHALLOW_WORKLOADS.has(workload)) {
      const nonScarce = pool.filter(p => quotaClass(p.m) !== 'scarce');
      if (nonScarce.length) {
        out.skipped = pool.filter(p => quotaClass(p.m) === 'scarce').map(p => p.m.id);
        cands = nonScarce;
      }
    }

    // 3. policy ordering. Chain index is the tiebreak, so the owner's explicit order still
    //    decides between models the policy scores equally.
    const ordered = cands.slice().sort((a, b) =>
      (policyScore(a.m, workload, policy) - policyScore(b.m, workload, policy)) || (a.idx - b.idx));
    out.scored = ordered.map(p => ({
      id: p.m.id, quota: quotaClass(p.m), tier: p.m.tier || 'custom',
      score: policyScore(p.m, workload, policy), chainIndex: p.idx,
      penalty: usabilityPenalty(p.m.id, workload) || 0,
    }));
    out.candidates = [...leading, ...ordered.map(p => p.m.id)];

    // if everything is cooling down, allow the first anyway so the task can still run
    if (!out.candidates.length && out.blocked.length) { out.candidates = out.blocked.slice(0, 1); out.reason = 'every capable model is rate-limited — using the first anyway'; }
    if (!out.candidates.length && leading.length) { out.candidates = leading; }   // manual pick is all we have
    if (!out.reason) {
      out.reason = out.candidates.length
        ? 'policy ' + policy + ' → ' + workload + ' (' + cap + ')'
          + (out.skipped.length ? ', spared ' + out.skipped.length + ' scarce model(s)' : '')
          + (out.blocked.length ? ', skipped ' + out.blocked.length + ' rate-limited' : '')
        : 'no enabled model advertises ' + cap;
      if (out.liveOnly.length) out.reason += '; excluded ' + out.liveOnly.length + ' Live-API-only model(s)';
    }
    return out;
  }

  /**
   * reportTask — one record per real model call: who served it, how long, whether it worked.
   * Feeds the Activity stream (operational facts only) and the usage tracker.
   */
  function reportTask(info) {
    info = info || {};
    const dir = { task: info.task, capability: info.capability, workload: info.workload, policy: info.policy, model: info.model, provider: info.provider || 'google', ms: info.ms, status: info.status || 'ok', error: info.error || null, page: info.page || '', project: info.project || '', credential: info.credential || null, label: info.label || ((TASK_DEFS[info.task] || {}).label || info.task), fallbackFrom: info.fallbackFrom || null, attempts: info.attempts || 1 };
    try { onActivity(dir); } catch (_) {}
    return dir;
  }

  function setPolicy(p) {
    if (!POLICIES.includes(p)) throw new Error('policy must be one of ' + POLICIES.join(', '));
    settings.routing.policy = p;
    save();
    return settings.routing.policy;
  }

  /** The single model id most services want (first candidate, or a documented fallback). */
  function pickOne(task, opts) {
    const r = pick(task, opts);
    return r.candidates[0] || (opts && opts.fallback) || null;
  }

  // ---------------------------------------------------------------- mutations
  function saveProvider(id, patch) {
    const cur = settings.providers[id] || { id };
    const next = { ...cur, ...(patch || {}), id, updated: Date.now() };
    if (patch && patch.retry) next.retry = { ...cur.retry, ...patch.retry };
    if (patch && patch.rateLimit) next.rateLimit = { ...cur.rateLimit, ...patch.rateLimit };
    if ('apiKey' in (patch || {}) && patch.apiKey === '') next.apiKey = '';   // explicit clear
    settings.providers[id] = next;
    save();
    return settings.providers[id];
  }
  function saveModel(m) {
    if (!m || !m.id) throw new Error('model id required');
    const id = String(m.id).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 90);
    if (!id) throw new Error('model id must contain letters or digits');
    let cur = find(id);
    if (!cur) { cur = { id, provider: 'google', capabilities: [], enabled: true, limits: { rpm: 0, rpd: 0 }, tier: 'custom', verified: false, notes: '' }; settings.models.push(cur); }
    const next = {
      ...cur, ...m, id,
      provider: U.sanitizeText(m.provider || cur.provider, 40),
      displayName: U.sanitizeText(m.displayName || cur.displayName || id, 80),
      capabilities: (Array.isArray(m.capabilities) ? m.capabilities : cur.capabilities).filter(c => CAPABILITIES.includes(c)),
      enabled: m.enabled === undefined ? cur.enabled : !!m.enabled,
      notes: U.sanitizeText(m.notes || cur.notes || '', 300),
      limits: { rpm: U.clamp((m.limits || {}).rpm, 0, 100000, cur.limits.rpm || 0), rpd: U.clamp((m.limits || {}).rpd, 0, 1000000, cur.limits.rpd || 0), note: U.sanitizeText((m.limits || {}).note || (cur.limits || {}).note || '', 200) },
    };
    const i = settings.models.findIndex(x => x.id === id);
    settings.models[i] = next;
    save();
    return next;
  }
  function deleteModel(id) {
    const before = settings.models.length;
    settings.models = settings.models.filter(m => m.id !== id);
    for (const cap of Object.keys(settings.routing.tasks)) settings.routing.tasks[cap] = settings.routing.tasks[cap].filter(x => x !== id);
    for (const cap of Object.keys(settings.routing.manual)) if (settings.routing.manual[cap] === id) delete settings.routing.manual[cap];
    save();
    return { removed: before - settings.models.length };
  }
  function saveRouting(r) {
    r = r || {};
    if (r.mode) settings.routing.mode = r.mode === 'manual' ? 'manual' : 'auto';
    if (r.policy) settings.routing.policy = POLICIES.includes(r.policy) ? r.policy : settings.routing.policy;
    if (r.manual) settings.routing.manual = { ...settings.routing.manual, ...r.manual };
    if (Array.isArray(r.pinnedTasks)) settings.routing.pinnedTasks = [...new Set(r.pinnedTasks.map(String))];
    if (r.tasks) {
      for (const [k, v] of Object.entries(r.tasks)) {
        if (!Array.isArray(v)) continue;
        settings.routing.tasks[k] = v.map(x => String(x)).filter(id => !!find(id));
      }
    }
    save();
    return settings.routing;
  }
  function savePageRouting(pageKey, patch) {
    settings.pages[pageKey] = { ...(settings.pages[pageKey] || {}), ...(patch || {}) };
    Object.keys(settings.pages[pageKey]).forEach(k => { if (settings.pages[pageKey][k] === '') delete settings.pages[pageKey][k]; });
    save();
    return settings.pages[pageKey];
  }

  return {
    FILE, CAPABILITIES, TASK_CAPABILITY, TASK_DEFS, WORKLOADS, POLICIES,
    get settings() { return settings; },
    publicSettings, saveProvider, saveModel, deleteModel, saveRouting, savePageRouting, setPolicy,
    models: () => settings.models, find, enabledModels, pick, pickOne, quotaClass, policyScore, TIER_OF_WORKLOAD,
    record, reportTask, setVerified, healthOf, usageOf, keyFor, keyContext,
    credentials: () => settings.credentials.map(publicCredential),
    saveCredential, deleteCredential, credentialPick, credUsageOf, recordCredential, publicCredential,
    poolHealth,
    maskPublic: maskKey,
  };
}

module.exports = { createProviders, CAPABILITIES, TASK_CAPABILITY, TASK_DEFS, WORKLOADS, POLICIES, quotaClass, defaultSettings, defaultModels, CATALOG };
