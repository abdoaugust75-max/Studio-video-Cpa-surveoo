// lib/util.js — shared primitives: atomic IO, ids, validation, path confinement, structured logs.
// Zero dependencies. Every write is tmp+rename so a crash can never corrupt an existing record.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function appendJsonl(file, obj) {
  try { ensureDir(path.dirname(file)); fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (_) {}
}

function uid(prefix) {
  return (prefix || 'X') + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

const nowIso = () => new Date().toISOString();

/** clamp(value, min, max, fallback) — numbers only, never NaN. */
function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Strip control chars, shell-hostile characters and cap length. Used for anything reaching ffmpeg. */
function sanitizeText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`$\\"'|;&<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 600);
}

function safeName(s, max) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '').slice(0, max || 60) || 'anon';
}

/** Confine a path to a directory: rejects traversal and absolute escapes. */
function isInside(dir, p) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function resolveInside(dir, name) {
  const p = path.join(dir, path.basename(String(name || '')));
  if (!isInside(dir, p)) throw new Error('path outside allowed directory: ' + name);
  return p;
}

/** Pull the largest JSON object out of an LLM reply (handles ```json fences and prose wrappers). */
function extractJSON(text) {
  if (!text) return null;
  const blocks = String(text).replace(/```json/gi, '```').split('```').filter(Boolean);
  const t = blocks.sort((a, b) => b.length - a.length)[0] || String(text);
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { return null; }
}

const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const hash16 = s => sha(s).slice(0, 16);

/** Structured logger: timestamp, level, event, context. JSONL on disk, one line on stdout. */
function makeLogger(logFile) {
  return function log(level, event, ctx) {
    const rec = { ts: nowIso(), level, event, ...(ctx || {}) };
    appendJsonl(logFile, rec);
    if (level !== 'debug') {
      const { ts, level: lv, event: ev, ...rest } = rec;
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest).slice(0, 400) : '';
      console.log(ts.slice(11, 19), '[' + ev + ']' + extra);
    }
    return rec;
  };
}

// ---------- shell-free process helper ----------
const { spawn } = require('child_process');
/** run(bin, args, {timeoutSec, input}) — argument array only, never a shell string. */
function run(bin, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, cwd: opts.cwd, detached:process.platform!=='win32' });
    let out = '', err = '';
    p.stdout.on('data', c => out += c);
    p.stderr.on('data', c => err += c);
    p.on('error', reject);
    const t = setTimeout(() => { require('./process-budget').stopTree(p); reject(new Error('timeout after ' + (opts.timeoutSec || 300) + 's: ' + path.basename(bin))); }, (opts.timeoutSec || 300) * 1000);
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) return resolve({ out, err });
      reject(new Error((err || out || ('exit ' + code)).trim().slice(-400)));
    });
  });
}

/**
 * modelTokens — the device/product model names a piece of text mentions, normalised to short tokens.
 *
 * This exists for one specific failure: a platform caption that says "iPhone 17 Pro Max" sitting on
 * top of footage of an iPhone X. Comparing normalised tokens is how the studio NOTICES that the
 * caption and the footage disagree, instead of quietly trusting the caption when it writes a script.
 * It is deliberately conservative — a brand word with up to a 4-character model marker — because a
 * false "conflict" would be worse than no detection at all.
 */
const PRODUCT_WORDS = 'iphone|ipad|galaxy|redmi|poco|pixel|xiaomi|samsung|huawei|oppo|vivo|honor|realme|infinix|tecno|nokia|airpods|macbook|thinkpad|playstation|ps5';
const PRODUCT_SET = new Set(PRODUCT_WORDS.split('|'));
// Model-suffix words that can sit between a product word and the model number. 'flip' and 'fold'
// are the important ones: "Galaxy Z Flip 5" vs "Galaxy Z Flip 7" differ ONLY in that trailing
// number, so the tokenizer must carry the whole chain or the comparison is meaningless.
const MODEL_WORDS = new Set(['flip', 'fold', 'fe', 'se', 'pro', 'max', 'plus', 'ultra', 'air', 'note', 'x', 'z']);
function modelTokens(text) {
  // 'flip7' and 'Flip7' must read as 'flip 7', and hashtags arrive glued; split letters from digits
  // so a caption's model number can never silently disappear from the comparison.
  const words = String(text == null ? '' : text)
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (!PRODUCT_SET.has(words[i])) continue;
    const parts = [words[i]];
    let j = i + 1;
    while (j < words.length && parts.length < 5) {
      const n = words[j];
      // 'x' / 'se' after a product word are model markers (iPhone X, iPhone SE); 'z' is a Galaxy
      // series word (Galaxy Z Flip). A single letter continues the chain only when it is a known
      // marker or when a NUMBER FOLLOWS it ('s' + '24' → s24); otherwise it is plain English.
      const nextIsNum = j + 1 < words.length && /^\d{1,3}$/.test(words[j + 1]);
      if (/^\d{1,3}$/.test(n) || MODEL_WORDS.has(n) || (n.length === 1 && nextIsNum)) {
        parts.push(n); j++; continue;
      }
      break;
    }
    // Canonical form: glue a single-letter model marker to its number ('s 24' → s24).
    const tok = parts.length > 2 && /^[a-z]$/.test(parts[1]) && /^\d/.test(parts[2] || '')
      ? parts[0] + parts[1] + parts.slice(2).join(' ')
      : parts.join(' ');
    if (!out.includes(tok)) out.push(tok);
    // The SHORT product token ('iphone 17' from 'iphone 17 pro max') is registered too: the exact
    // trim level (pro/max/ultra) is often missing from captions, and its absence is an agreement
    // case, not a conflict. Two tokens per product keep the comparison direction-free.
    const trimStart = parts.findIndex(t => /^(pro|max|plus|ultra|fe|air)$/.test(t));
    if (trimStart > 0) {
      const short = parts.slice(0, trimStart).join(' ').replace(/ ([a-z]) (?=\d)/g, '$1');
      if (short !== tok && !out.includes(short)) out.push(short);
    }
    i = j - 1;
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * footageTruth — the rule that the footage outranks the caption, made into data.
 *
 * A platform caption is marketing copy and is routinely wrong about the product: the owner's own
 * session had "iPhone 17 Pro Max unboxing" over footage of an iPhone X, and the script came out about
 * the wrong phone. This compares what the vision analysis says the footage shows against what the
 * caption claims, so the disagreement is a fact in the project record rather than something a model
 * has to notice on its own.
 *
 * Derived lazily (from stored analysis + the stored source caption) so projects imported before this
 * existed get it too — a re-import should never be needed to fix a grounding bug.
 */
function footageTruth(analysis, caption) {
  const rawProduct = sanitizeText((analysis && (analysis.suggested_product || analysis.product_visible)) || '', 60);
  const cap = sanitizeText(caption || '', 140);
  if (!analysis || (!rawProduct && !cap)) return null;
  const a = modelTokens(rawProduct), b = modelTokens(cap);
  // Only MODEL-BEARING tokens (they end in a number) can prove or refute an exact model match.
  // A shared brand token ("samsung") proves nothing: "Z Flip 5" and "Z Flip 7" are both Samsung.
  // But a model-less product token ("iphone x", "galaxy z flip") still keeps the UNCERTAINTY: a
  // model-bearing caption facing a model-less footage reading cannot be called an agreement.
  const hasNum = t => /\d/.test(t);
  const aModel = a.filter(hasNum), bModel = b.filter(hasNum);
  const conflict = aModel.length && bModel.length
    ? !aModel.some(t => bModel.includes(t))
    : !!(a.length && b.length && !a.some(t => b.includes(t)));
  // Packaging evidence: text printed ON the product/box in the footage is part of the FOOTAGE.
  // When the box visibly carries the caption's model number, the caption is corroborated by the
  // visuals; when it carries the analysis's model, the footage identity is internally confirmed.
  // Packaging text is noisy (a capacity like "256GB" sits next to the model), so a packaging
  // token AGREES with a caption token when the caption token is contained in it.
  const visibleText = Array.isArray(analysis && analysis.visible_text) ? analysis.visible_text : [];
  const packaging = modelTokens(visibleText.join(' '));
  const supports = (modelToks, packToks) => !!modelToks.length && modelToks.some(m =>
    packToks.some(p => p.includes(m) || m.includes(p)));
  const packagingSupportsCaption = supports(bModel, packaging);
  const packagingSupportsFootage = supports(aModel, packaging);
  // visualConfidence — how well the FOOTAGE evidence settles the EXACT model.
  //   confirmed    → analysis and caption agree, or visible packaging text settles it
  //   uncertain    → analysis and caption disagree and nothing visible settles it
  //   unidentified → the footage could not name a product at all
  let visualConfidence;
  if (!aModel.length) visualConfidence = 'unidentified';
  else if (!conflict || packagingSupportsFootage || packagingSupportsCaption) visualConfidence = 'confirmed';
  else visualConfidence = 'uncertain';
  // What scripts should NAME. An uncertain model degrades to the FAMILY ("Samsung Galaxy Z Flip"),
  // never silently committing to a number the evidence does not settle — and never to the caption's
  // number. When the packaging itself confirms the caption, the caption model IS the footage.
  let product = rawProduct || null;
  let uncertainNote = '';
  if (visualConfidence === 'uncertain') {
    product = rawProduct.replace(/\s*\d{1,3}\s*$/, '').replace(/\s+(pro|max|plus|ultra|fe|air)\s*$/i, '').trim() || rawProduct;
    uncertainNote = 'MODEL NOT CONFIRMED: the footage analysis reads "' + rawProduct + '" while the caption says "' + cap + '" and nothing visible on the packaging settles it. Name the product family only ("' + product + '") in scripts/titles — never a specific model number — until the owner confirms.';
  }
  if (packagingSupportsCaption) {
    // Rebuild the confirmed product from the caption's own model tokens, title-cased.
    const bIdx = bModel.length ? b.indexOf(bModel[0]) : -1;
    const chain = bIdx >= 0 ? b.slice(0, bIdx + 1).join(' ') : '';
    if (chain) product = chain.replace(/\b\w/g, c => c.toUpperCase());
  }
  return {
    product: product || null,
    visualProductModel: rawProduct || null,
    visualProductFamily: visualConfidence === 'uncertain' ? product : null,
    metadataProduct: bModel[0] || null,
    caption: cap || null,
    captionModel: bModel[0] || null,
    visualConfidence,
    packagingSupportsCaption,
    conflict: packagingSupportsCaption ? false : conflict,
    note: packagingSupportsCaption
      ? 'The packaging text visible in the footage confirms the caption model — the identity is confirmed.'
      : uncertainNote || (conflict
        ? 'The caption names a different product than the footage shows. Scripts, titles and captions describe the FOOTAGE.'
        : (product ? 'The footage is the authority; the caption agrees closely enough.'
          : 'No product could be identified in the footage — do not invent one.')),
  };
}

module.exports = { ensureDir, readJson, writeJsonAtomic, appendJsonl, uid, nowIso, clamp, sanitizeText, safeName, isInside, resolveInside, sha, hash16, makeLogger, run, extractJSON, modelTokens, footageTruth };
