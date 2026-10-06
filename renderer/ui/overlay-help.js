// "Report an issue…" drawn above the page (main/help.js sends it). The page's
// address and screenshot are only included when their boxes are ticked;
// system info is listed so the person can see exactly what it is. It keeps
// the keyboard focus: Tab moves around it, ⌘/Ctrl+Enter sends, Esc cancels.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (u) => { try { const x = new URL(u); return x.host + (x.pathname.length > 1 ? x.pathname : ''); } catch { return u; } };

export const KINDS = new Set(['feedback']);
let api = null;
let sending = false;

const SYSTEM_LABELS = { lumio: 'Lumio Browser', chromium: 'Chromium', electron: 'Electron', os: 'System', arch: 'Processor', language: 'Language' };

export function render(_kind, payload, card, bridge) {
  api = bridge;
  sending = false;
  const p = payload;
  const sys = Object.entries(p.system || {}).map(([k, v]) => `<li><span>${esc(SYSTEM_LABELS[k] || k)}</span><b>${esc(v)}</b></li>`).join('');
  card.innerHTML = `
    <form class="fb" id="fb" role="dialog" aria-labelledby="fb-title" aria-describedby="fb-sub" novalidate>
      <div class="fb-title" id="fb-title">Report an issue</div>
      <p class="fb-sub" id="fb-sub">Tell us what went wrong or what could be better. We read every report.</p>
      <label class="fb-field"><span>What happened?</span>
        <textarea id="fb-text" rows="5" maxlength="5000" required placeholder="What did you do, what happened, and what did you expect?"></textarea></label>
      <label class="fb-field"><span>Email <em>(optional, so we can reply)</em></span>
        <input id="fb-email" type="email" value="${esc(p.email)}" autocomplete="off" spellcheck="false"></label>
      ${p.url ? `<label class="fb-check"><input type="checkbox" id="fb-url"><span><b>Include this page’s address</b><small>${esc(short(p.url))}</small></span></label>` : ''}
      ${p.thumb ? `<label class="fb-check"><input type="checkbox" id="fb-shot"><span><b>Include a screenshot of this page</b><small>Only what you see below is sent.</small><img class="fb-thumb" src="${esc(p.thumb)}" alt="Screenshot of the page"></span></label>` : ''}
      <label class="fb-check"><input type="checkbox" id="fb-system" checked><span><b>Include system info</b><small>Versions and your computer’s system, no personal data.</small></span></label>
      <details class="fb-sys"><summary>What’s included</summary><ul>${sys}</ul></details>
      <p class="fb-note">${p.signedIn ? 'It’s sent with your Lumio account. ' : ''}Lumio never sends the page’s content unless you include its address or screenshot.</p>
      <div class="fb-error" id="fb-error" role="alert" hidden></div>
      <div class="fb-actions">
        <span class="grow"></span>
        <button type="button" class="acc-btn ghost" data-fb="cancel">Cancel</button>
        <button type="submit" class="acc-btn primary" id="fb-send" disabled>Send report</button>
      </div>
    </form>`;
  const text = card.querySelector('#fb-text');
  text.addEventListener('input', () => { card.querySelector('#fb-send').disabled = sending || !text.value.trim(); });
  card.querySelector('#fb').addEventListener('submit', (e) => { e.preventDefault(); send(card); });
  card.querySelector('[data-fb=cancel]').addEventListener('click', () => api.send('help:close'));
  // Reported sizes make the dialog fit; the screenshot changes its height once loaded.
  card.querySelector('.fb-thumb')?.addEventListener('load', () => measure(card));
  card.querySelector('.fb-sys').addEventListener('toggle', () => measure(card));
  text.focus({ preventScroll: true });
  measure(card);
}

async function send(card) {
  const text = card.querySelector('#fb-text');
  if (sending || !text.value.trim()) return;
  sending = true;
  const button = card.querySelector('#fb-send');
  const error = card.querySelector('#fb-error');
  button.disabled = true;
  button.textContent = 'Sending…';
  error.hidden = true;
  const res = await api.invoke('help:send', {
    description: text.value,
    email: card.querySelector('#fb-email').value,
    includeUrl: !!card.querySelector('#fb-url')?.checked,
    includeShot: !!card.querySelector('#fb-shot')?.checked,
    includeSystem: !!card.querySelector('#fb-system').checked,
  }).catch(() => null);
  sending = false;
  if (res?.ok) {
    card.innerHTML = '<div class="fb fb-done" role="status"><div class="fb-title">Thanks!</div><p class="fb-sub">Your report was sent.</p></div>';
    measure(card);
    setTimeout(() => api.send('help:close'), 1600);
    return;
  }
  button.textContent = 'Send report';
  button.disabled = false;
  error.textContent = res?.error || 'That didn’t send. Try again.';
  error.hidden = false;
  measure(card);
}

function measure(card) {
  requestAnimationFrame(() => {
    card.style.height = 'auto';
    const h = card.getBoundingClientRect().height;
    card.style.height = '';
    api.send('overlay:size', { height: Math.ceil(h) + 2 + 22 });
  });
}

export function keydown(kind, e, card) {
  if (kind !== 'feedback') return;
  if (e.key === 'Escape') { e.preventDefault(); api.send('help:close'); return; }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(card); return; }
  // Keep Tab inside the dialog.
  if (e.key === 'Tab') {
    const f = [...card.querySelectorAll('textarea, input, summary, button:not([disabled])')];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
}
