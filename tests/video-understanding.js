'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVideoUnderstanding, validateChunk, buildTimeline } = require('../lib/video-understanding');

async function runFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-understanding-'));
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, 'test source');
  const durations = new Map([[source, 27]]), calls = [];
  const media = {
    probeStrict: async file => ({ duration: durations.get(file), width: 1080, height: 1920, fps: 30 }),
    ff: async args => { const destination = args[args.length - 1];
      const scale = Number(args[args.indexOf('-vf') + 1].match(/setpts=([\d.]+)/)[1]);
      assert(args.indexOf('-t') < args.indexOf('-i'), 'Trim input before stretching playback');
      assert.strictEqual(args[args.indexOf('-r') + 1], '24');
      durations.set(destination, Number(args[args.indexOf('-t') + 1]) * scale); fs.writeFileSync(destination, 'native clip'); },
  };
  const llm = { video: async (model, prompt, buffer, mime, context) => {
    if (context.task.endsWith('narration')) {
      assert(prompt.includes('Other observers\' hypotheses in LOCAL PLAYBACK seconds'));
      assert(prompt.includes('CANONICAL narration timeline'));
    }
    calls.push({ model, context: { ...context }, mime, bytes: buffer.length });
    if (options.failAt === calls.length) throw new Error('provider outage');
    context.__model = options.fallback ? 'gemini-2.5-flash' : model;
    const duration = context.playbackDuration;
    return { reviewedInterval: { start: 0, end: options.incomplete ? 1 : duration }, summary: 'visible box',
      events: [{ start: 0, end: duration, description: 'A hand lifts the phone from its box', objects: ['hand', 'phone', 'box'],
        confidence: 0.8, narrationCue: context.task.endsWith('narration') ? 'The phone comes out of the box.' : '', avoidClaims: ['battery capacity'] }] };
  } };
  const service = createVideoUnderstanding({ dir: path.join(dir, 'records'), media, llm });
  service.save({ id: 'VU_fixture', status: 'queued', jobId: 'job1', ts: 123, source: { url: 'https://fixture.invalid/video' } });
  const progress = [];
  let result, error;
  try { result = await service.analyze({ id: 'VU_fixture', asset: { id: 'asset1', file: source }, project: 'project1' }, {
    progress: (stage, percent) => { assert.strictEqual(typeof stage, 'string'); assert.strictEqual(typeof percent, 'number'); progress.push(percent); },
    shouldStop: () => options.cancelAt && calls.length >= options.cancelAt }); }
  catch (err) { error = err; }
  const stored = service.get('VU_fixture');
  assert.strictEqual(service.list()[0].id, 'VU_fixture');
  let reconciled = null;
  if (options.reconcile && result) {
    const before = calls.length;
    reconciled = await service.reconcile({ id: 'VU_fixture' });
    assert.strictEqual(calls.length - before, 3, 'only the narration role re-inspects the three chunks');
    assert(calls.slice(before).every(call => call.context.task.endsWith('narration')));
    assert.deepStrictEqual(reconciled.roles[0].observations, result.roles[0].observations);
    assert.deepStrictEqual(reconciled.roles[1].observations, result.roles[1].observations);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, error, stored, calls, progress, reconciled };
}

(async () => {
  const success = await runFixture();
  assert.ifError(success.error);
  assert.strictEqual(success.calls.length, 9, 'all three roles inspect all three chunks');
  assert(success.calls.every(call => call.context.fps === 24 && call.mime === 'video/mp4' && call.bytes > 0));
  assert.strictEqual(success.result.coverage.playbackTimeScale, 1.25);
  assert.deepStrictEqual(success.result.coverage.chunks.map(chunk => chunk.playbackDuration), [15, 15, 3.75]);
  assert.strictEqual(success.result.duration, 27);
  assert.strictEqual(success.result.coverage.allOriginalFramesRequested, true);
  assert.strictEqual(success.result.coverage.requestedFrames, 810);
  assert.deepStrictEqual(success.result.timeline.map(scene => [scene.start, scene.end]), [[0, 12], [12, 24], [24, 27]]);
  assert(success.result.roles.every(role => role.coverage.length === 3));
  assert.strictEqual(success.result.narrationBrief.independence, true);
  assert.strictEqual(success.result.source.url, 'https://fixture.invalid/video');
  assert.strictEqual(success.result.status, 'completed');
  assert.strictEqual(success.result.jobId, 'job1');
  assert.strictEqual(success.result.ts, 123);
  assert.strictEqual(success.result.assetId, 'asset1');
  assert(success.result.roles.every(role => role.progress === 100 && role.model));
  assert.strictEqual(success.progress[success.progress.length - 1], 100);
  const partial = await runFixture({ failAt: 5 });
  assert(partial.error);
  assert.strictEqual(partial.stored.status, 'failed');
  assert.strictEqual(partial.stored.coverage.complete, false);
  assert.strictEqual(partial.stored.narrationBrief, null);
  const incomplete = await runFixture({ incomplete: true });
  assert(incomplete.error && /entire submitted chunk/.test(incomplete.error.message));
  assert.strictEqual(incomplete.calls.length, 1);
  const cancelled = await runFixture({ cancelAt: 2 });
  assert.strictEqual(cancelled.stored.status, 'cancelled');
  assert.strictEqual(cancelled.calls.length, 2);
  const shared = await runFixture({ fallback: true });
  assert.strictEqual(shared.result.narrationBrief.independentModels, 1);
  assert.strictEqual(shared.result.narrationBrief.independence, false);
  const reconciled = await runFixture({ reconcile: true });
  assert.strictEqual(reconciled.reconciled.status, 'completed');
  assert.strictEqual(reconciled.reconciled.narrationPolicyVersion, 'canonical-verified-narration-v2');
  assert(reconciled.reconciled.timeline.every(scene => scene.canonicalRole === 'narration'));
  const observation = (start, end, description, narrationCue = '') => ({ start, end, description, narrationCue, chunk: 0, confidence: 0.8, model: 'fixture', objects: [], visibleText: [] });
  const aligned = buildTimeline({ roles: [
    { id: 'actions', observations: [observation(0, 12, 'Opens box then takes phone out')] },
    { id: 'details', observations: [observation(0, 12, 'Box and wrapped phone')] },
    { id: 'narration', coverage: [{ chunk: 0 }], observations: [observation(0, 4, 'Cuts seal', 'The seal is cut.'), observation(4, 8, 'Lifts lid', 'The lid comes off.'), observation(8, 12, 'Removes phone', 'The phone comes out.')] },
  ] });
  assert.deepStrictEqual(aligned.map(scene => scene.narrationCue), ['The seal is cut.', 'The lid comes off.', 'The phone comes out.']);
  assert.deepStrictEqual(aligned.map(scene => scene.description), ['Cuts seal', 'Lifts lid', 'Removes phone']);
  assert(aligned.every(scene => scene.evidence.length === 3), 'one best aligned observation per role');
  assert.throws(() => validateChunk({ reviewedInterval: { start: 0, end: 12 }, events: [{ start: 11, end: 14, description: 'outside clip' }] }, 12), /timing/);
  assert.throws(() => validateChunk({ reviewedInterval: { start: 0, end: 12 }, events: [{ start: 0, end: 2, description: 'opening only' }] }, 12), /end of the chunk/);
  assert.throws(() => validateChunk({ reviewedInterval: { start: 0, end: 12 }, events: [{ start: 0, end: 2, description: 'first' }, { start: 8, end: 12, description: 'last' }] }, 12), /unreviewed interval/);
  console.log('Whole-video understanding: source cadence, all-role coverage, timestamps, persistence, provider failure, cancellation and fallback identity passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
