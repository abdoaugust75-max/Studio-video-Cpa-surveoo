// lib/source.js — source discovery: turn "find me a clean iPhone unboxing video, no faces, no text"
// into a small, honestly-ranked set of REAL video candidates.
//
// Design rules learned from what went wrong before:
//
//  1. ONE search service. The UI and the orchestrator both call this, so a candidate the owner sees
//     in the grid is the same object the agent can import.
//  2. Broad search, narrow output. The upstream engine returns dozens; this module ranks and returns
//     3-6. Everything else is reported as a COUNT with the reason it was dropped, never shown.
//  3. Ranking is metadata + MEASURED signals. Each candidate carries `why` (what matched) and
//     `signals` where every field says how it was obtained: 'measured' (ffprobe on the real stream),
//     'vision' (sampled frames seen by the configured vision model), 'title' (text heuristic), or
//     'unknown'. A heuristic is never presented as a measurement.
//  4. Constraints that need eyes (faces / on-screen text) are only checked when the request actually
//     asks about them, and only on the top few candidates — this is a free-tier account and probing
//     every result with a vision model would burn the quota for no gain.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

const SIGNAL_VERSION = 'src-signals-v11-coverage-retry';
const UNBOXING_VISION_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
const UNBOXING_BACKUP_MODELS = ['gemini-2.5-flash', 'gemini-3.1-pro-preview'];
const UNBOXING_MIN_MODELS = 3;

// ------------------------------------------------------------------ intent
/**
 * Bilingual term tables. Kept as plain data because these are heuristics the owner must be able to
 * argue with — every match is reported back in `intent.matched` so the ranking is explainable.
 */
const TERMS = {
  noFaces: ['no faces', 'no face', 'faceless', 'without people', 'no people', 'nobody', 'no presenter',
    'without faces', 'no person', 'hands only', 'بدون وجه', 'بلا وجه', 'بدون أشخاص', 'بلا أشخاص', 'sans visage'],
  noText: ['no text', 'no overlay', 'no overlays', 'without text', 'no captions', 'no on-screen text',
    'clean text', 'بدون نص', 'بلا نص', 'بلا كتابة', 'بدون كتابة', 'sans texte'],
  noSlideshow: ['no slideshow', 'no slideshows', 'without slideshow', 'not a slideshow', 'بدون عرض شرائح', 'بلا عرض شرائح', 'بلا سلايدشو'],
  unboxing: ['unboxing', 'unbox', 'open box', 'فتح العلبة', 'فتح علبة', 'فتح الصندوق', 'فتح الكرتونة', 'فتح التغليف', 'انبوكسين', 'أنبوكسين', 'انبوكسنج', 'déballage'],
  handsOn: ['hands-on', 'handson', 'hands on', 'first look', 'prise en main', 'يدين'],
  closeup: ['close-up', 'closeup', 'close up', 'macro', 'detail shot', 'gros plan'],
  broll: ['b-roll', 'broll', 'b roll', 'stock footage', 'footage', 'clips'],
  review: ['review', 'test', 'hands-on review', 'comparison', 'vs'],
  clean: ['clean', 'simple', 'minimal', 'plain background', 'studio', 'neat', 'tidy'],
  product: ['product', 'device', 'gadget', 'phone', 'phones', 'smartphone', 'smartphones', 'iphone', 'samsung', 'pixel', 'xiaomi',
    'laptop', 'tablet', 'ipad', 'airpods', 'headphones', 'earbuds', 'watch', 'camera', 'drone', 'console',
    'ps5', 'xbox', 'switch', 'powerbank', 'charger', 'هاتف', 'هواتف', 'تلفون', 'تليفون', 'تليفونات', 'هواتف ذكية', 'موبايل', 'جوال'],
  vertical: ['vertical', '9:16', 'portrait', 'tiktok style', 'reel'],
  horizontal: ['horizontal', '16:9', 'landscape', 'youtube'],
};
/** Words that mark content which is NOT clean product footage, for a product-footage request. */
const NEGATIVE_TERMS = ['vlog', 'prank', 'funny', 'comedy', 'mukbang', 'reaction', 'dance', 'dancing',
  'singing', 'song', 'lyrics', 'podcast', 'interview', 'tutorial', 'rant', 'story time', 'storytime',
  'day in my life', 'get ready with me', 'grwm', 'makeup', 'skincare', 'asmr eating', 'football',
  'matches', 'gaming stream', 'live'];

function hasTerm(hay, term) {
  if (!term) return false;
  if (/[\u0600-\u06FF]/.test(term)) return hay.includes(term);
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i').test(hay);
}

/** Parse "1-60 seconds", "under 30s", "30 sec", "2 minutes", "short", "long". */
function parseDuration(text) {
  // Mentions of an opening hook are not a clip-length request (e.g. "the first 3 seconds").
  const t = String(text || '').toLowerCase().replace(/\b(?:first|opening)\s+(?:three|3)\s+(?:seconds?|secs?)\b/g, ' ');
  // "30 sec" → 30; "2 min" → 120. Minutes are the only ambiguous case, so they are matched first.
  const unitOf = u => (/^m/i.test(String(u || '')) ? 60 : 1);
  const mm = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|minutes?|mins?|min|s|m)\b/);
  if (mm) {
    const u = unitOf(mm[3]);
    return { min: Number(mm[1]) * u, max: Number(mm[2]) * u, source: 'request' };
  }
  const single = t.match(/under\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|minutes?|mins?|min|s|m)\b/)
    || t.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|minutes?|mins?|min|s|m)\b\s*(or less|max|maximum)?/);
  if (single) return { min: 0, max: Number(single[1]) * unitOf(single[2]), source: 'request' };
  if (/\bshort\b|\breel\b|\bshort-form\b|\bقصير\b/.test(t)) return { min: 4, max: 60, source: 'request' };
  if (/\blong\b|\bfull video\b/.test(t)) return { min: 60, max: 900, source: 'request' };
  if (/\bunboxing\b|\bhands-on\b|\bhook\b/.test(t)) return { min: 5, max: 120, source: 'default' };
  return { min: 4, max: 180, source: 'default' };
}

/**
 * The subject the owner asked for. A known device name wins outright; otherwise the instruction and
 * constraint words are stripped out so "hands-on samsung clip under 30 seconds" yields "samsung"
 * rather than the whole sentence.
 */
const INSTRUCTION_WORDS = new Set(['find', 'search', 'get', 'give', 'show', 'want', 'need', 'me', 'us',
  'a', 'an', 'the', 'some', 'any', 'please', 'for', 'of', 'to', 'in', 'on', 'with', 'and', 'or', 'no',
  'without', 'clean', 'nice', 'good', 'best', 'video', 'videos', 'clip', 'clips', 'footage', 'broll',
  'b-roll', 'b', 'roll', 'hands-on', 'handson', 'hands', 'on', 'unboxing', 'unbox', 'review', 'close-up',
  'closeup', 'close', 'up', 'macro', 'vertical', 'horizontal', 'portrait', 'landscape', 'under',
  'below', 'less', 'than', 'seconds', 'second', 'sec', 'secs', 'minutes', 'minute', 'min', 'mins',
  'short', 'long', 'faces', 'face', 'text', 'overlay', 'overlays', 'captions', 'presenter', 'people',
  'person', 'nobody', 'robot', 'robots', 'slideshow', 'slideshows', 'hook', 'opening', 'first', 'only', 'just', 'that', 'shows', 'showing', 'pick', 'source', 'sources', 'new']);
function parseSubject(query) {
  const q = String(query || '');
  // Do not let the old Galaxy pattern swallow the next word in "Galaxy phones".
  const m = q.match(/\b(iPhone\s?\d{0,2}\s?(?:Pro|Max|Plus|Mini|Air)?|Galaxy(?:\s+(?:[A-Z]?\d{1,3}|Ultra|Plus|FE|Fold|Flip))?|Pixel\s?\d+\S*|Xiaomi\s?\S*\d*\S*|iPad\s?\S*|AirPods\s?\S*|MacBook\s?\S*|PlayStation\s?5|PS5|Xbox\s?\S*|Switch\s?2?|DJI\s?\S+|GoPro\s?\S*|Pixel\s?\d+)\b/i);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  const words = q.split(/\s+/)
    .map(w => w.replace(/[,.;:!?()"']/g, '').trim())
    .filter(w => w.length >= 3 && /[a-zA-Z]/.test(w) && !INSTRUCTION_WORDS.has(w.toLowerCase()));
  return words.slice(0, 3).join(' ');
}

function semanticsFor(raw) {
  const h = String(raw || '').toLowerCase();
  const brand = /\b(galaxy|samsung)\b|سامسونج/.test(h) ? 'samsung' :
    /\b(iphone|apple)\b/.test(h) ? 'apple' :
    /\b(pixel|google phone)\b/.test(h) ? 'google' :
    /\b(xiaomi|redmi|poco)\b/.test(h) ? 'xiaomi' : null;
  const category = /\b(phone|phones|smartphone|smartphones|mobile|device|handset|iphone|galaxy|pixel|samsung)\b|هاتف|هواتف|تلفون|تليفون|تليفونات|موبايل|جوال/.test(h)
    ? 'smartphone' : null;
  const modelSpecific = /\b(s\d{1,3}|a\d{1,3}|z fold|z flip|ultra|pro max|iphone\s?\d+)\b/i.test(h);
  // The concrete model string, normalised the way people write it in captions — used to expand
  // discovery AROUND the model instead of flooding the pool with the whole brand.
  let model = null;
  const gm = h.match(/galaxy\s*(s\d{1,2}|a\d{1,3}|z\s*fold\d?|z\s*flip\d?)\s*(ultra|\+|plus)?/);
  const im = h.match(/iphone\s*(\d{1,2})\s*(pro max|pro|plus)?/);
  if (gm) model = ('galaxy ' + gm[1].replace(/\s+/g, '') + ' ' + (gm[2] || '')).trim();
  else if (im) model = ('iphone ' + im[1] + ' ' + (im[2] || '')).trim();
  return { brand, category, modelSpecific, model };
}

/** Strict visual gate shared by live search and regression tests. */
function visualRejectReason({ intent, signals, measured, candidate, strictVisual = true }) {
  if (strictVisual && (!signals || !signals.available)) return 'unverified';
  if (!signals || !signals.available) return null;
  if (signals.faces === true || signals.person_or_body === true) return 'faces_or_person';
  if (signals.robot_or_nonhuman === true) return 'robot_or_nonhuman';
  if (intent.wants.unboxing && (signals.text_overlay === true || signals.watermark === true)) return 'text_or_watermark';
  if (intent.wants.unboxing && (signals.faces !== false || signals.person_or_body !== false)) return 'unverified_faces';
  if (intent.wants.unboxing && (signals.text_overlay !== false || signals.watermark !== false)) return 'text_or_watermark';
  if (intent.wants.unboxing && signals.robot_or_nonhuman !== false) return 'unverified_robot_check';
  if (intent.wants.unboxing && (signals.hook_score == null || signals.hook_score < 0.6)) return 'weak_or_unverified_opening_hook';
  if (intent.wants.unboxing && (signals.quality < 0.65 || signals.usability < 0.65)) return 'low_visual_quality';
  if (intent.wants.unboxing && signals.models_checked < UNBOXING_MIN_MODELS) return 'incomplete_model_panel';
  if (intent.wants.noFaces && signals.faces !== false) return 'unverified_faces';
  if (intent.wants.noText && (signals.text_overlay !== false || signals.large_overlay === true || signals.watermark === true)) return 'text_or_watermark';
  if (intent.wants.unboxing && signals.unboxing !== true) return 'not_verified_unboxing';
  if (intent.wants.unboxing && (signals.is_real_footage !== true || signals.slideshow !== false)) return 'not_verified_real_footage';
  if (!intent.wants.unboxing && (signals.is_real_footage === false || signals.slideshow === true)) return 'not_real_footage';
  if (intent.semantics && intent.semantics.category && (signals.product_visible === false || signals.subject_match === 'none')) return 'wrong_product';
  if (intent.wants.unboxing && signals.product_visible !== true) return 'unverified_product';

  const duration = Number((measured && measured.duration) || (candidate && candidate.duration) || 0);
  const ranges = Array.isArray(signals.overlay_ranges) ? signals.overlay_ranges : [];
  const covered = duration > 0
    ? ranges.reduce((sum, r) => sum + Math.max(0, Math.min(duration, Number(r.end) || 0) - Math.max(0, Number(r.start) || 0)), 0) / duration
    : 0;
  if (covered >= 0.35 || (signals.large_overlay === true && covered >= 0.2)) return 'text_heavy';
  return null;
}

function expandedQueries(raw, intent) {
  const q = String(raw || '').trim();
  const s = intent && intent.semantics ? intent.semantics : semanticsFor(q);
  const out = [q];
  // TikTok captions frequently omit the product name; discover broadly, then
  // use frames to decide whether the actual object matches the request.
  if (s.category === 'smartphone') {
    // Exact-model requests: caption writers abbreviate differently, so expand AROUND the model
    // ("Galaxy S25 Ultra hands on", "S25 Ultra unboxing") instead of dropping to brand level —
    // broad brand queries would flood the pool with wrong-model phones the vision gate then has
    // to reject one by one. Aliases are DISCOVERY ONLY: frames still decide acceptance.
    const model = s.model;   // e.g. 'galaxy s25 ultra' | 'iphone 16 pro max' | null
    if (model) {
      const short = model.replace(/\b(galaxy|samsung|iphone|apple)\b/gi, '').replace(/\s+/g, ' ').trim();
      out.push(model + ' hands on', short + ' unboxing', short + ' close up', model + ' b roll');
      if (s.brand === 'samsung') out.push(short + ' review');
    }
    else if (s.brand === 'samsung') out.push('Samsung Galaxy phone', 'Galaxy smartphone', 'Samsung phone', 'Galaxy hands on', 'Samsung Galaxy unboxing');
    else if (s.brand === 'apple') out.push('iPhone hands on', 'Apple phone unboxing', 'iPhone close up');
    else if (s.brand === 'google') out.push('Google Pixel phone', 'Pixel smartphone hands on', 'Pixel unboxing');
    else if (s.brand === 'xiaomi') out.push('Xiaomi smartphone hands on', 'Redmi phone unboxing', 'smartphone close up');
    else out.push('smartphone unboxing', 'phone unboxing close up', 'mobile phone product footage',
      'android phone unboxing', 'smartphone hands only');
  }
  if (intent && intent.wants && intent.wants.unboxing && !s.model) out.push(
    'smartphone unboxing overhead clean video',
    'phone box opening close up no talking',
    'clean smartphone unboxing studio footage',
    'android phone unboxing hands only video',
    'smartphone unboxing hands only no captions',
    'phone unboxing hands only no watermark',
    'phone unboxing no captions no watermark',
    'phone unboxing clean video no added text',
    'clean box opening phone close up hands only',
    'phone unboxing closeup hands only no captions',
    'phone unboxing no captions no watermark',
    'new smartphone box opening hands no face',
    'minimalist smartphone unboxing clean background',
    'smartphone unboxing hands only clean background',
    'phone unboxing close up no watermark',
    'clean phone reveal box hands closeup',
    'smartphone box opening real video no captions',
    'phone unboxing no talking no captions',
  );
  return [...new Set(out.map(x => x.trim()).filter(Boolean))].slice(0, intent && intent.wants && intent.wants.unboxing ? 24 : 6);
}

function continuationQueries(intent, round) {
  const s = intent.semantics || {};
  const products = s.model ? [s.model] : s.brand ? [s.brand + ' phone']
    : ['smartphone', 'iPhone', 'Samsung Galaxy phone', 'Android phone', 'Google Pixel', 'Xiaomi phone'];
  const styles = [
    ['hands only box opening', 'top down unpacking', 'ASMR unboxing no captions', 'desk unboxing no face'],
    ['phone unboxing with hands only', 'overhead unboxing no captions', 'close up opening new box', 'minimal studio unboxing'],
    ['hands unboxing sealed box', 'silent unboxing clean footage', 'unboxing no watermark', 'unboxing plain background'],
  ][Math.max(0, Math.min(2, round - 1))];
  return products.flatMap(product => styles.map(style => product + ' ' + style));
}

/**
 * parseIntent — what the owner actually asked for. Every field is derived from the request text and
 * is echoed back to the UI so a bad ranking can be traced to a bad reading of the request.
 */
function parseIntent(query) {
  const raw = String(query || '');
  const hay = ' ' + raw.toLowerCase() + ' ';
  const wants = Object.fromEntries(Object.entries(TERMS).map(([k, list]) => [k, list.some(t => hasTerm(hay, t))]));
  const matched = {};
  for (const [k, list] of Object.entries(TERMS)) {
    const hit = list.filter(t => hasTerm(hay, t));
    if (hit.length) matched[k] = hit;
  }
  const negatives = NEGATIVE_TERMS.filter(t => hasTerm(hay, t));
  // "no faces / no text" are the only constraints that REQUIRE looking at frames. Everything else can
  // be judged from metadata, which is free.
  const semantics = semanticsFor(raw);
  const needsVision = !!(wants.noFaces || wants.noText || wants.product || wants.unboxing || wants.handsOn || wants.closeup || wants.broll || wants.review || wants.clean || semantics.category);
  const orientation = wants.vertical ? 'vertical' : wants.horizontal ? 'horizontal' : 'any';
  return {
    raw: U.sanitizeText(raw, 200),
    subject: parseSubject(raw),
    duration: parseDuration(raw),
    orientation,
    wants,
    matched,
    negatives,
    needsVision,
    expandedQueries: expandedQueries(raw, { semantics, wants }),
    // A "product footage" request is the default reading: hands-on / unboxing / review / close-up /
    // b-roll all mean the same thing for ranking purposes.
    productIntent: !!(wants.product || wants.unboxing || wants.handsOn || wants.closeup || wants.broll || wants.review || wants.clean || semantics.category),
    semantics,
  };
}

// ------------------------------------------------------------------ measurement
/**
 * withFresh — run `fn(url)` against the candidate's stream, and if that fails, resolve a fresh URL
 * for the same video and run it again.
 *
 * This exists because the discovery engine caches results for hours while the platform's CDN URLs
 * expire in minutes. Without it, a cached search is a list of dead links: measurement reports unknown
 * and frame sampling fails — which is exactly what happened before this was added. A refresh also
 * writes the working URL back onto the candidate, so the preview and the import use it too.
 */
async function withFresh(candidate, refresh, fn) {
  try { return await fn(candidate.play); }
  catch (first) {
    if (!refresh || !candidate.source) throw first;
    let fresh = null;
    try { fresh = await refresh(candidate.source); } catch (_) { throw first; }
    if (!fresh || !fresh.play || fresh.play === candidate.play) throw first;
    candidate.play = fresh.play;
    candidate.refreshed = true;
    return await fn(fresh.play);
  }
}

/**
 * measure — real ffprobe on the candidate's own stream URL.
 * This is what tells a video from a photo carousel and what the true duration and resolution are.
 * A failure after a refresh attempt is recorded as unknown, never guessed.
 */
async function measure(candidate, media, refresh) {
  const out = { known: false, url: candidate.play || '' };
  if (!candidate.play) return out;
  try {
    const p = await withFresh(candidate, refresh, url => media.probeStrict(url));
    if (!p) return out;
    out.known = true;
    out.duration = p.duration || 0;
    out.width = p.width || 0;
    out.height = p.height || 0;
    out.hasAudio = !!p.hasAudio;
    out.aspect = p.width && p.height ? Math.round((p.width / p.height) * 1000) / 1000 : 0;
    out.orientation = !p.width ? 'unknown' : p.width > p.height ? 'horizontal' : p.width === p.height ? 'square' : 'vertical';
    // A single still served as "video" shows up as an almost-static, sub-second or fps-less stream.
    out.looksStill = !!p.width && (!p.duration || p.duration < 0.6);
    out.refreshed = !!candidate.refreshed;
    return out;
  } catch (_) { return out; }
}

/**
 * visionSignals — sample a few frames from the candidate's stream and ask the configured vision model
 * the three questions the owner actually cares about. Cached forever per video id + prompt version:
 * the same candidate is never paid for twice.
 */
function frameTimes(duration) {
  const d = Number(duration) || 0;
  if (d <= 0) return [1.0];
  return [d * 0.15, d * 0.5, d * 0.85].map(t => Math.max(0.2, Math.round(t * 10) / 10));
}

function openingFrameTimes(duration) {
  const d = Number(duration) || 0;
  return [0.4, 1.2, 2.4].filter(t => !d || t < d);
}

function unboxingFrameTimes(duration) {
  const d = Number(duration) || 0;
  const opening = openingFrameTimes(d);
  if (d <= 3) return opening;
  const body = Array.from({ length: 9 }, (_, i) => Math.max(3.2, Math.min(d - 0.2, Math.round((d * (i + 1) / 10) * 10) / 10)));
  return [...new Set([...opening, ...body])].sort((a, b) => a - b);
}

async function visionSignals(candidate, m, o) {
  const cacheFile = path.join(o.cacheDir, 'sig_' + U.safeName(candidate.id, 40) + '_' + U.hash16(SIGNAL_VERSION + '|' + JSON.stringify(o.intent && o.intent.semantics || {})) + '.json');
  const hit = U.readJson(cacheFile, null);
  if (hit && hit.available) return { ...hit, cached: true };
  async function sample(times, tag) {
    const frames = [];
    for (const t of times) {
    const f = path.join(o.cacheDir, 'sig_' + U.safeName(candidate.id, 40) + '_' + String(t).replace('.', '-') + '.jpg');
    try {
      if (!fs.existsSync(f) || fs.statSync(f).size < 2048) {
        // Sampled straight from the stream at a real timestamp — never a thumbnail, so what the model
        // sees is what the video actually contains.
        // A scout frame that cannot arrive quickly is not worth stalling the whole shortlist.
        // The source can be retried/refreshed later when the owner actually imports it.
        await withFresh(candidate, o.refresh, url => o.media.ff(['-ss', String(t), '-i', url, '-frames:v', '1', '-vf', 'scale=-2:480', '-q:v', '4', f], 15));
      }
      if (fs.existsSync(f) && fs.statSync(f).size > 2048) frames.push({ time: t, data: fs.readFileSync(f) });
    } catch (_) { /* a frame we cannot extract is simply not one of the samples */ }
    }
    return frames;
  }
  const needsExactModel = !!(o.intent && o.intent.semantics && o.intent.semantics.modelSpecific);
  const needsUnboxing = !!(o.intent && o.intent.wants && o.intent.wants.unboxing);
  const videoDuration = Number(m && m.duration) || Number(candidate.duration) || 0;
  // Unboxing is a sequence, so inspect its beginning, middle and end. A phone close-up alone
  // does not prove that the clip actually shows a phone being unpacked.
  const scoutTimes = needsUnboxing
    ? unboxingFrameTimes(videoDuration)
    : needsExactModel ? frameTimes(m && m.duration) : frameTimes(m && m.duration).filter((_, i) => i !== 1);
  const sampled = await sample(scoutTimes, 'scout');
  const frames = sampled.map(x => x.data);
  if (!frames.length) return { available: false, reason: 'no frames could be sampled from this source', kind: 'no_frames', source: 'unknown' };
  if (needsUnboxing && (videoDuration <= 3 || sampled.length < 6
    || sampled.filter(x => x.time < 3).length < 2
    || !sampled.some(x => x.time >= videoDuration * 0.8))) {
    return { available: false, kind: 'insufficient_coverage', source: 'unknown',
      reason: 'not enough opening and full-clip frames to verify this unboxing', frames: frames.length };
  }
  const prompt = [
    'You are looking at ', String(frames.length), ' sampled frames from one short video, in order. Their timestamps in seconds are ', JSON.stringify(sampled.map(x => x.time)), '.',
    'The requested visual concept is: ', JSON.stringify(o.intent && o.intent.semantics || {}), '. ',
    'Answer ONLY with JSON: {"faces":true|false,"person_or_body":true|false,"robot_or_nonhuman":true|false,"hands":true|false,"text_overlay":true|false,"large_overlay":true|false,"watermark":true|false,"physical_text":true|false,"product_visible":true|false,"product":"model or null","product_category":"smartphone|tablet|laptop|other|unknown","brand":"samsung|apple|google|xiaomi|other|unknown","subject_match":"exact|brand|category|none|uncertain","subject_confidence":0..1,"is_real_footage":true|false,"slideshow":true|false,"unboxing":true|false,"hook_score":0..1,"hook_reason":"short reason","quality":0..1,"usability":0..1,"overlay_ranges":[{"start":number,"end":number,"position":"top|center|bottom|full","confidence":0..1}],"note":"<18 words>"}',
    '"faces" = a person\'s face is clearly visible. "person_or_body" excludes hands-only footage.',
    'Hands are allowed and useful. A presenter, talking head, selfie or full body is not.',
    '"robot_or_nonhuman" is true for any robot, android, animated mascot, or non-human character; reject it even if no person appears.',
    'The first three frames are from the opening seconds. Score hook_score only from those opening frames: does visible unboxing action/product immediately create curiosity? No proof means a low score.',
    '"quality" scores sharpness, lighting, stability and composition; "usability" scores whether the whole clip is clean, usable phone-unboxing footage. Use 0 to 1 conservatively.',
    '"large_overlay" is edited text covering a meaningful area. A small watermark/username is allowed.',
    'Text printed physically on a product or box is physical_text, never an edited overlay.',
    '"product_visible" = a product/device is the clear subject of the frames.',
    'For subject_match, compare the visible object to the requested concept. A Samsung Galaxy phone can be brand or exact; another object is none. Do not infer a match from hashtags alone.',
    '"is_real_footage" = real camera footage, not a still photo, slideshow, chart or animation.',
    '"unboxing" = the sampled sequence visibly shows the phone being unpacked or revealed from its packaging; a phone close-up or review alone is false.',
    '"text_overlay" includes any added caption, title, sticker or other visible writing. "watermark" separately identifies account or platform marks. Physical lettering on the phone or packaging is physical_text.',
    'Estimate overlay ranges using the supplied timestamps; a brief range is acceptable, but do not invent continuous coverage.',
    'Judge only what you can see. Output the JSON object only.',
  ].join('\n');
  const call = { page: o.page || '', project: o.project || '', workload: 'vision', task: 'source.signals' };
  try {
    const models = Array.isArray(o.visionModels) && o.visionModels.length ? [...new Set(o.visionModels)] : [o.fastModel || o.model || null];
    const votes = [];
    const failures = [];
    let scoutLikelyClean = false;
    const runVote = async model => {
      const modelCall = { ...call, task: models.length > 1 ? 'source.signals.ensemble' : call.task };
      const raw = await o.llm.vision(model, prompt, frames, 'image/jpeg', modelCall);
      const parsed = U.extractJSON(raw);
      if (!parsed || !Object.keys(parsed).length) throw new Error('model returned no usable visual verdict');
      return { model: modelCall.__model || model || 'router-selected', verdict: parsed };
    };
    if (needsUnboxing && models.length > 1) {
      // Cheap first-pass triage scans every source. Spend the three stronger calls only when the
      // scout sees a plausible clean unboxing; a bad robot/text/person clip is rejected immediately.
      try { votes.push(await runVote(models[0])); }
      catch (e) { failures.push({ model: models[0], error: U.sanitizeText(e.message, 120) }); }
      const scout = votes[0] && votes[0].verdict;
      scoutLikelyClean = !!scout && scout.faces === false && scout.person_or_body === false
        && scout.robot_or_nonhuman === false && scout.text_overlay === false && scout.watermark === false
        && scout.unboxing === true && scout.product_visible === true && scout.is_real_footage === true
        && scout.slideshow === false && Number(scout.hook_score) >= 0.6
        && Number(scout.quality) >= 0.65 && Number(scout.usability) >= 0.65;
      if (scoutLikelyClean) {
        const remaining = await Promise.allSettled(models.slice(1).map(runVote));
        const used = new Set(votes.map(v => v.model));
        for (const result of remaining) {
          if (result.status === 'fulfilled' && !used.has(result.value.model)) { votes.push(result.value); used.add(result.value.model); }
          else if (result.status === 'rejected') failures.push({ model: 'review model', error: U.sanitizeText(result.reason && result.reason.message, 120) });
        }
        for (const model of UNBOXING_BACKUP_MODELS) {
          if (used.size >= models.length) break;
          try {
            const vote = await runVote(model);
            if (!used.has(vote.model)) { votes.push(vote); used.add(vote.model); }
          } catch (e) { failures.push({ model, error: U.sanitizeText(e.message, 120) }); }
        }
      }
    } else {
      try { votes.push(await runVote(models[0])); }
      catch (e) { failures.push({ model: models[0], error: U.sanitizeText(e.message, 120) }); }
    }
    // Prefer four distinct votes, but allow three if provider fallback/rate limits prevent a fourth.
    // One scout alone can never accept a clip, and aliases/fallback duplicates never count twice.
    const partialScout = needsUnboxing && !scoutLikelyClean && votes.length === 1;
    if (votes.length < (needsUnboxing ? UNBOXING_MIN_MODELS : models.length) && !partialScout) {
      const failed = { available: false, kind: 'ensemble_incomplete', reason: failures.length + ' of ' + models.length + ' visual model checks failed', source: 'unknown', models_checked: votes.length, modelFailures: failures };
      U.writeJsonAtomic(cacheFile, failed);
      return failed;
    }
    if (new Set(votes.map(v => v.model)).size !== votes.length) {
      const failed = { available: false, kind: 'ensemble_fallback_duplicate', reason: 'the router used the same fallback model for multiple votes', source: 'unknown', models_checked: votes.length };
      U.writeJsonAtomic(cacheFile, failed);
      return failed;
    }
    const bool = (key, rule = 'any') => {
      const values = votes.map(v => v.verdict[key]).filter(x => typeof x === 'boolean');
      if (!values.length) return null;
      if (rule === 'allTrue') return values.length === votes.length && values.every(Boolean) ? true : values.some(x => !x) ? false : null;
      if (rule === 'allFalse') return values.length === votes.length && values.every(x => !x) ? false : values.some(Boolean) ? true : null;
      return values.some(Boolean) ? true : values.length === votes.length ? false : null;
    };
    const numeric = (key, method = 'mean') => {
      const values = votes.map(v => Number(v.verdict[key])).filter(Number.isFinite);
      if (!values.length) return null;
      return method === 'min' ? Math.min(...values) : values.reduce((a, b) => a + b, 0) / values.length;
    };
    const voteLabels = votes.map(v => v.model);
    let j = {
      faces: bool('faces'), person_or_body: bool('person_or_body'), robot_or_nonhuman: bool('robot_or_nonhuman'),
      hands: bool('hands'), text_overlay: bool('text_overlay'), large_overlay: bool('large_overlay'),
      watermark: bool('watermark'), physical_text: bool('physical_text'), product_visible: bool('product_visible', 'allTrue'),
      is_real_footage: bool('is_real_footage', 'allTrue'), slideshow: bool('slideshow'),
      unboxing: bool('unboxing', 'allTrue'), hook_score: numeric('hook_score', 'min'),
      hook_reason: votes.map(v => U.sanitizeText(String(v.verdict.hook_reason || ''), 100)).filter(Boolean).join(' / '),
      product: votes.map(v => v.verdict.product).find(Boolean) || null,
      product_category: votes.map(v => v.verdict.product_category).find(x => x && x !== 'unknown') || 'unknown',
      brand: votes.map(v => v.verdict.brand).find(x => x && x !== 'unknown') || 'unknown',
      subject_match: votes.map(v => v.verdict.subject_match).find(x => x === 'none') || votes[0].verdict.subject_match,
      subject_confidence: numeric('subject_confidence'), quality: numeric('quality'), usability: numeric('usability'),
      overlay_ranges: votes.flatMap(v => Array.isArray(v.verdict.overlay_ranges) ? v.verdict.overlay_ranges : []),
      note: votes.map(v => U.sanitizeText(String(v.verdict.note || ''), 60)).filter(Boolean).join('; '),
    };
    let deep = false;
    // A generic "smartphones" search needs a fast scout, not a deep-video call for every
    // candidate. The deep pass exists to settle a keep/reject decision that is genuinely in
    // doubt: an owner-requested exact model whose identity the scout could not confirm, a real
    // possibility of burned-in overlay text, or footage that does not look like real footage.
    // Low-but-usable quality alone is NOT a trigger — it was firing on nearly every candidate
    // and made discovery serial-slow without changing any accept/reject outcome.
    const identityUnknown = needsExactModel && (j.product == null || j.subject_match == null || j.subject_match === 'uncertain' || j.subject_match === 'none');
    const textSuspect = j.text_overlay === true || j.watermark === true;
    const footageSuspect = j.is_real_footage === false || j.slideshow === true;
    const unboxingUnclear = needsUnboxing && j.unboxing !== true;
    if (!needsUnboxing && (identityUnknown || textSuspect || footageSuspect || unboxingUnclear) && m && Number(m.duration) > 2) {
      const denseTimes = Array.from({ length: 7 }, (_, i) => Math.max(0.2, Math.min(Number(m.duration) - 0.2, Math.round((Number(m.duration) * (i + 1) / 8) * 10) / 10)));
      const dense = await sample(denseTimes, 'deep');
      if (dense.length >= 3) {
        const deepPrompt = prompt + '\nThis is a dense follow-up pass for an ambiguous candidate. Re-evaluate carefully and return the same JSON, with exact overlay ranges and the actual product model only when visually supported.';
        try {
          const deepRaw = await o.llm.vision(o.deepModel || 'gemini-3.7-flash', deepPrompt, dense.map(x => x.data), 'image/jpeg', { ...call, task: 'source.signals.deep' });
          j = U.extractJSON(deepRaw) || j; deep = true;
        } catch (_) { /* scout result remains valid; deep is an enhancement, not a false gate */ }
      }
    }
    const rec = {
      available: true, source: 'vision', model: voteLabels.join(', '), models: voteLabels, models_checked: votes.length,
      stage: models.length > 1 ? 'multi-model' : deep ? 'scout+deep' : 'scout', frames: frames.length,
      sample_times: sampled.map(x => x.time),
      faces: typeof j.faces === 'boolean' ? j.faces : null,
      person_or_body: typeof j.person_or_body === 'boolean' ? j.person_or_body : null,
      robot_or_nonhuman: typeof j.robot_or_nonhuman === 'boolean' ? j.robot_or_nonhuman : null,
      hook_score: U.clamp(j.hook_score, 0, 1, 0),
      hook_reason: U.sanitizeText(String(j.hook_reason || ''), 100),
      hands: typeof j.hands === 'boolean' ? j.hands : null,
      text_overlay: typeof j.text_overlay === 'boolean' ? j.text_overlay : null,
      large_overlay: typeof j.large_overlay === 'boolean' ? j.large_overlay : null,
      watermark: typeof j.watermark === 'boolean' ? j.watermark : null,
      physical_text: typeof j.physical_text === 'boolean' ? j.physical_text : null,
      product_visible: typeof j.product_visible === 'boolean' ? j.product_visible : null,
      unboxing: typeof j.unboxing === 'boolean' ? j.unboxing : null,
      product: U.sanitizeText(String(j.product || ''), 80) || null,
      product_category: U.sanitizeText(String(j.product_category || ''), 30) || 'unknown',
      brand: U.sanitizeText(String(j.brand || ''), 20) || 'unknown',
      subject_match: ['exact', 'brand', 'category', 'none', 'uncertain'].includes(j.subject_match) ? j.subject_match : 'uncertain',
      subject_confidence: U.clamp(j.subject_confidence, 0, 1, 0),
      is_real_footage: typeof j.is_real_footage === 'boolean' ? j.is_real_footage : null,
      slideshow: typeof j.slideshow === 'boolean' ? j.slideshow : null,
      quality: U.clamp(j.quality, 0, 1, 0), usability: U.clamp(j.usability, 0, 1, 0),
      overlay_ranges: Array.isArray(j.overlay_ranges) ? j.overlay_ranges.slice(0, 12).map(x => ({ start: U.clamp(x.start, 0, 7200, 0), end: U.clamp(x.end, 0, 7200, 0), position: ['top','center','bottom','full'].includes(x.position) ? x.position : 'center', confidence: U.clamp(x.confidence, 0, 1, 0) })).filter(x => x.end >= x.start) : [],
      note: U.sanitizeText(String(j.note || ''), 80),
    };
    U.writeJsonAtomic(cacheFile, rec);
    return rec;
  } catch (e) {
    // Honest failure: the constraint could not be checked. The candidate is still returned, labelled.
    return { available: false, kind: 'model_unavailable', reason: 'vision check failed: ' + U.sanitizeText(e.message, 140), source: 'unknown' };
  }
}

// ------------------------------------------------------------------ ranking
function titleScore(title, intent) {
  const hay = ' ' + String(title || '').toLowerCase() + ' ';
  const hits = [], misses = [];
  const positive = [];
  if (intent.wants.unboxing) positive.push('unboxing', 'unbox', 'فتح العلبة');
  if (intent.wants.handsOn) positive.push('hands-on', 'hands on', 'first look', 'close up', 'closeup');
  if (intent.wants.closeup) positive.push('close up', 'closeup', 'macro', 'detail');
  if (intent.wants.broll) positive.push('footage', 'b-roll', 'broll');
  if (intent.wants.review) positive.push('review', 'test', 'unboxing');
  if (intent.wants.clean) positive.push('clean', 'minimal', 'studio');
  if (intent.subject) positive.push(...intent.subject.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  let score = 0;
  for (const t of positive) { if (hasTerm(hay, t)) { score += 3; hits.push(t); } }
  for (const t of NEGATIVE_TERMS) { if (hasTerm(hay, t)) { score -= 6; misses.push(t); } }
  const wanted = positive.length ? positive : [];
  return { score, hits, negatives: misses, considered: wanted.length };
}

/**
 * rank — a transparent score in [0,1] plus a plain-language `why` list.
 * Metadata first (free), then measurements, then vision. Nothing here claims certainty.
 */
function rank(candidate, intent, measured, signals) {
  const why = [];
  let score = 0.4;                                     // a real stream URL already earns a place
  const t = titleScore(candidate.title, intent);

  // --- duration fit (measured when we have it, metadata when we don't) ---
  const dur = (measured && measured.known && measured.duration) || candidate.duration || 0;
  const dmin = intent.duration.min, dmax = intent.duration.max;
  if (dur) {
    if (dur >= dmin && dur <= dmax) { score += 0.16; why.push('duration ' + Math.round(dur) + 's is inside the ' + dmin + '–' + dmax + 's window'); }
    else if (dur < dmin) { score -= 0.12; why.push('shorter than the requested ' + dmin + 's minimum (' + Math.round(dur) + 's)'); }
    else if (dur > dmax * 1.6) { score -= 0.18; why.push('much longer than requested (' + Math.round(dur) + 's)'); }
    else { score -= 0.04; why.push('slightly outside the requested length (' + Math.round(dur) + 's)'); }
  }

  // --- title heuristics ---
  if (t.score) {
    score += Math.max(-0.5, Math.min(0.36, t.score / 22));
    if (t.hits.length) why.push('title matches: ' + t.hits.slice(0, 4).join(', '));
    if (t.negatives.length) why.push('title reads like non-product content: ' + t.negatives.slice(0, 3).join(', '));
  } else if (intent.productIntent) {
    why.push('title carries no product-footage words');
  }

  // --- measured stream facts ---
  if (measured && measured.known) {
    if (measured.looksStill) { score -= 0.45; why.push('MEASURED: this stream behaves like a still image, not footage'); }
    else { score += 0.1; why.push('MEASURED: real video stream (' + measured.width + '×' + measured.height + ', ' + measured.duration + 's)'); }
    const shortSide = Math.min(measured.width || 0, measured.height || 0);
    if (shortSide >= 1080) { score += 0.1; why.push('MEASURED: full HD or better'); }
    else if (shortSide && shortSide < 480) { score -= 0.12; why.push('MEASURED: low resolution (' + measured.width + '×' + measured.height + ')'); }
    if (intent.orientation !== 'any' && measured.orientation !== 'unknown') {
      if (measured.orientation === intent.orientation) { score += 0.06; why.push('MEASURED: ' + measured.orientation + ' footage, as asked'); }
      else { score -= 0.08; why.push('MEASURED: ' + measured.orientation + ' footage (asked for ' + intent.orientation + ')'); }
    }
    if (measured.hasAudio === false) { score += 0.03; why.push('MEASURED: no audio track — nothing to mute before adding your own voice'); }
  }

  // --- vision signals: the only way to honour "no faces / no text" ---
  let constrained = false;
  if (signals && signals.available) {
    if (intent.semantics && intent.semantics.category) {
      const match = signals.subject_match || 'uncertain';
      if (match === 'exact' || match === 'brand') { score += 0.28; why.push('SEEN IN FRAMES: matches the requested ' + (intent.semantics.brand || 'product') + ' phone'); }
      else if (match === 'category') { score += 0.08; why.push('SEEN IN FRAMES: smartphone category matches; exact model not confirmed'); }
      else if (match === 'none') { score -= 0.8; why.push('SEEN IN FRAMES: visible subject does not match the requested phone concept'); }
      else { score -= 0.18; why.push('SEEN IN FRAMES: phone relevance is uncertain'); }
    }
    if (intent.wants.noFaces) {
      if (signals.faces === true) { score -= 0.6; why.push('SEEN IN FRAMES: a face is visible — you asked for no faces'); constrained = true; }
      else if (signals.faces === false) { score += 0.2; why.push('SEEN IN FRAMES: no face detected'); constrained = true; }
    }
    if (intent.wants.noText) {
      if (signals.text_overlay === true || signals.watermark === true) { score -= 0.5; why.push('SEEN IN FRAMES: on-screen writing or watermark — you asked for none'); constrained = true; }
      else if (signals.text_overlay === false && signals.watermark === false) { score += 0.18; why.push('SEEN IN FRAMES: no overlay text or watermark'); constrained = true; }
    }
    if (signals.faces === true || signals.person_or_body === true) { score -= 0.62; why.push('SEEN IN FRAMES: presenter/person/body footage is not suitable product B-roll'); }
    if (signals.hands === true) { score += 0.08; why.push('SEEN IN FRAMES: useful hands-on footage'); }
    if (signals.large_overlay === true) { score -= 0.52; why.push('SEEN IN FRAMES: large permanent edited overlay'); }
    if (signals.is_real_footage === false || signals.slideshow === true) { score -= 0.55; why.push('SEEN IN FRAMES: not real footage (still/slideshow/animation)'); }
    if (intent.productIntent && signals.product_visible === true) { score += 0.16; why.push('SEEN IN FRAMES: the product is the subject'); }
    score += Math.min(0.18, ((signals.quality || 0) + (signals.usability || 0)) * 0.09);
    if (signals.note) why.push('vision note: ' + signals.note);
  } else if (intent.needsVision) {
    // A constraint the owner stated but we could not verify is NOT satisfied — an unchecked candidate
    // must not rank level with one that was checked and passed.
    const unchecked = [intent.wants.noFaces ? 'no faces' : null, intent.wants.noText ? 'no text' : null].filter(Boolean);
    if (unchecked.length) { score -= 0.05 * unchecked.length; why.push('faces/text could not be checked (' + unchecked.join(', ') + ') — treated as unverified, not as a pass'); }
  }

  return { score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), why, constrained };
}

// ------------------------------------------------------------------ service
function createSource(o) {
  const store = o.store;
  const log = o.log || (() => {});
  const activity = o.activity || (() => {});

  /**
   * search — broad discovery, aggressive narrowing.
   * Returns `{ intent, candidates, considered, dropped, notes }`. `dropped` is a count per reason:
   * the owner sees "looked at 28, showed 5" instead of a wall of noise.
   */
  async function searchRound(opts) {
    opts = opts || {};
    const query = String(opts.query || '').trim().slice(0, 160);
    if (!query) throw new Error('a search needs a query');
    const intent = parseIntent(query);
    const limit = U.clamp(opts.limit, 1, 8, 5);
    const progress = opts.progress || (() => {});
    const note = opts.note || (() => {});
    const assertRunning = () => { if (opts.shouldStop && opts.shouldStop()) throw new Error('source search cancelled'); };
    assertRunning();
    // Visual verification is the DEFAULT for every search: faces, bodies, slideshows, big burned-in
    // text and product relevance are checked on every candidate shown to the owner — the owner must
    // never have to ask for it. An explicit opts.vision === false still skips it for tooling/tests.
    const strictVisual = opts.vision !== false;
    intent.expandedQueries = Array.isArray(opts.discoveryQueries) && opts.discoveryQueries.length
      ? opts.discoveryQueries : expandedQueries(query, intent);

    progress('searching sources for "' + query + '"', 12);
    const rawBatches=[];let discovered=0,queryIndex=0;
    // Work in bounded batches. Returning enough candidates to inspect is useful;
    // launching 24 parallel searches and dozens of downloader processes is not.
    while(queryIndex<intent.expandedQueries.length && discovered<80){
      assertRunning();const batch=intent.expandedQueries.slice(queryIndex,queryIndex+3);queryIndex+=batch.length;
      progress('discovering sources: '+queryIndex+'/'+intent.expandedQueries.length+' queries, '+discovered+' raw results',12);
      const results=await Promise.allSettled(batch.map(q=>o.legacy.discoverTikTok(q)));rawBatches.push(...results);
      discovered+=results.reduce((n,r)=>n+(r.status==='fulfilled'&&Array.isArray(r.value)?r.value.length:0),0);
    }
    assertRunning();
    const raw = rawBatches.flatMap(x => x.status === 'fulfilled' && Array.isArray(x.value) ? x.value : []);
    if (!raw.length) {
      if (rawBatches.every(x => x.status === 'rejected')) throw new Error('Source discovery is unavailable; all search providers failed.');
      return { query, intent, candidates: [], considered: 0, dropped: {}, examinedIds: [],
        vision: { requested: strictVisual, ran: 0, scouted: 0, unavailable: 0 }, notes: ['This search round returned no sources.'] };
    }

    const dropped = { noStream: 0, duplicates: 0, alreadyUsed: 0, previouslyChecked: 0, noSubjectMatch: 0, negativeContent: 0, looksStill: 0, visualReject: 0 };
    const excluded = new Set((opts.excludedIds || []).map(String));
    const seen = new Set();
    const pool = [];
    for (const v of raw) {
      if (!v || !v.play) { dropped.noStream++; continue; }
      if (store.isSourceUsed({ url: v.source, platformId: v.id })) { dropped.alreadyUsed++; continue; }
      const key = String(v.id || v.source || '') || String(v.title || '').slice(0, 80);
      if (excluded.has(key)) { dropped.previouslyChecked++; continue; }
      if (seen.has(key)) { dropped.duplicates++; continue; }
      seen.add(key);
      pool.push(v);
    }

    // ---- stage 1: free, metadata-only narrowing. Keeps the expensive stages small. ----
    const scored = pool.map(v => ({ v, t: titleScore(v.title, intent) }));
    const cleanPool = scored.filter(x => {
      if (intent.productIntent && x.t.negatives.length && x.t.score < -4) { dropped.negativeContent++; return false; }
      return true;
    }).sort((a, b) => (b.t.score - a.t.score) || ((b.v.plays || 0) - (a.v.plays || 0)))
      .map(x => x.v);

    // ---- stage 2: measure the top slice, plus whatever the popularity order offers, so a strong
    // large-account result cannot crowd out the whole set. ----
  const desiredCount = intent.wants.unboxing ? 1 : limit;
  const measureSlice = cleanPool.slice(0, Math.max(limit * 4,
    intent.wants.unboxing ? U.clamp(opts.visionLimit, 1, 160, 160) : 16));
    progress('measuring ' + measureSlice.length + ' candidate streams', 45);
    const measured = new Map();
    {
      const queue = [...measureSlice];
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) {
          assertRunning();
          const c = queue.shift();
          const m = await measure(c, o.media, o.refresh);
          measured.set(String(c.id), m);
          if (m.known && m.looksStill) dropped.looksStill++;
        }
      }));
    }

    // ---- stage 3: vision on the top few, ONLY when the request asks about faces/text ----
    const signals = new Map();
    let vision = { requested: !!intent.needsVision, ran: 0, scouted: 0, unavailable: 0, model: null };
    if (strictVisual) {
      // Cached visual evidence counts wherever the candidate sits in the pool: a clip verified in a
      // previous search must not be rejected as "unverified" just because this run's discovery order
      // placed it outside the fresh-probe slice (that mistake zeroed shortlists on repeat searches).
      // `signalFromCache` is a pure cache read — no network, no model calls.
      const cacheProbe = (c) => {
        const m = measured.get(String(c.id));
        // Only measurable candidates have frames to sample; without a stream a cached signal is
        // meaningless because it could never be re-verified on import either.
        if (!m || !m.known || m.looksStill) return null;
        const cacheFile = path.join(o.cacheDir, 'sig_' + U.safeName(c.id, 40) + '_' + U.hash16(SIGNAL_VERSION + '|' + JSON.stringify(intent.semantics || {})) + '.json');
        const hit = U.readJson(cacheFile, null);
        return hit && hit.available ? hit : null;
      };
      const fresh = [];
      for (const c of measureSlice) {
        const hit = cacheProbe(c);
        if (hit) signals.set(String(c.id), { ...hit, cached: true });
        else fresh.push(c);
      }

      // Asking for five videos needs more than five visual checks: some otherwise promising clips
      // are rejected for faces, slideshows or large overlay text. Keep this bounded, but inspect
      // enough candidates to give the requested shortlist a real chance before saying "only one".
      const visionCap = U.clamp(opts.visionLimit, 1, 160, intent.wants.unboxing ? 160 : Math.max(10, limit * 3));
      const probeSlice = fresh.slice(0, visionCap);
      const batchSize = intent.wants.unboxing ? 6 : probeSlice.length;
      let checked = 0;
      while (checked < probeSlice.length) {
        assertRunning();
        const queue = probeSlice.slice(checked, checked + batchSize);
        progress('visually screening candidates ' + Math.min(checked + queue.length, probeSlice.length) + ' of ' + probeSlice.length, 70);
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length) {
            assertRunning();
            const c = queue.shift();
            const s = await visionSignals(c, measured.get(String(c.id)), {
              cacheDir: o.cacheDir, media: o.media, llm: o.llm, model: opts.visionModel || null,
              fastModel: opts.fastVisionModel || 'gemini-3.5-flash-lite', deepModel: opts.deepVisionModel || 'gemini-3.7-flash',
              visionModels: intent.wants.unboxing ? (opts.visionModels || UNBOXING_VISION_MODELS) : null,
              page: opts.page, project: opts.project, refresh: o.refresh, intent,
            });
            signals.set(String(c.id), s);
            if (s.models_checked) vision.scouted++;
            if (s.available) { vision.ran++; vision.model = vision.model || s.model; } else { vision.unavailable++; if (s.kind) vision.reason = s.reason; }
          }
        }));
        checked += batchSize;
        if (intent.wants.unboxing) {
          const passed = measureSlice.some(v => {
            const s = signals.get(String(v.id));
            return s && !visualRejectReason({ intent, signals: s, measured: measured.get(String(v.id)), candidate: v, strictVisual })
              && rank({ ...v }, intent, measured.get(String(v.id)), s).score >= 0.45;
          });
          if (passed) break;
        }
      }
    }

    // ---- final rank ----
    const all = measureSlice.map(v => {
      const m = measured.get(String(v.id)) || null;
      const s = signals.get(String(v.id)) || null;
      const r = rank({ ...v }, intent, m, s);
      return { v, m, s, r };
    }).sort((a, b) => b.r.score - a.r.score);

    const rejectReasons = {};
    const strong = all.filter(x => {
      const reject = visualRejectReason({ intent, signals: x.s, measured: x.m, candidate: x.v, strictVisual });
      if (reject) { dropped.visualReject++; rejectReasons[reject] = (rejectReasons[reject] || 0) + 1; }
      return !reject && x.r.score >= 0.45;
    });
    const candidates = strong.slice(0, desiredCount).map(({ v, m, s, r }) => ({
      id: String(v.id), source: v.source || '', play: v.play, cover: v.cover || '',
      title: U.sanitizeText(v.title, 140), author: U.sanitizeText(v.author, 60),
      // Metadata duration is what the engine reported; `measured` is what the stream actually is.
      duration: (m && m.known && m.duration) || v.duration || 0,
      durationSource: m && m.known && m.duration ? 'measured' : 'metadata',
      plays: v.plays || 0, likes: v.likes || 0,
      preview: v.play ? ('/proxy?url=' + encodeURIComponent(v.play) + '&id=' + encodeURIComponent(String(v.id))) : '',
      measured: m && m.known ? {
        width: m.width, height: m.height, duration: m.duration, hasAudio: m.hasAudio,
        orientation: m.orientation, aspect: m.aspect, looksStill: m.looksStill,
      } : null,
      signals: s && s.available ? {
        source: 'vision', model: s.model, stage: s.stage || 'scout', frames: s.frames, cached: !!s.cached,
        faces: s.faces, personOrBody: s.person_or_body, hands: s.hands, textOverlay: s.text_overlay, largeOverlay: s.large_overlay,
        robotOrNonhuman: s.robot_or_nonhuman, hookScore: s.hook_score, hookReason: s.hook_reason,
        quality: s.quality, usability: s.usability, modelsChecked: s.models_checked,
        watermark: s.watermark, physicalText: s.physical_text, productVisible: s.product_visible, product: s.product,
      productCategory: s.product_category, brand: s.brand, subjectMatch: s.subject_match, subjectConfidence: s.subject_confidence,
      unboxing: s.unboxing,
        realFootage: s.is_real_footage, slideshow: s.slideshow, quality: s.quality, usability: s.usability,
        overlayRanges: s.overlay_ranges || [], note: s.note,
      } : { source: 'unknown', reason: (s && s.reason) || (strictVisual ? 'not checked' : 'faces/text not requested'),
        faces: null, textOverlay: null, productVisible: null, realFootage: null },
      score: r.score, why: r.why,
    }));

    const unfaithful = candidates.filter(c => strictVisual && c.signals.source !== 'vision').length;
    const notes = [
      'Ranked on the request terms, the source metadata and ffprobe measurements of each stream.',
      // Say exactly what happened. Claiming a check ran when every probe failed would be the kind of
      // false assurance this whole module exists to avoid.
      !strictVisual
        ? 'Visual checks were skipped for this internal run.'
        : vision.ran || signals.size
          ? ('Visual screening produced evidence for ' + signals.size + ' candidate(s)' + (vision.model ? ' with ' + vision.model : '') + '.')
          : 'Faces/text could NOT be checked — ' + (vision.reason ? U.sanitizeText(vision.reason, 160) : 'the frames could not be sampled') + '. Every candidate is labelled unknown.',
      'Search expanded into TikTok-native product phrases; frame vision decides relevance instead of trusting captions alone.',
      'Preference matching is a heuristic, not a guarantee: preview before you commit.',
    ];
    if (vision.ran && unfaithful) notes.push(unfaithful + ' candidate(s) could not be checked and are labelled unknown.');

    activity({
      type: 'model.call', kind: 'search', label: 'Source search', task: 'source.search', capability: 'search',
      status: 'ok', ms: 0, page: opts.page || '', project: opts.project || '',
      text: query, considered: pool.length, shown: candidates.length, vision: vision.ran, visionCached: signals.size,
    });
    log('info', 'source.search', { query, considered: pool.length, shown: candidates.length, vision: vision.ran, visionCached: signals.size, dropped });
    note('looked at ' + pool.length + ', showing ' + candidates.length);
    return { query, intent, candidates, considered: pool.length, dropped, rejectReasons, vision, notes,
      examinedIds: measureSlice.map(v => String(v.id || v.source || '')) };
  }

  async function search(opts = {}) {
    const intent = parseIntent(opts.query);
    const roundLimit = intent.wants.unboxing ? U.clamp(opts.searchRounds, 1, 4, 4) : 1;
    const excludedIds = new Set((opts.excludedIds || []).map(String));
    const rounds = [];
    const rejected = {};
    let result;
    for (let round = 0; round < roundLimit; round++) {
      if (opts.shouldStop && opts.shouldStop()) throw new Error('source search cancelled');
      const discoveryQueries = round === 0 ? expandedQueries(opts.query, intent) : continuationQueries(intent, round);
      (opts.progress || (() => {}))('search round ' + (round + 1) + ' of ' + roundLimit + ': discovering new sources', 12);
      const summary={round:round+1,queries:[],discovered:0,examined:0,selected:0,vision:null,rejectReasons:{}};
      for(let offset=0;offset<discoveryQueries.length;offset+=3){
        const batch=discoveryQueries.slice(offset,offset+3);summary.queries.push(...batch);
        result=await searchRound({...opts,excludedIds:[...excludedIds],discoveryQueries:batch,
          progress:(stage,pct)=>(opts.progress||(()=>{}))('round '+(round+1)+'/'+roundLimit+', queries '+(offset+1)+'–'+(offset+batch.length)+': '+stage,pct)});
        for(const id of result.examinedIds)excludedIds.add(id);
        for(const [key,value]of Object.entries(result.dropped))rejected[key]=(rejected[key]||0)+value;
        summary.discovered+=result.considered;summary.examined+=result.examinedIds.length;summary.selected=result.candidates.length;summary.vision=result.vision;
        for(const [key,value]of Object.entries(result.rejectReasons||{}))summary.rejectReasons[key]=(summary.rejectReasons[key]||0)+value;
        if(result.candidates.length)break;
      }
      rounds.push(summary);
      if (result.candidates.length) break;
      (opts.note || (() => {}))('No approved unboxing in round ' + (round + 1) + '; trying different searches automatically.');
    }
    const found = !!result.candidates.length;
    result.dropped = rejected;
    result.examinedIds = [...excludedIds];
    result.search = { status: found ? 'found' : 'exhausted', rounds, examined: excludedIds.size, roundLimit };
    if (!found) result.notes.push('Automatic searches exhausted ' + rounds.length + ' rounds without an approved video. No video was selected.');
    return result;
  }

  return { search, parseIntent, rank, measure, visionSignals, titleScore };
}

module.exports = { createSource, parseIntent, expandedQueries, continuationQueries, semanticsFor, visualRejectReason, SIGNAL_VERSION };
