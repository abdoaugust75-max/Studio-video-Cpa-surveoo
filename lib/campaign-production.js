'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { PROFILES } = require('./campaign-profiles');
const { languageOk } = require('./page-writers');
const { composeWriterBrief, validSceneLinks,writerValidationIssues,sanitizeSceneLinks } = require('./writer-brief');
const { narrationWords } = require('./social-compositor');
const {scopedCommercialFacts,scriptPriceError}=require('./commercial-facts');

function unifiedNarration(base, referral, position = .5) {
  const boundaries = [...base.matchAll(/[.!؟?](?:\s|$)/g)].map(m => m.index + 1).filter(i => i > base.length * .2 && i < base.length * .8);
  const split = boundaries.sort((a,b) => Math.abs(a-base.length*position)-Math.abs(b-base.length*position))[0] || base.length;
  const text = (base.slice(0,split).trim() + ' ' + referral + ' ' + base.slice(split).trim()).trim();
  if (text.length > 1500) throw Error('Complete narration including the profile referral exceeds 1500 characters. Shorten the page instructions.');
  return text;
}

function createCampaignProduction({ dir, store, jobs, understanding, media, legacy, tts, transcribe, captions, publish, appearance, trackingLink = value => value }) {
  U.ensureDir(dir);
  let learningFor=()=>null;
  const writerSettingsFile = path.join(dir, '..', 'writer-settings.json');
  const writerSettings = () => ({ sharedInstructions: '', updatedAt: 0, ...U.readJson(writerSettingsFile, {}) });
  function settings() {
    return { ...writerSettings(), pages: catalog().map(p => ({ key: p.key, label: p.label, idea: p.idea, language: p.language, instructions: p.writerInstructions || '' })) };
  }
  function saveSettings(input) {
    const clean = (value, max) => {
      if (typeof value !== 'string' || value.length > max) throw Error('Writer instructions must be text within the displayed length limit.');
      return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    };
    const current = writerSettings();
    if (input.updatedAt != null && input.updatedAt !== current.updatedAt) throw Error('Writer settings changed in another session. Reload them before saving.');
    const sharedInstructions = input.sharedInstructions == null ? current.sharedInstructions : clean(input.sharedInstructions, 4000);
    const pageInstructions = input.pageInstructions || {};
    const updates = Object.entries(pageInstructions).map(([key, value]) => {
      if (!PROFILES.some(p => p.key === key) || !store.page(key)) throw Error('Unknown writer page.');
      return [key, clean(value, 6000)];
    });
    for (const [key, instructions] of updates) {
      const page = store.page(key);
      store.savePage(key, { campaign: { ...page.campaign, writerInstructions: instructions } });
    }
    U.writeJsonAtomic(writerSettingsFile, { sharedInstructions, updatedAt: Date.now() });
    return settings();
  }
  function preview({ page, analysisId }) {
    const profile = catalog().find(p => p.key === page), analysis = understanding.get(analysisId);
    if (!profile || !analysis?.coverage?.complete) throw Error('Choose a page and a fully analysed source.');
    const commercial=scopedCommercialFacts({analysis,presentation:appearance.get().pages[page],approvedFacts:legacy.knowledgeBlock?.(page)||''});
    return { page, analysisId, prompt: composeWriterBrief({ profile, analysis, sharedInstructions: writerSettings().sharedInstructions,
      pageInstructions: profile.writerInstructions, presentation: {...appearance.get().pages[page],prices:commercial.prices}, approvedFacts: commercial.text+'\n'+commercial.note }) };
  }
  const file = id => path.join(dir, String(id).replace(/[^a-zA-Z0-9_]/g, '') + '.json');
  const get = id => U.readJson(file(id), null);
  const pageFile = (runId, key) => path.join(dir, runId + '--' + key + '.json');
  const row = (runId, key) => U.readJson(pageFile(runId, key), null);
  const saveRow = value => { value.updatedAt = Date.now(); U.writeJsonAtomic(pageFile(value.runId, value.key), value); return value; };
  const usable = (id, project, kind) => {
    const art = id && store.artifact(id);
    return art && art.project === project && (!kind || art.kind === kind) && (kind === 'script' ? !!art.text : art.file && fs.existsSync(art.file) && fs.statSync(art.file).size > 512) ? art : null;
  };
  function catalog() {
    return PROFILES.map(profile => {
      const page = store.page(profile.key);
      const card = page?.production?.ctaAssets?.facebook;
      const clip = card ? path.join(path.dirname(card), 'facebook.MOV') : null;
      return { ...profile, label: page?.label || profile.key, configured: !!page,
        idea: page?.campaign?.idea || profile.idea, language: page?.campaign?.language || profile.language,
        audience: page?.campaign?.audience || profile.audience,
        writerInstructions: page?.campaign?.writerInstructions || '',
        learning:learningFor(profile.key),
        card: clip && fs.existsSync(path.join(legacy.root || process.cwd(), clip)) ? clip.replace(/\\/g, '/') : null,
        cardPreview: '/api/v2/campaign/card?page=' + profile.key,
        writer: legacy.providers.pickOne('script', { page: profile.key }), voice: 'Kore',
        ttsModels: legacy.providers.pick('tts', { page: profile.key }).candidates,
        connection: page?.campaign?.connection || null,
        connections: page?.campaign?.connections || [],
        destinations: page ? publish.destinations(profile.key) : [] };
    });
  }
  function inspect(id) {
    const run = get(id);
    if (!run || run.schema !== 1) return null;
    const pages = run.pages.map(key => row(run.id, key)).filter(Boolean);
    const count = status => pages.filter(p => p.status === status).length;
    const ready = pages.filter(p => !!p.videoId && ['ready','published','needs_connection','checking_connection','uploading','unknown_upload'].includes(p.status)).length;
    const pending = pages.some(p => !['ready', 'published', 'failed', 'needs_connection', 'cancelled', 'unknown_upload'].includes(p.status));
    return { ...run, profiles: pages, summary: { total: pages.length, assembled: ready, published: count('published'), failed: count('failed'), needsConnection: count('needs_connection'), cancelled: count('cancelled') },
      status: pending ? 'processing' : count('published') === pages.length ? 'published' : ready === pages.length && !count('failed') ? 'ready' : 'partial' };
  }
  function list() {
    return fs.readdirSync(dir).filter(name => /^CR[^-]+\.json$/.test(name)).map(name => get(name.slice(0, -5)))
      .filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map(run => inspect(run.id));
  }
  function configure() {
    for (const profile of PROFILES) {
      const page = store.page(profile.key);
      if (!page) continue;
      const campaign = { ...profile, ...(page.campaign || {}), voice: 'Kore', profileClip: 'facebook.MOV', writerTask: 'script' };
      if (JSON.stringify(campaign) !== JSON.stringify(page.campaign)) store.savePage(profile.key, { campaign });
    }
    return catalog();
  }
  function captionLines(transcription) {
    return transcription.segments.flatMap(segment => {
      const words = String(segment.text || '').trim().split(/\s+/).filter(Boolean);
      const lines = [];
      if (segment.words?.length >= Math.ceil(words.length * 0.9)) {
        for (let i = 0; i < segment.words.length; i += 4) {
          const group = segment.words.slice(i, i + 4);
          lines.push({ start: group[0].start, end: group.at(-1).end, text: captions.wrap(group.map(w => w.text).join(' '), 22, 2) });
        }
      } else {
        const groups = [];
        for (let i = 0; i < words.length; i += 4) groups.push(words.slice(i, i + 4).join(' '));
        const length = groups.reduce((sum, text) => sum + text.length, 0);
        let start = segment.start;
        groups.forEach((text, i) => { const end = i === groups.length - 1 ? segment.end : start + (segment.end - segment.start) * text.length / length;
          lines.push({ start, end, text: captions.wrap(text, 22, 2), derived: 'interpolated' }); start = end; });
      }
      return lines;
    });
  }
  async function assembleSocial({ run, profile, analysis, branch, script, voice, state, ctx, stage, settings }) {
    const videoSettings = settings || run.videoSettings || appearance.get();
    const style = videoSettings.common, pageStyle = videoSettings.pages[profile.key];
    // A single complete performance contains the profile referral. Never generate a second
    // tutorial voice or splice extra speech into an already-timed narration.
    const referral = String(pageStyle.tutorialText || '').trim();
    if (script.params?.narrationVersion !== 'single-profile-v3' || script.params?.profileReferral !== referral || (script.params?.referralPosition ?? .5) !== style.tutorialPosition) {
      const base = script.params?.baseNarration || script.text.replace(script.params?.profileReferral || referral || '\u0000', '').trim();
      const text = unifiedNarration(base, referral, style.tutorialPosition);
      script = store.addArtifact({ project: branch.id, kind: 'script', op: 'script', attach: false,
        text, label: profile.label + ' · unified narration', params: { ...script.params, supersedes: script.id, baseNarration: base, profileReferral: referral, referralPosition: style.tutorialPosition, narrationVersion: 'single-profile-v3' } });
      stage('generating_tts', { scriptId: script.id, script: text, ttsId: null, tutorialScript: null, tutorialAudioUrl: null });
    }
    if (!voice || voice.params?.scriptArtifactId !== script.id) {
      stage('generating_tts');
      const text = script.text;
      voice = (await tts({ page: profile.key, project: branch.id, text, voice: 'Kore', rate: 1, scriptId: script.id, profileKey: profile.key, isolated: true })).artifact;
      stage('transcribing', { ttsId: voice.id, audioUrl: voice.rel, ttsDuration: voice.probe.duration });
    }
    stage('transcribing');
    const { transcription } = await transcribe.run({ projectId: branch.id, artifactId: voice.id, language: profile.language, requireWordAlignment: true, vocabulary: script.text, progress: ctx.progress, note: ctx.note });
    let words = narrationWords(transcription), insertAt = null, insertDuration = 0;
    if (!words.length) throw Error('No timed narration returned.');
    stage('matching_duration', { transcriptionId: transcription.id });
    const compositionKeys = ['profileCardEnabled','tutorialEnabled','tutorialStart','tutorialExcerptSeconds','tutorialWidth','tutorialHeight','tutorialPosition'];
    const prior = state.presentationBaseId ? store.artifact(state.presentationBaseId) : (branch.artifacts || []).map(id => store.artifact(id)).filter(a => a?.op === 'append_cta').at(-1);
    const reuse = state.narrationVersion === 'single-profile-v3' && state.compositionVersion === 'full-referral-v2' && state.ttsId === voice.id && state.scriptId === script.id && prior?.file && fs.existsSync(prior.file)
      && Math.abs(prior.probe.duration - voice.probe.duration) < .12 && compositionKeys.every(k => (state.videoSettings?.common?.[k] ?? (k === 'profileCardEnabled' ? true : null)) === style[k]);
    let matched, originalPolicy, originalDuration;
    if (reuse) {
      store.rollback(branch.id, prior.id); matched = prior;
      originalPolicy = state.durationPolicy; originalDuration = state.sourceDuration;
      insertAt = state.tutorialAt; insertDuration = state.tutorialDuration || 0;
      ctx.note('Reusing the clean composition and aligned narration; only presentation is changing.');
    } else {
    store.rollback(branch.id, state.sourceId);
    matched = await media.applyOp(branch.id, 'voiceover', { text: script.text, voice: 'Kore', audioFile: voice.file, rate: 1, bed: 0 }, ctx);
    originalPolicy = matched.params.durationPolicy; originalDuration = matched.params.sourceDuration;
    if (style.tutorialEnabled) {
      const desired = voice.probe.duration * style.tutorialPosition;
      const clean = s => String(s).replace(/[\u064b-\u065f\u0640]/g,'').replace(/[^a-z0-9\u0600-\u06ff]/gi,'').toLowerCase();
      const target = clean(referral);
      let offset = 0;
      const spans = words.map(w => { const normalized = clean(w.text), begin = offset; offset += normalized.length; return { begin, end: offset, normalized, start: w.start }; });
      const index = target ? spans.map(w => w.normalized).join('').indexOf(target) : -1;
      // Align the silent visual to the referral in the ONE main performance.
      // Match the complete phrase, not a common first word such as English "The".
      insertAt = index >= 0 ? spans.find(w => w.begin <= index && w.end > index)?.start ?? desired : desired;
      stage('tutorial_insert');
      matched = await media.applyOp(branch.id, 'tutorial_insert', { at: insertAt, excerptStart: style.tutorialStart, excerptSeconds: style.tutorialExcerptSeconds, width: style.tutorialWidth, height: style.tutorialHeight }, ctx);
      insertDuration = matched.params.overlayDuration; insertAt = matched.params.overlayAt;
      stage('profile_card', { tutorialScript: null, tutorialAudioUrl: null, tutorialAt: insertAt, tutorialDuration: insertDuration, tutorialMode: 'silent_overlay' });
    } else stage('profile_card');
    const clipDuration = (await media.probe(path.join(legacy.root || process.cwd(), profile.card))).duration;
    if(style.profileCardEnabled!==false)await media.applyOp(branch.id, 'append_cta', { profile:profile.key, platform:'facebook', variant:'profile', ctaStartSec:Math.max(.5,matched.probe.duration-clipDuration) }, ctx);
    }
    const normalize=s=>String(s||'').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g,'');
    const evidence=normalize(JSON.stringify(analysis.timeline)+' '+analysis.source?.title);
    const matchingOffers=scopedCommercialFacts({analysis,presentation:pageStyle}).prices;
    const offer=matchingOffers.find(p=>p.key===state.offerKey)||(matchingOffers.length===1?matchingOffers[0]:null);
    stage('captions', { presentationBaseId: store.project(branch.id).current });
    const overlay = await media.applyOp(branch.id, 'social_style', { captions:JSON.stringify(style.karaoke ? words : words.reduce((lines,w,i)=>{if(i%4===0)lines.push({text:w.text,start:w.start,end:w.end});else{lines.at(-1).text+=' '+w.text;lines.at(-1).end=w.end;}return lines;},[])), appearance:JSON.stringify(style),title:pageStyle.titleText||state.title||script.params.title,price:offer?.price||'',cta:pageStyle.ctaText },ctx);
    stage('rendering');
    const video=await media.applyOp(branch.id,'render',{mode:'final',copyEncoded:true},ctx);
    if (Math.abs(video.probe.duration - voice.probe.duration) > .12) throw Error('Final video duration changed after transcription. Captions must remain on the narration timeline.');
    branch=store.project(branch.id);
    let baseCaption=state.caption||branch.caption||state.title||'';
    if(state.website&&baseCaption.endsWith('\n\n'+state.website))baseCaption=baseCaption.slice(0,-(state.website.length+2));
    if(pageStyle.website&&baseCaption.endsWith('\n\n'+pageStyle.website))baseCaption=baseCaption.slice(0,-(pageStyle.website.length+2));
    const deliveryWebsite=trackingLink(pageStyle.website,{page:profile.key,video:video.id});
    branch.caption=deliveryWebsite&&style.includeWebsiteInCaption&&!baseCaption.includes(deliveryWebsite)?baseCaption+'\n\n'+deliveryWebsite:baseCaption;
    branch.deliveryWebsite=style.includeWebsiteInCaption?deliveryWebsite:'';store.saveProject(branch);
    stage('ready',{videoId:video.id,videoUrl:video.rel,outputDuration:video.probe.duration,sourceDuration:originalDuration,durationPolicy:originalPolicy,caption:branch.caption,website:deliveryWebsite,displayPrice:offer?.price||null,overlayTitle:pageStyle.titleText||state.title||script.params.title,videoSettings,transcriptionId:transcription.id,transcribedText:transcription.text,captionTiming:transcription.timing,tutorialScript:null,tutorialAudioUrl:null,tutorialAt:insertAt,tutorialDuration:insertDuration,tutorialMode:style.tutorialEnabled?'silent_overlay':'none',narrationVersion:'single-profile-v3',compositionVersion:'full-referral-v2',socialStyle:true});
    return video;
  }
  async function execute(job, ctx) {
    const run = get(job.params.runId);
    const profile = catalog().find(p => p.key === job.params.page);
    const analysis = run && understanding.get(run.analysisId);
    if (!run || !profile || !analysis?.coverage?.complete || analysis.project !== run.sourceProject) throw Error('Valid profile and complete source evidence required');
    let state = row(run.id, profile.key);
    if (!state) throw Error('Profile job has no durable state');
    const guard = () => { if (jobs.get(job.id)?.status === 'cancelled') throw Error('Profile production cancelled'); };
    const stage = (status, patch = {}) => {
      guard(); const current = row(run.id, profile.key);
      const progress = ({ writing: 10, generating_tts: 25, transcribing: 40, matching_duration: 55, captions: 65, profile_card: 75, rendering: 85, ready: 100, checking_connection: 94, uploading: 98, published: 100 })[status] || 0;
      state = saveRow({ ...current, status, progress, error: null, events: [...(current.events || []), { stage: status, at: Date.now() }].slice(-24), ...patch });
      ctx.note(profile.label + ': ' + status); ctx.progress(profile.label + ' · ' + status, progress);
    };
    try {
      if (!profile.card) throw Error('Original Facebook profile clip is missing');
      let branch = state.project && store.project(state.project);
      if (!branch) {
        const sourceProject = store.project(run.sourceProject);
        branch = store.createProject(profile.key, 'Unboxing · ' + profile.label, { source: sourceProject.source, analysis: sourceProject.analysis,
          sourcePipelineProject: run.sourceProject, campaignRun: run.id, campaignIdea: profile.idea, role: 'branch' });
        const source = store.linkArtifact(branch.id, analysis.assetId, { op: 'source', kind: 'video', label: 'Shared source · ' + profile.label });
        branch = store.project(branch.id); branch.sourceArtifact = source.id; store.saveProject(branch);
        stage('writing', { project: branch.id, sourceId: source.id });
      }
      const commercial=scopedCommercialFacts({analysis,presentation:(run.videoSettings||appearance.get()).pages[profile.key],approvedFacts:legacy.knowledgeBlock?.(profile.key)||''});
      let script = usable(state.scriptId, branch.id, 'script');
      if(script && scriptPriceError([script.text,script.params?.title,script.params?.caption].join(' '),commercial)){stage('writing',{previousOutput:{scriptId:state.scriptId,ttsId:state.ttsId,videoId:state.videoId},scriptId:null,ttsId:null,videoId:null,videoUrl:null});script=null;}

      if (!script) {
        stage('writing');
        const ownerSnapshot = run.writerSettings || { ...writerSettings(), pages: Object.fromEntries(catalog().map(p => [p.key, p.writerInstructions])) };
        const prompt = composeWriterBrief({ profile:{...profile,learning:run.learningSnapshot?run.learningSnapshot[profile.key]:profile.learning}, analysis, sharedInstructions: ownerSnapshot.sharedInstructions,
          pageInstructions: ownerSnapshot.pages?.[profile.key] || '', presentation: {...(run.videoSettings || appearance.get()).pages[profile.key],prices:commercial.prices}, approvedFacts: commercial.text+'\n'+commercial.note,
          siblingHooks: inspect(run.id).profiles.filter(p => p.key !== profile.key && p.title).map(p => p.title) });
        let written;
        const writerSchema={type:'OBJECT',properties:{script_text:{type:'STRING'},title:{type:'STRING'},caption:{type:'STRING'},offer_key:{type:'STRING',nullable:true},scene_links:{type:'ARRAY',minItems:1,maxItems:4,items:{type:'OBJECT',properties:{scene_index:{type:'INTEGER'},line:{type:'STRING'},connection:{type:'STRING'}},required:['scene_index','line','connection']}}},required:['script_text','title','caption','scene_links']};
        const call = {page:profile.key,project:branch.id,jsonAnswer:true,jsonSchema:writerSchema,validateResponse:raw=>typeof U.extractJSON(raw)?.script_text==='string'};
        const dialectRule=profile.key==='vouchteck'?'English only, with no Arabic letters.':profile.key==='alshihna'?'Modern Standard Arabic, without Moroccan dialect markers واش باش دابا كاين غادي ديال.':'Everyday Moroccan Darija, not Modern Standard Arabic. Avoid these formal words: هذا هذه ذلك ليس فقط عند سوف.';
        let correction='',lastErrors=[];
        for(let attempt=0;attempt<3;attempt++){
          guard();const rawCandidate=U.extractJSON(await legacy.llm.text(profile.writer,prompt+'\nReturn only 2–4 scene links. Language acceptance: '+dialectRule+correction,'script',call));
          const cleaned=sanitizeSceneLinks(rawCandidate,analysis),parsed=cleaned.written;
          const text=String(parsed?.script_text||'').trim(),priceError=scriptPriceError([text,parsed?.title,parsed?.caption].join(' '),commercial);
          lastErrors=writerValidationIssues(parsed,analysis,{languageValid:languageOk(profile.key,text),priceError});
          if(!lastErrors.length){written=parsed;stage('writing',{writerValidation:{status:'passed',discardedUnverifiedSceneLinks:cleaned.discarded,correctedIssues:state.writerValidation?.issues||[]}});break;}
          stage('writing',{writerValidation:{attempt:attempt+1,issues:lastErrors,response:parsed}});
          correction='\nThe previous result failed validation. Fix ALL these specific issues: '+JSON.stringify(lastErrors)+'. '+dialectRule+' Keep title under 45 characters. Scene links must quote exact narration words and valid indices. Never borrow another product price; omit price/currency without verified current-product pricing. Return the complete corrected JSON object.';
        }
        if(!written)throw Error('Writer validation failed: '+lastErrors.join('; '));
        const profileReferral = String((run.videoSettings || appearance.get()).pages[profile.key].tutorialText || '').trim();
        const referralPosition = (run.videoSettings || appearance.get()).common.tutorialPosition;
        const baseNarration = written.script_text.replace(profileReferral || '\u0000', '').trim();
        written.script_text = unifiedNarration(baseNarration, profileReferral, referralPosition);
        script = store.addArtifact({ project: branch.id, kind: 'script', op: 'script', attach: false, text: written.script_text, label: profile.label + ' · script',
          params: { profileKey: profile.key, language: profile.language, idea: profile.idea, writerModel: call.__model || profile.writer, understandingId: analysis.id, narrationVersion: 'single-profile-v3', baseNarration, profileReferral, referralPosition, writerInstructions: { shared: ownerSnapshot.sharedInstructions, page: ownerSnapshot.pages?.[profile.key] || '' }, sceneLinks: written.scene_links, title: written.title, caption: written.caption } });
        branch = store.project(branch.id); branch.caption = U.sanitizeText(written.caption || written.title, 1500); store.saveProject(branch);
        stage('generating_tts', { scriptId: script.id, script: script.text, title: U.sanitizeText(written.title, 60), caption: branch.caption, sceneLinks: written.scene_links, offerKey: written.offer_key || null, tutorialScript: written.tutorial_text || null });
      }
      let voice = usable(state.ttsId, branch.id, 'audio');
      if (!voice) {
        stage('generating_tts');
        const result = await tts({ page: profile.key, project: branch.id, text: script.text, voice: 'Kore', rate: 1, scriptId: script.id, profileKey: profile.key, isolated: true });
        voice = result.artifact; guard(); stage('transcribing', { ttsId: voice.id, audioUrl: voice.rel, ttsDuration: voice.probe.duration });
      }
      let video = usable(state.videoId, branch.id, 'video');
      if (!video) {
        video = await assembleSocial({ run, profile, analysis, branch, script, voice, state, ctx, stage });
      }
      if (run.publish && run.confirm && state.status !== 'published') {
        await deliver({ profile, branch, video, state, stage, guard });
      } else if (state.status !== 'published') stage('ready');
      return { page: profile.key, project: branch.id, videoId: video.id, status: state.status };
    } catch (error) {
      const current = row(run.id, profile.key);
      saveRow({ ...current, status: jobs.get(job.id)?.status === 'cancelled' ? 'cancelled' : current.status === 'uploading' ? 'unknown_upload' : 'failed', error: current.error || U.sanitizeText(error.message, 250), failedStage: current.status });
      throw error;
    }
  }
  async function deliver({ profile, branch, video, state, stage, guard }) {
        const delivery = appearance.get();
        const website = trackingLink(delivery.pages[profile.key].website,{page:profile.key,video:video.id});
        const ownerCaption = store.project(branch.id);
        let deliveryCaption=String(ownerCaption.caption||'');
        const previousWebsite=ownerCaption.deliveryWebsite||state.website;
        if(previousWebsite&&deliveryCaption.endsWith('\n\n'+previousWebsite))deliveryCaption=deliveryCaption.slice(0,-(previousWebsite.length+2));
        if(website&&delivery.common.includeWebsiteInCaption&&!deliveryCaption.includes(website))deliveryCaption+='\n\n'+website;
        ownerCaption.caption=deliveryCaption;ownerCaption.deliveryWebsite=delivery.common.includeWebsiteInCaption?website:'';store.saveProject(ownerCaption);
        const destinations = profile.destinations.filter(d => d.enabled);
        if (!destinations.length) throw Error('No authorised destinations configured');
        guard(); store.rollback(branch.id, video.id); store.approve(branch.id, 'owner-campaign-publish-request', 'Owner requested publication for this page campaign');
        const outcomes = [];
        for (const destination of destinations) {
          const saved = store.project(branch.id);
          const previous = saved.publishPairs?.[video.id+'|'+destination.id] || (saved.publish || []).flatMap(b=>b.results || []).find(r=>r.ok && r.artifact===video.id && String(r.destination?.id)===String(destination.id));
          if (previous?.postId) { outcomes.push({ ...previous, destination, artifact:video.id, ok:true, reused:true }); continue; }
          guard(); stage('checking_connection', { destination });
          const connection = await publish.checkConnection(profile.key, destination.id);
          if (!connection.ok) { outcomes.push({ destination, ok: false, connection, error: connection.error || 'Destination not connected' }); continue; }
          const selection = { artifacts: [video.id], destinations: [destination.id] };
          const plan = publish.plan(selection);
          if (!plan.ok) { outcomes.push({ destination, ok: false, error: plan.error || plan.blockedSummary?.join('; ') }); continue; }
          stage('uploading', { destination, connection });
          const result = await publish.execute({ ...selection, token: plan.token, confirm: true });
          outcomes.push(...(result.results || [{ destination, ok: false, error: result.error }]));
        }
        const accepted = outcomes.filter(r => r.ok);
        const status = accepted.length === destinations.length ? 'published' : outcomes.some(r => r.unknown) ? 'unknown_upload' : 'needs_connection';
        stage(status, { deliveries: outcomes, postId: accepted[0]?.postId || null, postUrl: accepted[0]?.postId ? 'https://www.facebook.com/' + accepted[0].postId : null,
          publishResult: { results: outcomes, posted: accepted.length, failed: outcomes.length-accepted.length }, error: outcomes.filter(r => !r.ok).map(r => r.error).join('; ') || null });
        return { status, page: profile.key, deliveries: outcomes };
  }
  async function publishPage({ runId, page }) {
    const state = row(runId, page), profile = catalog().find(p => p.key === page);
    if (!state?.videoId || !profile) throw Error('An assembled campaign video is required');
    const branch = store.project(state.project), video = store.artifact(state.videoId);
    const stage = (status, patch = {}) => saveRow({ ...row(runId, page), status, ...patch });
    return deliver({ profile, branch, video, state, stage, guard: () => {} });
  }
  jobs.register('campaign.publish', job => {
    if(job.params.slotId) {
      const automation=U.readJson(path.join(dir,'..','automation-settings.json'),{});
      if(!automation.enabled || !automation.schedules?.[job.params.page]?.enabled) return {status:'missed',error:'Automatic publishing was disabled before this job started'};
      const slot=automation.schedules[job.params.page].slots[Number(job.params.slotId.split(':').at(-1))];
      if(job.params.scheduledTime && (slot?.time!==job.params.scheduledTime || slot?.zone!==job.params.scheduledZone)) return {status:'missed',error:'Schedule changed before this publication job started'};
    }
    if (job.params.expiresAt && Date.now() > job.params.expiresAt) return { status: 'missed', error: 'Posting window expired while waiting for a worker' };
    return publishPage(job.params);
  });
  jobs.register('campaign.page', execute);
  jobs.register('campaign.social', async (job, ctx) => {
    const run=get(job.params.runId),state=row(run.id,job.params.page),profile=catalog().find(p=>p.key===state.key),analysis=understanding.get(run.analysisId);
    const branch=store.project(state.project),script=store.artifact(state.scriptId),voice=store.artifact(state.ttsId);
    if(!branch||!script||state.postId)throw Error('An unpublished assembled page is required.');
    const stage=(status,patch={})=>{if(jobs.get(job.id).status==='cancelled')throw Error('Cancelled');const previous=row(run.id,state.key);saveRow({...previous,status,progress:status==='ready'?100:80,error:null,...patch,events:[...(previous.events||[]),{stage:status,at:Date.now()}]});ctx.progress(profile.label+' · '+status,status==='ready'?100:80);};
    try{return await assembleSocial({run,profile,analysis,branch,script,voice,state,ctx,stage,settings:job.params.settings});}
    catch(e){saveRow({...row(run.id,state.key),status:jobs.get(job.id)?.status==='cancelled'?'cancelled':'failed',error:U.sanitizeText(e.message,250)});throw e;}
  });
  function applyStyle({runId,pages}){const run=inspect(runId);if(!run)throw Error('Unknown campaign.');if(run.status==='processing')throw Error('This campaign is already processing. Wait for the current render before applying another style.');const settings=appearance.get();const selected=run.profiles.filter(p=>p.videoId&&!p.postId&&['ready','failed'].includes(p.status)&&(!pages?.length||pages.includes(p.key)));for(const p of selected){const job=jobs.enqueue({type:'campaign.social',page:p.key,project:run.sourceProject,params:{runId,page:p.key,settings}});saveRow({...p,status:'queued',jobId:job.id,error:null});}return {ok:true,pages:selected.map(p=>p.key)};}

  jobs.register('campaign.presentation', async (job, ctx) => {
    const state = row(job.params.runId, job.params.page);
    const branch = state && store.project(state.project);
    if (!branch || !state.videoId || state.postId) throw Error('Choose an assembled, unpublished page video.');
    const input = (branch.artifacts || []).map(id => store.artifact(id)).filter(a => a?.kind === 'video' && a.op === 'append_cta').at(-1);
    if (!input?.file || !fs.existsSync(input.file)) throw Error('Un-titled assembly is unavailable.');
    const previousHead = branch.current;
    try {
      saveRow({ ...state, status: 'rendering', progress: 85, events: [...state.events, { stage: 'enlarging_title', at: Date.now() }] });
      store.rollback(branch.id, input.id);
      const video = await media.applyOp(branch.id, 'render', { mode: 'final', title: JSON.stringify({ text: state.title, at: 0, duration: 3 }),
        titleStyle: JSON.stringify({ position: 'center', singleLine: true, size: 80, widthFraction: 0.90, color: '#000000', background: '#ffffff', backgroundOpacity: 1, outline: 6, outlineColor: '#ffffff', shadow: 0 }) }, ctx);
      if (!video.params.burnedTitle) throw Error('Title did not render.');
      saveRow({ ...row(state.runId, state.key), status: 'ready', progress: 100, videoId: video.id, videoUrl: video.rel, outputDuration: video.probe.duration,
        titlePresentation: 'center-white-black-90pct-v2', events: [...row(state.runId, state.key).events, { stage: 'ready', at: Date.now() }] });
      return { videoId: video.id, page: state.key };
    } catch (e) {
      if (previousHead) store.rollback(branch.id, previousHead);
      saveRow({ ...row(state.runId, state.key), status: 'ready', progress: 100, presentationError: U.sanitizeText(e.message, 250) });
      throw e;
    }
  });
  function enlargeTitles({ runId }) {
    const run = inspect(runId);
    if (!run) throw Error('Unknown campaign run.');
    const selected = run.profiles.filter(p => p.status === 'ready' && p.videoId && !p.postId && p.titlePresentation !== 'center-white-black-90pct-v2');
    for (const page of selected) {
      if (jobs.list({ project: run.sourceProject }).some(j => j.type === 'campaign.presentation' && j.params.page === page.key && j.params.runId === run.id && ['queued', 'running'].includes(j.status))) continue;
      const job = jobs.enqueue({ type: 'campaign.presentation', page: page.key, project: run.sourceProject, params: { runId, page: page.key } });
      saveRow({ ...page, status: 'queued', progress: 0, jobId: job.id });
    }
    return { ok: true, queued: selected.map(p => p.key) };
  }
  function start({ analysisId, pages, publish: doPublish = false, confirm = false }) {
    const analysis = understanding.get(analysisId);
    if (!analysis?.coverage?.complete || analysis.status !== 'completed') throw Error('Select a completely reviewed source');
    if (doPublish && !confirm) throw Error('Explicit publication confirmation required');
    const keys = [...new Set(pages?.length ? pages : PROFILES.map(p => p.key))];
    if (keys.some(key => !PROFILES.some(p => p.key === key))) throw Error('Unknown page profile');
    const pending = list().find(run => run.analysisId === analysisId && run.status === 'processing');
    if (pending) return { ok: true, coalesced: true, runId: pending.id };
    const run = { id: U.uid('CR'), schema: 1, analysisId, sourceProject: analysis.project, pages: keys, publish: !!doPublish, confirm: !!confirm, videoSettings: appearance.get(),learningSnapshot:Object.fromEntries(catalog().map(p=>[p.key,p.learning])), writerSettings: { ...writerSettings(), pages: Object.fromEntries(catalog().map(p => [p.key, p.writerInstructions])) }, createdAt: Date.now() };
    U.writeJsonAtomic(file(run.id), run);
    for (const key of keys) {
      const profile = catalog().find(p => p.key === key);
      saveRow({ runId: run.id, key, label: profile.label, idea: profile.idea, language: profile.language, card: profile.card, status: 'queued', createdAt: Date.now() });
      const job = jobs.enqueue({ type: 'campaign.page', page: key, project: analysis.project, params: { runId: run.id, page: key } });
      saveRow({ ...row(run.id, key), jobId: job.id });
    }
    return { ok: true, runId: run.id, pages: keys, publishingRequested: !!doPublish };
  }
  function retry({ runId, pages, confirm }) {
    const run = inspect(runId);
    if (!run) throw Error('Unknown campaign run');
    
    const selected = run.profiles.filter(p => (!pages?.length || pages.includes(p.key)) && (['failed', 'needs_connection', 'cancelled'].includes(p.status)||p.status==='ready'&&p.scriptId&&(()=>{const analysis=understanding.get(run.analysisId),script=store.artifact(p.scriptId),commercial=scopedCommercialFacts({analysis,presentation:(run.videoSettings||appearance.get()).pages[p.key],approvedFacts:legacy.knowledgeBlock?.(p.key)||''});return !!scriptPriceError([script?.text,script?.params?.title,script?.params?.caption].join(' '),commercial);})()));
    if(run.publish&&!confirm&&selected.some(p=>jobs.get(p.jobId)?.type!=='campaign.social'))throw Error('Publication retry requires explicit confirmation');
    for (const p of selected) {
      const previous = jobs.get(p.jobId);
      if (previous && ['queued', 'running'].includes(previous.status)) continue;
      const job = jobs.enqueue({ type: previous?.type==='campaign.social'?'campaign.social':'campaign.page', page: p.key, project: run.sourceProject, params: { runId, page: p.key, ...(previous?.type==='campaign.social'?{settings:previous.params.settings||appearance.get()}: {}) } });
      saveRow({ ...p, status: 'queued', jobId: job.id, error: null });
    }
    return { ok: true, runId, retried: selected.map(p => p.key) };
  }
  async function checkConnections() {
    const result = [];
    for (const profile of catalog()) {
      const connections = await Promise.all(profile.destinations.filter(d => d.enabled).map(async d => ({ destinationId: d.id, ...await publish.checkConnection(profile.key, d.id) })));
      const page = store.page(profile.key);
      if (page) store.savePage(profile.key, { campaign: { ...page.campaign, connections, connection: { ok: connections.length > 0 && connections.every(c => c.ok), checkedAt: Date.now(), error: connections.filter(c => !c.ok).map(c => c.error).join('; ') || null } } });
      result.push(...connections.map(c => ({ page: profile.key, ...c })));
    }
    return result;
  }
  return {setLearningProvider:fn=>{learningFor=fn;}, publishPage, catalog, configure, start, inspect, list, retry, checkConnections, settings, saveSettings, preview, enlargeTitles, applyStyle };
}
module.exports = { createCampaignProduction };
