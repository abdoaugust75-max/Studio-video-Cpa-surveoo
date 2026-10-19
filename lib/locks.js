// lib/locks.js — edit locks. A lock is a persisted project fact, not a prompt suggestion.
//
// WHY THIS IS CODE AND NOT A SENTENCE IN A PROMPT
// The owner can say "Improve this video" on a cut they already approved. If the only thing stopping
// the pipeline from re-cutting it were a line of prompt text, the failure mode is silent: the video
// comes back different and nothing says why. So a lock is:
//
//   1. persisted on the project (survives reload and restart),
//   2. declared to the model (so it plans within the constraint),
//   3. VALIDATED in media.applyOp before any file is written (so it cannot be violated even if the
//      model ignores the declaration),
//   4. INHERITED from a master project by its branches, where a master lock cannot be released by
//      the branch (only by changing the master).
//
// Layers are the vocabulary the owner thinks in ("cuts", "captions"), not operation names.
'use strict';

/**
 * LAYERS — every lockable layer, in timeline order, with the operations it governs.
 * `ops` are media-operation names; `services` are non-FFmpeg producers (caption track edits,
 * transcript-driven cuts) that must be blocked by the same lock.
 */
const LAYERS = [
  { key: 'source',   label: 'Source',   desc: 'The imported source file itself.',                     ops: [] },
  { key: 'cuts',     label: 'Cuts',     desc: 'Trim / cut points and clip boundaries.',               ops: ['trim', 'concat'] },
  { key: 'framing',  label: 'Framing',  desc: 'Aspect ratio, crop and scale.',                        ops: ['crop_ratio', 'resize'] },
  { key: 'timing',   label: 'Timing',   desc: 'Playback speed and time remapping.',                   ops: ['speed'] },
  { key: 'captions', label: 'Captions', desc: 'Caption text, timing and burn-in.',                    ops: ['burn_subs'], services: ['caption.create', 'caption.update', 'caption.burn'] },
  { key: 'text',     label: 'Text',     desc: 'Text overlays burned into the video.',                  ops: ['overlay_text'] },
  { key: 'tts',      label: 'TTS',      desc: 'Generated voiceover and its mix.',                      ops: ['voiceover', 'remove_tts'], services: ['tts.generate'] },
  { key: 'music',    label: 'Music',    desc: 'Background music and its level.',                       ops: ['mix_music', 'remove_music', 'music_volume'] },
  { key: 'audio',    label: 'Audio',    desc: 'Original audio level and muting.',                      ops: ['volume', 'mute', 'mute_source', 'source_volume'] },
  { key: 'color',    label: 'Color / look', desc: 'Look, grade and colour treatment.',                ops: ['color', 'grade'] },
];

const BY_KEY = new Map(LAYERS.map(l => [l.key, l]));
const OP_TO_LAYER = (() => {
  const m = new Map();
  for (const l of LAYERS) for (const op of (l.ops || [])) m.set(op, l.key);
  return m;
})();
const SERVICE_TO_LAYER = (() => {
  const m = new Map();
  for (const l of LAYERS) for (const s of (l.services || [])) m.set(s, l.key);
  return m;
})();

/** Operations that are never lockable: they produce a new file for inspection, not an edit. */
const UNLOCKABLE_OPS = new Set(['render', 'extract_frame', 'proxy']);

/** Which layer governs an operation (null when the operation is not lockable). */
function layerOf(op) { return OP_TO_LAYER.get(String(op || '')) || null; }
function layerOfService(name) { return SERVICE_TO_LAYER.get(String(name || '')) || null; }

/** Normalise a lock map: only known layers, only booleans, false entries dropped. */
function normalize(locks) {
  const out = {};
  if (!locks || typeof locks !== 'object') return out;
  for (const l of LAYERS) if (locks[l.key] === true) out[l.key] = true;
  return out;
}

/**
 * effective(lists) — merge lock maps. Anyone who declares a layer locked wins: a branch cannot
 * release a master's lock by simply not mentioning it, which is the whole point of inheritance.
 */
function effective(...lists) {
  const out = {};
  for (const l of lists) for (const k of Object.keys(normalize(l))) out[k] = true;
  return out;
}

/** Is this operation blocked? Returns the layer key or null. */
function blockedOp(locks, op) {
  if (UNLOCKABLE_OPS.has(op)) return null;
  const layer = layerOf(op);
  return layer && normalize(locks)[layer] ? layer : null;
}

function blockedService(locks, name) {
  const layer = layerOfService(name);
  return layer && normalize(locks)[layer] ? layer : null;
}

class LockedError extends Error {
  constructor(layer, what) {
    const l = BY_KEY.get(layer);
    super((l ? l.label : layer) + ' is locked on this project, so ' + what + ' was not run. Unlock it in the editor first.');
    this.name = 'LockedError';
    this.locked = true;
    this.layer = layer;
  }
}

/** Throw if the operation would touch a locked layer. Called before any file is written. */
function assertOp(locks, op) {
  const layer = blockedOp(locks, op);
  if (layer) throw new LockedError(layer, op);
  return op;
}
function assertService(locks, name) {
  const layer = blockedService(locks, name);
  if (layer) throw new LockedError(layer, name);
  return name;
}

/** The lock list with state attached — what the UI and the agent context both read. */
function describe(locks, inherited) {
  const own = normalize(locks), inh = normalize(inherited);
  return LAYERS.map(l => ({
    key: l.key, label: l.label, desc: l.desc,
    locked: !!own[l.key] || !!inh[l.key],
    own: !!own[l.key],
    inherited: !own[l.key] && !!inh[l.key],
  }));
}

/** A short line for the agent's context: only what is locked, or nothing at all. */
function summary(locks, inherited) {
  const all = effective(locks, inherited);
  const keys = Object.keys(all);
  if (!keys.length) return 'no layers are locked';
  return 'LOCKED (do not propose operations on these): ' + keys.map(k => (BY_KEY.get(k) || { label: k }).label).join(', ');
}

module.exports = { LAYERS, BY_KEY, layerOf, layerOfService, normalize, effective, blockedOp, blockedService, assertOp, assertService, describe, summary, LockedError, UNLOCKABLE_OPS };
