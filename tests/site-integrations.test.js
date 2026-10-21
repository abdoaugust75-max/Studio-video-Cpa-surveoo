'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSiteIntegrations } = require('../lib/site-integrations');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-integrations-'));
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: String(url), options });
    const data = String(url).includes('/user/tokens/verify') ? { success: true, result: { status: 'active' } }
      : String(url).endsWith('/user') ? { login: 'owner' }
      : String(url).includes('/repos/owner/site-a') ? { private: true }
      : String(url).includes('/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pages/projects') ? { success: true, result: [{ name: 'landing-a', production_branch: 'main', source: { type: 'direct-upload' }, domains: ['site.example'] }] }
      : String(url).includes('/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') ? { success: true, result: { name: 'Owner account' } }
      : [{ full_name: 'owner/site-a', default_branch: 'main', private: true, html_url: 'https://github.com/owner/site-a' }];
    return { ok: true, status: 200, json: async () => data };
  };
  return { dir, calls, service: createSiteIntegrations({ dir, request, now: () => 1234 }) };
}

test('website connections save tokens privately, discover inventory and never return secrets', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.service.save({ githubToken: 'github-test-' + 'x'.repeat(40), cloudflareToken: 'cloudflare-test-' + 'y'.repeat(40), accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal((await f.service.verify({ provider: 'github' })).github.username, 'owner');
  assert.equal((await f.service.verify({ provider: 'cloudflare' })).cloudflare.projectCount, 1);
  assert.equal(f.calls.some(c => /\/user\/tokens\/verify/.test(c.url)), false);
  assert.equal(f.calls.some(c => /\/accounts\/a+$/.test(c.url)), false);
  assert.deepEqual(await f.service.repositories(), [{ fullName: 'owner/site-a', defaultBranch: 'main', private: true, url: 'https://github.com/owner/site-a' }]);
  assert.equal((await f.service.pagesProjects())[0].name, 'landing-a');
  await f.service.save({ site: { id: 'darija-main', repository: 'owner/site-a', branch: 'main', project: 'landing-a', domain: 'site.example', market: 'morocco_darija' } });
  const settings = f.service.settings();
  assert.equal(settings.sites.length, 1);
  assert.equal(JSON.stringify(settings).includes('github-test-'), false);
  assert.equal(JSON.stringify(settings).includes('cloudflare-test-'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'site-integrations-private.json'), 'utf8'));
  assert.equal(saved.github.token, 'github-test-' + 'x'.repeat(40));
  assert.equal(saved.cloudflare.token, 'cloudflare-test-' + 'y'.repeat(40));
});

test('invalid provider, account, and site mapping inputs are rejected', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await assert.rejects(f.service.verify({ provider: 'github' }), /Save a GitHub token/);
  await assert.rejects(f.service.save({ accountId: 'bad' }), /32 hexadecimal/);
  await assert.rejects(f.service.save({ site: { id: '../x', repository: 'owner/repo', branch: 'main', project: 'pages' } }), /website identifier/);
});

test('verification checks Pages permissions directly and invalidates results when account changes', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.service.save({ cloudflareToken: 'account-test-' + 'z'.repeat(30), accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const verified = await f.service.verify({ provider: 'cloudflare' });
  assert.equal(verified.cloudflare.pagesReadVerified, true);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/pages\/projects/);
  assert.equal(new URL(f.calls[0].url).searchParams.get('per_page'), '10');
  const changed = await f.service.save({ accountId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(changed.cloudflare.verifiedAt, null);
  assert.equal(changed.cloudflare.pagesReadVerified, false);
});

test('account identity verification does not imply accessible repositories', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-integrations-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createSiteIntegrations({ dir, request: async url => ({ok:true,status:200,json:async()=>String(url).endsWith('/user') ? {login:'owner'} : []}) });
  await service.save({ githubToken: 'github-test-' + 'x'.repeat(40) });
  const verified = await service.verify({ provider: 'github' });
  assert.equal(verified.github.username, 'owner');
  assert.equal(verified.github.repositoryCount, 0);
});

test('Cloudflare discovery follows supported page sizes and returns subsequent pages', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-integrations-pages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const service = createSiteIntegrations({ dir, request: async url => {
    const u = new URL(url); calls.push(u.searchParams.get('page'));
    assert.equal(u.searchParams.get('per_page'), '10');
    const page = Number(u.searchParams.get('page'));
    return {ok:true,status:200,json:async()=>({success:true,result:Array.from({length:page===1?10:1},(_,i)=>({name:'site-'+page+'-'+i})),result_info:{total_pages:2}})};
  }});
  await service.save({ cloudflareToken: 'cloudflare-test-' + 'x'.repeat(40), accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal((await service.pagesProjects()).length, 11);
  assert.deepEqual(calls, ['1','2']);
});

test('direct upload preview uses a mapped private repository and never promotes to production', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-integrations-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const html = '<!doctype html><html><body><h1>Site</h1></body></html>';
  const bytes = Buffer.from(html), { blake3 } = require('hash-wasm');
  const hash = (await blake3(bytes.toString('base64') + 'html')).slice(0, 32);
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const target = String(url);
    let data = {};
    if (target.includes('/repos/owner/site-a') && !target.includes('/git/')) data = { private: true };
    else if (target.includes('/pages/projects?')) data = { success: true, result: [{ name: 'landing-a', production_branch: 'main', domains: ['site.example'] }] };
    else if (target.includes('/repos/owner/site-a/git/trees/main')) data = { tree: [{ type: 'blob', path: 'sites/darija-main/index.html', sha: 'blob-html' }], truncated: false };
    else if (target.includes('/repos/owner/site-a/git/blobs/blob-html')) data = { encoding: 'base64', content: bytes.toString('base64') };
    else if (target.endsWith('/upload-token')) data = { success: true, result: { jwt: 'temporary-upload-jwt' } };
    else if (target.endsWith('/assets/check-missing')) data = { success: true, result: [hash] };
    else if (target.endsWith('/assets/upload')) {
      const uploaded = JSON.parse(options.body);
      assert.equal(uploaded[0].metadata.contentType, 'text/html; charset=utf-8');
      assert.equal(uploaded[0].base64, true);
      assert.equal(uploaded[0].key, hash);
      data = { success: true };
    }
    else if (target.endsWith('/assets/upsert-hashes')) {
      assert.deepEqual(JSON.parse(options.body), { hashes: [hash] });
      data = { success: true };
    }
    else if (target.endsWith('/deployments') && options.method === 'POST') {
      assert.equal(options.body.get('branch'), 'studio-preview');
      assert.deepEqual(JSON.parse(options.body.get('manifest')), { '/index.html': hash });
      data = { success: true, result: { id: '11111111-2222-4333-8444-555555555555', url: 'https://abc.landing-a.pages.dev', aliases: [], environment: 'preview', created_on: '2026-10-21T00:00:00Z', latest_stage: { status: 'success' } } };
    }
    return { ok: true, status: 200, json: async () => data };
  };
  const service = createSiteIntegrations({ dir, request });
  await service.save({ githubToken: 'github-test-' + 'x'.repeat(40), cloudflareToken: 'cloudflare-test-' + 'y'.repeat(40), accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  await service.save({ site: { id: 'darija-main', repository: 'owner/site-a', branch: 'main', path: 'sites/darija-main', project: 'landing-a', domain: 'site.example', market: 'morocco_darija' } });
  const result = await service.deploy({ id: 'darija-main', mode: 'preview' });
  assert.equal(result.environment, 'preview');
  assert.equal(result.status, 'success');
  assert.equal(calls.some(x => x.url.includes('/deployments') && x.options.method === 'POST'), true);
  assert.equal(calls.some(x => x.url.includes('/deployments') && x.options.method === 'POST' && x.options.body.get('branch') === 'main'), false);
  assert.equal(JSON.stringify(service.settings()).includes('temporary-upload-jwt'), false);
});
