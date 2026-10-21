// lib/publish.js — publishing with hard brand isolation.
//
// The single most dangerous thing this application can do is post the wrong brand's video to the
// wrong page. So publishing is split in two, and the second half cannot run without the first:
//
//   plan()   — resolves artifact → page agent → allowed destination, and REFUSES anything that does
//              not line up. Returns a confirmation summary plus a token over exactly those inputs.
//   execute() — requires that token. A destination the owner approved and a destination that gets
//              posted are therefore the same list, checked twice against the page's own permission
//              record (and again against the linked Facebook page's brand).
//
// The permission check lives HERE, not in the UI: filtering the dropdown is a convenience, not a
// guarantee.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

const APP_VERSION = 'v21.0';
// Multipart descriptions are plain text, not shell arguments. Preserve URL query
// separators and line breaks so source attribution survives publication.
const captionForPost = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 5000);

function createPublish(o) {
  const store = o.store;
  const log = o.log || (() => {});
  const activity = o.activity || (() => {});
  const accounts = o.accounts || (() => []);      // legacy Facebook pages: [{id,name,brand,page_token}]
  const appVersion = o.appVersion || APP_VERSION;

  /** The destinations the owner has actually authorised for this agent. */
  function allowed(pageKey) {
    const p = store.page(pageKey);
    const list = Array.isArray(p.allowedDestinations) ? p.allowedDestinations : [];
    const ids = new Set(list.map(d => String(d.id)));
    // The legacy link (fbPages whose brand === page key) is folded in so an existing install keeps
    // working, but it is recorded as authorised-by-account rather than authorised-by-owner.
    const legacy = accounts().filter(a => a.brand === pageKey)
      .filter(a => !ids.has(String(a.id)))
      .map(a => ({ id: String(a.id), name: a.name, platform: 'facebook', source: 'account-link', enabled: true }));
    return [...list.map(d => ({ platform: 'facebook', enabled: true, source: 'owner', ...d })), ...legacy];
  }

  /** Is this destination explicitly authorised for this page agent? */
  function authorise(pageKey, destinationId) {
    const list = allowed(pageKey);
    const hit = list.find(d => String(d.id) === String(destinationId));
    if (!hit) {
      return { ok: false, error: 'this destination is not authorised for this page agent — add it in Settings → Page Agents first', allowed: list };
    }
    if (hit.enabled === false) return { ok: false, error: 'that destination is disabled for this page agent', allowed: list };
    const acct = accounts().find(a => String(a.id) === String(destinationId));
    if (!acct) return { ok: false, error: 'the platform account for that destination is not connected', allowed: list };
    // Belt and braces: the connected account's own brand must match the page agent that owns the
    // artifact. An account linked to another brand can never be posted to from here, even if it was
    // somehow added to the allowed list.
    if (acct.brand && acct.brand !== pageKey) {
      return { ok: false, error: 'that page belongs to a different brand (' + acct.brand + ') — an agent may only post to its own pages', allowed: list };
    }
    if (!acct.page_token) return { ok: false, error: 'no access token is stored for that page', allowed: list };
    return { ok: true, destination: { id: String(acct.id), name: acct.name, platform: 'facebook' } };
  }

  /** Resolve one artifact to a page agent + a real file on disk. */
  function resolveArtifact(artifactId) {
    const art = store.artifact(artifactId);
    if (!art) return { ok: false, error: 'unknown artifact: ' + artifactId };
    const project = store.project(art.project);
    if (!project) return { ok: false, error: 'the project behind artifact ' + artifactId + ' no longer exists' };
    if (art.kind !== 'video') return { ok: false, error: art.label + ' is ' + art.kind + ', not a video — only video artifacts can be posted' };
    if (!fs.existsSync(art.file)) return { ok: false, error: 'the file for ' + art.label + ' is missing on disk' };
    if (!project.approvedArtifact) return { ok: false, error: 'this project has no approved video — approve the final artifact before publishing' };
    if (project.approvedArtifact !== art.id) return { ok: false, error: 'artifact ' + art.id + ' is not the exact approved artifact (' + project.approvedArtifact + ')' };
    return { ok: true, artifact: art, project, pageKey: project.page };
  }

  /** Verify the platform object after an accepted upload without ever exposing its access token. */
  async function verifyPublished(postId, pageToken) {
    const checkedAt = Date.now();
    try {
      const r = await fetch('https://graph.facebook.com/' + appVersion + '/' + encodeURIComponent(postId) + '?fields=id', {
        headers: { Authorization: 'OAuth ' + pageToken }, signal: AbortSignal.timeout(30000),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body && String(body.id) === String(postId)) return { checkedAt, verified: true, objectId: String(body.id) };
      return { checkedAt, verified: false, error: U.sanitizeText((body && body.error && body.error.message) || ('platform verification returned HTTP ' + r.status), 180) };
    } catch (e) {
      return { checkedAt, verified: false, error: U.sanitizeText(e.message, 180) };
    }
  }
  async function checkConnection(pageKey, destinationId) {
    const auth = authorise(pageKey, destinationId);
    if (!auth.ok) return { ok: false, checkedAt: Date.now(), error: auth.error };
    const acct = accounts().find(a => String(a.id) === String(destinationId));
    try {
      const response = await fetch('https://graph.facebook.com/' + appVersion + '/' + encodeURIComponent(acct.id) + '?fields=id,name,can_post', {
        headers: { Authorization: 'OAuth ' + acct.page_token }, signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      return { ok: response.ok && String(body.id) === String(acct.id), checkedAt: Date.now(), pageId: String(acct.id), pageName: body.name || acct.name,
        http: response.status, code: body.error?.code || null, subcode: body.error?.error_subcode || null,
        error: body.error ? U.sanitizeText(body.error.message, 250) : null,canPost:typeof body.can_post==='boolean'?body.can_post:null, publishPermissionVerified: false };
    } catch (error) { return { ok: false, checkedAt: Date.now(), pageId: String(acct.id), pageName: acct.name, error: U.sanitizeText(error.message, 200) }; }
  }
  async function checkVideo(pageKey, destinationId, postId) {
    const auth = authorise(pageKey, destinationId);
    if (!auth.ok) return { ok: false, error: auth.error, checkedAt: Date.now() };
    const acct = accounts().find(a => String(a.id) === String(destinationId));
    try {
      const response = await fetch('https://graph.facebook.com/' + appVersion + '/' + encodeURIComponent(postId) + '?fields=id,status,permalink_url', {
        headers: { Authorization: 'OAuth ' + acct.page_token }, signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      return { ok: response.ok && String(body.id) === String(postId), checkedAt: Date.now(), status: body.status || null,
        permalink: body.permalink_url ? new URL(body.permalink_url, 'https://www.facebook.com').href : null,
        error: body.error ? U.sanitizeText(body.error.message, 200) : null };
    } catch (error) { return { ok: false, checkedAt: Date.now(), error: U.sanitizeText(error.message, 200) }; }
  }

  /**
   * plan — what WOULD happen, with every refusal explained. Pure: nothing is posted, nothing is
   * written except the activity record.
   */
  function plan(opts) {
    opts = opts || {};
    const artifactIds = (opts.artifacts || []).map(String).filter(Boolean);
    if (!artifactIds.length) return { ok: false, error: 'select at least one video to post' };
    const requested = (opts.destinations || []).map(String).filter(Boolean);
    if (!requested.length) return { ok: false, error: 'choose at least one destination' };

    const items = [];
    for (const id of artifactIds) {
      const r = resolveArtifact(id);
      if (!r.ok) { items.push({ artifact: id, ok: false, error: r.error, pageAgent: null, destination: null }); continue; }
      const { artifact, project, pageKey } = r;
      for (const destId of requested) {
        const a = authorise(pageKey, destId);
        items.push({
          artifact: id, artifactLabel: artifact.label, project: project.id, projectTitle: project.title,
          pageAgent: { key: pageKey, label: store.page(pageKey).label },
          destination: a.ok ? a.destination : { id: destId, name: (allowed(pageKey).find(d => String(d.id) === destId) || {}).name || destId },
          ok: !!a.ok, error: a.ok ? null : a.error,
        });
      }
    }
    const postable = items.filter(i => i.ok);
    const blocked = items.filter(i => !i.ok);
    const token = U.hash16(JSON.stringify({ a: artifactIds.slice().sort(), d: requested.slice().sort() }));
    const result = {
      ok: postable.length > 0,
      token,
      items,
      postable: postable.length,
      blocked: blocked.length,
      // One line per artifact → destination: exactly what the owner confirms.
      summary: postable.map(i => i.artifactLabel + '  →  ' + i.pageAgent.label + ' · ' + i.destination.name),
      blockedSummary: blocked.map(i => (i.artifactLabel || i.artifact) + '  →  ' + (i.destination ? i.destination.name : '?') + ' : ' + i.error),
      dryRun: true,
      note: 'Nothing has been posted. Confirming posts exactly the video/destination pairs listed here.',
    };
    activity({ type: 'model.call', kind: 'publish', label: 'Publish plan', task: 'publish.plan', capability: 'publish', status: result.ok ? 'ok' : 'blocked', ms: 0, artifacts: artifactIds.length, postable: postable.length, blocked: blocked.length });
    return result;
  }

  /**
   * execute — post the planned pairs. Requires the token from the plan the owner actually saw, so a
   * changed selection cannot be posted under an old confirmation.
   */
  async function execute(opts) {
    if(o.hold?.())throw Error('Publication paused by the owner: tests only; no upload is allowed.');
    opts = opts || {};
    const fresh = plan(opts);
    if (!fresh.ok) return { ok: false, attempted: false, error: fresh.error || 'nothing can be posted from this selection', plan: fresh };
    if (!opts.token || opts.token !== fresh.token) {
      // Nothing was sent: this is a client-side confirmation problem, so it is an error the caller can
      // fix, not a server failure. `attempted` is what lets the route pick the right status code.
      return { ok: false, attempted: false, error: 'the confirmation does not match this selection — review the summary and confirm again', plan: fresh };
    }
    if (opts.confirm !== true) return { ok: false, attempted: false, error: 'publishing requires an explicit confirmation', plan: fresh };

    const results = [];
    for (const item of fresh.items.filter(i => i.ok && (!opts.retryPairs || opts.retryPairs.includes(i.artifact + "|" + i.destination.id)))) {
      const art = store.artifact(item.artifact);
      const acct = accounts().find(a => String(a.id) === String(item.destination.id));
      // Re-checked at the moment of posting: the plan was made seconds ago, but this is the last gate
      // before something becomes public and it costs nothing to be certain.
      const again = authorise(item.pageAgent.key, item.destination.id);
      if (!again.ok) { results.push({ ...item, ok: false, error: 're-check refused: ' + again.error }); continue; }
      const pairKey = item.artifact + '|' + item.destination.id;
      const before = store.project(item.project);
      const previous = before.publishPairs?.[pairKey] || (before.publish || []).flatMap(b => b.results || []).find(r => r.ok && r.artifact === item.artifact && String(r.destination?.id) === String(item.destination.id));
      if (previous?.postId) { results.push({ ...item, ...previous, ok: true, reused: true }); continue; }
      if (previous && ['uploading', 'unknown'].includes(previous.status)) { results.push({ ...item, ok: false, unknown: true, error: 'Previous upload needs verification on Facebook; automatic retry blocked' }); continue; }
      const lock = art.file + '.publish-' + item.destination.id + '.lock';
      let claim;
      try { claim = fs.openSync(lock, 'wx'); } catch (_) { results.push({ ...item, ok: false, unknown: true, error: 'Upload already claimed; inspect Facebook before clearing claim' }); continue; }
      const record = value => { const current = store.project(item.project); current.publishPairs = { ...(current.publishPairs || {}), [pairKey]: value }; store.saveProject(current); };
      try {
        const project = store.project(item.project);
        const caption = captionForPost((project && project.caption) || project.title || '');
        const form = new FormData();
        form.append('source', new Blob([fs.readFileSync(art.file)]), path.basename(art.file));
        form.append('description', caption);
        record({ status: 'uploading', at: Date.now() });
        const r = await fetch('https://graph.facebook.com/' + appVersion + '/' + acct.id + '/videos', {
          method: 'POST', headers: { Authorization: 'OAuth ' + acct.page_token }, body: form, signal: AbortSignal.timeout(600000),
        });
        const out = await r.json();
        if (out && out.id) {
          const acceptedAt=Date.now();
          record({ status: 'published', postId: String(out.id), at: acceptedAt });
          const acceptedProject=store.project(item.project);
          if(!(acceptedProject.posts || []).some(p=>String(p.post_id)===String(out.id))) {
            acceptedProject.posts=[...(acceptedProject.posts || []),{artifact:item.artifact,platform:'facebook',page_id:item.destination.id,page:item.destination.name,post_id:String(out.id),published_at:acceptedAt,verification:null}];
            store.saveProject(acceptedProject);
          }
          const verification = await verifyPublished(out.id, acct.page_token);
          results.push({ ...item, ok: true, postId: out.id, at: Date.now(), verification });
          log('info', 'publish.posted', { artifact: item.artifact, page: item.pageAgent.key, destination: item.destination.name, post: out.id });
        } else {
          record({ status: r.status >= 500 ? 'unknown' : 'failed', at: Date.now() });
          results.push({ ...item, ok: false, unknown: r.status >= 500, error: (out && out.error && out.error.message) || JSON.stringify(out).slice(0, 200) });
        }
      } catch (e) {
        record({ status: 'unknown', at: Date.now() });
        results.push({ ...item, ok: false, unknown: true, error: U.sanitizeText(e.message, 200) });
      } finally { fs.closeSync(claim); fs.unlinkSync(lock); }
    }

    // Record the outcome on each project so Performance can track the post it created.
    const byProject = new Map();
    for (const r of results) byProject.set(r.project, [...(byProject.get(r.project) || []), r]);
    for (const [projectId, list] of byProject) {
      const p = store.project(projectId);
      if (!p) continue;
      p.publish = [...(p.publish || []), { at: Date.now(), results: list }];
      p.posts = [...(p.posts || []), ...list.filter(r => r.ok && !(p.posts || []).some(p => String(p.post_id) === String(r.postId))).map(r => ({
        artifact: r.artifact, platform: 'facebook', page_id: r.destination.id, page: r.destination.name, post_id: r.postId, published_at: r.at, verification: r.verification || null,
      }))];
      p.posts=p.posts.map(post=>{const accepted=list.find(r=>r.ok && String(r.postId)===String(post.post_id));return accepted?.verification?{...post,verification:accepted.verification}:post;});
      p.status = list.every(r => r.ok) ? 'published' : (list.some(r => r.ok) ? 'partially_published' : 'publish_failed');
      p.publishedArtifacts = [...new Set([...(p.publishedArtifacts || []), ...list.filter(r => r.ok).map(r => r.artifact)])];
      for (const r of list.filter(r => r.ok)) {
        if (p.source && p.source.url) store.markSourceUsed({ url: p.source.url, platformId: p.source.meta && p.source.meta.id, project: p.id, page: p.page, artifact: r.artifact, publishedArtifact: r.artifact, reason: 'published' });
      }
      store.saveProject(p);
    }
    const posted = results.filter(r => r.ok).length;
    activity({ type: 'model.call', kind: 'publish', label: 'Published ' + posted + '/' + results.length, task: 'publish.execute', capability: 'publish', status: posted ? 'ok' : 'failed', ms: 0, posted, failed: results.length - posted });
    // attempted: true — real requests were made to the platform. A failure here is a genuine upstream
    // failure, which is a different thing from a refused confirmation.
    return { ok: posted > 0, attempted: true, posted, failed: results.length - posted, results, note: 'Recorded against each project so Performance can follow the post.' };
  }

  /** Destinations the UI may offer for this page agent — already filtered by permission. */
  /** Retry only destination pairs that were durably recorded as failed. No render is repeated. */
  function retryFailed(opts) {
    opts = opts || {};
    const confirmed = plan(opts);
    if (opts.confirm !== true || opts.token !== confirmed.token) return { ok: false, attempted: false, error: 'Review and confirm the retry selection first' };
    const requested = new Set((opts.destinations || []).map(String).filter(Boolean));
    const artifacts = (opts.artifacts || []).map(String).filter(Boolean);
    const pairs = [];
    for (const summary of store.listProjects()) {
      const project = store.project(summary.id);
      if (!project) continue;
      if (artifacts.length && !artifacts.some(id => project.artifacts && project.artifacts.includes(id))) continue;
      for (const batch of (project.publish || [])) for (const result of (batch.results || [])) {
        if (result.ok || !result.artifact || !result.destination) continue;
        if (artifacts.length && !artifacts.includes(String(result.artifact))) continue;
        if (requested.size && !requested.has(String(result.destination.id))) continue;
        const key = String(result.artifact) + '|' + String(result.destination.id);
        if (!pairs.some(p => p.key === key)) pairs.push({ key, artifact: String(result.artifact), destination: String(result.destination.id) });
      }
    }
    if (!pairs.length) return { ok: false, attempted: false, error: 'no durable failed destination pairs found to retry' };
    const selection = { artifacts: [...new Set(pairs.map(p => p.artifact))], destinations: [...new Set(pairs.map(p => p.destination))] };
    return execute({ ...opts, ...selection, token: plan(selection).token, retryPairs: pairs.map(p => p.key) });
  }

  function destinations(pageKey) {
    const list = allowed(pageKey);
    return list.map(d => {
      const acct = accounts().find(a => String(a.id) === String(d.id));
      const a = authorise(pageKey, d.id);
      return { id: String(d.id), name: d.name, platform: d.platform || 'facebook', enabled: d.enabled !== false, source: d.source || 'owner', postable: !!a.ok, reason: a.ok ? null : a.error, connected: !!acct };
    });
  }

  async function metrics(pageKey, destinationId, postId) {
    const auth = authorise(pageKey, destinationId);
    const result = { ok: false, likes: null, comments: null, shares: null, views: null, checkedAt: Date.now() };
    if (!auth.ok) return { ...result, error: auth.error };
    const acct = accounts().find(a => String(a.id) === String(destinationId));
    try {
      const response = await fetch('https://graph.facebook.com/' + appVersion + '/' + encodeURIComponent(postId) + '?fields=id,views,likes.limit(0).summary(true),comments.limit(0).summary(true),shares', {
        headers: { Authorization: 'OAuth ' + acct.page_token }, signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      if (!response.ok || body.error) return { ...result, error: 'Facebook metrics unavailable (HTTP ' + response.status + ')' };
      return { ...result, ok: true, views:Number.isFinite(body.views)?body.views:null, viewsMetric:'Video.views', likes: body.likes?.summary?.total_count ?? null, comments: body.comments?.summary?.total_count ?? null, shares: body.shares?.count ?? null };
    } catch (_) { return { ...result, error: 'Facebook metrics connection failed' }; }
  }
  async function readGraph(pageKey,destinationId,objectPath,params={}){
    const auth=authorise(pageKey,destinationId);if(!auth.ok)throw Error(auth.error);
    const acct=accounts().find(a=>String(a.id)===String(destinationId));
    const url='https://graph.facebook.com/'+appVersion+'/'+objectPath+'?'+new URLSearchParams(params);
    let response;try{response=await fetch(url,{headers:{Authorization:'OAuth '+acct.page_token},signal:AbortSignal.timeout(20000)});}catch(_){throw Error('Meta connection timed out');}
    const body=await response.json();
    if(!response.ok || body.error){const e=Error('Meta read failed (HTTP '+response.status+', code '+(body.error?.code || 'unknown')+'). Check the destination token and permissions.');e.code=body.error?.code;e.subcode=body.error?.error_subcode;throw e;}
    return body;
  }
  async function listVideos(pageKey,destinationId,{limit=100,cursor='',edge='videos'}={}){
    if(!['videos','video_reels'].includes(edge))throw Error('Unsupported video edge');
    const size=Math.max(1,Math.min(100,Number(limit)||100));
    const body=await readGraph(pageKey,destinationId,encodeURIComponent(destinationId)+'/'+edge,{fields:'id,title,description,created_time,permalink_url,length,views',limit:String(size),...(cursor?{after:cursor}:{})});
    return{videos:(body.data || []).map(v=>({id:String(v.id),destinationId:String(destinationId),title:v.title || '',description:v.description || '',createdAt:v.created_time || null,permalink:v.permalink_url || null,duration:v.length ?? null,views:Number.isFinite(v.views)?v.views:null,viewsMetric:'Video.views'})),nextCursor:body.paging?.next?body.paging?.cursors?.after || null:null,hasMore:!!body.paging?.next,checkedAt:Date.now()};
  }
  async function videoSource(pageKey,destinationId,videoId){
    if(!/^\d{5,30}$/.test(String(videoId)))throw Error('Invalid Facebook video ID');
    const body=await readGraph(pageKey,destinationId,encodeURIComponent(videoId),{fields:'id,source,from,length'});
    if(body.from?.id && String(body.from.id)!==String(destinationId))throw Error('The video belongs to a different Facebook page');
    if(!body.source)throw Error('Meta did not expose a downloadable source for this owned video');
    const url=new URL(body.source);if(url.protocol!=='https:' || !/(^|\.)(fbcdn\.net|fbsbx\.com)$/.test(url.hostname))throw Error('Meta video source is outside the supported CDN');
    return{url:url.href,duration:body.length ?? null};
  }
  return { listVideos, videoSource, metrics, plan, execute, retryFailed, destinations, allowed, authorise, resolveArtifact, verifyPublished, checkConnection, checkVideo };
}

module.exports = { createPublish, captionForPost };
