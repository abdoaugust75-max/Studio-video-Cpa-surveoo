// VideoStudio v2 — local video automation studio (zero dependencies, Node >= 18)
// Fixed port 3333, bound to 127.0.0.1. All state in ./data
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {createGate,stopTree}=require('./lib/process-budget');
const metadataGate=createGate(2);
const { Readable } = require('stream');
const { profileFor } = require('./lib/campaign-profiles');

const { resolveStorage } = require('./lib/storage');

const ROOT = __dirname;
// Every path is now environment-configurable, so the app can be moved into a container later
// without rewriting where it writes. Defaults reproduce the current local layout exactly.
const STORAGE = resolveStorage({ root: ROOT }).ensure();
const DATA = STORAGE.dataDir;
const CACHE = STORAGE.cacheDir;
const PROJECTS = STORAGE.legacyProjectsDir;
const MEMORY = path.join(DATA, 'memory');
const MEDIA = STORAGE.legacyMediaDir;
const TEMPLATES = path.join(DATA, 'templates');
const PUBLIC = path.join(ROOT, 'public');
for (const d of [CACHE, PROJECTS, MEMORY, MEDIA, TEMPLATES, PUBLIC]) fs.mkdirSync(d, { recursive: true });

// ----------------------------------------------------------------------------------------------
// Startup configuration is READ, never assumed. A fresh data volume (a new container, a new VPS)
// starts with none of these files, and crashing with an ENOENT stack trace at boot is the least
// useful possible behaviour: the container restarts forever and the operator sees nothing.
// So: defaults are created, missing files are reported clearly, and the app comes up.
// ----------------------------------------------------------------------------------------------
function readJsonOrCreate(file, fallback, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      console.log(new Date().toISOString().slice(11, 19), '[config] created ' + what + ' at ' + file);
      return fallback;
    }
    console.log(new Date().toISOString().slice(11, 19), '[config] ' + what + ' is unreadable (' + e.message + ') — using defaults');
    return fallback;
  }
}
const CFG = readJsonOrCreate(path.join(DATA, 'config.json'),
  { port: Number(process.env.VS_PORT) || 3340, models: {}, geminiKeyFile: 'gemini_keys.txt', brands: Object.fromEntries(require('./lib/campaign-profiles').PROFILES.map(p=>[p.key,{label:p.key,lang:p.language,color:p.color}])), render_endpoints: {} },
  'config.json');
const KEYS = (() => {
  try { return fs.readFileSync(path.join(DATA, 'gemini_keys.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  catch (_) {
    console.log(new Date().toISOString().slice(11, 19), '[config] no gemini_keys.txt — add provider keys in Settings → Providers');
    return [];
  }
})();
let keyIdx = 0;
const nextKey = () => { if (!KEYS.length) return ''; keyIdx = (keyIdx + 1) % KEYS.length; return KEYS[keyIdx]; };
const FBCFG = () => readJsonOrCreate(path.join(DATA, 'fb_config.json'), { pages: [] }, 'fb_config.json');
const saveFBCFG = c => fs.writeFileSync(path.join(DATA, 'fb_config.json'), JSON.stringify(c, null, 2));
const APPV = 'v21.0';

// Read-only Graph reconciliation. Page names are mutable in Meta; keeping a stale copied name in
// a page agent is how a correct id can look like the wrong destination. Tokens never leave this
// function or its outbound request, and a failed lookup leaves the last known local mapping intact.
async function refreshFacebookPages() {
  const cfg = FBCFG();
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const results = [];
  for (const page of pages) {
    if (!page || !page.id || !page.page_token) { results.push({ id: String((page || {}).id || ''), ok: false, error: 'page id or access token is missing' }); continue; }
    try {
      const url = 'https://graph.facebook.com/' + APPV + '/' + encodeURIComponent(page.id)
        + '?fields=id,name&access_token=' + encodeURIComponent(page.page_token);
      const remote = await fetchJson(url, { timeout: 20000 }, 1);
      if (!remote || String(remote.id) !== String(page.id) || !remote.name) throw new Error('Graph returned no matching page identity');
      const name = String(remote.name).replace(/[\r\n]/g, ' ').trim().slice(0, 120);
      const changed = name && name !== page.name;
      if (changed) page.name = name;
      results.push({ id: String(page.id), name: page.name || name, ok: true, changed, capabilities: { videoPublish: true, verifiedAt: Date.now() } });
    } catch (e) {
      // Do not bubble Graph response bodies or request URLs into logs/UI: either could contain an
      // access token. The operator only needs a short, safe failure reason.
      results.push({ id: String(page.id), name: page.name || '', ok: false, error: String(e && e.message || 'Graph refresh failed').replace(/https?:\/\/\S+/g, 'Graph request failed').slice(0, 160) });
    }
  }
  if (results.some(r => r.changed)) saveFBCFG(cfg);
  return { refreshedAt: Date.now(), refreshed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, pages: results };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const j = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, err) => { const chunks = []; let size = 0; req.on('data', c => { size += c.length; if (size > 200e6) req.destroy(); chunks.push(c); }); req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', err); });
const readJson = async req => { const b = await readBody(req); try { return JSON.parse(b.toString('utf8') || '{}'); } catch (_) { return {}; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function fetchText(url, opts = {}, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(opts.timeout || 25000) });
      return await r.text();
    } catch (e) { lastErr = e; await sleep(1200); }
  }
  throw lastErr;
}
const fetchJson = async (url, opts = {}, tries = 2) => { const t = await fetchText(url, opts, tries); try { return JSON.parse(t); } catch (_) { throw new Error('bad json: ' + t.slice(0, 120)); } };
function extractJSON(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, '```').split('```').filter(Boolean);
  t = t.sort((a, b) => b.length - a.length)[0] || text;
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { return null; }
}

// ---------- provider registry + capability router ----------
// Every model id in this process comes from here, so Settings actually changes behaviour.
const { createProviders } = require('./lib/providers');
// The activity sink is bound after the studio exists (the studio owns the SSE clients), so
// routing records made before then are simply dropped rather than lost into a stub.
const activitySink = { fn: null };
const providers = createProviders({
  dir: path.join(DATA, 'studio'),
  log: (lvl, ev, ctx) => log('[providers]', ev, JSON.stringify(ctx || {})),
  keys: () => KEYS,
  onActivity: rec => { if (activitySink.fn) activitySink.fn(rec); },
});

/**
 * routeCandidates(task, override) — the ordered models to try for a task.
 * An explicit override (page setting or a caller's choice) is honoured first, but the router's
 * chain stays behind it, so a 429 on the chosen model degrades instead of failing the task.
 */
function routeCandidates(task, override, opts) {
  opts = opts || {};
  const r = providers.pick(task || 'plan', opts);
  const own = override && providers.find(override) && providers.find(override).enabled ? [override] : [];
  const rest = r.candidates.filter(x => !own.includes(x));
  const list = [...own, ...rest];
  const shared = { task: r.task, capability: r.capability, workload: r.workload, policy: r.policy, scored: r.scored, skipped: r.skipped, mode: r.mode };
  if (list.length) return { list, ...shared, reason: r.reason };
  const fb = override || providers.pickOne(task || 'plan', opts) || CFG.models.writer;
  return { list: fb ? [fb] : [], ...shared, reason: 'router found no candidate — legacy fallback' };
}

/**
 * redact — secret hygiene (owner security rule): provider error bodies can ECHO the credential
 * ("403 Permission denied: Consumer api_key:AIza…" — a real observed leak into chat). Nothing
 * that reaches logs, chat answers, artifacts or reports may carry key material.
 */
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/(api[_-]?key["'\s:=]+)\S+/gi, '$1[REDACTED]')
    .replace(/([?&]key=)\S+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED-KEY]')
    .replace(/AQ\.Ab[0-9A-Za-z_-]{20,}/g, '[REDACTED-TOKEN]');
}

const isQuota = s => /quota|429|RESOURCE_EXHAUSTED|rate limit/i.test(String(s || ''));
const isUnavailable = s => /503|overload|UNAVAILABLE|high demand/i.test(String(s || ''));
// A missing/unsupported model is permanent: retrying it just burns time. Move to the next candidate now.
const isMissing = s => /not found|NOT_FOUND|\b404\b|not supported|unsupported|invalid model|permission/i.test(String(s || ''));

/**
 * gemini(model, body, task) — routed call with real fallback and honest usage accounting.
 * A 429 marks that model rate-limited (with a cooldown) and the next capable model is tried;
 * the routing decision is logged so the operational activity stream can explain itself.
 */
async function gemini(model, body, task, opts) {
  task = task || 'plan';
  opts = opts || {};
  const route = routeCandidates(task, model, opts);
  if (Array.isArray(opts.modelChain)) route.list = opts.modelChain.filter(id => providers.find(id) && providers.find(id).enabled);
  if (!route.list.length) throw new Error('no model available for ' + task + ' (configure one in Settings → Models)');
  let lastErr = 'unknown';
  const tried = [];
  const startedAt = Date.now();
  for (const cand of route.list.slice(0, Math.max(1,Math.min(4,opts.maxModels || 4)))) {
    for (let attempt = 0; attempt < (opts.maxAttempts || Math.max(1, Math.min(KEYS.length, 3))); attempt++) {
      // The credential comes from the registry, not straight from the key file, so a credential
      // whose own configured quota is spent is never silently worked around.
      const kc = providers.keyContext('google',cand);
      if (!kc) {
        lastErr = 'every enabled Google credential is spent or cooling down (configure more, or wait)';
        break;
      }
      const key = kc.key;
      try {
        const r = await fetch(`${providers.settings.providers.google.baseUrl}/models/${cand}:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs || providers.settings.providers.google.timeoutMs || 150000),
        });
        const out = await r.json().catch(() => ({}));
        if (out.candidates && out.candidates[0]) {
          const parts = out.candidates[0].content && out.candidates[0].content.parts;
          if (parts && parts.some(p=>!p.thought && (p.text?.trim() || p.inlineData?.data)) && (!opts.validateJSON || extractJSON(parts.filter(p=>!p.thought).map(p=>p.text||'').join(''))) && (!opts.validateResponse || (()=>{try{return opts.validateResponse(parts.filter(p=>!p.thought).map(p=>p.text||'').join(''))!==false;}catch(_){return false;}})()) && out.candidates[0].finishReason !== 'MAX_TOKENS' && (!opts.requireAudio || parts.some(p => p.inlineData && p.inlineData.data))) {
            providers.record(cand, { status: 'ok' });
            if (kc.credential) providers.recordCredential(kc.credential, { status: 'ok', model:cand, tokens:out.usageMetadata?.totalTokenCount });
            providers.reportTask({
              task, capability: route.capability, workload: route.workload, policy: route.policy,
              model: cand, provider: 'google', ms: Date.now() - startedAt, status: 'ok',
              page: opts.page, project: opts.project, credential: kc.credential, source: kc.source,
              fallbackFrom: tried.length ? tried[tried.length - 1] : null, attempts: attempt + 1,
            });
            if (tried.length) log('[router]', task, '→', cand, '(fell back after ' + tried.join(', ') + ')');
            // Hand the caller the model that actually served this call, so records can state the
            // truth (a fallback is otherwise invisible to whoever stored the result).
            if (opts && typeof opts === 'object') opts.__model = cand;
            return parts;
          }
        }
        // Distinguish "the model said nothing" from a transport error. Measured example:
        // gemini-3.5-transcribe answers 200 with finishReason STOP and no content parts for inline
        // audio, so this is where that shows up — and it must name the model and the reason rather
        // than reporting a vague 'no candidates' to the owner.
        lastErr = redact((out.error && (out.error.code + ' ' + out.error.message))
          || ((out.candidates && out.candidates[0] && out.candidates[0].finishReason)
            ? (cand + ' returned an empty response (finishReason ' + out.candidates[0].finishReason + ') — this model cannot serve this request over generateContent')
            : 'no candidates'));
        if(kc.source==='pool' && /suspended|API key not valid|API_KEY_INVALID|key.*(?:disabled|revoked|expired)/i.test(lastErr)){
          providers.recordCredential(kc.credential,{status:'error',error:lastErr,model:cand});
          attempt--; continue; // quarantined key cannot be selected again; bounded by pool size
        }
        providers.record(cand, { status: isQuota(lastErr) ? 'rate_limited' : 'error', error: lastErr, rateLimited: isQuota(lastErr), retryAfterMs: 60e3 });
        if (kc.credential) providers.recordCredential(kc.credential, { model:cand, status: isQuota(lastErr) ? 'rate_limited' : 'error', error: lastErr, rateLimited: isQuota(lastErr), retryAfterMs: 60e3 });
        if (isQuota(lastErr) || isMissing(lastErr)) break;   // spent or non-existent — try the next candidate
        if (isUnavailable(lastErr)) { await sleep(6000); continue; }
        break;                                               // any other error: fall through to the next model, surfacing only if all fail
      } catch (e) {
        lastErr = redact(e.message);
        providers.record(cand, { status: isQuota(lastErr) ? 'rate_limited' : 'error', error: lastErr, rateLimited: isQuota(lastErr) });
        if (kc.credential) providers.recordCredential(kc.credential, { model:cand, status: isQuota(lastErr) ? 'rate_limited' : 'error', error: lastErr, rateLimited: isQuota(lastErr) });
        if (isQuota(lastErr) || isMissing(lastErr)) break;
        await sleep(1500);
      }
    }
    tried.push(cand);
  }
  providers.reportTask({
    task, capability: route.capability, workload: route.workload, policy: route.policy,
    model: tried[tried.length - 1] || null, provider: 'google', ms: Date.now() - startedAt,
    status: 'failed', error: lastErr, page: opts.page, project: opts.project, attempts: tried.length,
  });
  throw new Error(redact('Gemini failed after trying ' + tried.join(', ') + ': ' + lastErr));
}
const gemText = async (model, prompt, task, opts) => {
  opts=opts || {}; if(opts.jsonAnswer){opts.validateJSON=true;opts.validateResponse ||= raw=>typeof extractJSON(raw)?.answer==='string'&&!!extractJSON(raw).answer.trim();}
  const body={contents:[{parts:[{text:prompt}]}]};
  if(opts?.jsonAnswer) body.generationConfig={responseMimeType:'application/json',responseSchema:opts.jsonSchema || {type:'OBJECT',properties:{answer:{type:'STRING'}},required:['answer']}};
  return (await gemini(model,body,task || 'reply',opts)).filter(p=>p.thought!==true).map(p=>p.text || '').join('');
};
async function gemAudio(model, prompt, voice, rate = 1.0, task, deliveryStyle = null) {
  const structured = /gemini-3\.8.*tts/i.test(model);
  const parts = await gemini(model, {
    contents: [{ role: 'user', parts: [{ text: prompt, ...(structured && deliveryStyle ? { speech_metadata: { style: deliveryStyle } } : {}) }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: structured ? { voice } : { prebuiltVoiceConfig: { voiceName: voice } } } },
  }, task || 'tts', { modelChain: [model], maxAttempts: 1, requireAudio: true });
  const audioParts = parts.filter(p => p.inlineData && p.inlineData.data);
  if (!audioParts.length) throw new Error('no audio');
  const buffers = audioParts.map(p => Buffer.from(p.inlineData.data, 'base64'));
  if (buffers.length > 1 && buffers.some(b => b.toString('ascii',0,4) === 'RIFF')) throw Error('Multiple WAV containers returned; retry with the fallback TTS model.');
  const audio = Buffer.concat(buffers);
  audio.mimeType = audioParts[0].inlineData.mimeType || '';
  return audio;
}
// gemVision accepts ONE image (a Buffer) or SEVERAL (an array of Buffers). Several images go in a
// single request so judging a video from three sampled frames costs one vision call, not three —
// which matters on a free tier.
async function gemVision(model, prompt, mediaBuf, mime, task, opts) {
  const bufs = Array.isArray(mediaBuf) ? mediaBuf.filter(b => b && b.length) : [mediaBuf];
  if (!bufs.length) throw new Error('vision called with no image data');
  const parts = await gemini(model, {
    contents: [{
      parts: [
        { text: prompt },
        ...bufs.map(b => ({ inline_data: { mime_type: mime || 'image/jpeg', data: b.toString('base64') } })),
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  }, task || 'vision', opts);
  return parts.filter(p=>!p.thought).map(p => p.text || '').join('');
}

// Native video input keeps chronological motion and sound. Sampling rate is explicit so a
// whole-video review cannot silently fall back to the default one-frame-per-second view.
async function gemVideo(model, prompt, videoBuf, mime, opts) {
  opts = opts || {};
  if (!Buffer.isBuffer(videoBuf) || !videoBuf.length) throw new Error('video analysis requires a real video buffer');
  if (videoBuf.length > 18 * 1024 * 1024) throw new Error('analysis segment exceeds the inline video budget');
  opts.validateJSON=true;
  const fps = Number(opts.fps);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 24) throw new Error('native video analysis accepts a maximum of 24 fps; use frame-preserving slow playback for faster sources');
  const parts = await gemini(model, {
    contents: [{ parts: [
      { inline_data: { mime_type: mime || 'video/mp4', data: videoBuf.toString('base64') }, videoMetadata: { fps } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' },
  }, 'vision', opts);
  return parts.filter(p=>!p.thought).map(p => p.text || '').join('');
}
/**
 * gemTranscribe — audio in, transcript text out, through the router's `transcribe` task.
 * The prompt asks for JSON and the caller validates it; this transport only moves bytes. Large
 * clips are rejected up front rather than failing halfway through a 150 s timeout.
 */
async function gemTranscribe(model, prompt, audioBuf, mime, opts) {
  const MAX = 18 * 1024 * 1024;   // ~18 MB of 16 kHz mono PCM is many minutes of speech
  if (audioBuf.length > MAX) throw new Error('audio is too long for a single transcription request (' + Math.round(audioBuf.length / 1048576) + ' MB); trim the video first');
  const parts = await gemini(model, {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime || 'audio/wav', data: audioBuf.toString('base64') } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 16384, ...(opts?.jsonAnswer?{responseMimeType:'application/json',responseSchema:opts.jsonSchema}:{}) },
  }, 'transcribe', opts);
  return parts.filter(p=>!p.thought).map(p => p.text || '').join('');
}

/** discoverModels — the provider's own catalogue. The only way an id gets marked verified. */
async function discoverModels() {
  const d = await fetchJson(`${providers.settings.providers.google.baseUrl}/models?pageSize=1000&key=${providers.keyFor('google')}`, { timeout: 25000 }, 2);
  return (d.models || []).map(m => ({ id: String(m.name || '').replace(/^models\//, ''), display: m.displayName || '', methods: m.supportedGenerationMethods || [] }));
}

// Legacy `CFG.models.*` keys resolve through the router on every access. Existing call sites
// therefore inherit Settings without a rewrite, and a legacy settings save still sticks
// (it becomes a manual routing override).
for (const [prop, task] of [['writer', 'script'], ['planner', 'plan'], ['classify', 'classify'], ['vision', 'vision'], ['transcribe', 'transcribe'], ['tts', 'tts'], ['embed', 'embed']]) {
  const saved = CFG.models[prop];
  Object.defineProperty(CFG.models, prop, {
    configurable: true,
    enumerable: true,
    get() { return providers.pickOne(task, { fallback: saved }) || saved; },
    // A legacy settings save becomes a manual routing override for the matching capability.
    // Guarded: an undefined assignment must never wipe the operator's routing choices.
    set(v) {
      if (!v) return;
      providers.saveRouting({ manual: { [providers.TASK_CAPABILITY[task] || 'llm']: v } });
    },
  });
}

// ---------- TikTok discovery ----------
// permanent search cache: L1 memory, L2 disk — every search ever made stays instant
const searchCacheFile = path.join(DATA, 'search_cache.json');
const searchCache = new Map();
try { const d = JSON.parse(fs.readFileSync(searchCacheFile, 'utf8')); for (const [k, v] of Object.entries(d)) if (Date.now() - v.ts < 7 * 864e5) searchCache.set(k, v); } catch (_) {}
function cacheSave() { try { const o = {}; for (const [k, v] of searchCache) o[k] = v; fs.writeFileSync(searchCacheFile, JSON.stringify(o)); } catch (_) {} }
function ytdlpMeta(url, timeoutSec = 80) {
  const expires=Date.now()+timeoutSec*1000;
  return metadataGate(()=>{if(Date.now()>=expires)return null;return new Promise(resolve => {
    const p = spawn(String(process.env.VS_YTDLP || (process.platform === 'win32' ? path.join(ROOT, 'tools', 'yt-dlp.exe') : 'yt-dlp')), ['-j', '--no-warnings', '--socket-timeout', '30', url], { windowsHide: true });
    let out = '';
    p.stderr.on('data',()=>{});
    p.stdout.on('data', c => out += c);
    p.on('error', () => resolve(null));
    const t = setTimeout(() => { stopTree(p); resolve(null); }, Math.max(1,expires-Date.now()));
    p.on('close', () => {
      clearTimeout(t);
      const line = out.split('\n').find(l => l.trim().startsWith('{'));
      if (!line) return resolve(null);
      try {
        const d = JSON.parse(line);
        const uid = String(d.uploader_id || d.uploader || d.channel || '').replace(/^@/, '');
        const isId = /^\d{15,25}$/.test(uid);
        resolve({
          id: String(d.id), author: uid && !isId ? uid : 'unknown', title: d.title || '', duration: Math.round(d.duration || 0),
          cover: d.thumbnail || '', play: d.url || '', plays: d.view_count || 0, likes: d.like_count || 0,
          source: d.webpage_url || (isId ? '' : 'https://www.tiktok.com/@' + uid + '/video/' + d.id),
        });
      } catch (_) { resolve(null); }
    });
  });});
}
function curlGet(url, timeoutSec = 45) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl.exe', ['-sL', '--max-time', String(timeoutSec), '-A', 'curl/8.21.0', '-H', 'Accept: */*', url], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', c => out += c); p.stderr.on('data', c => err += c);
    p.on('error', reject);
    p.on('close', code => code === 0 && out ? resolve(out) : reject(new Error('curl exit ' + code)));
  });
}
async function discoverTikTok(q) {
  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.ts < 1800e3) return cached.results;
  // ---------- discovery: DDG/Startpage → TikWM enrich → yt-dlp (fully local, no VPS) ----------
  const clean = q.replace(/[^\w\s\u0600-\u06FF]/g, ' ').trim() || q;
  const engineUrls = [
    // proven live routes (tested): DDG-html via Jina + Startpage via Jina — 3 calls total,
    // variants beyond these returned the same links (page 2 = page 1) and only added latency
    'https://r.jina.ai/' + encodeURIComponent('https://html.duckduckgo.com/html/?q=' + encodeURIComponent('site:tiktok.com ' + clean)),
    'https://r.jina.ai/https://html.duckduckgo.com/html/?q=' + encodeURIComponent('site:tiktok.com ' + clean + (/unbox/i.test(clean)?' ASMR':' review')),
    'https://r.jina.ai/https://www.startpage.com/sp/search?query=' + encodeURIComponent('site:tiktok.com ' + clean),
  ];
  const urlMap = new Map(); // id -> best full url (real username beats @i placeholder)
  const addId = (id, user) => {
    if (!/\d{15,25}/.test(id)) return;
    const prev = urlMap.get(id);
    if (!prev || (user && !prev.includes('/@'))) urlMap.set(id, 'https://www.tiktok.com/@' + (user || 'i') + '/video/' + id);
  };
  const harvest = text => {
    text = String(text || '');
    for (const m of text.matchAll(/tiktok\.com\/@([\w.\-]+)\/video\/(\d{15,25})/g)) addId(m[2], m[1]);
    for (const m of text.matchAll(/uddg=([^&\s"')]+)/g)) {
      try { const dec = decodeURIComponent(m[1]); const mm = dec.match(/tiktok\.com\/@([\w.\-]+)\/video\/(\d{15,25})/); if (mm) addId(mm[2], mm[1]); } catch (_) {}
    }
    // startpage-style bare video paths without a visible username
    for (const m of text.matchAll(/tiktok\.com\/(?:[\w.%\-\/]*?)video\/(\d{15,25})/g)) addId(m[1], null);
  };
  await Promise.allSettled(engineUrls.map(async u => {
    try { harvest(await curlGet(u, 40)); } catch (_) { try { harvest(await fetchText(u, { timeout: 40000 })); } catch (_) {} }
  }));
  if (!urlMap.size) throw new Error('No TikTok results for "' + q + '". Try different words.');
  let entries = [...urlMap.entries()].map(([id, url]) => ({ id, url })).slice(0, 40);
  let results = [];
  // enrich via TikWM with limited concurrency (their rate limit) — two passes so
  // ids that failed on rate-limit get a second chance (most recover on retry)
  const enrichOne = async entry => {
    for (const tryUrl of [entry.url, 'https://www.tiktok.com/@x/video/' + entry.id]) {
      try {
        const d = await fetchJson('https://tikwm.com/api/?url=' + encodeURIComponent(tryUrl) + '&hd=1', { timeout: 20000 }, 1);
        if (d && d.code === 0 && d.data && d.data.id) {
          const v = d.data;
          results.push({
            id: String(v.id), author: (v.author && (v.author.unique_id || v.author.nickname)) || 'unknown',
            title: v.title || '', duration: v.duration || 0, cover: v.cover || v.origin_cover || '',
            play: v.play || v.wmplay || '', plays: v.play_count || 0, likes: v.digg_count || 0,
            source: 'https://www.tiktok.com/@' + ((v.author && v.author.unique_id) || 'user') + '/video/' + v.id,
          });
          return true;
        }
        if (d && d.code !== 0 && tryUrl === entry.url) continue; // try @x fallback
        return false;
      } catch (_) { if (tryUrl !== entry.url) return false; }
    }
    return false;
  };
  // hard speed budget: the whole enrich+rescue phase must finish inside 60s so the
  // dashboard never hangs — whatever is collected by then is what ships (cache makes repeats instant)
  const deadline = Date.now() + 60000;
  for (let pass = 0; pass < 2; pass++) {
    const queue = entries.filter(e => !results.some(r => r.id === String(e.id)));
    if (!queue.length || Date.now() > deadline - 8000) break;
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (queue.length && Date.now() < deadline) {
        const e = queue.shift();
        await enrichOne(e);
        await sleep(pass === 0 ? 60 : 250);
      }
    }));
    if (results.length >= 15) break; // plenty — skip the slow retry pass
  }
  // yt-dlp rescue: "dead" for TikWM ≠ dead — pull metadata + direct play URL locally.
  // Hard-capped: this used to run up to 150s on EVERY fresh search even when TikWM
  // already gave 10+ results — that was the search slowness. Now: only when needed, 45s max.
  const missing = entries.filter(e => !results.some(r => r.id === String(e.id)));
  if (missing.length && results.length < 10 && Date.now() < deadline - 10000) {
    const mqueue = [...missing];
    const deadline2 = Date.now() + Math.min(45000, deadline - Date.now());
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (mqueue.length && Date.now() < deadline2) {
        const e = mqueue.shift();
        const m = await ytdlpMeta(e.url).catch(() => null);
        if (m && !results.some(r => r.id === m.id)) results.push(m);
      }
    }));
  }
  if (!results.length) throw new Error('Links found but data failed (TikWM hiccup). Retry.');
  // dedupe: same id twice, or same title+duration (reposts with different region ids)
  const seen = new Set();
  results = results.filter(r => {
    const k1 = r.id, k2 = (r.title || '').slice(0, 60) + '|' + r.duration;
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1); seen.add(k2); return true;
  });
  // tiles whose play URL sits on a non-expiring CDN first — they play instantly;
  // webapp-hosted ones still stream, just via the proxy's self-heal on 403
  const cdnOK = r => /tiktokcdn-us\.com|akamaized\.net|tikwm\.com/.test(r.play || '');
  results.sort((a, b) => (Number(cdnOK(b)) - Number(cdnOK(a))) || ((b.plays || 0) - (a.plays || 0)));
  searchCache.set(q, { ts: Date.now(), results });
  cacheSave();
  return results;
}

// ---------- knowledge base + memory ----------
function loadKB(brand) { try { const a = JSON.parse(fs.readFileSync(path.join(DATA, 'kb_' + brand + '.json'), 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
function saveKB(brand, arr) { fs.writeFileSync(path.join(DATA, 'kb_' + brand + '.json'), JSON.stringify(arr.slice(0, 100), null, 2)); }
function knowledgeBlock(brand) {
  const kb = loadKB(brand).filter(k => k.text && k.text.trim());
  if (!kb.length) return '';
  return '\n\n=== APPROVED KNOWLEDGE (the ONLY facts, prices, offers and links you may use — NEVER invent or replace them) ===\n'
    + kb.map((k, i) => `[${i + 1}] ${k.text}`).join('\n')
    + '\nIf a product price appears here, it is the SELLING price — use it exactly as your_price; never invent another.';
}
function memFile(brand) { return path.join(MEMORY, brand + '.json'); }
function loadMem(brand) { try { return JSON.parse(fs.readFileSync(memFile(brand), 'utf8')); } catch (_) { return { hooks_used: [], products_done: [], style_notes: [], chats: 0 }; } }
function saveMem(brand, mem) { fs.writeFileSync(memFile(brand), JSON.stringify(mem, null, 2)); }

// ---------- used-videos ledger (reuse reminders) ----------
function usedFile() { return path.join(DATA, 'used_videos.json'); }
function loadUsed() { try { return JSON.parse(fs.readFileSync(usedFile(), 'utf8')); } catch (_) { return []; } }
function saveUsed(a) { fs.writeFileSync(usedFile(), JSON.stringify(a, null, 2)); }
function usedEntry(videoId) { return loadUsed().find(v => v.id === String(videoId)); }
function markUsed(entry) {
  const a = loadUsed();
  const i = a.findIndex(v => v.id === entry.id);
  if (i >= 0) a[i] = { ...a[i], ...entry, times_used: (a[i].times_used || 0) + 1, last_used: Date.now(), uses: [...(a[i].uses || []), { ts: Date.now(), brand: entry.brand, project: entry.project || '', note: entry.note || '' }] };
  else a.push({ id: entry.id, author: entry.author || '', title: entry.title || '', times_used: 1, first_used: Date.now(), last_used: Date.now(), uses: [{ ts: Date.now(), brand: entry.brand, project: entry.project || '', note: entry.note || '' }] });
  saveUsed(a);
  return usedEntry(entry.id);
}

// ---------- shared builders ----------
const ANALYZE_PROMPT = 'You are watching raw footage that will be reused for short-form selling videos. Watch the ENTIRE video carefully and return ONLY JSON:\n{"scene_descriptions_text":"0:00-0:05 what is literally seen | 0:05-0:10 what is seen | ... every scene with timestamps","mood":"pace and vibe","product_visible":"the product/subject on screen","product_first_appearance_sec":0,"suggested_product":"ONLY the product name itself, maximum 4 words, like "DJI Mini 3" — NEVER a sentence","suggested_category":"product category, 1-2 words","visible_condition":"the physical state of the product: new/sealed, open-box, used, scratched — only what you SEE","visible_text":["any text visible ON the product or packaging"],"model_year_hint":"the apparent model/generation if visually determinable, else null","selling_angle":"one punchy line: the single most sellable angle of this exact footage","emotional_hooks":["clickbait hook angle 1","hook 2","hook 3"],"key_moments":["0:02","0:08"],"visual_notes":"lighting, quality, anything a seller should exploit"}\nDescribe EXACTLY what happens with timestamps — the script writer treats this as ground truth and narrates what the viewer sees. Then find how this footage can SELL.\nIMPORTANT: report the duration as you perceived it (length of narrated content vs visual content) in visual_notes, e.g. "60s of footage, all visual, no speech".';
function params_model(m) { return providers.find(m) ? m : null; }
async function makeTTSFile(brandKey, text, voice, rate) {
  // Owner rule (2026-09-23) + n8n parity: the ONLY voice is Kore — all 7 production workflows
  // hardcode voiceName "Kore". Pinned at the single synthesis chokepoint so NO caller (brand
  // config, page profile, tool arg) can route Puck/Charon/Fenrir/Algenib/Aoede/Iapetus.
  const v = 'Kore';
  const models = routeCandidates('tts', params_model(CFG.models.tts)).list;
  const campaignVoice = profileFor(brandKey);
  const language = campaignVoice?.accent || (brandKey === 'studio' ? 'authentic everyday Moroccan Darija with a Moroccan accent' : null);
  const dialect = (language || 'script language') + '|exciting-marketing-v5-structured';
  const deliveryStyle = `Exciting, charismatic product marketing in ${language || 'the transcript language'}. Lively, smiling, expressive intonation and punchy emphasis. Clear medium pace with brief purposeful pauses. Engaging and confident without shouting, sleepy delivery, rushed words or filler.`;
  const speechPrompt = dialect ? 'Perform the following exact script as an EXCITING, charismatic marketing creator speaking ' + language + '. Strong lively energy from the first word, smiling voice, punchy emphasis and expressive rising and falling intonation. Make the opening grab attention and the final invitation motivating. This is a confident, engaging product video: do not sound sleepy, restrained, solemn, flat or like a newsreader. Maintain a clear medium speaking pace, never rush the words; use short purposeful pauses, not long breaks. Be enthusiastic without shouting, fake laughter, added filler or invented words. Keep Kore consistent throughout. Use only the requested language and accent. Do not translate, paraphrase, add words or read these directions aloud.\n\nText to speak:\n' + text : text;
  const file = path.join(CACHE, 'tts_' + hash(brandKey + '|' + dialect + '|' + models.join('>') + '|' + v + '|' + (rate || 1) + '|' + text) + '.wav');
  if (fs.existsSync(file)) return '/media/' + path.basename(file);
  // TTS models come from the router (Google only for now) — no hard-coded model id here
  let audio = null; const errs = [];
  for (const m of models) {
    try { audio = await gemAudio(m, /gemini-3\.8.*tts/i.test(m) ? text : speechPrompt, v, rate, 'tts', deliveryStyle); break; }
    catch (e) { errs.push(m + ': ' + redact(e.message)); log('[tts]', errs[errs.length - 1]); }
  }
  // Surface EVERY attempted voice model, not just the last: with three TTS models on tiny free
  // daily quotas, 'the last one got a 429' hides that the day's voice budget is simply spent.
  if (!audio) throw new Error(errs.length > 1
    ? 'TTS failed on all ' + errs.length + ' configured voice models (likely the daily voice quota is spent): ' + errs.join(' | ')
    : 'TTS failed: ' + (errs[0] || 'no voice model configured'));
  if (audio.toString('ascii',0,4) === 'RIFF' && audio.toString('ascii',8,12) === 'WAVE') {
    fs.writeFileSync(file,audio); return '/media/' + path.basename(file);
  }
  const sampleRate = Number(/rate=(\d+)/i.exec(audio.mimeType || '')?.[1]) || 24000;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + audio.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sampleRate, 24); hdr.writeUInt32LE(sampleRate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(audio.length, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, audio]));
  return '/media/' + path.basename(file);
}
async function makeScript(brandKey, o) {
  const brand = CFG.brands[brandKey];
  const mem = loadMem(brandKey);
  const model = o.model || CFG.models.writer;
  const tone = o.tone ? `\n\nTONE OVERRIDE: write with this tone: ${o.tone}` : '';
  const extraLang = o.language ? `\n\nLANGUAGE OVERRIDE: ${o.language}` : '';
  const vars = {
    product: o.product || '', category: o.category || '', brand: o.brand_name || brand.label,
    duration: o.duration || '30-40 seconds', research: o.research || null,
    recent_hooks: mem.hooks_used.slice(-8).join(' | ') || 'none yet',
    scene_descriptions_text: o.scene_descriptions_text || 'No scene descriptions available',
    product_first_appearance_sec: o.product_first_appearance_sec || 'unknown',
  };
  let research = vars.research;
  if (!research) {
    const rText = await gemText(model, fillTemplate(brand.researcher_prompt, vars) + knowledgeBlock(brandKey) + '\n\nReturn ONLY the JSON object.');
    research = extractJSON(rText);
    if (!research) throw new Error('Researcher returned unparsable output');
  }
  const styleNotes = mem.style_notes.length ? '\n\nOWNER INSTRUCTIONS (must follow):\n' + mem.style_notes.map(s => '- ' + s).join('\n') : '';
  let ground = '';
  if (o.analysis) {
    const a = o.analysis;
    const hooks = Array.isArray(a.emotional_hooks) && a.emotional_hooks.length ? '\nClickbait hook angles (pick the strongest): ' + a.emotional_hooks.join(' | ') : '';
    const moments = Array.isArray(a.key_moments) && a.key_moments.length ? '\nBest moments to reference: ' + a.key_moments.join(', ') : '';
    ground = '\n\n=== WHAT THE VIDEO SHOWS (ground truth — this is the EXACT footage the voiceover will ride. Narrate what the viewer sees, moment by moment. NEVER invent scenes that are not here) ===\n'
      + 'Scenes: ' + (a.scene_descriptions_text || 'n/a')
      + '\nMood: ' + (a.mood || 'n/a') + ' | On screen: ' + (a.product_visible || 'n/a') + ' | Product appears at: ' + (a.product_first_appearance_sec !== undefined ? a.product_first_appearance_sec + 's' : 'unknown')
      + '\nSelling angle: ' + (a.selling_angle || 'n/a') + hooks + moments
      + '\nMission: grab in the first 2 seconds, ride the footage beat by beat, sell the product HARD, end with a CTA.';
  }
  const wText = await gemText(model, fillTemplate(brand.writer_prompt, vars) + ground + knowledgeBlock(brandKey) + styleNotes + tone + extraLang + '\n\nReturn ONLY the JSON object.', 'script');
  const script = extractJSON(wText);
  if (!script) throw new Error('Writer returned unparsable output');
  mem.hooks_used.push((script.hook_style_used || 'unknown') + ': ' + ((script.sentences && script.sentences[0]) || script.title_arabic || '').slice(0, 120));
  mem.hooks_used = mem.hooks_used.slice(-40);
  if (o.product && !mem.products_done.includes(o.product)) mem.products_done.push(o.product);
  saveMem(brandKey, mem);
  return { research, script };
}
function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*\$json\.([a-zA-Z0-9_]+)(?:\.([a-zA-Z0-9_]+))?\s*(?:\|\|\s*"([^"]*)")?\s*\}\}/g, (m, a, b, def) => {
    let v = b !== undefined ? (vars[a] && vars[a][b]) : vars[a];
    if (v === undefined || v === null || v === '') v = def !== undefined ? def : '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// ---------- routes ----------
const routes = {};
const facebookReconnect = require('./lib/facebook-reconnect').createFacebookReconnect({ file: path.join(DATA, 'fb_config.json') });
routes['/api/v2/facebook/reconnect'] = async (req, res) => {
  if (req.method !== 'POST') return j(res, 405, { error: 'POST required' });
  const origin = req.headers.origin;
  if (origin && origin !== 'http://' + req.headers.host) return j(res, 403, { error: 'Use the local studio connection form.' });
  try {
    const input = await readJson(req);
    j(res, 200, await facebookReconnect.reconnect(input.token, input.page));
  } catch (e) { j(res, 400, { error: e.message, code: e.code || null, subcode: e.subcode || null }); }
};
routes['/api/brands'] = async (req, res) => {
  j(res, 200, { brands: Object.entries(CFG.brands).map(([k, b]) => ({ key: k, label: b.label, color: b.color, lang: b.lang, voice: b.voice, terms: b.terms || [] })) });
};
routes['/api/search'] = async (req, res, u) => {
  const q = (u.searchParams.get('q') || '').trim();
  if (!q) return j(res, 400, { error: 'missing q' });
  try { j(res, 200, { results: await discoverTikTok(q) }); } catch (e) { j(res, 502, { error: e.message }); }
};
routes['/api/script'] = async (req, res) => {
  const b = await readJson(req);
  if (!CFG.brands[b.brand]) return j(res, 400, { error: 'unknown brand' });
  try { j(res, 200, await makeScript(b.brand, b)); } catch (e) { j(res, 502, { error: e.message }); }
};
routes['/api/tts'] = async (req, res) => {
  const b = await readJson(req);
  const text = (b.text || '').trim();
  if (!text) return j(res, 400, { error: 'no text' });
  try { j(res, 200, { url: await makeTTSFile(b.brand, text, b.voice, b.rate) }); } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- Gemini voices / models ----------
// Owner rule (2026-09-23): the ONLY voice is Kore (n8n parity — every production workflow
// hardcodes voiceName "Kore"). The old 12-voice picker list is gone; even the advertised list
// must not offer Puck/Charon/Fenrir/Algenib/Aoede/Iapetus.
const VOICES = ['Kore'];
// ---------- live model list from Google (Gemini + Gemma, everything) ----------
let modelCache = { ts: 0, models: [], tts: [] };
routes['/api/models'] = async (req, res, u) => {
  const refresh = u && u.searchParams.get('refresh');
  if (!refresh && Date.now() - modelCache.ts < 10 * 60e3 && modelCache.models.length) return j(res, 200, { models: modelCache.models, tts: modelCache.tts });
  let out = [];
  for (let attempt = 0; attempt < 3 && !out.length; attempt++) {
    try {
      const d = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${providers.keyFor('google')}`, { timeout: 20000 }, 2);
      out = (d.models || []).map(m => ({
        name: String(m.name || '').replace(/^models\//, ''),
        display: m.displayName || '',
        methods: m.supportedGenerationMethods || [],
      }));
    } catch (e) { await sleep(1000); }
  }
  if (!out.length && modelCache.models.length) return j(res, 200, { models: modelCache.models, tts: modelCache.tts, stale: true });
  if (!out.length) return j(res, 502, { error: 'could not fetch model list from Google' });
  const BAD = /embedding|aqa|imagen|lyria|tts|image|banana|robotics|computer-use|antigravity|deep-research|transcribe|omni|veo|live|audio/i;
  const models = out.filter(m => m.methods.includes('generateContent') && !BAD.test(m.name)).map(m => m.name);
  const tts = out.filter(m => /tts/i.test(m.name)).map(m => m.name);
  modelCache = { ts: Date.now(), models, tts };
  j(res, 200, { models, tts });
};
// ---------- v2 settings: providers, models, routing (secrets stay server-side) ----------
routes['/api/v2/settings'] = (req, res) => j(res, 200, providers.publicSettings());
routes['/api/v2/settings/provider'] = async (req, res) => {
  const b = await readJson(req);
  if (!b.id) return j(res, 400, { error: 'provider id required' });
  const allowed = ['name', 'enabled', 'baseUrl', 'keyMode', 'apiKey', 'timeoutMs', 'retry', 'rateLimit'];
  const patch = {};
  for (const k of allowed) if (k in b) patch[k] = b[k];
  if ('baseUrl' in patch && !/^https:\/\//i.test(String(patch.baseUrl))) return j(res, 400, { error: 'baseUrl must be an https URL' });
  if ('timeoutMs' in patch) patch.timeoutMs = Math.min(600000, Math.max(5000, Number(patch.timeoutMs) || 150000));
  if ('keyMode' in patch) patch.keyMode = ['single', 'credentials'].includes(patch.keyMode) ? patch.keyMode : 'pool';
  if ('apiKey' in patch) patch.apiKey = String(patch.apiKey || '').trim().slice(0, 300);
  providers.saveProvider(b.id, patch);
  j(res, 200, { ok: true, provider: providers.publicSettings().providers[b.id] });
};
routes['/api/v2/settings/model'] = async (req, res) => {
  const b = await readJson(req);
  try { const m = providers.saveModel(b.model || b); j(res, 200, { ok: true, model: providers.publicSettings().models.find(x => x.id === m.id) }); }
  catch (e) { j(res, 400, { error: e.message }); }
};
routes['/api/v2/settings/model/delete'] = async (req, res) => {
  const b = await readJson(req);
  if (!b.id) return j(res, 400, { error: 'id required' });
  j(res, 200, { ok: true, ...providers.deleteModel(b.id) });
};
// ---------- multiple credential configurations per provider ----------
// For legitimate workload/project separation and failover. Selection never rotates around a
// spent quota: credentialPick() returns nothing when every enabled credential is exhausted, and
// the request then declines instead of quietly working around the limit.
routes['/api/v2/settings/credential'] = async (req, res) => {
  const b = await readJson(req);
  try { j(res, 200, { ok: true, credential: providers.saveCredential(b.credential || b) }); }
  catch (e) { j(res, 400, { error: e.message }); }
};
routes['/api/v2/settings/credential/delete'] = async (req, res) => {
  const b = await readJson(req);
  if (!b.id) return j(res, 400, { error: 'id required' });
  j(res, 200, { ok: true, ...providers.deleteCredential(b.id) });
};
routes['/api/v2/settings/policy'] = async (req, res) => {
  const b = await readJson(req);
  try {
    const policy = providers.setPolicy(b.policy);
    // show the owner what the policy actually did to routing, not just that it was stored
    const preview = {};
    for (const task of ['classify', 'reply', 'plan_simple', 'plan', 'vision', 'transcribe', 'tts']) {
      const r = providers.pick(task);
      preview[task] = { workload: r.workload, first: r.candidates[0] || null, spared: r.skipped.length };
    }
    j(res, 200, { ok: true, policy, preview });
  } catch (e) { j(res, 400, { error: e.message }); }
};
routes['/api/v2/settings/routing'] = async (req, res) => {
  const b = await readJson(req);
  j(res, 200, { ok: true, routing: providers.saveRouting(b) });
};
routes['/api/v2/settings/page'] = async (req, res) => {
  const b = await readJson(req);
  const key = String(b.page || '').replace(/[^a-z0-9_]/gi, '');
  if (!key) return j(res, 400, { error: 'page required' });
  j(res, 200, { ok: true, page: providers.savePageRouting(key, b.models || {}) });
};
/** Router preview — answers "which model would run this task, and why" without spending quota. */
routes['/api/v2/router/plan'] = (req, res, u) => {
  const task = u.searchParams.get('task') || 'plan';
  const page = (u.searchParams.get('page') || '').replace(/[^a-z0-9_]/gi, '') || null;
  j(res, 200, providers.pick(task, { page }));
};
routes['/api/v2/settings/discover'] = async (req, res) => {
  try {
    const live = await discoverModels();
    const ids = new Set(live.map(x => x.id));
    let matched = 0;
    for (const m of providers.models()) if (ids.has(m.id)) { providers.setVerified(m.id, true); matched++; }
    j(res, 200, { ok: true, discovered: live.length, matchedToCatalog: matched, models: live.slice(0, 400) });
  } catch (e) { j(res, 502, { error: 'model discovery failed: ' + e.message }); }
};
/** TEST PROVIDER — the smallest legitimate request: list the provider's models. No quota cost. */
routes['/api/v2/settings/provider/test'] = async (req, res) => {
  const b = await readJson(req);
  const id = b.id || 'google';
  const p = providers.settings.providers[id];
  if (!p) return j(res, 404, { error: 'unknown provider ' + id });
  const kc = providers.keyContext(id);
  if (!kc) {
    const why = p.keyMode === 'credentials'
      ? 'every enabled credential for ' + id + ' is spent or cooling down (add one, or wait for the cooldown)'
      : 'no API key configured';
    return j(res, 400, { error: why, hint: p.keyMode === 'credentials' ? undefined : 'add keys to data/gemini_keys.txt or set a single key here' });
  }
  const key = kc.key;
  const started = Date.now();
  try {
    const r = await fetch(`${p.baseUrl}/models?pageSize=1&key=${key}`, { signal: AbortSignal.timeout(20000) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 200) {
      if (kc.credential) providers.recordCredential(kc.credential, { status: 'ok' });
      return j(res, 200, { ok: true, message: 'connection successful', latencyMs: Date.now() - started, keyMasked: providers.maskPublic(key), credential: kc.credential || null, keySource: kc.source, modelsReachable: (body.models || []).length });
    }
    const msg = (body.error && body.error.message) || ('HTTP ' + r.status);
    const kind = r.status === 401 || r.status === 403 ? 'invalid key' : r.status === 429 ? 'quota exceeded' : 'provider refused the request';
    if (kc.credential) providers.recordCredential(kc.credential, { status: r.status === 429 ? 'rate_limited' : 'error', error: kind, rateLimited: r.status === 429, retryAfterMs: 60e3 });
    return j(res, 200, { ok: false, error: kind, detail: msg, status: r.status, latencyMs: Date.now() - started, credential: kc.credential || null, keySource: kc.source });
  } catch (e) {
    const net = /timeout|abort/i.test(e.message) ? 'network failure (timeout)' : /ENOTFOUND|EAI_AGAIN|fetch failed/i.test(e.message) ? 'invalid base URL or no network' : e.message;
    if (kc.credential) providers.recordCredential(kc.credential, { status: 'error', error: net });
    j(res, 200, { ok: false, error: net, detail: e.message });
  }
};
/** TEST MODEL — one tiny request. TTS audio is only generated when explicitly asked for. */
routes['/api/v2/settings/model/test'] = async (req, res) => {
  const b = await readJson(req);
  const m = providers.find(b.id);
  if (!m) return j(res, 404, { error: 'unknown model ' + b.id });
  const cap = (m.capabilities || [])[0];
  const started = Date.now();
  try {
    if (cap === 'tts' && !b.audio) {
      return j(res, 200, { ok: true, skipped: 'TTS test needs audio:true to avoid spending quota on a test', model: m.id });
    }
    if (cap === 'tts') {
      const buf = await gemAudio(m.id, 'ok', 'Kore', 1, 'tts');
      providers.setVerified(m.id, true);
      return j(res, 200, { ok: true, message: 'TTS produced ' + buf.length + ' bytes of audio', bytes: buf.length, latencyMs: Date.now() - started, model: m.id });
    }
    const parts = await gemini(m.id, { contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }], generationConfig: { maxOutputTokens: 8 }, ...(cap === 'embedding' ? {} : {}) }, 'classify');
    providers.setVerified(m.id, true);
    j(res, 200, { ok: true, message: 'model answered', sample: parts.map(x => x.text || '').join('').slice(0, 80), latencyMs: Date.now() - started, model: m.id });
  } catch (e) {
    const msg = e.message;
    const kind = isQuota(msg) ? 'quota exceeded / rate limited' : /not found|404|NOT_FOUND|unsupported/i.test(msg) ? 'model unavailable for this API version' : msg.slice(0, 200);
    j(res, 200, { ok: false, error: kind, detail: msg.slice(0, 300), model: m.id });
  }
};

// ---------- CONTROL CENTER: key-pool management, gated reveal, page recipes ----------
// Pool keys live in data/gemini_keys.txt (one per line; health-aware fair allocation). The
// Settings UI manages that pool through the routes below. Every listing response is MASKED;
// the only way a full key ever leaves this process is the explicit per-key reveal route,
// which exists for the local Settings UI and is never logged.
const KEY_FILE = path.join(DATA, 'gemini_keys.txt');
const keyMaskOf = k => { const s = String(k || ''); return !s ? '' : s.length <= 8 ? '••••' + s.slice(-2) : s.slice(0, 6) + '••••••••' + s.slice(-4); };
function readKeyPool() {
  try { return fs.readFileSync(KEY_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  catch (_) { return []; }
}
function writeKeyPool(list) {
  fs.writeFileSync(KEY_FILE, list.join('\n') + (list.length ? '\n' : ''));
  KEYS.length = 0; for (const k of list) KEYS.push(k);   // refresh the live pool the router reads
}
/** Real, lightweight key check: list the provider's models with THIS key. No quota spend. */
async function testKeyLive(key) {
  const p = providers.settings.providers.google;
  const started = Date.now();
  try {
    const r = await fetch(`${p.baseUrl}/models?pageSize=1&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) });
    const body = await r.json().catch(() => ({}));
    const ms = Date.now() - started;
    if (r.status === 200) return { ok: true, status: 'READY', scope:'Models endpoint authentication only; generation quota is not verified', latencyMs: ms, modelsReachable: (body.models || []).length };
    const msg = (body.error && body.error.message) || ('HTTP ' + r.status);
    if (r.status === 400 && /API key not valid/i.test(msg)) return { ok: false, status: 'INVALID', detail: msg, latencyMs: ms };
    if (r.status === 401 || r.status === 403) return { ok: false, status: /suspended|disabled|blocked/i.test(msg) ? 'SUSPENDED' : 'INVALID', detail: msg, latencyMs: ms };
    if (r.status === 429) return { ok: false, status: /day|daily|per day/i.test(msg) ? 'DAILY QUOTA EXHAUSTED' : 'RATE LIMITED', detail: msg, latencyMs: ms };
    return { ok: false, status: 'PROVIDER ERROR', detail: msg, latencyMs: ms };
  } catch (e) {
    return { ok: false, status: 'PROVIDER ERROR', detail: /timeout|abort/i.test(e.message) ? 'network timeout' : e.message };
  }
}
routes['/api/v2/provider-usage'] = (req,res)=>j(res,200,providers.poolHealth.inspect());
routes['/api/v2/keys'] = async (req, res, u, method) => {
  if (method === 'GET') {
    const list = readKeyPool();
    return j(res, 200, {
      keyFile: 'data/gemini_keys.txt',
      provider: 'google',
      keys: list.map((k, i) => ({ id: 'pool-' + i, index: i, masked: keyMaskOf(k), label: 'Pool key ' + (i + 1) })),
    });
  }
  const b = await readJson(req);
  const act = String(b.action || '');
  const list = readKeyPool();
  if (act === 'add') {
    const key = String(b.key || '').trim();
    if (!key || key.length < 20 || /\s/.test(key)) return j(res, 400, { error: 'that does not look like an API key' });
    if (list.includes(key)) return j(res, 400, { error: 'this key is already in the pool (' + keyMaskOf(key) + ')' });
    const test = await testKeyLive(key);
    if (!test.ok && ['INVALID','SUSPENDED'].includes(test.status)) return j(res, 200, { ok: false, added: false, ...test });
    list.push(key); writeKeyPool(list);
    return j(res, 200, { ok: true, added: true, saved: true, tested: test, masked: keyMaskOf(key) });
  }
  const idx = Number(b.index);
  if (act !== 'test_all' && (!Number.isInteger(idx) || idx < 0 || idx >= list.length)) return j(res, 404, { error: 'no such pool key' });
  if (act === 'test') {const check=await testKeyLive(list[idx]);providers.poolHealth.probe(list[idx],check);return j(res,200,{...check,detail:check.detail?redact(check.detail):undefined,masked:keyMaskOf(list[idx])});}
  if (act === 'test_all') {
    const results = [];
    for (let i = 0; i < list.length; i++) {const check=await testKeyLive(list[i]);providers.poolHealth.probe(list[i],check);results.push({index:i,masked:keyMaskOf(list[i]),...check,detail:check.detail?redact(check.detail):undefined});}
    return j(res, 200, { ok: true, results });
  }
  if (act === 'reveal') return j(res, 200, { ok: true, index: idx, key: list[idx] });   // explicit local action only; never logged
  if (act === 'delete') {
    const removed = list.splice(idx, 1)[0];
    writeKeyPool(list);
    return j(res, 200, { ok: true, removedMasked: keyMaskOf(removed), remaining: list.length });
  }
  return j(res, 400, { error: 'unknown action' });
};
/** Reveal a REGISTERED credential's own key — same gated rule as the pool reveal. */
routes['/api/v2/settings/credential/reveal'] = async (req, res) => {
  const b = await readJson(req);
  const c = (providers.settings.credentials || []).find(x => x.id === b.id);
  if (!c || !c.key) return j(res, 404, { error: 'no stored key for that credential' });
  j(res, 200, { ok: true, id: c.id, key: c.key });   // explicit local action only; never logged
};
/** PAGE RECIPES — the 7 n8n-derived production contracts, view-only. What to do per page,
 *  separate from which MODEL does it (that is routing, not a recipe). Never a chat here. */
routes['/api/v2/recipes'] = (req, res) => {
  const pw = require('./lib/page-writers');
  const pages = studio.store.pages();
  const byKey = Object.fromEntries(pages.map(p => [p.key, p]));
  const clip = (v, n) => Array.isArray(v) ? v.slice(0, n).map(x => String(x)) : v ? [String(v)] : [];
  const recipes = Object.entries(pw.WRITERS).map(([key, w]) => {
    const pg = byKey[key] || {};
    return {
      key,
      name: (pg.label || key).split('—').pop().trim(),
      language: w.language || '', outputLang: w.outputLang || '', publishLang: w.publishLang || '',
      audience: w.audience || '', identity: w.identity || '', landingPage: w.landingPage || '',
      structure: pw.SHARED.sequence || '', hookRule: pw.SHARED.hookRule || '',
      currency: w.currency || '', wasWord: w.wasWord || '', titleField: w.titleField || '',
      sourcingAngles: clip(w.sourcingAngles, 8), urgency: clip(w.urgency, 4),
      engagement: clip(w.engagement, 4), banned: clip(w.banned, 8),
      surveyFraming: clip(w.surveyFraming, 2),
      destinations: (pg.pageIds || []).map(d => ({ name: d.name, id: String(d.id || '').slice(0, 6) + '…' })),
      voice: pg.voice || '', captionStyle: (pg.prefs && pg.prefs.textStyle) || null,
      musicStyle: (pg.prefs && pg.prefs.musicStyle) || '', cta: (pg.prefs && pg.prefs.cta) || '',
    };
  });
  j(res, 200, { recipes, shared: { sequence: pw.SHARED.sequence, priceRules: pw.SHARED.priceRules, cleanNameRule: pw.SHARED.cleanNameRule } });
};

routes['/api/settings'] = async (req, res, u, method) => {
  if (method === 'GET') {
    return j(res, 200, {
      models: CFG.models, voices: VOICES,
      renderEndpoints: CFG.render_endpoints || {},
      defaultTemplate: CFG.default_template || '',
    });
  }
  const b = await readJson(req);
  if (b.models) { CFG.models = { ...CFG.models, ...b.models }; }
  if (b.renderEndpoints) CFG.render_endpoints = { ...CFG.render_endpoints, ...b.renderEndpoints };
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(CFG, null, 2));
  j(res, 200, { ok: true });
};

// ---------- FB pages ----------
routes['/api/pages'] = async (req, res) => {
  const c = FBCFG();
  j(res, 200, { pages: c.pages.map(p => ({ id: p.id, name: p.name, category: p.category, brand: p.brand || '' })) });
};
routes['/api/pages/map'] = async (req, res) => {
  const b = await readJson(req);
  const c = FBCFG();
  const p = c.pages.find(x => x.id === b.id);
  if (p) { p.brand = b.brand || ''; saveFBCFG(c); }
  j(res, 200, { ok: true });
};
routes['/api/publish'] = async (req, res) => {
  if(readJsonOrCreate(path.join(DATA,'studio','publish-hold.json'),{enabled:true},'publish-hold.json').enabled!==false)return j(res,409,{error:'Owner requested tests only; publishing is paused.'});
  const b = await readJson(req);
  const f = path.join(PROJECTS, path.basename(b.projectId || '') + '.json');
  if (!fs.existsSync(f)) return j(res, 404, { error: 'project not found' });
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = FBCFG();
  const results = [];
  for (const t of (b.targets || [])) {
    const page = c.pages.find(x => x.id === t.page_id);
    if (!page || !page.page_token) { results.push({ target: t.platform, page: t.page_id, ok: false, error: 'page not found/token missing' }); continue; }
    const videoFile = p.rendered_file ? path.join(MEDIA, path.basename(p.rendered_file)) : null;
    if (!videoFile || !fs.existsSync(videoFile)) { results.push({ target: t.platform, page: page.name, ok: false, error: 'no rendered video attached to project' }); continue; }
    try {
      const desc = (t.description || p.caption || '').slice(0, 5000);
      const form = new FormData();
      form.append('source', new Blob([fs.readFileSync(videoFile)]), path.basename(videoFile));
      form.append('description', desc);
      const r = await fetch(`${`https://graph.facebook.com/${APPV}`}/${page.id}/videos`, { method: 'POST', headers: { Authorization: 'OAuth ' + page.page_token }, body: form, signal: AbortSignal.timeout(600000) });
      const out = await r.json();
      if (out.id) { results.push({ target: t.platform, page: page.name, ok: true, post_id: out.id }); }
      else results.push({ target: t.platform, page: page.name, ok: false, error: out.error ? out.error.message : JSON.stringify(out).slice(0, 200) });
    } catch (e) { results.push({ target: t.platform, page: page.name, ok: false, error: e.message }); }
  }
  p.status = results.every(r => r.ok) ? 'published' : (results.some(r => r.ok) ? 'partially_published' : 'publish_failed');
  p.publish_results = results;
  p.published_at = Date.now();
  // record live-tracked post refs for the stats engine
  p.posts = [...(p.posts || []), ...results.filter(r => r.ok).map(r => ({ platform: 'facebook', page_id: (c.pages.find(x => x.name === r.page) || {}).id || '', page: r.page, post_id: r.post_id, published_at: Date.now() }))];
  fs.writeFileSync(f, JSON.stringify(p, null, 2));
  if (p.video && p.video.id) markUsed({ id: p.video.id, author: p.video.author, title: p.video.title, brand: p.brand, project: p.id, note: 'published ' + results.filter(r => r.ok).map(r => r.page).join(',') });
  j(res, 200, { ok: results.some(r => r.ok), results, status: p.status });
};

// ---------- download + watch (vision) ----------
async function downloadVideo(url) {
  const id = 'vid_' + hash(url);
  const file = path.join(MEDIA, id + '.mp4');
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) return file;
  await new Promise((resolve, reject) => {
    const p = spawn('curl.exe', ['-sL', '--max-time', '180', '-o', file, '-A', UA, url], { windowsHide: true });
    p.on('error', reject);
    p.on('close', code => code === 0 && fs.existsSync(file) && fs.statSync(file).size > 10000 ? resolve() : reject(new Error('download failed ' + code)));
  });
  return file;
}
routes['/api/download'] = async (req, res) => {
  const b = await readJson(req);
  if (!b.url) return j(res, 400, { error: 'no url' });
  try { const f = await downloadVideo(b.url); j(res, 200, { file: path.basename(f), url: '/file/' + path.basename(f), size: fs.statSync(f).size }); }
  catch (e) { j(res, 502, { error: e.message }); }
};
routes['/api/analyze'] = async (req, res) => {
  const b = await readJson(req);
  const f = path.join(MEDIA, path.basename(b.file || ''));
  if (!fs.existsSync(f)) return j(res, 404, { error: 'download the video first' });
  const buf = fs.readFileSync(f);
  if (buf.length > 18e6) return j(res, 413, { error: 'video too large for inline analysis (' + Math.round(buf.length / 1e6) + 'MB). Use one under ~18MB or trim.' });
  try {
    const analysis = await gemVision(CFG.models.vision, ANALYZE_PROMPT, buf, 'video/mp4', 'vision');
    const parsed = extractJSON(analysis);
    j(res, 200, { analysis: parsed || { scene_descriptions_text: analysis.slice(0, 1500) } });
  } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- render (Modal, with cards) ----------
routes['/api/render'] = async (req, res) => {
  const b = await readJson(req);
  const f = path.join(PROJECTS, path.basename(b.projectId || '') + '.json');
  if (!fs.existsSync(f)) return j(res, 404, { error: 'project not found' });
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  const brand = p.brand || b.brand || '';
  const endpoints = CFG.render_endpoints || {};
  const base = endpoints[brand];
  if (!base) return j(res, 400, { error: 'no render endpoint configured for brand ' + brand + ' (add it in Settings)' });
  const videoFile = p.video_file ? path.join(MEDIA, path.basename(p.video_file)) : (b.videoFile ? path.join(MEDIA, path.basename(b.videoFile)) : null);
  if (!videoFile || !fs.existsSync(videoFile)) return j(res, 400, { error: 'no downloaded video for this project' });
  try {
    const videoBuf = fs.readFileSync(videoFile);
    const ttsFile = b.ttsFile ? path.join(CACHE, path.basename(b.ttsFile)) : null;
    const ttsBuf = ttsFile && fs.existsSync(ttsFile) ? fs.readFileSync(ttsFile) : null;
    const tpl = b.template || CFG.default_template || {};
    const fbCard = (CFG.brands[brand] && CFG.brands[brand].cards && CFG.brands[brand].cards.fb) || tpl.fb_card || '';
    const igCard = (CFG.brands[brand] && CFG.brands[brand].cards && CFG.brands[brand].cards.ig) || tpl.ig_card || '';
    const payload = {
      video_b64: videoBuf.toString('base64'),
      tts_b64: ttsBuf ? ttsBuf.toString('base64') : undefined,
      music_url: b.musicUrl || (tpl.music_url || '') || (CFG.brands[brand] && CFG.brands[brand].music_url) || '',
      card_url: fbCard,
      tts_duration_sec: b.ttsDurationSec || 0,
      title: b.title || (p.script && (p.script.title_arabic || p.script.title_darija)) || '',
      sentences: b.sentences || (p.script && p.script.sentences) || [],
      burned_subs: b.burned_subs !== undefined ? !!b.burned_subs : true,
      template: tpl.name || 'default',
    };
    const r = await fetch(base + '/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(600000) });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('video') || ct.includes('octet-stream')) {
      const buf = Buffer.from(await r.arrayBuffer());
      const out = path.join(MEDIA, 'render_' + p.id + '.mp4');
      fs.writeFileSync(out, buf);
      p.rendered_file = path.basename(out);
      p.status = 'rendered';
      fs.writeFileSync(f, JSON.stringify(p, null, 2));
      return j(res, 200, { ok: true, file: p.rendered_file, url: '/file/' + p.rendered_file, size: buf.length });
    }
    const out = await r.json().catch(() => ({}));
    return j(res, 502, { error: 'render service responded: ' + JSON.stringify(out).slice(0, 300) });
  } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- templates ----------
routes['/api/templates'] = async (req, res, u, method) => {
  if (method === 'GET') {
    const list = fs.readdirSync(TEMPLATES).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, '') }));
    const builtins = [
      { name: 'clean', fb_card: '', ig_card: '', music_url: '', burned_subs: true },
      { name: 'product_focus', fb_card: '', ig_card: '', music_url: '', burned_subs: true },
    ];
    const custom = list.map(n => JSON.parse(fs.readFileSync(path.join(TEMPLATES, n.name + '.json'), 'utf8')));
    return j(res, 200, { templates: [...builtins, ...custom] });
  }
  const b = await readJson(req);
  if (!b.name) return j(res, 400, { error: 'name required' });
  const t = { name: String(b.name).slice(0, 40), fb_card: b.fb_card || '', ig_card: b.ig_card || '', music_url: b.music_url || '', burned_subs: !!b.burned_subs, notes: b.notes || '' };
  fs.writeFileSync(path.join(TEMPLATES, t.name + '.json'), JSON.stringify(t, null, 2));
  j(res, 200, { ok: true });
};
routes['/api/template'] = async (req, res, u) => {
  const name = u.searchParams.get('name');
  const f = path.join(TEMPLATES, path.basename(name || '') + '.json');
  if (!fs.existsSync(f)) return j(res, 404, { error: 'not found' });
  fs.unlinkSync(f);
  j(res, 200, { ok: true });
};

// ---------- used videos ----------
routes['/api/used'] = async (req, res, u, method) => {
  const list = loadUsed();
  if (method === 'DELETE') {
    const id = u.searchParams.get('id');
    saveUsed(loadUsed().filter(v => v.id !== id));
    return j(res, 200, { ok: true });
  }
  const withReminder = list.map(v => ({ ...v, warning: v.times_used >= 1 ? '⚠️ already used ' + v.times_used + '× (last: ' + new Date(v.last_used).toLocaleString() + ')' : '' }));
  j(res, 200, { used: withReminder });
};

// ---------- live stats: posts + pages (never throws) ----------
let statsCache = { ts: 0, data: null };
async function statsData(force) {
  if (!force && statsCache.data && Date.now() - statsCache.ts < 60e3) return statsCache.data;
  const c = FBCFG();
  const token = id => (c.pages.find(x => x.id === id) || {}).page_token;
  // gather published post refs from all projects
  const posts = [];
  try {
    for (const f of fs.readdirSync(PROJECTS).filter(f => f.endsWith('.json'))) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECTS, f), 'utf8'));
        for (const post of (p.posts || [])) posts.push({ ...post, project: p.id, product: p.product || '' });
      } catch (_) {}
    }
  } catch (_) {}
  const [postStats, pageStats] = await Promise.all([
    Promise.all(posts.map(async post => {
      try {
        const t = token(post.page_id);
        if (!t) throw new Error('no page token');
        const d = await fetchJson(`https://graph.facebook.com/${APPV}/${post.post_id}?fields=id,permalink_url,created_time,likes.summary(true),comments.summary(true),views&access_token=${t}`, { timeout: 15000 }, 1);
        return { ...post, views: d.views || 0, likes: (d.likes && d.likes.summary && d.likes.summary.total_count) || 0, comments: (d.comments && d.comments.summary && d.comments.summary.total_count) || 0, permalink: d.permalink_url || '', created: d.created_time || '', ok: true };
      } catch (e) { return { ...post, ok: false, error: e.message }; }
    })),
    Promise.all(c.pages.map(async page => {
      try {
        const d = await fetchJson(`https://graph.facebook.com/${APPV}/${page.id}?fields=name,fan_count,followers_count&access_token=${page.page_token}`, { timeout: 15000 }, 1);
        return { id: page.id, name: page.name, brand: page.brand || '', followers: d.followers_count || 0, fans: d.fan_count || 0, ok: true };
      } catch (e) { return { id: page.id, name: page.name, brand: page.brand || '', ok: false, error: e.message }; }
    })),
  ]);
  const data = { posts: postStats.sort((a, b) => (b.published_at || 0) - (a.published_at || 0)), pages: pageStats, updated_at: Date.now() };
  statsCache = { ts: Date.now(), data };
  return data;
}
routes['/api/stats'] = async (req, res) => {
  try { j(res, 200, await statsData()); } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- music ----------
routes['/api/music'] = async (req, res, u) => {
  const q = (u.searchParams.get('q') || '').trim();
  if (!q) return j(res, 400, { error: 'missing q' });
  try {
    const s = await fetchJson('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(`mediatype:(audio) AND format:(MP3) AND (title:(${q}) OR subject:(${q}))`) + '&fl[]=identifier&fl[]=title&fl[]=creator&rows=10&page=1&output=json', { timeout: 25000 });
    const docs = (s.response && s.response.docs) || [];
    const tracks = [];
    await Promise.all(docs.slice(0, 8).map(async d => {
      try {
        const m = await fetchJson('https://archive.org/metadata/' + d.identifier, { timeout: 20000 }, 1);
        const f = (m.files || []).find(x => /\.mp3$/i.test(x.name || ''));
        if (f) tracks.push({ id: d.identifier, title: d.title || d.identifier, creator: (d.creator && d.creator[0]) || '', url: `https://archive.org/download/${d.identifier}/${encodeURIComponent(f.name)}` });
      } catch (_) {}
    }));
    j(res, 200, { results: tracks });
  } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- chat ----------
routes['/api/chat'] = async (req, res) => {
  const b = await readJson(req);
  const brand = CFG.brands[b.brand];
  if (!brand || !b.message) return j(res, 400, { error: 'brand + message required' });
  const mem = loadMem(b.brand);
  const rem = b.message.match(/^(?:remember|always|بدايما|دائما)[:\s]+(.+)/i);
  if (rem) {
    mem.style_notes.push(rem[1].trim()); mem.style_notes = mem.style_notes.slice(-20); saveMem(b.brand, mem);
    return j(res, 200, { reply: `✅ Saved to ${b.brand}'s permanent memory.` });
  }
  if (/(script|سكريبت|سيناريو)/i.test(b.message) && /(make|write|create|build|give|generate|need|want|اكتب|صاوب|دير|عطيني|بغيت)/i.test(b.message)) {
    try {
      const planText = await gemText(CFG.models.classify, 'From this owner request, extract a plan for the brand "' + brand.label + '". Return ONLY JSON {"product":"...","category":"...","duration":"20-30 seconds|30-40 seconds|40-60 seconds"}. Request: "' + b.message + '"');
      const plan = extractJSON(planText) || { product: b.message.slice(0, 60) };
      const s = await makeScript(b.brand, plan);
      const p = { id: 'P' + Date.now().toString(36), brand: b.brand, product: plan.product || '', category: plan.category || '', status: 'draft', research: s.research, script: s.script, ts: Date.now() };
      fs.writeFileSync(path.join(PROJECTS, p.id + '.json'), JSON.stringify(p, null, 2));
      return j(res, 200, { reply: '✅ Script ready (saved as ' + p.id + '):\n\n' + (s.script.sentences || []).join('\n') + '\n\nOpen it in the studio panel.', made_project: p.id });
    } catch (e) { return j(res, 200, { reply: '❌ ' + e.message }); }
  }
  const sys = [
    'You are the studio assistant for brand "' + brand.label + '" (key: ' + b.brand + ').',
    'BRAND PERSONA (researcher):\n' + brand.researcher_prompt.slice(0, 2200),
    'BRAND PERSONA (writer):\n' + brand.writer_prompt.slice(0, 4000),
    knowledgeBlock(b.brand),
    mem.style_notes.length ? 'OWNER INSTRUCTIONS (must obey):\n' + mem.style_notes.map(s => '- ' + s).join('\n') : '',
    b.project ? 'CURRENT PROJECT CONTEXT:\n' + JSON.stringify(b.project).slice(0, 3000) : '',
    'HARD RULES: Never invent brand facts, prices, offers or policies. Use ONLY approved knowledge above. Reply in the owner\'s language (Darija if Darija).',
    'TOOLS: If the owner asks you to CREATE or SEARCH, answer with exactly one JSON tool call and nothing else:\n' +
      '{"tool":"make_script","product":"...","category":"...","duration":"30-40 seconds"}\n' +
      '{"tool":"search","query":"..."}\n' +
      '{"tool":"kb_add","text":"..."}',
  ].filter(Boolean).join('\n\n---\n\n');
  const contents = [{ role: 'user', parts: [{ text: sys }] }, { role: 'model', parts: [{ text: 'Ready. I am the ' + brand.label + ' agent with tools.' }] }];
  for (const m of (b.history || []).slice(-10)) contents.push({ role: m.role === 'ai' ? 'model' : 'user', parts: [{ text: m.text }] });
  contents.push({ role: 'user', parts: [{ text: b.message }] });
  try {
    const parts = await gemini(CFG.models.writer, { contents });
    let reply = parts.map(p => p.text || '').join('');
    mem.chats++; saveMem(b.brand, mem);
    const tm = reply.match(/\{[\s\S]*\}/);
    if (tm && /"tool"\s*:/.test(tm[0])) {
      let call = null; try { call = JSON.parse(tm[0]); } catch (_) {}
      if (call && call.tool) {
        let result = { ok: false };
        try {
          if (call.tool === 'make_script') { const s = await makeScript(b.brand, call); result = { ok: true, made: 'script', title: s.script.title_arabic || s.script.title_darija || '' }; }
          else if (call.tool === 'search') { const r = await discoverTikTok(String(call.query || '')); result = { ok: true, made: 'search', count: r.length, top: r.slice(0, 3).map(v => ({ author: v.author, title: (v.title || '').slice(0, 60) })) }; }
          else if (call.tool === 'kb_add') { const kb = loadKB(b.brand); kb.push({ text: String(call.text || '').slice(0, 500), ts: Date.now() }); saveKB(b.brand, kb); result = { ok: true, made: 'kb_add' }; }
        } catch (e) { result = { ok: false, error: e.message }; }
        contents.push({ role: 'model', parts: [{ text: reply }] });
        contents.push({ role: 'user', parts: [{ text: 'TOOL_RESULT: ' + JSON.stringify(result) + '\nSummarize for the owner in their language.' }] });
        const parts2 = await gemini(CFG.models.writer, { contents });
        reply = parts2.map(p => p.text || '').join('');
        return j(res, 200, { reply, tool_result: result });
      }
    }
    j(res, 200, { reply });
  } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- KB / memory / projects routes ----------
routes['/api/kb'] = async (req, res, u, method) => {
  const brand = u.searchParams.get('brand');
  if (!CFG.brands[brand]) return j(res, 400, { error: 'unknown brand' });
  if (method === 'GET') return j(res, 200, { items: loadKB(brand) });
  if (method === 'DELETE') {
    const idx = parseInt(u.searchParams.get('idx'), 10);
    const kb = loadKB(brand);
    if (kb[idx]) { kb.splice(idx, 1); saveKB(brand, kb); }
    return j(res, 200, { items: kb });
  }
  const b = await readJson(req);
  const text = (b.text || '').trim();
  if (!text) return j(res, 400, { error: 'no text' });
  const kb = loadKB(brand);
  for (const part of text.split(/\n+/).map(s => s.trim()).filter(Boolean)) kb.push({ text: part.slice(0, 500), ts: Date.now() });
  saveKB(brand, kb);
  j(res, 200, { items: kb });
};
routes['/api/memory'] = async (req, res, u, method) => {
  const brand = u.searchParams.get('brand');
  if (!CFG.brands[brand]) return j(res, 400, { error: 'unknown brand' });
  const mem = loadMem(brand);
  if (method === 'DELETE') {
    const which = u.searchParams.get('which'), idx = parseInt(u.searchParams.get('idx'), 10);
    if (which === 'style' && mem.style_notes[idx] !== undefined) { mem.style_notes.splice(idx, 1); saveMem(brand, mem); }
    if (which === 'hooks') mem.hooks_used = [];
    if (which === 'all') saveMem(brand, { hooks_used: [], products_done: [], style_notes: [], chats: 0 });
    return j(res, 200, { memory: loadMem(brand) });
  }
  j(res, 200, { memory: mem });
};
routes['/api/projects'] = async (req, res, u, method) => {
  if (method === 'GET') {
    const list = fs.readdirSync(PROJECTS).filter(f => f.endsWith('.json')).map(f => {
      try { const p = JSON.parse(fs.readFileSync(path.join(PROJECTS, f), 'utf8')); return { id: p.id, brand: p.brand, product: p.product, status: p.status, ts: p.ts, has_script: !!p.script, rendered: !!p.rendered_file }; } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => b.ts - a.ts);
    return j(res, 200, { projects: list });
  }
  const p = await readJson(req);
  if (!p.brand) return j(res, 400, { error: 'brand required' });
  p.id = p.id || 'P' + Date.now().toString(36);
  p.ts = p.ts || Date.now();
  fs.writeFileSync(path.join(PROJECTS, p.id + '.json'), JSON.stringify(p, null, 2));
  j(res, 200, { id: p.id });
};
routes['/api/project'] = async (req, res, u, method) => {
  const id = u.searchParams.get('id');
  const f = path.join(PROJECTS, path.basename(id || '') + '.json');
  if (method === 'DELETE') { try { fs.unlinkSync(f); } catch (_) {} return j(res, 200, { ok: true }); }
  if (!fs.existsSync(f)) return j(res, 404, { error: 'not found' });
  j(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
};

// ---------- batch factory: 1 video → all brands, customizable, crash-resumable ----------
async function runBatchJob(job, pf, analysis) {
  const save = st => { job.status = st; try { fs.writeFileSync(pf, JSON.stringify(job, null, 2)); } catch (_) {} };
  const fail = why => { save('failed'); job.error = why; log('[batch] ' + job.brand + ' FAILED: ' + why); };
  try {
    const srcFile = path.join(MEDIA, 'src_' + job.video.id + '.mp4');
    if (!fs.existsSync(srcFile)) {
      save('downloading');
      try { const f = await downloadVideo(job.video.play); if (path.basename(f) !== 'src_' + job.video.id + '.mp4') { try { fs.renameSync(f, srcFile); } catch (_) {} } } catch (_) {}
    }
    if (!fs.existsSync(srcFile)) return fail('download failed');
    job.video_file = path.basename(srcFile);
    if (!analysis) {
      save('analyzing');
      if (fs.statSync(srcFile).size <= 18e6) {
        try {
          const parsed = extractJSON(await gemVision(CFG.models.vision, ANALYZE_PROMPT,
            fs.readFileSync(srcFile), 'video/mp4'));
          if (parsed) analysis = parsed;
        } catch (_) {}
      }
    }
    job.analysis = analysis;
    save('writing');
    const o = job.overrides || {};
    const { script } = await makeScript(job.brand, {
      product: job.product, category: job.category, duration: '30-40 seconds',
      model: o.model || undefined, tone: o.tone || undefined, language: o.language || undefined,
      analysis: analysis || undefined,
      scene_descriptions_text: job.analysis ? (job.analysis.scene_descriptions_text || '') : '',
      product_first_appearance_sec: job.analysis ? job.analysis.product_first_appearance_sec : undefined,
    });
    job.script = script;
    save('voicing');
    const sText = (script.sentences || []).join(' ') || script.script_text || '';
    if (sText) {
      const txt = sText + (o.tone ? ' (' + o.tone + ')' : '');
      try { job.tts_url = await makeTTSFile(job.brand, txt, o.voice, o.rate); } catch (e) { log('[batch] tts ' + job.brand + ': ' + e.message); }
    }
    job.caption = script.caption_social || '';
    job.script_text = sText;
    save('ready');
    log('[batch] ' + job.brand + ' READY ' + path.basename(pf, '.json'));
  } catch (e) { fail(e.message); }
}
function resumeBatches() {
  try {
    const stuck = fs.readdirSync(PROJECTS).filter(f => /^B/.test(f) && f.endsWith('.json'))
      .map(f => { try { return { pf: path.join(PROJECTS, f), p: JSON.parse(fs.readFileSync(path.join(PROJECTS, f), 'utf8')) }; } catch (_) { return null; } })
      .filter(x => x && x.p.status && ['analyzing', 'writing', 'voicing', 'downloading', 'batch'].includes(x.p.status));
    if (!stuck.length) return;
    log('[batch] resuming ' + stuck.length + ' interrupted build(s) after restart');
    (async () => { let shared = null; for (const { pf, p } of stuck) { await runBatchJob(p, pf, shared); if (p.analysis) shared = p.analysis; } })().catch(e => log('[batch] resume fatal: ' + e.message));
  } catch (_) {}
}
setTimeout(resumeBatches, 4000);

routes['/api/batch'] = async (req, res) => {
  const b = await readJson(req);
  const video = b.video || {};
  if (!video.id || !video.play) return j(res, 400, { error: 'video with id + play url required' });
  const specs = Array.isArray(b.specs) ? b.specs.filter(s => CFG.brands[s.brand]) : [];
  if (!specs.length) return j(res, 400, { error: 'no valid brand specs' });
  if (specs.length > 7) specs.length = 7;
  j(res, 200, { ok: true, started: specs.length });
  log('[batch] starting ' + specs.length + ' builds for video ' + video.id);
  (async () => {
    let sharedAnalysis = null;
    for (const s of specs) {
      const job = {
        brand: s.brand, product: s.product || video.title.replace(/#\w+/g, '').trim().slice(0, 60) || 'product',
        category: s.category || '', status: 'batch', ts: Date.now(),
        video: { id: video.id, author: video.author || '', title: video.title || '', url: video.source || '', plays: video.plays || 0, duration: video.duration || 0, play: video.play },
        video_file: null, analysis: null, script: null, caption: '', script_text: '',
        music: s.music ? { title: s.music.title || 'custom', url: s.music.url } : null,
        overrides: { voice: s.voice, rate: s.rate, tone: s.tone, language: s.language, model: s.model },
      };
      const pf = path.join(PROJECTS, 'B' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.json');
      await runBatchJob(job, pf, sharedAnalysis);
      if (job.analysis && !sharedAnalysis) sharedAnalysis = job.analysis;
    }
    log('[batch] all done');
  })().catch(e => log('[batch] fatal: ' + e.message));
};

// ---------- StudioChat: 7 editing agents + local ffmpeg engine ----------
const FFMPEG = (() => { try { const d = fs.readdirSync(path.join(ROOT, 'tools', 'ffmpeg')).find(f => f.startsWith('ffmpeg-')); return path.join(ROOT, 'tools', 'ffmpeg', d, 'bin', 'ffmpeg.exe'); } catch (_) { return 'ffmpeg'; } })();
const FFPROBE = FFMPEG === 'ffmpeg' ? 'ffprobe' : FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');
const CHATS = path.join(DATA, 'chats');
if (!fs.existsSync(CHATS)) fs.mkdirSync(CHATS, { recursive: true });
function chatFile(k) { return path.join(CHATS, k + '.json'); }
function loadChat(k) { try { return JSON.parse(fs.readFileSync(chatFile(k), 'utf8')); } catch (_) { return { id: k, created: Date.now(), history: [], project: null, last_video: null, last_plan: null }; } }
function saveChat(k, c) { c.history = (c.history || []).slice(-120); fs.writeFileSync(chatFile(k), JSON.stringify(c, null, 2)); }

function runFF(args, timeoutSec = 300) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', c => err += c);
    p.on('error', reject);
    const t = setTimeout(() => { try { p.kill(); } catch (_) {} reject(new Error('ffmpeg timeout')); }, timeoutSec * 1000);
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve(true) : reject(new Error(err.slice(-400) || 'ffmpeg exit ' + code)); });
  });
}
function probeVideo(f) {
  return new Promise(resolve => {
    const p = spawn(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', f], { windowsHide: true });
    let out = '';
    p.stdout.on('data', c => out += c);
    p.on('error', () => resolve(null));
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch (_) { resolve(null); } });
  });
}
// deterministic executors — the agent picks ops, these do the real work
async function applyEditOp(state, op) {
  const kind = op.op;
  if (kind === 'trim') {
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const args = ['-ss', String(op.start), '-i', state.file, '-t', String(op.duration || op.end - op.start), '-c', 'copy', out];
    if (op.copy === false) { args.splice(args.indexOf('-c'), 3, '-c:v', 'libx264', '-c:a', 'aac', out); }
    await runFF(args); state.file = out; state.cuts.push({ start: op.start, duration: op.duration || op.end - op.start });
  } else if (kind === 'text') {
    // text overlay at a timestamp: needs re-encode
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const t = String(op.text || '').replace(/['":\\]/g, '');
    const fs_ = op.size || 42, col = (op.color || 'white').replace(/[^a-zA-Z0-9]/g, '');
    const enable = op.at !== undefined ? `:enable='between(t,${op.at},${op.at + (op.dur || 3)})'` : '';
    const x = op.x || '(w-text_w)/2', y = op.y === 'top' ? '60' : op.y === 'bottom' ? 'h-140' : '(h-text_h)/2';
    const vf = `drawtext=text='${t}':fontsize=${fs_}:fontcolor=${col}:borderw=3:bordercolor=black:x=${x}:y=${y}${enable}`;
    await runFF(['-i', state.file, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', out]);
    state.file = out; state.texts.push(t);
  } else if (kind === 'speed') {
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const s = Math.min(3, Math.max(0.25, +op.factor || 1));
    await runFF(['-i', state.file, '-filter_complex', `[0:v]setpts=${(1 / s).toFixed(4)}*PTS[v];[0:a]atempo=${s}[a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', out]);
    state.file = out; state.speed = s;
  } else if (kind === 'zoom') {
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const z = Math.min(2, Math.max(1, +op.factor || 1.2));
    await runFF(['-i', state.file, '-vf', `scale=iw*${z}:ih*${z},crop=iw/${z}:ih/${z}`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', out]);
    state.file = out; state.zoom = z;
  } else if (kind === 'crop_ratio') {
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const r = String(op.ratio || '9:16');
    const [rw, rh] = r === '9:16' ? [9, 16] : r === '1:1' ? [1, 1] : [16, 9];
    await runFF(['-i', state.file, '-vf', `crop='min(iw,ih*${rw}/${rh})':'min(ih,iw*${rh}/${rw})'`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', out]);
    state.file = out; state.ratio = r;
  } else if (kind === 'music') {
    // mix music under original audio, ducked
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const murl = op.url; const mfile = path.join(CACHE, 'mus_' + hash(murl) + '.mp3');
    const r2 = await fetch(murl, { signal: AbortSignal.timeout(60000) });
    if (!r2.ok) throw new Error('music download failed');
    fs.writeFileSync(mfile, Buffer.from(await r2.arrayBuffer()));
    const vol = Math.min(1, Math.max(0.05, +op.volume ?? 0.25));
    await runFF(['-i', state.file, '-i', mfile, '-filter_complex', `[1:a]volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', out]);
    state.file = out; state.music = murl;
  } else if (kind === 'tts') {
    const url = await makeTTSFile(state.brand || 'alshihna', op.text || '', op.voice, op.rate);
    const tfile = path.join(CACHE, path.basename(url));
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    await runFF(['-i', state.file, '-i', tfile, '-filter_complex', '[0:a]volume=0.15[bg];[1:a][bg]amix=inputs=2:duration=first[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', out]);
    state.file = out; state.tts = op.text;
  } else if (kind === 'caption_file') {
    // burned subtitles from provided srt content
    const srt = path.join(CACHE, 'sub_' + Date.now() + '.srt');
    fs.writeFileSync(srt, String(op.srt || ''));
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    await runFF(['-i', state.file, '-vf', 'subtitles=' + srt.replace(/\\/g, '/').replace(':', '\\:'), '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', out]);
    state.file = out; state.subs = true;
  } else if (kind === 'volume') {
    const out = path.join(MEDIA, 'edit_' + Date.now() + '.mp4');
    const v = Math.min(3, Math.max(0, +op.factor ?? 1));
    await runFF(['-i', state.file, '-af', `volume=${v}`, '-c:v', 'copy', out]);
    state.file = out;
  } else {
    throw new Error('unknown op: ' + kind);
  }
}

const CHAT_TOOLS_HINT = `You are one of 7 video-editing agents. The owner sends a TikTok URL or talks to you.
When a video is staged you WATCH it (the system gives you the analysis) and SUGGEST an edit plan in chat, briefly, in the owner's style.
To actually edit, reply with ONLY a JSON object (no prose) matching the tool contract:
{"tool":"plan","ops":[{"op":"trim","start":5,"duration":7},{"op":"text","text":"SOLDE 50%","at":3,"dur":3,"size":44,"color":"white","y":"bottom"},{"op":"speed","factor":1.2},{"op":"zoom","factor":1.3},{"op":"crop_ratio","ratio":"9:16"},{"op":"music","url":"<url>","volume":0.25},{"op":"tts","text":"...","voice":"Kore","rate":1},{"op":"caption_file","srt":"1\\n00:00:01,000 --> 00:00:03,000\\n..."},{"op":"volume","factor":1.5}]}
ops run in order on the real file with real ffmpeg. Never invent other ops. When asked questions or chatting, answer normally in Darija (or the owner's language). Never invent prices — use the brand knowledge base or ask.`;

async function chatProcessURL(k, c, url) {
  try {
    const brand = CFG.brands[k];
    const d = await fetchJson('https://tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', { timeout: 25000 }, 2);
    if (!d || d.code !== 0 || !d.data) throw new Error('TikWM could not fetch this URL');
    const v = d.data;
    let file = c.last_video && c.last_video.id === String(v.id) ? c.last_video.file : null;
    if (!file || !fs.existsSync(path.join(MEDIA, path.basename(file)))) {
      const f = await downloadVideo(v.play || v.wmplay); file = path.basename(f);
    }
    const abs = path.join(MEDIA, path.basename(file));
    c.last_video = { id: String(v.id), file, author: (v.author && v.author.unique_id) || '', title: v.title || '', duration: v.duration || 0, plays: v.play_count || 0, url };
    c.edit_state = { file: abs, cuts: [], texts: [], brand: k };
    saveChat(k, c);
    let analysis = null;
    if (fs.statSync(abs).size <= 18e6) {
      try { analysis = extractJSON(await gemVision(CFG.models.vision, ANALYZE_PROMPT, fs.readFileSync(abs), 'video/mp4', 'vision')); } catch (_) {}
    }
    c.last_analysis = analysis;
    const hook = await gemText(CFG.models.writer,
      'Owner sent a TikTok URL. You watched it. Analysis: ' + JSON.stringify(analysis || { note: 'unavailable' }) + '. Duration ' + v.duration + 's. ' + CHAT_TOOLS_HINT +
      ' Now write a SHORT chat reply: what you saw (2-3 lines), then 3-4 concrete suggestions of what you could do with THIS footage for brand ' + brand.label + '. Darija. No JSON.').catch(() => null);
    c.history.push({ role: 'agent', text: hook || 'Video downloaded w chfto. Goli liya ash bghiti ndir lih.', ts: Date.now() });
    c.pending = undefined;
    saveChat(k, c);
  } catch (e) {
    c.history.push({ role: 'agent', text: '✕ ' + e.message, ts: Date.now() });
    c.pending = undefined;
    saveChat(k, c);
  }
}
function resumeChatJobs() {
  try {
    const files = fs.readdirSync(CHATS).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const k = path.basename(f, '.json');
        const c = JSON.parse(fs.readFileSync(path.join(CHATS, f), 'utf8'));
        if (c.pending && c.pending.action === 'analyze_url' && c.pending.url) {
          log('[chat] resuming pending URL job for ' + k);
          chatProcessURL(k, c, c.pending.url);
        }
      } catch (_) {}
    }
  } catch (_) {}
}
setTimeout(resumeChatJobs, 6000);

routes['/api/chat/state'] = async (req, res, u) => {
  const k = (u.searchParams.get('id') || 'alshihna').replace(/[^a-z_]/g, '');
  const c = loadChat(k);
  const out = { ...c, video_url: c.last_video ? '/file/' + path.basename(c.last_video.file) : null, video_meta: c.last_video ? { author: c.last_video.author, duration: c.last_video.duration, title: c.last_video.title } : null, edited_url: c.last_plan && c.last_plan.final ? '/file/' + path.basename(c.last_plan.final) : null };
  delete out.last_plan;
  if (c.last_plan) out.plan_ops = c.last_plan.ops || [];
  j(res, 200, out);
};
routes['/api/chat/reset'] = async (req, res, u) => {
  const k = (u.searchParams.get('id') || '').replace(/[^a-z_]/g, '');
  saveChat(k, { id: k, created: Date.now(), history: [], project: null, last_video: null, last_plan: null });
  j(res, 200, { ok: true });
};
routes['/api/chat'] = async (req, res) => {
  const b = await readJson(req);
  const k = String(b.chat_id || '').replace(/[^a-z_]/g, '');
  if (!CFG.brands[k]) return j(res, 400, { error: 'unknown chat' });
  const c = loadChat(k);
  const msg = String(b.message || '').trim();
  if (!msg) return j(res, 400, { error: 'empty message' });
  c.history.push({ role: 'user', text: msg, ts: Date.now() });
  saveChat(k, c);
  const brand = CFG.brands[k];
  const mem = loadMem(k);
  const state = c.edit_state || { file: (c.last_video && c.last_video.file) || null, cuts: [], texts: [], brand: k };
  // TikTok URL? → download + WATCH + suggest (persisted job — survives restarts)
  const urlM = msg.match(/https?:\/\/[^\s]*tiktok\.com\/[^\s]+|https?:\/\/vm\.tiktok\.com\/[^\s]+/);
  if (urlM) {
    c.pending = { action: 'analyze_url', url: urlM[0], ts: Date.now() };
    saveChat(k, c);
    j(res, 200, { ok: true, busy: 'downloading + watching the video' });
    await chatProcessURL(k, c, urlM[0]);
    return;
  }
  // normal chat → agent decides: prose or a tool plan
  try {
    j(res, 200, { ok: true, busy: 'agent thinking' });
    const recent = c.history.slice(-14).map(h => h.role + ': ' + h.text).join('\n');
    const kb = knowledgeBlock(k);
    const memBlock = mem.style_notes.length ? '\nOWNER RULES: ' + mem.style_notes.join(' | ') : '';
    const decide = await gemText(CFG.models.classify,
      CHAT_TOOLS_HINT + '\nBrand: ' + brand.label + '. ' + memBlock + kb +
      '\nVideo state: ' + JSON.stringify({ staged: !!state.file, applied: { cuts: state.cuts, texts: state.texts, speed: state.speed, zoom: state.zoom, music: state.music, tts: state.tts, subs: state.subs } }) +
      '\nLast analysis: ' + JSON.stringify(c.last_analysis || null) +
      '\nRecent conversation:\n' + recent + '\n\nIf the owner wants edits, reply ONLY the plan JSON. Otherwise reply with normal chat text.').catch(() => null);
    if (!decide) throw new Error('agent unreachable');
    const plan = extractJSON(decide);
    if (plan && plan.tool === 'plan' && Array.isArray(plan.ops) && plan.ops.length && state.file) {
      const results = [];
      for (const op of plan.ops.slice(0, 8)) {
        try { await applyEditOp(state, op); results.push('✓ ' + op.op); }
        catch (e) { results.push('✕ ' + op.op + ': ' + e.message.slice(0, 80)); }
      }
      c.edit_state = state;
      c.last_plan = { ops: plan.ops, results, final: state.file, ts: Date.now() };
      c.history.push({ role: 'agent', text: 'Done: ' + results.join(', ') + '. Video updated — check the player. Anything else?', ts: Date.now() });
      saveChat(k, c);
    } else {
      c.history.push({ role: 'agent', text: String(decide).slice(0, 2000), ts: Date.now() });
      saveChat(k, c);
    }
  } catch (e) {
    c.history.push({ role: 'agent', text: '✕ ' + e.message, ts: Date.now() });
    saveChat(k, c);
  }
};

// ---------- one-sentence builder ----------
routes['/api/one_sentence'] = async (req, res) => {
  const b = await readJson(req);
  const text = (b.text || '').trim();
  if (!text) return j(res, 400, { error: 'empty' });
  const brandList = Object.entries(CFG.brands).map(([k, v]) => `${k} = ${v.label} (${v.lang})`).join('; ');
  try {
    const planText = await gemText(CFG.models.writer,
      'You convert the owner\'s one-line request into a video-studio plan. Brands: ' + brandList + '.\nOwner request: "' + text + '"\n' +
      'Return ONLY JSON: {"brand":"<brand key>","product":"<short product name>","category":"<category>","duration":"20-30 seconds|30-40 seconds|40-60 seconds","search_query":"<2-4 English words>","notes":"<1 line>"}');
    const plan = extractJSON(planText);
    if (!plan || !CFG.brands[plan.brand]) return j(res, 502, { error: 'could not understand the request' });
    const out = { plan, steps: [] };
    try { const r = await discoverTikTok(plan.search_query); out.videos = r.slice(0, 4); out.steps.push('search: ' + out.videos.length + ' videos'); } catch (e) { out.steps.push('search failed: ' + e.message); }
    const s = await makeScript(plan.brand, plan);
    out.research = s.research; out.script = s.script; out.steps.push('research + script done');
    try { out.tts = await makeTTSFile(plan.brand, (s.script.sentences || []).join(' ') || s.script.script_text || ''); out.steps.push('voice ready'); } catch (e) { out.steps.push('tts failed: ' + e.message); }
    out.brand = plan.brand;
    j(res, 200, out);
  } catch (e) { j(res, 502, { error: e.message }); }
};

// ---------- static + media ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.wav': 'audio/wav' };
function serveStatic(res, urlPath) {
  let f = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}
function serveFile(req, res, name, dir, type) {
  const f = path.join(dir, path.basename(name));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no file'); }
  const stat = fs.statSync(f), range = req.headers.range;
  const ct = type || MIME[path.extname(f)] || 'application/octet-stream';
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
async function tikwmRefresh(id) {
  // fresh play/cover URLs — TikWM re-resolves server-side, immune to our IP blocks
  try {
    const d = await fetchJson('https://tikwm.com/api/?url=' + encodeURIComponent('https://www.tiktok.com/@x/video/' + id) + '&hd=1', { timeout: 20000 }, 1);
    if (d && d.code === 0 && d.data) return { play: d.data.play || d.data.wmplay || '', cover: d.data.cover || d.data.origin_cover || '' };
  } catch (_) {}
  return null;
}
function streamUpstream(res, upstream) {
  const h = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers.get(k)) h[k] = upstream.headers.get(k);
  if (!h['accept-ranges']) h['accept-ranges'] = 'bytes';
  res.writeHead(upstream.status, h);
  Readable.fromWeb(upstream.body).pipe(res);
}
async function proxyMedia(req, res, u) {
  const target = u.searchParams.get('url');
  const vid = u.searchParams.get('id') || '';
  if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('bad url'); }
  const doStream = t => fetch(t, { headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', Range: req.headers.range || 'bytes=0-' }, signal: AbortSignal.timeout(60000) });
  try {
    let upstream = await doStream(target);
    // self-heal: TikTok webapp CDN URLs expire in minutes → 403. Re-resolve via
    // TikWM with the video id, refresh the search cache, and stream the fresh URL.
    if (upstream.status === 403 || upstream.status === 404) {
      if (vid) {
        const fresh = await tikwmRefresh(vid);
        if (fresh) {
          for (const [, c] of searchCache) {
            const hit = c.results.find(r => String(r.id) === String(vid));
            if (hit) { if (fresh.play) hit.play = fresh.play; if (fresh.cover) hit.cover = fresh.cover; }
          }
          if (fresh.play && fresh.play !== target) {
            try { const up2 = await doStream(fresh.play); if (up2.status < 400) return streamUpstream(res, up2); } catch (_) {}
          }
        }
      }
      res.writeHead(502); return res.end('upstream ' + upstream.status + ' (expired, no refresh)');
    }
    return streamUpstream(res, upstream);
  } catch (e) { res.writeHead(502); res.end('proxy error: ' + e.message); }
}

// ---------- Adaptive Studio v2 layer (lib/*) ----------
const { createStudio } = require('./lib/studio');
const { findBinary } = require('./lib/media');
const FF_BIN = findBinary(path.join(ROOT, 'tools', 'ffmpeg'), 'ffmpeg.exe');

/**
 * ROLE — which half of the runtime this process is.
 *   all    : web + jobs in one process (local default; what the owner runs today)
 *   web    : HTTP + SSE only, never starts an ffmpeg job
 *   worker : the job queue only, no HTTP listener
 * Chosen by VS_ROLE or --role=…, so Compose can run the same image as two services.
 */
const ROLE = (() => {
  const fromArgv = (process.argv.find(a => /^--role=/.test(a)) || '').split('=')[1];
  const v = String(fromArgv || process.env.VS_ROLE || 'all').toLowerCase();
  return ['all', 'web', 'worker'].includes(v) ? v : 'all';
})();

/**
 * readiness — the checks a container health check needs, and nothing else.
 * Read-only by design: it stats directories for writability and looks for the binary, but it never
 * writes, never queues a job and never mutates a record. A probe that changes state is a probe that
 * can corrupt a project when it runs every ten seconds.
 */
function readiness() {
  const checks = [];
  const add = (name, fn) => {
    try { const r = fn(); checks.push({ name, ok: r.ok !== false, detail: r.detail || '' }); }
    catch (e) { checks.push({ name, ok: false, detail: e.message }); }
  };
  add('storage', () => {
    const roots = [STORAGE.dataDir, STORAGE.studioDir, STORAGE.mediaDir, STORAGE.logsDir, STORAGE.cacheDir];
    for (const d of roots) { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); }
    return { detail: roots.length + ' writable roots' };
  });
  add('ffmpeg', () => ({ ok: !!FF_BIN && (fs.existsSync(FF_BIN) || (process.env.PATH || '').split(path.delimiter).some(d=>fs.existsSync(path.join(d,FF_BIN)))), detail: FF_BIN || 'not found' }));
  add('store', () => ({ ok: Array.isArray(studio.store.pages()), detail: studio.store.pages().length + ' pages' }));
  add('queue', () => ({
    ok: ROLE === 'web' || typeof studio.jobs.tick === 'function',
    detail: ROLE === 'web' ? 'not executed in this role (worker owns the queue)' : 'runner available',
  }));
  add('providers', () => ({ ok: true, detail: ROLE === 'web' ? 'models are used by the worker' : 'router configured' }));
  return checks;
}

// analysis proxy: Gemini inline vision caps at ~18MB, so long videos get a short low-res proxy first
async function analysisProxy(file) {
  const out = path.join(MEDIA, 'an_' + hash(file + fs.statSync(file).size) + '.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 10000) return out;
  await new Promise((resolve, reject) => {
    const p = spawn(FF_BIN, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-t', '20', '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', out], { windowsHide: true });
    let err = ''; p.stderr.on('data', c => err += c); p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-200) || 'proxy failed')));
  });
  return out;
}
async function analyzeFile(file) {
  let buf = fs.readFileSync(file);
  if (buf.length > 18e6) buf = fs.readFileSync(await analysisProxy(file));
  const raw = await gemVision(CFG.models.vision, ANALYZE_PROMPT, buf, 'video/mp4', 'vision');
  return extractJSON(raw) || { scene_descriptions_text: String(raw).slice(0, 1500) };
}
async function resolveUrl(url) {
  try {
    const d = await fetchJson('https://tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', { timeout: 25000 }, 2);
    if (d && d.code === 0 && d.data) {
      const v = d.data;
      const un = (v.author && v.author.unique_id) || 'user';
      return { id: String(v.id), author: un, title: v.title || '', duration: v.duration || 0, cover: v.cover || '', plays: v.play_count || 0, likes: v.digg_count || 0, play: v.play || v.wmplay || '', source: 'https://www.tiktok.com/@' + un + '/video/' + v.id };
    }
  } catch (_) {}
  return await ytdlpMeta(url).catch(() => null);
}

const studio = createStudio({
  root: ROOT, dataDir: DATA, storage: STORAGE,
  // Role split: `web` serves HTTP and never executes a heavy job; `worker` executes jobs and does
  // not serve HTTP. `all` (the default) keeps the classic single-process local behaviour. Jobs are
  // persisted records either way, so a worker crash re-queues its work instead of losing it.
  jobsEnabled: ROLE !== 'web',
  legacy: {
    brands: () => CFG.brands,
    fbPages: () => FBCFG().pages,
    refreshFacebookPages,
    llm: {
      // Workload-declared: the caller says WHAT KIND of work it is (chat_light vs edit_complex),
      // and the router decides which model serves it, so Settings changes real behaviour.
      text: (model, prompt, task, opts) => gemText(model, prompt, task || 'reply', opts),
      vision: (model, prompt, buf, mime, opts) => gemVision(model, prompt, buf, mime, 'vision', opts),
      video: (model, prompt, buf, mime, opts) => gemVideo(model, prompt, buf, mime, opts),
      transcribe: (model, prompt, buf, mime, opts) => gemTranscribe(model, prompt, buf, mime, opts),
      modelKey: () => null,
    },
    providers,
    knowledgeBlock, discoverTikTok, makeTTSFile, downloadVideo, fetchJson,
    stats: () => statsData(true), analyzeFile, resolveUrl,
  },
});
for (const [p, h] of Object.entries(studio.routes)) routes[p] = h;
// bind the routing activity stream to the studio, which owns the SSE fan-out
activitySink.fn = rec => studio.recordActivity(rec);
log('[studio] v2 mounted: ' + Object.keys(studio.routes).length + ' routes, ' + studio.agent.toolNames().length + ' agent tools');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (process.env.VS_AUTH_PASSWORD && !['/health/live','/health/ready'].includes(u.pathname)) {
    const expected = Buffer.from((process.env.VS_AUTH_USER || 'studio') + ':' + process.env.VS_AUTH_PASSWORD);
    let supplied = Buffer.alloc(0);
    if (/^Basic /i.test(req.headers.authorization || '')) supplied = Buffer.from(req.headers.authorization.slice(6), 'base64');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="VideoStudio", charset="UTF-8"' }); return res.end('Authentication required'); }
  }
  try {
    // ---- health: container/orchestrator probes ----
    // Liveness answers "is this process still working?" and touches nothing. Readiness answers
    // "can it serve a real request right now?" by checking the things a request needs (storage
    // writable, ffmpeg present, store readable, queue ticking) WITHOUT mutating any state — a
    // health check that writes is a health check that can corrupt a project.
    if (u.pathname === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, role: ROLE, pid: process.pid, uptime: Math.round(process.uptime()) }));
    }
    if (u.pathname === '/health/ready') {
      const checks = readiness();
      const ok = checks.every(c => c.ok);
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok, role: ROLE, checks }));
    }
    if (u.pathname.startsWith('/studio-media/')) return studio.serveStudioMedia(req, res, u);
    const profileMedia = /^\/profile-media\/([a-z_]+)\.mp4$/.exec(u.pathname);
    if (profileMedia) { u.searchParams.set('page', profileMedia[1]); return studio.routes['/api/v2/campaign/card'](req, res, u); }
    if (u.pathname === '/atlas-preview') return studio.routes['/api/v2/campaign/thumbnail'](req, res, u);
    if (u.pathname === '/tutorial-media/surveoo.mp4') return serveFile(req, res, 'surveoo.mp4', path.join(ROOT, 'assets/tutorials'), 'video/mp4');
    if (u.pathname.startsWith('/media/')) return serveFile(req, res, u.pathname.slice(7), CACHE, 'audio/wav');
    if (u.pathname.startsWith('/file/')) return serveFile(req, res, u.pathname.slice(6), MEDIA);
    if (u.pathname === '/proxy') return await proxyMedia(req, res, u);
    if (u.pathname.startsWith('/api/')) {
      const r = routes[u.pathname];
      if (!r) return j(res, 404, { error: 'no route' });
      return await r(req, res, u, req.method);
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    // Old bookmarks used to expose the pre-chat manual-editor pages. Keep their backend utilities,
    // but always return the owner to the sole supported chat workspace.
    if (u.pathname === '/legacy/studio.html' || u.pathname === '/legacy/studiochat.html') {
      res.writeHead(302, { Location: '/' }); return res.end();
    }
    return serveStatic(res, u.pathname);
  } catch (e) {
    log('[error]', req.url, e.message);
    try { j(res, 500, { error: e.message }); } catch (_) {}
  }
});
process.on('uncaughtException', e => log('[uncaught]', e.message));
process.on('unhandledRejection', e => log('[unhandled]', (e && e.message) || e));
process.stdin.on('error', () => {}); process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
// Bind address comes from the environment so the same image works locally (loopback only) and in a
// container (where the proxy must be able to reach it). Default stays loopback: exposing this by
// accident would publish a studio with no authentication on whatever network the box sits on.
const HOST = process.env.VS_HOST || '127.0.0.1';
const PORT = Number(process.env.VS_PORT) > 0 ? Number(process.env.VS_PORT) : CFG.port;
if (ROLE === 'worker') {
  // No HTTP listener at all. The queue is already ticking (studio.jobs.resume() re-queued anything
  // that was running when the last worker died); this process just has to stay alive.
  setInterval(() => {}, 1 << 30);
  log(`VideoStudio worker → queue only | ${studio.jobs.enabled ? 'jobs enabled' : 'JOBS DISABLED'} | role ${ROLE}`);
  if (!studio.jobs.enabled) log('[fatal] worker started with jobs disabled — nothing will run; set VS_ROLE=worker without VS_JOB_CONCURRENCY=0');
} else {
  server.listen(PORT, HOST, () => log(`VideoStudio v2 → http://${HOST}:${PORT} | role ${ROLE} | ${KEYS.length} keys | ${Object.keys(CFG.brands).length} agents | publishing ${readJsonOrCreate(path.join(DATA,'studio','publish-hold.json'),{enabled:true},'publish-hold.json').enabled!==false?'HELD':'ENABLED'}`));
}
// Startup failures must be visible AND terminal. A process that cannot bind its port has nothing to
// offer — staying alive would make it look healthy to a supervisor while serving nobody, which is
// how a container reports "up" forever while the port answers nothing. Exiting lets the restart
// policy (or the operator) see the real problem.
server.on('error', e => {
  log('[fatal] server error: ' + e.message);
  process.exit(1);
});
