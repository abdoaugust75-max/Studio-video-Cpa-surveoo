(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tab = $('mylead-settings-tab'), panel = $('mylead-settings-panel');
  if (!tab || !panel) return;
  const postbackPanel = document.createElement('section');
  postbackPanel.innerHTML = `<h3>MyLead postback URL</h3><p>Copy this private URL to MyLead → For Webmasters → Postback. Select Any status. The receiver works independently of API login.</p><input id="mylead-postback-url" readonly aria-label="Private MyLead postback URL"><div class="writer-actions"><button type="button" id="mylead-postback-copy" class="soft-button">Copy postback URL</button><a href="/api/v2/mylead/postback-url?download=1">Download URL as text</a></div><p id="mylead-postback-state" role="status"></p>`;
  panel.append(postbackPanel);
  const api = async (url, body) => {
    const response = await fetch(url, body === undefined
      ? { cache: 'no-store', signal: AbortSignal.timeout(30000) }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    if (!response.ok || result.error) throw Error(result.error || 'MyLead request failed');
    return result;
  };
  const message = value => { $('mylead-status').textContent = value; };
  function show() {
    for (const id of ['writer-settings-panel', 'facebook-settings-panel', 'video-settings-panel', 'automation-settings-panel', 'site-integrations-panel']) if ($(id)) $(id).hidden = true;
    for (const id of ['writer-settings-tab', 'facebook-settings-tab', 'video-settings-tab', 'automation-settings-tab', 'site-integrations-tab']) if ($(id)) $(id).classList.remove('active');
    panel.hidden = false; tab.classList.add('active'); $('settings-check').hidden = true;
  }
  async function load() {
    const data = await api('/api/v2/mylead/settings');
    $('mylead-credential-state').textContent = data.configured ? 'Credentials saved on this Studio server · ' + data.usernameHint : 'No MyLead credentials saved.';
    const report = await api('/api/v2/mylead/report');
    renderReport(report);
    const postback = await api('/api/v2/mylead/postback-url');
    $('mylead-postback-url').value = postback.url;
    $('mylead-postback-state').textContent = `${postback.receivedLeads} distinct lead receipts received. Postback signals are shown separately from API-confirmed totals.`;
  }
  function renderReport(data) {
    const root = $('mylead-report'); root.replaceChildren();
    const totals = data.totals || {};
    const summary = document.createElement('p');
    const payoutText = Object.entries(totals.payoutByCurrency || {}).map(([currency, amount]) => `${Number(amount).toFixed(2)} ${currency}`).join(' · ') || 'no payout records';
    summary.textContent = `${totals.conversions || 0} conversions · recorded payouts: ${payoutText} · last sync: ${data.lastSync?.status === 'success' ? new Date(data.lastSync.lastSyncAt).toLocaleString() : 'not synced yet'}`;
    root.append(summary);
    for (const balance of data.balance || []) {
      const line = document.createElement('p');
      line.textContent = `MyLead balance (${balance.currency || ''}) · to pay ${Number(balance.toPay).toFixed(2)} · accepted ${Number(balance.accepted).toFixed(2)} · waiting ${Number(balance.waiting).toFixed(2)}`;
      root.append(line);
    }
    const counts = document.createElement('p');
    counts.textContent = Object.entries(totals.status || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No status totals yet.';
    root.append(counts);
    const statusPayouts = document.createElement('p');
    statusPayouts.textContent = 'Payout by lead status: ' + (Object.entries(totals.payoutByStatus || {}).map(([key, value]) => `${key.replace('|', ' / ')} ${Number(value).toFixed(2)}`).join(' · ') || 'not available yet');
    root.append(statusPayouts);
    const countryHeading = document.createElement('h4'); countryHeading.textContent = 'Results by country'; root.append(countryHeading);
    for (const row of (data.byCountry || []).slice(0, 20)) {
      const item = document.createElement('p');
      item.textContent = `${row.country} · ${row.conversions} leads · approved ${row.approved} · rejected ${row.rejected} · approved payout ${row.approvedPayout.toFixed(2)} ${row.currency}`;
      root.append(item);
    }
    for (const row of data.bySource || []) {
      const item = document.createElement('p');
      item.textContent = `${row.page} · ${row.video} · ${row.country} · ${row.campaignName || row.campaignId || 'Campaign not identified'} · ${row.conversions} conversions · approved payout ${row.approvedPayout.toFixed(2)} ${row.currency || ''}`;
      root.append(item);
    }
    const campaigns = document.createElement('details');
    const heading = document.createElement('summary'); heading.textContent = `Synced offer rules and campaigns (${(data.campaigns || []).length})`; campaigns.append(heading);
    for (const offer of (data.campaigns || []).slice(0, 100)) {
      const item = document.createElement('p');
      const payments = offer.payments.map(p => `${p.title}: ${p.revenue == null ? 'payout unavailable' : p.revenue + ' ' + p.currency}`).join(', ');
      const countries = offer.countries.map(c => c.code || c.name).filter(Boolean).join(', ');
      const traffic = offer.trafficTypes.map(t => t.name).filter(Boolean).join(', ');
      const caps = offer.caps.map(c => `${c.type} ${c.leadLimit}${c.limitUsed ? ' (used)' : ''}`).join(', ');
      const restrictions = offer.restrictions.join('; ');
      const description = offer.shortDescription.en || offer.shortDescription.es || offer.description.en || '';
      item.textContent = `${offer.name} · ${offer.status || 'available'} · MyLead EPC ${offer.epc == null ? 'n/a' : offer.epc} · MyLead CR ${offer.cr == null ? 'n/a' : offer.cr}${payments ? ' · ' + payments : ''}${countries ? ' · Countries: ' + countries : ''}${traffic ? ' · Traffic: ' + traffic : ''}${caps ? ' · Caps: ' + caps : ''}${restrictions ? ' · Rules: ' + restrictions : ''}${description ? ' · ' + description.slice(0, 320) : ''}`;
      campaigns.append(item);
    }
    if ((data.campaigns || []).length) root.append(campaigns);
  }
  tab.addEventListener('click', () => { show(); load().catch(error => message(error.message)); });
  $('mylead-postback-copy').addEventListener('click', async () => {
    const input = $('mylead-postback-url');
    if (!input.value) return;
    try { await navigator.clipboard.writeText(input.value); $('mylead-postback-state').textContent = 'Copied. Paste into MyLead and select Any status.'; }
    catch (_) { input.focus(); input.select(); $('mylead-postback-state').textContent = 'Select and copy the URL, or use Download URL as text.'; }
  });
  window.addEventListener('DOMContentLoaded', () => {
    if(location.hash === '#mylead') { document.querySelector('[data-view="settings"]')?.click(); tab.click(); }
  });
  for (const id of ['writer-settings-tab', 'facebook-settings-tab', 'video-settings-tab', 'automation-settings-tab']) {
    $(id)?.addEventListener('click', () => { panel.hidden = true; tab.classList.remove('active'); });
  }
  $('mylead-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('mylead-save'); button.disabled = true; message('Saving credentials securely on the Studio server…');
    try {
      const data = await api('/api/v2/mylead/settings', { username: $('mylead-username').value.trim() || undefined, password: $('mylead-password').value || undefined });
      $('mylead-password').value = '';
      $('mylead-credential-state').textContent = 'Credentials saved on this Studio server · ' + data.usernameHint;
      message('Saved. Next, verify access.');
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  $('mylead-verify').addEventListener('click', async () => {
    $('mylead-verify').disabled = true; message('Checking MyLead login and read-only balance access…');
    try { const result = await api('/api/v2/mylead/verify', {}); message(result.message); }
    catch (error) { message(error.message); }
    finally { $('mylead-verify').disabled = false; }
  });
  $('mylead-sync').addEventListener('click', async () => {
    const button = $('mylead-sync'); button.disabled = true; message('Reading MyLead conversions…');
    try {
      const result = await api('/api/v2/mylead/sync', { dateFrom: $('mylead-from').value, dateTo: $('mylead-to').value });
      message(`${result.rowsFetched} conversions updated. Sensitive IP and user-agent fields were discarded.`);
      renderReport(await api('/api/v2/mylead/report'));
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  const today = new Date(), from = new Date(today.getTime() - 30 * 86400000);
  $('mylead-to').value = today.toISOString().slice(0, 10); $('mylead-from').value = from.toISOString().slice(0, 10);
})();
