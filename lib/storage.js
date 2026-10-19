// lib/storage.js — one place that decides WHERE things live, and which kind of thing they are.
//
// Why this exists: the audit found every byte of state under a single `data/` tree, with no
// distinction between "lose this and the owner loses work" and "lose this and we just recompute
// it". That is fine on one local disk and wrong the moment the app runs in a container, where
// everything outside a mounted volume disappears on redeploy.
//
// So each root is declared with a PERSISTENCE CLASS:
//   persistent  — must survive container recreation (mount a volume here)
//   cache       — regenerable; safe to lose, safe to wipe
//
// Nothing is deployed by this file. It only makes the roots configurable and makes the split
// explicit, so a future Coolify deploy has an unambiguous list of volumes to mount.
'use strict';
const path = require('path');
const fs = require('fs');

/** Resolve a root from an env var, falling back to its default. Always absolute. */
function root(env, name, fallback) {
  const v = env && env[name];
  return v && String(v).trim() ? path.resolve(String(v).trim()) : path.resolve(fallback);
}

/**
 * resolveStorage — every path the application writes to, derived from four configurable roots.
 *
 * Env vars (all optional; defaults reproduce the current local layout exactly):
 *   VS_DATA_DIR    persistent application state        (default <repo>/data)
 *   VS_STUDIO_DIR  studio domain state                 (default <VS_DATA_DIR>/studio)
 *   VS_MEDIA_DIR   persistent project media            (default <VS_STUDIO_DIR>/media)
 *   VS_CACHE_DIR   regenerable cache/scratch           (default <VS_DATA_DIR>/cache)
 *   VS_LOGS_DIR    logs + activity stream              (default <VS_STUDIO_DIR>/logs)
 */
function resolveStorage(o) {
  const repoRoot = path.resolve((o && o.root) || path.join(__dirname, '..'));
  const env = (o && o.env) || process.env;

  const dataDir = root(env, 'VS_DATA_DIR', path.join(repoRoot, 'data'));
  const studioDir = root(env, 'VS_STUDIO_DIR', path.join(dataDir, 'studio'));
  const mediaDir = root(env, 'VS_MEDIA_DIR', path.join(studioDir, 'media'));
  const cacheDir = root(env, 'VS_CACHE_DIR', path.join(dataDir, 'cache'));
  const logsDir = root(env, 'VS_LOGS_DIR', path.join(studioDir, 'logs'));

  // Tools are needed to RUN, not to preserve. They live with the app so a fresh clone works.
  const toolsDir = path.resolve(env.VS_TOOLS_DIR || path.join(repoRoot, 'tools'));

  const S = {
    repoRoot, env: {
      VS_DATA_DIR: env.VS_DATA_DIR || null, VS_STUDIO_DIR: env.VS_STUDIO_DIR || null,
      VS_MEDIA_DIR: env.VS_MEDIA_DIR || null, VS_CACHE_DIR: env.VS_CACHE_DIR || null,
      VS_LOGS_DIR: env.VS_LOGS_DIR || null, VS_TOOLS_DIR: env.VS_TOOLS_DIR || null,
    },
    // ---- persistent (mount these as volumes in a container) ----
    dataDir, studioDir, mediaDir, logsDir,
    // legacy layer kept in place so existing projects keep working
    legacyMediaDir: path.join(dataDir, 'media'),
    legacyProjectsDir: path.join(dataDir, 'projects'),
    legacyChatsDir: path.join(dataDir, 'chats'),
    secretsDir: dataDir,
    // ---- cache (regenerable) ----
    cacheDir,
    // ---- runtime (needed to execute, not to preserve) ----
    toolsDir,
  };

  S.ensure = function ensure() {
    for (const d of [S.dataDir, S.studioDir, S.mediaDir, S.cacheDir, S.logsDir, S.legacyMediaDir, S.legacyProjectsDir, S.legacyChatsDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    }
    return S;
  };

  /**
   * describe — the audit, as data. Each entry declares what it is and what happens to it when
   * each hostile event occurs, so the answer is generated from the layout instead of remembered.
   */
  S.describe = function describe() {
    const entry = (name, kind, dir, note, survives) => ({ name, kind, dir, note, survives });
    const P = { reload: true, restart: true, cacheCleared: true, containerRecreate: false };
    const C = { reload: true, restart: true, cacheCleared: false, containerRecreate: false };
    const R = { reload: true, restart: true, cacheCleared: false, containerRecreate: false };
    return {
      roots: {
        data: { path: S.dataDir, class: 'persistent', envVar: 'VS_DATA_DIR' },
        studio: { path: S.studioDir, class: 'persistent', envVar: 'VS_STUDIO_DIR' },
        media: { path: S.mediaDir, class: 'persistent', envVar: 'VS_MEDIA_DIR' },
        logs: { path: S.logsDir, class: 'persistent', envVar: 'VS_LOGS_DIR' },
        cache: { path: S.cacheDir, class: 'cache', envVar: 'VS_CACHE_DIR' },
        tools: { path: S.toolsDir, class: 'runtime', envVar: 'VS_TOOLS_DIR' },
      },
      locations: [
        entry('Project records + artifact version graph', 'persistent', path.join(S.studioDir, 'projects'), 'project JSON + artifact JSON (parent links)', P),
        entry('Page agent config + isolated memory', 'persistent', path.join(S.studioDir, 'pages'), 'per-page config; memory/ alongside', P),
        entry('Conversations', 'persistent', path.join(S.studioDir, 'conversations'), 'one file per page agent', P),
        entry('Jobs', 'persistent', path.join(S.studioDir, 'jobs'), 'persisted queue; paused approvals survive restart', P),
        entry('Templates + asset vault', 'persistent', path.join(S.studioDir, 'templates'), 'editing recipes and reusable assets', P),
        entry('Provider/model settings, credentials', 'persistent', path.join(S.studioDir, 'settings.json'), 'secrets stay server-side', P),
        entry('Source + edited + rendered project media', 'persistent', S.mediaDir, 'source.mp4, trim_v*.mp4, text_v*.mp4, render_*.mp4, tts_*.wav, subs_*.ass, frame_*.png', P),
        entry('Activity stream + studio logs', 'persistent', S.logsDir, 'activity.jsonl, studio.jsonl', P),
        entry('TTS / music / transcription scratch', 'cache', S.cacheDir, 'tts_*.wav, mus_*.mp3, sub_*.srt — copied into the project on registration', C),
        entry('Legacy downloads (pre-studio pipeline)', 'cache', S.legacyMediaDir, 'vid_*.mp4, src_*.mp4 — old single-shot pipeline', C),
        entry('Legacy project/chats', 'persistent', S.legacyProjectsDir, 'previous UI layer', P),
        entry('ffmpeg + ffprobe binaries', 'runtime', S.toolsDir, 'needed to execute, not to preserve', R),
      ],
      volumesForContainer: ['VS_DATA_DIR', 'VS_MEDIA_DIR'],
    };
  };

  return S;
}

module.exports = { resolveStorage };
