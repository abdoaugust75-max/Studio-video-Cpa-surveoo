'use strict';

// Cookie-free landing-page attribution. No IP, user-agent or visitor fingerprint is stored.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');
const { PROFILES } = require('./campaign-profiles');
const PUBLIC_PATHS = new Set(['/track/client.js', '/track/event', '/track/go']);
const MARKETS = ['morocco_darija', 'arabic', 'english'];
const marketFor = page => page === 'alshihna' ? 'arabic' : page === 'vouchteck' ? 'english' : 'morocco_darija';
function ownerTrackingSummary(result) {
  if (!result.publicConfigured || !result.sites?.some(s => s.enabled)) return 'تتبع المواقع مازال ما تفعّلش. خاص إعداد الموقع وتركيب كود التتبع فيه، ومن بعد نقدر نقارن الزيارات بالنقرات والعمولات.';
  const report = result.report, totals = report.totals;
  const payouts = Object.entries(totals.approvedPayout).map(([currency, amount]) => Number(amount).toFixed(2) + ' ' + currency).join('، ');
  return `فالمدة اللي تفحصات، تسجلات فالستوديو ${totals.visits} زيارة للصفحات و${totals.offerClicks} نقرة على العروض. تربطو بهم ${totals.leads} ليد، منهم ${totals.statuses.approved || 0} مقبولين.`
    + (payouts ? '\nالعمولة المقبولة المسجلة: ' + payouts + '.' : '\nما كايناش مبالغ ديال عمولات مقبولة مسجلة فهاد النتائج.')
    + (totals.unavailableApprovedPayouts ? `\nباقي ${totals.unavailableApprovedPayouts} ليد مقبول ناقص الثمن أو العملة؛ حساب الربح مازال ناقص.` : '')
    + '\nهادو غير الأرقام اللي وصلات للتتبع والمزامنة؛ ماشي جميع زوار المواقع، وما كتثبتش بوحدها علاش شي فيديو نجح.';
}
const identifier = (value, optional = false) => {
  const text = String(value ?? '');
  if ((!text && optional) || /^[a-zA-Z0-9_-]{1,100}$/.test(text)) return text;
  throw Error('Use an identifier containing letters, digits, underscores or hyphens');
};
function webUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw Error('Use HTTPS (HTTP is allowed only for localhost)');
  return url;
}
function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw Error('Use a YYYY-MM-DD date');
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw Error('Invalid date');
  return ms;
}
function createSiteTracking({ dir, conversions = () => [], now = Date.now, clientFile = path.join(__dirname, '../public/tracking-client.js') }) {
  const settingsFile = path.join(dir, 'site-tracking-private.json');
  const ledger = path.join(dir, 'tracking-events');
  let cachedDay = '', todayEvents = [], todayKeys = new Map();
  const budgets = new Map();
  const config = () => {
    if (!fs.existsSync(settingsFile)) return { publicBaseUrl: '', sites: [], secret: '' };
    const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!Array.isArray(data.sites) || !/^[a-f0-9]{64}$/.test(data.secret || '')) throw Error('Tracking settings require recovery; no events were accepted');
    return data;
  };
  const settings = () => {
    const { secret, ...value } = config();
    return { ...value, profiles: PROFILES.map(p => ({ key: p.key, language: p.language, market: marketFor(p.key) })), markets: MARKETS };
  };
  function save(input = {}) {
    const previous = config();
    const publicBaseUrl = input.publicBaseUrl == null ? previous.publicBaseUrl : (input.publicBaseUrl ? webUrl(input.publicBaseUrl).origin : '');
    const sites = previous.sites.slice();
    if (input.site) {
      const site = input.site, id = identifier(site.id);
      if (!MARKETS.includes(site.market)) throw Error('Choose a known website market');
      const origins = [...new Set((Array.isArray(site.origins) ? site.origins : []).map(value => webUrl(value).origin))];
      if (!origins.length || origins.length > 10) throw Error('Configure between one and ten exact website origins');
      const offerUrl = site.offerUrl ? webUrl(site.offerUrl).href : '';
      const offers = Array.isArray(site.offers) ? site.offers.slice(0, 10).map((item, index) => ({
        id: identifier(item.id), url: webUrl(item.url).href,
        campaign: identifier(item.campaign || item.id || ('offer_' + (index + 1))),
      })) : [];
      if (offers.some((item, index) => offers.findIndex(other => other.id === item.id) !== index)) throw Error('Offer identifiers must be unique within a website.');
      if (offers.length && !offerUrl) throw Error('Set a primary offer link when using multiple offers.');
      const landingUrl = site.landingUrl ? webUrl(site.landingUrl).href : origins[0] + '/';
      if (!origins.includes(new URL(landingUrl).origin)) throw Error('Landing page URL must belong to an allowed website origin');
      if (site.enabled === true && (!offerUrl || !publicBaseUrl)) throw Error('Configure the public tracker URL and offer URL before enabling the site');
      const next = { id, label: U.sanitizeText(site.label || id, 100), market: site.market, origins, landingUrl, offerUrl, offers, campaign: identifier(site.campaign, true), enabled: site.enabled === true, updatedAt: now() };
      const old = sites.findIndex(s => s.id === id);
      if (old >= 0) sites[old] = next; else sites.push(next);
      if (sites.length > 50) throw Error('Tracking supports at most 50 sites');
    }
    if (!publicBaseUrl && sites.some(s => s.enabled)) throw Error('Disable enabled sites before removing the tracker URL');
    U.writeJsonAtomic(settingsFile, { publicBaseUrl, sites, secret: previous.secret || crypto.randomBytes(32).toString('hex'), updatedAt: now() });
    if (process.platform !== 'win32') fs.chmodSync(settingsFile, 0o600);
    return settings();
  }
  const dayAt = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  function readDay(day) {
    const file = path.join(ledger, day + '.jsonl');
    if (!fs.existsSync(file)) return [];
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error('Tracking ledger exceeds its daily size limit');
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  function current() {
    const day = dayAt(now());
    if (cachedDay !== day) {
      todayEvents = readDay(day); todayKeys = new Map(todayEvents.map(e => [e.kind + ':' + e.id, e])); cachedDay = day;
    }
    return todayEvents;
  }
  function append(event) {
    current();
    const key = event.kind + ':' + event.id;
    if (todayKeys.has(key)) return todayKeys.get(key);
    if (todayEvents.length >= 20000) throw Error('Daily tracking capacity reached; no redirect was performed');
    U.ensureDir(ledger);
    fs.appendFileSync(path.join(ledger, cachedDay + '.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    todayEvents.push(event); todayKeys.set(key, event);
    return event;
  }
  function spend(origin) {
    const minute = Math.floor(now() / 60000);
    const previous = budgets.get(origin);
    const count = previous?.minute === minute ? previous.count + 1 : 1;
    if (count > 300) throw Error('Tracking request limit reached; retry in a minute');
    budgets.set(origin, { minute, count });
  }
  function siteFor(id, origin) {
    const site = config().sites.find(s => s.id === id && s.enabled);
    if (!site || (origin && !site.origins.includes(origin))) throw Error('Website is not enabled for this origin');
    return site;
  }
  const signature = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  function tokenFor(event, secret) {
    const payload = Buffer.from(JSON.stringify({ id: event.id, day: dayAt(event.at), site: event.site, exp: event.at + 86400000 })).toString('base64url');
    return payload + '.' + signature(payload, secret);
  }
  function recordVisit(input, origin) {
    const cfg = config();
    const site = siteFor(input.site, origin);
    if (!origin || !site.origins.includes(origin)) throw Error('An allowed website origin is required');
    spend(origin);
    const eventId = identifier(input.eventId);
    const page = identifier(input.page, true);
    if (page && !PROFILES.some(p => p.key === page && marketFor(page) === site.market)) throw Error('This page does not belong to the website market');
    const video = identifier(input.video, true);
    if (video && !page) throw Error('A video source requires its page');
    const id = crypto.createHmac('sha256', cfg.secret).update(site.id + '|' + origin + '|' + eventId).digest('hex').slice(0, 32);
    current();
    const event = append({ kind: 'visit', id, at: now(), site: site.id, market: site.market, page, video, variant: identifier(input.variant || 'default'), campaign: identifier(input.campaign || site.campaign, true) });
    return { ok: true, redirect: cfg.publicBaseUrl + '/track/go?token=' + encodeURIComponent(tokenFor(event, cfg.secret)) };
  }
  function redirect(token, offerId = '') {
    if (typeof token !== 'string' || token.length > 1500) throw Error('Invalid tracking link');
    const [payload, supplied, extra] = token.split('.');
    const cfg = config(), expected = signature(payload || '', cfg.secret || '');
    if (extra || !supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw Error('Invalid tracking signature');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    dateValue(data.day);
    if (!/^[a-f0-9]{32}$/.test(data.id) || !Number.isFinite(data.exp) || data.exp < now() || data.exp > now() + 86400000) throw Error('Tracking link has expired');
    const site = siteFor(data.site);
    const events = data.day === dayAt(now()) ? current() : readDay(data.day);
    const visit = events.find(e => e.kind === 'visit' && e.id === data.id && e.site === data.site);
    if (!visit) throw Error('Visit receipt is missing');
    spend('redirect:' + site.id);
    const selectedOffer = site.offers?.find(item => item.id === offerId);
    if (offerId && !selectedOffer) throw Error('Unknown offer for this website');
    const url = webUrl(selectedOffer?.url || site.offerUrl);
    const campaign = selectedOffer?.campaign || site.campaign;
    const offerKey = offerId || 'primary';
    const clickId = crypto.createHmac('sha256', cfg.secret).update('click:' + visit.id + ':' + offerKey).digest('hex').slice(0, 32);
    // Count a unique click per offer while deduplicating refreshes of that offer.
    const clicked = events.find(e => e.kind === 'click' && e.visitId === visit.id && (e.offer || 'primary') === offerKey) || current().find(e => e.kind === 'click' && e.visitId === visit.id && (e.offer || 'primary') === offerKey);
    if (!clicked) append({ ...visit, kind: 'click', id: clickId, visitId: visit.id, offer: offerKey, campaign, at: now(), visitedAt: visit.at });
    [clickId, visit.page, visit.video, visit.site, campaign].forEach((value, index) => url.searchParams.set('ml_sub' + (index + 1), value));
    return { location: url.href, clickId };
  }
  function report(input = {}) {
    const end = dateValue(input.dateTo || dayAt(now()));
    const start = dateValue(input.dateFrom || dayAt(now() - 29 * 86400000));
    if (start > end || (end - start) / 86400000 > 89) throw Error('Choose a date range of at most 90 days');
    const events = [];
    // Include next-day clicks of visits at the end of the requested UTC cohort.
    for (let t = start; t <= Math.min(end + 86400000, now()); t += 86400000) {
      const daily = readDay(dayAt(t));
      if (events.length + daily.length > 100000) throw Error('This report exceeds 100,000 receipts; choose a shorter date range');
      events.push(...daily);
    }
    const visits = new Map(events.filter(e => e.kind === 'visit' && e.at >= start && e.at < end + 86400000 && (!input.page || input.page === 'all' || e.page === input.page)).map(e => [e.id, e]));
    const clicks = new Map(events.filter(e => e.kind === 'click' && visits.has(e.visitId)).map(e => [e.id, e]));
    const buckets = { market: new Map(), site: new Map(), page: new Map(), video: new Map(), variant: new Map(), offer: new Map() };
    const make = key => ({ key, visits: 0, offerClicks: 0, leads: 0, statuses: {}, approvedPayout: {}, unavailableApprovedPayouts: 0, approvedClickIds: new Set() });
    const totals = make('all');
    function groups(e) {
      return [totals, ...Object.entries(buckets).map(([kind, rows]) => {
        const key = kind === 'variant' ? e.site + ':' + e.variant : kind === 'video' ? (e.page || 'unattributed') + ':' + (e.video || 'unattributed') : kind === 'offer' ? e.offer || 'unattributed' : e[kind] || 'unattributed';
        if (!rows.has(key)) rows.set(key, make(key));
        return rows.get(key);
      })];
    }
    for (const visit of visits.values()) for (const row of groups(visit)) row.visits++;
    for (const click of clicks.values()) for (const row of groups(click)) row.offerClicks++;
    let unmatchedConversions = 0, metadataMismatches = 0;
    for (const lead of conversions()) {
      const click = clicks.get(lead.sub?.[0]);
      if (!click) { unmatchedConversions++; continue; }
      if ([click.page, click.video, click.site, click.campaign].some((value, index) => String(lead.sub?.[index + 1] || '') !== value)) metadataMismatches++;
      for (const row of groups(click)) {
        row.leads++; row.statuses[lead.status] = (row.statuses[lead.status] || 0) + 1;
        if (lead.status === 'approved') {
          row.approvedClickIds.add(click.id);
          if (lead.currency && Number.isFinite(lead.payout)) row.approvedPayout[lead.currency] = (row.approvedPayout[lead.currency] || 0) + lead.payout;
          else row.unavailableApprovedPayouts++;
        }
      }
    }
    const finish = ({ approvedClickIds, ...row }) => ({ ...row, approvedClicks: approvedClickIds.size, visitToClickRate: row.visits ? row.offerClicks / row.visits : null, clickToApprovedRate: row.offerClicks ? approvedClickIds.size / row.offerClicks : null, approvedRevenuePerVisit: Object.fromEntries(Object.entries(row.approvedPayout).map(([currency, amount]) => [currency, row.visits ? amount / row.visits : null])) });
    return { generatedAt: now(), dateFrom: dayAt(start), dateTo: dayAt(end), basis: 'UTC visit cohort; subsequent synchronized conversions are joined by recorded click ID', totals: finish(totals), groups: Object.fromEntries(Object.entries(buckets).map(([key, rows]) => [key, [...rows.values()].map(finish).sort((a, b) => b.visits - a.visits).slice(0, 100)])), unmatchedConversions, metadataMismatches, note: 'Visits are page loads, not unique people or verified human traffic. Unattributed traffic stays unattributed. No causal claim is made. Currencies are never combined.' };
  }
  function inspect(input = {}) {
    const cfg = config();
    return { publicConfigured: !!cfg.publicBaseUrl, sites: cfg.sites.map(({ id, label, market, enabled }) => ({ id, label, market, enabled })), report: report(input) };
  }
  function decorateWebsite(value, { page, video } = {}) {
    if (!value) return value;
    try {
      const cfg = config(), url = webUrl(value);
      const matches = cfg.sites.filter(s => s.enabled && s.market === marketFor(page) && s.origins.includes(url.origin) && new URL(s.landingUrl || s.origins[0]).pathname === url.pathname);
      if (!cfg.publicBaseUrl || matches.length !== 1 || !PROFILES.some(p => p.key === page)) return value;
      identifier(video);
      url.searchParams.set('st_page', page); url.searchParams.set('st_video', video);
      if (matches[0].campaign) url.searchParams.set('st_campaign', matches[0].campaign);
      return url.href;
    } catch (_) { return value; }
  }
  async function handlePublic(req, res, url) {
    if (!PUBLIC_PATHS.has(url.pathname)) return false;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === '/track/client.js') {
        if (req.method !== 'GET') { send(405, { error: 'GET required' }); return true; }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
        res.end(fs.readFileSync(clientFile)); return true;
      }
      if (url.pathname === '/track/go') {
        if (req.method !== 'GET') { send(405, { error: 'GET required' }); return true; }
        const target = redirect(url.searchParams.get('token'), identifier(url.searchParams.get('offer') || '', true));
        res.writeHead(302, { Location: target.location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return true;
      }
      const origin = req.headers.origin;
      if (!origin || !config().sites.some(s => s.enabled && s.origins.includes(origin))) { send(403, { error: 'Website origin is not allowed' }); return true; }
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); send(204, {}); return true;
      }
      if (req.method !== 'POST') { send(405, { error: 'POST required' }); return true; }
      if (!(req.headers['content-type'] || '').startsWith('application/json')) { send(415, { error: 'JSON required' }); return true; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) { send(413, { error: 'Event is too large' }); return true; } chunks.push(chunk); }
      send(200, recordVisit(JSON.parse(Buffer.concat(chunks).toString('utf8')), origin));
    } catch (_) { send(400, { error: 'Tracking request could not be accepted. Check site settings or refresh the landing page.' }); }
    return true;
  }
  return { settings, save, recordVisit, redirect, report, inspect, handlePublic, decorateWebsite };
}
module.exports = { createSiteTracking, PUBLIC_PATHS, marketFor, ownerTrackingSummary };
