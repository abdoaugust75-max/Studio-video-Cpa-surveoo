'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSource, parseIntent, continuationQueries } = require('../lib/source');
const { createJobs } = require('../lib/jobs');

const query = 'clean smartphone unboxing no people no robot no text no slideshow';
const clean = { faces: false, person_or_body: false, robot_or_nonhuman: false, hands: true,
  text_overlay: false, large_overlay: false, watermark: false, physical_text: true,
  product_visible: true, product: 'smartphone', product_category: 'smartphone', brand: 'other',
  subject_match: 'category', subject_confidence: 0.9, is_real_footage: true, slideshow: false,
  unboxing: true, hook_score: 0.9, hook_reason: 'Visible box opening immediately', quality: 0.9,
  usability: 0.9, overlay_ranges: [], note: 'Real hands-only unboxing' };

async function fixture(fn) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-source-retry-'));
  let calls = 0, frameCalls = 0, visionCalls = 0;
  const probes = [];
  const candidate = id => ({ id, source: 'https://fixture.invalid/' + id, play: id,
    title: 'clean smartphone unboxing', duration: 24, plays: 100 });
  const source = createSource({ cacheDir, store: { isSourceUsed: () => false },
    legacy: { discoverTikTok: async term => { calls++; return fn.discover(term, calls, candidate); } },
    media: { probeStrict: async id => { probes.push(id); if (fn.probeFails) throw Error('probe failed');
      return { duration: 24, width: 1080, height: 1920, hasAudio: false }; },
      ff: async args => { frameCalls++; const time = Number(args[1]);
        if (fn.openingOnly && time >= 3) throw Error('stream frame failed');
        const id = args[3]; fs.writeFileSync(args[args.length - 1], Buffer.alloc(4096, id === 'good' ? 2 : 1)); } },
    llm: { vision: async (model, prompt, frames, mime, context) => {
      visionCalls++; if (fn.visionFails && fn.visionFails()) throw Error('temporary provider failure');
      assert(frames.length >= 6, 'unboxing must include more than just opening frames');
      assert(prompt.includes('21.6'), 'the late-video sample must be visible to the reviewer');
      context.__model = model;
      return JSON.stringify({ ...clean, text_overlay: frames[0][0] === 1, watermark: false, physical_text: true }); } },
  });
  try { await fn.run(source, () => ({ calls, frameCalls, visionCalls, probes })); }
  finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
}

(async () => {
  const intent = parseIntent(query);
  const phrases = [intent.expandedQueries, ...[1, 2, 3].map(round => continuationQueries(intent, round))].flat();
  assert.strictEqual(new Set(phrases).size, phrases.length, 'each continuation must use new discovery phrases');
  assert(continuationQueries(parseIntent('iPhone 16 Pro Max unboxing'), 1).every(q => q.startsWith('iphone 16 pro max')),
    'continuations must preserve an exact product request');
  await fixture({ discover: (term, calls, c) => calls <= 24 ? [c('bad')] : [c('bad'), c('good')],
    run: async (source, stats) => {
      const result = await source.search({ query });
      assert.strictEqual(result.search.rounds.length, 2, 'rejected first round must retry automatically');
      assert.strictEqual(result.search.status, 'found');
      assert.strictEqual(result.candidates.length, 1, 'only one approved candidate is returned');
      assert.strictEqual(result.candidates[0].id, 'good');
      assert(result.candidates[0].signals.modelsChecked >= 3, 'acceptance needs independent models');
      assert(stats().calls > 24 && stats().calls < 48,
        'a later round should stop at the first accepted candidate, without starting another round');
      assert.strictEqual(stats().probes.filter(id => id === 'bad').length, 1, 'rejected sources are not reprocessed');
    } });
  await fixture({ discover: (term, calls, c) => [c('bad')], run: async source => {
    const result = await source.search({ query });
    assert.strictEqual(result.search.rounds.length, 4);
    assert.strictEqual(result.search.examined, 1);
    assert.strictEqual(result.search.status, 'exhausted');
    assert.strictEqual(result.candidates.length, 0, 'exhaustion must not select a rejected video');
  } });
  await fixture({ probeFails: true, discover: (term, calls, c) => [c('good')], run: async source => {
    const result = await source.search({ query, searchRounds: 1 });
    assert.strictEqual(result.candidates.length, 1, 'metadata duration must permit full-clip sampling after a probe failure');
    assert.strictEqual(result.candidates[0].signals.frames, 12);
  } });
  await fixture({ openingOnly: true, discover: (term, calls, c) => [c('good')], run: async (source, stats) => {
    const result = await source.search({ query, searchRounds: 1 });
    assert.strictEqual(result.candidates.length, 0, 'only opening frames cannot verify a whole clip');
    assert.strictEqual(stats().visionCalls, 0, 'incomplete samples must not waste review calls');
  } });
  let fail = true;
  await fixture({ visionFails: () => fail, discover: (term, calls, c) => [c('good')], run: async source => {
    assert.strictEqual((await source.search({ query, searchRounds: 1 })).candidates.length, 0);
    fail = false;
    assert.strictEqual((await source.search({ query, searchRounds: 1 })).candidates.length, 1,
      'temporary model failures must not poison the persistent cache');
  } });
  await fixture({ discover: () => { throw Error('provider unavailable'); }, run: async source => {
    await assert.rejects(source.search({ query }), /Source discovery is unavailable/);
  } });
  await fixture({ discover: () => [], run: async (source, stats) => {
    await assert.rejects(source.search({ query, shouldStop: () => true }), /cancelled/);
    assert.strictEqual(stats().calls, 0, 'cancelled searches must not invoke providers');
  } });
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cancel-retry-'));
  let resume, began;
  const ready = new Promise(resolve => { began = resolve; });
  const jobs = createJobs({ dir: jobDir });
  jobs.register('cancel.fixture', async (job, ctx) => {
    began();
    await new Promise(resolve => { resume = resolve; });
    ctx.progress('late progress after cancellation', 70);
    ctx.note('late note after cancellation');
    assert.strictEqual(jobs.get(job.id).status, 'cancelled', 'late progress must not resurrect a cancelled search');
    throw Error('source search cancelled');
  });
  const job = jobs.enqueue({ type: 'cancel.fixture', params: {} });
  await ready;
  jobs.cancel(job.id);
  resume();
  for (let n = 0; n < 20 && jobs.get(job.id).stage !== 'cancelled'; n++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(jobs.get(job.id).status, 'cancelled', 'cooperative cancellation must not become a failed job');
  assert.strictEqual(jobs.get(job.id).stage, 'cancelled');
  fs.rmSync(jobDir, { recursive: true, force: true });
  console.log('Source continuation, rejection, coverage, cache recovery and cancellation checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
