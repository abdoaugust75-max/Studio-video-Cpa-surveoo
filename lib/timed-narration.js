'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

function createTimedNarration({ store, media, legacy, tts, transcribe }) {
  return async function produce({ project, analysis, ctx, guard }) {
    if (!analysis.coverage?.complete || !analysis.timeline?.length) throw Error('Complete visual evidence is required');
    const p = store.project(project), duration = Number(analysis.duration);
    const stage = name => { guard(); const current = store.project(project); current.status = name; store.saveProject(current); ctx.note(name); ctx.progress(name, 50); };
    const model = legacy.providers.pickOne('script', { page: p.page });
    const ctaStart = Math.max(3, duration - 8);
    const slots = [];
    for (let start = 0; start < ctaStart; start += 8) {
      const end = Math.min(start + 8, ctaStart);
      if (end - start < 2 && slots.length) { slots[slots.length - 1].end = end; continue; }
      slots.push({ start, end, kind: start === 0 ? 'hook_and_visible_action' : 'visible_action' });
    }
    slots.push({ start: ctaStart, end: duration, kind: 'marketing_cta' });
    for (const slot of slots) {
      slot.maxWords = Math.max(3, Math.floor((slot.end - slot.start) * 1.25));
      slot.evidence = analysis.timeline.filter(e => e.end > slot.start && e.start < slot.end)
        .map((e, index) => ({ index, start: e.start, end: e.end, description: e.description, uncertainty: e.uncertainty }));
      if (slot.kind === 'visible_action') {
        // Prefer an action beginning inside the window with room for natural speech.
        // A late action must not force clipped speech or an early description of the future.
        const chosen = slot.evidence.find(e => e.start >= slot.start && e.start <= slot.end - 2.5) || slot.evidence[0];
        if (!chosen) throw Error('A visual window has no observed action');
        slot.evidence = [{ ...chosen, index: 0 }];
      }
    }
    stage('planning_timed_narration');
    const prompt = `You write natural Moroccan Darija in Arabic script. Return JSON only: {"title":"curiosity hook, short 3-6 word TikTok opening title","scenes":[{"text":"spoken Darija","evidenceIndex":0}]}. Exactly ${slots.length} scenes, matching slots in order. Respect each slot maxWords. For every visual action choose ONE evidenceIndex within that slot, and describe ONLY that specific action. Speech will start at that action's observed start, NOT automatically at the slot boundary. Prefer an action with enough time remaining before slot end; very late actions need just 2-3 words. Never describe a future event before it occurs. First slot: curious hook grounded in this actual unboxing. Last slot is explicitly our marketing addition: invite viewers to the website link to check Surveoo survey eligibility and conditions, distinct from the phone review. Never claim a free phone, guaranteed reward, money, availability or invented phone specs. No directions or timestamps in spoken text. Evidence timestamps are estimates. Slots: ${JSON.stringify(slots)}`;
    const plan = U.extractJSON(await legacy.llm.text(model, prompt, 'script', { page: p.page, project }));
    if (!plan || !Array.isArray(plan.scenes) || plan.scenes.length !== slots.length) throw Error('Writer did not return the complete timed scene plan');
    const title = U.sanitizeText(plan.title, 100);
    if (!title) throw Error('Writer did not provide an opening title');
    const scenes = plan.scenes.map((scene, i) => {
      const slot = slots[i];
      const evidence = slot.evidence[Number(scene.evidenceIndex)];
      if (slot.kind === 'visible_action' && !evidence) throw Error(`Scene ${i + 1} does not identify its observed action`);
      const start = slot.kind === 'visible_action' ? Math.max(slot.start, evidence.start) : slot.start;
      if (slot.end - start < 0.7) throw Error(`Scene ${i + 1} selected an action too late for narration`);
      return { ...slot, start, evidenceIndex: scene.evidenceIndex, text: slot.kind === 'marketing_cta'
        ? 'دخل للرابط فالبايو وشوف شروط الاستبيانات ديال Surveoo.' : U.sanitizeText(scene.text, 600) };
    });
    if (scenes.some(s => !s.text)) throw Error('A narration scene is empty');
    const script = store.addArtifact({ project, kind: 'script', op: 'script', attach: false, parent: analysis.assetId,
      text: scenes.map(s => s.text).join(' '), label: 'Timed Darija narration plan',
      params: { writerModel: model, language: 'darija', understandingId: analysis.id, title, scenes, timingPrecision: 'visual-model-estimates' } });
    const voices = [], lines = [], transcripts = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i], budget = scene.end - scene.start;
      stage(`generating_tts_scene_${i + 1}_of_${scenes.length}`);
      let voice;
      for (let attempt = 0; attempt < 3; attempt++) {
        guard();
        voice = await tts({ page: p.page, project, text: scene.text, voice: 'Kore', rate: 1, scriptId: script.id });
        if (voice.artifact.probe.duration <= budget - 0.1) break;
        if (attempt === 2) throw Error(`Narration scene ${i + 1} cannot fit its visual window`);
        scene.text = U.sanitizeText(await legacy.llm.text(model,
          `Shorten this Moroccan Darija sentence to at most ${Math.max(2, Math.floor(scene.text.split(/\s+/).length * 0.65))} words. Keep its meaning and only its evidenced action, no new claims. Return spoken Arabic-script Darija ONLY: ${scene.text}`, 'script', { page: p.page, project }), 600);
        if (!scene.text) throw Error('Shortened narration is empty');
      }
      scene.audioId = voice.artifact.id; scene.speechDuration = voice.artifact.probe.duration;
      voices.push(voice.artifact);
      stage(`transcribing_tts_scene_${i + 1}_of_${scenes.length}`);
      const { transcription } = await transcribe.run({ projectId: project, artifactId: voice.artifact.id, language: 'Moroccan Darija', progress: ctx.progress, note: ctx.note });
      guard(); transcripts.push(transcription.id);
      const words = transcription.segments.flatMap(s => s.words || []);
      if (!words.length || transcription.segments.some(s => !s.words?.length)) throw Error(`Scene ${i + 1} has no complete word timestamps; karaoke cannot be honestly rendered`);
      for (let offset = 0; offset < words.length; offset += 3) {
        const group = words.slice(offset, offset + 3);
        for (let activeWord = 0; activeWord < group.length; activeWord++) {
          lines.push({ start: scene.start + group[activeWord].start, end: scene.start + group[activeWord].end,
            text: group.map(w => w.text).join(' '), style: { activeWord, phraseWords: group.map(w => w.text) },
            // Keep the phrase's word evidence for highlighting; only the active word's timing
            // belongs inside this short caption event.
            wordTimings: [{ text: group[activeWord].text, start: scene.start + group[activeWord].start, end: scene.start + group[activeWord].end }],
            phraseWords: group.map(w => w.text) });
        }
      }
    }
    script.text = scenes.map(s => s.text).join(' '); script.params.scenes = scenes; store.saveArtifact(script);
    stage('aligning_speech_to_visual_windows');
    const audioFile = media.nextFile(project, 'timed_kore').replace(/\.mp4$/, '.wav');
    const inputs = voices.flatMap(v => ['-i', v.file]);
    const filters = scenes.map((s, i) => `[${i}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=${Math.round(s.start * 1000)}:all=1[a${i}]`);
    filters.push(scenes.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${voices.length}:duration=longest:normalize=0,apad,atrim=duration=${duration}[a]`);
    await media.ff([...inputs, '-filter_complex', filters.join(';'), '-map', '[a]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', audioFile]);
    guard();
    const audio = store.addArtifact({ project, kind: 'audio', op: 'tts', file: audioFile, attach: false, parent: script.id,
      probe: await media.probe(audioFile), label: 'Kore · aligned narration', params: { voice: 'Kore', scriptArtifactId: script.id, scenes, transcripts } });
    const timingPlan = path.join(store.projectDir(project), `narration-plan-${audio.id}.json`);
    fs.writeFileSync(timingPlan, JSON.stringify({ title, duration, scenes, transcripts, captions: lines, wordTimingPrecision: 'model_estimated' }, null, 2));
    stage('assembling_timed_video');
    store.rollback(project, analysis.assetId);
    await media.applyOp(project, 'voiceover', { text: script.text, voice: 'Kore', rate: 1, bed: 0, audioFile, preserveDuration: true }, ctx);
    stage('burning_karaoke_subtitles');
    const style = { ...media.CAPTION_PRESETS.karaoke, size: 76, highlight: '#ffe04b', color: '#ffffff', outline: 5, shadow: 2, y: 74, safeMarginX: 105, maxCharsPerLine: 18, maxLines: 2 };
    await media.applyOp(project, 'burn_subs', { lines: JSON.stringify(lines), style: JSON.stringify(style) }, ctx);
    stage('rendering_opening_title');
    const final = await media.applyOp(project, 'render', { mode: 'final', title: JSON.stringify({ text: title, start: 0, duration: 3 }),
      titleStyle: JSON.stringify({ position: 'top', y: 12, size: 62, background: '#121212' }) }, ctx);
    guard();
    if (final.params.burnedTitle !== title) throw Error('Opening title was not burned successfully');
    const production = { scriptId: script.id, ttsId: audio.id, videoId: final.id, url: final.rel, title, karaoke: true,
      timingPlan: path.basename(timingPlan), wordTimingPrecision: 'model_estimated', music: 'awaiting_owner_tracks', published: false };
    const current = store.project(project); current.productionResult = production; current.productionError = null; current.status = 'assembled'; store.saveProject(current);
    return production;
  };
}
module.exports = { createTimedNarration };
