(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const panel = $('mylead-settings-panel');
  if (!panel) return;
  const section = document.createElement('section');
  section.id = 'site-tracking-panel';
  section.innerHTML = `<hr><h3>Website → offer click → approved lead</h3>
    <p>Configure each website once. Darija websites share a market group; Arabic and English stay separate. Each social page and video keeps its own results.</p>
    <div class="writer-settings-grid"><form id="tracking-form">
      <label for="tracking-public-url">Public Studio tracker origin · HTTPS</label><input id="tracking-public-url" type="url" placeholder="https://your-studio-domain.example">
      <label for="tracking-site-select">Website configuration</label><div class="writer-actions"><select id="tracking-site-select"></select><button type="button" id="tracking-new" class="soft-button">Add website</button></div>
      <label for="tracking-id">Website identifier</label><input id="tracking-id" required pattern="[A-Za-z0-9_-]{1,100}" maxlength="100">
      <label for="tracking-label">Website label</label><input id="tracking-label" maxlength="100">
      <label for="tracking-market">Market group</label><select id="tracking-market"><option value="morocco_darija">Morocco · Darija</option><option value="arabic">Arabic · Al-Shihna</option><option value="english">English · Vouch Teck</option></select>
      <label for="tracking-origins">Allowed website origins · one per line</label><textarea id="tracking-origins" rows="2" required placeholder="https://your-landing-domain.example"></textarea>
      <label for="tracking-landing">Full landing page URL</label><input id="tracking-landing" type="url" placeholder="https://your-landing-domain.example/offer/">
      <label for="tracking-offer">Existing MyLead offer link</label><input id="tracking-offer" type="url" autocomplete="off" placeholder="Paste the offer link from your MyLead account">
      <label for="tracking-offers">More than one offer · one JSON object per line, optional</label><textarea id="tracking-offers" rows="3" placeholder='{"id":"surveoo","url":"https://...","campaign":"surveoo"}'></textarea>
      <label for="tracking-campaign">Campaign identifier · optional</label><input id="tracking-campaign" pattern="[A-Za-z0-9_-]{0,100}" maxlength="100">
      <label><input id="tracking-enabled" type="checkbox"> Accept visits and offer clicks for this site</label>
      <div class="writer-actions"><button class="primary" type="submit" id="tracking-save">Save website tracking</button><button type="button" class="soft-button" id="tracking-refresh">Refresh report</button></div>
      <p id="tracking-status" role="status"></p>
    </form><aside class="mix-guide"><h3>Install on the landing page</h3>
      <p>After saving, add this script to the site and mark offer buttons with <code>data-studio-offer</code>. Keep their existing offer href as a fallback.</p>
      <label for="tracking-page">Default page · leave unknown for shared traffic</label><select id="tracking-page"></select>
      <label for="tracking-variant">Landing variant</label><input id="tracking-variant" value="default" pattern="[A-Za-z0-9_-]{1,100}" maxlength="100">
      <pre id="tracking-snippet" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <p>New Studio captions receive page/video tags only when their configured website matches one enabled tracking site. A shared bio link cannot identify a video by itself.</p>
      <p>The script sends no cookies, IP, full page URL or browser fingerprint. The tracker needs public HTTPS access. Dashboard settings and credentials remain authenticated.</p>
      <p>Saving here does not install the script on Cloudflare, activate posting, or validate an offer's traffic rules.</p>
    </aside></div><h3>Recorded funnel · UTC visit cohorts</h3><div id="tracking-report" class="copy-box">No tracking report loaded.</div>`;
  panel.append(section);
  let config = { sites: [], profiles: [] };
  const message = text => { $('tracking-status').textContent = text; };
  async function api(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Tracking request failed');
    return value;
  }
  function selected() { return config.sites.find(s => s.id === $('tracking-site-select').value); }
  function options() {
    const previous = $('tracking-page').value;
    $('tracking-page').replaceChildren(new Option('Unknown / shared traffic', ''));
    for (const profile of config.profiles.filter(p => p.market === $('tracking-market').value)) $('tracking-page').append(new Option(profile.key, profile.key));
    if ([...$('tracking-page').options].some(o => o.value === previous)) $('tracking-page').value = previous;
  }
  function snippet() {
    const site = selected();
    if (!site || !config.publicBaseUrl) { $('tracking-snippet').textContent = 'Save a site and public tracker origin first.'; return; }
    const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const page = $('tracking-page').value;
    const variant = /^[A-Za-z0-9_-]{1,100}$/.test($('tracking-variant').value) ? $('tracking-variant').value : 'default';
    $('tracking-snippet').textContent = `<script defer src="${escape(config.publicBaseUrl)}/track/client.js" data-site="${escape(site.id)}"${page ? ` data-page="${escape(page)}"` : ''} data-variant="${variant}"></script>\n\n<!-- Give each offer link its saved offer id, e.g. <a data-studio-offer="surveoo">. -->`;
  }
  function fill(site) {
    for (const [id, key] of [['id','id'],['label','label'],['landing','landingUrl'],['offer','offerUrl'],['campaign','campaign']]) $('tracking-' + id).value = site?.[key] || '';
    $('tracking-id').readOnly = !!site;
    $('tracking-market').value = site?.market || 'morocco_darija';
    $('tracking-origins').value = (site?.origins || []).join('\n');
    $('tracking-offers').value = (site?.offers || []).map(x => JSON.stringify(x)).join('\n');
    $('tracking-enabled').checked = site?.enabled === true;
    options(); snippet();
  }
  async function load() {
    const previous = $('tracking-site-select').value;
    config = await api('/api/v2/tracking/settings');
    $('tracking-public-url').value = config.publicBaseUrl || '';
    $('tracking-site-select').replaceChildren(new Option('New website', ''));
    for (const site of config.sites) $('tracking-site-select').append(new Option(site.label + (site.enabled ? ' · enabled' : ' · draft'), site.id));
    $('tracking-site-select').value = config.sites.some(s => s.id === previous) ? previous : config.sites[0]?.id || '';
    fill(selected());
    await report();
  }
  async function report() {
    const query = new URLSearchParams();
    for (const [key, id] of [['dateFrom', 'mylead-from'], ['dateTo', 'mylead-to']]) if ($(id)?.value) query.set(key, $(id).value);
    const data = await api('/api/v2/tracking/report?' + query);
    const root = $('tracking-report'); root.replaceChildren();
    const text = value => { const p = document.createElement('p'); p.textContent = value; root.append(p); };
    const money = row => Object.entries(row.approvedPayout || {}).map(([c, a]) => `${Number(a).toFixed(2)} ${c}`).join(' · ') || 'no approved payout';
    text(`${data.dateFrom} → ${data.dateTo} · ${data.totals.visits} page loads · ${data.totals.offerClicks} unique offer clicks · ${data.totals.leads} linked leads · ${money(data.totals)}`);
    if (data.totals.unavailableApprovedPayouts) text(`${data.totals.unavailableApprovedPayouts} approved leads have no usable payout/currency; revenue figures are incomplete.`);
    for (const [dimension, rows] of Object.entries(data.groups || {})) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = `${dimension} (${rows.length})`; details.append(summary);
      for (const row of rows) {
        const p = document.createElement('p');
        p.textContent = `${row.key}: ${row.visits} visits · ${row.offerClicks} clicks · ${row.leads} leads · ${row.statuses.approved || 0} approved · ${money(row)} · approved clicks/clicks ${row.clickToApprovedRate == null ? 'unknown' : (row.clickToApprovedRate * 100).toFixed(1) + '%'}`;
        details.append(p);
      }
      root.append(details);
    }
    text(`${data.unmatchedConversions} synced conversions have no matching click in this visit cohort. ${data.metadataMismatches} metadata mismatches; the saved click receipt determines attribution.`);
    text(data.note);
  }
  $('tracking-site-select').addEventListener('change', () => fill(selected()));
  $('tracking-new').addEventListener('click', () => { $('tracking-site-select').value = ''; fill(null); });
  $('tracking-market').addEventListener('change', () => { options(); snippet(); });
  $('tracking-page').addEventListener('change', snippet);
  $('tracking-variant').addEventListener('input', snippet);
  $('tracking-form').addEventListener('submit', async event => {
    event.preventDefault(); $('tracking-save').disabled = true;
    try {
      const id = $('tracking-id').value.trim();
      const offers = $('tracking-offers').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => JSON.parse(line));
      await api('/api/v2/tracking/settings', { publicBaseUrl: $('tracking-public-url').value.trim(), site: { id, label: $('tracking-label').value, market: $('tracking-market').value, origins: $('tracking-origins').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean), landingUrl: $('tracking-landing').value.trim(), offerUrl: $('tracking-offer').value.trim(), offers, campaign: $('tracking-campaign').value.trim(), enabled: $('tracking-enabled').checked } });
      $('tracking-site-select').append(new Option(id, id)); $('tracking-site-select').value = id;
      await load(); message('Saved. Install the script on the landing page before expecting visits here.');
    } catch (error) { message(error.message); }
    finally { $('tracking-save').disabled = false; }
  });
  $('tracking-refresh').addEventListener('click', () => report().catch(e => message(e.message)));
  $('mylead-settings-tab')?.addEventListener('click', () => load().catch(e => message(e.message)));
})();
