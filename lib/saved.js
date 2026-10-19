// lib/saved.js — the Saved Source library.
//
// Saving a source keeps the POINTER, never the video. A saved source is a URL plus the facts the
// search actually measured about it, and the owner's own tags/notes. Downloading on save would turn
// a browsing action into a media action and fill the disk with footage nobody chose.
//
// A saved source is NOT a promise that the clip still exists: platform URLs expire. So availability
// is only ever set by an actual check — an import that really fetched it, or a probe — and never
// assumed from the fact that it saved fine once. `unchecked` is a real state, not a bug.

const U = require('./util');

const LIMITS = { title: 140, author: 60, note: 300, tag: 24, tags: 8, collection: 40 };
const DEFAULT_CAP = 800;

function host(url) {
  try { return String(url).replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, ''); }
  catch (_) { return ''; }
}
function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = U.sanitizeText(t, LIMITS.tag).trim();
    if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function createSaved(opts) {
  const o = opts || {};
  const file = o.file;
  if (!file) throw new Error('createSaved needs a file path');
  const log = o.log || (() => {});
  const cap = o.cap || DEFAULT_CAP;
  let cache = null;

  function all() {
    if (cache) return cache;
    const d = U.readJson(file, null);
    const items = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : []);
    cache = items.filter(x => x && x.id && x.url);
    return cache;
  }
  function persist() {
    U.writeJsonAtomic(file, { version: 1, updatedAt: U.nowIso(), items: all().slice(0, cap) });
  }
  /** Stable id per URL, so saving the same clip twice updates one record instead of duplicating it. */
  const idFor = url => 'src_' + U.hash16(String(url));

  /**
   * shape — one saved source. Only fields that came from a real search result or from the owner are
   * ever written; nothing is invented to make a card look complete.
   */
  function shape(input) {
    const out = {};
    const set = (k, v, max) => { const s = U.sanitizeText(v, max).trim(); if (s) out[k] = s; };
    set('title', input.title, LIMITS.title);
    set('author', input.author, LIMITS.author);
    set('cover', input.cover, 2048);
    set('play', input.play, 2048);
    set('note', input.note, LIMITS.note);
    set('collection', input.collection, LIMITS.collection);
    set('page', input.page, 40);
    set('platform', input.platform || host(input.url), 60);
    if (input.duration != null && isFinite(Number(input.duration)) && Number(input.duration) > 0) out.duration = Math.round(Number(input.duration));
    const tags = normTags(input.tags);
    if (tags.length) out.tags = tags;
    return out;
  }

  function save(input) {
    const url = String((input && input.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('a saved source needs a real http(s) URL to point at');
    const id = idFor(url);
    const list = all();
    const now = U.nowIso();
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) {
      // Re-saving refreshes what we now know and keeps when it was first saved: a library should not
      // lose its history because the owner saved the same clip a second time.
      const prev = list[i];
      const merged = { ...prev, ...shape(input), id, url, savedAt: prev.savedAt || now, lastSeenAt: now, saves: (prev.saves || 1) + 1 };
      merged.tags = normTags([...(prev.tags || []), ...((input && input.tags) || [])]);
      list[i] = merged;
      persist();
      log('info', 'saved.update', { id, url: host(url) });
      return { record: merged, created: false };
    }
    const rec = {
      id, url, ...shape(input), savedAt: now, lastSeenAt: now, saves: 1,
      // Deliberately not 'ok': nothing has fetched this URL since it was saved.
      availability: { state: 'unchecked', checkedAt: null, note: 'not fetched since it was saved — platform links expire' },
    };
    list.unshift(rec);
    persist();
    log('info', 'saved.add', { id, url: host(url), title: rec.title || '' });
    return { record: rec, created: true };
  }

  function get(id) { return all().find(x => x.id === id) || null; }

  function remove(id) {
    const list = all();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return { removed: false };
    const [gone] = list.splice(i, 1);
    persist();
    log('info', 'saved.remove', { id });
    return { removed: true, record: gone };
  }

  /**
   * markSeen — called only by something that REALLY touched the URL (an import that produced a
   * playable artifact, or a probe). This is the only way availability stops being 'unchecked'.
   */
  function markSeen(url, patch) {
    const id = idFor(url);
    const list = all();
    const rec = list.find(x => x.id === id);
    if (!rec) return null;
    const when = U.nowIso();
    rec.lastSeenAt = when;
    rec.availability = {
      state: (patch && patch.state) || 'ok',
      checkedAt: when,
      note: (patch && patch.note) || 'fetched successfully',
    };
    if (patch && patch.project) rec.importedProject = String(patch.project);
    if (patch && patch.artifact) rec.importedArtifact = String(patch.artifact);
    persist();
    return rec;
  }

  function markGone(url, note) {
    const rec = all().find(x => x.url === url);
    if (!rec) return null;
    rec.availability = { state: 'gone', checkedAt: U.nowIso(), note: U.sanitizeText(note || 'the platform refused the download', 160) };
    persist();
    return rec;
  }

  /**
   * search — the library is searched the same way the owner talks: words, not operators. No terms
   * means "everything, newest first"; terms that match nothing returns nothing rather than a
   * consolation list, because a wrong saved source is worse than an honest empty result.
   */
  function search(opts2) {
    const q = String((opts2 && opts2.q) || '').trim();
    const collection = String((opts2 && opts2.collection) || '').trim().toLowerCase();
    const page = String((opts2 && opts2.page) || '').trim();
    let list = all().slice();
    if (collection) list = list.filter(x => String(x.collection || '').toLowerCase() === collection);
    if (page) list = list.filter(x => x.page === page);
    const terms = (q.toLowerCase().match(/[a-z0-9\u0600-\u06ff]+/g) || []);
    if (terms.length) {
      const scored = [];
      for (const x of list) {
        const hay = [x.title, x.author, x.collection, x.note, (x.tags || []).join(' '), x.platform].join(' ').toLowerCase();
        let s = 0;
        for (const t of terms) if (hay.includes(t)) s += t.length > 3 ? 2 : 1;
        if (s > 0) scored.push({ x, s });
      }
      scored.sort((a, b) => b.s - a.s || String(b.x.savedAt).localeCompare(String(a.x.savedAt)));
      list = scored.map(r => r.x);
    } else {
      list.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    }
    const limit = Math.max(1, Math.min(Number((opts2 && opts2.limit) || 50), 200));
    return { total: list.length, items: list.slice(0, limit), query: q, collection: collection || null };
  }

  /** collections — derived from the records, so a collection exists exactly while it holds something. */
  function collections() {
    const m = new Map();
    for (const x of all()) {
      const c = String(x.collection || '').trim();
      if (!c) continue;
      m.set(c, (m.get(c) || 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  function stats() {
    const list = all();
    const byState = { unchecked: 0, ok: 0, gone: 0 };
    for (const x of list) {
      const s = (x.availability && x.availability.state) || 'unchecked';
      byState[s] = (byState[s] || 0) + 1;
    }
    return { total: list.length, collections: collections().length, availability: byState, file };
  }

  return { all: () => all().slice(), get, save, remove, markSeen, markGone, search, collections, stats, idFor };
}

module.exports = { createSaved };
