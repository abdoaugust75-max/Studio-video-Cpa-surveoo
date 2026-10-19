// lib/plan.js — the Edit Decision List: validate a plan BEFORE running it, and show a real diff.
//
// Two jobs, both about not surprising the owner:
//
//   validate() — a plan is checked against the project's effective locks and against the operations
//   that actually exist, BEFORE any job is queued. A locked operation is removed from the plan and
//   explained; it is never silently executed, and it is never silently dropped without a reason.
//
//   diff() — the before/after of what the plan would change, computed from the project's REAL state
//   (current artifact probe, the operations actually in the current cut, the active caption track).
//   It is derived from structured operations, never from prose about them, so it cannot claim a
//   change the pipeline would not make.
'use strict';
const LOCK = require('./locks');

function createPlan(o) {
  const store = o.store;
  const resolveOp = o.resolveOp;
  const round = n => Math.round(Number(n || 0) * 100) / 100;

  /** Duration of the current cut, from its probe — never guessed. */
  function currentDuration(project) {
    const a = project.current ? store.artifact(project.current) : null;
    if (a && a.probe && isFinite(a.probe.duration) && a.probe.duration > 0) return a.probe.duration;
    const s = project.source && project.source.meta;
    return (s && isFinite(s.duration) && s.duration) || null;
  }

  /** The current value of a layer, read from real records, so a diff has an honest left side. */
  function layerState(project, layer) {
    const dur = currentDuration(project);
    const cur = project.current ? store.artifact(project.current) : null;
    const ops = (project.operations || []);
    const lastOf = op => ops.filter(x => x.op === op).pop() || null;
    switch (layer) {
      case 'cuts': {
        const t = lastOf('trim');
        const p = t && t.params ? t.params : null;
        return { value: dur != null ? round(dur) + 's clip' : 'unknown length', detail: p ? ('cut to ' + round(p.start) + 's + ' + round(p.duration) + 's') : 'full source' };
      }
      case 'framing': {
        const c = lastOf('crop_ratio') || lastOf('resize');
        return { value: c ? ((c.params && c.params.ratio) || c.op) : ((cur && cur.probe && cur.probe.width && cur.probe.height) ? (cur.probe.width + '×' + cur.probe.height) : 'source framing'), detail: c ? c.op : 'untouched' };
      }
      case 'timing': {
        const s = lastOf('speed');
        return { value: s && s.params && s.params.factor ? (round(s.params.factor) + '×') : '1× (normal speed)', detail: s ? 'retimed' : 'untouched' };
      }
      case 'captions': {
        const burned = (cur && cur.op === 'burn_subs' && cur.params && cur.params.track) || null;
        const tracks = store.captionTracks(project.id);
        const active = tracks[0] || null;
        if (!active) return { value: 'no caption track', detail: 'none built yet' };
        return {
          value: (burned === active.id ? 'burned into the video' : 'draft, not in the video'),
          detail: (active.preset || 'captions') + ' v' + active.version + ', ' + (active.segments || []).length + ' segments',
        };
      }
      case 'text': {
        const t = lastOf('overlay_text');
        return t && t.params ? { value: '"' + String(t.params.text || '').slice(0, 60) + '"', detail: 'at ' + round(t.params.at) + 's for ' + round(t.params.duration) + 's' } : { value: 'no text overlay', detail: 'none' };
      }
      case 'tts': {
        const v = lastOf('voiceover');
        return v && v.params ? { value: String(v.params.text || '').slice(0, 60) || 'voiceover', detail: 'mixed across the clip' } : { value: 'no voiceover', detail: 'none' };
      }
      case 'music': {
        const m = lastOf('mix_music');
        return m && m.params ? { value: String(m.params.title || m.params.url || 'music'), detail: 'volume ' + round((m.params.volume != null ? m.params.volume : 0.22) * 100) + '%' } : { value: 'no music', detail: 'none' };
      }
      case 'audio': {
        const v = lastOf('volume');
        const m = lastOf('mute');
        if (m) return { value: 'muted', detail: 'original audio muted' };
        return v && v.params && v.params.factor != null ? { value: round(v.params.factor * 100) + '%', detail: 'original audio level' } : { value: '100%', detail: 'original audio level' };
      }
      case 'source': return { value: project.source ? (project.source.title || project.source.url || 'imported source') : 'no source imported', detail: 'the imported file' };
      case 'color': return { value: 'no grade applied', detail: 'untouched' };
      default: return { value: '—', detail: '' };
    }
  }

  /** What one operation would set a layer to. */
  function opEffect(project, op, args) {
    const dur = currentDuration(project);
    const a = args || {};
    switch (op) {
      case 'trim':
        return { layer: 'cuts', value: round(a.start) + 's + ' + round(a.duration) + 's (' + round(a.duration) + 's clip)', detail: 'cut from ' + round(a.start) + 's' };
      case 'crop_ratio': return { layer: 'framing', value: a.ratio || '1:1', detail: a.fit ? ('fit: ' + a.fit) : 'cropped to ratio' };
      case 'resize':
        if (a.width) return { layer: 'framing', value: a.width + '×' + (a.height || 'auto'), detail: 'scaled' };
        return { layer: 'framing', value: (a.scale ? (round(a.scale * 100) + '%') : a.height ? (a.height + 'px tall') : 'resized'), detail: 'scaled' };
      case 'speed': return { layer: 'timing', value: round(a.factor) + '×', detail: 'playback speed' };
      case 'overlay_text': return { layer: 'text', value: '"' + String(a.text || '').slice(0, 60) + '"', detail: 'at ' + round(a.at) + 's for ' + round(a.duration != null ? a.duration : 3) + 's, ' + (a.position || 'bottom') };
      case 'burn_subs': return { layer: 'captions', value: 'burned into the video', detail: 'from the current caption track' };
      case 'volume': return { layer: 'audio', value: round((a.factor != null ? a.factor : 1) * 100) + '%', detail: 'original audio level' };
      case 'mute': return { layer: 'audio', value: 'muted', detail: 'original audio muted' };
      case 'mix_music': return { layer: 'music', value: String(a.title || a.url || 'music'), detail: 'volume ' + round((a.volume != null ? a.volume : 0.22) * 100) + '%' + (dur ? ', across ' + round(dur) + 's' : '') };
      case 'voiceover': return { layer: 'tts', value: String(a.text || '').slice(0, 60) || 'voiceover', detail: 'voice ' + (a.voice || 'default') + (a.rate ? (', rate ' + round(a.rate)) : '') };
      case 'render': return { layer: 'output', value: (a.mode === 'final' ? 'final export' : 'preview export'), detail: 'writes a new version, nothing edited' };
      case 'extract_frame': return { layer: 'output', value: 'still frame', detail: 'writes a new file, nothing edited' };
      case 'proxy': return { layer: 'output', value: 'proxy file', detail: 'writes a new file, nothing edited' };
      default: return { layer: LOCK.layerOf(op) || 'output', value: op, detail: '' };
    }
  }

  /**
   * validate — resolve names and check locks. Returns accepted ops, and a reason for each rejected
   * one. `enabled: false` is the owner's own choice from the plan inspector and is kept as `skipped`
   * so the UI can show it, not as a rejection.
   */
  function validate(project, rawOps) {
    const locks = store.effectiveLocks(project.id);
    const accepted = [], blocked = [], unknown = [], skipped = [];
    for (const raw of (Array.isArray(rawOps) ? rawOps : []).slice(0, 24)) {
      const name = resolveOp(raw && raw.op);
      if (!name) { unknown.push(String((raw && raw.op) || '?')); continue; }
      const entry = { op: name, args: (raw && raw.args) || {}, reason: (raw && raw.reason) || '', enabled: (raw && raw.enabled) !== false };
      const layer = LOCK.blockedOp(locks, name);
      if (layer) {
        blocked.push({ ...entry, layer, error: new LOCK.LockedError(layer, name).message });
        continue;
      }
      if (!entry.enabled) { skipped.push({ ...entry, layer: opEffect(project, name, entry.args).layer }); continue; }
      accepted.push(entry);
    }
    return { accepted, blocked, unknown, skipped, locks };
  }

  /**
   * diff — the before/after per layer for a plan, plus the layers the locks hold constant.
   * Layers touched by more than one operation collapse to one row (last write wins), which is what
   * the pipeline would actually produce.
   */
  function diff(project, ops) {
    const order = LOCK.LAYERS.map(l => l.key);
    const rows = new Map();
    for (const entry of (ops || [])) {
      const eff = opEffect(project, entry.op, entry.args);
      if (eff.layer === 'output') continue;
      const before = layerState(project, eff.layer);
      rows.set(eff.layer, {
        layer: eff.layer, label: (LOCK.BY_KEY.get(eff.layer) || { label: eff.layer }).label,
        from: before.value, fromDetail: before.detail, to: eff.value, toDetail: eff.detail,
        changed: before.value !== eff.value, op: entry.op,
      });
    }
    const touched = new Set(rows.keys());
    const locks = store.effectiveLocks(project.id);
    const held = LOCK.LAYERS
      .filter(l => locks[l.key] && !touched.has(l.key) && l.key !== 'source')
      .map(l => ({ layer: l.key, label: l.label, from: layerState(project, l.key).value, to: 'unchanged', detail: 'locked', changed: false }));
    return {
      project: project.id,
      rows: order.filter(k => rows.has(k)).map(k => rows.get(k)),
      held,
      note: 'Left side read from the project\'s current state; right side from the structured operations. Nothing here is prose.',
    };
  }

  return { validate, diff, layerState, opEffect, currentDuration };
}

module.exports = { createPlan };
