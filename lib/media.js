// lib/media.js — FFmpeg tool layer. Parameterised, validated, shell-free.
// Every operation reads the project's current artifact and produces a NEW verified artifact.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const LOCK = require('./locks');
const { createQuality } = require('./quality');

const RATIOS = { '9:16': [9, 16], '1:1': [1, 1], '16:9': [16, 9], '4:5': [4, 5], '3:4': [3, 4] };

function findBinary(dir, exe) {
  // A bundled build wins; otherwise fall back to the NAME on PATH. The name has to be wrong the
  // right way round per platform: shipping this app in a container would otherwise look for
  // `ffmpeg.exe` on Linux and fail with a confusing "spawn ENOENT" at the first render.
  const bare = String(exe).replace(/\.exe$/i, '');
  const names = process.platform === 'win32' ? [exe, bare] : [bare, exe];
  try {
    const sub = fs.readdirSync(dir).find(f => /^ffmpeg-/.test(f));
    for (const n of names) {
      const p = sub ? path.join(dir, sub, 'bin', n) : path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return names[0];
}

// ---------------- schema validation ----------------
function validate(schema, args) {
  const out = {};
  for (const [k, s] of Object.entries(schema || {})) {
    let v = args ? args[k] : undefined;
    if (v === undefined || v === null || v === '') {
      if (s.required) throw new Error('missing required parameter: ' + k);
      out[k] = s.def;
      continue;
    }
    if (s.type === 'number') { const n = Number(v); if (!isFinite(n)) throw new Error(k + ' must be a number'); out[k] = U.clamp(n, s.min, s.max, s.def || 0); }
    else if (s.type === 'boolean') out[k] = !!v;
    else if (s.type === 'jsontext') {
      // A JSON payload (caption lines, an ops array, a style object). It must round-trip EXACTLY: the
      // generic text sanitiser strips quotes and backslashes, which silently turned every JSON
      // argument into an unparseable string — the reason burning captions could never succeed through
      // this path. Validated here, then handed over untouched.
      //
      // Models express JSON arguments both ways: a JSON string, or a real object/array. Both are
      // accepted, because rejecting the second made a valid plan fail validation with an error that
      // blamed the model for something the tool layer could simply have handled.
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      if (text.length > (s.max || 60000)) throw new Error(k + ' is too long (' + text.length + ' chars)');
      try { JSON.parse(text); } catch (_) { throw new Error(k + ' must be valid JSON'); }
      out[k] = text;
    }
    else if (s.type === 'string' && s.literal) {
      const text = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (text.length > (s.max || 600) || /[{}\\]/.test(text)) throw Error(k + ' must be plain display text within its length limit.');
      // ASS is written to a file, never a shell command. Keep currencies, quotes and
      // explicit line breaks exactly as entered instead of stripping $ from prices.
      out[k] = text;
    }
    else if (s.type === 'enum') { if (!s.values.includes(v)) throw new Error(k + ' must be one of ' + s.values.join(', ')); out[k] = v; }
    else if (s.type === 'path') {
      // A filesystem path: sanitizeText would strip the backslashes, destroying Windows paths.
      // Only a bounded, read-existing file path is accepted here.
      const p = String(v).slice(0, s.max || 1000);
      if (!fs.existsSync(p)) throw new Error(k + ' does not exist on disk: ' + path.basename(p));
      out[k] = path.resolve(p);
    }
    else out[k] = U.sanitizeText(v, s.max || 400);
  }
  return out;
}

function createMedia(o) {
  const store = o.store;
  const log = o.log || (() => {});
  const FFMPEG = o.ffmpeg || findBinary(path.join(o.root, 'tools', 'ffmpeg'), 'ffmpeg.exe');
  const FFPROBE = o.ffprobe || findBinary(path.join(o.root, 'tools', 'ffmpeg'), 'ffprobe.exe');
  const bridge = o.bridge || {};              // { tts(text,voice,rate)->file, music(url)->file }
  const quality = o.quality || createQuality();
  const FONT = findFont();

  function findFont() {
    for (const f of ['C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']) {
      try { if (fs.existsSync(f)) return f; } catch (_) {}
    }
    return null;
  }

  /**
   * probeStrict — same measurement as probe(), but it THROWS instead of returning null.
   * Callers that need to know "did this actually work" (so they can retry against a refreshed source
   * URL) cannot tell that apart from a null result, which is why this exists.
   */
  function probeStrict(file) {
    return U.run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutSec: 60 })
      .then(({ out }) => {
        const d = JSON.parse(out);
        const v = (d.streams || []).find(s => s.codec_type === 'video') || {};
        const a = (d.streams || []).find(s => s.codec_type === 'audio');
        const fps = v.r_frame_rate ? Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1] || 1) : 0;
        return {
          duration: Math.round((Number(d.format && d.format.duration) || 0) * 100) / 100,
          width: v.width || 0, height: v.height || 0, fps: Math.round(fps * 100) / 100, hasAudio: !!a,
          size: Number(d.format && d.format.size) || 0, frameCount: Number(v.nb_frames) || null,
        };
      });
  }

  function probe(file) {
    return U.run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutSec: 60 })
      .then(({ out }) => {
        const d = JSON.parse(out);
        const v = (d.streams || []).find(s => s.codec_type === 'video') || {};
        const a = (d.streams || []).find(s => s.codec_type === 'audio');
        const fps = v.r_frame_rate ? Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1] || 1) : 0;
        return {
          duration: Math.round((Number(d.format && d.format.duration) || 0) * 100) / 100,
          width: v.width || 0, height: v.height || 0, fps: Math.round(fps * 100) / 100,
          hasVideo: !!v.width, hasAudio: !!a, size: Number(d.format && d.format.size) || fs.statSync(file).size,
        };
      })
      .catch(() => null);
  }

  // cwd matters: the subtitles filter is passed a bare filename and resolved against the
  // process working directory, which sidesteps Windows filter-path escaping entirely.
  const ff = (args, timeoutSec, cwd) => U.run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeoutSec: timeoutSec || 600, cwd });

  function nextFile(projectId, op, ext) {
    const dir = store.projectDir(projectId);
    const n = fs.readdirSync(dir).filter(f => f.startsWith(op + '_v')).length + 1;
    return path.join(dir, op + '_v' + n + (ext || '.mp4'));
  }

  function inputOf(project, fallbackKey) {
    if (fallbackKey) {
      const a = store.artifact(fallbackKey);
      if (a && fs.existsSync(a.file)) return a.file;
    }
    const cur = project.current ? store.artifact(project.current) : null;
    if (cur && cur.file && fs.existsSync(cur.file) && cur.kind === 'video') return cur.file;
    if (project.source && project.source.file && fs.existsSync(project.source.file)) return project.source.file;
    throw new Error('no source video in this project yet');
  }

  // ---------------- ASS builder (handles Arabic shaping + bidi correctly) ----------------
  function assTime(t) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  // 9 alignment slots — ASS numpad layout (1-3 bottom, 4-6 middle, 7-9 top)
  const ASS_ALIGN = {
    'bottom-left': 1, bottom: 2, 'bottom-right': 3,
    'mid-left': 4, center: 5, 'mid-right': 6,
    'top-left': 7, top: 8, 'top-right': 9,
  };
  /** #rrggbb → ASS &HAABBGGRR (ASS is BGR, and alpha is inverted 00=opaque). */
  function assColor(hex, opacity) {
    const c = String(hex || '#ffffff').replace('#', '');
    const r = (c.slice(0, 2) || 'ff'), g = (c.slice(2, 4) || 'ff'), b = (c.slice(4, 6) || 'ff');
    const inv = opacity == null ? 0 : Math.round((1 - U.clamp(opacity, 0, 1, 1)) * 255);
    return '&H' + inv.toString(16).padStart(2, '0').toUpperCase() + b.toUpperCase() + g.toUpperCase() + r.toUpperCase();
  }
  /**
   * STYLE_DEFAULTS — the neutral baseline every caption style starts from.
   * Deliberately a handful of honest defaults rather than a wall of fake presets; each field here
   * maps to a real ASS style attribute.
   */
  const STYLE_DEFAULTS = {
    font: 'Tahoma', size: 64, bold: true, weight: 'bold',
    color: '#ffffff', outlineColor: '#000000', outline: 3, shadow: 1,
    background: null, backgroundOpacity: 0.55,
    align: 'bottom', position: 'bottom', x: 50, y: 88,
    lineSpacing: 0, maxCharsPerLine: 24, maxLines: 2,
    uppercase: false, boxed: false, safeMarginX: 72, safeMarginBottom: 120, safeMarginTop: 110,
  };
  const CAPTION_PRESETS = {
    clean:        { label: 'Clean',          size: 56, bold: false, color: '#ffffff', outline: 3, shadow: 1, y: 84, background: null, maxCharsPerLine: 24, maxLines: 2 },    bold_social:  { label: 'Bold Social',  size: 56, bold: true,  color: '#ffffff', outline: 4, shadow: 2, y: 78, uppercase: true, maxCharsPerLine: 18, maxLines: 2 },
    karaoke:      { label: 'Karaoke',        size: 68, bold: true,  color: '#ffffff', outline: 5, shadow: 1, y: 80, highlight: '#ffe04b', wordHighlight: true, maxCharsPerLine: 18, maxLines: 2 },
    word_highlight:{ label: 'Word Highlight',size: 66, bold: true,  color: '#ffffff', outline: 5, shadow: 1, y: 80, highlight: '#45e0a8', wordHighlight: true, maxCharsPerLine: 20, maxLines: 2 },
    minimal:      { label: 'Minimal',        size: 46, bold: false, color: '#f2f2f2', outline: 2, shadow: 0, y: 86, background: null, maxCharsPerLine: 28, maxLines: 2 },
    top_captions: { label: 'Top Captions',   size: 58, bold: true,  color: '#ffffff', outline: 4, shadow: 1, align: 'top', position: 'top', y: 12, maxCharsPerLine: 22, maxLines: 2 },
    tech:         { label: 'Tech',           size: 60, bold: true,  color: '#eaf6ff', outline: 4, shadow: 1, y: 80, background: '#0b1220', boxed: true },
  };

  // Unicode bidi isolates preserve Arabic reading order while keeping product names, numbers and
  // currency in their natural LTR order. This is standards-based isolation, never string reversal.
  function bidiSafeText(value) {
    const text = String(value == null ? '' : value);
    if (!/[\u0600-\u06ff]/.test(text) || !/[A-Za-z0-9]/.test(text)) return text;
    return text.replace(/[A-Za-z][A-Za-z0-9+._-]*(?:\s+[A-Za-z0-9+._-]+)*|\d+(?:[.,]\d+)?(?:\s*(?:DH|MAD|USD|EUR|درهم))?/gi, m => '\u2068' + m + '\u2069');
  }
  /**
   * buildASS — one ASS document from timed lines plus an optional style.
   *
   * libass does the Arabic shaping and bidi layout, which is why text and captions go through ASS
   * rather than drawtext. Per-line `style`/`position` overrides let a caption segment differ from
   * the track default without a second render pass.
   */
  function buildASS(lines, probeInfo, opts) {
    opts = opts || {};
    const W = probeInfo && probeInfo.width ? probeInfo.width : 1080;
    const H = probeInfo && probeInfo.height ? probeInfo.height : 1920;
    const scale = H / 1920;
    const st = { ...STYLE_DEFAULTS, ...(opts.style || {}) };
    const s = v => Math.round(U.clamp(v, 12, 200) * (scale < 0.5 ? 0.5 : scale));
    const font = st.font || 'Tahoma';
    const size = s(st.size || opts.size || 64);
    const align = ASS_ALIGN[st.align || st.position || 'bottom'] || 2;
    // vertical margin: y is a percentage of frame height, converted into the ASS margin for the
    // chosen alignment. This is what makes a dragged caption land where the owner dropped it.
    const yPct = U.clamp(st.y == null ? 88 : st.y, 2, 98);
    const vertical = align <= 3 ? Math.round(H * (1 - yPct / 100)) : align <= 6 ? Math.round(H * (0.5 - yPct / 100)) : Math.round(H * (yPct / 100));
    const marginV = Math.max(0, Math.min(H - 10, vertical));
    const boxed = st.boxed || st.background;
    const style = [
      'Def', font, size,
      assColor(st.wordHighlight ? (st.highlight || '#ffe04b') : st.color, 1),
      // Karaoke starts at SecondaryColour and fills into PrimaryColour through real word timings.
      assColor(st.color, 1),
      assColor(st.outlineColor || '#000000', 1),
      boxed ? assColor(st.background || '#000000', st.backgroundOpacity == null ? 0.55 : st.backgroundOpacity) : assColor('#000000', 0.4),
      (st.bold || st.weight === 'bold') ? -1 : 0, 0, 0, 0, 100, 100, 0, 0,
      boxed ? 3 : 1,
      U.clamp(st.outline == null ? 3 : st.outline, 0, 12),
      U.clamp(st.shadow == null ? 1 : st.shadow, 0, 12),
      align, Math.max(40, Math.round((st.safeMarginX || 72) * W / 1080)), Math.max(40, Math.round((st.safeMarginX || 72) * W / 1080)), marginV, 1,
    ].join(',');
    const head = [
      '[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes',
      'PlayResX: ' + W, 'PlayResY: ' + H, '', '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: ' + style,
      '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const body = lines.map(l => {
      const a = ASS_ALIGN[(l.style && l.style.align) || l.position || st.align || 'bottom'] || align;
      const y = l.style && l.style.y != null ? l.style.y : yPct;
      const v = a <= 3 ? Math.round(H * (1 - y / 100)) : a <= 6 ? Math.round(H * (0.5 - y / 100)) : Math.round(H * (y / 100));
      let text = bidiSafeText(l.text).replace(/\r?\n/g, '\\N');
      if ((l.style && l.style.uppercase) || (!l.style && st.uppercase)) text = text.toUpperCase();
      if (U.sanitizeText(text, 4000) === '' && text !== '') text = '';   // never emit control chars
      const lineStyle = { ...st, ...(l.style || {}) };
      const timedWords = Array.isArray(l.wordTimings) ? l.wordTimings : null;
      // Never derive \k durations from a segment. It is only emitted for a complete, ordered
      // timestamp list supplied by transcription.
      if (lineStyle.wordHighlight && timedWords && timedWords.length && Number.isInteger(lineStyle.activeWord)) {
        // Discrete word highlighting uses each actual word onset, preserving pauses and RTL.
        const phrase = Array.isArray(lineStyle.phraseWords) ? lineStyle.phraseWords : timedWords.map(w => w.text);
        // One word per event keeps Arabic shaping intact: inline colour runs can reorder RTL.
        text = bidiSafeText(phrase[lineStyle.activeWord] || '').replace(/[{}\\]/g, '');
      } else if (lineStyle.wordHighlight && timedWords && timedWords.length) {
        const safeWords = timedWords.map(w => ({ text: bidiSafeText(w.text).replace(/[{}\\\\]/g, ''), start: Number(w.start), end: Number(w.end) }))
          .filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start);
        if (safeWords.length === timedWords.length) text = safeWords.map(w => '{\\k' + Math.max(1, Math.round((w.end - w.start) * 100)) + '}' + w.text).join(' ');
      }
      const emph = (l.style && l.style.emphasis) || l.emphasis;
      const tags = '\\an' + a + (Number.isInteger(lineStyle.activeWord) ? '\\fscx94\\fscy94\\t(0,90,\\fscx100\\fscy100)' : '') + (emph === 'highlight' ? '\\c&H00FFFF&' : '');
      return 'Dialogue: 0,' + assTime(l.start) + ',' + assTime(l.end) + ',Def,,0,0,' + Math.max(0, Math.min(H - 10, v)) + ',,' + '{' + tags + '}' + text;
    });
    return head.concat(body).join('\n');
  }
  const subsFilter = name => 'subtitles=' + name + (process.env.VS_FONTS_DIR && fs.existsSync(process.env.VS_FONTS_DIR) ? ':fontsdir=' + process.env.VS_FONTS_DIR.replace(/\\/g,'/').replace(/:/g,'\\:') : '');
  function writeASS(dir, lines, probeInfo, opts) {
    const f = path.join(dir, 'subs_' + Date.now() + '.ass');
    fs.writeFileSync(f, buildASS(lines, probeInfo, opts), 'utf8');
    return f;
  }

  // ---------------- operations ----------------
  const ops = {
    trim: {
      label: 'Trim',
      desc: 'Cut the video to a time range.',
      params: { start: { type: 'number', min: 0, max: 7200, required: true }, duration: { type: 'number', min: 0.2, max: 7200, required: true } },
      async run({ project, params, ctx, file }) {
        const p = await probe(file);
        const start = Math.min(params.start, Math.max(0, (p ? p.duration : params.start + params.duration) - 0.2));
        const dur = Math.min(params.duration, Math.max(0.2, (p ? p.duration - start : params.duration)));
        const out = nextFile(project.id, 'trim');
        ctx.progress('trimming ' + start + 's → ' + (start + dur).toFixed(1) + 's', 30);
        await ff(['-ss', String(start), '-i', file, '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', out]);
        return { file: out, params: { start, duration: Math.round(dur * 100) / 100 } };
      },
    },
    crop_ratio: {
      label: 'Aspect ratio',
      desc: 'Crop to a target aspect ratio (9:16, 1:1, 16:9, 4:5, 3:4).',
      params: { ratio: { type: 'enum', values: Object.keys(RATIOS), def: '9:16' } },
      async run({ project, params, ctx, file }) {
        const [rw, rh] = RATIOS[params.ratio];
        const out = nextFile(project.id, 'crop');
        ctx.progress('cropping to ' + params.ratio, 30);
        await ff(['-i', file, '-vf', `crop='min(iw,ih*${rw}/${rh})':'min(ih,iw*${rh}/${rw})'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', out]);
        return { file: out, params };
      },
    },
    resize: {
      label: 'Resize',
      desc: 'Scale the video to exact width/height (height -2 keeps aspect).',
      params: { width: { type: 'number', min: 128, max: 3840, def: 1080 }, height: { type: 'number', min: -2, max: 3840, def: -2 } },
      async run({ project, params, ctx, file }) {
        const out = nextFile(project.id, 'resize');
        ctx.progress('resizing', 30);
        await ff(['-i', file, '-vf', `scale=${params.width}:${params.height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', out]);
        return { file: out, params };
      },
    },
    speed: {
      label: 'Speed',
      desc: 'Change playback speed (0.25x - 3x).',
      params: { factor: { type: 'number', min: 0.25, max: 3, def: 1.15 } },
      async run({ project, params, ctx, file }) {
        const s = params.factor;
        const out = nextFile(project.id, 'speed');
        ctx.progress('speeding ' + s + 'x', 30);
        const at = []; for (let f = s; f > 2; f /= 2) at.push('atempo=2'); // atempo accepts 0.5-2, so chain for extremes
        const chain = `[0:v]setpts=${(1 / s).toFixed(4)}*PTS[v]`;
        let audio = '';
        if (s > 2) audio = `[0:a]${at.join(',')},atempo=${(s / Math.pow(2, at.length)).toFixed(4)}[a]`;
        else if (s < 0.5) audio = `[0:a]atempo=${(s * 2).toFixed(4)},atempo=0.5[a]`;
        else audio = `[0:a]atempo=${s.toFixed(4)}[a]`;
        const hasAudio = (await probe(file) || {}).hasAudio;
        const fc = hasAudio ? `${chain};${audio}` : chain;
        const maps = hasAudio ? ['-map', '[v]', '-map', '[a]'] : ['-map', '[v]'];
        await ff(['-i', file, '-filter_complex', fc, ...maps, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', out]);
        return { file: out, params };
      },
    },
    overlay_text: {
      label: 'Text overlay',
      desc: 'Burn a timed text overlay (Arabic-safe, libass). position: top|center|bottom.',
      params: {
        text: { type: 'string', max: 200, required: true },
        at: { type: 'number', min: 0, max: 7200, def: 0 },
        duration: { type: 'number', min: 0.3, max: 7200, def: 3 },
        size: { type: 'number', min: 12, max: 160, def: 64 },
        position: { type: 'enum', values: ['top', 'center', 'bottom', 'bottom-left', 'bottom-right'], def: 'bottom' },
        mode: { type: 'enum', values: ['update', 'add'], def: 'update' },
        layerId: { type: 'string', max: 40, def: '' },
      },
      async run({ project, params, ctx, file }) {
        const out = nextFile(project.id, 'text');
        const info = await probe(file);
        const dir = store.projectDir(project.id);
        const ass = writeASS(dir, [{ text: params.text, start: params.at, end: params.at + params.duration, position: params.position }], info, { size: params.size });
        ctx.progress('burning text overlay', 30);
        await ff(['-i', file, '-vf', subsFilter(path.basename(ass)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', out], 600, dir);
        return { file: out, params };
      },
    },
    burn_subs: {
      label: 'Captions',
      desc: 'Burn timed caption/text lines with a style. lines = JSON array of {start,end,text,style?,position?}; style = an optional JSON style object (font, size, color, outline, shadow, align, x, y, background, uppercase).',
      params: { lines: { type: 'jsontext', max: 60000, required: true }, style: { type: 'jsontext', max: 4000, def: '' } },
      async run({ project, params, ctx, file }) {
        let lines;
        try { lines = JSON.parse(params.lines); } catch (_) { throw new Error('lines must be a JSON array of {start,end,text}'); }
        if (!Array.isArray(lines) || !lines.length) throw new Error('lines must be a non-empty JSON array');
        let style = null;
        if (params.style) { try { style = JSON.parse(params.style); } catch (_) { throw new Error('style must be a JSON object'); } }
        const clean = lines.slice(0, 400).map(l => {
          const start = U.clamp(l.start, 0, 7200, 0);
          const end = U.clamp(l.end, 0, 7200, start + 3);
          return {
            start, end: end <= start ? start + 0.4 : end,
            // Sanitize each wrapped ROW separately, then rejoin with \n. The blanket
            // sanitizeText collapsed newlines into spaces, destroying the renderAll wrap —
            // captions arrived as one 140-char line that libass (WrapStyle:2 then) cut at the
            // frame edges. Multi-row display text is the intended caption contract.
            text: String(l.text || '').split(/\r?\n/).map(seg => U.sanitizeText(seg, 300)).filter(Boolean).join('\n'),
            position: ['top', 'center', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'mid-left', 'mid-right'].includes(l.position) ? l.position : undefined,
            style: l.style && typeof l.style === 'object' ? l.style : undefined,
            wordTimings: Array.isArray(l.wordTimings) ? l.wordTimings.slice(0, 100).map(w => ({ text: U.sanitizeText(w && (w.text || w.word), 120), start: Number(w && w.start), end: Number(w && w.end) })).filter(w => w.text && isFinite(w.start) && isFinite(w.end) && w.end > w.start && w.start >= start && w.end <= end) : null,
          };
        }).filter(l => l.text);
        if (!clean.length) throw new Error('no caption lines had any text');
        const out = nextFile(project.id, 'subs');
        const info = await probe(file);
        const dir = store.projectDir(project.id);
        const ass = writeASS(dir, clean, info, { style: style || { size: 52 } });
        ctx.progress('burning ' + clean.length + ' caption lines', 30);
        await ff(['-i', file, '-vf', subsFilter(path.basename(ass)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', out], 600, dir);
        return { file: out, params: { lines: clean.length, preset: (style && style.preset) || null }, captionLines: clean };
      },
    },
    volume: {
      label: 'Volume',
      desc: 'Change the audio level (0 = mute, 3 = loud).',
      params: { factor: { type: 'number', min: 0, max: 3, def: 1.5 } },
      async run({ project, params, ctx, file }) {
        const out = nextFile(project.id, 'vol');
        ctx.progress('setting volume ' + params.factor, 30);
        await ff(['-i', file, '-af', `volume=${params.factor}`, '-c:v', 'copy', out]);
        return { file: out, params };
      },
    },
    mute: {
      label: 'Mute',
      desc: 'Remove the audio track entirely.',
      params: {},
      async run({ project, ctx, file }) {
        const out = nextFile(project.id, 'mute');
        ctx.progress('removing audio', 30);
        await ff(['-i', file, '-an', '-c:v', 'copy', out]);
        return { file: out, params: {} };
      },
    },
    remove_music: {
      label: 'Music removed', desc: 'Rebuild the composition without the music layer.', params: {},
      async run({ project, ctx }) { return rebuildAudioLayers(project, { exclude: new Set(['mix_music']) }, ctx); },
    },
    remove_tts: {
      label: 'Voiceover removed', desc: 'Rebuild the composition without the TTS layer.', params: {},
      async run({ project, ctx }) { return rebuildAudioLayers(project, { exclude: new Set(['voiceover']) }, ctx); },
    },
    mute_source: {
      label: 'Source audio muted', desc: 'Mute original source audio while preserving music and TTS.', params: {},
      async run({ project, ctx }) { return rebuildAudioLayers(project, { sourceGain: 0 }, ctx); },
    },
    source_volume: {
      label: 'Source audio level', desc: 'Change original source audio without changing music or TTS.',
      params: { factor: { type: 'number', min: 0, max: 3, def: 0.5 } },
      async run({ project, params, ctx }) { return rebuildAudioLayers(project, { sourceGain: params.factor }, ctx); },
    },
    music_volume: {
      label: 'Music level', desc: 'Change only the music gain and preserve source audio and TTS.',
      params: { factor: { type: 'number', min: 0.01, max: 1, def: 0.18 } },
      async run({ project, params, ctx }) { return rebuildAudioLayers(project, { musicGain: params.factor }, ctx); },
    },
    mix_music: {
      label: 'Music',
      desc: 'Mix background music under the video audio, ducked.',
      params: { url: { type: 'string', max: 500, required: true }, title: { type: 'string', max: 120, def: '' }, volume: { type: 'number', min: 0.02, max: 1, def: 0.22 } },
      async run({ project, params, ctx, file }) {
        if (!bridge.music) throw new Error('music bridge unavailable');
        ctx.progress('downloading music', 20);
        const mfile = await bridge.music(params.url, params.title);
        const out = nextFile(project.id, 'music');
        ctx.progress('mixing music', 45);
        const info = await probe(file);
        if (info && info.hasAudio) {
          await ff(['-i', file, '-i', mfile, '-filter_complex', `[1:a]volume=${params.volume}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', out]);
        } else {
          await ff(['-i', file, '-i', mfile, '-filter_complex', `[1:a]volume=${params.volume}[a]`, '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'copy', '-c:a', 'aac', out]);
        }
        return { file: out, params };
      },
    },
    voiceover: {
      label: 'Voiceover',
      desc: 'Generate a TTS voiceover and mix it over the (attenuated) original audio.',
      params: { text: { type: 'string', max: 1500, required: true }, voice: { type: 'string', max: 40, def: '' }, rate: { type: 'number', min: 0.6, max: 1.6, def: 1 }, bed: { type: 'number', min: 0, max: 1, def: 0.15 }, audioFile: { type: 'path', max: 1000, def: '' }, preserveDuration: { type: 'boolean', def: false } },
      async run({ project, params, ctx, file }) {
        // audioFile reuse: when the caller already HAS this exact speech as a TTSArtifact file,
        // mix THAT file and never re-synthesize. The TTS stage spent real quota on this voice;
        // a render re-asking the model for the same text burned quota again (and 429'd mid-render).
        let tfile = null;
        if (params.audioFile && fs.existsSync(params.audioFile) && fs.statSync(params.audioFile).size > 512) {
          tfile = params.audioFile;
          ctx.progress('reusing the generated voice file', 25);
        } else {
          if (!bridge.tts) throw new Error('tts bridge unavailable');
          ctx.progress('generating voice', 25);
          // Owner rule (2026-09-23): the ONLY voice is Kore — pinned here too, so no op arg can
          // route Puck/Charon/Fenrir/Algenib/Aoede/Iapetus.
          tfile = await bridge.tts(params.text, 'Kore', params.rate, project.page);
        }
        const out = nextFile(project.id, 'voice');
        ctx.progress('mixing voice over video', 55);
        const info = await probe(file);
        const ti = await probe(tfile);
        const speechDur = Math.max(0.3, Number(ti && ti.duration) || Number(info && info.duration) || 0.3);
        const target = params.preserveDuration ? Math.max(speechDur, Number(info && info.duration) || 0.3) : speechDur;
        const videoDur = Number(info && info.duration) || target;
        const repeat = target > videoDur + 0.025;
        const vchain = `[0:v]trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS[v]`;
        const fc = info && info.hasAudio
          ? `${vchain};[0:a]volume=${params.bed},apad,atrim=duration=${target.toFixed(3)}[bg];[1:a]apad,atrim=duration=${target.toFixed(3)}[tts];[tts][bg]amix=inputs=2:duration=longest:dropout_transition=0[a]`
          : `${vchain};[1:a]apad,atrim=duration=${target.toFixed(3)}[a]`;
        await ff([...(repeat ? ['-stream_loop', '-1'] : []), '-i', file, '-i', tfile, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', target.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-movflags', '+faststart', out]);
        return { file: out, params: { text: params.text, voice: 'Kore', rate: params.rate, bed: params.bed, ttsDuration: speechDur, outputDuration: target, sourceDuration: videoDur, durationPolicy: repeat ? 'loop_visuals_to_tts' : target < videoDur ? 'trim_visuals_to_tts' : 'matched' } };
      },
    },
    append_cta: {
      label: 'CTA card',
      desc: 'Show the page\'s OWN CTA/profile card OVER the final CTA portion of the video (owner rule 2026-09-23): the card starts when the spoken CTA starts (ctaStartSec, from the caption/transcript timing) and covers the tail — never the whole video. Falls back to a short tail overlay when no CTA timing exists.',
      params: { platform: { type: 'enum', values: ['facebook', 'instagram'], def: 'facebook' }, ctaStartSec: { type: 'number', min: 0, max: 7200, def: 0 }, profile: { type: 'string', max: 80, def: '' }, variant: { type: 'enum', values: ['bio', 'profile'], def: 'bio' } },
      async run({ project, params, ctx, file }) {
        const page = store.page(params.profile || project.page);
        let rel = page && page.production && page.production.ctaAssets && page.production.ctaAssets[params.platform];
        if (!rel) throw new Error('no ' + params.platform + ' CTA card is configured for page ' + project.page);
        if (params.variant === 'profile') rel = path.join(path.dirname(rel), params.platform + '.MOV');
        const card = path.resolve(o.root, rel);
        if (!fs.existsSync(card)) throw new Error('configured CTA card is missing: ' + rel);
        const out = nextFile(project.id, 'cta');
        const info = await probe(file);
        const cardDur = Number((await probe(card)) && (await probe(card)).duration) || 4.9;
        const total = Number(info && info.duration) || 0;
        // Overlay window: begin at the spoken-CTA start (or the last cardDur seconds when the CTA
        // sentence timing is unavailable — a bounded tail, never the whole video). A clip too short
        // to hold a tail window (QA fixtures) simply keeps the card in the final second.
        let start = 0;
        if (total > 3.5) {
          start = params.ctaStartSec > 0
            ? Math.max(0, Math.min(Number(params.ctaStartSec), total - 1))
            : Math.max(0, total - Math.min(cardDur, Math.max(2.5, total * 0.18)));
        }
        const scaled = Math.max(0, Math.min(cardDur, Math.max(0.5, total - start)));
        ctx.progress('overlaying ' + params.platform + ' CTA card from ' + start.toFixed(1) + 's', 45);
        // Owner rule (2026-09-27): the CTA card must SAY the bio-link — a dark plate + bold white
        // "الرابط فالبيو" (or "Link in bio") burned UNDER the card's own visuals, full-window.
        // This replaces the old bare .MOV overlay which said nothing actionable.
        const bioText = /^(vouchteck|amazon_liquidation)$/i.test(page.key || '') ? 'Link in bio' : 'الرابط فالبيو';
        const bioDir = store.projectDir(project.id);
        const bioASS = path.join(bioDir, 'cta_bio_' + Date.now() + '.ass');
        // The burn event must be timed in the OUTPUT timeline — after the concat the card window
        // starts at `start`, so the bio text must also start there (a 0-based event showed the
        // text at the video's opening instead of on the card).
        const burnStart = total > start + 0.4 ? start : 0;
        fs.writeFileSync(bioASS, buildASS([{ text: bioText, start: burnStart, end: Math.max(burnStart + 0.5, burnStart + scaled), position: 'bottom' }], { width: 1080, height: 1920 }, { style: { size: 88, bold: true, color: '#ffffff', outline: 5, shadow: 2, background: '#101418', backgroundOpacity: 0.78, boxed: true, align: 'bottom', position: 'bottom', y: 84, maxCharsPerLine: 24, maxLines: 2 } }), 'utf8');
        const norm = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p';
        // Owner fix (2026-09-27): overlay=enable='between(t,..)' with a second input produced a
        // BLACK tail — repro'd standalone (tmp_repctest.js): inside the enable window the
        // composited frame came out dark because the card's frames never landed in the window.
        // The composition now SPLITS the timeline instead of overlaying: original up to the CTA
        // start + the card for the window (+ any original after it), then concat — no overlay,
        // no enable, no black. The card is burned into the stream, not composited on top.
        let fc;
        if (total > start + 0.4) {
          const head = start > 0.05;
          const tail = total > start + scaled + 0.4;
          const chains = [];
          const order = [];
          if (head && tail) {
            // [0:v] feeds two chains (head + tail) — split it explicitly first.
            chains.push(`[0:v]${norm},split=2[va][vb]`);
            chains.push(`[va]trim=end=${start.toFixed(3)},setpts=PTS-STARTPTS[b0]`);
            chains.push(`[vb]trim=start=${(start + scaled).toFixed(3)},setpts=PTS-STARTPTS[b2]`);
            order.push('[b0]');
          } else if (head) {
            chains.push(`[0:v]${norm},trim=end=${start.toFixed(3)},setpts=PTS-STARTPTS[b0]`);
            order.push('[b0]');
          } else if (tail) {
            chains.push(`[0:v]${norm},trim=start=${(start + scaled).toFixed(3)},setpts=PTS-STARTPTS[b2]`);
          }
          chains.push(`[1:v]${norm},trim=duration=${scaled.toFixed(3)},setpts=PTS-STARTPTS[b1]`);
          // The card segment always sits between the original head and tail segments.
          if (head) order.push('[b1]'); else order.unshift('[b1]');
          if (tail) order.push('[b2]');
          if (order.length === 1) {
            fc = `[1:v]${norm},trim=duration=${scaled.toFixed(3)},setpts=PTS-STARTPTS${params.variant === 'profile' ? '' : ',subtitles=' + path.basename(bioASS)}[v]`;
          } else {
            fc = chains.join(';') + `;${order.join('')}concat=n=${order.length}:v=1:a=0[vc];[vc]${params.variant === 'profile' ? 'null' : 'subtitles=' + path.basename(bioASS)}[v]`;
          }
        } else {
          fc = `[0:v]${norm},${params.variant === 'profile' ? 'null' : 'subtitles=' + path.basename(bioASS)}[v]`;
        }
        await ff(['-i', file, '-i', card, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', '-t', String(total || ''), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], 900, bioDir);
        return { file: out, params: { platform: params.platform, profile: page.key, variant: params.variant, card: rel, cardDuration: cardDur, overlayStart: start, overlayDuration: scaled, cardBurnStart: burnStart, recipe: 'cta-timed-card-concat' } };
      },
    },
    render: {
      label: 'Render',
      desc: 'Render preview (fast proxy) or final (production quality) export.',
      params: { mode: { type: 'enum', values: ['preview', 'final'], def: 'preview' }, title: { type: 'jsontext', max: 400, def: '' }, titleStyle: { type: 'jsontext', max: 1000, def: '' }, copyEncoded: { type: 'boolean', def: false } },
      async run({ project, params, ctx, file }) {
        const out = nextFile(project.id, 'render_' + params.mode);
        ctx.progress('rendering ' + params.mode, 25);
        const info = await probe(file);
        let workFile = file;
        let burnedTitle = null;
        if (params.copyEncoded && params.mode === 'final' && !params.title) {
          const input = store.artifact(project.current);
          if (input?.op !== 'social_style' || info.width !== 1080 || info.height !== 1920 || !info.hasAudio)
            throw Error('Final-copy export requires a fully encoded 1080x1920 social composition with audio.');
          // social_style already encodes H.264/AAC with faststart. Another encode only
          // loses quality and makes every presentation correction wait for a second pass.
          fs.copyFileSync(file, out);
          ctx.progress('final export · existing production encode preserved', 95);
          return { file: out, kind: 'video', params: { mode: 'final', copyEncoded: true, sourceArtifact: input.id } };
        }
        // Owner rule 2026-09-23: EVERY final video carries a clearly visible on-video title —
        // dark rounded box + bold white text near the top (TikTok/Reels product-ad style),
        // Arabic-safe via the same libass pipeline as captions. Burned BEFORE the encode pass.
        if (params.title) {
          try {
            const t = JSON.parse(params.title);
            const text = U.sanitizeText(String(t.text || ''), 120);
            if (text) {            const style = params.titleStyle ? JSON.parse(params.titleStyle) : {};
            const dir = store.projectDir(project.id);
            // Owner fix (2026-09-27): CENTER titles (ass an5, dark box) with REAL word wrap —
            // buildASS never wraps, so a long title was one huge line cut by the frame edges.
            // 16 chars/line × up to 3 lines keeps every word inside the 9:16 safe area.
            const centered = /center/i.test(String(style.position || ''));
            const wrapTitle = (s, maxChars, maxLines) => {
              const words = String(s || '').trim().split(/\s+/).filter(Boolean);
              const lines = [];
              let cur = '';
              for (const w of words) {
                const next = cur ? cur + ' ' + w : w;
                if (next.length > maxChars && cur) { lines.push(cur); cur = w; } else cur = next;
              }
              if (cur) lines.push(cur);
              if (lines.length <= maxLines) return lines.join('\n');
              const kept = lines.slice(0, maxLines - 1);
              kept.push(lines.slice(maxLines - 1).join(' '));
              return kept.join('\n');
            };
            const titleBody = style.singleLine ? text.replace(/\s+/g, ' ') : centered
              ? wrapTitle(text, 16, 3)
              : wrapTitle(text, 24, 2);
            if (style.singleLine) {
              const widthFraction = U.clamp(style.widthFraction || 0.80, 0.65, 0.92, 0.80);
              style.size = Math.min(style.size || 58, Math.max(24, Math.floor(((info.width * widthFraction) / Math.max(1, titleBody.length * 0.8)) / (info.height / 1920))));
            }
            const ass = writeASS(dir, [{
              text: titleBody,
              start: Math.max(0, Number(t.at) || 0),
              end: Number(t.end) || Math.min((info && info.duration) || 5, (Number(t.at) || 0) + (Number(t.duration) || 3.2)),
              position: centered ? 'center' : (style.position || 'top'),
            }], info, centered
              ? { style: { size: style.size || 58, bold: true, color: style.color || '#ffffff', outline: style.outline == null ? 4 : style.outline, outlineColor: style.outlineColor || '#000000', shadow: style.shadow == null ? 2 : style.shadow, background: style.background || '#101418', backgroundOpacity: style.backgroundOpacity == null ? 0.72 : style.backgroundOpacity, boxed: true, align: 'center', position: 'center', y: 50 } }
              : { style: { size: style.size || 58, bold: true, color: '#ffffff', outline: 4, shadow: 2, background: style.background || '#101418', backgroundOpacity: 0.72, boxed: true, align: style.position || 'top', position: style.position || 'top', y: style.y == null ? 9 : style.y } });
              const titled = nextFile(project.id, 'titled');
              await ff(['-i', workFile, '-vf', subsFilter(path.basename(ass)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'copy', titled], 600, dir);
              workFile = titled;
              burnedTitle = text;
              ctx.progress('title burned: ' + text.slice(0, 24), 40);
            }
          } catch (e) { ctx.note && ctx.note('title burn skipped: ' + e.message); }
        }
        const common = ['-i', workFile, '-c:a', 'aac'];
        if (params.mode === 'preview') {
          await ff([...common, '-vf', "scale=-2:'min(1280,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-b:a', '96k', '-movflags', '+faststart', out], 900);
        } else {
          await ff([...common, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-b:a', '160k', '-movflags', '+faststart', out], 1800);
        }
        return { file: out, params: { mode: params.mode, burnedTitle } };
      },
    },
    extract_frame: {
      label: 'Frame',
      desc: 'Export a single frame as a PNG (timeline thumbnails, thumbnails for posts).',
      params: { at: { type: 'number', min: 0, max: 7200, def: 0 } },
      async run({ project, params, ctx, file }) {
        const out = nextFile(project.id, 'frame', '.png');
        ctx.progress('extracting frame at ' + params.at + 's', 30);
        await ff(['-ss', String(params.at), '-i', file, '-frames:v', '1', '-q:v', '3', out]);
        return { file: out, params, kind: 'image', attach: false };
      },
    },
    proxy: {
      label: 'Proxy',
      desc: 'Generate a small fast proxy used for previews.',
      params: { height: { type: 'number', min: 240, max: 1080, def: 720 } },
      async run({ project, params, ctx, file }) {
        const out = nextFile(project.id, 'proxy');
        ctx.progress('building proxy', 30);
        await ff(['-i', file, '-vf', `scale=-2:${params.height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', out], 900);
        return { file: out, params, attach: false };
      },
    },
  };

  /** Re-render a composition from its source lineage so audio-layer commands stay precise. */
  async function rebuildAudioLayers(project, policy, ctx) {
    const chain = [];
    const seen = new Set();
    let cur = project.current ? store.artifact(project.current) : null;
    while (cur && !seen.has(cur.id)) { chain.unshift(cur); seen.add(cur.id); cur = cur.parent ? store.artifact(cur.parent) : null; }
    if (!chain.length) throw new Error('this project has no media lineage to rebuild');
    // Fold prior audio-policy commands before applying the new one. Without this, doing
    // "remove music" and then "mute original video" would replay the old music layer.
    const effective = { exclude: new Set(), sourceGain: undefined, musicGain: undefined };
    for (const art of chain) {
      if (art.op === 'mix_music') effective.exclude.delete('mix_music');
      else if (art.op === 'voiceover') effective.exclude.delete('voiceover');
      else if (art.op === 'remove_music') effective.exclude.add('mix_music');
      else if (art.op === 'remove_tts') effective.exclude.add('voiceover');
      else if (art.op === 'mute_source') effective.sourceGain = 0;
      else if (art.op === 'source_volume') effective.sourceGain = Number((art.params && art.params.audioPolicy && art.params.audioPolicy.sourceGain) ?? (art.params && art.params.factor));
      else if (art.op === 'music_volume') effective.musicGain = Number((art.params && art.params.audioPolicy && art.params.audioPolicy.musicGain) ?? (art.params && art.params.factor));
    }
    for (const op of (policy.exclude || new Set())) effective.exclude.add(op);
    if (policy.sourceGain !== undefined) effective.sourceGain = policy.sourceGain;
    if (policy.musicGain !== undefined) effective.musicGain = policy.musicGain;
    policy = effective;
    let file = chain[0].file;
    if (!file || !fs.existsSync(file)) throw new Error('the source artifact file is missing');
    const applied = [];
    if (policy.sourceGain !== undefined) {
      const baseOp = policy.sourceGain === 0 ? ops.mute : ops.volume;
      const baseParams = policy.sourceGain === 0 ? {} : { factor: policy.sourceGain };
      const r = await baseOp.run({ project, params: baseParams, ctx, file });
      file = r.file; applied.push(policy.sourceGain === 0 ? 'mute_source' : 'source_volume');
    }
    for (const art of chain.slice(1)) {
      if ((policy.exclude || new Set()).has(art.op)) continue;
      const step = ops[art.op];
      if (!step || ['remove_music', 'remove_tts', 'mute_source', 'source_volume', 'music_volume'].includes(art.op)) continue;
      let raw = { ...(art.params || {}) };
      if (art.op === 'mix_music' && policy.musicGain !== undefined) raw.volume = policy.musicGain;
      let params;
      try { params = validate(step.params, raw); }
      catch (e) { throw new Error('cannot safely rebuild legacy ' + art.op + ' layer: ' + e.message); }
      const r = await step.run({ project, params, ctx, file });
      file = r.file; applied.push(art.op);
    }
    const out = nextFile(project.id, policy.exclude && policy.exclude.has('mix_music') ? 'no_music' : policy.exclude && policy.exclude.has('voiceover') ? 'no_tts' : policy.sourceGain === 0 ? 'source_muted' : policy.musicGain !== undefined ? 'music_level' : 'source_level');
    await ff(['-i', file, '-c', 'copy', '-movflags', '+faststart', out]);
    return { file: out, params: { audioPolicy: { removeMusic: !!(policy.exclude && policy.exclude.has('mix_music')), removeTts: !!(policy.exclude && policy.exclude.has('voiceover')), sourceGain: policy.sourceGain, musicGain: policy.musicGain }, rebuilt: applied } };
  }

  /**
   * applyOp — the single entry point used by the agent tool registry and the UI.
   * Resolves input, validates params, runs ffmpeg, probes + registers the artifact.
   */
  async function applyOp(projectId, opName, args, ctx) {
    const project = store.project(projectId);
    if (!project) throw new Error('unknown project: ' + projectId);
    const op = ops[opName];
    if (!op) throw new Error('unknown operation: ' + opName);
    // LOCK ENFORCEMENT — before validation, before any file is touched. A lock declared on the
    // project (or inherited from its master) is a hard stop, not advice to the model: if the model
    // proposes a locked operation anyway, it fails here with a reason the owner can act on.
    LOCK.assertOp(store.effectiveLocks(project.id), opName);
    // Fill in whatever the caller left out. A caller passing `{ progress(){} }` without `note` used
    // to crash mid-operation on `ctx.note(...)` — a partial context is a caller convenience, not a
    // reason to fail an otherwise valid edit.
    ctx = Object.assign({ progress() {}, note() {} }, ctx || {});
    const params = validate(op.params, args);
    let file = inputOf(project, args && args.from);
    let parent = project.current || null;
    let supersedes = null;
    if (opName === 'overlay_text' && params.mode !== 'add') {
      const cur = project.current ? store.artifact(project.current) : null;
      if (cur && cur.op === 'overlay_text' && cur.parent) {
        const base = store.artifact(cur.parent);
        if (base && base.file && fs.existsSync(base.file)) {
          file = base.file; parent = cur.parent; supersedes = cur.id;
          params.layerId = params.layerId || cur.layerId || (cur.params && cur.params.layerId) || U.uid('L');
        }
      }
    }
    if (opName === 'overlay_text' && !params.layerId) params.layerId = U.uid('L');
    if (opName === 'voiceover') {
      const cur = project.current ? store.artifact(project.current) : null;
      if (cur && cur.op === 'voiceover' && cur.parent) {
        const base = store.artifact(cur.parent);
        if (base && base.file && fs.existsSync(base.file)) {
          file = base.file; parent = cur.parent; supersedes = cur.id;
          params.layerId = cur.layerId || (cur.params && cur.params.layerId) || U.uid('L');
        }
      }
      if (!params.layerId) params.layerId = U.uid('L');
    }
    const started = Date.now();
    ctx.note('op ' + opName + ' on ' + path.basename(file));
    const res = await op.run({ project, params, ctx, file });
    if (!res || !res.file || !fs.existsSync(res.file) || fs.statSync(res.file).size < 512) throw new Error(opName + ' produced no output file');
    const info = await probe(res.file);
    if (!info && res.kind !== 'image') throw new Error(opName + ' output is not a valid media file');
    const draft = {
      project: project.id, op: opName, params: res.params || params, file: res.file,
      kind: res.kind || 'video', probe: info, attach: res.attach !== false,
      label: op.label + ' v', parent, supersedes, layerId: params.layerId || null,
    };
    draft.qa = quality.inspectArtifact(draft, res.qaContext || null);
    const artifact = store.addArtifact(draft);
    log('info', 'artifact.created', { artifact: artifact.id, op: opName, project: project.id, ms: Date.now() - started, file: path.basename(artifact.file) });
    return artifact;
  }

  /**
   * extractAudio — a transcription-optimised mono PCM WAV, in the regenerable cache.
   *
   * Deliberately NOT an artifact: it is an intermediate, and the source is never modified. Keyed by
   * the source file's name+size+mtime so an unchanged source reuses the same extraction instead of
   * spending ffmpeg time (and, downstream, an API request) again.
   */
  async function extractAudio(projectId, file, opts) {
    opts = opts || {};
    const st = fs.statSync(file);
    const rate = U.clamp(opts.rate || 16000, 8000, 48000, 16000);
    const h = U.hash16(path.basename(file) + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + rate);
    const dir = U.ensureDir(o.cacheDir || path.join(store.DIR.projects, '..', 'cache'));
    const out = path.join(dir, 'asr_' + h + '.wav');
    if (fs.existsSync(out) && fs.statSync(out).size > 2048) return { file: out, cached: true, bytes: fs.statSync(out).size };
    const p = await probe(file);
    if (p && p.hasAudio === false) throw new Error('this video has no audio track to transcribe');
    // 16 kHz mono is the standard speech-recognition input and keeps the base64 payload small.
    await ff(['-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', out], 600);
    if (!fs.existsSync(out) || fs.statSync(out).size < 1024) throw new Error('could not extract an audio track (silent or corrupt audio)');
    return { file: out, cached: false, bytes: fs.statSync(out).size, probe: p };
  }

  return {
    FFMPEG, FFPROBE, font: FONT, probe, probeStrict, ops, opNames: Object.keys(ops), applyOp, ff, nextFile,
    buildASS, writeASS, subsFilter, inputOf, validate, extractAudio,
    STYLE_DEFAULTS, CAPTION_PRESETS, assColor, bidiSafeText,
  };
}

module.exports = { createMedia, RATIOS, findBinary };
