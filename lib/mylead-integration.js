'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');

const BASE = 'https://api.mylead.global/api/external/v1';
const STATUSES = new Set(['approved', 'pending', 'rejected', 'pre_approved']);
const rowsOf = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];

function createMyLeadIntegration({ dir, request = fetch, now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const credentialsFile = path.join(dir, 'mylead-private.json');
  const conversionsFile = path.join(dir, 'mylead-conversions.json');
  const stateFile = path.join(dir, 'mylead-sync-state.json');
  const postbackFile = path.join(dir, 'mylead-postback-private.json');
  const receiptsFile = path.join(dir, 'mylead-postback-receipts.json');
  const read = (file, fallback) => U.readJson(file, fallback);
  const safeWrite = (file, data) => {
    U.writeJsonAtomic(file, data);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  };
  const settings = () => {
    const c = read(credentialsFile, {});
    const s = read(stateFile, {});
    return { configured: !!(c.username && c.password), usernameHint: c.username ? c.username.replace(/^(.{1,2}).*(@.*)?$/, (_, a, b) => a + '•••' + (b || '')) : '', lastSyncAt: s.lastSyncAt || null, lastSyncStatus: s.status || 'never', lastSyncMessage: s.message || null, conversionCount: Object.keys(read(conversionsFile, {})).length };
  };
  function save(input = {}) {
    const current = read(credentialsFile, {});
    const username = String(input.username ?? current.username ?? '').trim();
    const password = input.password ? String(input.password) : current.password;
    if (!username || username.length > 254 || /[\r\n]/.test(username)) throw Error('Enter your MyLead username or account email');
    if (!password || password.length > 2048) throw Error('Enter your MyLead API password');
    safeWrite(credentialsFile, { username, password, updatedAt: now() });
    return settings();
  }
  let sequence = Promise.resolve();
  let lastRequestAt = 0;
  async function limitedRequest(url, init) {
    const run = async () => {
      const pause = 1100 - (now() - lastRequestAt);
      if (pause > 0) await wait(pause);
      lastRequestAt = now();
      const response = await request(url, { ...init, signal: AbortSignal.timeout(25000) });
      if (response.status === 429) throw Error('MyLead rate limit reached; wait before syncing again');
      return response;
    };
    const next = sequence.then(run, run);
    sequence = next.catch(() => {});
    return next;
  }
  async function jsonRequest(url, init) {
    let response;
    try { response = await limitedRequest(url, init); }
    catch (error) {
      if (/rate limit/.test(error.message)) throw error;
      throw Error('Could not reach MyLead API; check the connection and retry');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status === 'error') {
      const error = response.status === 401 ? 'MyLead rejected the saved credentials. Check the account username and API password.'
        : response.status === 403 ? 'This MyLead account does not have permission for this API operation.'
        : response.status === 422 ? 'MyLead rejected the request parameters.'
        : response.status === 429 ? 'MyLead rate limit reached; wait before syncing again'
        : 'MyLead API request failed (HTTP ' + response.status + ').';
      throw Error(error);
    }
    return data;
  }
  async function login() {
    const c = read(credentialsFile, {});
    if (!c.username || !c.password) throw Error('Save MyLead credentials in Studio Settings first');
    const form = new FormData();
    form.set('username', c.username); form.set('password', c.password);
    const result = await jsonRequest(BASE + '/auth/login', { method: 'POST', body: form });
    const token = result.data?.access_token;
    if (!token) throw Error('MyLead login succeeded without returning an access token');
    return token;
  }
  async function verify() {
    const token = await login();
    const response = await jsonRequest(BASE + '/statistic/balance', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    const balance = rowsOf(response.data?.balance).map(row => ({ toPay: Number(row.to_pay) || 0, accepted: Number(row.accepted) || 0, waiting: Number(row.waiting) || 0, currency: U.sanitizeText(row.currency || '', 12), time: row.time || null }));
    const state = read(stateFile, {}); state.balance = balance; state.balanceCheckedAt = now(); safeWrite(stateFile, state);
    return { ok: true, checkedAt: now(), balance, message: 'MyLead credentials verified; read-only balance access works.' };
  }
  function dateString(value, name) {
    const s = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) throw Error('Invalid ' + name + ' date; use YYYY-MM-DD');
    return s;
  }
  function sanitizeConversion(row) {
    return {
      id: String(row.id || ''), campaignId: row.campaign_id == null ? null : String(row.campaign_id),
      campaignName: U.sanitizeText(row.campaign_name || '', 180), destinationCampaignId: row.destination_campaign_id == null ? null : String(row.destination_campaign_id),
      destinationCampaignName: U.sanitizeText(row.destination_campaign_name || '', 180), payout: row.payout == null || !Number.isFinite(Number(row.payout)) ? null : Number(row.payout),
      currency: U.sanitizeText(row.currency || '', 12), status: STATUSES.has(String(row.status)) ? String(row.status) : 'unknown',
      statusReason: U.sanitizeText(row.status_reason || '', 180), country: U.sanitizeText(row.country || '', 80), createdAt: row.created_at || null,
      sub: [1, 2, 3, 4, 5].map(n => U.sanitizeText(row['ml_sub' + n] || '', 180)),
    };
  }
  function sanitizeCampaign(row) {
    const names = rows => (Array.isArray(rows) ? rows : []).map(item => ({ id: item.id == null ? null : String(item.id), name: U.sanitizeText(item.name || item.name_lang?.en || item.name_lang?.es || '', 120), code: U.sanitizeText(item.code || '', 20) }));
    const languageText = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([key, text]) => /^[a-z]{2,3}$/i.test(key) && typeof text === 'string').map(([key, text]) => [key, U.sanitizeText(text, 1500)]));
    return {
      id: String(row.id || ''), name: U.sanitizeText(row.name || '', 180), previewUrl: /^https:\/\//i.test(row.preview_url || '') ? String(row.preview_url).slice(0, 500) : '',
      status: U.sanitizeText(row.status || '', 60), statusReason: U.sanitizeText(row.status_reason || '', 250), description: languageText(row.description_lang), shortDescription: languageText(row.short_description_lang),
      cr: row.cr == null || !Number.isFinite(Number(row.cr)) ? null : Number(row.cr), epc: row.epc == null || !Number.isFinite(Number(row.epc)) ? null : Number(row.epc),
      countries: names(row.countries), categories: names(row.categories), trafficTypes: names(row.traffic_types),
      conversionTypes: names(row.conversion_types), deviceTypes: names(row.device_types),
      payments: (Array.isArray(row.payments) ? row.payments : []).map(item => ({ title: U.sanitizeText(item.title || '', 120), revenue: item.revenue == null || !Number.isFinite(Number(item.revenue)) ? null : Number(item.revenue), type: U.sanitizeText(item.type || '', 40), currency: U.sanitizeText(item.currency || '', 12) })),
      caps: (Array.isArray(row.caps) ? row.caps : []).map(item => ({ type: U.sanitizeText(item.type || '', 40), leadLimit: Number(item.lead_limit) || 0, limitUsed: !!item.limit_used })),
      restrictions: (Array.isArray(row.restrictions) ? row.restrictions : []).map(item => U.sanitizeText(item.name_lang?.en || item.name_lang?.es || item.name || '', 180)).filter(Boolean),
    };
  }
  async function syncData(input = {}) {
    const dateTo = dateString(input.dateTo || new Date(now()).toISOString().slice(0, 10), 'end');
    const defaultFrom = new Date(now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateFrom = dateString(input.dateFrom || defaultFrom, 'start');
    if (dateFrom > dateTo) throw Error('Start date must be before end date');
    const token = await login();
    const balanceResponse = await jsonRequest(BASE + '/statistic/balance', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    const balance = rowsOf(balanceResponse.data?.balance).map(row => ({ toPay: Number(row.to_pay) || 0, accepted: Number(row.accepted) || 0, waiting: Number(row.waiting) || 0, currency: U.sanitizeText(row.currency || '', 12), time: row.time || null }));
    const campaigns = [];
    for (let page = 1; page <= 10; page++) {
      const url = new URL(BASE + '/campaigns'); url.searchParams.set('page', String(page)); url.searchParams.set('limit', '500');
      const response = await jsonRequest(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      const rows = response.data?.campaigns;
      if (!Array.isArray(rows)) throw Error('MyLead returned an unexpected campaigns response');
      campaigns.push(...rows.map(sanitizeCampaign).filter(c => c.id));
      const nextPage = Number(response.pagination?.next_page || 0);
      if (!rows.length || !nextPage) break;
      if (page === 10) throw Error('Campaign sync reached its safety limit; narrow the campaign list in MyLead');
    }
    const gathered = [];
    const maxPages = 20;
    let totalCount = null;
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(BASE + '/statistic/conversions');
      for (const [key, value] of Object.entries({ page, limit: 500, date_from: dateFrom, date_to: dateTo })) url.searchParams.set(key, String(value));
      const response = await jsonRequest(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      const rows = response.data?.conversions;
      if (!Array.isArray(rows)) throw Error('MyLead returned an unexpected conversions response');
      gathered.push(...rows.map(sanitizeConversion).filter(row => row.id));
      totalCount = Number(response.pagination?.total_count ?? totalCount ?? gathered.length);
      const nextPage = Number(response.pagination?.next_page || 0);
      if (!rows.length || !nextPage || gathered.length >= totalCount) break;
      if (page === maxPages) throw Error('Sync stopped at the safety limit of 10,000 conversions; narrow the date range');
    }
    // Enrich campaigns that actually converted in this range. Detail responses can contain
    // private affiliate tracking URLs, so sanitizeCampaign intentionally discards those fields.
    const detailIds = [...new Set(gathered.map(row => row.campaignId).filter(Boolean))].slice(0, 15);
    const campaignById = new Map(campaigns.map(c => [c.id, c]));
    for (const id of detailIds) {
      const response = await jsonRequest(BASE + '/campaign/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      const detail = response.data?.campaign;
      if (detail?.id != null) campaignById.set(String(detail.id), sanitizeCampaign(detail));
    }
    const existing = read(conversionsFile, {});
    const byId = { ...existing };
    for (const row of gathered) byId[row.id] = row;
    const bounded = Object.fromEntries(Object.entries(byId).sort((a, b) => Date.parse(a[1].createdAt || 0) - Date.parse(b[1].createdAt || 0)).slice(-50000));
    safeWrite(conversionsFile, bounded);
    const state = { ...read(stateFile, {}), status: 'success', lastSyncAt: now(), message: gathered.length + ' conversions updated; IP addresses and user-agent data were discarded.', range: { dateFrom, dateTo }, rowsFetched: gathered.length, balance, balanceCheckedAt: now(), campaigns: [...campaignById.values()], campaignsSyncedAt: now() };
    safeWrite(stateFile, state);
    return { ...state, totalStored: Object.keys(bounded).length };
  }
  let activeSync = null;
  async function sync(input = {}) {
    if (activeSync) return activeSync;
    const previous = read(stateFile, {});
    if (!input.force && previous.status === 'success' && now() - Number(previous.lastSyncAt || 0) < 5 * 60 * 1000) return { ...previous, cached: true, totalStored: Object.keys(read(conversionsFile, {})).length };
    activeSync = (async () => {
      try { return await syncData(input); }
      catch (error) {
        const old = read(stateFile, {});
        safeWrite(stateFile, { ...old, status: 'failed', lastSyncAttemptAt: now(), message: U.sanitizeText(error.message || 'MyLead sync failed', 250) });
        throw error;
      } finally { activeSync = null; }
    })();
    return activeSync;
  }
  function report(input = {}) {
    const rows = Object.values(read(conversionsFile, {}));
    const dateFrom = input.dateFrom ? dateString(input.dateFrom, 'start') : null;
    const dateTo = input.dateTo ? dateString(input.dateTo, 'end') : null;
    const filtered = rows.filter(row => {
      const date = typeof row.createdAt === 'string' ? row.createdAt.slice(0, 10) : '';
      return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
    });
    const grouped = new Map(), countries = new Map(), payoutByCurrency = new Map(), payoutByStatus = new Map();
    const status = {};
    for (const row of filtered) {
      status[row.status] = (status[row.status] || 0) + 1;
      const currency = row.currency || 'unknown';
      payoutByCurrency.set(currency, (payoutByCurrency.get(currency) || 0) + (row.payout || 0));
      const statusKey = row.status + '|' + currency;
      payoutByStatus.set(statusKey, (payoutByStatus.get(statusKey) || 0) + (row.payout || 0));
      const page = row.sub[1] || 'unattributed';
      const video = row.sub[2] || 'unattributed';
      const country = row.country || 'unknown';
      const countryKey = country + '|' + currency;
      const countryItem = countries.get(countryKey) || { country, currency, conversions: 0, payout: 0, approvedPayout: 0, approved: 0, rejected: 0 };
      countryItem.conversions++; countryItem.payout += row.payout || 0;
      if (row.status === 'approved') { countryItem.approved++; countryItem.approvedPayout += row.payout || 0; }
      if (row.status === 'rejected') countryItem.rejected++;
      countries.set(countryKey, countryItem);
      const key = [page, video, row.campaignId || '', currency, country].join('|');
      const item = grouped.get(key) || { page, video, country, campaignId: row.campaignId, campaignName: row.campaignName, conversions: 0, payout: 0, approvedPayout: 0, currency: row.currency, statuses: {} };
      item.conversions++;
      item.statuses[row.status] = (item.statuses[row.status] || 0) + 1;
      if (row.payout != null) item.payout += row.payout;
      if (row.status === 'approved' && row.payout != null) item.approvedPayout += row.payout;
      grouped.set(key, item);
    }
    const state = read(stateFile, {});
    return { generatedAt: now(), dateFrom, dateTo, balance: state.balance || [], campaigns: state.campaigns || [], totals: { conversions: filtered.length, payoutByCurrency: Object.fromEntries(payoutByCurrency), payoutByStatus: Object.fromEntries(payoutByStatus), status }, byCountry: [...countries.values()].sort((a, b) => b.conversions - a.conversions).slice(0, 100), bySource: [...grouped.values()].sort((a, b) => b.conversions - a.conversions).slice(0, 100), postback: postbackSummary(), lastSync: state };
  }
  function postbackSummary() {
    const rows = Object.values(read(receiptsFile, {}));
    return { receivedLeads: rows.length, lastReceivedAt: rows.reduce((latest, row) => Math.max(latest, row.receivedAt), 0) || null, statuses: rows.reduce((counts, row) => { counts[row.status] = (counts[row.status] || 0) + 1; return counts; }, {}), note: 'Postback receipts are provisional network signals. They are kept separate from API-confirmed account totals to avoid counting one lead twice.' };
  }
  function postbackUrl(origin) {
    const base = new URL(origin);
    if (base.protocol !== 'https:' && !(['localhost','127.0.0.1'].includes(base.hostname) && base.protocol === 'http:')) throw Error('Configure a public HTTPS tracker origin first');
    let config;
    if (fs.existsSync(postbackFile)) {
      config = JSON.parse(fs.readFileSync(postbackFile, 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(config.token || '')) throw Error('Postback key needs recovery');
    } else {
      config = { token: crypto.randomBytes(32).toString('hex'), createdAt: now() };
      safeWrite(postbackFile, config);
    }
    const macros = { lead_id: 'transaction_id', payout_decimal: 'payout_decimal', currency: 'currency', status: 'status', program_id: 'program_id', program_name: 'program_name', program_config_id: 'program_config_id', country_code: 'country_code', ml_sub1: 'ml_sub1', ml_sub2: 'ml_sub2', ml_sub3: 'ml_sub3', ml_sub4: 'ml_sub4', ml_sub5: 'ml_sub5' };
    return { url: base.origin + '/mylead-lead?token=' + config.token + '&' + Object.entries(macros).map(([key, macro]) => key + '=[' + macro + ']').join('&'), ...postbackSummary() };
  }
  let postbackMinute = 0, postbackCount = 0;
  function receivePostback(query) {
    const config = read(postbackFile, {}), supplied = query.get('token') || '';
    if (!/^[a-f0-9]{64}$/.test(config.token || '') || !/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(config.token), Buffer.from(supplied))) return { http: 403, error: 'Invalid postback key' };
    if (query.get('verify') === '1') return { http: 200, ok: true, verificationOnly: true };
    const minute = Math.floor(now() / 60000);
    if (postbackMinute !== minute) { postbackMinute = minute; postbackCount = 0; }
    if (++postbackCount > 300) return { http: 429, error: 'Retry later' };
    const id = query.get('lead_id') || '';
    const rawStatus = query.get('status') || '';
    const decimal = query.get('payout_decimal');
    if (!/^[A-Za-z0-9_.:-]{1,150}$/.test(id) || !rawStatus || rawStatus.length > 80 || /[\[\]{}]/.test(rawStatus)) return { http: 422, error: 'Real transaction ID and substituted status are required' };
    if (decimal === null || !/^-?\d{1,12}(?:\.\d{1,8})?$/.test(decimal)) return { http: 422, error: 'A decimal payout is required' };
    const currency = query.get('currency') || '';
    if (!/^[A-Z]{3}$/.test(currency)) return { http: 422, error: 'A three-letter currency is required' };
    const status = ({ accepted: 'pre_approved', approved: 'approved', pending: 'pending', rejected: 'rejected', pre_approved: 'pre_approved' })[rawStatus.toLowerCase()] || 'unknown';
    const receipt = { id, status, rawStatus: U.sanitizeText(rawStatus, 80), payout: Number(decimal), currency, campaignId: U.sanitizeText(query.get('program_id') || '', 100), campaignName: U.sanitizeText(query.get('program_name') || '', 180), country: U.sanitizeText(query.get('country_code') || '', 12), sub: [1,2,3,4,5].map(n => U.sanitizeText(query.get('ml_sub'+n) || '', 180)) };
    const rows = read(receiptsFile, {}), key = crypto.createHash('sha256').update(id).digest('hex');
    const previous = rows[key];
    const hash = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
    if (previous?.hash === hash) return { http: 200, ok: true, duplicate: true };
    if (!previous && Object.keys(rows).length >= 50000) return { http: 503, error: 'Receipt storage requires maintenance' };
    rows[key] = { ...receipt, firstReceivedAt: previous?.firstReceivedAt || now(), receivedAt: now(), hash };
    safeWrite(receiptsFile, rows);
    return { http: 200, ok: true, updated: !!previous };
  }
  function handlePostback(req, res, url) {
    let result;
    try { result = req.method === 'GET' ? receivePostback(url.searchParams) : { http: 405, error: 'GET required' }; }
    catch (_) { result = { http: 503, error: 'Postback receiver temporarily unavailable' }; }
    res.writeHead(result.http, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const { http, ...body } = result; res.end(JSON.stringify(body));
  }
  // Internal sanitized rows for deterministic click attribution; never a public HTTP endpoint.
  const conversionRows = () => Object.values(read(conversionsFile, {}));
  return { settings, save, verify, sync, report, conversionRows, postbackUrl, receivePostback, handlePostback };
}

module.exports = { createMyLeadIntegration };
