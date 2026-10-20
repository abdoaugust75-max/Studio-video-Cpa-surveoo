'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

function createTelegramReports({ dir, report, request = fetch }) {
  const file = path.join(dir, 'telegram-private.json');
  const outFile = path.join(dir, 'telegram-deliveries.json');
  const read = () => U.readJson(file, { enabled: false, token: '', chatId: '' });
  function settings() {
    const c = read();
    const lastDelivery=Object.values(U.readJson(outFile,{})).at(-1) || null;
    return { enabled: !!c.enabled, configured: !!c.token, chatId: c.chatId || '', bot: c.bot || null, verifiedAt: c.verifiedAt || null, lastDelivery };
  }
  function save(input) {
    const c = read();
    if (input.clearToken === true) { c.token = ''; c.bot = null; c.verifiedAt = null; }
    if (input.token) {
      if (!/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(input.token)) throw Error('Invalid Telegram bot token format');
      c.token = input.token; c.bot = null; c.verifiedAt = null;
    }
    if (input.chatId !== undefined) {
      if (input.chatId && !/^-?\d{1,20}$/.test(String(input.chatId))) throw Error('Chat ID must be a numeric Telegram chat ID');
      c.chatId = String(input.chatId || '');
    }
    if (input.enabled !== undefined) c.enabled = input.enabled === true;
    if (input.agentEnabled !== undefined) c.agentEnabled = input.agentEnabled === true;
    U.writeJsonAtomic(file, c);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    return settings();
  }
  async function api(method, body = {}, expectedToken) {
    const c = read();
    if (expectedToken && expectedToken !== c.token) throw Error('Telegram connection changed; retry using the current settings');
    if (!c.token) throw Error('Save a Telegram bot token in Settings first');
    let r;
    try { r = await request('https://api.telegram.org/bot' + c.token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    }); } catch (_) { throw Error('Telegram request timed out or connection failed; delivery may be uncertain'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const reason = r.status === 401 ? 'The bot token is invalid or revoked. Copy a fresh token from BotFather.'
        : r.status === 409 ? 'Another Telegram receiver or webhook is using this bot. Use a dedicated studio bot.'
        : r.status === 403 ? 'The bot is blocked or cannot access this chat. Open the bot and press Start.'
        : method === 'sendMessage' && r.status === 400 ? 'Chat not found. Use your personal chat ID and press Start in the bot first.'
        : 'Check the bot, chat ID and permissions.';
      const e = Error('Telegram ' + method + ' failed (HTTP ' + r.status + '). ' + reason);
      e.definite = true; e.retryAfter = data.parameters?.retry_after || null; throw e;
    }
    return data.result;
  }
  async function verify() {
    const bot = await api('getMe');
    const c = read(); c.bot = { id: bot.id, username: bot.username || '' }; c.verifiedAt = Date.now();
    U.writeJsonAtomic(file, c); return settings();
  }
  async function chats() {
    const updates = await api('getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post'] });
    const items = updates.map(x => (x.message || x.channel_post)?.chat).filter(Boolean);
    return [...new Map(items.map(c => [String(c.id), { id: String(c.id), title: c.title || c.first_name || c.username || String(c.id), type: c.type }])).values()];
  }
  let lastSent=0;
  let sending=Promise.resolve();
  async function sendNow(text) {
    const c = read(); if (!c.chatId) throw Error('Select a Telegram chat in Settings');
    const pause=1100-(Date.now()-lastSent);
    if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));
    const latest=read();if(latest.token!==c.token || latest.chatId!==c.chatId)throw Error('Telegram connection changed before sending; retry with the current settings');
    lastSent=Date.now();
    return api('sendMessage', { chat_id: c.chatId, text: String(text).slice(0, 4000), link_preview_options: { is_disabled: true } },c.token);
  }
  function send(text){const next=sending.then(()=>sendNow(text));sending=next.catch(()=>{});return next;}
  function sendVideo(file,caption){
    const next=sending.then(async()=>{
      const c=read();if(!c.enabled||!c.chatId||!c.token)throw Error('Telegram is not configured and enabled');
      const size=fs.statSync(file).size;
      if(size>49*1024*1024){const e=Error('الفيديو أكبر من حد الإرسال المباشر؛ الملف باقي فالداشبورد.');e.definite=true;throw e;}
      const pause=1100-(Date.now()-lastSent);if(pause>0)await new Promise(r=>setTimeout(r,pause));
      const latest=read();if(latest.token!==c.token||latest.chatId!==c.chatId||!latest.enabled)throw Error('Telegram connection changed before sending');
      const form=new FormData();form.set('chat_id',c.chatId);form.set('caption',String(caption).slice(0,1024));form.set('supports_streaming','true');form.set('video',new Blob([fs.readFileSync(file)],{type:'video/mp4'}),'studio-review.mp4');
      lastSent=Date.now();let response;
      try{response=await request('https://api.telegram.org/bot'+c.token+'/sendVideo',{method:'POST',body:form,signal:AbortSignal.timeout(180000)});}catch(_){throw Error('Telegram video delivery interrupted; acceptance is uncertain');}
      const body=await response.json().catch(()=>({}));if(!response.ok||!body.ok){const e=Error('Telegram video delivery failed (HTTP '+response.status+')');e.definite=true;throw e;}return body.result;
    });sending=next.catch(()=>{});return next;
  }
  async function notify(key, text) {
    const c = read(); if (!c.enabled || !c.token || !c.chatId) return { skipped: true, reason: 'Telegram is not configured and enabled' };
    const out = U.readJson(outFile, {});
    if (out[key]) return out[key];
    // Persist before sending. An uncertain delivery is never automatically duplicated.
    out[key] = { status: 'sending', at: Date.now() }; U.writeJsonAtomic(outFile, out);
    try {
      const result = await send(text); out[key] = { status: 'sent', at: Date.now(), messageId: result.message_id };
    } catch (e) { out[key] = { status: e.definite ? 'failed' : 'unknown', at: Date.now(), error: e.message }; }
    U.writeJsonAtomic(outFile, Object.fromEntries(Object.entries(out).slice(-500))); return out[key];
  }
  return { api, send, sendVideo, settings, save, verify, chats, notify, test: async () => { await verify(); await send('VideoStudio: Telegram connection works. Reports will use this chat.'); return { ok: true }; },
    report: async () => { const text = await report(); await send(text); return { ok: true }; } };
}
module.exports = { createTelegramReports };
