// lib/editor.js — the project's editorial state, ASSEMBLED FROM REAL RECORDS.
//
// Nothing here is decorative. Every timeline block, tree node, drawer row and suggestion is derived
// from an artifact, a caption track, a transcription, or a recorded operation on the project. If a
// fact is not in the data, the corresponding block simply does not exist.
//
// HONESTY RULES THIS FILE FOLLOWS
//   * A block's timing is either `measured` (came from a real range/op param) or `full_length`
//     (the operation spans the whole clip, so we say so instead of inventing numbers).
//   * Captions are marked `burned` only when the CURRENT video was actually produced from that
//     track; otherwise they are `draft` — defined but not yet in the video.
//   * Suggestions are observations with evidence, never verdicts. Anything the pipeline cannot
//     actually execute carries `apply: null` so the UI cannot offer a button that would fail.
'use strict';

function createEditor(o) {
  const store = o.store;

  const r2 = n => Math.round(Number(n || 0) * 100) / 100;
  const num = (v, d) => (isFinite(Number(v)) ? Number(v) : d);

  /** Duration of the project's current video, from its probe — never guessed. */
  function durationOf(project, artifact) {
    const p = artifact && artifact.probe;
    if (p && isFinite(p.duration) && p.duration > 0) return p.duration;
    const s = project.source && project.source.meta;
    return (s && isFinite(s.duration) && s.duration) || 0;
  }

  /** What the project is currently cutting — the pointer, not a guess. */
  function currentArtifact(project) {
    if (!project) return null;
    if (project.current) { const a = store.artifact(project.current); if (a) return a; }
    const all = store.artifactsOf(project.id);
    return all.length ? all[all.length - 1] : null;
  }

  /**
   * captionState — which caption track the owner is working on, and whether that work is already in
   * the current cut.
   *
   * These are two different questions. Conflating them caused a real bug: after burning captions,
   * editing them created a newer version, but `active` stayed pinned to the burned one — so the
   * timeline kept showing the old captions and the edit looked like it had done nothing.
   *
   *   track  = the newest track: what you are editing right now.
   *   state  = 'burned' only when the CURRENT video was produced from that exact track.
   *   burnedTrack = the track already rendered into the current cut, when it is an older one.
   */
  function captionState(project) {
    const tracks = store.captionTracks(project.id);
    if (!tracks.length) return { track: null, state: 'none', burnedTrack: null };
    const cur = currentArtifact(project);
    const burnedId = (cur && cur.op === 'burn_subs' && cur.params && cur.params.track) || null;
    const burned = burnedId ? tracks.find(x => x.id === burnedId) : null;
    const active = tracks[0];
    return { track: active, state: burned && burned.id === active.id ? 'burned' : 'draft', burnedTrack: burned ? burned.id : null };
  }

  /**
   * timeline — tracks and blocks for the editor.
   * The video chain is linear (each operation rewrites the whole clip), so the video track holds
   * exactly one clip — the current cut — rather than a fabricated multi-clip arrangement.
   */
  function timeline(projectId) {
    const project = store.project(projectId);
    if (!project) throw new Error('unknown project: ' + projectId);
    const cur = currentArtifact(project);
    const artifacts = store.artifactsOf(project.id);
    const dur = durationOf(project, cur);
    const probe = (cur && cur.probe) || {};

    // Only operations that are actually part of THIS cut belong on its timeline. The project keeps
    // every operation ever run, so without the ancestry walk the timeline would claim overlays,
    // voiceovers and music that the current video does not contain — and the preview would
    // contradict it. Blocks are drawn only from the parent chain of the current artifact.
    const inCut = new Set();
    for (let a = cur, guard = 0; a && guard < 500; guard++) {
      if (inCut.has(a.id)) break;
      inCut.add(a.id);
      a = a.parent ? store.artifact(a.parent) : null;
    }
    const ops = (project.operations || []).filter(op => op && op.op && op.artifact && inCut.has(op.artifact));

    const video = [], origAudio = [], ttsTrack = [], music = [], captions = [], text = [];

    if (cur && cur.kind === 'video') {
      video.push({
        id: 'clip:' + cur.id, kind: 'video', artifact: cur.id, label: cur.label || 'Video',
        start: 0, end: r2(dur), timing: 'measured', editable: false,
        why: 'The cut is one continuous clip: every operation rewrites the whole timeline.',
      });
      if (probe.hasAudio !== false && dur > 0) {
        origAudio.push({
          id: 'ao:' + cur.id, kind: 'audio', artifact: cur.id, label: 'Original audio',
          start: 0, end: r2(dur), timing: 'measured', volume: 1,
          editable: true, editOp: 'volume', editArgs: { factor: 1 },
          why: 'Measured from the current cut probe.',
        });
      }
    }

    // Operations the owner actually ran, in order. Their real params give the real timing.
    ops.forEach((op, i) => {
      const art = op.artifact ? store.artifact(op.artifact) : null;
      const p = op.params || {};
      const base = { artifact: op.artifact || null, at: op.ts, editIndex: i };
      if (op.op === 'overlay_text') {
        const at = num(p.at, 0), d = num(p.duration, 3);
        text.push({
          ...base, id: 'tx:' + (op.artifact || i), kind: 'text', label: String(p.text || 'Text').slice(0, 40),
          text: p.text || '', start: r2(at), end: r2(Math.min(dur || at + d, at + d)),
          position: p.position || 'bottom', size: num(p.size, 64), timing: 'measured',
          editable: true, editOp: 'overlay_text', editArgs: p,
          why: 'This overlay was applied at ' + r2(at) + 's for ' + r2(d) + 's.',
        });
      } else if (op.op === 'voiceover') {
        const d = art && art.probe && art.probe.duration ? art.probe.duration : dur;
        ttsTrack.push({
          ...base, id: 'tts:' + (op.artifact || i), kind: 'tts', label: art ? art.label : 'Voiceover',
          text: p.text || '', voice: p.voice || null, start: 0, end: r2(Math.min(d || dur, dur || d)),
          timing: 'full_length', volume: 1, bed: num(p.bed, 0.15),
          editable: true, editOp: 'voiceover', editArgs: p,
          why: 'A voiceover is mixed across the whole clip; its own length is the only honest length.',
        });
      } else if (op.op === 'mix_music') {
        music.push({
          ...base, id: 'mus:' + (op.artifact || i), kind: 'music', label: art ? art.label : (p.title || 'Music'),
          url: p.url || '', start: 0, end: r2(dur), timing: 'full_length', volume: num(p.volume, 0.22),
          editable: true, editOp: 'mix_music', editArgs: p,
          why: 'Background music is mixed under the full clip (ducked beneath the voice).',
        });
      }
    });

    // How many projects-level files exist for a lane, independent of the current cut. A TTS file
    // or a music track can sit in the project without being part of this version, and hiding the
    // lane entirely would make the editor look like it has fewer tracks than it does.
    const avail = {
      tts: artifacts.filter(a => a.kind === 'audio' && (a.op === 'tts' || a.op === 'voiceover')).length,
      music: artifacts.filter(a => a.op === 'mix_music').length,
    };

    const cs = captionState(project);
    if (cs.track) {
      for (const s of cs.track.segments || []) {
        captions.push({
          id: 'cap:' + cs.track.id + ':' + s.id, kind: 'captions', track: cs.track.id, segment: s.id,
          label: s.text.slice(0, 40), text: s.text, display: s.display || s.text,
          start: r2(s.start), end: r2(s.end),
          position: (s.style && s.style.align) || s.position || 'bottom',
          derived: s.derived || 'measured', state: cs.state, preset: cs.track.preset,
          editable: true, timing: s.derived === 'interpolated' ? 'interpolated' : 'measured',
          why: s.derived === 'interpolated'
            ? 'Boundary interpolated inside a transcript segment (no word timings available).'
            : 'Boundary measured from the transcript segment.',
        });
      }
    }

    return {
      project: { id: project.id, title: project.title, page: project.page, status: project.status },
      duration: r2(dur),
      timebase: 1000,
      current: cur ? { id: cur.id, label: cur.label, op: cur.op, version: cur.version, rel: cur.rel, kind: cur.kind } : null,
      source: project.source ? { url: project.source.url, rel: project.source.meta && project.source.meta.cover ? null : null } : null,
      captionTrack: cs.track ? { id: cs.track.id, version: cs.track.version, preset: cs.track.preset, state: cs.state, language: cs.track.language } : null,
      tracks: [
        { id: 'video', kind: 'video', label: 'Video', blocks: video },
        { id: 'audio', kind: 'audio', label: 'Original audio', blocks: origAudio },
        { id: 'tts', kind: 'tts', label: 'Voice (TTS)', blocks: ttsTrack, available: avail.tts },
        { id: 'music', kind: 'music', label: 'Music', blocks: music, available: avail.music },
        { id: 'captions', kind: 'captions', label: 'Captions', blocks: captions },
        { id: 'text', kind: 'text', label: 'Text', blocks: text },
      ],
      counts: { versions: artifacts.length, captions: captions.length, text: text.length, tts: ttsTrack.length, music: music.length },
    };
  }

  /**
   * versionTree — the real artifact graph. Nodes are artifacts; edges are the recorded parent links,
   * so branches show up as branches instead of being flattened into V1..Vn.
   */
  function versionTree(projectId) {
    const project = store.project(projectId);
    if (!project) throw new Error('unknown project: ' + projectId);
    const all = store.artifactsOf(project.id);
    const ids = new Set(all.map(a => a.id));
    const nodes = all.map(a => ({
      id: a.id, label: a.label || a.op, op: a.op, kind: a.kind, version: a.version,
      ts: a.ts, rel: a.rel, duration: (a.probe && a.probe.duration) || null,
      current: a.id === project.current, parent: a.parent && ids.has(a.parent) ? a.parent : null,
      opLabel: OP_LABEL[a.op] || a.op,
    }));
    const edges = nodes.filter(n => n.parent).map(n => ({ from: n.parent, to: n.id }));
    const roots = nodes.filter(n => !n.parent).map(n => n.id);
    const withSource = project.source
      ? [{ id: 'source:' + project.id, label: 'Source', op: 'source', kind: 'source', version: 0, ts: null, rel: null, duration: (project.source.meta && project.source.meta.duration) || null, current: false, parent: null, opLabel: 'Source' }, ...nodes]
      : nodes;
    const sourceEdges = project.source && roots.length ? roots.map(r => ({ from: 'source:' + project.id, to: r })) : [];
    return {
      nodes: withSource, edges: [...sourceEdges, ...edges],
      current: project.current || null,
      note: 'Every operation appends a node. Nothing is deleted, so any earlier version can be restored.',
    };
  }
  const OP_LABEL = {
    source: 'Source', trim: 'Trim', crop_ratio: 'Aspect', resize: 'Scale', speed: 'Speed',
    overlay_text: 'Text', burn_subs: 'Captions', volume: 'Volume', mute: 'Mute',
    mix_music: 'Music', voiceover: 'Voice', render: 'Render', extract_frame: 'Frame', proxy: 'Proxy', tts: 'Voice file',
  };

  /** artifactDrawer — every real artifact plus the transcripts/caption tracks, grouped for retrieval. */
  function drawer(projectId) {
    const project = store.project(projectId);
    if (!project) throw new Error('unknown project: ' + projectId);
    const all = store.artifactsOf(project.id);
    const put = (list, group, item) => { (list[group] = list[group] || []).push(item); };
    const groups = {};
    for (const a of all) {
      const item = {
        id: a.id, label: a.label || a.op, op: a.op, kind: a.kind, version: a.version, rel: a.rel,
        previewRel: a.previewRel || null, duration: (a.probe && a.probe.duration) || null,
        width: (a.probe && a.probe.width) || null, height: (a.probe && a.probe.height) || null,
        bytes: a.size || null, ts: a.ts, current: a.id === project.current,
      };
      const group = a.op === 'source' ? 'source'
        : a.op === 'render' ? (/final/i.test(a.label || '') ? 'final' : 'previews')
        : a.op === 'extract_frame' ? 'frames'
        : a.op === 'tts' ? 'tts'
        : a.op === 'mix_music' ? 'music'
        : a.op === 'proxy' ? 'proxies'
        : 'versions';
      put(groups, group, item);
    }
    const transcripts = store.transcriptions(project.id).map(t => ({
      id: t.id, label: (t.language || 'auto') + ' · ' + (t.segments || []).length + ' segments',
      segments: (t.segments || []).length, duration: t.duration, model: t.model, timing: t.timing,
      wordTimings: !!t.wordTimings, corrections: Object.keys(t.corrections || {}).length, ts: t.createdAt,
    }));
    const tracks = store.captionTracks(project.id).map(t => ({
      id: t.id, label: (t.preset || 'captions') + ' v' + t.version, segments: (t.segments || []).length,
      preset: t.preset, language: t.language, ts: t.updated,
    }));
    const order = ['source', 'versions', 'previews', 'final', 'tts', 'music', 'transcripts', 'captions', 'frames', 'proxies'];
    return {
      project: project.id, current: project.current || null,
      groups: order.filter(k => groups[k]).map(k => ({ key: k, items: groups[k] })),
      transcripts, captionTracks: tracks,
      total: all.length,
    };
  }

  /**
   * suggestions — factual observations about the current cut.
   *
   * Sources of truth used: the transcript's measured segment boundaries, the stored analysis, the
   * applied operations and their params, and the caption track. No model is asked to "review" the
   * video here, so nothing can be hallucinated — every item carries the evidence it came from.
   *
   * An item with `apply: null` is informational: the current media pipeline has no operation that
   * could carry it out, and offering a button that would fail is worse than saying nothing.
   */
  function suggestions(projectId) {
    const project = store.project(projectId);
    if (!project) throw new Error('unknown project: ' + projectId);
    const cur = currentArtifact(project);
    const dur = durationOf(project, cur);
    const out = [];
    let n = 0;
    const add = s => { out.push({ id: 'SG' + (++n), confidence: 'observation', ...s }); };

    // ---- 1. leading dead space (measured: transcript boundaries) ----
    const tr = store.transcriptions(project.id)[0] || null;
    if (tr && (tr.segments || []).length) {
      const first = tr.segments[0];
      if (first.start >= 1.2) {
        add({
          kind: 'trim', severity: 'info', label: 'Possible dead space at the start',
          detail: 'Speech in the transcript begins at ' + r2(first.start) + 's. Trimming there removes ' + r2(first.start) + 's before the first word.',
          evidence: 'transcript ' + tr.id + ' segment ' + first.id + ' starts at ' + r2(first.start) + 's (measured)',
          range: { start: 0, end: r2(first.start) },
          apply: { op: 'trim', args: { start: r2(first.start), duration: r2(Math.max(0.5, dur - first.start)) } },
        });
      }
      // ---- 2. mid-clip gaps: report, but do not pretend we can cut them out ----
      for (let i = 1; i < tr.segments.length && i <= 12; i++) {
        const gap = tr.segments[i].start - tr.segments[i - 1].end;
        if (gap >= 1.6) {
          add({
            kind: 'gap', severity: 'info', label: 'Possible pause of ' + r2(gap) + 's',
            detail: 'A ' + r2(gap) + 's gap between transcript segments at ' + r2(tr.segments[i - 1].end) + 's. Removing a middle section needs clip joining, which this pipeline does not do yet.',
            evidence: 'measured gap between ' + tr.segments[i - 1].id + ' and ' + tr.segments[i].id,
            range: { start: r2(tr.segments[i - 1].end), end: r2(tr.segments[i].start) },
            apply: null,
          });
        }
      }
    }

    // ---- 3. product appears late (the analysis is the evidence) ----
    const a = project.analysis || {};
    const firstApp = Number(a.product_first_appearance_sec);
    if (isFinite(firstApp) && firstApp >= 2 && dur > firstApp) {
      add({
        kind: 'hook', severity: 'info', label: 'Product first appears at ' + r2(firstApp) + 's',
        detail: 'The analysis placed the product on screen at ' + r2(firstApp) + 's. Starting the cut there makes the product the opening frame.',
        evidence: 'project analysis: product_first_appearance_sec = ' + r2(firstApp) + (a.suggested_product ? ' (' + a.suggested_product + ')' : ''),
        range: { start: 0, end: r2(firstApp) },
        apply: { op: 'trim', args: { start: r2(firstApp), duration: r2(Math.max(0.5, dur - firstApp)) } },
      });
    }

    // ---- 4. text that runs past the end of the clip ----
    for (const op of (project.operations || [])) {
      if (op.op !== 'overlay_text' || !dur) continue;
      const end = num(op.params && op.params.at, 0) + num(op.params && op.params.duration, 3);
      if (end > dur + 0.15) {
        add({
          kind: 'text', severity: 'warn', label: 'Text runs past the end of the clip',
          detail: 'An overlay ends at ' + r2(end) + 's but the clip is ' + r2(dur) + 's, so its tail is never shown.',
          evidence: 'operation overlay_text at ' + r2(num(op.params && op.params.at, 0)) + 's, duration ' + r2(num(op.params && op.params.duration, 3)) + 's',
          range: { start: r2(dur), end: r2(end) },
          apply: null,
        });
      }
    }

    // ---- 5. captions defined but not in the current video ----
    const cs = captionState(project);
    if (cs.track && cs.state === 'draft') {
      add({
        kind: 'captions', severity: 'warn', label: 'Captions are not in the current video yet',
        detail: 'Caption track ' + cs.track.id + ' has ' + (cs.track.segments || []).length + ' segments, and the current cut was not rendered from it.',
        evidence: 'caption track ' + cs.track.id + ', current artifact ' + (cur ? cur.op + ' ' + cur.id : 'none'),
        range: null,
        apply: { tool: 'caption.burn', args: { track: cs.track.id } },
      });
      // ---- 6. caption placement inside typical bottom platform UI ----
      const y = num((cs.track.style || {}).y, 88);
      if (y >= 86) {
        add({
          kind: 'captions', severity: 'info', label: 'Captions sit low in the frame',
          detail: 'Caption baseline is at ' + r2(y) + '% of the frame height. On 9:16 posts the bottom strip is often covered by platform UI, so moving up to about 80% is usually safer.',
          evidence: 'caption style y = ' + r2(y) + '%',
          range: null,
          apply: { tool: 'caption.update', args: { style: { y: 80 } } },
        });
      }
    }

    // ---- 7. music configured louder than the voice bed ----
    const mu = (project.operations || []).filter(o => o.op === 'mix_music').pop();
    const vo = (project.operations || []).filter(o => o.op === 'voiceover').pop();
    if (mu && vo && num(mu.params && mu.params.volume, 0.22) > num(vo.params && vo.params.bed, 0.15) * 2.2) {
      add({
        kind: 'audio', severity: 'warn', label: 'Music may sit above the voice',
        detail: 'Music volume is ' + r2(num(mu.params.volume, 0.22)) + ' while the original bed under the voice is ' + r2(num(vo.params.bed, 0.15)) + '. Ducking is applied, but the gap suggests the voice could still be crowded.',
        evidence: 'mix_music volume vs voiceover bed (configured values)',
        range: null,
        apply: { op: 'mix_music', args: { url: (mu.params || {}).url, title: (mu.params || {}).title, volume: r2(Math.max(0.05, num(vo.params && vo.params.bed, 0.15) * 1.5)) } },
      });
    }

    return {
      project: project.id, artifact: cur ? cur.id : null, duration: r2(dur),
      note: 'These are observations derived from stored data (transcript boundaries, analysis, applied operations, caption settings) — not a model review and not a verdict.',
      items: out,
    };
  }

  return { timeline, versionTree, drawer, suggestions, captionState, currentArtifact, durationOf, OP_LABEL };
}

module.exports = { createEditor };
