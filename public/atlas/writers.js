(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const STORAGE = 'videostudio.writer-drafts.v1';
  let settings = null, drafts = {}, page = 'maghrebtechstore', shared = '', dirty = new Set(), sharedDirty = false;
  let timer, saving = null, loading = null;
  let recovery; try { recovery = JSON.parse(localStorage.getItem(STORAGE) || 'null'); } catch (_) {}
  const status = message => $('writer-save-status').textContent = message;
  async function api(url, body) {
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const result = await r.json(); if (!r.ok || result.error) throw Error(result.error || 'Settings request failed'); return result;
  }
  function backup() {
    try { if (dirty.size || sharedDirty) localStorage.setItem(STORAGE, JSON.stringify({ pages: Object.fromEntries([...dirty].map(key => [key,drafts[key]])), shared: sharedDirty ? shared : undefined })); else localStorage.removeItem(STORAGE); } catch (_) {}
  }
  function panel(name) {
    $('writer-settings-panel').hidden = name !== 'writer'; $('facebook-settings-panel').hidden = name !== 'facebook';
    if($('mylead-settings-panel'))$('mylead-settings-panel').hidden=true; if($('mylead-settings-tab'))$('mylead-settings-tab').classList.remove('active');
    if($('site-integrations-panel'))$('site-integrations-panel').hidden=true; if($('site-integrations-tab'))$('site-integrations-tab').classList.remove('active');
    $('writer-settings-tab').classList.toggle('active', name === 'writer'); $('facebook-settings-tab').classList.toggle('active', name === 'facebook'); $('settings-check').hidden = name !== 'facebook'; if($('video-settings-panel'))$('video-settings-panel').hidden=name!=='video'; if($('video-settings-tab'))$('video-settings-tab').classList.toggle('active',name==='video');
  }
  function select(key) {
    if (!settings) { page = key; return; }
    const selected = settings.pages.find(p => p.key === key); if (!selected) return;
    page = key; $('writer-page-select').value = key; $('page-writer-prompt').value = drafts[key] ?? '';
    $('writer-page-context').textContent = selected.language + ' · ' + selected.idea;
    document.querySelectorAll('[data-writer-page]').forEach(b => { b.classList.toggle('active', b.dataset.writerPage === key); b.setAttribute('aria-pressed', String(b.dataset.writerPage === key)); });
    $('writer-preview-details').hidden = true;
  }
  async function load() {
    if (settings) return settings; if (loading) return loading;
    loading = (async () => {
      try {
        settings = await api('/api/v2/writers/settings'); drafts = Object.fromEntries(settings.pages.map(p => [p.key,p.instructions || ''])); shared = settings.sharedInstructions || '';
        if (recovery) {
          for (const [key,value] of Object.entries(recovery.pages || {})) if (key in drafts && typeof value === 'string') { drafts[key] = value; dirty.add(key); }
          if (typeof recovery.shared === 'string') { shared = recovery.shared; sharedDirty = true; }
          recovery = null;
        }
        $('shared-writer-prompt').value = shared; $('writer-page-select').replaceChildren(); $('writer-page-buttons').replaceChildren();
        for (const p of settings.pages) {
          const option = document.createElement('option'); option.value = p.key; option.textContent = p.label; $('writer-page-select').append(option);
          const button = document.createElement('button'); button.type = 'button'; button.dataset.writerPage = p.key; button.textContent = p.label;
          button.onclick = () => select(p.key); $('writer-page-buttons').append(button);
        }
        select(page); $('page-writer-prompt').disabled = false; $('shared-writer-prompt').disabled = false;
        status(dirty.size || sharedDirty ? 'Recovered unsaved instructions · saving…' : 'Saved instructions loaded');
        if (dirty.size || sharedDirty) schedule();
        return settings;
      } catch (e) { status('Could not load: ' + e.message + '. Open Writer prompts to retry.'); throw e; }
      finally { loading = null; }
    })(); return loading;
  }
  function schedule() { backup(); clearTimeout(timer); status('Saving…'); timer = setTimeout(() => save().catch(() => {}), 700); }
  async function save() {
    clearTimeout(timer); await load();
    if (saving) { await saving; if (dirty.size || sharedDirty) return save(); return; }
    if (!dirty.size && !sharedDirty) { status('Saved · each page has its own instructions'); return; }
    const pageSnapshot = Object.fromEntries([...dirty].map(key => [key,drafts[key]]));
    const sharedSnapshot = sharedDirty ? shared : undefined;
    const input = {updatedAt: settings.updatedAt, pageInstructions: pageSnapshot}; if (sharedDirty) input.sharedInstructions = sharedSnapshot;
    status('Saving…');
    saving = (async () => {
      try {
        const result = await api('/api/v2/writers/settings', input); settings = result;
        for (const [key,value] of Object.entries(pageSnapshot)) if (drafts[key] === value) dirty.delete(key);
        if (sharedSnapshot !== undefined && shared === sharedSnapshot) sharedDirty = false;
        backup(); status(dirty.size || sharedDirty ? 'Saving latest changes…' : 'Saved automatically · instructions kept for each page');
        window.dispatchEvent(new Event('atlas:writers-saved'));
      } catch (e) { backup(); status('Not saved to studio: ' + e.message + ' Your draft is kept in this browser. Click Save now to retry.'); throw e; }
      finally { saving = null; }
    })(); await saving; if (dirty.size || sharedDirty) return save();
  }
  $('page-writer-prompt').disabled = true; $('shared-writer-prompt').disabled = true;
  $('writer-page-select').onchange = () => select($('writer-page-select').value);
  $('page-writer-prompt').oninput = () => { drafts[page] = $('page-writer-prompt').value; dirty.add(page); $('writer-preview-details').hidden = true; schedule(); };
  $('shared-writer-prompt').oninput = () => { shared = $('shared-writer-prompt').value; sharedDirty = true; $('writer-preview-details').hidden = true; schedule(); };
  $('page-writer-prompt').onblur = $('shared-writer-prompt').onblur = () => { if (dirty.size || sharedDirty) save().catch(() => {}); };
  $('writer-settings-form').onsubmit = e => { e.preventDefault(); save().catch(() => {}); };
  $('writer-settings-tab').onclick = () => { panel('writer'); load().catch(() => {}); };
  $('facebook-settings-tab').onclick = () => panel('facebook');
  window.addEventListener('atlas:settings-open', () => { panel('writer'); load().catch(() => {}); });
  window.addEventListener('atlas:facebook-open', () => panel('facebook'));
  window.addEventListener('atlas:video-open', () => panel('video'));
  window.addEventListener('pagehide', backup);
  $('preview-writer-brief').onclick = async () => {
    $('preview-writer-brief').disabled = true;
    try {
      await save(); const analysisId = $('writer-source-select').value; if (!analysisId) throw Error('Select a fully analysed source.');
      const result = await api('/api/v2/writers/preview?page=' + encodeURIComponent(page) + '&analysisId=' + encodeURIComponent(analysisId));
      $('writer-preview').textContent = result.prompt; $('writer-preview-details').hidden = false; $('writer-preview-details').open = true;
    } catch (e) { status(e.message); } finally { $('preview-writer-brief').disabled = false; }
  };
  panel('writer'); load().catch(() => {});
})();
