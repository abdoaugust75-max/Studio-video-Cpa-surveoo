'use strict';

// Website source, tracker, and Cloudflare Pages Direct Upload integration.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { blake3 } = require('hash-wasm');
const U = require('./util');

function createSiteIntegrations({ dir, request = fetch, now = Date.now, tracking = null }) {
  const file = path.join(dir, 'site-integrations-private.json');
  const read = () => {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw Error('Website connection settings could not be read'); }
  };
  const write = value => {
    U.ensureDir(dir);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  };
  async function api(url, token, options = {}) {
    const response = await request(url, { ...options, headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      const detail = response.status === 401 || response.status === 403
        ? String(url).startsWith('https://api.github.com/') ? 'GitHub denied source access. The fine-grained token needs Metadata: read and Contents: read/write for this private repository.'
          : 'Cloudflare denied this Pages operation. The token needs Pages: Edit on the selected account.'
        : `Provider request failed (${response.status}).`;
      const error = Error(detail); error.status = response.status; throw error;
    }
    return body;
  }
  const githubApi = (endpoint, value, options = {}) => api('https://api.github.com' + endpoint, value.github.token, {
    ...options, headers: { 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) },
  });
  const cfApi = (endpoint, value, options = {}) => api('https://api.cloudflare.com/client/v4' + endpoint, value.cloudflare.token, options);
  function safeSitePath(value) {
    const root = String(value || '').replace(/^\/+|\/+$/g, '');
    if (!/^sites\/[A-Za-z0-9_-]{1,100}$/.test(root)) throw Error('Website source path must be sites/<site-id>.');
    return root;
  }
  function mapping(value, id) {
    const site = (Array.isArray(value.sites) ? value.sites : []).find(item => item.id === id);
    if (!site) throw Error('Save this website connection first.');
    if (!value.github?.token || !value.cloudflare?.token || !value.cloudflare?.accountId) throw Error('Connect GitHub and Cloudflare first.');
    return site;
  }
  function settings() {
    const value = read();
    return {
      github: { connected: !!value.github?.token, verifiedAt: value.github?.verifiedAt || null, username: value.github?.username || null, repositoryCount: value.github?.repositoryCount ?? null },
      cloudflare: { connected: !!value.cloudflare?.token, verifiedAt: value.cloudflare?.verifiedAt || null, accountId: value.cloudflare?.accountId || '', accountName: value.cloudflare?.accountName || null, projectCount: value.cloudflare?.projectCount ?? null, pagesReadVerified: value.cloudflare?.pagesReadVerified === true },
      sites: Array.isArray(value.sites) ? value.sites : [],
      deployments: Array.isArray(value.deployments) ? value.deployments : [],
    };
  }
  async function save(input = {}) {
    const value = read();
    value.github ||= {};
    value.cloudflare ||= {};
    if (input.githubToken) {
      if (typeof input.githubToken !== 'string' || input.githubToken.length < 20 || input.githubToken.length > 500) throw Error('Enter a valid GitHub fine-grained token in this Settings form.');
      value.github.token = input.githubToken;
      delete value.github.verifiedAt; delete value.github.username; delete value.github.repositoryCount;
    }
    if (input.cloudflareToken) {
      if (typeof input.cloudflareToken !== 'string' || input.cloudflareToken.length < 20 || input.cloudflareToken.length > 500) throw Error('Enter a valid Cloudflare API token in this Settings form.');
      value.cloudflare.token = input.cloudflareToken;
      delete value.cloudflare.verifiedAt; delete value.cloudflare.accountName; delete value.cloudflare.projectCount; delete value.cloudflare.pagesReadVerified;
    }
    if (input.accountId !== undefined) {
      const id = String(input.accountId || '').trim();
      if (id && !/^[a-f0-9]{32}$/i.test(id)) throw Error('Cloudflare account ID must contain 32 hexadecimal characters.');
      if (value.cloudflare.accountId !== id) {
        delete value.cloudflare.verifiedAt; delete value.cloudflare.accountName; delete value.cloudflare.projectCount; delete value.cloudflare.pagesReadVerified;
      }
      value.cloudflare.accountId = id;
    }
    if (input.site) {
      const s = input.site;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(s.id || ''))) throw Error('Choose a valid existing website identifier.');
      if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(String(s.repository || ''))) throw Error('Choose a GitHub repository in owner/name format.');
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(s.branch || ''))) throw Error('Choose a valid repository branch.');
      if (!/^[a-z0-9-]{1,100}$/.test(String(s.project || ''))) throw Error('Choose a valid Cloudflare Pages project.');
      const sourcePath = safeSitePath(s.path || 'sites/' + s.id);
      const domain = String(s.domain || '').trim().toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw Error('Choose the existing custom domain for this Pages project.');
      const [owner, repo] = String(s.repository).split('/');
      const repository = await githubApi(`/repos/${owner}/${repo}`, value);
      if (repository.private !== true) throw Error('Website source must stay in a private GitHub repository.');
      const projects = await listPagesProjects(value);
      const project = projects.find(item => item.name === s.project);
      if (!project || !project.domains.includes(domain)) throw Error('That domain is not connected to the selected Cloudflare Pages project.');
      const entry = { id: s.id, repository: s.repository, branch: s.branch, path: sourcePath, project: s.project, domain, market: ['morocco_darija', 'arabic', 'english'].includes(s.market) ? s.market : 'morocco_darija', updatedAt: now() };
      const existing = Array.isArray(value.sites) ? value.sites : [];
      const index = existing.findIndex(item => item.id === entry.id);
      if (index >= 0) existing[index] = entry; else existing.push(entry);
      value.sites = existing.slice(0, 50);
    }
    write(value);
    return settings();
  }
  async function verify(input = {}) {
    const value = read();
    if (input.provider === 'github') {
      if (!value.github?.token) throw Error('Save a GitHub token first.');
      const user = await api('https://api.github.com/user', value.github.token, { headers: { 'X-GitHub-Api-Version': '2022-11-28' } });
      const repos = await listRepositories(value);
      value.github.username = String(user.login || ''); value.github.repositoryCount = repos.length; value.github.verifiedAt = now(); write(value);
      return settings();
    }
    if (input.provider === 'cloudflare') {
      if (!value.cloudflare?.token) throw Error('Save a Cloudflare token first.');
      // Verify the required Pages operation directly. Account-owned tokens do
      // not use /user/tokens/verify, and Pages tokens need no Account Read scope.
      const projects = await listPagesProjects(value);
      value.cloudflare.projectCount = projects.length;
      value.cloudflare.pagesReadVerified = true;
      value.cloudflare.verifiedAt = now(); write(value);
      return settings();
    }
    throw Error('Choose GitHub or Cloudflare to verify.');
  }
  async function listRepositories(value) {
    if (!value.github?.token) throw Error('Save a GitHub token first.');
    const data = await api('https://api.github.com/user/repos?per_page=100&sort=updated&visibility=all', value.github.token, { headers: { 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!Array.isArray(data)) throw Error('GitHub returned an unexpected repository list.');
    return data.map(repo => ({ fullName: repo.full_name, defaultBranch: repo.default_branch || 'main', private: !!repo.private, url: repo.html_url })).filter(repo => repo.fullName && repo.defaultBranch);
  }
  async function repositories() { return listRepositories(read()); }
  async function listPagesProjects(value) {
    if (!value.cloudflare?.token || !value.cloudflare?.accountId) throw Error('Save a Cloudflare token and account ID first.');
    const id = encodeURIComponent(value.cloudflare.accountId);
    const projects = [];
    for (let page = 1; page <= 50; page++) {
      let data;
      try { data = await api(`https://api.cloudflare.com/client/v4/accounts/${id}/pages/projects?page=${page}&per_page=10`, value.cloudflare.token); }
      catch (error) {
        if ([401,403].includes(error.status)) throw Error('Cloudflare denied Pages access. Check the account ID and grant Cloudflare Pages: Read or Edit. R2-only credentials do not grant Pages access.');
        throw error;
      }
      if (!data.success || !Array.isArray(data.result)) throw Error('Cloudflare returned an unexpected Pages project list.');
      projects.push(...data.result.map(project => ({ name: project.name, productionBranch: project.production_branch || 'main', sourceType: project.source?.type || null, domains: project.domains || [] })));
      const totalPages = Number(data.result_info?.total_pages);
      if ((totalPages > 0 && page >= totalPages) || (!totalPages && data.result.length < 10)) return projects;
    }
    throw Error('Cloudflare project list exceeded the 500-project discovery limit; no partial list returned.');
  }
  async function pagesProjects() { return listPagesProjects(read()); }

  async function commitFiles(site, value, files, message) {
    if (!files.length || files.length > 500) throw Error('Source update must contain between 1 and 500 files.');
    const [owner, repo] = site.repository.split('/');
    const repoData = await githubApi(`/repos/${owner}/${repo}`, value);
    if (repoData.private !== true) throw Error('The website source repository must be private.');
    const ref = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(site.branch)}`, value);
    const parentSha = ref.object?.sha;
    const parent = await githubApi(`/repos/${owner}/${repo}/git/commits/${parentSha}`, value);
    const tree = [];
    let totalBytes = 0;
    for (const file of files) {
      const relative = path.posix.normalize(String(file.path || '').replace(/\\/g, '/'));
      if (!relative.startsWith(site.path + '/') || relative.split('/').some(part => !part || part === '.' || part === '..') || /(?:^|\/)(?:\.env|secrets?|credentials?|private-backup|data)(?:\/|$)/i.test(relative)) throw Error('Website source update contains a path outside its mapped site.');
      const bytes = Buffer.from(file.bytes);
      totalBytes += bytes.length;
      if (bytes.length > 20 * 1024 * 1024 || totalBytes > 100 * 1024 * 1024) throw Error('Website update exceeds the file or total size limit.');
      const blob = await githubApi(`/repos/${owner}/${repo}/git/blobs`, value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }) });
      tree.push({ path: relative, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const nextTree = await githubApi(`/repos/${owner}/${repo}/git/trees`, value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
    const commit = await githubApi(`/repos/${owner}/${repo}/git/commits`, value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: String(message || 'Update managed website').slice(0, 200), tree: nextTree.sha, parents: [parentSha] }) });
    await githubApi(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(site.branch)}`, value, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: false }) });
    return { sha: commit.sha, url: commit.html_url };
  }

  async function importLiveSite({ id, trackerUrl } = {}) {
    const value = read(), site = mapping(value, String(id || ''));
    const origin = 'https://' + site.domain;
    const index = await request(origin + '/', { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!index.ok || !(index.headers.get('content-type') || '').toLowerCase().includes('text/html')) throw Error('Could not read the current live homepage as HTML.');
    let html = await index.text();
    if (html.length > 3_000_000) throw Error('Homepage exceeds the 3 MB import limit.');
    if (!html.includes('</html>')) throw Error('The live homepage is incomplete; no source was saved.');
    const offers = [];
    html = html.replace(/<a\b[^>]*\bhref=(['"])(https?:\/\/[^'"]+)\1[^>]*>[\s\S]*?<\/a>/gi, (anchor, quote, href) => {
      let url; try { url = new URL(href); } catch (_) { return anchor; }
      if (!/price-low\.eu$/i.test(url.hostname) || !/^\/a\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return anchor;
      const existing = offers.find(item => item.url === url.href);
      const key = existing?.id || (offers.length === 0 ? 'surveoo' : offers.length === 1 ? 'kingopinion' : 'offer_' + (offers.length + 1));
      if (!existing) offers.push({ id: key, url: url.href, campaign: key });
      return /\bdata-studio-offer=/i.test(anchor) ? anchor : anchor.replace(/<a\b/i, '<a data-studio-offer="' + key + '"');
    });
    if (!offers.length) throw Error('No supported affiliate offer links were found. The published site was left untouched.');
    if (trackerUrl) {
      const tracker = new URL(trackerUrl);
      if (tracker.protocol !== 'https:' || tracker.username || tracker.password) throw Error('Tracker URL must be a public HTTPS origin.');
      const script = `<script defer src="${tracker.origin}/track/client.js" data-site="${site.id}"></script>`;
      if (!html.includes('/track/client.js')) html = html.replace(/<\/body>/i, script + '</body>');
    }
    const files = new Map([['index.html', Buffer.from(html)]]);
    const refs = new Set();
    for (const match of html.matchAll(/(?:src|href)\s*=\s*['"]([^'"]+)['"]|url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) {
      const ref = match[1] || match[2];
      if (!ref || /^(?:data:|blob:|javascript:|#|mailto:|tel:)/i.test(ref) || /^https?:\/\//i.test(ref)) continue;
      let u; try { u = new URL(ref, origin); } catch (_) { continue; }
      if (u.origin !== origin) continue;
      const name = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!name || name.includes('..') || name.startsWith('cdn-cgi/')) continue;
      refs.add(name);
    }
    if (refs.size > 100) throw Error('The site references more than 100 local assets; import stopped before saving.');
    let totalBytes = Buffer.byteLength(html);
    for (const name of refs) {
      const u = new URL('/' + name, origin);
      const response = await request(u, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`Could not import required website asset: ${name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw Error(`Website asset exceeds the safe 20 MB limit: ${name}`);
      totalBytes += bytes.length;
      if (totalBytes > 100 * 1024 * 1024) throw Error('Website source exceeds the 100 MB import limit.');
      files.set(name, bytes);
    }
    const saved = await commitFiles(site, value, [...files].map(([name, bytes]) => ({ path: `${site.path}/${name}`, bytes })), `Import current ${site.project} site with Studio tracking`);
    const existingTracking = tracking?.settings();
    if (tracking && offers.length && (trackerUrl || existingTracking?.publicBaseUrl)) {
      tracking.save({ publicBaseUrl: trackerUrl || existingTracking.publicBaseUrl, site: {
        id: site.id, label: site.id, market: site.market, origins: [origin], landingUrl: origin + '/',
        offerUrl: offers[0].url, offers, campaign: site.id, enabled: true,
      } });
    }
    return { ok: true, site: site.id, project: site.project, domain: site.domain, repository: site.repository, branch: site.branch, sourcePath: site.path, importedFiles: files.size, bytes: totalBytes, offers: offers.map(item => ({ id: item.id, url: new URL(item.url).origin + new URL(item.url).pathname })), trackingEnabled: !!(tracking && (trackerUrl || existingTracking?.publicBaseUrl)), commit: saved.sha, note: 'Current public site copied into the Studio repository. No Cloudflare deployment was triggered.' };
  }

  async function readSource(site, value) {
    const [owner, repo] = site.repository.split('/');
    const tree = await githubApi(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(site.branch)}?recursive=1`, value);
    if (tree.truncated) throw Error('GitHub source tree is too large; deployment stopped.');
    const prefix = site.path + '/';
    const entries = (tree.tree || []).filter(item => item.type === 'blob' && item.path.startsWith(prefix));
    if (!entries.some(item => item.path === prefix + 'index.html') || entries.length > 500) throw Error('GitHub site source is incomplete or exceeds the 500-file limit.');
    let totalBytes = 0;
    const files = [];
    for (const item of entries) {
      const blob = await githubApi(`/repos/${owner}/${repo}/git/blobs/${item.sha}`, value);
      const bytes = Buffer.from(blob.content || '', blob.encoding === 'base64' ? 'base64' : 'utf8');
      totalBytes += bytes.length;
      if (bytes.length > 20 * 1024 * 1024 || totalBytes > 100 * 1024 * 1024) throw Error('GitHub site source exceeds the file or total size limit.');
      files.push({ path: item.path.slice(prefix.length), bytes });
    }
    return files;
  }
  async function readFile({ id, relativePath } = {}) {
    const value = read(), site = mapping(value, String(id || ''));
    const rel = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/'));
    if (!rel || rel.startsWith('/') || rel.split('/').some(part => !part || part === '.' || part === '..') || !/\.(?:html|css|js|json|svg|txt)$/i.test(rel)) throw Error('Choose a text file inside the mapped website.');
    const files = await readSource(site, value);
    const file = files.find(item => item.path === rel);
    if (!file) throw Error('That website source file does not exist in GitHub.');
    return { site: site.id, path: rel, content: file.bytes.toString('utf8'), commit: site.branch };
  }

  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  async function deploy({ id, mode = 'preview' } = {}) {
    if (!['preview', 'production'].includes(mode)) throw Error('Deployment mode must be preview or production.');
    const value = read(), site = mapping(value, String(id || ''));
    const files = await readSource(site, value);
    const tokenResponse = await cfApi(`/accounts/${encodeURIComponent(value.cloudflare.accountId)}/pages/projects/${encodeURIComponent(site.project)}/upload-token`, value);
    const jwt = tokenResponse.result?.jwt;
    if (!tokenResponse.success || !jwt) throw Error('Cloudflare did not issue a Pages upload token. Confirm Pages Write permission.');
    // Match Wrangler's Pages asset key: BLAKE3(base64(file bytes) + extension),
    // truncated to 32 hex characters.
    const assets = await Promise.all(files.map(async file => {
      const extension = path.extname(file.path).slice(1);
      const hash = (await blake3(file.bytes.toString('base64') + extension)).slice(0, 32);
      return { ...file, hash, type: mimeTypes[path.extname(file.path).toLowerCase()] || 'application/octet-stream' };
    }));
    // Cloudflare's deployment manifest uses rooted paths such as /index.html.
    const manifest = Object.fromEntries(assets.map(file => ['/' + (file.path.startsWith('/') ? file.path.slice(1) : file.path), file.hash]));
    const missingResponse = await request('https://api.cloudflare.com/client/v4/pages/assets/check-missing', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [...new Set(assets.map(file => file.hash))] }), signal: AbortSignal.timeout(30000) });
    const missingBody = await missingResponse.json().catch(() => ({}));
    if (!missingResponse.ok || !missingBody.success || !Array.isArray(missingBody.result)) throw Error('Cloudflare could not check missing Pages assets.');
    const missing = new Set(missingBody.result);
    for (let offset = 0; offset < assets.length; offset += 20) {
      const chunk = assets.slice(offset, offset + 20).filter(file => missing.has(file.hash));
      if (!chunk.length) continue;
      const upload = await request('https://api.cloudflare.com/client/v4/pages/assets/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify(chunk.map(file => ({ base64: true, key: file.hash, metadata: { contentType: file.type }, value: file.bytes.toString('base64') }))), signal: AbortSignal.timeout(60000) });
      const uploaded = await upload.json().catch(() => ({}));
      if (!upload.ok || !uploaded.success) throw Error('Cloudflare rejected one or more website assets.');
    }
    const registeredResponse = await request('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [...new Set(assets.map(file => file.hash))] }), signal: AbortSignal.timeout(30000) });
    const registered = await registeredResponse.json().catch(() => ({}));
    if (!registeredResponse.ok || !registered.success) throw Error('Cloudflare did not register the uploaded Pages asset hashes.');
    const form = new FormData();
    form.set('branch', mode === 'production' ? site.branch : 'studio-preview');
    form.set('commit_dirty', 'true'); form.set('commit_message', mode === 'production' ? `Studio publish ${site.id}` : `Studio preview ${site.id}`);
    form.set('manifest', JSON.stringify(manifest)); form.set('pages_build_output_dir', '.');
    const created = await cfApi(`/accounts/${encodeURIComponent(value.cloudflare.accountId)}/pages/projects/${encodeURIComponent(site.project)}/deployments`, value, { method: 'POST', body: form });
    const deployment = created.result;
    if (!created.success || !deployment?.id) throw Error('Cloudflare did not create the Pages deployment.');
    let current = deployment;
    for (let attempt = 0; attempt < 15 && !['success', 'failure', 'canceled', 'skipped'].includes(current.latest_stage?.status); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const status = await cfApi(`/accounts/${encodeURIComponent(value.cloudflare.accountId)}/pages/projects/${encodeURIComponent(site.project)}/deployments/${encodeURIComponent(deployment.id)}`, value);
      current = status.result || current;
    }
    if (current.latest_stage?.status !== 'success') throw Error(`Cloudflare deployment did not finish successfully (${current.latest_stage?.status || 'status unknown'}).`);
    const output = { ok: true, site: site.id, project: site.project, mode, deploymentId: deployment.id, url: current.url, aliases: current.aliases || [], environment: current.environment, status: current.latest_stage.status, files: files.length, createdAt: deployment.created_on };
    value.deployments ||= []; value.deployments.push(output); value.deployments = value.deployments.slice(-200); write(value);
    return output;
  }

  async function updateFile({ id, relativePath, content, message } = {}) {
    const value = read(), site = mapping(value, String(id || ''));
    const rel = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/'));
    if (!rel || rel.startsWith('/') || rel.split('/').some(part => !part || part === '.' || part === '..') || !/\.(?:html|css|js|json|svg|txt)$/i.test(rel)) throw Error('Only a text HTML/CSS/JS/JSON/SVG/TXT file inside this site can be edited.');
    if (/(?:^|\/)(?:\.env|secrets?|credentials?|private-backup|data)(?:\/|$)/i.test(rel)) throw Error('This file is outside the website editor scope.');
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 3_000_000) throw Error('Website text must be non-empty and at most 3 MB.');
    if (/\b(?:CF_API_TOKEN|GITHUB_TOKEN|OPENROUTER_API_KEY|TELEGRAM_BOT_TOKEN)\b\s*[:=]/i.test(content)) throw Error('Website source cannot contain Studio credentials.');
    if (/\.html?$/i.test(rel) && (!/<html\b/i.test(content) || !/<\/html>/i.test(content))) throw Error('An HTML edit must include a complete HTML document.');
    const updated = await commitFiles(site, value, [{ path: `${site.path}/${rel}`, bytes: Buffer.from(content) }], message || `Studio edit ${site.id}/${rel}`);
    return { ok: true, site: site.id, path: rel, commit: updated.sha, url: updated.url, note: 'Saved in GitHub source. Live website unchanged until Cloudflare preview and production deployment.' };
  }

  async function deploymentHistory({ id } = {}) {
    const value = read(), site = mapping(value, String(id || ''));
    const response = await cfApi(`/accounts/${encodeURIComponent(value.cloudflare.accountId)}/pages/projects/${encodeURIComponent(site.project)}/deployments?per_page=10`, value);
    return (response.result || []).map(item => ({ id: item.id, url: item.url, aliases: item.aliases || [], environment: item.environment, status: item.latest_stage?.status || 'unknown', createdAt: item.created_on }));
  }
  async function rollback({ id, deploymentId } = {}) {
    const value = read(), site = mapping(value, String(id || ''));
    if (!/^[a-f0-9-]{20,50}$/i.test(String(deploymentId || ''))) throw Error('Choose a deployment from this site history.');
    const history = await deploymentHistory({ id });
    if (!history.some(item => item.id === deploymentId && item.environment === 'production' && item.status === 'success')) throw Error('Rollback target must be a successful production deployment belonging to this website.');
    const response = await cfApi(`/accounts/${encodeURIComponent(value.cloudflare.accountId)}/pages/projects/${encodeURIComponent(site.project)}/deployments/${encodeURIComponent(deploymentId)}/rollback`, value, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.success || !response.result?.id) throw Error('Cloudflare could not roll back this website.');
    return { ok: true, site: site.id, project: site.project, rollbackDeploymentId: response.result.id, restoredFrom: deploymentId, url: response.result.url, status: response.result.latest_stage?.status || 'queued' };
  }
  return { settings, save, verify, repositories, pagesProjects, importLiveSite, readFile, updateFile, deploy, deploymentHistory, rollback };
}
module.exports = { createSiteIntegrations };
