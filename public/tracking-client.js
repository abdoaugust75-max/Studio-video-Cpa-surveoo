(() => {
  'use strict';
  const script = document.currentScript;
  if (!script?.dataset.site) return;
  const tracker = new URL(script.src).origin;
  const query = new URLSearchParams(location.search);
  const field = name => query.get('st_' + name) || script.dataset[name] || '';
  const input = { site: script.dataset.site, page: field('page'), video: field('video'), variant: field('variant') || 'default', campaign: field('campaign'), eventId: crypto.randomUUID() };
  const ready = () => fetch(tracker + '/track/event', {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(8000)
  }).then(async response => {
    if (!response.ok) return;
    const value = await response.json();
    const url = new URL(value.redirect);
    if (url.origin !== tracker || url.pathname !== '/track/go') return;
    for (const anchor of document.querySelectorAll('a[data-studio-offer]')) {
      const offer = anchor.dataset.studioOffer;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(offer || '')) continue;
      const click = new URL(url.href); click.searchParams.set('offer', offer);
      anchor.href = click.href; anchor.referrerPolicy = 'no-referrer';
    }
  }).catch(() => { /* Existing offer links remain usable if tracking is unavailable. */ });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
