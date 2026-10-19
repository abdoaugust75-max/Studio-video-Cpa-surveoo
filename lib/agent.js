// lib/agent.js — Page Agents: context assembly, tool registry, execution loop.
// The LLM reasons and picks tools; the backend validates and executes them.
// A tool result is the ONLY thing that can produce an artifact — the model cannot fake one.
'use strict';
const path = require('path');
const U = require('./util');
const PAGE_WRITERS = require('./page-writers');

const STUDIO_POLICY = [
  'You are a page agent inside a local AI video-editing studio. You operate ONE social page.',
  '',
  'HARD RULES (violating these breaks the product):',
  '1. Never claim an edit, download, render or voice generation happened unless a tool result says so.',
  '2. Never invent prices, offers, policies, links, statistics or brand facts. Use the approved knowledge or ask.',
  '3. Stay inside your own page: never apply another page\'s voice, style, template or memory.',
  '4. When the owner wants an action, answer with the tool JSON — do not describe what you would do.',
  '4b. For two or more edits in one request, prefer the edit.plan tool with an ordered ops array.',
  '4c. Some steps pause for the owner\'s approval. When that happens the step is NOT finished — tell them it is waiting for review, never that it is done.',
  '5. Report progress honestly: if a tool failed, say what failed and why, in the owner\'s language.',
  '6. Never exceed the video length with narration: check the duration the tools report.',
  '7. Audio layers are distinct. "remove music" means media.remove_music; "mute original video" means media.mute_source; "remove TTS" means media.remove_tts. Never use media.mute unless the owner explicitly asks for a completely silent file.',
  '8. Editing or moving an existing title uses media.text with mode update. Use mode add only when the owner explicitly asks for another text layer.',
  '9. The footage analysis is ground truth. Never write a script for a model/product that the footage does not show, even when the project title or source caption says otherwise.',
  '10. When reporting source-search results, copy candidate titles, product names and IDs exactly from the tool result. Never rename, upgrade or infer a different model in prose.',
  '11. When the owner explicitly says remember, always, never, or corrects a repeated behavior, persist that page-scoped preference automatically with memory.write or memory.consolidate; do not ask them to repeat it.',
].join('\n');

// ---- module-scope search helpers (pure string functions; exported for tests) ----
function isSearchLikeMessage(value) {
    const text = String(value || '');
    // "show the final videos" / "open the 7 finals" / "عرض الفيديوهات" asks to DISPLAY existing
    // batch outputs — it is a workspace view request, never a new source search. Without this
    // guard the search heuristic hijacked it and ran a fresh TikTok discovery pass.
    const showsExisting = /\b(show|open|display|list|view|see|play)\b[\s\S]{0,40}\b(finals?|final videos?|the\s+\d+\s+videos?|versions?)\b/i.test(text)
      || /وريني|شوف|عرض|فتح[\s\S]{0,30}(الفيديوهات|النسخ|النهائي)/i.test(text);
    if (showsExisting) return false;
    return /\b(find|search|look\s+for|get\s+me|show\s+me|send\s+me|bring\s+me|give\s+me|need|fetch)\b[\s\S]{0,140}\b(video|videos|footage|clips?|b-?roll|phone|phones|smartphone|smartphones)\b/i.test(text)
      || /(?:قلب|قلب ليا|ابحث|لقا|جيب|عطيني|صيفط|وريني|بغيت|بغينا|9alab|jib)[\s\S]{0,140}(?:فيديو|فيديوهات|هواتف|تليفونات|تيليفونات|phone|video)/i.test(text)
      || /\b(?:qell?eb|9ell?eb|9alab|jib|jib\s+liya|bghit|bghina)\b[\s\S]{0,160}\b(?:video|videos|unboxing|unbox|phone|phones|smartphone|smartphones)\b/i.test(text)
      || /\b(?:video|videos|footage|clips?|b-?roll)\b/i.test(text) && /\b(?:send|show|give|get|find|search|need)\b/i.test(text);
  }

function requestedSearchCount(value) {
    const t = String(value || '');
    // "5 videos" / "10 phones" / "1 iPhone 16 Pro Max video": a count right before the subject.
    // The lookahead keeps "iPhone 16" from being read as a count (16 is the model, not the quota).
    const m = t.match(/\b(?:at\s+least\s+|up\s+to\s+|give\s+me\s+|send\s+me\s+|show\s+me\s+)?(\d{1,2})\s+(?=(?:different\s+)?(?:videos?|clips?|phones?|smartphones?|b-?roll)\b|iphone\b|galaxy\b|pixel\b|xiaomi\b|ipad\b|laptops?\b|watches?\b|أجهزة|هاتف|هواتف)/i)
      || t.match(/\b(?:at\s+least|at\s+e(?:ast|least)|give\s+me|send\s+me|show\s+me)?\s*(\d{1,2})\s+(?:different\s+)?(?:videos?|clips?)\b/i);
    return m ? Math.max(1, Math.min(10, Number(m[1]))) : 5;
  }

function searchQueryFromMessage(value, messages) {
    const text = String(value || '').trim();
    // A quota request such as "send me at least 5 videos" carries no subject.
    // Reuse the most recent explicit search subject instead of asking the model
    // to invent one or searching the literal quota sentence.
    const stripped = text
      .replace(/\b(?:send|get|find|search|show|bring|give|fetch)\s+me\b/ig, '')
      .replace(/\b(?:send|get|find|search|show|bring|give|fetch)\b/ig, '')
      .replace(/\b(?:at\s+least|up\s+to|give\s+me)\s+\d+\b/ig, '')
      .replace(/\b(?:at\s+e(?:ast|least)|e(?:ast|least))\s+\d+\b/ig, '')
      .replace(/\b\d+\s+(?:different\s+)?(?:videos?|clips?)\b/ig, '')
      .replace(/\b(?:videos?|footage|clips?|b-?roll)\b/ig, '')
      // A bare leading count ("5 smartphone") is a quota, not a subject: the regex deliberately
      // fires only when the number is NOT directly attached to a model name ("S25" must survive).
      .replace(/^\s*\d{1,2}\s+(?=[a-z])/i, (m) => /^\s*\d{1,2}\s+(?:pro|max|plus|ultra)/i.test(m) ? m : '')
      .replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim()
      .replace(/\b(?:search|find|look)\s+(?:on|for)?\s*/i, '')
      .replace(/\bfor\s+me\b/i, '')
      .replace(/^\b(?:of|for|a|an|the)\b\s*/i, '')
      .replace(/^.*?\b(?:like\s+this|similar\s+to)\s*:\s*/i, '')
      .replace(/\b\d{1,2}\b(?!(?:\s*(?:pro|max|plus|ultra)))/gi, '')
      .replace(/^(?:(?:qell?eb|9ell?eb|9alab)(?:\s+(?:liya|lia))?\s+(?:3la|3la)|jib(?:\s+liya)?|bghit|bghina|9alab(?:\s+lia)?\s+3la|قلب(?:\s+ليا)?\s+على|search\s+for|find)\s+/i, '')
      // Darija/Latin search verbs + particles that leak into the subject: "jib liya 5 videos dyal smartphones" → "smartphones"
      .replace(/^\s*(?:jib|jb\s+li(?:ya)?|9alab|9elleb|qelleb|قلب|قلب\s+ليا|قلب\s+لينا|ابحث\s+لي|عطيني|جيب\s+ليا?|وريني|صيفط\s+ليا?|بغيت)\s+/i, '')
      .replace(/(?:^|\s)(?:li(?:ya)?|ليا|لينا)(?=\s|$)/gi, '')
      .replace(/(?:^|\s)(?:dyal|ديال|dial|ta3|تابع|3la|mn)(?=\s|$)/gi, ' ')
      .replace(/(?:^|\s)(?:li(?:ya)?|ليا|لينا)(?=\s|$)/gi, '')
      .replace(/(?:^|\s)(?:lia)(?=\s|$)/gi, '')
      .replace(/\s{2,}/g, ' ')                        // collapse double spaces left by particle strips
      .trim();
    if (stripped && !/^(?:please|more|some|other|again|at\s+east\s+\d+|east\s+\d+)$/i.test(stripped)) return stripped;
    for (const m of (messages || []).slice().reverse()) {
      if (m.role !== 'user') continue;
      const prior = String(m.text || '').trim();
      if (prior && isSearchLikeMessage(prior)) {
        const q = prior.replace(/\b(?:find|search|look\s+for|get\s+me|show\s+me|send\s+me|bring\s+me|give\s+me)\b/ig, '')
          .replace(/\b(?:videos?|footage|clips?|b-?roll)\b/ig, '').trim();
        if (q) return q;
      }
    }
    return text || 'product videos';
  }

function createAgent(o) {
  const store = o.store, media = o.media, jobs = o.jobs, log = o.log || (() => {});
  const services = o.services || {};
  const LOCK = o.locks || require('./locks');
  const llm = o.llm;                      // { text(model,prompt), vision(model,prompt,buf,mime), modelKey() }
  const knowledgeBlock = o.knowledgeBlock || (() => '');

  // ---------------------------------------------------------------- tool registry
  /**
   * Every tool: { name, desc, params, run(args, ctx) }.
   * `params` drives both validation and the prompt text, so the model can never see a tool
   * that does not exist, and cannot call one with an out-of-range argument.
   */
  const TOOLS = {};
  const add = t => { TOOLS[t.name] = t; return t; };

  const mediaOp = (name, opName, desc, params) => add({
    name, desc, params: { project: { type: 'string' }, ...params },
    async run(a, ctx) {
      const project = ctx.projectId;
      if (!project) throw new Error('no project is open — import a URL or create a project first');
      const art = await media.applyOp(project, opName, a, ctx);
      return { artifact: art, note: art.label + ' → ' + art.rel };
    },
  });

  add({ name: 'media.import_url', desc: 'Download a supported video URL into a project and analyse what happens in it.', params: { url: { type: 'string', max: 500, required: true }, title: { type: 'string', max: 120 } },
    async run(a, ctx) { return services.importUrl({ page: ctx.page, project: ctx.projectId, url: a.url, title: a.title, ctx }); } });

  add({ name: 'media.search', desc: 'Search for source videos matching a request. Returns up to the requested number of real, ranked candidate cards; never invent candidates.', params: { query: { type: 'string', max: 200, required: true }, limit: { type: 'number', min: 1, max: 8, def: 5 } },
    // Visual verification is PERMANENT studio policy, not a per-call option: the tool does not
    // even accept a vision flag, so no caller (model, route or panel) can produce a shortlist
    // whose candidates were not frame-checked for faces, bodies, slideshows and relevance.
    async run(a, ctx) { return services.search(a.query, ctx, { page: ctx.page, project: ctx.projectId, limit: a.limit || 5, vision: true }); } });

  // source.import — import a candidate the owner selected from a previous search result.
  add({ name: 'source.import', desc: 'Import one search candidate (by its candidate id from a search result) as the project source video.', params: { candidate: { type: 'string', max: 40, required: true }, project: { type: 'string', max: 40 } },
    async run(a, ctx) { return services.importCandidate({ page: ctx.page, project: a.project || ctx.projectId, candidateId: a.candidate, ctx }); } });

  // ------------------------------------------------------------ the saved source library
  // Saving is a pointer, not a download: the owner can keep a clip for later without spending disk
  // or bandwidth on footage they have not chosen. Importing a saved source goes through the SAME
  // import job as a fresh candidate, so there is one validated path into a project.
  add({ name: 'source.save', desc: 'Keep a source in the owner\'s library for later WITHOUT downloading it. Pass a candidate id from a search, or a URL.', params: {
      candidate: { type: 'string', max: 40 }, url: { type: 'string', max: 500 }, title: { type: 'string', max: 140 },
      collection: { type: 'string', max: 40 }, tags: { type: 'jsontext', max: 400 }, note: { type: 'string', max: 300 } },
    async run(a, ctx) {
      let input = null;
      const id = String(a.candidate || '').replace(/[^a-z0-9_]/gi, '');
      if (id) { const hit = services.findCandidate ? services.findCandidate(id) : null; if (!hit) return { saved: false, error: 'that candidate id is not in a recent search — search again, then save' }; input = { url: hit.source, title: hit.title, author: hit.author, play: hit.play, cover: hit.cover, duration: hit.duration }; }
      else input = { url: a.url, title: a.title };
      if (!input.url) return { saved: false, error: 'a candidate id or a url is required' };
      const r = services.saved.save({ ...input, page: ctx.page, collection: a.collection, note: a.note, tags: a.tags });
      return { saved: true, created: r.created, id: r.record.id, title: r.record.title || r.record.url, note: 'The library holds the link, not the video.' };
    } });

  add({ name: 'saved.search', desc: 'Search the owner\'s saved sources (the ones they kept for later). Returns the real stored records, newest first when no terms are given.', params: {
      q: { type: 'string', max: 120 }, collection: { type: 'string', max: 40 }, limit: { type: 'number', min: 1, max: 50, def: 12 } },
    async run(a) {
      const r = services.saved.search({ q: a.q, collection: a.collection, limit: a.limit });
      return { total: r.total, items: r.items.map(x => ({ id: x.id, title: x.title, duration: x.duration, collection: x.collection, availability: (x.availability || {}).state, url: x.url })), collections: services.saved.collections() };
    } });

  add({ name: 'saved.import', desc: 'Import a source from the owner\'s saved library into the open (or a new) project.', params: { id: { type: 'string', max: 40, required: true }, project: { type: 'string', max: 40 } },
    async run(a, ctx) { return services.savedImport({ page: ctx.page, project: a.project || ctx.projectId, id: a.id, ctx }); } });

  add({ name: 'saved.forget', desc: 'Remove one source from the saved library. Only the library record is removed; nothing already imported is touched.', params: { id: { type: 'string', max: 40, required: true } },
    async run(a) { const r = services.saved.remove(a.id); return r.removed ? { removed: r.record.id, title: r.record.title || '' } : { removed: false, error: 'not in the library' }; } });

  // ------------------------------------------------------------------ publishing tools
  // Deliberately NO publish.execute tool. Posting to a real page is the one irreversible action in
  // the product, so the model may PLAN a post (which validates permissions and changes nothing) and
  // the owner confirms it in the UI. A model that could post on its own could cross-publish a page.
  add({ name: 'publish.destinations', desc: 'List the destinations this page agent is authorised to publish to.', params: { page: { type: 'string', max: 40 } },
    async run(a, ctx) { const k = a.page || ctx.page; return { page: k, destinations: services.publish.destinations(k) }; } });
  add({ name: 'publish.plan', desc: 'Dry-run a publish: shows exactly which video would go to which destination, and refuses anything not authorised. Nothing is posted.', params: { artifacts: { type: 'string', max: 2000 }, destinations: { type: 'string', max: 500 } },
    async run(a) {
      const list = x => String(x || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      return services.publish.plan({ artifacts: list(a.artifacts), destinations: list(a.destinations) });
    } });

  add({ name: 'media.inspect', desc: 'Inspect the open project: source, current artifact, probe data, what the video shows, applied edits.', params: {},
    async run(a, ctx) {
      const p = store.project(ctx.projectId);
      if (!p) throw new Error('no project open');
      const cur = p.current ? store.artifact(p.current) : null;
      return { project: p.id, title: p.title, source: p.source, current: cur ? { op: cur.op, version: cur.version, probe: cur.probe, rel: cur.rel } : null, analysis: p.analysis, videoUnderstanding: p.videoUnderstanding || null, truth: groundTruth(p), operations: p.operations.slice(-12) };
    } });

  add({ name: 'script.create', desc: 'Create a first-class script artifact grounded in the imported footage. The text must describe the product shown in the stored analysis.', params: {
      text: { type: 'string', max: 4000, required: true }, title: { type: 'string', max: 120 }, language: { type: 'string', max: 40 } },
    async run(a, ctx) {
      const p = store.project(needProject(ctx));
      const truth = groundTruth(p);
      const art = store.addArtifact({
        project: p.id, kind: 'script', op: 'script', attach: false, parent: p.current || null,
        text: a.text, params: { language: a.language || store.page(p.page).lang, groundedProduct: truth && truth.product || null },
        label: a.title || 'Script',
      });
      return { artifact: art, groundedProduct: truth && truth.product || null, note: 'Script saved as a durable artifact; the playable video pointer was not changed.' };
    } });

  mediaOp('media.trim', 'trim', 'Cut the video to a time range (seconds from the start).', { start: { type: 'number', min: 0, max: 7200, required: true }, duration: { type: 'number', min: 0.2, max: 7200, required: true } });
  mediaOp('media.ratio', 'crop_ratio', 'Change aspect ratio (9:16, 1:1, 16:9, 4:5, 3:4).', { ratio: { type: 'enum', values: ['9:16', '1:1', '16:9', '4:5', '3:4'], def: '9:16' } });
  mediaOp('media.resize', 'resize', 'Scale to exact dimensions.', { width: { type: 'number', min: 128, max: 3840, def: 1080 }, height: { type: 'number', min: -2, max: 3840, def: -2 } });
  mediaOp('media.speed', 'speed', 'Change playback speed.', { factor: { type: 'number', min: 0.25, max: 3, def: 1.15 } });
  mediaOp('media.text', 'overlay_text', 'Add or update a timed text layer (Arabic/Latin bidi-safe). Default mode update replaces the latest text layer; mode add creates another layer.', { text: { type: 'string', max: 200, required: true }, at: { type: 'number', min: 0, max: 7200, def: 0 }, duration: { type: 'number', min: 0.3, max: 7200, def: 3 }, size: { type: 'number', min: 12, max: 160, def: 64 }, position: { type: 'enum', values: ['top', 'center', 'bottom'], def: 'bottom' }, mode: { type: 'enum', values: ['update', 'add'], def: 'update' }, layerId: { type: 'string', max: 40 } });
  // jsontext, not string: the generic text sanitiser strips the quotes and backslashes that JSON is
  // made of, so a `string` param here can never survive validation (see media.validate).
  mediaOp('media.subtitles', 'burn_subs', 'Burn subtitle lines. Pass lines as a JSON string: [{"start":1,"end":3,"text":"…"}].', { lines: { type: 'jsontext', max: 20000, required: true } });
  mediaOp('media.volume', 'volume', 'Set audio level (0 mute … 3 loud).', { factor: { type: 'number', min: 0, max: 3, def: 1.5 } });
  mediaOp('media.mute', 'mute', 'Remove the audio track.', {});
  mediaOp('media.remove_music', 'remove_music', 'Remove only the music layer; preserve source audio and TTS.', {});
  mediaOp('media.mute_source', 'mute_source', 'Mute only the original source audio; preserve music and TTS.', {});
  mediaOp('media.remove_tts', 'remove_tts', 'Remove only the TTS/voiceover layer; preserve source audio and music.', {});
  mediaOp('media.source_volume', 'source_volume', 'Change only the original source-audio gain.', { factor: { type: 'number', min: 0, max: 3, def: 0.5 } });
  mediaOp('media.music_volume', 'music_volume', 'Change only the music gain.', { factor: { type: 'number', min: 0.01, max: 1, def: 0.18 } });
  mediaOp('media.music', 'mix_music', 'Download and mix background music under the audio (ducked).', { url: { type: 'string', max: 500, required: true }, title: { type: 'string', max: 120 }, volume: { type: 'number', min: 0.02, max: 1, def: 0.22 } });
  mediaOp('media.voiceover', 'voiceover', 'Generate a voiceover and mix it over the attenuated original audio.', { text: { type: 'string', max: 1500, required: true }, voice: { type: 'string', max: 40 }, rate: { type: 'number', min: 0.6, max: 1.6, def: 1 }, bed: { type: 'number', min: 0, max: 1, def: 0.15 } });
  mediaOp('media.cta', 'append_cta', 'Append the current page agent\'s own Facebook or Instagram CTA/profile card.', { platform: { type: 'enum', values: ['facebook', 'instagram'], def: 'facebook' } });
  mediaOp('media.render', 'render', 'Render the project: preview (fast) or final (production).', { mode: { type: 'enum', values: ['preview', 'final'], def: 'preview' } });
  mediaOp('media.frame', 'extract_frame', 'Export one frame as PNG.', { at: { type: 'number', min: 0, max: 7200, def: 0 } });

  add({ name: 'tts.generate', desc: 'Generate a standalone voiceover audio file (previewable, not yet in the video). Produces AUDIO ONLY — never a video, never a render.', params: { text: { type: 'string', max: 1500, required: true }, voice: { type: 'string', max: 40 }, rate: { type: 'number', min: 0.6, max: 1.6, def: 1 } },
    async run(a, ctx) { return services.tts({ page: ctx.page, project: ctx.projectId, text: a.text, voice: a.voice, rate: a.rate }); } });
  add({ name: 'pages.ttsAll', desc: 'Generate exactly ONE TTSArtifact per profile from that profile\'s current script. STOPS THERE: no video, no music, no captions, no render. Fails per-profile without touching the others.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.ttsAll) throw new Error('batch TTS is not available in this process');
      return services.ttsAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), ctx });
    } });

  add({ name: 'pages.titlesAll', desc: 'Promote each profile\'s suggested on-video TITLE (from the n8n writer contract) into a reviewable TitleArtifact per profile. STOPS THERE: nothing is burned into video, no render. Titles stay suggestions until the owner approves them.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.titlesAll) throw new Error('batch titles are not available in this process');
      return services.titlesAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), ctx });
    } });

  add({ name: 'pages.setPrice', desc: 'The owner\'s EXPLICIT price override for one profile (or all): record the exact selling price (or monthly installment) on the CURRENT batch and invalidate that branch\'s script/TTS/video so the next generation uses it. Money handling only — no generation happens here.', params: { profile: { type: 'string', max: 60, required: true }, amount: { type: 'number', required: true }, monthly: { type: 'boolean', def: false } },
    async run(a, ctx) {
      if (!services.setPrice) throw new Error('price override is not available in this process');
      return services.setPrice({ profile: a.profile, amount: a.amount, monthly: a.monthly, ctx });
    } });
  add({ name: 'pages.setCtaStyle', desc: 'The owner\'s EXPLICIT CTA preference ("link_bio" or "comment") for one profile or all. The NEXT script generation for those profiles opens and ends with that CTA style. Configuration only — nothing is generated here.', params: { profile: { type: 'string', max: 60, required: true }, style: { type: 'string', max: 20, required: true } },
    async run(a, ctx) {
      if (!services.setCtaStyle) throw new Error('CTA style is not available in this process');
      return services.setCtaStyle({ profile: a.profile, style: a.style, ctx });
    } });

  // ---- one-stage-per-command batch tools: each does EXACTLY its stage and nothing else ----
  add({ name: 'pages.musicAll', desc: 'Add ONE distinct licensed background music track per profile to the CURRENT batch (a durable playable MusicArtifact each). STOPS THERE: no mixing into video, no render, no captions.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.musicAll) throw new Error('batch music is not available in this process');
      return services.musicAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), ctx });
    } });
  add({ name: 'pages.captionsAll', desc: 'Generate captions for every profile from the REAL TTS-audio transcript and burn a captioned preview per profile. A healthy caption for the current TTS is reused; pass force=true ONLY when the owner explicitly asks to REGENERATE subtitles. STOPS THERE: no final render, no CTA, no publish.', params: { pages: { type: 'string', max: 500 }, force: { type: 'boolean' } },
    async run(a, ctx) {
      if (!services.captionsAll) throw new Error('batch captions are not available in this process');
      return services.captionsAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), force: !!a.force, ctx });
    } });
  add({ name: 'pages.ctaAll', desc: 'Append each profile\'s OWN production CTA card to its current video. STOPS THERE: no descriptions, no final render, no publish.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.ctaAll) throw new Error('batch CTA is not available in this process');
      return services.ctaAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), ctx });
    } });
  add({ name: 'pages.descriptionsAll', desc: 'Create one DescriptionArtifact per profile from that profile\'s own n8n description template (landing link, engagement CTA, social captions, Instagram variant). Text only: no video work.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.descriptionsAll) throw new Error('batch descriptions are not available in this process');
      return services.descriptionsAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), ctx });
    } });
  add({ name: 'pages.renderAll', desc: 'THE final-render stage: compose and encode one final video per profile from the CURRENT batch pointers only (script, TTS, music, captions, that profile\'s CTA card). Run ONLY when the owner explicitly asks for the final render. No publishing of any kind.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.renderAll) throw new Error('batch render is not available in this process');
      return services.renderAll({ pages: String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean), ctx });
    } });

  add({ name: 'music.search', desc: 'Find music candidates to preview before mixing.', params: { query: { type: 'string', max: 120, required: true } },
    async run(a) { return services.musicSearch(a.query); } });
  add({ name: 'music.save', desc: 'Save one searched music candidate to the library without downloading it.', params: { id: { type: 'string', max: 80, required: true } },
    async run(a, ctx) { return services.saveMusic({ id: a.id, page: ctx.page, project: ctx.projectId }); } });
  add({ name: 'music.use', desc: 'Create a durable playable MusicArtifact for one searched candidate.', params: { id: { type: 'string', max: 80, required: true }, volume: { type: 'number', min: 0.02, max: 1, def: 0.22 } },
    async run(a, ctx) { return services.useMusic({ id: a.id, page: ctx.page, project: ctx.projectId, volume: a.volume }); } });

  // ------------------------------------------------------------ locks, suites, review
  add({ name: 'locks.get', desc: 'Which edit layers are locked on the open project (own locks and any inherited from the master edit).', params: {},
    async run(a, ctx) {
      const p = store.project(ctx.projectId);
      if (!p) throw new Error('no project is open');
      return {
        project: p.id, role: p.role,
        layers: LOCK.describe(p.locks, store.inheritedLocks(p.id)),
        summary: LOCK.summary(p.locks, store.inheritedLocks(p.id)),
      };
    } });

  add({ name: 'locks.set', desc: 'Lock or unlock an edit layer on the open project. Locked layers cannot be edited by any operation.',
    params: { layer: { type: 'enum', values: LOCK.LAYERS.map(l => l.key), required: true }, locked: { type: 'bool', def: true } },
    async run(a, ctx) {
      const p = store.project(ctx.projectId);
      if (!p) throw new Error('no project is open');
      const inh = store.inheritedLocks(p.id);
      if (inh[a.layer] && a.locked === false) throw new Error(LOCK.BY_KEY.get(a.layer).label + ' is locked on the master edit, so this branch inherits it — release it on the master instead');
      const next = { ...(p.locks || {}) };
      if (a.locked === false) delete next[a.layer]; else next[a.layer] = true;
      const saved = store.setLocks(p.id, next);
      return { project: saved.id, layer: a.layer, locked: !!saved.locks[a.layer], layers: LOCK.describe(saved.locks, inh).filter(l => l.locked) };
    } });

  add({ name: 'master.start', desc: 'Create a suite: a master edit every page version will be built from. Optionally copy an existing project\'s cut in as the starting point.',
    params: { title: { type: 'string', max: 120 }, from: { type: 'string', max: 40 } },
    async run(a, ctx) { const r = services.suite.startMaster({ page: ctx.page, title: a.title, from: a.from || ctx.projectId || null, ctx }); return { suite: r.suite, master: r.master, note: 'The master is a draft until you approve it.' }; } });

  add({ name: 'master.approve', desc: 'Approve (or reject) the master edit. Page versions are only generated from an approved master by default.',
    params: { project: { type: 'string', max: 40 }, status: { type: 'enum', values: ['approved', 'draft', 'rejected'], def: 'approved' }, note: { type: 'string', max: 300 } },
    async run(a, ctx) { const p = store.setMasterStatus(a.project || ctx.projectId, a.status, a.note || ''); store.setReview(p.id, p.masterStatus === 'approved' ? 'approved' : 'waiting', { note: a.note || '' }); return { project: p.id, masterStatus: p.masterStatus }; } });

  add({ name: 'branch.plan', desc: 'Show exactly what a page version would do: the operations it will run and the steps it must skip, with the reason for each skip.',
    params: { suite: { type: 'string', max: 40, required: true }, page: { type: 'string', max: 40, required: true } },
    async run(a) {
      const s = store.suite(a.suite);
      if (!s) throw new Error('unknown suite: ' + a.suite);
      const recipe = services.suite.recipeFor(a.page);
      const probe = { id: 'preview', role: 'branch', suite: s.id, master: { suite: s.id, project: s.master, artifact: null }, locks: {}, current: null, branch: { recipe } };
      const plan = services.suite.branchPlan(probe, recipe);
      return { suite: s.id, page: a.page, recipe, willRun: plan.steps.map(x => x.op), willSkip: plan.skipped, note: 'Nothing has been created or rendered by this call.' };
    } });

  add({ name: 'branches.generate', desc: 'Generate page versions from the approved master — one per selected page agent. Runs as one isolated job per branch; a failing branch does not stop the others.',
    params: { suite: { type: 'string', max: 40, required: true }, pages: { type: 'string', max: 400 }, ttsText: { type: 'string', max: 1200 } },
    async run(a, ctx) {
      const pages = String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean).map(x => x.replace(/[^a-z0-9_]/gi, ''));
      const r = await services.suite.generate({ suiteId: a.suite, pages: pages.length ? pages : null, recipe: a.ttsText ? null : null, ctx, requireApproval: true });
      return { suite: r.suite, ready: r.ready, failed: r.failed, branches: r.branches.map(b => ({ page: b.page, status: b.status, branch: b.branch, error: b.error || null, steps: (b.steps || []).length, skipped: (b.skipped || []).length })) };
    } });

  add({ name: 'pages.fanout', desc: 'Run one isolated pipeline for every selected page. mode=scripts_only creates exactly one grounded ScriptArtifact per page and stops; mode=production may continue to TTS, music and render only when explicitly requested.', params: {
    brief: { type: 'string', max: 1800, required: true },
    pages: { type: 'string', max: 500 },
    sourceProject: { type: 'string', max: 40 },
    mode: { type: 'enum', values: ['scripts_only', 'production'], def: 'production' },
    music: { type: 'boolean', def: true },
    render: { type: 'boolean', def: true },
  },
    async run(a, ctx) {
      if (!services.fanout) throw new Error('multi-page production is not available in this process');
      const pages = String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean);
      return services.fanout({ pages, sourceProject: a.sourceProject || ctx.projectId, brief: a.brief, mode: a.mode || 'production', music: a.music !== false, render: a.render !== false, ctx });
    } });
  add({ name: 'pages.fanout.attach', desc: 'Attach the latest completed per-page fanout artifacts to the orchestrator conversation without creating new media.', params: { pages: { type: 'string', max: 500 } },
    async run(a, ctx) {
      if (!services.fanoutAttach) throw new Error('fanout attachment is not available in this process');
      const pages = String(a.pages || '').split(',').map(x => x.trim()).filter(Boolean);
      return services.fanoutAttach({ pages, owner: ctx.page });
    } });

  add({ name: 'pages.reviseScript', desc: 'Change ONE page profile\'s script after owner review (hook, wording, structure…) and leave every other profile untouched. Use this instead of page.ask when the owner reviewed the batch and wants one profile fixed. profile is the page key or a unique part of its name; instruction is the exact change to apply.', params: {
    profile: { type: 'string', max: 60, required: true }, instruction: { type: 'string', max: 1200, required: true } },
    async run(a, ctx) {
      if (!services.reviseScript) throw new Error('single-profile script revision is not available in this process');
      return services.reviseScript({ profile: a.profile, instruction: a.instruction, ctx });
    } });

  add({ name: 'branch.regenerate', desc: 'Redo one page version without touching the others. Only: all|hook|captions|tts|music.',
    params: { branch: { type: 'string', max: 40, required: true }, only: { type: 'enum', values: ['all', 'hook', 'captions', 'tts', 'music'], def: 'all' } },
    async run(a, ctx) { const r = await services.suite.regenerateBranch({ branchId: a.branch, only: a.only, ctx }); return { mode: r.mode, status: r.status, artifact: r.artifact ? r.artifact.id : null, skipped: r.skipped || [] }; } });

  add({ name: 'suite.get', desc: 'The master and every page version of a suite, each with its own artifact, status and edit summary.',
    params: { suite: { type: 'string', max: 40, required: true } },
    async run(a) { return services.suite.comparison(a.suite); } });

  add({ name: 'review.queue', desc: 'Everything waiting for the owner\'s decision: masters, page versions and paused approvals.', params: {},
    async run(a, ctx) { const items = store.reviewQueue({ page: ctx.page }); return { total: items.length, items: items.map(x => ({ project: x.project, title: x.title, role: x.role, kind: x.kind, state: x.state, note: x.note || null })) }; } });

  add({ name: 'batch.correct', desc: 'Apply ONE structured correction to several page versions at once (music_volume, audio_volume, text_size, tts_rate, speed, caption_preset). Dry run by default; locked branches are skipped with a reason.',
    params: { branches: { type: 'string', max: 800, required: true }, kind: { type: 'enum', values: Object.keys(services.suite.CORRECTIONS), required: true }, value: { type: 'number', min: 0, max: 100 }, dryRun: { type: 'bool', def: true } },
    async run(a) {
      const ids = String(a.branches).split(',').map(x => x.trim()).filter(Boolean);
      if (!ids.length) throw new Error('name at least one branch project id');
      const kind = a.kind;
      const value = a.value != null ? a.value : (kind === 'caption_preset' ? 0 : null);
      if (kind !== 'caption_preset' && value == null) throw new Error('a numeric value is required for ' + kind);
      return services.suite.batchCorrect({ branches: ids, kind, value, dryRun: a.dryRun !== false });
    } });

  add({ name: 'analytics.intel', desc: 'Observations computed from the metrics the platform actually returned. Reports the sample size; makes no causal claim.', params: {},
    async run(a, ctx) { return services.analyticsIntel(ctx.page); } });

  // ---- transcription / captions / timeline -------------------------------------------------
  // These tools call the SAME services the editor panels call, so a tool result always matches what
  // the owner sees in the transcript, caption and timeline panels. If a tool says it transcribed or
  // changed a caption, the panel genuinely shows it.
  const needProject = ctx => {
    if (!ctx.projectId) throw new Error('no project is open — import a video or pick a project first');
    return ctx.projectId;
  };

  add({ name: 'transcription.generate', desc: 'Transcribe the speech in the current video into a timed transcript. Reuses a cached transcript when the audio and settings are unchanged.', params: { language: { type: 'string', max: 40 }, force: { type: 'boolean' } },
    async run(a, ctx) {
      const r = await services.transcribe.run({
        projectId: needProject(ctx), language: a.language || 'auto', force: !!a.force,
        progress: ctx.progress, note: ctx.note,
      });
      return {
        transcription: r.transcription.id, cached: !!r.cached, language: r.transcription.language,
        duration: r.transcription.duration, segments: r.transcription.segments.length,
        timing: r.transcription.timing, wordTimings: r.transcription.wordTimings,
        note: r.transcription.precisionNote,
        segments_preview: r.transcription.segments.slice(0, 12).map(s => ({ from: s.start, to: s.end, text: s.text })),
        full_text: r.transcription.text.slice(0, 2500),
      };
    } });

  add({ name: 'transcription.get', desc: 'Read the project transcript (segments with timestamps, plus the owner\'s corrections).', params: { transcription: { type: 'string', max: 40 } },
    async run(a, ctx) {
      const project = needProject(ctx);
      const t = a.transcription ? store.transcription(project, a.transcription) : store.transcriptions(project)[0];
      if (!t) return { transcript: null, note: 'this project has not been transcribed yet' };
      return {
        transcription: t.id, language: t.language, model: t.model, timing: t.timing, wordTimings: !!t.wordTimings,
        duration: t.duration, corrections: Object.keys(t.corrections || {}).length,
        segments: (t.segments || []).map(s => ({
          id: s.id, from: s.start, to: s.end,
          text: (t.corrections && t.corrections[s.id] && t.corrections[s.id].text) || s.text,
        })),
      };
    } });

  add({ name: 'transcription.correct', desc: 'Fix the text of one transcript segment. The machine transcription is preserved beside the correction.', params: { transcription: { type: 'string', max: 40 }, segment: { type: 'string', max: 20, required: true }, text: { type: 'string', max: 600, required: true } },
    async run(a, ctx) {
      const project = needProject(ctx);
      const t = a.transcription || ((store.transcriptions(project)[0] || {}).id);
      if (!t) throw new Error('this project has no transcript yet');
      const rec = services.transcribe.correct(project, t, { segmentId: a.segment, text: a.text });
      return { transcription: rec.id, corrected: a.segment, totalCorrections: Object.keys(rec.corrections || {}).length };
    } });

  add({ name: 'caption.create', desc: 'Build a caption track from the transcript: real measured timings, wrapped to the style\'s line limits. Only works on a real transcript.', params: {
    transcription: { type: 'string', max: 40 }, preset: { type: 'string', max: 40 },
    maxChars: { type: 'number', min: 12, max: 400 }, maxWords: { type: 'number', min: 2, max: 80 },
    maxDuration: { type: 'number', min: 1, max: 30 }, splitLongSegments: { type: 'boolean' },
  },
    async run(a, ctx) {
      const project = needProject(ctx);
      const p = store.project(project);
      const t = a.transcription || ((store.transcriptions(project)[0] || {}).id);
      if (!t) throw new Error('transcribe the video first — captions come from measured timings');
      const track = services.captions.createTrack({
        projectId: project, page: p.page, transcriptionId: t, preset: a.preset || 'bold_social',
        options: { maxChars: a.maxChars, maxWords: a.maxWords, maxDuration: a.maxDuration, splitLongSegments: a.splitLongSegments },
      });
      return {
        track: track.id, version: track.version, preset: track.preset, segments: track.segments.length,
        timing: services.captions.timingReport(track),
        preview: track.segments.slice(0, 10).map(s => ({ from: s.start, to: s.end, text: s.display || s.text })),
      };
    } });

  add({ name: 'caption.update', desc: 'Edit the caption track: per-segment text/timing/position, a whole-track style, or a preset. Saves a new version.', params: {
    track: { type: 'string', max: 40 }, segments: { type: 'jsontext', max: 20000 }, style: { type: 'jsontext', max: 4000 }, preset: { type: 'string', max: 40 },
  },
    async run(a, ctx) {
      const project = needProject(ctx);
      let segments = null, style = null;
      if (a.segments) { try { segments = typeof a.segments === 'string' ? JSON.parse(a.segments) : a.segments; } catch (_) { throw new Error('segments must be a JSON array of {id, text?, start?, end?, position?, emphasis?}'); } }
      if (a.style) { try { style = typeof a.style === 'string' ? JSON.parse(a.style) : a.style; } catch (_) { throw new Error('style must be a JSON object'); } }
      const track = services.captions.updateTrack({ projectId: project, trackId: a.track || null, segments, style, preset: a.preset || null });
      return { track: track.id, version: track.version, preset: track.preset, segments: track.segments.length };
    } });

  add({ name: 'caption.burn', desc: 'Burn the caption track into the video as a new version (fast preview). Timings come from the track, never from the model.', params: { track: { type: 'string', max: 40 } },
    async run(a, ctx) {
      const project = needProject(ctx);
      const art = await services.burnCaptions({ project, track: a.track || null, ctx });
      return { artifact: { id: art.id, op: art.op, label: art.label, rel: art.rel, kind: art.kind, duration: art.probe && art.probe.duration, width: art.probe && art.probe.width, height: art.probe && art.probe.height }, track: art.track, segments: art.segments };
    } });

  add({ name: 'caption.presets', desc: 'List the caption style presets that the renderer actually honours.', params: {},
    async run() { return { presets: services.captions.presets(), defaults: services.captions.resolveStyle('bold_social') }; } });

  add({ name: 'timeline.get', desc: 'The project timeline as real tracks and blocks (video, original audio, TTS, music, captions, text).', params: {},
    async run(a, ctx) { return services.editor.timeline(needProject(ctx)); } });

  add({ name: 'timeline.suggest', desc: 'Observations about the current cut, each with the evidence it came from. Informational: nothing is applied automatically.', params: {},
    async run(a, ctx) { return services.editor.suggestions(needProject(ctx)); } });

  add({ name: 'version.tree', desc: 'The artifact version graph with parent links, so branches and rollback targets are visible.', params: {},
    async run(a, ctx) { return services.editor.versionTree(needProject(ctx)); } });

  add({ name: 'artifact.drawer', desc: 'Every artifact the project has produced, grouped: source, versions, previews, finals, tts, music, transcripts, captions, frames.', params: {},
    async run(a, ctx) { return services.editor.drawer(needProject(ctx)); } });

  add({ name: 'preview.render', desc: 'Render a fast preview of the current cut. Repeat calls while one is pending are coalesced, not stacked.', params: {},
    async run(a, ctx) {
      const r = services.previewRender({ page: ctx.page, project: needProject(ctx) });
      return { job: r.job, coalesced: r.coalesced, note: 'The preview is built from the project\'s current version when it runs.' };
    } });

  add({ name: 'template.save', desc: 'Save the current editing recipe (settings and operations, never rendered media) as a reusable template.', params: { name: { type: 'string', max: 60, required: true } },
    async run(a, ctx) {
      const p = store.project(needProject(ctx));
      const byId = new Map(store.artifactsOf(p.id).map(x => [x.id, x]));
      const lineage = [];
      let cursor = p.current ? byId.get(p.current) : null;
      while (cursor) { lineage.unshift(cursor); cursor = cursor.parent ? byId.get(cursor.parent) : null; }
      const reusable = new Set(['crop_ratio', 'resize', 'speed', 'overlay_text', 'volume', 'mute_source', 'source_volume', 'music_volume', 'remove_music']);
      const operations = lineage.filter(x => reusable.has(x.op)).map(x => ({ op: x.op, params: JSON.parse(JSON.stringify(x.params || {})) }));
      const latestCaption = (p.captions || []).slice(-1)[0] || null;
      const latestVoice = lineage.slice().reverse().find(x => x.op === 'voiceover');
      const recipe = store.saveTemplate({
        name: a.name, kind: 'editing_recipe', version: 1, page: p.page,
        operations,
        captions: latestCaption ? { preset: latestCaption.preset || null, style: latestCaption.style || null } : null,
        tts: latestVoice ? { voice: latestVoice.params && latestVoice.params.voice || '', rate: latestVoice.params && latestVoice.params.rate || 1, bed: latestVoice.params && latestVoice.params.bed } : null,
        render: { ratio: (p.analysis && p.analysis.ratio) || null },
      });
      return { saved: true, template: recipe.name, operations: operations.length, note: 'Saved the recipe only; no source or rendered media was copied.' };
    } });

  add({ name: 'template.apply', desc: 'Apply a saved editing recipe to the current project and create new artifact versions.', params: { name: { type: 'string', max: 60, required: true } },
    async run(a, ctx) {
      const t = store.template(a.name);
      if (!t) return { applied: false, error: 'template not found: ' + a.name, available: store.templates().map(x => x.name) };
      const p = store.project(ctx.projectId);
      if (!p || !p.current) throw new Error('open a project with a playable source before applying a template');
      p.template = t.name;
      p.templateSettings = { captions: t.captions || null, tts: t.tts || null, render: t.render || null };
      store.saveProject(p);
      const produced = [];
      for (const step of (t.operations || [])) {
        const art = await media.applyOp(p.id, step.op, JSON.parse(JSON.stringify(step.params || {})), ctx);
        produced.push({ id: art.id, op: art.op, rel: art.rel });
      }
      return { applied: true, template: t.name, artifacts: produced, settings: p.templateSettings, note: 'Applied recipe settings to this project without copying the original media.' };
    } });

  add({ name: 'artifact.list', desc: 'List the version history of the current project.', params: {},
    async run(a, ctx) {
      const p = store.project(ctx.projectId);
      if (!p) throw new Error('no project open');
      return { current: p.current, artifacts: store.artifactsOf(p.id).map(x => ({ id: x.id, op: x.op, version: x.version, label: x.label, rel: x.rel, duration: x.probe ? x.probe.duration : null, ts: x.ts })) };
    } });

  add({ name: 'artifact.rollback', desc: 'Move the project pointer to an earlier (or later) version. Nothing is re-rendered.', params: { artifact: { type: 'string', max: 40, required: true } },
    async run(a, ctx) { const p = store.rollback(ctx.projectId, a.artifact); return { current: p.current }; } });

  add({ name: 'memory.write', desc: 'Persist a durable preference for THIS page (rule, correction, hook or style).', params: {
      rule: { type: 'string', max: 300 }, correction: { type: 'string', max: 300 }, hook: { type: 'string', max: 200 }, product: { type: 'string', max: 80 },
      style: { type: 'string', max: 200, def: '' } },
    async run(a, ctx) {
      const patch = {};
      for (const k of ['rule', 'correction', 'hook', 'product']) if (a[k]) patch[k] = a[k];
      if (a.style) patch.style = { note: a.style };
      const m = store.writeMemory(ctx.page, patch);
      return { saved: Object.keys(patch), rules: m.rules.length, hooks: m.hooks.length };
    } });

  add({ name: 'memory.query', desc: 'Read this page\'s memory (rules, corrections, hooks, products, style).', params: {},
    async run(a, ctx) { return { page: ctx.page, memory: store.memory(ctx.page) }; } });

  add({ name: 'memory.consolidate', desc: 'Persist repeated or explicitly stated durable preferences without importing the whole chat history. Scope is page by default; global and project require an explicit scope.', params: {
      scope: { type: 'enum', values: ['page', 'global', 'project'], def: 'page' },
      project: { type: 'string', max: 40 },
      observations: { type: 'jsontext', max: 6000, required: true },
    },
    async run(a, ctx) {
      let observations = a.observations;
      if (typeof observations === 'string') { try { observations = JSON.parse(observations); } catch (_) { throw new Error('observations must be a JSON array'); } }
      if (!Array.isArray(observations)) throw new Error('observations must be a JSON array');
      if (a.scope === 'project' && !a.project && !ctx.projectId) throw new Error('project scope requires a project');
      const m = store.consolidateMemory({ scope: a.scope || 'page', page: ctx.page, project: a.project || ctx.projectId, observations });
      return { scope: a.scope || 'page', saved: m.stats.observations, updated: m.updated, preferences: m.preferences, rules: m.rules.slice(-8) };
    } });

  add({ name: 'analytics.page', desc: 'Real page + post metrics from the connected platform. Only returned values are real.', params: {},
    async run(a, ctx) { return services.analyticsPage(ctx.page); } });

  // ------------------------------------------------------------------ orchestration tools
  add({ name: 'pages.list', desc: 'List the page agents, their language, format, voice and which destinations they may post to.', params: {},
    async run() {
      return {
        pages: store.pages().filter(p => p.role !== 'orchestrator').map(p => ({
          key: p.key, label: p.label, lang: p.lang, ratio: p.ratio, voice: p.voice,
          approval: p.approval, projects: store.listProjects(p.key).length,
          destinations: services.publish ? services.publish.destinations(p.key).map(d => ({ name: d.name, postable: d.postable })) : [],
        })),
      };
    } });

  add({ name: 'page.ask', desc: 'Hand an instruction to ONE page agent and get its real result back. This is how you delegate.', params: { page: { type: 'string', max: 40, required: true }, message: { type: 'string', max: 1200, required: true } },
    async run(a, ctx) {
      if (!services.delegate) throw new Error('delegation is not available in this process');
      return services.delegate({ page: a.page, message: a.message, ctx });
    } });

  add({ name: 'project.create', desc: 'Create a new empty project for this page.', params: { title: { type: 'string', max: 120 } },
    async run(a, ctx) { return { project: store.createProject(ctx.page, a.title || 'Untitled') }; } });

  add({
    name: 'edit.plan',
    desc: 'Run an ordered EDIT PLAN (several operations in sequence) with a human approval checkpoint between steps. Use this instead of many single ops when the owner asks for a multi-step edit. ops is a JSON array string: [{"op":"trim","args":{"start":2,"duration":8}},{"op":"overlay_text","args":{"text":"…","at":1,"duration":4}}].',
    params: { ops: { type: 'jsontext', max: 20000, required: true }, checkpoint: { type: 'enum', values: ['ask_after_each', 'ask_before_final', 'auto'], def: 'ask_before_final' } },
    async run(a, ctx) {
      if (!ctx.projectId) throw new Error('no project is open — import a URL first');
      // Accepts a JSON string or an already-parsed array (see media.validate jsontext).
      let ops;
      if (Array.isArray(a.ops)) ops = a.ops;
      else { try { ops = JSON.parse(a.ops); } catch (_) { throw new Error('ops must be a JSON array of {op,args}'); } }
      if (!Array.isArray(ops) || !ops.length) throw new Error('ops must be a non-empty JSON array');
      return jobs.enqueue({ type: 'edit.plan', page: ctx.page, project: ctx.projectId, params: { page: ctx.page, project: ctx.projectId, ops, cursor: 0, checkpoint: a.checkpoint } });
    },
  });

  // ---------------------------------------------------------------- prompt rendering
  function toolSpec(t) {
    const ps = Object.entries(t.params || {}).map(([k, s]) => {
      let hint = s.type;
      if (s.type === 'enum') hint = s.values.join('|');
      if (s.type === 'number') hint += '[' + (s.min !== undefined ? s.min : '') + '..' + (s.max !== undefined ? s.max : '') + ']';
      return k + ':' + hint + (s.required ? '!' : (s.def !== undefined ? '=' + JSON.stringify(s.def) : ''));
    });
    return '- ' + t.name + '(' + ps.join(', ') + ') — ' + t.desc;
  }
  const TOOL_SPEC_TEXT = Object.values(TOOLS).map(toolSpec).join('\n');

  // ---------------------------------------------------------------- context assembly
  /**
   * orchestratorBlock — the context for the studio-level agent.
   * The orchestrator owns no media and no page identity: its job is to understand the request, work
   * out which page agent (or which discovery / publishing step) should handle it, delegate, and
   * report the real result back in ONE conversation.
   */
  function orchestratorBlock(page, project, memory, opts) {
    const pages = store.pages().filter(p => p.role !== 'orchestrator');
    const running = jobs.list({}).filter(x => x.status === 'running' || x.status === 'queued' || x.status === 'waiting_approval');
    const waiting = pages.flatMap(p => store.waitingApprovals(p.key).map(w => ({ page: p.label, ...w })));
    const arts = opts && opts.focus ? store.artifact(opts.focus) : null;
    const refs = (opts && opts.refs || []).map(id => store.artifact(id)).filter(Boolean);
    const lines = [
      STUDIO_POLICY.replace('You are a page agent inside a local AI video-editing studio. You operate ONE social page.',
        'You are the Studio Orchestrator inside a local AI video studio: the owner\'s single point of contact.'),
      '',
      '=== YOUR ROLE ===',
      'The owner talks to YOU. You do not edit video yourself and you do not act as one page.',
      'You understand the request, then either answer it, search for source footage, import a link, or',
      'delegate the creative work to the right page agent and report what really happened.',
      'If the owner asks for scripts/content for all pages or says 7 scripts, use pages.fanout with mode=scripts_only and the OPEN PROJECT as sourceProject — its result already carries the 7 ScriptArtifacts as cards, so do NOT call pages.fanout.attach after it. Never turn assistant prose into scripts. Do not call TTS, music, render or page.ask for a scripts-first request. Only use mode=production when the owner explicitly asks to produce the videos.',
      'If the owner asks for TTS/voices/audio for all profiles ("generate the TTS", "voices for all 7"), the request is ALREADY handled deterministically — never call pages.fanout, tts.generate, media.applyOp or any render tool for it. TTS means TTS ONLY: it must never produce a video, music, captions or a publish.',
      'NEVER cascade stages. Each owner message advances exactly one stage: scripts → TTS → titles → music → captions → render. If the owner asks for TTS, do NOT render. If they ask for scripts, do NOT speak. Suggest the next stage in words, never execute it unasked.',
      'If the owner reviewed the script batch and asks to change ONE profile\'s script ("change profile 3", "fix the MaghrebTechStore hook"), use pages.reviseScript with that profile — NEVER page.ask and NEVER pages.fanout again; those create duplicates.',
      'Use page.ask to hand work to a page agent. Use source.search / media.search to find footage.',
      'Use source.save to keep a clip for later (the link, not the video) and saved.search to find it again.',
      'Never describe work as done unless a tool result confirms it.',
      '',
      '=== THE PAGES YOU CAN DELEGATE TO ===',
      ...pages.map(p => '- ' + p.key + ' — ' + p.label + ' | language ' + p.lang + ' | format ' + p.ratio + ' | voice ' + p.voice
        + ' | destinations: ' + (services.publish ? services.publish.destinations(p.key).filter(d => d.postable).map(d => d.name).join(', ') || 'none authorised' : 'n/a')),
      ...pages.map(p => { const w = PAGE_WRITERS.writerFor(p.key); return w ? '- writer contract ' + p.key + ': ' + w.language + ' | audience: ' + w.audience + ' | offer angle: ' + String(w.sourcingAngles || '').slice(0, 80) : ''; }),
      '',
      '=== OPEN PROJECT ===',
      project ? ('project ' + project.id + ' "' + project.title + '" | page ' + project.page + ' | status ' + project.status) : 'no project open — a link or a search will create one',
      '=== DURABLE MEMORY ===',
      ...(store.globalMemory ? (store.globalMemory().rules || []).slice(-12).map(r => '- global: ' + r) : []),
      ...(memory.rules || []).slice(-12).map(r => '- studio: ' + r),
      // The footage outranks the caption, always. Stated at the orchestrator too, because the
      // orchestrator is what writes scripts when the owner just asks for them directly.
      project && groundTruth(project) ? ('GROUND TRUTH (the footage): ' + (groundTruth(project).product || 'product not identified — do not invent one')
        + (groundTruth(project).caption ? ' | the source caption says "' + groundTruth(project).caption + '"' : '')
        + (groundTruth(project).conflict ? ' — THEY DISAGREE: the caption is marketing copy, the footage wins. Never script a product the footage does not show.' : '')) : '',
      project && project.pending ? ('⚠ waiting for the owner\'s approval: ' + project.pending.label) : '',
      '',
      '=== WHAT THE OWNER IS LOOKING AT ===',
      arts ? ('focused artifact: ' + arts.id + ' — ' + arts.label + ' (' + arts.op + ' v' + arts.version + ', ' + arts.kind + ') on page ' + arts.page + '. A short instruction like "make it shorter" refers to THIS.') : 'no artifact focused',
      refs.length ? ('also referenced: ' + refs.map(a => a.id + ' — ' + a.label).join('; ')) : '',
      '',
      '=== WORK IN FLIGHT ===',
      running.length ? running.slice(0, 8).map(x => '- ' + x.type + ' on ' + (x.page || 'studio') + ' — ' + (x.stage || x.status)).join('\n') : 'nothing running',
      waiting.length ? ('waiting for approval: ' + waiting.map(w => w.page + '/' + (w.label || w.op)).join(', ')) : '',
      '',
      '=== TOOLS (call one per reply) ===',
      TOOL_SPEC_TEXT,
      'To act, reply with ONLY: {"tool":"name","args":{…}} — no prose around it.',
      'To talk, reply with plain text in the owner\'s language.',
    ];
    if (opts && opts.toolResults && opts.toolResults.length) {
      lines.push('', '=== REAL TOOL RESULTS (ground truth — report these, never embellish) ===');
      for (const r of opts.toolResults) lines.push(JSON.stringify(r).slice(0, 1200));
    }
    return lines.filter(l => l !== '').join('\n');
  }

  /**
   * groundTruth — what the footage shows, and whether the caption disagrees with it.
   *
   * Prefers the stored `truth` from import time; falls back to deriving it from the stored analysis
   * and the stored source caption, which is what gives projects imported before this existed the same
   * protection. Read-only: the prompt never writes to the project.
   */
  function groundTruth(p) {
    if (!p) return null;
    if (p.truth) return p.truth;
    const caption = p.source && p.source.meta ? p.source.meta.title : '';
    try { return U.footageTruth(p.analysis, caption); } catch (_) { return null; }
  }

  function contextBlock(page, project, memory, opts) {
    opts = opts || {};
    if (page.role === 'orchestrator') return orchestratorBlock(page, project, memory, opts);
    const durable = store.memoryContext ? store.memoryContext(page.key, project && project.id) : { global: {}, page: memory, project: null };
    const globalMemory = durable.global || {};
    const projectMemory = durable.project || {};
    const kb = knowledgeBlock(page.key) || '';
    const p = project;
    const cur = p && p.current ? store.artifact(p.current) : null;
    const lines = [
      STUDIO_POLICY,
      '',
      '=== YOUR PAGE ===',
      'key: ' + page.key + ' | name: ' + page.label + ' | language: ' + page.lang,
      'voice: ' + page.voice + ' | tts rate: ' + page.ttsRate + ' | default format: ' + page.ratio,
      'identity: ' + page.identity,
      page.instructions ? 'owner instructions: ' + page.instructions : '',
      page.prefs ? 'preferences: duration ' + page.prefs.duration + ', music ' + (page.prefs.musicStyle || 'any') + ', text style ' + JSON.stringify(page.prefs.textStyle) + ', CTA ' + (page.prefs.cta || '(none)') : '',
      PAGE_WRITERS.writerPromptBlock(page.key) ? '\n=== PAGE WRITER CONTRACT ===\n' + PAGE_WRITERS.writerPromptBlock(page.key) : '',
      page.pageIds && page.pageIds.length ? 'connected pages: ' + page.pageIds.map(x => x.name).join(', ') : '',
      '',
      '=== PAGE RULES ===',
      ...(page.rules || []).map(r => '- ' + r),
      ...(globalMemory.rules || []).slice(-12).map(r => '- global: ' + r),
      ...(memory.rules || []).map(r => '- ' + r),
      ...(memory.corrections || []).slice(-8).map(c => '- correction: ' + c.text),
      kb ? '\n=== APPROVED KNOWLEDGE (the only facts/prices/offers you may state) ===' + kb : '',
      '',
      '=== TOOLS (call one per reply) ===',
      TOOL_SPEC_TEXT,
      'To act, reply with ONLY: {"tool":"name","args":{…}} — no prose around it.',
      'To talk, reply with plain text in ' + page.lang + '.',
      '',
      '=== PROJECT STATE ===',
      p ? ('project ' + p.id + ' "' + p.title + '" | status ' + p.status + ' | role ' + p.role + (p.suite ? ' | suite ' + p.suite : '') + ' | template ' + (p.template || page.template || 'none')) : 'no project open',
      // Locks are declared here so the model plans within them. The media layer refuses anyway — this
      // keeps it from proposing work that would be rejected, which is a worse experience.
      p ? ('EDIT LOCKS: ' + LOCK.summary(p.locks, store.inheritedLocks(p.id))) : '',
      p && p.role === 'master' ? ('this is the MASTER EDIT (status: ' + (p.masterStatus || 'draft') + '). Its locks are inherited by every page branch; page versions are generated from it once approved.') : '',
      p && p.role === 'branch' ? ('this is a PAGE BRANCH for ' + ((p.branch && p.branch.pageLabel) || p.page) + '; it inherits the master edit\'s locks and cannot release them.') : '',
      p && p.review ? ('review state: ' + p.review.state + (p.review.note ? ' — ' + p.review.note : '')) : '',
      p && p.source ? ('source: ' + (p.source.url || p.source.file) + ' | ' + JSON.stringify(p.source.meta || {})) : '',
      cur ? ('current artifact: ' + cur.label + ' (' + cur.op + ' v' + cur.version + ') ' + JSON.stringify(cur.probe || {})) : '',
      p && p.analysis ? ('WHAT THE VIDEO SHOWS: ' + JSON.stringify(p.analysis).slice(0, 1800)) : '',
      p && p.videoUnderstanding && p.videoUnderstanding.status === 'completed'
        ? ('TIMED VISUAL GROUNDING: narrate the action actually visible at each source timestamp; do not invent specifications or transplant generic copy. Full evidence is in project.inspect. ' + JSON.stringify(p.videoUnderstanding.timeline.map(s => ({ start: s.start, end: s.end, description: s.description, cue: s.narrationCue, uncertainty: s.uncertainty }))).slice(0, 16000)) : '',
      groundTruth(p) ? [
        '=== GROUND TRUTH — WHAT THE FOOTAGE ACTUALLY SHOWS ===',
        'product in the footage: ' + (groundTruth(p).product || 'NOT identified — do not invent one'),
        groundTruth(p).caption ? ('the source caption says: "' + groundTruth(p).caption + '"') : '',
        groundTruth(p).conflict
          ? '⚠ THE CAPTION CONTRADICTS THE FOOTAGE. A caption or hashtag is marketing copy, not evidence. Every script, title, price line and caption you write must describe what the footage SHOWS — never what the caption claims.'
          : groundTruth(p).note,
      ].filter(Boolean).join('\n') : '',
      p && p.operations.length ? ('applied operations: ' + p.operations.slice(-10).map(x => x.op).join(', ')) : '',
      p && p.pending ? ('⚠ A step is WAITING FOR THE OWNER\'S APPROVAL: ' + p.pending.label + ' (' + p.pending.op + '). Do not claim it is finished; ask them to approve, fix or regenerate it.') : '',
      p && p.approvals && p.approvals.length ? ('approval history: ' + p.approvals.slice(-5).map(x => x.decision + ' ' + (x.checkpoint || '')).join(', ')) : '',
      '',
      '=== MEMORY (this page only) ===',
      'hooks used: ' + (memory.hooks || []).slice(-10).join(' | '),
      'products done: ' + (memory.products || []).slice(-15).join(', '),
      'style: ' + JSON.stringify(memory.style || {}),
      'preferences: ' + JSON.stringify(memory.preferences || {}),
      projectMemory.rules && projectMemory.rules.length ? 'project memory: ' + projectMemory.rules.slice(-8).join(' | ') : '',
    ];
    if (opts.toolResults && opts.toolResults.length) {
      lines.push('', '=== REAL TOOL RESULTS (ground truth — report these, never embellish) ===');
      for (const r of opts.toolResults) lines.push(JSON.stringify(r).slice(0, 1200));
    }
    return lines.filter(l => l !== '').join('\n');
  }

  // ---------------------------------------------------------------- execution
  async function executeTool(name, args, ctx) {
    const tool = TOOLS[name];
    if (!tool) return { ok: false, error: 'unknown tool: ' + name + ' (available: ' + Object.keys(TOOLS).join(', ') + ')' };
    const started = Date.now();
    try {
      const clean = media.validate(tool.params, args || {});
      log('info', 'agent.tool', { page: ctx.page, project: ctx.projectId, tool: name });
      if (ctx.emit) ctx.emit('agent.tool', { tool: name, args: clean });
      const result = await tool.run(clean, ctx);
      if (result && result.ok !== false && services.store && /^media\./.test(name) && name !== 'media.search') {
        const op = name.slice(6).replace(/[^a-z0-9_]+/gi, '_');
        services.store.recordLearning(ctx.page, { kind: 'preference', name: 'edit_' + op, text: 'Owner used ' + op + ' successfully on this page.', source: 'successful-edit' });
      }
      return { ok: true, tool: name, args: clean, result, ms: Date.now() - started };
    } catch (e) {
      log('error', 'agent.tool.failed', { tool: name, error: e.message });
      return { ok: false, tool: name, args, error: e.message };
    }
  }

  /**
   * workloadFor — a cheap deterministic estimate of how much brain this message needs.
   *
   * This is call-site routing policy, NOT model reasoning: it decides which TIER of model to
   * spend (chat_light goes to the high-quota lite models, edit_complex may reach the strong tier).
   * The page still behaves as one agent — only who serves each step changes.
   */
  function workloadFor(message) {
    const t = String(message || '').toLowerCase();
    if (/(\bplan\b|خطة|خطه|بجوج|بزاف|multiple|several|\bthen\b|من بعد)/.test(t)) return 'edit_complex';
    const ops = (t.match(/trim|cut|قطع|قص|text|نص|كتابة|speed|سرعة|ratio|أبعاد|ابعاد|music|موسيق|صوت|voice|mute|صامت|volume|مستوى|render|subtitle|ترجمة/g) || []).length;
    if (ops >= 2 || t.length > 220) return 'edit_complex';
    if (ops === 1) return 'edit_simple';
    return 'chat_light';
  }
  /** workload → the routing task whose chain serves it. */
  const TASK_FOR = { chat_light: 'classify', chat_complex: 'reply_deep', edit_simple: 'plan_simple', edit_complex: 'plan' };

  // A model occasionally returns its drafting rubric instead of the owner-facing answer. That is
  // neither useful product copy nor something the Studio should surface. Reject the whole reply
  // (rather than trying to extract a guessed "final" line) and report only real tool results.
  function ownerReply(value) {
    const text = U.sanitizeText(String(value || '').trim(), 4000);
    if (!text) return '';
    // Never surface a model's raw tool syntax as if it were a result. The actual
    // candidate cards are attached from the tool response below.
    if (/^\s*(?:media|source|saved)\.search\s*\(/i.test(text)) return '';
    const internal = /(?:^|\n)\s*\*?\s*(?:role|input|goal|hard rules|self[- ]correction|drafting|final polish|self-reflection|chain[- ]of[- ]thought)\s*:/im;
    return internal.test(text) ? '' : text;
  }

  

  

  /**
   * titlesAllRequest — "generate titles for all (7)" / "suggest the titles" / "عناوين".
   * A DETERMINISTIC stage request like ttsAllRequest: promote the n8n writer's suggested titles
   * into per-profile TitleArtifacts and STOP — never render, never burn.
   */
  function titlesAllRequest(value) {
    const t = String(value || '');
    const titleWord = /\btitles?\b|\btext\s+on\s+video\b|عنوان|عناوين/i.test(t);
    const generateVerb = /\b(generate|make|create|suggest|show|give|prepare|promote)\b|ولد|جهز|اقترح|أعطني/i.test(t);
    const allWord = /\ball\b|\b7\b|seven|them\b|جميع|كل\b|لكل|لجميع/i.test(t);
    return titleWord && generateVerb && allWord;
  }
  /**
   * priceSetRequest — "dir 200dh", "bdel taman dyal MaghrebTechStore l 200dh",
   * "tashilat 100dh f chhar", "change the price to 200". Returns { profile, amount, monthly }.
   * Only fires when the message contains a currency-ish number; chat numbers alone never trigger it.
   */
  function priceSetRequest(value) {
    const t = String(value || '');
    const m = t.match(/(\d{2,6})\s*(?:dh|dhs|dirhams?|درهم|فالشهر|\$)?/i);
    if (!m) return null;
    const hasPriceWord = /\b(?:price|taman|thaman|dirham|dh|دزرهم|درهم|الثمن|الثمن\s+l)\b|سوم/i.test(t)
      || /\bdh\b/i.test(t) || /درهم/.test(t);
    if (!hasPriceWord) return null;
    const verbish = /\b(?:set|dir|bdel|beddel|change|make|put|mettez|fixe|khali|عند|حط|بدل|غير)\b|على|ل\s*$/i.test(t)
      || /\b(?:to|=|l|ل)\s*\d{2,6}/i.test(t) || /^\s*[a-z\s]{0,30}\d{2,6}\s*(?:dh|درهم)/i.test(t);
    if (!verbish) return null;
    const monthly = /(?:f|ف)\s*chhar|فالشهر|monthly|per month|كل شهر|شهر/i.test(t);
    // profile extraction: a known page word inside the message, else null (= every profile ask).
    return { profile: matchProfileKey(t), amount: Number(m[1]), monthly };
  }
  /** ctaStyleRequest — "use link in bio", "bdel CTA l link f bio", "comment CTA for all". */
  function ctaStyleRequest(value) {
    const t = String(value || '');
    const ctaWord = /\bcta\b|call\s*to\s*action|كارت|بطاقة|دعوة/i.test(t);
    const bio = /link\s*(?:in|f|في)?\s*(?:the\s*)?bio|فالبايو|فالبايو|bayo|الرابط\s*(?:ف|في)?\s*البايو/i.test(t);
    const comment = /comment|كومنت|تعليق|مهتم|interested/i.test(t);
    if (!ctaWord && !bio && !comment) return null;
    if (!ctaWord && !(bio || comment)) return null;
    const wants = bio && !comment ? 'link_bio' : comment && !bio ? 'comment'
      : bio && comment ? (/link/.test(t) ? 'link_bio' : 'comment') : null;
    if (!wants) return null;
    const verb = /\b(?:use|bdel|beddel|switch|change|make|put|dir|خلي|بدل|استعمل|دخل)\b/i.test(t) || /\bcta\b/i.test(t);
    if (!verb) return null;
    return { profile: matchProfileKey(t), style: wants };
  }
  /**
   * profileFromMessage — resolve an explicit profile reference ("MaghrebTechStore", "profile 3",
   * "الصفحة 2") to a profileKey, or null when the message names none.
   */
  function profileFromMessage(value) {
    const labels = {};
    for (const k of PROFILE_KEYS) { const p = store.page(k); if (p && p.label) labels[k] = p.label; }
    return matchProfileKey(value, labels);
  }
  /**
   * ttsRequest — the GENERATE_TTS boundary: "dir liya TTS", "make TTS", "generate voice for all",
   * "generate TTS for MaghrebTechStore", "retry the failed voices". Returns { profile } where
   * profile=null means every profile of the CURRENT batch. Exactly one TTSArtifact per resolved
   * profile, then STOP — never a render, never music, never captions. Detected here (not by the
   * model) so no LLM turn can ever widen the operation again.
   */
  function ttsRequest(value) {
    const t = String(value || '');
    if (!/\b(tts|voice\s?over|voiceover|voices?|audio|speech)\b|صوت|أصوات|الصوت/i.test(t)) return null;
    if (!/\b(generate|make|create|do|prepare|gen|dir|sawet|talegh|saygh|give|retry|redo)\b|ولد|صاوب|دير|جهز|توليد|أعطني|عطيني|عاود/i.test(t)) return null;
    return { profile: profileFromMessage(t) };
  }

  // ---- deterministic stage matchers: one command = one stage, never a cascade ----
  /** musicAllRequest — "add music for all (7)" / "موسيقى لجميع". Adds tracks ONLY. */
  function musicAllRequest(value) {
    const t = String(value || '');
    const musicWord = /\bmusic\b|\btracks?\b|\bbgm\b|background|موسيقى|موسيقى خلفية/i.test(t);
    const allWord = /\ball\b|\b7\b|seven|them\b|جميع|كل\b|لكل|لجميع/i.test(t);
    return musicWord && allWord;
  }
  /** captionsAllRequest — "generate/add captions/subtitles for all" / "ترجمة/تسمية لجميع". */
  function captionsAllRequest(value) {
    const t = String(value || '');
    const capWord = /\bcaptions?\b|\bsubtitles?\b|كابشن|ترجمة|ترجمات|تسمية|sub/i.test(t);
    const allWord = /\ball\b|\b7\b|seven|them\b|جميع|كل\b|لكل|لجميع/i.test(t);
    return capWord && allWord;
  }
  /** ctaAllRequest — "apply/add the CTA for all" / "الكارت لجميع". Appends cards ONLY. */
  function ctaAllRequest(value) {
    const t = String(value || '');
    const ctaWord = /\bcta\b|\bcards?\b|call\s*to\s*action|profile\s*card|كارت|بطاقة|دعوة/i.test(t);
    const allWord = /\ball\b|\b7\b|seven|them\b|جميع|كل\b|لكل|لجميع/i.test(t);
    return ctaWord && allWord;
  }
  /** descriptionsAllRequest — "generate descriptions for all" / "وصف لجميع". Text artifacts ONLY. */
  function descriptionsAllRequest(value) {
    const t = String(value || '');
    const descWord = /\bdescriptions?\b|\bcaptions?\s+text\b|post\s+text|وصف|أوصاف|الوصف|كابشنز/i.test(t);
    const allWord = /\ball\b|\b7\b|seven|them\b|جميع|كل\b|لكل|لجميع/i.test(t);
    return descWord && allWord;
  }
  /**
   * renderAllRequest — "render all 7" / "make the final videos" / "صنع الفيديوهات النهائية".
   * The ONLY phrase that triggers video composition. Everything after render reports and stops.
   */
  function renderAllRequest(value) {
    const t = String(value || '');
    // "show/display/play the final videos" is a VIEW command, not a render command — the display
    // matcher runs before this one, but keep the guard here too so the two can never race.
    if (/\b(show|open|display|list|view|see|play)\b/i.test(t) && !/\band\s+render\b|\brender\s+(them|it|all\s+of\s+them)\b/i.test(t)) return false;
    const renderWord = /\brender\b|\bexports?\b|final\s+videos?|\bcompose\b|combine|export|صنع|إنشاء|توليد|تصدير/i.test(t)
      && /\bvideos?\b|\bfinals?\b|الفيديوهات|فيديو|نهائ/i.test(t)
      || /\brender\s+(all|the\s+7|7)\b/i.test(t);
    // "make/render the final videos" (definite article = the current batch) is an all-profiles
    // command even without an explicit count.
    const allWord = /\ball\b|\b7\b|seven|them\b|the\s+finals?\b|the\s+final\s+videos?\b|جميع|كل\b|لكل|لجميع/i.test(t);
    return renderWord && allWord;
  }

  /**
   * resolveFanoutBatch — the most recent completed per-profile fanout run (the scripts the owner
   * just reviewed). Returns [{page, project, script}] in a stable order. This is what makes "for
   * all of them" resolve to exactly the reviewed batch, not a re-guess.
   */
  function resolveFanoutBatch() {
    const seen = new Map();
    for (const row of store.listProjects()) {
      const p = store.project(row.id);
      if (!p || !p.branch || !p.branch.fanout) continue;
      // the reviewed batch is the newest fanout project per profile (v2+ revisions live in the same project)
      const prev = seen.get(p.branch.page);
      if (!prev || (p.updated || 0) > (prev.updated || 0)) seen.set(p.branch.page, p);
    }
    return [...seen.values()];
  }

  

  function searchCandidates(toolResults) {
    const seen = new Set();
    const out = [];
    for (const r of toolResults || []) {
      if (!r || r.tool !== 'media.search' || !r.ok) continue;
      const list = r.result && Array.isArray(r.result.candidates) ? r.result.candidates : [];
      for (const c of list) {
        const key = String(c.id || c.vid || c.url || c.video_url || c.title || '');
        if (!key || seen.has(key)) continue;
        seen.add(key); out.push(c);
      }
    }
    return out;
  }

  function parseRawSearchCall(value) {
    const m = String(value || '').trim().match(/^media\.search\s*\(\s*(?:query\s*=\s*)?([\s\S]*?)\s*\)$/i);
    if (!m) return null;
    return m[1].replace(/^['"]|['"]$/g, '').trim() || 'product videos';
  }

  /**
   * runTurn — one user message in, one agent reply out (plus real artifacts).
   * Loop: the model may call up to `maxSteps` tools; each result is fed back as ground truth
   * before the final user-facing reply is written.
   */
  async function runTurn(opts) {
    const page = store.page(opts.page);
    const ctx = {
      page: page.key, projectId: opts.project || null, emit: opts.emit, progress: opts.progress || (() => {}), note: () => {},
      focus: opts.focus || null, refs: opts.refs || null,
    };
    const memory = store.memory(page.key);
    let project = opts.project ? store.project(opts.project) : null;
    // A project id can outlive its project (deleted while the client still had it selected).
    // Failing the whole turn over a stale pointer is a bad trade, so fall back to the page's most
    // recent project — or to none, in which case the agent starts a fresh one when it imports.
    if (opts.project && !project) {
      const recent = store.listProjects(page.key)[0];
      project = recent ? store.project(recent.id) : null;
      log('info', 'agent.stale_project', { asked: opts.project, used: project ? project.id : null, page: page.key });
    }
    ctx.projectId = project ? project.id : null;

    const model = opts.model || page.model || llm.modelKey();
    const toolResults = [];
    let reply = null;
    const maxSteps = 3;
    // Who serves this turn is declared up front: ordinary conversation stays on the cheap
    // high-quota brain; only genuinely hard requests reach the strong (scarce) tier.
    const workload = opts.workload || workloadFor(opts.message);
    const brainTask = TASK_FOR[workload] || 'classify';
    ctx.workload = workload;

    // Explicit source discovery is deterministic product behavior, not a conversational guess.
    // Running it before the model prevents stale candidate IDs from recent chat history, and also
    // prevents one request from being expanded into duplicate media.search calls.
    const directSearch = isSearchLikeMessage(opts.message);
    // GENERATE_SCRIPTS = scripts ONLY. A script request never cascades: any later-stage word in
    // the same message (voice/tts/title/music/caption/cta/description/render/video) goes to that
    // stage's own handler instead of silently regenerating scripts.
    const scriptsOnlyRequest = page.role === 'orchestrator'
      && /(?:\b(?:7|seven)\b|سبع|سبعة)[\s-]*(?:different\s+)?(?:scripts?|نصوص?|سكريبتات?)/i.test(opts.message || '')
      && /\b(create|generate|make|write|prepare|draft|do|dir|kteb|sawet)\b|اكتب|كتب|صاوب|جهز|ولد/i.test(opts.message || '')
      && !/\b(tts|voice|audio|speech|title|music|caption|subtitle|cta|description|render|video|final|publish)\b|صوت|أصوات|موسيقى|ترجمة|عنوان|وصف|كارت|تصيير|نشر/i.test(opts.message || '');
    // This is deterministic because a scripts-first request must never be allowed
    // to drift into TTS/render just because the model picked the broad production tool.
    if (scriptsOnlyRequest && project) {
      // The fanout result already carries the 7 ScriptArtifacts onto this turn's message — do NOT
      // attach them again: a second attach pass is exactly what produced duplicate v1 cards.
      const produced = await executeTool('pages.fanout', {
        brief: opts.message, sourceProject: project.id, mode: 'scripts_only', music: false, render: false,
      }, ctx);
      toolResults.push(produced);
      const n = produced.ok && produced.result && Array.isArray(produced.result.pages)
        ? produced.result.pages.filter(x => x.status === 'ready').length : 7;
      reply = produced.ok
        ? '✓ ' + n + ' ScriptArtifacts ready — exactly one current script per profile, attached below. No TTS or video was created.'
        : 'Script batch failed: ' + produced.error;
    }
    // "Generate TTS for all (7)" is a hard stage boundary: resolve the reviewed script batch and
    // produce exactly one TTSArtifact per profile — NO voiceover video, NO music, NO render. The
    // deterministic path exists so the model can never widen the operation into a production run.
    // Owner price override — deterministic: "dir 200dh", "bdel taman dyal X l 100dh". Money only.
    if (!reply && page.role === 'orchestrator') {
      const ps = priceSetRequest(opts.message);
      if (ps) {
        const produced = await executeTool('pages.setPrice', { profile: ps.profile || 'all', amount: ps.amount, monthly: ps.monthly }, ctx);
        toolResults.push(produced);
        reply = produced.ok ? ' ' : 'Price override failed: ' + produced.error;
      }
    }
    // Owner CTA-style override — deterministic: "use link in bio", "bdel CTA l comment".
    if (!reply && page.role === 'orchestrator') {
      const cs = ctaStyleRequest(opts.message);
      if (cs) {
        const produced = await executeTool('pages.setCtaStyle', { profile: cs.profile || 'all', style: cs.style }, ctx);
        toolResults.push(produced);
        reply = produced.ok ? ' ' : 'CTA style change failed: ' + produced.error;
      }
    }
    if (!reply && page.role === 'orchestrator' && titlesAllRequest(opts.message) && !ttsRequest(opts.message)) {
      if (opts.progress) opts.progress('collecting the suggested titles', 10);
      const produced = await executeTool('pages.titlesAll', { pages: '' }, ctx);
      toolResults.push(produced);
      if (produced.ok) {
        const r = produced.result || {};
        const lines = (r.pages || []).filter(x => x.status === 'ready').map((x, i) => (i + 1) + '. ' + (x.text || '').slice(0, 70));
        reply = '✓ ' + (r.ready || 0) + ' titles suggested — review them below and say "all titles are good" to approve, or "change title N: …".\n' + lines.join('\n')
          + '\nNothing is burned into the videos until you approve.';
      } else reply = 'Title batch failed: ' + produced.error;
    }
    // "make the full videos" — the OWNER'S one-command production chain (2026-09-23): current
    // TTS (Kore) → title → music → real synced subtitles → CTA card timed to the spoken CTA →
    // final render. This is the ONLY command allowed to cascade stages, because the cascade IS
    // the explicit request. Each stage keeps its own boundary; every failure is reported per
    // profile with its REAL reason so the owner can retry only what broke.
    if (!reply && page.role === 'orchestrator' && fullVideosRequest(opts.message)) {
      const fbatch = store.currentBatch ? store.currentBatch() : null;
      if (!fbatch) {
        reply = 'There is no current production batch yet — import a source and create the scripts first, then say "make the full videos".';
      } else {
        const allKeys = Object.keys(fbatch.profiles || {});
        const recOf = (prof, field) => (prof && prof[field] ? store.artifact(prof[field]) : null);
        const olderThan = (a, other) => !!(other && a && a.ts && other.ts && a.ts < other.ts);
        const needs = (field, stale) => allKeys.filter(k => {
          const prof = fbatch.profiles[k] || {};
          const a = recOf(prof, field);
          return !a || (stale ? stale(a, prof) : false);
        });
        const chain = [
          // TTS: the stage's verify-then-reuse regenerates anything not real/current/Kore.
          { tool: 'pages.ttsAll', keys: allKeys, label: 'Kore voice' },
          { tool: 'pages.titlesAll', keys: needs('currentTitleArtifactId', (a, prof) => olderThan(a, recOf(prof, 'approvedScriptArtifactId') || recOf(prof, 'currentScriptArtifactId'))), label: 'titles' },
          { tool: 'pages.musicAll', keys: needs('currentMusicArtifactId'), label: 'music' },
          // subtitles come from the CURRENT TTS audio. The stage itself verifies each caption
          // (real non-refusal segments + transcribed from the current TTS file) and reuses only
          // healthy ones, so asking for every profile still spends ASR calls only where needed.
          { tool: 'pages.captionsAll', keys: allKeys, label: 'synced subtitles' },
        ];
        const failures = [];
        for (const step of chain) {
          if (!step.keys.length) continue;
          if (opts.progress) opts.progress('full videos: ' + step.label + ' for ' + step.keys.length + ' profile' + (step.keys.length > 1 ? 's' : ''), 10);
          const produced = await executeTool(step.tool, { pages: step.keys.join(',') }, ctx);
          toolResults.push(produced);
          if (!produced.ok) failures.push(step.label + ' stage failed: ' + produced.error);
          else for (const f of ((produced.result || {}).errors || [])) failures.push(f);
        }
        // Render ONLY what is missing or stale (its inputs are newer than it) — a retry must
        // re-render the failed profile only, never the whole batch (owner rule 2026-09-23).
        // Re-read the batch FIRST: the stages above moved the pointers (fresh captions/CTA), and
        // using the pre-stage snapshot here is exactly what skipped Mubadara's re-render on
        // 2026-09-23 — his fixed captions never reached his video.
        const fb2 = (store.currentBatch ? store.currentBatch() : null) || fbatch;
        const recOf2 = (prof, field) => (prof && prof[field] ? store.artifact(prof[field]) : null);
        const renderKeys = allKeys.filter(k => {
          const prof = (fb2.profiles || {})[k] || {};
          const a = recOf2(prof, 'currentVideoArtifactId');
          return !a || ['currentTtsArtifactId', 'currentMusicArtifactId', 'currentCaptionArtifactId', 'currentTitleArtifactId']
            .some(f => olderThan(a, recOf2(prof, f)));
        });
        let rendered = { ok: true, result: { ready: 0, failed: 0, errors: [], pages: [] } };
        if (renderKeys.length) {
          if (opts.progress) opts.progress('full videos: final render (title burn + CTA card timing + encode) for ' + renderKeys.length + ' profiles', 85);
          rendered = await executeTool('pages.renderAll', { pages: renderKeys.join(',') }, ctx);
        }
        toolResults.push(rendered);
        if (rendered.ok) {
          const r = rendered.result || {};
          failures.push(...(r.errors || []));
          reply = (renderKeys.length
              ? '✓ ' + (r.ready || 0) + ' of ' + renderKeys.length + ' final videos rendered — the full chain ran per profile: Kore voice → visible title → music → subtitles synced to the real TTS → CTA card timed to the spoken CTA → final encode.'
              : '✓ Everything was already current — no stage needed to run and nothing was re-rendered.')
            + (failures.length ? '\n\nFAILED (real reasons):\n- ' + failures.join('\n- ') + '\nSay "retry the failed renders" to fix only those profiles.' : '')
            + '\nNothing has been published.';
        } else {
          reply = 'Final render failed: ' + rendered.error
            + (failures.length ? '\nEarlier stages reported:\n- ' + failures.join('\n- ') : '');
        }
      }
    }
    if (!reply && page.role === 'orchestrator' && ttsRequest(opts.message) && !fullVideosRequest(opts.message)) {
      const tr = ttsRequest(opts.message);
      const curBatch = store.currentBatch ? store.currentBatch() : null;
      // exactly-one-profile requests resolve that profile; bare "make TTS" / "dir liya TTS"
      // speaks every profile of the CURRENT batch
      const keys = tr.profile ? [tr.profile]
        : (curBatch ? Object.keys(curBatch.profiles || {}) : resolveFanoutBatch().map(p => p.branch.page));
      if (!keys.length) {
        reply = 'There is no script batch to speak yet. Create the scripts first (e.g. "create the 7 scripts"), then ask for the TTS.';
      } else {
        if (opts.progress) opts.progress('generating ' + keys.length + ' voice' + (keys.length > 1 ? 's' : '') + ' from the current scripts', 15);
        const produced = await executeTool('pages.ttsAll', { pages: keys.join(',') }, ctx);
        toolResults.push(produced);
        if (produced.ok) {
          const r = produced.result || {};
          const okN = r.ready || 0, bad = r.failed || 0, reused = r.reused || 0;
          reply = '✓ ' + okN + ' TTS artifact' + (okN === 1 ? '' : 's') + ' ready'
            + (reused ? ' (' + reused + ' verified playable and reused)' : '')
            + (bad ? ' — ' + bad + ' FAILED (' + (r.errors || []).slice(0, 3).join('; ') + '). Say "retry the failed voices" to retry only those.' : '')
            + '. The audio cards are below. Nothing else was created — no music, captions or video.';
        } else reply = 'TTS batch failed: ' + produced.error;
      }
    }
    // ---- one-stage-per-command batch handlers: each fires its OWN tool and nothing else.
    // Mutually exclusive by construction: every branch sets `reply`, and later branches only run
    // while `!reply` — so at most ONE stage ever executes per owner message. DISPLAY commands are
    // matched BEFORE the render stage so "show the final videos" can never re-render.
    const batchStage = async (matcher, tool, okMessage, progressLabel) => {
      if (page.role !== 'orchestrator' || !matcher(opts.message)) return;
      if (opts.progress) opts.progress(progressLabel, 10);
      const produced = await executeTool(tool, { pages: '' }, ctx);
      toolResults.push(produced);
      if (produced.ok) {
        const r = produced.result || {};
        const ok = r.ready || 0, bad = r.failed || 0;
        reply = okMessage(ok, bad, r);
      } else reply = (tool) + ' failed: ' + produced.error;
    };
    // "show the final videos" — attach the CURRENT batch's per-profile final VideoArtifacts to
    // the reply so the real playable cards appear right in the chat. Pure display: no generation.
    if (!reply && page.role === 'orchestrator' && /\b(show|open|display|list|view|see|play)\b[\s\S]{0,40}\b(finals?|final videos?|the\s+\d+\s+videos?|versions?)\b/i.test(opts.message || '')) {
      const batch = store.currentBatch ? store.currentBatch() : null;
      const vids = batch ? Object.entries(batch.profiles).map(([key, p]) => ({ key, id: p.currentVideoArtifactId })).filter(x => x.id).map(x => store.artifact(x.id)).filter(Boolean) : [];
      if (vids.length && services.appendArtifacts) {
        services.appendArtifacts({ owner: page.key, text: '✓ ' + vids.length + ' current final videos — one per profile. Nothing new was generated.', artifacts: vids });
        reply = ' ';
      } else if (vids.length) {
        reply = 'The ' + vids.length + ' final videos are in the workspace panel — one per profile. Nothing new was generated.';
      }
    }
    if (!reply) await batchStage(musicAllRequest, 'pages.musicAll',
      (ok, bad, r) => '✓ ' + ok + ' MusicArtifact' + (ok === 1 ? '' : 's') + ' ready' + (bad ? ' — ' + bad + ' failed (' + (r.errors || []).slice(0, 3).join('; ') + ')' : '')
        + '. Tracks are recorded per profile; nothing is mixed into video yet — say "render all 7" when you are ready.',
      'picking a distinct track per profile');
    if (!reply) await batchStage(captionsAllRequest, 'pages.captionsAll',
      (ok, bad, r) => '✓ ' + ok + ' caption track' + (ok === 1 ? '' : 's') + ' generated from the real voiceover timing and burned into per-profile previews'
        + (bad ? ' — ' + bad + ' failed (' + (r.errors || []).slice(0, 3).join('; ') + ')' : '') + '. No final render has run.',
      'generating captions from real TTS timing');
    if (!reply) await batchStage(ctaAllRequest, 'pages.ctaAll',
      (ok, bad, r) => '✓ ' + ok + ' CTA card' + (ok === 1 ? '' : 's') + ' appended — each profile got its OWN production card'
        + (bad ? ' — ' + bad + ' failed (' + (r.errors || []).slice(0, 3).join('; ') + ')' : '') + '. No render has run.',
      'appending per-profile CTA cards');
    if (!reply) await batchStage(descriptionsAllRequest, 'pages.descriptionsAll',
      (ok, bad, r) => '✓ ' + ok + ' DescriptionArtifact' + (ok === 1 ? '' : 's') + ' created from each profile\'s own n8n template'
        + (bad ? ' — ' + bad + ' failed (' + (r.errors || []).slice(0, 3).join('; ') + ')' : '') + '.',
      'building descriptions from the n8n templates');
    if (!reply) await batchStage(renderAllRequest, 'pages.renderAll',
      (ok, bad, r) => '✓ ' + ok + ' final video' + (ok === 1 ? '' : 's') + ' rendered — one per profile, composed from that profile\'s approved script, voice, music, captions and its own CTA card'
        + (bad ? ' — ' + bad + ' failed (' + (r.errors || []).slice(0, 3).join('; ') + '). Say "retry the failed renders".' : '')
        + '. Review them below; nothing has been published.',
      'composing final videos per profile');
    if (directSearch) {
      if (opts.progress) opts.progress('searching and visually checking source footage', 10);
      const res = await executeTool('media.search', { query: searchQueryFromMessage(opts.message, store.conversation(page.key).messages), limit: requestedSearchCount(opts.message), vision: true }, ctx);
      toolResults.push(res);
      const candidates = searchCandidates(toolResults);
      if (!res.ok) reply = 'Source search failed: ' + res.error;
      else if (!candidates.length) reply = 'No strong verified candidates were found. Nothing weak or unverified was added to the shortlist.';
      else {
        const arabic = /[\u0600-\u06ff]/.test(opts.message);
        const strict = !!(res.result && res.result.vision && res.result.vision.requested);
        reply = (arabic ? 'لقيت ' : 'Found ') + candidates.length + (arabic
          ? (strict ? ' فيديوهات حقيقية ومتحقق منها بصرياً. شوف الكروت لتحت واختار Import أو Save.' : ' فيديوهات حقيقية ومقاسة. شوف الكروت لتحت؛ طلب “no faces” أو “no text” كيدير visual screening صارم.')
          : (strict ? ' real, visually verified videos. Use the cards below to Import or Save one.' : ' real, measured videos. Ask for “no faces” or “no text” for strict visual screening.'));
      }
    }

    for (let step = 0; !reply && step < maxSteps + 1; step++) {
      const convo = store.conversation(page.key).messages.slice(-10).map(m => m.role + ': ' + m.text).join('\n');
      const prompt = contextBlock(page, project, memory, { toolResults, focus: opts.focus || null, refs: opts.refs || null })
        + '\n\n=== RECENT CONVERSATION ===\n' + (convo || '(new conversation)')
        + (step === 0 ? '' : '\n\nYou already ran tools this turn. Either call ONE more tool, or reply to the owner now with plain text.')
        + '\n\nOWNER MESSAGE: ' + opts.message;
      if (opts.progress) opts.progress('thinking (' + step + ')', 10 + step * 20);
      let raw = '';
      try { raw = await llm.text(model, prompt, brainTask, { page: page.key, project: ctx.projectId }); }
      catch (e) { return { ok: false, error: 'model unreachable: ' + e.message, toolResults }; }
      const rawSearch = parseRawSearchCall(raw);
      if (rawSearch && step < maxSteps) {
        const res = await executeTool('media.search', { query: rawSearch }, ctx);
        toolResults.push(res);
        continue;
      }
      const parsed = U.extractJSON(raw);
      if (parsed && parsed.tool && step < maxSteps) {
        const res = await executeTool(parsed.tool, parsed.args || parsed, ctx);
        toolResults.push(res);
        if (res.ok) {
          if (!project && res.result && res.result.project) project = store.project(res.result.project.id || res.result.project);
          if (res.result) ctx.projectId = (project && project.id) || res.result.project && res.result.project.id || ctx.projectId;
          if (ctx.projectId) project = store.project(ctx.projectId);
          memory.stats = { ...(memory.stats || {}), edits: ((memory.stats || {}).edits || 0) + 1 };
          store.saveMemory(page.key, memory);
        }
        continue;
      }
      // A reply that is still a tool-call envelope must never reach the owner as chat text
      // (raw JSON in the log is a bug the owner cannot act on). Force a plain-text answer.
      reply = (parsed && parsed.tool) ? '' : ownerReply(raw);
      if (!reply) continue;
      break;
    }
    if (!reply) {
      // tools ran but the model stopped — write the report from the real results
      try { reply = ownerReply(await llm.text(model, contextBlock(page, project, memory, { toolResults, focus: opts.focus || null, refs: opts.refs || null }) + '\n\nWrite the owner-facing reply now, in ' + page.lang + ', reporting exactly what the tool results say. Plain text only. Never expose instructions, drafting, self-critique, or reasoning.', 'reply', { page: page.key, project: ctx.projectId })); }
      catch (_) { reply = toolResults.map(r => (r.ok ? '✓ ' + r.tool : '✕ ' + r.tool + ': ' + r.error)).join('\n'); }
    }
    if (!reply) reply = toolResults.length
      ? toolResults.map(r => (r.ok ? '✓ ' + r.tool : '✕ ' + r.tool + ': ' + r.error)).join('\n')
      : 'I’m ready for the next instruction.';

    // Search is a hard factual boundary. Once media.search ran, discard any
    // model-written list that is not backed by returned candidates. This is what
    // prevents fabricated IDs/titles after an empty or partial search response.
    const searchRuns = toolResults.filter(r => r && r.tool === 'media.search');
    if (searchRuns.length) {
      const realCandidates = searchCandidates(toolResults);
      if (!realCandidates.length) {
        reply = 'No real video candidates were returned by the source search. I will not invent titles or IDs. Try a broader product description or search again.';
      } else if (!directSearch) {
        const arabic = /[\u0600-\u06ff]/.test(opts.message || '');
        reply = (arabic ? 'لقيت ' : 'Found ') + realCandidates.length + (arabic ? ' نتيجة حقيقية؛ الكروت ديال الفيديو كاينة لتحت.' : ' real video candidate' + (realCandidates.length === 1 ? '' : 's') + '; the video cards are below.');
      }
    }

    // fix 9: assistant/status prose is NEVER promoted to a ScriptArtifact. A ScriptArtifact is
    // created only by the deterministic scripts stage (pages.fanout) or an explicit script.create
    // tool call — "لقد قمت مسبقاً بتوليد الصوت…" is a chat message and stays a chat message.

    // Aggregate tools (notably pages.fanout and pages.fanout.attach) return child artifact
    // ids inside result.pages.  Promote those ids at the agent boundary as well, otherwise
    // the artifacts are persisted in the conversation but disappear from the turn response
    // consumed by the browser/reconnect path.
    const aggregateArtifacts = toolResults.flatMap(r => {
      const pages = r && r.ok && r.result && Array.isArray(r.result.pages) ? r.result.pages : [];
      return pages.flatMap(p => Array.isArray(p.artifacts) ? p.artifacts : [])
        .map(a => typeof a === 'string' ? store.artifact(a) : (a && a.id ? store.artifact(a.id) || a : null))
        .filter(Boolean);
    });
    const artifacts = toolResults.filter(r => r.ok && r.result && r.result.artifact).map(r => r.result.artifact)
      .concat(toolResults.filter(r => r.ok && r.result && Array.isArray(r.result.artifacts)).flatMap(r => r.result.artifacts))
      .concat(aggregateArtifacts);
    const uniqueArtifacts = [...new Map(artifacts.filter(Boolean).map(a => [String(a.id), a])).values()];
    const failed = toolResults.filter(r => !r.ok);
    memory.stats = { ...(memory.stats || {}), messages: ((memory.stats || {}).messages || 0) + 1 };
    store.saveMemory(page.key, memory);

    const msg = {
      role: 'agent', text: ownerReply(reply) || (toolResults.length ? toolResults.map(r => (r.ok ? '✓ ' + r.tool : '✕ ' + r.tool + ': ' + r.error)).join('\n') : 'I’m ready for the next instruction.'),
      // Artifacts travel with the few extra facts the workspace needs to present them as real
      // objects: which PROJECT they belong to (a page version rendered in the orchestrator belongs
      // to its own project, and approving it must target that project, not the open one), which
      // page, their version, and when they were made. Every field is read off the stored record —
      // nothing here is composed by the model.
      artifacts: uniqueArtifacts.map(a => ({
        id: a.id, op: a.op, label: a.label, rel: a.rel, kind: a.kind,
        project: a.project || null, page: a.page || null, version: a.version || null,
        ts: a.ts || null, status: a.status || null, parent: a.parent || null,
        text: a.text || null, size: a.size || null,
        duration: a.probe ? a.probe.duration : null, width: a.probe ? a.probe.width : null, height: a.probe ? a.probe.height : null,
        params: a.params || null,
      })),
      tools: toolResults.map(r => ({ tool: r.tool, ok: r.ok, error: r.error || null, artifact: r.ok && r.result && r.result.artifact ? r.result.artifact.id : null })),
      candidates: searchCandidates(toolResults).length ? searchCandidates(toolResults) : null,
      music: toolResults.map(r => r.ok && r.result && r.result.results).find(Boolean) || null,
      project: project ? project.id : null,
    };
    store.appendMessage(page.key, msg);
    if (opts.emit) opts.emit('agent.reply', { page: page.key, project: msg.project, artifacts: msg.artifacts.length, failed: failed.length });
    return { ok: true, reply: msg.text, artifacts: msg.artifacts, tools: msg.tools, candidates: msg.candidates, music: msg.music, project: msg.project, toolResults };
  }

  return { TOOLS, toolSpecText: TOOL_SPEC_TEXT, executeTool, runTurn, contextBlock, toolNames: () => Object.keys(TOOLS) };
}

// test-only exports (functions defined inside createAgent are re-created per agent; the static
// helpers are re-exposed here for regression tests via a lightweight probe)
// PROFILE_KEYS — the seven page-recipe keys in canonical order ("profile N" numbering uses this).
const PROFILE_KEYS = ['alshihna', 'maghrebtechstore', 'maghrebly', 'mubadara', 'tashilat', 'vouchteck', 'amazon_liquidation'];
/**
 * matchProfileKey — resolve an explicit profile reference ("MaghrebTechStore", "profile 3",
 * "الصفحة 2", "dyal tashilat") to its profileKey, or null when the message names none. Pure
 * string matching (labels optional) so the rule is unit-testable. FULL keys/labels, longest
 * first: a 6-char prefix probe scanned in array order matched "Maghrebly" to maghrebtechstore
 * (both start with "maghre") — one wrong profile's TTS proved it in real use.
 */
function matchProfileKey(value, labels) {
  const raw = String(value || '');
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
  const t = norm(raw);
  const names = PROFILE_KEYS.map(k => ({ key: k, needles: [norm((labels || {})[k]), k].filter(n => n && n.length > 1) }))
    .sort((a, b) => Math.max(...b.needles.map(n => n.length)) - Math.max(...a.needles.map(n => n.length)));
  for (const n of names) for (const needle of n.needles) if (t.includes(needle)) return n.key;
  if (/maghrebly|maghrebli|magribli|مغربلي/i.test(raw)) return 'maghrebly';
  if (/vouch\s?tech/i.test(raw)) return 'vouchteck';
  const m = raw.match(/(?:profile|page|number|البروفايل|الصفحة|رقم)\s*#?\s*(\d)/i);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < PROFILE_KEYS.length) return PROFILE_KEYS[idx];
  }
  return null;
}
/**
 * fullVideosRequest — the OWNER'S composite command (2026-09-23): "make the full videos" runs
 * the WHOLE chain — current TTS → title → music → real synced subtitles → CTA card timing →
 * final render. Distinct from "render all 7" (render ONLY from the existing stage inputs) and
 * from view commands ("show the full videos"), which never build anything. Pure so it is
 * unit-testable.
 */
function fullVideosRequest(value) {
  const t = String(value || '');
  if (/\b(show|open|display|list|view|see|play)\b/i.test(t)) return false; // view commands never build
  // "retry the failed renders" re-runs the SAME chain — the stage-level staleness checks make it
  // touch ONLY the failed/stale profiles (voices stay TTS-only via ttsRequest).
  if (/\bretry\s+the\s+failed\s+(renders?|videos?)\b|عاود\s+(ال)?(فيديو|رندر)/i.test(t)) return true;
  const full = /\bfull\s+videos?\b|\bfull\s+versions?\b|complete\s+videos?|finished\s+videos?|the\s+whole\s+(video|production)|with\s+everything\b/i.test(t)
    || /الفيديوهات\s+الكاملة|الفيديو\s+الكامل|فيديوهات\s+كاملة|كاملة|بالكامل/.test(t);
  const wants = /\bvideos?\b|\bfinals?\b|\bclips?\b|فيديو/i.test(t);
  const make = /\b(make|create|generate|render|produce|build|finish|do|go)\b|صنع|دير|صاوب|أنش|تجهيز|توليد/i.test(t);
  return full && wants && make;
}
module.exports = { createAgent, STUDIO_POLICY, __test: { isSearchLikeMessage, requestedSearchCount, searchQueryFromMessage, matchProfileKey, fullVideosRequest } };
