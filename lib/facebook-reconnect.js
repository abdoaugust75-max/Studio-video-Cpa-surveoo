'use strict';
const fs = require('fs');
const path = require('path');
const { PROFILES } = require('./campaign-profiles');

// Refresh only identities already mapped to the seven campaign profiles.
// Never return credentials, widen destination permissions, or save an unverified token.
function createFacebookReconnect({ file }) {
  async function graph(resource, token) {
    const response = await fetch('https://graph.facebook.com/v21.0/' + resource, {
      headers: { Authorization: 'OAuth ' + token }, signal: AbortSignal.timeout(25000) });
    const body = await response.json();
    if (!response.ok || body.error) {
      const error = new Error(body.error?.code === 190 ? 'Facebook session expired or invalidated. Sign in to Meta and generate a fresh token for the same app.' : 'Facebook rejected the request. Check the existing app permissions.');
      error.code = body.error?.code; error.subcode = body.error?.error_subcode; throw error;
    }
    return body;
  }
  async function reconnect(token, pageKey) {
    if (!/^[A-Za-z0-9_-]{30,4096}$/.test(String(token || ''))) throw Error('Enter a valid Facebook access token in this local form.');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = new Set(PROFILES.filter(profile => !pageKey || profile.key === pageKey).map(profile => profile.key));
    const destinationIds=new Set();
    for(const key of keys){
      try{const page=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'studio','pages',key+'.json'),'utf8'));for(const d of page.allowedDestinations || [])if(d.enabled!==false&&(!d.platform||d.platform==='facebook'))destinationIds.add(String(d.id));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const allowed = cfg.pages.filter(p => keys.has(p.brand) || (!p.brand && destinationIds.has(String(p.id))));
    if (!allowed.length) throw Error('No existing campaign page selected.');
    const identity = await graph('me?fields=id,name', token);
    let remote = allowed.some(p => String(p.id) === String(identity.id)) ? [{ ...identity, access_token: token }] : [];
    if (!remote.length) {
      let next = 'me/accounts?fields=id,name,access_token&limit=100';
      for (let i = 0; next && i < 10; i++) {
        const result = await graph(next, token); remote.push(...(result.data || []));
        // Build the next request locally, never follow a token-bearing URL from the response.
        next = result.paging?.next && result.paging?.cursors?.after ? 'me/accounts?fields=id,name,access_token&limit=100&after=' + encodeURIComponent(result.paging.cursors.after) : null;
      }
    }
    const verified = [], missing = [];
    for (const page of allowed) {
      const match = remote.find(p => String(p.id) === String(page.id));
      if (!match?.access_token) { missing.push({ id: page.id, name: page.name }); continue; }
      const check = await graph('me?fields=id,name', match.access_token);
      if (String(check.id) !== String(page.id)) throw Error('Facebook returned a different page identity. Nothing saved.');
      verified.push({ id: page.id, name: check.name, token: match.access_token });
    }
    if (!verified.length) throw Error('This token does not grant access to the existing selected pages. Nothing saved.');
    // Reload after network I/O so unrelated configuration edits are preserved.
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of verified) {
      const page = latest.pages.find(p => String(p.id) === String(item.id));
      if (!page || !allowed.some(p => p.id === page.id && p.brand === page.brand)) throw Error('Page mapping changed. Retry the connection.');
      page.page_token = item.token; page.name = item.name; page.token_verified_at = Date.now();
    }
    if (!allowed.some(p => String(p.id) === String(identity.id))) latest.user_token = token;
    const temp = file + '.refresh.tmp'; fs.writeFileSync(temp, JSON.stringify(latest, null, 2)); fs.renameSync(temp, file);
    return { ok: true, updated: verified.map(p => ({ id: p.id, name: p.name })), missing, checkedAt: Date.now() };
  }
  return { reconnect };
}
module.exports = { createFacebookReconnect };
