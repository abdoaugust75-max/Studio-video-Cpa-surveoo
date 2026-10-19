// lib/captions.js — the caption engine: transcript → caption track → ASS lines.
//
// TWO RULES THAT SHAPE THIS FILE
//
// 1. Timing comes from transcription data, never from a model's imagination. This module only ever
//    *selects* and *merges* real boundaries. Split boundaries are interpolated by character share
//    and are flagged `derived: 'interpolated'` so the UI can say so; splitting is opt-in and off by
//    default, because the honest default is to keep the segment boundary you actually measured.
// 2. Captions are DATA. A track is an editable, persisted, versioned list of segments — not an
//    ASS string generated once. ASS is produced only at render time, from the current segments.
'use strict';
const U = require('./util');
const LOCK = require('./locks');

// sentence-ish boundaries across Latin and Arabic punctuation
const BREAK_CHARS = /([.!?؟…؛:،,;—])\s*/;
const HARD_BREAK = /[.!?؟…؛]/;

function createCaptions(o) {
  const media = o.media;
  const store = o.store;

  /** Built-in presets come from the render engine so the UI and the renderer cannot drift. */
  function presets() {
    const base = (media && media.CAPTION_PRESETS) || {};
    const custom = store.captionStyles ? store.captionStyles() : {};
    const out = {};
    for (const [k, v] of Object.entries(base)) out[k] = { key: k, builtIn: true, ...v };
    for (const [k, v] of Object.entries(custom)) out[k] = { key: k, builtIn: false, ...out[k], ...v };
    return out;
  }
  function resolveStyle(name) {
    const p = presets();
    const chosen = p[name] || p[String(name).replace(/[^a-z0-9_]/gi, '')] || p.bold_social || {};
    const defaults = (media && media.STYLE_DEFAULTS) || {};
    const { key, builtIn, label, ...style } = chosen;
    return { ...defaults, ...style, preset: (p[name] && name) || 'bold_social' };
  }

  /** Corrected text if the owner fixed this segment, else the machine transcription. */
  function textOf(transcription, seg) {
    const c = transcription.corrections && transcription.corrections[seg.id];
    return (c && c.text) || seg.text;
  }

  /** Break one caption's text into at most `maxLines` lines of at most `maxChars` characters. */
  function wrap(text, maxChars, maxLines) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (s.length <= maxChars) return s;
    const words = s.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (next.length > maxChars && cur) { lines.push(cur); cur = w; }
      else cur = next;
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return lines.join('\n');
    // Widen the per-line budget to the minimum that fits maxLines, capped at a width that is
    // provably inside the 9:16 safe area (~26 chars at size 56 ≈ 550px of 936 available).
    // This keeps lines BALANCED; the old code merged all overflow into ONE long line that got
    // cut at both sides of the frame.
    const budget = Math.max(maxChars, Math.min(Math.ceil(s.length / maxLines), maxChars + 8));
    const bal = [];
    let cur2 = '';
    for (const w of words) {
      const next = cur2 ? cur2 + ' ' + w : w;
      if (next.length > budget && cur2) { bal.push(cur2); cur2 = w; } else cur2 = next;
    }
    if (cur2) bal.push(cur2);
    if (bal.length <= maxLines) return bal.join('\n');
    // Still too many lines: spread the words evenly over up to 4 short lines — several short
    // lines always beat one cut-off line.
    const n = Math.min(4, bal.length);
    const per = Math.ceil(words.length / n);
    const out = [];
    for (let i = 0; i < n; i++) {
      const chunk = words.slice(i * per, (i + 1) * per).join(' ');
      if (chunk) out.push(chunk);
    }
    return out.join('\n');
  }

  /**
   * buildSegments — transcript → caption segments.
   *
   * Steps, in order: take real segment boundaries → optionally merge very short adjacent segments
   * (safe: both ends are measured) → optionally split over-long ones (flagged when interpolated) →
   * wrap text to the style's line limits.
   */
  function buildSegments(transcription, opts) {
    opts = opts || {};
    const maxChars = U.clamp(opts.maxChars || 90, 12, 400, 90);
    const maxWords = U.clamp(opts.maxWords || 16, 2, 80, 16);
    const minDur = U.clamp(opts.minDuration == null ? 0.8 : opts.minDuration, 0.2, 10, 0.8);
    const maxDur = U.clamp(opts.maxDuration == null ? 6 : opts.maxDuration, 1, 30, 6);
    const mergeGap = U.clamp(opts.mergeGap == null ? 0.35 : opts.mergeGap, 0, 3, 0.35);
    const maxCharsPerLine = U.clamp(opts.maxCharsPerLine || 24, 8, 80, 24);
    const maxLines = U.clamp(opts.maxLines || 2, 1, 4, 2);
    const style = opts.style || null;
    const splitLong = !!opts.splitLongSegments;
    const punctuationAware = opts.punctuationAware !== false;

    const src = (transcription.segments || []).map(s => ({
      start: s.start, end: s.end, text: textOf(transcription, s).trim(), srcId: s.id,
      // A text correction invalidates the original word string, so it is honestly segment-timed
      // until a fresh transcript is obtained.
      wordTimings: textOf(transcription, s).trim() === String(s.text || '').trim() && Array.isArray(s.words) ? s.words : null,
    })).filter(s => s.text && s.end > s.start);

    // 1. merge short neighbours separated by a small real gap — no new timing is invented
    const merged = [];
    for (const s of src) {
      const prev = merged[merged.length - 1];
      const gap = prev ? s.start - prev.end : Infinity;
      const wouldBe = prev ? s.end - prev.start : 0;
      const words = prev ? prev.text.split(/\s+/).length + s.text.split(/\s+/).length : 0;
      if (prev && gap <= mergeGap && (prev.end - prev.start) < minDur && wouldBe <= maxDur && words <= maxWords && (prev.text + ' ' + s.text).length <= maxChars) {
        prev.text = prev.text + ' ' + s.text;
        prev.end = s.end;
        prev.wordTimings = prev.wordTimings && s.wordTimings ? [...prev.wordTimings, ...s.wordTimings] : null;
        continue;
      }
      merged.push({ ...s });
    }

    // 2. optionally split over-long segments, preferring real punctuation boundaries
    const expanded = [];
    for (const s of merged) {
      const tooLong = (s.end - s.start) > maxDur || s.text.length > maxChars || s.text.split(/\s+/).length > maxWords;
      if (!splitLong || !tooLong) { expanded.push(s); continue; }
      let parts = [s.text];
      if (punctuationAware) {
        const chunks = s.text.split(BREAK_CHARS).reduce((acc, cur, i, arr) => {
          if (i % 2 === 0) { const punct = arr[i + 1] || ''; if (cur.trim()) acc.push((cur.trim() + punct).trim()); }
          return acc;
        }, []).filter(Boolean);
        if (chunks.length > 1) parts = chunks;
      }
      // If punctuation gave us nothing to go on (one long run of words), chunk by a word/character
      // budget instead. Emitting a single part that is identical to the original would produce a
      // "split" that changes nothing while claiming an interpolated boundary — worse than not
      // splitting at all.
      if (parts.length === 1) {
        const perWords = Math.max(1, maxWords);
        const perChars = Math.max(8, Math.round(maxCharsPerLine * maxLines * 0.85));
        parts = [];
        let cur = '';
        for (const w of s.text.split(/\s+/)) {
          const candidate = cur ? cur + ' ' + w : w;
          if (cur && (candidate.length > perChars || cur.split(/\s+/).length >= perWords)) { parts.push(cur); cur = w; }
          else cur = candidate;
        }
        if (cur) parts.push(cur);
        if (parts.length > 12) {
          const head = parts.slice(0, 11), rest = parts.slice(11).join(' ');
          parts = [...head, rest];
        }
      }
      if (parts.length < 2) { expanded.push(s); continue; }   // genuinely nothing to split on

      const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
      const span = s.end - s.start;
      let cursor = s.start;
      parts.forEach((p, i) => {
        const share = p.length / totalChars;
        const dur = i === parts.length - 1 ? s.end - cursor : span * share;
        expanded.push({
          start: Math.round(cursor * 100) / 100,
          end: Math.round(Math.min(s.end, cursor + Math.max(0.3, dur)) * 100) / 100,
          text: p, srcId: s.srcId, wordTimings: null,
          // `derived` describes where THIS segment begins: the first part still starts on the real
          // measured boundary, every later part starts on a boundary computed from character share.
          derived: i === 0 ? 'measured' : 'interpolated',
        });
        cursor += dur;
      });
    }

    // 3. wrap text for display, and assign ids
    return expanded.map((s, i) => {
      const ls = style || {};
      return {
        id: 'C' + (i + 1),
        start: s.start,
        end: s.end,
        text: s.text,
        display: wrap(s.text, ls.maxCharsPerLine || maxCharsPerLine, ls.maxLines || maxLines),
        style: null,
        position: ls.align || 'bottom',
        sourceSegmentId: s.srcId || null,
        derived: s.derived || 'measured',
        words: s.text.split(/\s+/).length,
        wordTimings: Array.isArray(s.wordTimings) && s.wordTimings.length ? s.wordTimings : null,
      };
    });
  }

  /** createTrack — transcript → persisted caption track. */
  function createTrack(opts) {
    // A locked Captions layer blocks the whole caption pipeline, track edits included — burning is
    // not the only way to change what the owner sees on screen.
    LOCK.assertService(store.effectiveLocks(opts.projectId), 'caption.create');
    const t = store.transcription(opts.projectId, opts.transcriptionId);
    if (!t) throw new Error('unknown transcription: ' + opts.transcriptionId);
    // Refuse an unsegmented transcript up front and say why. A track built from it would either be
    // one giant caption or carry invented boundaries — both worse than a clear message.
    if (!(t.segments || []).length) {
      throw new Error(t.timing === 'none'
        ? 'that transcript came back without timings, so captions cannot be timed from it — re-run transcription and pick a model that returns segments'
        : 'that transcript has no speech segments to build captions from (the audio may be silent)');
    }
    const style = resolveStyle(opts.preset || 'bold_social');
    const segs = buildSegments(t, { ...(opts.options || {}), style });
    if (!segs.length) throw new Error('the transcript produced no caption segments');
    return store.saveCaptionTrack({
      project: opts.projectId, page: opts.page,
      sourceTranscription: t.id, language: t.language,
      preset: style.preset, style,
      segments: segs,
      options: opts.options || {},
      status: 'draft',
    });
  }

  /** updateTrack — apply owner edits (segments, style, preset) as a NEW version. */
  function updateTrack(opts) {
    LOCK.assertService(store.effectiveLocks(opts.projectId), 'caption.update');
    const cur = store.captionTrack(opts.projectId, opts.trackId);
    if (!cur) throw new Error('unknown caption track: ' + opts.trackId);
    // A new record that continues this track's line: same lineage, incremented version. Passing the
    // version explicitly is what keeps "v3" meaning the third edit instead of resetting to v1.
    const next = { ...cur, parent: cur.id, id: null, version: (Number(cur.version) || 1) + 1 };
    if (opts.segments) {
      const byId = new Map(opts.segments.map(s => [s.id, s]));
      next.segments = (cur.segments || []).map(s => {
        const patch = byId.get(s.id);
        if (!patch) return s;
        const text = patch.text === undefined ? s.text : U.sanitizeText(patch.text, 300);
        let start = patch.start === undefined ? s.start : U.clamp(Number(patch.start), 0, 7200, s.start);
        let end = patch.end === undefined ? s.end : U.clamp(Number(patch.end), 0, 7200, s.end);
        if (end <= start) end = Math.min(7200, start + 0.4);
        return {
          ...s, text, start, end,
          wordTimings: text === s.text && start === s.start && end === s.end ? s.wordTimings : null,
          style: patch.style === undefined ? s.style : (patch.style || null),
          position: patch.position === undefined ? s.position : patch.position,
          emphasis: patch.emphasis === undefined ? s.emphasis : patch.emphasis,
          display: wrap(text, (next.style || {}).maxCharsPerLine || 24, (next.style || {}).maxLines || 2),
        };
      }).filter(s => s.text);
    }
    if (opts.preset) { next.style = resolveStyle(opts.preset); next.preset = next.style.preset; }
    if (opts.style) { next.style = { ...(next.style || {}), ...opts.style }; next.preset = next.style.preset || next.preset; }
    if (!next.segments.length) throw new Error('a caption track cannot be empty');
    return store.saveCaptionTrack(next);
  }

  /** Lines for the render engine (burn_subs) — current data, current style. */
  function toLines(track, opts) {
    opts = opts || {};
    const style = opts.style || track.style || {};
    return (track.segments || []).map(s => ({
      start: s.start, end: s.end, text: s.text,
      position: (s.style && s.style.align) || s.position || style.align || 'bottom',
      style: { ...(style || {}), ...(s.style || {}), emphasis: s.emphasis || (s.style && s.style.emphasis) || null },
      wordTimings: Array.isArray(s.wordTimings) ? s.wordTimings : null,
    }));
  }

  /** Honest summary of what the track's timings are made of — surfaced in the UI. */
  function timingReport(track) {
    const segs = track.segments || [];
    const interpolated = segs.filter(s => s.derived === 'interpolated').length;
    return {
      total: segs.length,
      measured: segs.length - interpolated,
      interpolated,
      note: interpolated
        ? interpolated + ' of ' + segs.length + ' caption boundaries were interpolated from character share because the transcript segment was too long — the rest come from measured transcript boundaries.'
        : 'All caption boundaries come from measured transcript segments.',
    };
  }

  return { presets, resolveStyle, buildSegments, createTrack, updateTrack, toLines, wrap, timingReport, textOf };
}

module.exports = { createCaptions };
