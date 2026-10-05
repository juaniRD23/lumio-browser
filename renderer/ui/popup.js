// A pop-up window's bar (main/popup-window.js): the lock or "Not secure" and
// the address of the page under it, which that page can't change, and "Open
// in tab". The page's title is the window's. The site information, saving a
// password, blocked pop-ups and permission prompts work as in the browser
// window, with the same dropdowns (renderer/ui/overlay.js).
import { icons } from './icons.js';
import { paintSiteIcon } from './site-icon.js';
import { initPermBar } from './permbar.js';
import { popupsButton } from './popups-button.js';

const api = window.lumio;
const $ = (sel) => document.querySelector(sel);

let state = { tabs: [], activeId: null };
const page = () => state.tabs.find((t) => t.id === state.activeId) || null;
let overlayKind = null;

$('#open-tab .ic').innerHTML = icons.tabs;
$('#pw-key').innerHTML = icons.key;

// ---- the page's place: under the bar (and the permission bar)
const slot = $('#slot');
let slotFrame = 0;
function reportSlot() {
  cancelAnimationFrame(slotFrame);
  slotFrame = requestAnimationFrame(() => {
    const r = slot.getBoundingClientRect();
    api.send('layout:slot', { x: r.left, y: r.top, width: r.width, height: r.height });
  });
}
new ResizeObserver(reportSlot).observe(slot);

// ---- where the pop-up is
const address = $('#address');
function render() {
  const t = page();
  paintSiteIcon($('#site-icon'), t, { words: true });
  // The whole address, without https:// (the lock says that); http:// stays.
  // Always the page's address now, even while you're selecting it.
  const url = t?.url || '';
  address.value = url.replace(/^https:\/\//, '');
  address.title = url;
  popups.render(t);
  pwKey.hidden = !(t && pwPrompts.has(t.id));
}
// Only while it still has focus: select() focuses it again, which would pull
// a quick Tab back to the address.
address.addEventListener('focus', () => requestAnimationFrame(() => { if (document.activeElement === address) address.select(); }));
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); address.blur(); }
});

// ---- dropdowns
function showOverlay(kind, rect, payload) {
  overlayKind = kind;
  api.send('overlay:show', { rect, payload: { kind, ...payload } });
}
function hideOverlay() {
  if (!overlayKind) return;
  const kind = overlayKind;
  overlayKind = null;
  api.send('overlay:hide', kind);
}
api.on('overlay-picked', (msg) => {
  if (msg.kind === overlayKind) overlayKind = null;
  if (msg.kind === 'pwsave') { const t = page(); if (t) pwPrompts.delete(t.id); render(); }
  if (msg.kind === 'popups' && !$('#popups-btn').hidden) $('#popups-btn').focus();
});
// A click anywhere else on the bar closes the open one.
window.addEventListener('mousedown', (e) => {
  if (overlayKind && !e.target.closest('#site-icon, #pw-key, #popups-btn')) hideOverlay();
});

// The site information (the lock).
const siteBtn = $('#site-icon');
async function showSiteInfo(info) {
  info ??= await api.invoke('site:info');
  if (!info) return;
  const r = siteBtn.getBoundingClientRect();
  showOverlay('siteinfo', { x: Math.max(0, r.left - 14), y: r.bottom + 6, width: 370, height: 210 + info.permissions.length * 42 + 26 }, { info });
}
siteBtn.addEventListener('mousedown', (e) => e.preventDefault());
siteBtn.addEventListener('click', () => {
  if (!siteBtn.classList.contains('clickable')) return;
  if (overlayKind === 'siteinfo') hideOverlay(); else showSiteInfo();
});
api.on('site-info', (info) => { if (overlayKind === 'siteinfo' && info) showSiteInfo(info); });

// Pop-ups this page tried to open by itself.
const popupsBtn = $('#popups-btn');
const popups = popupsButton(popupsBtn, api);
popupsBtn.addEventListener('mousedown', (e) => e.preventDefault());
popupsBtn.addEventListener('click', async () => {
  if (overlayKind === 'popups') { hideOverlay(); return; }
  if (await popups.show()) overlayKind = 'popups';
});

// "Save password?" after signing in here (never the password itself).
const pwPrompts = new Map(); // tab id -> prompt
const pwKey = $('#pw-key');
function showPwSave(prompt) {
  const r = pwKey.getBoundingClientRect();
  const width = 340;
  showOverlay('pwsave', { x: Math.max(0, r.right - width - 12 + 8), y: r.bottom + 6, width: width + 24, height: 260 }, { prompt });
}
api.on('passwords-prompt', (p) => {
  pwPrompts.set(p.tabId, p);
  render();
  if (page()?.id === p.tabId) setTimeout(() => showPwSave(p), 60);
});
pwKey.addEventListener('mousedown', (e) => e.preventDefault());
pwKey.addEventListener('click', () => {
  const p = pwPrompts.get(page()?.id);
  if (overlayKind === 'pwsave') hideOverlay(); else if (p) showPwSave(p);
});

// ---- the rest
initPermBar($('#permbar'), api);
$('#open-tab').addEventListener('click', () => api.send('popup:open-in-tab'));

let toastTimer = 0;
api.on('toast', ({ text }) => {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
});

api.on('tabs', (s) => { state = s; render(); });
const init = await api.invoke('popup:init');
if (init) state = init.tabs;
render();
reportSlot();
