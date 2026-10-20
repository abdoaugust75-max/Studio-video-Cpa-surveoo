// lib/transcribe.js — the transcription service.
//
// Deliberately its own module: the UI and the agent both ask THIS service, so there is exactly one
// transcription path, one cache rule and one honesty policy about timestamps.
//
// It is provider-independent. The only Google-specific part is the transport handed in as
// `llm.transcribe`, and the model is chosen by the router (workload `transcription`) — no model id
// is written here.
//
// HONESTY POLICY ON TIMESTAMPS
// The generative API returns text and estimated segment boundaries; it does not return verified
// word-level timings. So this service:
//   * validates every timestamp (numeric, ordered, non-overlapping, inside the real duration),
//   * discards or repairs anything that fails,
//   * records exactly whether the provider supplied word timings,
//   * never synthesises word timings, and never pretends segment times are exact.
// The UI reads those fields and labels the transcript accordingly.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

const PROMPT_VERSION = 'asr-v4-acoustic-boundary-repair';

// HONESTY GUARD (owner rule 2026-09-23): a transcription reply that is the model's APOLOGY rather
// than a transcript ("I'm sorry, I didn't catch that.") once got burned verbatim as a subtitle.
// Refusals and no-speech notices are detected here — the single transcription chokepoint — and
// rejected, so they can never become caption text anywhere in the product.
const REFUSAL_RE = /^\s*(i'?m\s+sorry|i\s+am\s+sorry|sorry\b|unfortunately\b|i\s+didn'?t\s+catch|i\s+could\s?n[o']?t\s+(catch|hear|understand)|i\s+can'?t\s+(hear|understand|make\s+out)|no\s+(clear\s+)?speech|there\s+(is|was)\s+no\s+(speech|audio|voice)|unable\s+to\s+transcribe|can\s?not\s+transcribe|audio\s+(is|seems|appears)\s+(silent|unclear|inaudible|empty))/i;
function isRefusalText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return !!t && t.length <= 140 && REFUSAL_RE.test(t);
}

function createTranscribe(o) {
  const store = o.store;
  const media = o.media;
  const llm = o.llm || {};
  const log = o.log || (() => {});
  const activity = o.activity || (() => {});
  const cacheDir = o.cacheDir;

  /** Fingerprint of the exact audio we asked for: identity + bytes + duration. */
  function sourceFingerprint(artifact, file) {
    let st = null;
    try { st = fs.statSync(file); } catch (_) {}
    return U.hash16([
      artifact.id, artifact.op || '', artifact.project,
      st ? st.size : 0, st ? Math.round(st.mtimeMs) : 0,
      (artifact.probe && artifact.probe.duration) || 0,
    ].join('|'));
  }
  /** Fingerprint of the transcription configuration that would change the output. */
  function configFingerprint(cfg) {
    return U.hash16([PROMPT_VERSION, cfg.model || 'router', cfg.language || 'auto', cfg.rate || 16000, cfg.referenceHash || ''].join('|'));
  }

  /**
   * findCached — a transcription for identical audio + identical config.
   * Reusing it is the difference between one API request and none, which matters on a free tier.
   */
  function findCached(projectId, srcFp, cfgFp) {
    // A cached record whose text/segments are a refusal predates the honesty guard — never reuse it.
    return store.transcriptions(projectId).find(t => t.sourceFingerprint === srcFp && t.configFingerprint === cfgFp && t.status === 'ready'
      && !isRefusalText(t.text) && !(t.segments || []).some(s => isRefusalText(s.text))) || null;
  }

  function resolveSource(project, artifactId) {
    const art = artifactId ? store.artifact(artifactId) : null;
    const a = (art && art.project === project.id) ? art : (project.current ? store.artifact(project.current) : null);
    if (!a) throw new Error('this project has no artifact to transcribe yet');
    if (!fs.existsSync(a.file)) throw new Error('the artifact file for ' + a.id + ' is missing on disk');
    return a;
  }

  /**
   * buildPrompt — instructs the model with an explicit, checkable output contract.
   * Wording is versioned (PROMPT_VERSION) because it is part of the cache key.
   */
  function buildPrompt(language) {
    return [
      'You are a speech transcription engine. Transcribe the audio EXACTLY as spoken.',
      'Return ONLY a JSON object, no prose, no markdown fence:',
      '{"language":"<bcp47 or plain name>","text":"<full transcript>","segments":[{"start":<seconds>,"end":<seconds>,"text":"<that span>","words":[{"text":"<spoken word>","start":<seconds>,"end":<seconds>}]}]}',
      'RULES:',
      '1. Transcribe verbatim in the original language and script (Arabic in Arabic script, Darija as spoken).',
      '2. Segment on natural pauses or sentences. Each segment 1-8 seconds. Never overlap.',
      '3. "start" and "end" are seconds from the beginning of the audio. They must increase.',
      '4. Do not translate, summarize, clean up or invent words. If audio is unclear, transcribe what you hear.',
      '5. If a span has no speech, do not emit a segment for it.',
      'Provide timestamps for EVERY spoken word from the actual audio. Word boundaries must be ordered, non-overlapping and inside their segment. Do not distribute time uniformly; listen to actual speech and pauses.',
      language && language !== 'auto' ? ('6. The speech is expected to be in: ' + language + '.') : '6. Detect the language yourself.',
      'Output the JSON object only.',
    ].join('\n');
  }

  /**
   * normalise — coerce a model JSON reply into a validated transcript.
   * Anything that cannot be validated is dropped rather than trusted; the caller is told how many.
   */
  function normalise(raw, duration) {
    let data = U.extractJSON ? U.extractJSON(raw) : null;
    if (!data) { try { data = JSON.parse(raw); } catch (_) {} }
    if (!data || typeof data !== 'object') {
      // The model answered with prose instead of the JSON contract. Throwing the whole transcript
      // away would lose real work, so it is kept as an UNSEGMENTED transcript: the words, no
      // timings, labelled as such. Inventing boundaries to fill the gap is the one thing this
      // service must never do — captions built on invented timings would be silently wrong.
      const text = U.sanitizeText(String(raw || '').trim(), 20000);
      if (!text) throw new Error('the transcription model returned nothing at all for this audio');
      if (isRefusalText(text)) throw new Error('the transcription model returned no usable segments (audio may be silent)');
      return { language: null, text, segments: [], dropped: 0, repaired: 0, unsegmented: true };
    }
    const rawSegs = Array.isArray(data.segments) ? data.segments : [];
    const max = Math.max(0.5, Number(duration) || 0);
    const segs = [];
    let dropped = 0, repaired = 0;
    // Optional provider evidence. A partial or malformed word timeline is discarded: deriving
    // one from characters would make a karaoke highlight look more precise than it is.
    function normaliseWords(rawWords, segStart, segEnd) {
      if (!Array.isArray(rawWords) || !rawWords.length || rawWords.length > 300) return null;
      const words = [];
      let previous = segStart;
      for (const item of rawWords) {
        if (!item || typeof item !== 'object') return null;
        const text = U.sanitizeText(String(item.word == null ? (item.text == null ? item.token : item.text) : item.word).replace(/\s+/g, ' ').trim(), 120);
        const start = Number(item.start), end = Number(item.end);
        if (!text || !isFinite(start) || !isFinite(end) || start < segStart - 0.02 || end > segEnd + 0.02 || end <= start || start < previous - 0.02) return null;
        words.push({ text, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100,
          ...(Number.isFinite(item.probability) ? { probability: item.probability } : {}) });
        previous = end;
      }
      return words;
    }
    for (const s of rawSegs.slice(0, 600)) {
      if (!s || typeof s !== 'object') { dropped++; continue; }
      const text = U.sanitizeText(String(s.text == null ? '' : s.text).replace(/\s+/g, ' ').trim(), 600);
      if (!text) { dropped++; continue; }
      if (isRefusalText(text)) { dropped++; continue; }
      let start = Number(s.start), end = Number(s.end);
      if (!isFinite(start) || !isFinite(end)) { dropped++; continue; }
      if (start < 0) { start = 0; repaired++; }
      if (end > max + 0.5) { end = max; repaired++; }
      if (end <= start) { end = Math.min(max, start + Math.max(0.6, (end - start) || 0.6)); repaired++; }
      if (end <= start) { dropped++; continue; }
      const cleanStart = Math.round(start * 100) / 100;
      const cleanEnd = Math.round(end * 100) / 100;
      segs.push({ start: cleanStart, end: cleanEnd, text, wordTimings: normaliseWords(s.words || s.word_timings || s.wordTimings, cleanStart, cleanEnd) });
    }
    // enforce a single ordered, non-overlapping timeline — a hallucinated overlap would produce
    // captions that stack on screen, so it is repaired here rather than rendered.
    segs.sort((a, b) => a.start - b.start);
    const out = [];
    for (const s of segs) {
      const prev = out[out.length - 1];
      if (prev && s.start < prev.end) { s.start = prev.end; repaired++; if (s.end <= s.start) { dropped++; continue; } }
      out.push(s);
    }
    const text = U.sanitizeText(String(data.text || out.map(s => s.text).join(' ')).trim(), 20000);
    return {
      language: U.sanitizeText(String(data.language || ''), 40) || null,
      text, segments: out.map((s, i) => ({ id: 'S' + (i + 1), start: s.start, end: s.end, text: s.text, words: s.wordTimings || null })),
      dropped, repaired,
    };
  }

  /**
   * run — transcribe a project artifact. Resumable-friendly: every stage reports through `progress`,
   * and the result is persisted before it is returned, so a restart mid-way loses nothing already
   * written.
   */
  async function run(opts) {
    const project = store.project(opts.projectId);
    if (!project) throw new Error('unknown project: ' + opts.projectId);
    const referenceOnly=opts.localOnly===true && opts.requireWordAlignment!==true;
    const aligned = opts.requireWordAlignment === true || referenceOnly;
    const cfg = { language: opts.language || 'auto', model: referenceOnly?'faster-whisper-small-reference-v1':aligned ? 'faster-whisper-small-forced-v4' : opts.model || null, rate: 16000, referenceHash: aligned ? U.hash16(opts.vocabulary || '') : '' };

    const artifact = resolveSource(project, opts.artifactId);
    const srcFp = sourceFingerprint(artifact, artifact.file);
    const cfgFp = configFingerprint(cfg);

    if (!opts.force) {
      const hit = findCached(project.id, srcFp, cfgFp);
      if (hit) {
        activity({ type: 'model.call', kind: 'transcription', label: 'Using cached transcription', task: 'transcribe', capability: 'transcription', model: hit.model, policy: cfg.model || 'auto', status: 'ok', ms: 0, cached: true, project: project.id, page: project.page, text: 'cached' });
        log('info', 'transcription.cache_hit', { project: project.id, transcription: hit.id });
        return { transcription: hit, cached: true };
      }
    }

    // ---- 1. audio ----
    opts.progress && opts.progress('preparing audio', 8);
    const audio = await media.extractAudio(project.id, artifact.file, { cacheDir, rate: cfg.rate });
    if (opts.note) opts.note('audio ' + (audio.cached ? 'from cache' : 'extracted') + ' (' + Math.round(audio.bytes / 1024) + ' KB)');

    if (aligned) {
      const root = path.resolve(__dirname, '..');
      const python = process.env.VS_SPEECH_PYTHON || path.join(root, 'tools', 'speech-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (!fs.existsSync(python)) throw Error('Install the studio speech runtime before creating karaoke captions. Estimated timestamps are not allowed.');
      const requestFile = path.join(cacheDir, 'words-' + srcFp + '-' + cfgFp + '.json');
      const expectedEnglish = /english|^en$/i.test(cfg.language);
      U.writeJsonAtomic(requestFile, { audio: audio.file, model: 'small', model_dir: process.env.VS_SPEECH_MODELS_DIR || path.join(root, 'tools', 'speech-models'),
        language: expectedEnglish ? 'en' : /arabic|darija|^ar/i.test(cfg.language) ? 'ar' : null,
        vocabulary: opts.vocabulary || '' });
      opts.progress && opts.progress('transcribing final audio · actual word boundaries', 45);
      const started = Date.now();
      const progressFile = requestFile + '.progress.json';
      if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
      let phase;
      const timer = setInterval(() => {
        const p = U.readJson(progressFile, null);
        if (p?.stage && p.stage !== phase) { phase = p.stage; opts.progress && opts.progress(p.stage, p.percent); }
      }, 2000);
      let result;
      try { result = await U.run(python, [path.join(root, 'tools/transcribe-audio.py'), requestFile], { timeoutSec: 1200, cwd: root }); }
      finally { clearInterval(timer); }
      const decoded = JSON.parse(result.out.trim());
      const duration = artifact.probe?.duration || audio.probe?.duration || 0;
      const norm = normalise(JSON.stringify(decoded), duration);
      if (!referenceOnly && (!norm.segments.length || norm.dropped || norm.repaired || norm.segments.some(s => !s.words?.length)))
        throw Error('Audio transcription did not return a complete usable word timeline. Captions were not guessed.');
      const words = norm.segments.flatMap(s => s.words || []);
      const expectedCount = String(opts.vocabulary || '').split(/\s+/).filter(Boolean).length;
      if (!referenceOnly && (words[0].start > 1.5 || words.at(-1).end < duration - 2.5 || expectedCount && words.length < expectedCount * .65))
        throw Error('Transcription missed part of the narration. Incomplete captions were not rendered.');
      if (words.some((w, i) => w.end <= w.start || w.end > duration + .05 || i > 0 && w.start < words[i - 1].end - .02))
        throw Error('Audio word boundaries failed validation.');
      const rec = store.saveTranscription({ project: project.id, page: project.page, sourceArtifact: artifact.id,
        provider: 'local', model: 'faster-whisper-small', language: norm.language, duration, text: norm.text,
        segments: norm.segments, recognisedText: decoded.recognisedText, alignment: decoded.alignment,boundaryRepairs:decoded.boundaryRepairs||0, timing: referenceOnly?'speech_recognition':'audio_word_alignment', wordTimings: true, status: 'ready',noSpeech:!norm.segments.length,
        precisionNote: referenceOnly?'Independent ASR of the reference audio. Machine recognition may be incomplete or mistaken; this is not a supplied narration script.':'Audio transcribed independently, then the known TTS script is forced-aligned to that audio using cross-attention/DTW. No uniform interpolation. Machine alignment still needs listening review.'+(decoded.boundaryRepairs?' Conflicting windows were reconciled using matching independent ASR word boundaries.':''),
        sourceFingerprint: srcFp, configFingerprint: cfgFp, elapsedMs: Date.now() - started, audioBytes: audio.bytes });
      log('info', 'transcription.aligned', { project: project.id, id: rec.id, words: words.length });
      return { transcription: rec, cached: false };
    }

    // ---- 2. transcribe ----
    opts.progress && opts.progress('transcribing', 35);
    const buf = fs.readFileSync(audio.file);
    const prompt = buildPrompt(cfg.language);
    const started = Date.now();
    let raw = '';
    // The transport writes back the model the router actually used (`call.__model`). That is the
    // only way to store a true model on the record — guessing it from the request would be a lie
    // whenever the router fell back.
    const call = { page: project.page, project: project.id, workload: 'transcription' };
    try {
      raw = await llm.transcribe(opts.model || null, prompt, buf, 'audio/wav', call);
    } catch (e) {
      throw new Error('transcription failed: ' + e.message);
    }
    const ms = Date.now() - started;
    const usedModel = opts.model || call.__model || (o.lastModel && o.lastModel()) || 'router-selected';
    if (opts.note) opts.note('model reply ' + Math.round(raw.length / 1024) + ' KB in ' + ms + 'ms');

    // ---- 3. validate ----
    opts.progress && opts.progress('validating timestamps', 72);
    const duration = (artifact.probe && artifact.probe.duration) || (audio.probe && audio.probe.duration) || 0;
    const norm = normalise(raw, duration);
    if (!norm.segments.length && !norm.unsegmented) throw new Error('the transcription model returned no usable segments (audio may be silent)');

    // ---- 4. persist ----
    opts.progress && opts.progress('saving transcript', 90);
    const rec = store.saveTranscription({
      project: project.id, page: project.page,
      sourceArtifact: artifact.id, provider: 'google', model: usedModel,
      language: norm.language, duration,
      text: norm.text, segments: norm.segments,
      // `none` means the words are real but there are no timings at all: captions cannot be built
      // from this transcript, and the UI says so instead of showing fabricated timings.
      timing: norm.unsegmented ? 'none' : 'model_estimated',   // see the honesty policy at the top
      wordTimings: !!norm.segments.some(s => Array.isArray(s.words) && s.words.length),
      unsegmented: !!norm.unsegmented,
      precisionNote: norm.unsegmented
        ? 'This reply came back as plain text with no segments, so the words are stored WITHOUT timings. Re-run transcription to get a timed transcript that captions can be built from.'
        : (norm.segments.some(s => Array.isArray(s.words) && s.words.length)
          ? 'Segment times are model-estimated. Karaoke uses only provider-supplied word timings where present; other segments remain segment-timed.'
          : 'Segment times are estimated by the transcription model, not verified word alignments.'),
      dropped: norm.dropped, repaired: norm.repaired, elapsedMs: ms,
      sourceFingerprint: srcFp, configFingerprint: cfgFp,
      audioBytes: audio.bytes, audioCached: !!audio.cached,
      status: 'ready',
    });
    log('info', 'transcription.created', { project: project.id, id: rec.id, segments: rec.segments.length, ms, repaired: norm.repaired, dropped: norm.dropped });
    return { transcription: rec, cached: false };
  }

  /**
   * correct — the owner's fix for one segment. The machine transcription is never overwritten; the
   * correction lives beside it so the original remains auditable and reversible.
   */
  function correct(projectId, transcriptionId, patch) {
    const t = store.transcription(projectId, transcriptionId);
    if (!t) throw new Error('unknown transcription');
    const seg = (t.segments || []).find(s => s.id === patch.segmentId);
    if (!seg) throw new Error('unknown segment: ' + patch.segmentId);
    const text = U.sanitizeText(patch.text, 600);
    t.corrections = t.corrections || {};
    if (!text || text === seg.text) delete t.corrections[patch.segmentId];
    else t.corrections[patch.segmentId] = { text, ts: Date.now() };
    t.updated = Date.now();
    store.saveTranscription(t, true);
    return t;
  }
  function clearCorrections(projectId, transcriptionId) {
    const t = store.transcription(projectId, transcriptionId);
    if (!t) throw new Error('unknown transcription');
    t.corrections = {};
    t.updated = Date.now();
    store.saveTranscription(t, true);
    return t;
  }

  return { run, correct, clearCorrections, buildPrompt, normalise, sourceFingerprint, configFingerprint, PROMPT_VERSION, isRefusalText };
}

module.exports = { createTranscribe, PROMPT_VERSION, isRefusalText };
