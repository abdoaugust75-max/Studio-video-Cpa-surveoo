'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createProviders } = require('../lib/providers');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-model-routing-'));
  try {
    const providers = createProviders({ dir, keys: () => ['test-credential'] });
    providers.saveModel({ id: 'gemini-3.8-flash-tts', provider: 'google', capabilities: ['tts'], enabled: true, tier: 'tts' });
    providers.saveRouting({ tasks: { script: ['gemini-3.1-flash-lite'], tts: ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'] }, pinnedTasks: ['script', 'tts'] });
    providers.saveRouting({ policy: 'quality' });
    assert.deepStrictEqual(providers.pick('script').candidates, ['gemini-3.1-flash-lite']);
    assert.deepStrictEqual(providers.pick('tts').candidates, ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview']);
    const code = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g,'\n');
    const routes = code.slice(code.indexOf('function routeCandidates('), code.indexOf('/**\n * redact'));
    const transport = code.slice(code.indexOf('async function gemini('), code.indexOf('// gemVision'));
    const synthesis = code.slice(code.indexOf('async function makeTTSFile('), code.indexOf('async function makeScript('));
    let mode = 'high-demand'; const calls = [];
    const context = { profileFor:require('../lib/campaign-profiles').profileFor, Buffer, fs, path, CACHE: dir, providers, KEYS: ['test-credential'], CFG: { models: { tts: 'gemini-3.8-flash-tts' } },
      params_model: model => model, log() {}, redact: String, sleep: async () => {},
      isQuota: text => /429/.test(text), isMissing: text => /404/.test(text), isUnavailable: text => /503/.test(text),
      hash: text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24), AbortSignal,
      fetch: async (url, options) => {
        const model = new URL(url).pathname.split('/').pop().split(':')[0];
        const body = JSON.parse(options.body);
        const voice=body.generationConfig.speechConfig.voiceConfig;assert.strictEqual(voice.voice || voice.prebuiltVoiceConfig?.voiceName, 'Kore');
        calls.push(model);
        if (model === 'gemini-3.8-flash-tts' && mode === 'high-demand') return { json: async () => ({ error: { code: 503, message: 'high demand' } }) };
        if (model === 'gemini-3.8-flash-tts' && mode === 'missing-audio') return { json: async () => ({ candidates: [{ content: { parts: [{ text: 'no audio' }] } }] }) };
        return { json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(100).toString('base64') } }] } }] }) };
      },
    };
    vm.createContext(context);
    vm.runInContext(routes + '\n' + transport + '\n' + synthesis, context);
    await context.makeTTSFile('studio', 'دارجة تجربة الضغط', 'Puck', 1);
    assert.deepStrictEqual(calls.splice(0), ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'], 'high demand must directly fall back once');
    mode = 'missing-audio';
    await context.makeTTSFile('studio', 'دارجة تجربة جواب بلا صوت', 'Puck', 1);
    assert.deepStrictEqual(calls.splice(0), ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview']);
    mode = 'success';
    await context.makeTTSFile('studio', 'دارجة تجربة نجاح', 'Puck', 1);
    assert.deepStrictEqual(calls.splice(0), ['gemini-3.8-flash-tts'], 'healthy main model must not call fallback');
    console.log('Production model order, immediate TTS fallback, missing-audio fallback and Kore voice passed.');
  } finally {
    const resolved = path.resolve(dir);
    assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('studio-model-routing-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
