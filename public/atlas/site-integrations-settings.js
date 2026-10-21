(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const settingsTabs = document.querySelector('.settings-tabs');
  const mylead = $('mylead-settings-panel');
  if (!settingsTabs || !mylead) return;
  const tab = document.createElement('button'); tab.id = 'site-integrations-tab'; tab.type = 'button'; tab.textContent = 'Websites'; settingsTabs.append(tab);
  const panel = document.createElement('section'); panel.id = 'site-integrations-panel'; panel.className = 'writer-settings-panel'; panel.hidden = true;
  panel.innerHTML = `<div class="writer-settings-intro"><div><h2>Websites · Source → Preview → Cloudflare</h2><p>One private Studio repository keeps each landing page under its own <code>sites/&lt;id&gt;</code> folder. Cloudflare stays Direct Upload, so the Studio publishes its files there through Pages.</p></div><span class="badge">Websites only · no social posts</span></div>
    <div class="writer-settings-grid"><div>
      <form id="site-gh-form"><h3>GitHub</h3><p id="site-gh-state" role="status">Not connected</p><label for="site-gh-token">Fine-grained personal access token</label><input id="site-gh-token" type="password" autocomplete="off" maxlength="500" placeholder="Enter here; never paste into chat"><small>Required: Repository access to the private Studio repository; Metadata: read; Contents: read and write. This is what lets the Studio save and retrieve each website's source.</small><button class="primary" type="submit">Save GitHub token</button> <button class="soft-button" type="button" id="site-gh-verify">Verify & list repositories</button></form>
      <hr><form id="site-cf-form"><h3>Cloudflare Pages</h3><p id="site-cf-state" role="status">Not connected</p><label for="site-cf-token">Cloudflare API token</label><input id="site-cf-token" type="password" autocomplete="off" maxlength="500" placeholder="Enter here; never paste into chat"><label for="site-cf-account">Account ID</label><input id="site-cf-account" autocomplete="off" maxlength="32" placeholder="32-character account ID"><small>Pages: Edit on this account enables upload tokens, preview and production deployments, and rollback.</small><button class="primary" type="submit">Save Cloudflare connection</button> <button class="soft-button" type="button" id="site-cf-verify">Verify & list Pages projects</button></form>
    </div><aside class="mix-guide"><h3>How this works</h3><p>GitHub is the versioned source for the seven websites. The Studio imports the current live HTML and local assets into separate folders, adds the tracker to offer links, then deploys a preview on Cloudflare. After the preview checks out, production deploys directly to the existing Pages project. Cloudflare deployment history supports rollback.</p><p>These are Direct Upload projects; the Studio uses Cloudflare Pages Direct Upload, not a GitHub Actions build. A website is not changed just by saving its source.</p><p>Private credentials stay in the Studio data folder and are never returned to the browser or Telegram. Social posting remains separate.</p></aside></div>
    <hr><h3>Connect a website</h3><div class="writer-settings-grid"><div>
      <label for="site-map-project">Existing Cloudflare Pages project</label><select id="site-map-project"><option value="">Verify Cloudflare first</option></select>
      <label for="site-map-domain">Existing custom domain</label><select id="site-map-domain"><option value="">Choose a Pages project first</option></select>
      <label for="site-map-id">Website ID · use the Pages project name</label><input id="site-map-id" pattern="[A-Za-z0-9_-]{1,100}" maxlength="100" placeholder="e.g. maghrebtechstore">
      <label for="site-map-market">Market</label><select id="site-map-market"><option value="morocco_darija">Morocco · Darija</option><option value="arabic">Arabic · Al-Shihna</option><option value="english">English · Vouch Teck</option></select>
      <label for="site-map-repo">Private GitHub repository</label><select id="site-map-repo"><option value="">Verify GitHub first</option></select>
      <label for="site-map-branch">Source branch</label><input id="site-map-branch" maxlength="100" value="main">
      <label for="site-tracker-url">Public tracker origin · HTTPS</label><input id="site-tracker-url" type="url" value="https://51.170.133.14:34568" placeholder="https://studio.example.com:34568">
      <button class="primary" id="site-map-save" type="button">Save website mapping</button><p id="site-map-status" role="status"></p>
    </div><aside class="mix-guide"><h3>Your 7 Pages projects</h3><div id="site-map-list">No websites mapped yet.</div><p>Maghreb Darija websites share one market for aggregate reporting; their page and video results remain separate. Al-Shihna and Vouch Teck have their own markets.</p></aside></div>
    <hr><h3>Website source editor</h3><div class="writer-settings-grid"><div>
      <label for="site-editor-select">Mapped website</label><select id="site-editor-select"></select>
      <label for="site-editor-path">File path within the website</label><input id="site-editor-path" value="index.html" pattern="[A-Za-z0-9_./-]+">
      <div class="writer-actions"><button class="soft-button" id="site-editor-load" type="button">Load source</button><button class="primary" id="site-editor-save" type="button">Save source to GitHub</button></div>
      <textarea id="site-editor-content" rows="18" spellcheck="false" placeholder="Load a website source file"></textarea><p id="site-editor-status" role="status"></p>
    </div><aside class="mix-guide"><h3>Safe rollout</h3><p>Import takes the currently deployed site and its same-origin assets, then marks the existing Surveoo and KingOpinion links for separate click tracking. It saves them in the mapped private GitHub folder.</p><p>Use Preview first. Production is a separate action. Rollback only targets a successful previous production deployment from that same Pages project.</p>
      <label for="site-history">Production deployment to restore</label><select id="site-history"><option value="">Load a site's deployment history</option></select>
      <div class="writer-actions"><button class="soft-button" id="site-history-load" type="button">Load history</button><button class="soft-button" id="site-rollback" type="button">Rollback selected</button></div>
      <p id="site-action-status" role="status"></p></aside></div>`;
  mylead.after(panel);
  const call = async (url, body) => {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(90000) });
    const x = await r.json(); if (!r.ok) throw Error(x.error || 'Website request failed'); return x;
  };
  let state = { sites: [] }, repos = [], projects = [];
  const status = (id, value) => { $(id).textContent = value; };
  const button = (label, action, className = 'soft-button') => { const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = label; b.addEventListener('click', action); return b; };
  const projectByName = name => projects.find(x => x.name === name);
  const setProjects = () => {
    const select = $('site-map-project'), previous = select.value;
    select.replaceChildren(new Option(projects.length ? 'Choose Pages project' : 'Verify Cloudflare first', ''));
    for (const item of projects.filter(x => x.name !== 'monetagepush10')) select.add(new Option(`${item.name} · ${item.sourceType || 'Direct Upload'}`, item.name));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    setDomains();
  };
  const setDomains = () => {
    const project = projectByName($('site-map-project').value), select = $('site-map-domain');
    select.replaceChildren(new Option(project ? 'Choose existing custom domain' : 'Choose a Pages project first', ''));
    for (const domain of project?.domains || []) if (!domain.endsWith('.pages.dev')) select.add(new Option(domain, domain));
    if (select.options.length === 2) select.selectedIndex = 1;
    if ($('site-map-project').value === 'alshihna') $('site-map-market').value = 'arabic';
    else if ($('site-map-project').value === 'vouchteck') $('site-map-market').value = 'english';
    else if ($('site-map-project').value) $('site-map-market').value = 'morocco_darija';
    if (!$('site-map-id').value || projects.some(x => x.name === $('site-map-id').value)) $('site-map-id').value = $('site-map-project').value;
  };
  const render = () => {
    status('site-gh-state', state.github?.connected ? `Token saved${state.github.username ? ' · ' + state.github.username : ''} · ${state.github.repositoryCount ?? '?'} repositories. GitHub will confirm Contents read/write when source import starts.` : 'Not connected');
    status('site-cf-state', state.cloudflare?.connected ? `Token saved${state.cloudflare.pagesReadVerified ? ' · Pages verified · ' + state.cloudflare.projectCount + ' projects' : ' · verify Pages access'}` : 'Not connected');
    if (state.cloudflare?.accountId) $('site-cf-account').value = state.cloudflare.accountId;
    const repo = $('site-map-repo'), oldRepo = repo.value; repo.replaceChildren(new Option(repos.length ? 'Choose private repository' : 'Verify GitHub first', ''));
    for (const item of repos.filter(x => x.private)) repo.add(new Option(`${item.fullName} · private`, item.fullName));
    if ([...repo.options].some(o => o.value === oldRepo)) repo.value = oldRepo;
    setProjects();
    const rows = $('site-map-list'); rows.replaceChildren();
    if (!state.sites?.length) rows.textContent = 'No websites mapped yet.';
    for (const site of state.sites || []) {
      const row = document.createElement('div'); row.className = 'copy-box';
      const title = document.createElement('strong'); title.textContent = `${site.id} · ${site.domain} → ${site.project}`; row.append(title);
      row.append(document.createElement('br'));
      row.append(button('Import current site → GitHub', async () => runSite(site.id, 'import')),' ');
      row.append(button('Preview on Cloudflare', async () => runSite(site.id, 'preview')),' ');
      row.append(button('Publish live', async () => runSite(site.id, 'production'), 'primary'));
      rows.append(row);
    }
    const editor = $('site-editor-select'), current = editor.value; editor.replaceChildren(new Option('Choose website', ''));
    for (const site of state.sites || []) editor.add(new Option(site.id + ' · ' + site.domain, site.id));
    if ([...editor.options].some(o => o.value === current)) editor.value = current;
  };
  const load = async () => { state = await call('/api/v2/sites/integrations'); render(); };
  async function runSite(id, action) {
    status('site-action-status', `${action} running…`);
    try {
      let result;
      if (action === 'import') result = await call('/api/v2/sites/integrations/import', { id, trackerUrl: $('site-tracker-url').value.trim() });
      else result = await call('/api/v2/sites/integrations/deploy', { id, mode: action });
      status('site-action-status', JSON.stringify(result)); await load();
    } catch (e) { status('site-action-status', e.message); }
  }
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.settings-tabs button').forEach(x => x.classList.toggle('active', x === tab));
    for (const id of ['writer-settings-panel','video-settings-panel','mylead-settings-panel','facebook-settings-panel','automation-settings-panel']) if ($(id)) $(id).hidden = true;
    panel.hidden = false; $('settings-check').hidden = true;
    try { await load(); } catch (e) { status('site-map-status', e.message); }
  });
  $('site-gh-form').addEventListener('submit', async e => { e.preventDefault(); try { state = await call('/api/v2/sites/integrations', { githubToken: $('site-gh-token').value }); $('site-gh-token').value = ''; render(); status('site-gh-state', 'Token saved privately. Verify repository access.'); } catch (x) { status('site-gh-state', x.message); } });
  $('site-cf-form').addEventListener('submit', async e => { e.preventDefault(); try { state = await call('/api/v2/sites/integrations', { cloudflareToken: $('site-cf-token').value, accountId: $('site-cf-account').value.trim() }); $('site-cf-token').value = ''; render(); status('site-cf-state', 'Connection saved privately. Verify Pages permissions.'); } catch (x) { status('site-cf-state', x.message); } });
  $('site-gh-verify').addEventListener('click', async () => { try { state = await call('/api/v2/sites/integrations/verify', { provider: 'github' }); repos = await call('/api/v2/sites/integrations/repositories'); render(); } catch (e) { status('site-gh-state', e.message); } });
  $('site-cf-verify').addEventListener('click', async () => { try { state = await call('/api/v2/sites/integrations/verify', { provider: 'cloudflare' }); projects = await call('/api/v2/sites/integrations/pages-projects'); render(); status('site-cf-state', `Verified; found ${projects.length} Pages projects.`); } catch (e) { status('site-cf-state', e.message); } });
  $('site-map-project').addEventListener('change', setDomains);
  $('site-map-save').addEventListener('click', async () => { try { state = await call('/api/v2/sites/integrations', { site: { id: $('site-map-id').value.trim(), repository: $('site-map-repo').value, branch: $('site-map-branch').value.trim() || 'main', path: 'sites/' + $('site-map-id').value.trim(), project: $('site-map-project').value, domain: $('site-map-domain').value, market: $('site-map-market').value } }); render(); status('site-map-status', 'Mapping saved. Import the current website to create its GitHub source; no live deployment started.'); } catch (e) { status('site-map-status', e.message); } });
  $('site-editor-load').addEventListener('click', async () => { try { const q = new URLSearchParams({ site: $('site-editor-select').value, path: $('site-editor-path').value.trim() }); const file = await call('/api/v2/sites/integrations/files/read?' + q); $('site-editor-content').value = file.content; status('site-editor-status', `Loaded ${file.path} from ${file.commit}.`); } catch (e) { status('site-editor-status', e.message); } });
  $('site-editor-save').addEventListener('click', async () => { try { const result = await call('/api/v2/sites/integrations/files', { id: $('site-editor-select').value, relativePath: $('site-editor-path').value.trim(), content: $('site-editor-content').value, message: 'Studio website editor update' }); status('site-editor-status', `Saved GitHub commit ${result.commit}. Live website unchanged until preview and production deployment.`); } catch (e) { status('site-editor-status', e.message); } });
  $('site-history-load').addEventListener('click', async () => { try { const id = $('site-editor-select').value, history = await call('/api/v2/sites/integrations/deployments?site=' + encodeURIComponent(id)); const select = $('site-history'); select.replaceChildren(new Option('Choose a successful production deployment', '')); for (const item of history.filter(x => x.environment === 'production' && x.status === 'success')) select.add(new Option(`${item.createdAt} · ${item.id.slice(0, 8)} · ${item.url}`, item.id)); status('site-action-status', `Loaded ${history.length} deployment records for ${id}.`); } catch (e) { status('site-action-status', e.message); } });
  $('site-rollback').addEventListener('click', async () => { try { const result = await call('/api/v2/sites/integrations/rollback', { id: $('site-editor-select').value, deploymentId: $('site-history').value }); status('site-action-status', JSON.stringify(result)); } catch (e) { status('site-action-status', e.message); } });
})();
