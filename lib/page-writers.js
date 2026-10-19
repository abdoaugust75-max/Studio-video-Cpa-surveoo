'use strict';

// lib/page-writers.js — the seven page production contracts, ported from the seven ACTIVE
// n8n production workflows on the VPS (V3-MetaDirect series, active workflow ids NEW*,
// extracted read-only on 2026-09-21; raw node dumps in n8n-audit/).
//
// Parity rule: everything below is the REAL production prompt content, not an invention.
// The only systematic substitutions against the n8n source:
//   • {{$json.*}} expressions become named inputs (product, price, …) supplied at run time;
//   • the per-run rotation lists (music URLs) stay in data/studio/profiles/<page>.json;
//   • credentials that appeared inline in n8n Code nodes are NOT carried over — keys come
//     from the studio's provider router, never from this file.
// The full original prompts are preserved verbatim in n8n-audit/prompts/<page>.writer.txt.

// ---------------------------------------------------------------- price policy (owner override)
// The owner sets the DEFAULT offer style per page (2026-09-23). These are deliberate overrides on
// top of the audited n8n tier tables:
//   • the four normal Moroccan sales pages open LOW (100 or 200 DH, rarely 500) — never 1000+;
//   • Tashilat stays INSTALLMENTS (100/200/300 DH per month from the real market tier rule);
//   • the USD pages keep dollar-style low prices in their own language/market logic.
// The user can always override the exact number in chat (services.setPrice).
const PRICE_POLICY = {
  alshihna:          { currency: '$', kind: 'one_time', usdTiers: [[800, 100], [500, 80], [300, 50], [150, 30], [70, 20], [0, 10]], fallbackMarket: 499 },
  vouchteck:         { currency: '$', kind: 'one_time', usdTiers: [[800, 100], [500, 80], [300, 50], [150, 30], [70, 20], [0, 10]], fallbackMarket: 499 },
  maghrebtechstore:  { currency: 'درهم', kind: 'one_time', low: [100, 200], rare: 500, fallbackMarkets: { 100: 4990, 200: 8990, 500: 15990 } },
  maghrebly:         { currency: 'درهم', kind: 'one_time', low: [100, 200], rare: 500, fallbackMarkets: { 100: 4990, 200: 8990, 500: 15990 } },
  mubadara:          { currency: 'درهم', kind: 'one_time', low: [100, 200], rare: 500, fallbackMarkets: { 100: 4990, 200: 8990, 500: 15990 } },
  amazon_liquidation:{ currency: 'درهم', kind: 'one_time', low: [100, 200], rare: 500, fallbackMarkets: { 100: 4990, 200: 8990, 500: 15990 } },
  tashilat:          { currency: 'درهم', kind: 'monthly', fallbackMarket: 5990 },
};

/** premiumProduct — flagship-looking product names get the 200/500 slot, everything else 100. */
function premiumProduct(name) {
  return /\b(pro|max|plus|ultra|fold|flip|note)\b|iphone\s*1[4-9]|s2[0-9]|galaxy\s*z/i.test(String(name || ''));
}

/**
 * priceFor(pageKey, opts) — the offer the writer must open with.
 * opts: { product, marketHint (number, MAD or USD per page), override { amount, monthly } }
 * Returns { amount, monthly, currency, market } — `market` is the believable was-price.
 */
function priceFor(pageKey, opts) {
  opts = opts || {};
  const pol = PRICE_POLICY[pageKey];
  if (!pol) return null;
  const market = Number(opts.marketHint) > 0 ? Math.round(Number(opts.marketHint)) : null;
  if (opts.override && Number(opts.override.amount) > 0) {
    return {
      amount: Math.round(Number(opts.override.amount)), monthly: !!opts.override.monthly,
      currency: pol.currency,
      market: market || (pol.kind === 'monthly' ? (pol.fallbackMarket || 5990) : (pol.fallbackMarkets ? (pol.fallbackMarkets[Math.round(Number(opts.override.amount))] || 8990) : (pol.fallbackMarket || 499))),
      overridden: true,
    };
  }
  if (pol.kind === 'monthly') {
    // Tashilat — the audited installment rule: the SELLING figure is the MONTHLY payment.
    const m = market || pol.fallbackMarket;
    const monthly = m < 5000 ? 100 : (m <= 10000 ? 200 : 300);
    return { amount: monthly, monthly: true, currency: pol.currency, market: m, months: Math.max(1, Math.ceil(m / monthly)) };
  }
  if (pol.usdTiers) {
    const t = market || pol.fallbackMarket;
    const row = pol.usdTiers.find(([min]) => t >= min);
    return { amount: row ? row[1] : 100, monthly: false, currency: pol.currency, market: t };
  }
  // MAD one-time: LOW by owner rule — 100 normal, 200 for flagship-looking products, 500 rare.
  const amount = premiumProduct(opts.product) ? (market && market >= 15000 ? pol.rare : pol.low[1]) : pol.low[0];
  return { amount, monthly: false, currency: pol.currency, market: market || (pol.fallbackMarkets && pol.fallbackMarkets[amount]) || 8990 };
}

// ---------------------------------------------------------------- price contract enforcement
// Owner rule (2026-09-23): "Do not generate random prices like 299 DH." A writer draft is
// accepted ONLY when it obeys the RESOLVED offer (owner override > page policy > n8n tiers):
//   1. the FIRST spoken sentence carries the offer amount (digits or its spoken word form);
//   2. installment pages (Tashilat) say PER MONTH in that first sentence;
//   3. no other price appears anywhere (only the offer and the was-price may-price contrast).

/** normalizeDigits — Arabic-Indic and Extended Arabic-Indic digits to ASCII. */
function normalizeDigits(s) {
  return String(s || '')
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0));
}

const CURRENCY_WORD = /درهم|دراهم|د\.?\s?م\.?|دولار|\$|dollars?|\bdhs?\b|\bdh\b/i;
const MONTH_WORD = /شهر|شھر|\/?\s*mo\b|per\s*month|monthly|a\s*month|\/month/i;

/**
 * priceNumbers — every number written in a PRICE context: near a currency word, right after
 * بـ (the "at X price" prefix), or after بدل / instead of (the was-price contrast). Product
 * numbers ("iPhone 16", "Galaxy S26") carry no price context and are never counted.
 */
function priceNumbers(text) {
  const s = normalizeDigits(text);
  const out = [];
  const re = /\d[\d,.]*/g;
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 8), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 8);
    const priceCtx = CURRENCY_WORD.test(before) || CURRENCY_WORD.test(after)
      || /(?:^|[^0-9])بـ\s*$/.test(before)
      || /بدل|instead of|au lieu de/i.test(before);
    if (priceCtx) out.push(Math.round(Number(m[0].replace(/[,.]/g, ''))) || 0);
  }
  return out;
}

/**
 * foreignPrices — price-context numbers that are neither the offer amount nor the was-price
 * (a rounded was-price like "9000" for 8990 is a contrast, not an invented price).
 */
function foreignPrices(text, offer) {
  const allowed = [];
  if (offer && Number(offer.amount) > 0) allowed.push(Math.round(Number(offer.amount)));
  const market = offer && Number(offer.market) > 0 ? Math.round(Number(offer.market)) : 0;
  return priceNumbers(text).filter(n => {
    if (!n) return true;
    if (allowed.includes(n)) return false;
    if (market && Math.abs(n - market) <= Math.max(50, market * 0.06)) return false;
    return true;
  });
}

/** amountWords — spoken word forms of an amount (Darija writes 100 as "مية", 200 as "مئتين"). */
function amountWords(amount) {
  const MAP = {
    10: ['عشرة', 'عشر دراهم', 'ten'],
    20: ['عشرين', 'عشرون', 'twenty'],
    30: ['تلاتين', 'ثلاثين', 'ثلاثون', 'thirty'],
    50: ['خمسين', 'خمسون', 'fifty'],
    80: ['ثمانين', 'تمانين', 'eighty'],
    100: ['مية', 'مئة', 'مائة', 'ميات', 'hundred'],
    200: ['مئتين', 'مائتين', 'مئتان', 'ميتين', 'two hundred'],
    300: ['تلاتمية', 'ثلاثمية', 'ثلاثمائة', 'ثلاثمئة', 'تلاتمئة', 'three hundred'],
    500: ['خمسمية', 'خمسمئة', 'خمس مئة', 'خمسماية', 'five hundred'],
    1000: ['الف', 'ألف', 'thousand'],
  };
  return MAP[Math.round(Number(amount))] || [];
}

/**
 * priceContractOk — the owner's price policy as an acceptance gate for writer drafts.
 */
function priceContractOk(pageKey, text, offer) {
  const reasons = [];
  const s = normalizeDigits(String(text || ''));
  const first = s.split(/[.!?\u061F\u06D4\n]/).map(x => x.trim()).filter(Boolean)[0] || '';
  if (offer && Number(offer.amount) > 0) {
    const amount = Math.round(Number(offer.amount));
    const hasDigits = new RegExp('(?:^|\\D)' + amount + '(?:\\D|$)').test(first);
    const hasWords = amountWords(amount).some(w => first.toLowerCase().includes(w.toLowerCase()));
    if (!hasDigits && !hasWords) {
      reasons.push('the FIRST sentence does not carry the offer price (' + amount + (offer.monthly ? '/month' : '') + ')');
    }
    if (offer.monthly && !MONTH_WORD.test(first)) {
      reasons.push('installment offer: the FIRST sentence must say ' + amount + ' is PER MONTH');
    }
  }
  for (const n of foreignPrices(s, offer)) {
    reasons.push('invented price ' + n + ' — the offer is '
      + (offer ? offer.amount + (offer.monthly ? ' per month' : '') + (offer.market ? ' (was ' + offer.market + ')' : '') : 'unset'));
  }
  return { ok: !reasons.length, reasons };
}

// Owner's controlled sourcing-angle library (2026-09-23) — natural variation, ONE angle per script.
// Same concepts the audited n8n workflows rotate; wording normalized to the owner's list for the
// Darija pages, Fusha wording for Al-Shihna, English for VouchTeck.
const ANGLES = {
  darija: 'حجز الديوانة (customs seizure) / مخزون فائض (overstock) / فائض الاستيراد (import surplus) / تغليف متضرر (damaged packaging) / مرجوعات الزبناء (customer returns) / تصفية إفلاس (bankruptcy liquidation) / تصفية مخزون (warehouse clearance)',
  arabic: 'حجز الجمارك (customs seizure) / مخزون فائض (overstock) / فائض استيراد (import surplus) / تغليف تالف (damaged packaging) / مرتجعات العملاء (customer returns) / تصفية إفلاس (bankruptcy liquidation) / تصفية مخزون (warehouse clearance)',
  english: 'Customs seizure / warehouse overstock / import surplus / damaged packaging / customer returns / bankruptcy liquidation / warehouse clearance',
};

const SHARED = {
  // Identical in all seven workflows: "## SCRIPT STRUCTURE (proven high-conversion)".
  // Owner override (2026-09-23): the price OPENS the script (price shock IS the hook) and the CTA
  // is the final line. The n8n anchor order is preserved underneath it.
  sequence: 'Price shock (price IS the hook) -> Why so cheap (ONE sourcing angle) -> Product benefits -> Urgency -> CTA (last line)',
  hookRule: 'Sentence 1 = HOOK in the first ~2.5 seconds (max ~8 words): price shock, bold claim, or question.',
  // Identical in all seven: "## PRICE RULES (critical)".
  priceRules:
    'ALWAYS present OUR price as the SELLING price supplied in context (the discounted price). ' +
    'NEVER invent another price and NEVER use the market price as our price. ' +
    'Always contrast against the market price to scream the huge discount, e.g. "{selling} بدل {market}". ' +
    'Keep the numbers exactly as given.',
  // Identical in all seven: the n8n "OUTPUT FORMAT" block (Parse Writer Output expects exactly this).
  outputContract:
    'Return ONLY a strictly valid JSON object (no markdown fences): ' +
    '{"hook_style_used":"price_shock|product_name|question|comparison|direct_address",' +
    '"sentences":["Hook...","Credibility...","Desire...","Price contrast...","CTA..."],' +
    '"title_<LANG>":"Short shocking title with the SELLING price and product name",' +
    '"script_text":"The entire raw spoken script text",' +
    '"caption_social":"Facebook caption","caption_social_ig":"Instagram caption"}',
  cleanNameRule:
    'If the product name has a repeated brand word (e.g. "Samsung Samsung A17"), remove the duplicate: "Samsung A17". Same for any repeated word in the name.',
};

const WRITERS = {
  alshihna: {
    n8n: 'alshihna video production V3-MetaDirect',
    language: 'SIMPLE, CLEAR Modern Standard Arabic (فصحى مبسطة)',
    audience: 'every Arabic speaker (Egypt, Saudi, UAE, Iraq, Morocco, Algeria...)',
    landingPage: 'alshihna.online',
    identity: 'الشحنة — مستودع التصفية (tech liquidation warehouse) serving ALL ARAB COUNTRIES',
    sourcingAngles: ANGLES.arabic,
    urgency: 'الكمية محدودة / العرض ينتهي قريباً',
    engagement: {
      word: 'مهتم / مهتمة',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment مهتم (male) or مهتمة (female) to get the link. Vary the phrasing every time. Examples: اكتب مهتم أو مهتمة في التعليقات وسيصلك الرابط مباشرة. / مهتم ولا مهتمة؟ اكتبها في التعليق والباقي علينا.',
    },
    surveyFraming: 'NEVER say استبيان. Use: تسجيل بسيط / نموذج بسيط / تأكيد الطلب / حجز مكانك. Mention the step as: طريقة الاستفادة: أكمل تسجيلاً بسيطاً عبر Surveoo وانتهى الأمر.',
    banned: 'NO Darija, NO dialect, NO French, NO English words. BANNED: الدارجة، واش، باش، دابا، كاين، غادي، ديال.',
    outputLang: 'arabic',   // Parse Writer Output: LANGUAGE="arabic", TITLE_FIELD="title_arabic"
    titleField: 'title_arabic',
    langGuard: 'banned-darija',
    currency: 'دولار', wasWord: 'بدل', publishLang: 'ar',
  },
  maghrebtechstore: {
    n8n: 'maghrebtechstore video production V3-MetaDirect',
    language: 'viral Moroccan Darija copywriting',
    audience: 'Moroccan tech deals store shoppers',
    landingPage: 'maghrebtechstore.com',
    identity: 'MaghrebTechStore (Moroccan tech deals store)',
    sourcingAngles: ANGLES.darija,
    writerModel: 'gemini-3.8-flash',   // owner override: Darija quality is better on newer Gemini
    urgency: 'الكمية محدودة / العرض غادي يسالي',
    engagement: {
      word: 'مهتم / مهتمة',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment مهتم (male) or مهتمة (female) to get the link. Vary the phrasing every time.',
    },
    banned: 'BANNED words in the spoken script: هذا, هذه, ذلك, ليس, فقط, عند, سوف. No stage directions.',
    outputLang: 'darija',
    titleField: 'title_darija',
    langGuard: 'banned-msa',
    currency: 'دولار', wasWord: 'بدل', publishLang: 'ar',
  },
  maghrebly: {
    n8n: 'maghrebly video production V3-MetaDirect',
    language: 'viral Moroccan Darija copywriting',
    audience: 'مغربلي — مستودع الجالية (diaspora liquidation)',
    landingPage: 'maghrebly.shop',
    identity: 'مغربلي — مستودع الجالية (diaspora liquidation)',
    sourcingAngles: ANGLES.darija,
    writerModel: 'gemini-3.8-flash',   // owner override: Darija quality is better on newer Gemini
    urgency: 'الكمية محدودة / العرض غادي يسالي',
    engagement: {
      word: 'مهتم / مهتمة',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment مهتم (male) or مهتمة (female) to get the link. Vary the phrasing every time.',
    },
    banned: 'BANNED words in the spoken script: هذا, هذه, ذلك, ليس, فقط, عند, سوف. No stage directions.',
    outputLang: 'darija',
    titleField: 'title_darija',
    langGuard: 'banned-msa',
    currency: 'دولار', wasWord: 'بدل', publishLang: 'ar',
  },
  mubadara: {
    n8n: 'mubadara video production V3-MetaDirect',
    language: 'viral Moroccan Darija copywriting',
    audience: 'مبادرة — youth initiative shoppers',
    landingPage: 'maghrebtech.online',
    identity: 'مبادرة — youth initiative',
    sourcingAngles: ANGLES.darija,
    writerModel: 'gemini-3.8-flash',   // owner override: Darija quality is better on newer Gemini
    urgency: 'الكمية محدودة / العرض غادي يسالي',
    engagement: {
      word: 'مهتم / مهتمة',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment مهتم (male) or مهتمة (female) to get the link. Vary the phrasing every time.',
    },
    banned: 'BANNED words in the spoken script: هذا, هذه, ذلك, ليس, فقط, عند, سوف. No stage directions.',
    outputLang: 'darija',
    titleField: 'title_darija',
    langGuard: 'banned-msa',
    currency: 'دولار', wasWord: 'بدل', publishLang: 'ar',
  },
  tashilat: {
    n8n: 'tashilat video production V3-MetaDirect',
    language: 'viral Moroccan Darija copywriting',
    audience: 'تسهيلات — Tasshilat tech store shoppers',
    landingPage: 'tasshilatttech.store',
    identity: 'Tasshilat tech store',
    sourcingAngles: ANGLES.darija,
    writerModel: 'gemini-3.8-flash',   // owner override: Darija quality is better on newer Gemini
    urgency: 'الكمية محدودة / العرض غادي يسالي',
    engagement: {
      word: 'مهتم / مهتمة',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment مهتم (male) or مهتمة (female) to get the link. Vary the phrasing every time.',
    },
    banned: 'BANNED words in the spoken script: هذا, هذه, ذلك, ليس, فقط, عند, سوف. No stage directions.',
    outputLang: 'darija',
    titleField: 'title_darija',
    langGuard: 'banned-msa',
    currency: 'دولار', wasWord: 'بدل', publishLang: 'ar',
  },
  amazon_liquidation: {
    n8n: 'amazon liquidation video production V3-MetaDirect',
    language: 'viral Moroccan Darija copywriting',
    audience: 'مستودع الأجهزة الذكية — Morocco smart-device liquidation shoppers',
    landingPage: 'warehouse-morocco.casa',
    identity: 'Smart Warehouse — Amazon liquidation Morocco',
    sourcingAngles: ANGLES.darija,
    writerModel: 'gemini-3.8-flash',   // owner override: Darija quality is better on newer Gemini
    urgency: 'الكمية محدودة / العرض غادي يسالي',
    engagement: {
      word: 'مهتم / مهتمة',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment مهتم (male) or مهتمة (female) to get the link. Vary the phrasing every time.',
    },
    banned: 'BANNED words in the spoken script: هذا, هذه, ذلك, ليس, فقط, عند, سوف. No stage directions.',
    outputLang: 'darija',
    titleField: 'title_darija',
    langGuard: 'banned-msa',
    currency: 'دولار', wasWord: 'بدل', publishLang: 'ar',
  },
  vouchteck: {
    n8n: 'VouchTeck Worldwide video production V3-MetaDirect',
    language: 'Simple universal English',
    audience: 'GLOBAL English-speaking audience (US, UK, India, Nigeria, Philippines, etc)',
    landingPage: 'vouchteck.com',
    identity: 'VouchTeck (worldwide tech deals store)',
    sourcingAngles: ANGLES.english,
    urgency: 'limited stock / deal ends soon',
    engagement: {
      word: 'INTERESTED',
      rule: 'Include ONE line — in the SPOKEN script AND in BOTH captions — asking viewers to comment INTERESTED to get the link. Vary the phrasing every time. Example: "Comment INTERESTED and I\'ll send you the link!"',
    },
    banned: 'Simple, universal English — short words, clear sentences. No Arabic.',
    outputLang: 'english',
    titleField: 'title_english',
    langGuard: 'english-only',
    currency: '$', wasWord: 'instead of', publishLang: 'en',
  },
};

// Per-page banned-word checks, ported from Parse Writer Output's languageOk() in each workflow.
// alshihna (LANGUAGE="arabic") rejects the Darija markers; the Darija pages reject MSA markers.
const BANNED_DARIJA = /(^|\s)(واش|باش|دابا|كاين|غادي|ديال)(?=\s|[،,.!?؟]|$)/;
const BANNED_MSA = /(^|\s)(هذا|هذه|ذلك|ليس|فقط|عند|سوف)(?=\s|[،,.!?؟]|$)/;

/** languageOk — the verbatim acceptance logic from n8n Parse Writer Output. */
function languageOk(key, text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const arabic = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const w = WRITERS[key];
  if (!w) return arabic >= 20;
  if (w.outputLang === 'english') return latin >= 20 && arabic === 0;
  if (w.outputLang === 'arabic') return arabic >= 20 && !BANNED_DARIJA.test(s);
  return arabic >= 20 && arabic >= Math.floor(latin * 0.7) && !BANNED_MSA.test(s);
}

function writerFor(key) { return WRITERS[String(key || '')] || null; }

/**
 * angleFor — owner override: a deterministic rotation so each profile gets its OWN sourcing
 * angle (customs seizure / overstock / import surplus / damaged packaging / returns / liquidation
 * / clearance) and 7 generated scripts never repeat the same cheap-price story.
 */
function angleFor(key, i) {
  const w = writerFor(key);
  const src = (w && w.sourcingAngles) || ANGLES.darija;
  const list = String(src).split(/\s+\/\s+/).map(s => s.trim()).filter(Boolean);
  return list[(((i || 0) % list.length) + list.length) % list.length] || String(src);
}

/**
 * writerPromptBlock — the page's production contract, assembled from the ported pieces in the
 * same order the n8n prompt uses: identity -> landing -> inputs -> angles -> price rules ->
 * structure -> engagement -> language rules -> output contract -> clean-name rule.
 * `inputs` carries the per-run values that n8n injected via {{$json.*}}.
 */
function writerPromptBlock(key, inputs) {
  const w = writerFor(key);
  if (!w) return '';
  const I = inputs || {};
  const lines = [
    'You are a viral copywriter and high-conversion CPA scriptwriter for ' + w.identity +
      '. Write in ' + w.language + (w.audience ? ' for ' + w.audience : '') +
      '. Write a persuasive short-form video script and social captions.',
    '',
    '## Landing Page',
    w.landingPage,
    '',
  ];
  if (I.product) lines.push('Product: ' + I.product);
  if (I.brand) lines.push('Brand: ' + I.brand);
  if (I.category) lines.push('Category: ' + I.category);
  if (I.duration) lines.push('Duration: ' + I.duration + ' seconds');
  if (I.firstAppearance) lines.push('Product first appears at: ' + I.firstAppearance + ' seconds');
  if (I.scenes) lines.push('', 'VIDEO SCENE DESCRIPTIONS:', I.scenes);
  if (I.sellingPrice != null) lines.push('', 'OUR SELLING PRICE (use THIS as our price, ALWAYS): ' + I.sellingPrice);
  if (I.marketPrice != null) lines.push('REAL MARKET PRICE (the \'was\' price to contrast against): ' + I.marketPrice);
  if (I.recentHooks) lines.push('', 'RECENT HOOKS (do not repeat): ' + I.recentHooks);
  lines.push(
    '',
    '## SOURCING ANGLE (pick ONE fresh angle each run, weave it in naturally)',
    w.sourcingAngles,
    I.angle ? 'THIS RUN — use EXACTLY this one angle (sibling pages take other angles): ' + I.angle : '',
    '',
    '## PRICE RULES (critical)',
    SHARED.priceRules.replace('{selling}', I.sellingPrice || 'SELLING').replace('{market}', I.marketPrice || 'MARKET'),
    '',
    '## SCRIPT STRUCTURE (proven high-conversion) — THE FIRST SENTENCE IS THE PRICE',
    '1. OPEN WITH THE PRICE. The FIRST spoken sentence contains our selling price' + (I.sellingPrice ? ' (' + I.sellingPrice + ')' : '') + ' — price shock IS the hook. ' + (I.monthly ? 'Speak it as a MONTHLY payment (e.g. "غير بـ ' + (I.sellingPrice || '200') + ' درهم فالشهر") — never as a one-time cash price.' : 'Not after the features. Not after the hook story.'),
    '2. IMMEDIATELY explain WHY it is this cheap, using ONE sourcing angle from the list below (' + (I.sellingPrice ? 'e.g. "' + (I.sellingPrice || 'السعر') + ' بدل ' + (I.marketPrice || 'السعر العالي') + '"' : 'price contrast') + ').',
    '3. Then desire: the strongest product features the footage actually shows + urgency (' + w.urgency + ').',
    '4. Near the END, before the final line: the payment trust line — the customer does NOT pay before the product arrives, inspects it, confirms it is okay, and only then pays.',
    '5. FINAL sentence = CTA (see ENGAGEMENT TRIGGER). The CTA is the LAST spoken line — nothing may come after it.',
    'Anchor structure: ' + SHARED.sequence,
    '',
    '## ENGAGEMENT TRIGGER (CRITICAL FOR THE AUTO-REPLY BOT)',
    I.ctaStyle === 'link_bio'
      ? 'OWNER OVERRIDE: use the LINK-IN-BIO CTA as the final spoken line (e.g. "دخل للرابط فالبايو وطلب دابا" — natural page-language equivalent). Do NOT ask for a comment.'
      : I.ctaStyle === 'comment'
        ? 'OWNER OVERRIDE: use the COMMENT CTA as the final spoken line (' + w.engagement.word + ').'
        : w.engagement.rule,
    '',
  );
  if (w.surveyFraming) lines.push('## SURVEY FRAMING (CRITICAL)', w.surveyFraming, '');
  lines.push(
    '## LANGUAGE RULES',
    w.banned + ' Weave in the on-screen visuals. Split the script into natural spoken sentences.',
    '',
    '## OUTPUT FORMAT',
    SHARED.outputContract.replace('title_<LANG>', w.titleField),
    '',
    '## CLEAN NAME RULE',
    SHARED.cleanNameRule,
  );
  return lines.join('\n');
}

module.exports = {
  SHARED, WRITERS, writerFor, writerPromptBlock, languageOk,
  PRICE_POLICY, priceFor, premiumProduct, ANGLES, angleFor,
  priceContractOk, foreignPrices, priceNumbers, amountWords, normalizeDigits,
};
