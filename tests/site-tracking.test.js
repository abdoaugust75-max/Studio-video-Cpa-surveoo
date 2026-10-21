'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { createSiteTracking, PUBLIC_PATHS, ownerTrackingSummary } = require('../lib/site-tracking');

function fixture(t, time = Date.parse('2026-10-20T12:00:00Z')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tracking-'));
  t.after(() => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.match(path.basename(target), /^studio-tracking-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  let clock = time;
  const leads = [];
  const create = () => createSiteTracking({ dir, conversions: () => leads, now: () => clock });
  const tracking = create();
  const site = { id: 'morocco', label: 'Morocco', market: 'morocco_darija', origins: ['https://landing.example'], landingUrl: 'https://landing.example/phone/', offerUrl: 'https://offer.example/start?existing=keep', campaign: 'surveoo', enabled: true };
  tracking.save({ publicBaseUrl: 'https://tracker.example', site });
  const visit = (input = {}) => tracking.recordVisit({ site: site.id, page: 'maghrebtechstore', video: 'video_1', variant: 'A', eventId: 'event_1', ...input }, site.origins[0]);
  const click = value => tracking.redirect(new URL(value.redirect).searchParams.get('token'));
  return { dir, leads, site, tracking, create, visit, click, setTime: value => { clock = value; } };
}

test('tracking persists visits and signed clicks without collecting caller secrets or fingerprints', t => {
  const f = fixture(t);
  const value = f.visit({ ip: '192.0.2.1', userAgent: 'private-agent', token: 'private-key' });
  const click = f.click(value), url = new URL(click.location);
  assert.equal(url.searchParams.get('existing'), 'keep');
  assert.equal(url.searchParams.get('ml_sub1'), click.clickId);
  assert.equal(url.searchParams.get('ml_sub2'), 'maghrebtechstore');
  assert.equal(url.searchParams.get('ml_sub3'), 'video_1');
  assert.equal(url.searchParams.get('ml_sub4'), 'morocco');
  assert.equal(url.searchParams.get('ml_sub5'), 'surveoo');
  f.visit(); f.click(value);
  const restarted = f.create();
  assert.equal(restarted.report().totals.visits, 1);
  assert.equal(restarted.report().totals.offerClicks, 1);
  const disk = fs.readFileSync(path.join(f.dir, 'tracking-events', '2026-10-20.jsonl'), 'utf8');
  for (const secret of ['192.0.2.1', 'private-agent', 'private-key']) assert.equal(disk.includes(secret), false);
  assert.equal('secret' in restarted.settings(), false);
  assert.equal(JSON.stringify(restarted.inspect()).includes('offer.example'), false);
});

test('approved conversion metrics join by recorded click and never inflate conversion rate or combine currencies', t => {
  const f = fixture(t), click = f.click(f.visit());
  const lead = (id, status, payout, currency, sub = [click.clickId, 'maghrebtechstore', 'video_1', 'morocco', 'surveoo']) => ({ id, status, payout, currency, sub });
  f.leads.push(lead('1', 'approved', 2, 'USD'), lead('2', 'approved', 3, 'EUR'), lead('3', 'pending', 100, 'USD'), lead('4', 'rejected', 100, 'USD'), lead('5', 'approved', 9, 'USD', ['unknown', 'maghrebtechstore']), lead('6', 'approved', 1, 'USD', [click.clickId, 'vouchteck', '', '', '']));
  const result = f.tracking.report();
  assert.equal(result.totals.leads, 5);
  assert.deepEqual(result.totals.approvedPayout, { USD: 3, EUR: 3 });
  assert.equal(result.totals.clickToApprovedRate, 1);
  assert.equal(result.unmatchedConversions, 1);
  assert.equal(result.metadataMismatches, 1);
  assert.equal(result.groups.page[0].key, 'maghrebtechstore');
  assert.deepEqual(result.totals.approvedRevenuePerVisit, { USD: 3, EUR: 3 });
  assert.equal(f.tracking.report({ page: 'alshihna' }).totals.visits, 0);
});

test('website market aggregation preserves individual social page results', t => {
  const f = fixture(t);
  f.click(f.visit());
  f.click(f.visit({ page: 'mubadara', eventId: 'other_visit', video: 'video_2' }));
  assert.equal(f.tracking.report().groups.market.length, 1);
  assert.equal(f.tracking.report().groups.page.length, 2);
  assert.throws(() => f.visit({ page: 'alshihna' }), /market/);
  assert.throws(() => f.visit({ page: 'vouchteck' }), /market/);
  assert.throws(() => f.visit({ page: '', video: 'video_1' }), /requires its page/);
});

test('next-day clicks belong to the original UTC visit cohort and repeated redirects remain unique', t => {
  const f = fixture(t, Date.parse('2026-10-20T23:59:00Z'));
  const value = f.visit();
  f.setTime(Date.parse('2026-10-21T00:01:00Z'));
  f.click(value); f.click(value);
  const result = f.tracking.report({ dateFrom: '2026-10-20', dateTo: '2026-10-20' });
  assert.equal(result.totals.visits, 1);
  assert.equal(result.totals.offerClicks, 1);
  assert.equal(f.tracking.report({ dateFrom: '2026-10-21', dateTo: '2026-10-21' }).totals.offerClicks, 0);
  f.setTime(Date.parse('2026-10-22T00:01:00Z'));
  assert.throws(() => f.click(value), /expired/);
});

test('multiple affiliate offers keep separate signed clicks and MyLead attribution', t => {
  const f = fixture(t);
  f.tracking.save({ site: { ...f.site, offers: [
    { id: 'surveoo', url: 'https://price-low.eu/a/surveoo', campaign: 'survey_offer' },
    { id: 'kingopinion', url: 'https://price-low.eu/a/king', campaign: 'king_offer' },
  ] } });
  const visit = f.visit();
  const token = new URL(visit.redirect).searchParams.get('token');
  const survey = new URL(f.tracking.redirect(token, 'surveoo').location);
  const king = new URL(f.tracking.redirect(token, 'kingopinion').location);
  assert.equal(survey.pathname, '/a/surveoo');
  assert.equal(king.pathname, '/a/king');
  assert.notEqual(survey.searchParams.get('ml_sub1'), king.searchParams.get('ml_sub1'));
  assert.equal(survey.searchParams.get('ml_sub5'), 'survey_offer');
  assert.equal(king.searchParams.get('ml_sub5'), 'king_offer');
  assert.equal(f.tracking.report().totals.offerClicks, 2);
  assert.deepEqual(f.tracking.report().groups.offer.map(x => x.key).sort(), ['kingopinion', 'surveoo', 'unattributed']);
  assert.throws(() => f.tracking.redirect(token, 'unknown'), /Unknown offer/);
});

test('untrusted origins, disabled sites, modified links and corrupt private state fail closed', t => {
  const f = fixture(t);
  assert.throws(() => f.tracking.recordVisit({ site: 'morocco', eventId: 'x' }, 'https://evil.example'), /origin/);
  const token = new URL(f.visit().redirect).searchParams.get('token');
  assert.throws(() => f.tracking.redirect(token + 'x'), /signature/);
  f.tracking.save({ site: { ...f.site, enabled: false } });
  assert.throws(() => f.tracking.redirect(token), /not enabled/);
  assert.throws(() => f.tracking.save({ site: { ...f.site, offerUrl: 'javascript:alert(1)' } }));
  assert.throws(() => f.tracking.save({ site: { ...f.site, landingUrl: 'https://evil.example' } }), /allowed website origin/);
  fs.writeFileSync(path.join(f.dir, 'site-tracking-private.json'), '{"sites":[]}');
  assert.throws(() => f.tracking.recordVisit({}, 'https://landing.example'), /recovery/);
});

test('post website links preserve existing parameters and only annotate an unambiguous matching site', t => {
  const f = fixture(t);
  const url = new URL(f.tracking.decorateWebsite('https://landing.example/phone/?keep=1', { page: 'mubadara', video: 'assembled_9' }));
  assert.equal(url.searchParams.get('keep'), '1');
  assert.equal(url.searchParams.get('st_video'), 'assembled_9');
  assert.equal(url.searchParams.get('st_page'), 'mubadara');
  const { captionForPost } = require('../lib/publish');
  assert.equal(captionForPost('شوف التفاصيل\n\n' + url.href), 'شوف التفاصيل\n\n' + url.href);
  assert.equal(new URL(captionForPost(url.href)).searchParams.get('st_video'), 'assembled_9');
  assert.equal(f.tracking.decorateWebsite('https://landing.example/phone/', { page: 'alshihna', video: 'v' }), 'https://landing.example/phone/');
  f.tracking.save({ site: { ...f.site, id: 'duplicate' } });
  assert.equal(f.tracking.decorateWebsite('https://landing.example/phone/', { page: 'mubadara', video: 'v' }), 'https://landing.example/phone/');
});

test('the Telegram tool can read one page funnel without editing it and has a natural Darija fallback', async t => {
  const f = fixture(t);
  f.click(f.visit());
  const tools = require('../lib/studio-tools').createStudioTools({ dir: path.join(f.dir, 'assistant-tools'), tracking: f.tracking });
  const result = await tools.execute({ tool: 'tracking.overview', page: 'all' });
  assert.equal(result.report.totals.offerClicks, 1);
  assert.equal(JSON.stringify(result).includes('offer.example'), false);
  const text = ownerTrackingSummary(result);
  assert.match(text, /1 زيارة/); assert.match(text, /1 نقرة/);
  assert.equal(text.includes('queued'), false);
  assert.match(ownerTrackingSummary({ publicConfigured: false, sites: [] }), /مازال ما تفعّلش/);
  await assert.rejects(tools.execute({ tool: 'tracking.save', page: 'all' }), /Unsupported/);
});

test('public HTTP boundary accepts allowed-origin JSON only; reports and settings never enter the public router', async t => {
  const f = fixture(t);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await f.tracking.handlePublic(req, res, url)) return;
    res.writeHead(401); res.end('Owner authentication required');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal(PUBLIC_PATHS.size, 3);
  assert.equal((await fetch(base + '/api/v2/tracking/settings')).status, 401);
  assert.equal((await fetch(base + '/api/v2/tracking/report')).status, 401);
  assert.equal((await fetch(base + '/track/client.js')).status, 200);
  const request = (origin, body, type = 'application/json') => fetch(base + '/track/event', { method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body });
  assert.equal((await request('https://evil.example', '{}')).status, 403);
  assert.equal((await request('https://landing.example', '{}', 'text/plain')).status, 415);
  assert.equal((await request('https://landing.example', 'x'.repeat(9000))).status, 413);
  const result = await request('https://landing.example', JSON.stringify({ site: 'morocco', page: 'mubadara', eventId: 'http_visit' }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), 'https://landing.example');
  const body = await result.json();
  const redirect = await fetch(base + new URL(body.redirect).pathname + new URL(body.redirect).search, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(new URL(redirect.headers.get('location')).hostname, 'offer.example');
});

test('actual Studio serves only tracker paths before Basic auth and leaves posting and scheduling held', { timeout: 30000 }, async t => {
  const f = fixture(t), root = path.resolve(__dirname, '..');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VS_PORT: String(port), VS_HOST: '127.0.0.1', VS_ROLE: 'web', VS_DATA_DIR: path.join(f.dir, 'app'), VS_STUDIO_DIR: path.join(f.dir, 'app/studio'), VS_MEDIA_DIR: path.join(f.dir, 'app/media'), VS_CACHE_DIR: path.join(f.dir, 'app/cache'), VS_LOGS_DIR: path.join(f.dir, 'app/logs'), VS_AUTH_USER: 'testowner', VS_AUTH_PASSWORD: 'fixture-password' }
  });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const exit = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exit; });
  const base = 'http://127.0.0.1:' + port;
  let live = false;
  for (let n = 0; n < 80; n++) {
    try { live = (await fetch(base + '/health/live', { signal: AbortSignal.timeout(500) })).ok; if (live) break; } catch (_) {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(live, 'Isolated Studio failed to boot: ' + output.slice(-1000));
  const headers = { Authorization: 'Basic ' + Buffer.from('testowner:fixture-password').toString('base64'), Origin: base, 'Content-Type': 'application/json' };
  const call = (endpoint, body) => fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/v2/tracking/settings')).status, 401);
  assert.equal((await fetch(base + '/api/v2/tracking/report')).status, 401);
  assert.equal((await fetch(base + '/track/go/')).status, 401);
  assert.equal((await fetch(base + '/track/client.js')).status, 200);
  const saved = await call('/api/v2/tracking/settings', { publicBaseUrl: base, site: f.site });
  assert.equal(saved.status, 200);
  const event = await fetch(base + '/track/event', { method: 'POST', headers: { Origin: 'https://landing.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ site: 'morocco', eventId: 'app_visit', page: 'mubadara' }) });
  assert.equal(event.status, 200);
  const redirect = (await event.json()).redirect;
  assert.equal((await fetch(redirect, { redirect: 'manual' })).status, 302);
  assert.equal((await (await call('/api/v2/tracking/report')).json()).totals.offerClicks, 1);
  assert.equal((await (await call('/api/v2/automation/settings')).json()).enabled, false);
  assert.equal((await call('/api/publish', { confirm: true })).status, 409);
  assert.equal((await fetch(base + '/api/v2/mylead/postback-url')).status, 401);
  const privateLink = await (await call('/api/v2/mylead/postback-url')).json();
  const postback = new URL(privateLink.url);
  postback.search = new URLSearchParams({token:postback.searchParams.get('token'),verify:'1'});
  const verification = await fetch(postback);
  assert.equal(verification.status, 200);
  assert.equal((await verification.json()).verificationOnly, true);
  const download = await call('/api/v2/mylead/postback-url?download=1');
  assert.equal((await download.text()).trim(), privateLink.url);
  assert.match(download.headers.get('content-disposition'), /attachment/);
});

test('postback is authenticated, decimal, idempotent and separate from confirmed API conversions', t => {
  const f = fixture(t);
  const api = require('../lib/mylead-integration').createMyLeadIntegration({dir:f.dir});
  const link = new URL(api.postbackUrl('https://tracker.example').url);
  const query = new URLSearchParams({token:link.searchParams.get('token'),lead_id:'transaction_1',payout_decimal:'4.00',currency:'USD',status:'accepted',ml_sub1:'click_1',ip:'192.0.2.5'});
  assert.equal(api.receivePostback(new URLSearchParams({lead_id:'transaction_1'})).http,403);
  assert.equal(api.receivePostback(query).http,200);
  assert.equal(api.receivePostback(query).duplicate,true);
  query.set('status','approved');
  assert.equal(api.receivePostback(query).updated,true);
  const report=api.report();
  assert.equal(report.postback.receivedLeads,1);
  assert.equal(report.postback.statuses.approved,1);
  assert.equal(report.totals.conversions,0);
  const rows=Object.values(JSON.parse(fs.readFileSync(path.join(f.dir,'mylead-postback-receipts.json'))));
  assert.equal(rows[0].payout,4);
  assert.equal(JSON.stringify(rows).includes('192.0.2.5'),false);
  assert.equal(JSON.stringify(api.report()).includes(link.searchParams.get('token')),false);
  assert.equal(api.postbackUrl('https://tracker.example').url,link.href.replace(/%5B/g,'[').replace(/%5D/g,']'));
});

test('postback verification and unsubstituted macros never create a lead; accepted is provisional', t => {
  const f=fixture(t), api=require('../lib/mylead-integration').createMyLeadIntegration({dir:f.dir});
  const url=new URL(api.postbackUrl('https://tracker.example').url);
  const key=url.searchParams.get('token');
  assert.equal(api.receivePostback(new URLSearchParams({token:key,verify:'1'})).verificationOnly,true);
  assert.equal(api.receivePostback(url.searchParams).http,422);
  assert.equal(api.report().postback.receivedLeads,0);
  const query=new URLSearchParams({token:key,lead_id:'t2',payout_decimal:'2.50',currency:'EUR',status:'accepted'});
  api.receivePostback(query);
  assert.equal(api.report().postback.statuses.pre_approved,1);
  assert.equal(api.report().totals.conversions,0);
});

test('MyLead balance verification accepts an object as well as the documented array shape', async t => {
  const f=fixture(t);
  const api=require('../lib/mylead-integration').createMyLeadIntegration({
    dir:f.dir,
    request:async (url, options={}) => String(url).endsWith('/auth/login')
      ? new Response(JSON.stringify({status:'success',data:{access_token:'test-token'}}),{status:200})
      : new Response(JSON.stringify({status:'success',data:{balance:{to_pay:12.5,accepted:10,waiting:2.5,currency:'USD',time:'today'}}}),{status:200}),
    wait:async()=>{}
  });
  api.save({username:'publisher',password:'test-password'});
  const result=await api.verify();
  assert.equal(result.ok,true);
  assert.deepEqual(result.balance,[{toPay:12.5,accepted:10,waiting:2.5,currency:'USD',time:'today'}]);
});
