// lib/quality.js — deterministic delivery checks for rendered media artifacts.
// Original VideoStudio code, informed by OpenMontage's useful create/verify separation.
'use strict';

function createQuality() {
  function inspectArtifact(artifact, context) {
    const p = artifact && artifact.probe || {};
    const issues = [];
    const warnings = [];
    if (!artifact || !artifact.file) issues.push('missing media file');
    if (artifact && artifact.kind === 'video') {
      if (!(p.duration > 0)) issues.push('duration is missing or zero');
      if (!(p.width > 0 && p.height > 0)) issues.push('video dimensions are missing');
      if (p.width && p.height && Math.min(p.width, p.height) < 480) warnings.push('short side is below 480px');
    }
    const safe = context && context.captionSafeArea;
    if (safe && safe.ok === false) issues.push('caption safe-area check failed');
    return {
      version: 1,
      status: issues.length ? 'failed' : (warnings.length ? 'warning' : 'passed'),
      checks: {
        playableMetadata: !!(p.duration > 0),
        dimensions: p.width && p.height ? { width: p.width, height: p.height } : null,
        audio: p.hasAudio !== false,
        captionSafeArea: safe || null,
      },
      issues, warnings, checkedAt: Date.now(),
    };
  }
  return { inspectArtifact };
}

module.exports = { createQuality };
