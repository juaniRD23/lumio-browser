// The title bar of an installed app's window (main/apps.js): back, forward
// and reload, the app's icon and page title, a note when you've left the
// app's site (with Back to app), "Save password?" after you sign in, Open in
// Lumio Browser and a menu.
import { icons } from './icons.js';

const api = window.lumio;
const $ = (s) => document.querySelector(s);
const svg = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  forward: svg('<path d="M9 18l6-6-6-6"/>'),
  reload: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  stop: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  browser: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>'),
  menu: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor"/></svg>',
  app: svg('<rect x="4" y="4" width="16" height="16" rx="4"/>', 14),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>', 13),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 13),
};
for (const act of ['back', 'forward', 'reload', 'browser', 'menu']) $(`[data-act="${act}"]`).innerHTML = I[act];

let state = null;
function render(s) {
  if (!s) return;
  state = s;
  document.body.classList.toggle('mac', s.platform === 'darwin');
  document.body.classList.toggle('windows', s.platform === 'win32');
  document.title = s.name;
  $('[data-act="back"]').disabled = !s.canGoBack;
  $('[data-act="forward"]').disabled = !s.canGoForward;
  const reload = $('[data-act="reload"]');
  reload.innerHTML = s.loading ? I.stop : I.reload;
  reload.title = s.loading ? 'Stop' : 'Reload';
  reload.setAttribute('aria-label', reload.title);
  $('.icon').innerHTML = s.icon ? `<img src="${s.icon}" alt="">` : I.app;
  $('#title').textContent = s.title || s.name;
  // Left the app's site: say where you are, and offer the way back.
  $('#away').hidden = !s.outside;
  $('.away-host').innerHTML = `${s.secure ? I.lock : I.warn}<span></span>`;
  $('.away-host span').textContent = s.host;
  $('.away-host').classList.toggle('insecure', !s.secure);
}

$('#bar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  let act = btn.dataset.act;
  if (act === 'reload' && state?.loading) act = 'stop';
  const r = btn.getBoundingClientRect();
  api.send('apps:nav', { action: act, x: r.left, y: r.bottom + 4 });
});
api.on('app-state', render);
api.invoke('apps:state').then(render).catch(() => {});

// "Save password?" after signing in here (main/password-manager.js), in the
// same bubble as a browser window's (renderer/ui/overlay.js, kind 'pwsave'),
// drawn over the site by this window's overlay. The key brings it back.
const pwKey = $('#pw-key');
pwKey.innerHTML = icons.key;
let pwPrompt = null;
let overlayKind = null;
function showPwSave(prompt) {
  const r = pwKey.getBoundingClientRect();
  const width = 340;
  overlayKind = 'pwsave';
  api.send('overlay:show', { rect: { x: Math.max(0, r.right - width - 12 + 8), y: r.bottom + 6, width: width + 24, height: 260 }, payload: { kind: 'pwsave', prompt } });
}
function hideOverlay() {
  if (!overlayKind) return;
  const kind = overlayKind;
  overlayKind = null;
  api.send('overlay:hide', kind);
}
api.on('passwords-prompt', (p) => {
  pwPrompt = p;
  pwKey.hidden = false;
  setTimeout(() => showPwSave(p), 60);
});
pwKey.addEventListener('mousedown', (e) => e.preventDefault());
pwKey.addEventListener('click', () => {
  if (overlayKind === 'pwsave') hideOverlay(); else if (pwPrompt) showPwSave(pwPrompt);
});
window.addEventListener('mousedown', (e) => { if (overlayKind && !e.target.closest('#pw-key')) hideOverlay(); });
api.on('overlay-picked', (msg) => {
  if (msg?.kind === overlayKind) overlayKind = null;
  if (msg?.kind === 'pwsave') { pwPrompt = null; pwKey.hidden = true; }
});
api.on('overlay-state', (s) => { if (s?.closed && s.kind === overlayKind) overlayKind = null; });

let toastTimer = 0;
api.on('toast', ({ text } = {}) => {
  const el = $('#toast');
  el.textContent = text || '';
  el.hidden = !text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
});
