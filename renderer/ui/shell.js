// Browser chrome: tab strip, toolbar, omnibox, info bars and page-slot layout.
import { icons, markSvg, avatarHtml } from './icons.js';
import { THEME_COLORS, accentFor, setAccent } from '/assets/theme-colors.js';
import { initPanel } from './ai-panel.js';
import { initSidebar } from './sidebar.js';
import { initOmnibox } from './omnibox.js';
import { initBookmarksBar } from './bookmarks-bar.js';
import { initTabGroups } from './tab-groups.js';
import { initSidePanel } from './side-panel.js';
import './keys.js';

const IS_MAC = /Mac/.test(navigator.platform);
// "Open in a new tab" modifier: ⌘ on the Mac, Ctrl elsewhere.
const modKey = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

const api = window.lumio;
const $ = (sel) => document.querySelector(sel);

const state = { tabs: [], groups: [], activeId: null, downloads: [], incognito: false, account: {}, profile: {} };
const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null;

// ------------------------------------------------------------------ icons
$('#newtab').innerHTML = icons.plus;
$('#back').innerHTML = icons.back;
$('#forward').innerHTML = icons.forward;
$('#reload').innerHTML = icons.reload;
$('#star').innerHTML = icons.star;
$('#downloads').insertAdjacentHTML('afterbegin', icons.download);
$('#ai-toggle .mark').innerHTML = markSvg(15);
$('#find-prev').innerHTML = icons.up;
$('#find-next').innerHTML = icons.down;
$('#find-close').innerHTML = icons.x;
$('#ext-btn').innerHTML = icons.puzzle;
$('#pw-key').innerHTML = icons.key;
$('#menu-btn').innerHTML = icons.dots;
$('#incognito-badge .ic').innerHTML = icons.incognito;

// ------------------------------------------------------------------ page slot
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
window.addEventListener('resize', reportSlot);

// ------------------------------------------------------------------ tabs
const tabsEl = $('#tabs');
const tabEls = new Map();

function faviconHtml(t) {
  if (t.loading) return '<span class="spinner"></span>';
  if (t.internal) return markSvg(14);
  if (t.favicon) return `<img src="${encodeURI(t.favicon)}" alt="" draggable="false">`;
  return icons.globe;
}

function createTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.setAttribute('role', 'tab');
  el.innerHTML = '<span class="fav"></span><i class="agent-dot" hidden></i><span class="title"></span><button class="audio" hidden></button><button class="x" aria-label="Close tab"></button>';
  el.querySelector('.x').innerHTML = icons.close;
  el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); api.send('tab:close', id); });
  el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); api.send('tab:mute', id); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.send('tab:close', id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.send('tab:context', id); });
  el.addEventListener('pointerdown', (e) => startTabDrag(e, el, id));
  return el;
}

function updateTabEl(el, t) {
  el.classList.toggle('active', t.id === state.activeId);
  el.classList.toggle('pinned', !!t.pinned);
  el.classList.toggle('sleeping', !!t.sleeping);
  el.setAttribute('aria-selected', String(t.id === state.activeId));
  el.title = t.title + (t.url ? '\n' + t.url : '') + (t.sleeping ? '\nSleeping to save memory (Memory Saver)' : '')
    + (t.agent ? `\n${t.agent.name} is working here: ${t.agent.title}` : '');
  // A helper AI is working in this tab: its color, the same as its row in the chat.
  const dot = el.querySelector('.agent-dot');
  dot.hidden = !t.agent;
  if (t.agent) dot.style.setProperty('--c', t.agent.color);
  el.classList.toggle('helped', !!t.agent);
  const fav = faviconHtml(t);
  if (el._fav !== fav) { el.querySelector('.fav').innerHTML = fav; el._fav = fav; }
  const img = el.querySelector('.fav img');
  if (img) img.onerror = () => { el.querySelector('.fav').innerHTML = icons.globe; };
  el.querySelector('.title').textContent = t.title || 'Untitled';
  const audio = el.querySelector('.audio');
  audio.hidden = !(t.audible || t.muted);
  audio.innerHTML = t.muted ? icons.muted : icons.volume;
}

// Tab groups: their chips go before their tabs (renderer/ui/tab-groups.js).
const tabGroups = initTabGroups({
  api,
  tabsEl,
  getState: () => state,
  accent: () => accent(),
  overlay: {
    kind: () => overlayKind,
    show: (kind, rect, payload) => { overlayKind = kind; api.send('overlay:show', { rect, payload }); },
    hide: (kind) => { if (overlayKind === kind) hideOverlay(); },
    closed: (kind) => { if (overlayKind === kind) overlayKind = null; },
  },
});

function renderTabs() {
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  state.tabs.forEach((t) => {
    let el = tabEls.get(t.id);
    if (!el) { el = createTabEl(t.id); tabEls.set(t.id, el); }
    updateTabEl(el, t);
  });
  tabGroups.layout(state.tabs, tabEls, state.groups).forEach((el, i) => {
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
  });
  requestAnimationFrame(() => {
    for (const el of tabEls.values()) el.classList.toggle('narrow', el.offsetWidth < 76);
  });
}

function startTabDrag(e, el, id) {
  if (e.button !== 0 || e.target.closest('.x, .audio')) return;
  api.send('tab:activate', id);
  const els = [...tabsEl.querySelectorAll('.tab:not(.collapsed-away)')]; // group chips stay put
  const from = els.indexOf(el);
  const rects = els.map((x) => x.getBoundingClientRect());
  const startX = e.clientX;
  let dragging = false;
  let target = from;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (!dragging && Math.abs(dx) < 5) return;
    dragging = true;
    el.classList.add('dragging');
    const min = rects[0].left - rects[from].left;
    const max = rects[rects.length - 1].left - rects[from].left;
    const clamped = Math.max(min, Math.min(max, dx));
    el.style.transform = `translateX(${clamped}px)`;
    const center = rects[from].left + rects[from].width / 2 + clamped;
    target = from;
    rects.forEach((r, i) => {
      const mid = r.left + r.width / 2;
      if (i < from && center < mid) target = Math.min(target, i);
      if (i > from && center > mid) target = Math.max(target, i);
    });
    const w = rects[from].width + 2;
    els.forEach((x, i) => {
      if (x === el) return;
      x.classList.add('shifting');
      const shift = i > from && i <= target ? -w : i < from && i >= target ? w : 0;
      x.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    els.forEach((x) => { x.style.transform = ''; x.classList.remove('shifting', 'dragging'); });
    if (dragging && target !== from) api.send('tab:move', { id, index: state.tabs.findIndex((t) => t.id === Number(els[target].dataset.id)) });
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

$('#newtab').addEventListener('click', () => api.send('tab:new'));
$('#tabstrip').addEventListener('dblclick', (e) => { if (e.target.classList.contains('strip-drag')) { /* system zoom handles it */ } });

// ------------------------------------------------------------------ toolbar
const address = $('#address');
const omnibox = $('#omnibox');
let omniFocused = false;
let omniEdited = false; // the user typed since focusing the address bar
let overlayKind = null;

function prettyUrl(url) {
  if (!url) return '';
  return url.replace(/^https:\/\//, '').replace(/^www\./, '').replace(/^([^/?#]+)\/$/, '$1');
}

function siteIcon(t) {
  const el = $('#site-icon');
  el.classList.remove('insecure', 'clickable');
  if (omniFocused || !t || !t.url) { el.innerHTML = icons.search; el.title = ''; return; }
  if (t.url.startsWith('https:')) { el.innerHTML = icons.lock; el.title = 'Connection is secure · View site information'; el.classList.add('clickable'); }
  else if (t.url.startsWith('http:')) { el.innerHTML = icons.warn; el.classList.add('insecure', 'clickable'); el.title = 'Not secure · View site information'; }
  else { el.innerHTML = icons.globe; el.title = ''; }
}

function renderToolbar() {
  const t = activeTab();
  $('#back').disabled = !t?.canGoBack;
  $('#forward').disabled = !t?.canGoForward;
  $('#reload').innerHTML = t?.loading ? icons.stop : icons.reload;
  $('#reload').title = t?.loading ? 'Stop loading' : 'Reload (⌘R)';
  if (!omniFocused) {
    address.value = prettyUrl(t?.url || '');
    address.classList.toggle('url-view', !!t?.url);
  } else if (!omniEdited && address.value !== (t?.url || '')) {
    // The page changed under a focused, untouched address bar (a bookmark,
    // a link, or Lumio navigating): show the new address.
    address.value = t?.url || '';
  }
  const star = $('#star');
  star.hidden = !t?.url || !/^https?:/.test(t.url);
  star.classList.toggle('on', !!t?.bookmarked);
  star.innerHTML = t?.bookmarked ? icons.starFilled : icons.star;
  siteIcon(t);
  if (typeof renderPwKey === 'function') renderPwKey();
  document.title = t ? `${t.title} — Lumio Browser${state.incognito ? ' (Incognito)' : ''}` : 'Lumio Browser';
  // Extension buttons show the state for the active tab.
  const ext = $('#ext-actions');
  if (t?.wcId && ext.getAttribute('tab') !== String(t.wcId)) ext.setAttribute('tab', String(t.wcId));
}

$('#back').addEventListener('click', () => api.send('tab:back'));
$('#forward').addEventListener('click', () => api.send('tab:forward'));
$('#reload').addEventListener('click', () => api.send(activeTab()?.loading ? 'tab:stop' : 'tab:reload'));
$('#star').addEventListener('click', () => api.send('tab:bookmark'));

address.addEventListener('focus', () => {
  omniFocused = true;
  omniEdited = false;
  omnibox.classList.add('focused');
  const t = activeTab();
  address.value = t?.url || '';
  address.classList.remove('url-view');
  siteIcon(t);
  requestAnimationFrame(() => address.select());
  omni.onFocus();
});
address.addEventListener('mousedown', () => { if (!omniFocused) address.dataset.justFocused = '1'; });
address.addEventListener('mouseup', (e) => {
  if (!address.dataset.justFocused) return;
  delete address.dataset.justFocused;
  e.preventDefault();
  address.select();
});
address.addEventListener('blur', () => {
  omniFocused = false;
  omnibox.classList.remove('focused');
  omni.onBlur();
  setTimeout(() => { if (!omniFocused && overlayKind === 'suggest') hideOverlay(); }, 160);
  renderToolbar();
});
// Typing, suggestions, chips and the address bar's keys (renderer/ui/omnibox.js).
const omni = initOmnibox({
  api,
  address,
  box: omnibox,
  activeTab,
  ask: (text) => { panel.open(); panel.sendText(text); },
  edited: () => { omniEdited = true; },
  overlay: {
    open: () => overlayKind === 'suggest',
    show: (rect, payload) => { overlayKind = 'suggest'; api.send('overlay:show', { rect, payload }); },
    hide: () => { if (overlayKind === 'suggest') hideOverlay(); },
  },
});

function hideOverlay() {
  if (!overlayKind) return;
  const kind = overlayKind;
  overlayKind = null;
  accountBtn.classList.remove('open');
  api.send('overlay:hide', kind);
}

api.on('overlay-picked', (msg) => {
  if (msg.kind === 'suggest') omni.onPicked(msg);
  if (['downloads', 'siteinfo', 'account', 'autofill', 'update'].includes(msg.kind)) { overlayKind = null; accountBtn.classList.remove('open'); }
  if (msg.kind === 'pwsave') { overlayKind = null; const t = activeTab(); if (t) pwPrompts.delete(t.id); renderPwKey(); }
});

// ------------------------------------------------------------------ save password prompt
const pwPrompts = new Map(); // tab id -> prompt from main (never the password itself)
const pwKey = $('#pw-key');
function renderPwKey() {
  const t = activeTab();
  pwKey.hidden = !(t && pwPrompts.has(t.id));
}
function showPwSave(prompt) {
  const r = pwKey.getBoundingClientRect();
  const width = 340;
  overlayKind = 'pwsave';
  api.send('overlay:show', {
    rect: { x: r.right - width - 12 + 8, y: r.bottom + 8, width: width + 24, height: 260 },
    payload: { kind: 'pwsave', prompt, accent: accent() },
  });
}
api.on('passwords-prompt', (p) => {
  pwPrompts.set(p.tabId, p);
  renderPwKey();
  if (activeTab()?.id === p.tabId) setTimeout(() => showPwSave(p), 60);
});
pwKey.addEventListener('mousedown', (e) => e.preventDefault());
window.addEventListener('mousedown', (e) => { if (overlayKind === 'pwsave' && !e.target.closest('#pw-key')) hideOverlay(); });
pwKey.addEventListener('click', () => {
  const p = pwPrompts.get(activeTab()?.id);
  if (overlayKind === 'pwsave') hideOverlay(); else if (p) showPwSave(p);
});

api.on('focus-omnibox', () => { address.focus(); address.select(); });

// ------------------------------------------------------------------ site info
const siteBtn = $('#site-icon');
async function showSiteInfo(info) {
  info ??= await api.invoke('site:info');
  if (!info) return;
  const r = siteBtn.getBoundingClientRect();
  overlayKind = 'siteinfo';
  api.send('overlay:show', {
    rect: { x: r.left - 14, y: r.bottom + 6, width: 370, height: 210 + info.permissions.length * 42 + 26 },
    payload: { kind: 'siteinfo', info },
  });
}
siteBtn.addEventListener('mousedown', (e) => { if (!omniFocused) e.preventDefault(); });
siteBtn.addEventListener('click', () => {
  if (omniFocused || !siteBtn.classList.contains('clickable')) return;
  if (overlayKind === 'siteinfo') hideOverlay(); else showSiteInfo();
});
api.on('site-info', (info) => { if (overlayKind === 'siteinfo' && info) showSiteInfo(info); });
window.addEventListener('mousedown', (e) => { if (overlayKind === 'siteinfo' && !e.target.closest('#site-icon')) hideOverlay(); });

// ------------------------------------------------------------------ toast + zoom
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
api.on('toast', ({ text }) => toast(text));
api.on('zoom', ({ level }) => {
  const b = $('#zoom-badge');
  b.hidden = level === 100;
  b.textContent = level + '%';
});
$('#zoom-badge').addEventListener('click', () => api.send('tab:zoom', 0));

// ------------------------------------------------------------------ downloads
const dlBtn = $('#downloads');
function renderDownloads(started) {
  const items = state.downloads;
  dlBtn.hidden = !items.length;
  const active = items.filter((d) => d.state === 'progressing');
  const total = active.reduce((a, d) => a + (d.total || 0), 0);
  const got = active.reduce((a, d) => a + (d.received || 0), 0);
  dlBtn.classList.toggle('busy', active.length > 0);
  dlBtn.classList.toggle('done', !active.length && items.some((d) => d.state === 'completed'));
  dlBtn.style.setProperty('--p', total ? (got / total).toFixed(3) : active.length ? 0.1 : 0);
  if (started) dlBtn.animate([{ transform: 'translateY(-4px)' }, { transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.22,1,.36,1)' });
  if (overlayKind === 'downloads') showDownloads();
}
function showDownloads() {
  const r = dlBtn.getBoundingClientRect();
  const width = 360;
  const height = Math.min(420, state.downloads.length * 54 + 56) + 26 + 38;
  overlayKind = 'downloads';
  api.send('overlay:show', {
    rect: { x: r.right - width + 12, y: r.bottom + 2, width: width + 24, height },
    payload: { kind: 'downloads', items: state.downloads },
  });
}
dlBtn.addEventListener('click', () => (overlayKind === 'downloads' ? hideOverlay() : showDownloads()));
window.addEventListener('mousedown', (e) => { if (overlayKind === 'downloads' && !e.target.closest('#downloads')) hideOverlay(); });
api.on('downloads', ({ items, started }) => { state.downloads = items; renderDownloads(started); });

// ------------------------------------------------------------------ bookmarks bar
// Under the address bar, like Chrome's: on every page (Show Bookmarks Bar,
// the default), or else only on the new tab page. Folders, their menus, drag
// and drop and the star's bubble: renderer/ui/bookmarks-bar.js.
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bookmarksBar = initBookmarksBar({
  api,
  bar: $('#bookmarks-bar'),
  isMac: IS_MAC,
  modKey,
  activeTab,
  reportSlot,
  accent: () => accent(),
  overlay: {
    kind: () => overlayKind,
    show: (kind, rect, payload) => { overlayKind = kind; api.send('overlay:show', { rect, payload }); },
    hide: (kind) => { if (overlayKind === kind) hideOverlay(); },
    closed: (kind) => { if (overlayKind === kind) overlayKind = null; },
  },
});
// The site icon in the address bar can be dragged onto the bar (or anywhere a link goes).
$('#site-icon').draggable = true;
$('#site-icon').addEventListener('dragstart', (e) => {
  const t = activeTab();
  if (!t || !/^https?:/.test(t.url || '')) { e.preventDefault(); return; }
  e.dataTransfer.effectAllowed = 'copyLink';
  e.dataTransfer.setData('text/uri-list', t.url);
  e.dataTransfer.setData('text/plain', t.url);
  e.dataTransfer.setData('text/html', `<a href="${escHtml(t.url)}">${escHtml(t.title || t.url)}</a>`);
});

// ------------------------------------------------------------------ account button
const accountBtn = $('#account-btn');
// The profile's theme color, in both shades (incognito is always purple).
const accent = () => (state.incognito ? THEME_COLORS.purple : accentFor(state.profile.theme));
function applyTheme() {
  setAccent(document.documentElement, accent());
}
function renderAccount() {
  accountBtn.innerHTML = avatarHtml({ profile: state.profile, account: state.account, incognito: state.incognito, size: 26 });
  accountBtn.classList.toggle('connecting', !!state.account.connecting);
  const a = state.account;
  accountBtn.title = state.incognito ? 'Incognito'
    : a.signedIn ? `${state.profile.name || a.name || a.email}\n${a.email}${a.planName ? ` · Lumio ${a.planName}` : ''}`
      : 'Sign in to Lumio';
  applyTheme();
  if (overlayKind === 'account') showAccountMenu();
}
function showAccountMenu() {
  const r = accountBtn.getBoundingClientRect();
  const width = 320;
  overlayKind = 'account';
  accountBtn.classList.add('open');
  api.send('overlay:show', {
    // The overlay page measures itself and asks for the right height.
    rect: { x: r.right - width - 12 + 6, y: r.bottom + 4, width: width + 24, height: 420 },
    payload: { kind: 'account', account: state.account, profile: state.profile, incognito: state.incognito, accent: accent() },
  });
}
accountBtn.addEventListener('mousedown', (e) => e.preventDefault());
accountBtn.addEventListener('click', () => {
  if (overlayKind === 'account') { hideOverlay(); return; }
  showAccountMenu();
});
window.addEventListener('mousedown', (e) => { if (overlayKind === 'account' && !e.target.closest('#account-btn')) hideOverlay(); });
api.on('account', (a) => { state.account = a || {}; renderAccount(); });
api.on('profile', (p) => { state.profile = p || {}; renderAccount(); });

// ------------------------------------------------------------------ updates
// A blue Update button next to the avatar while a newer release is out.
const updateBtn = $('#update-btn');
let updateState = null;
function renderUpdate(u) {
  updateState = u;
  const show = !!u && ['available', 'downloading', 'ready', 'installing'].includes(u.status);
  updateBtn.hidden = !show;
  if (!show) return;
  const busy = u.status === 'downloading' || u.status === 'installing';
  updateBtn.classList.toggle('busy', busy);
  updateBtn.querySelector('.ic').innerHTML = busy ? icons.spinner : icons.update;
  updateBtn.querySelector('.label').textContent = u.status === 'downloading' ? `Updating… ${u.progress || 0}%`
    : u.status === 'installing' ? 'Restarting…'
      : u.status === 'ready' ? 'Restart to update' : 'Update';
  updateBtn.style.setProperty('--p', u.status === 'downloading' ? u.progress || 0 : 0);
  updateBtn.title = u.error || `Lumio Browser ${u.latest} is available (you have ${u.current})`;
  updateBtn.setAttribute('aria-label', `Update Lumio Browser to ${u.latest}`);
}
// The What's new card under the Update button (also opened once when a new
// version comes out).
function showUpdateCard(u = updateState) {
  if (!u || !u.latest || !['available', 'ready'].includes(u.status)) return;
  const r = updateBtn.hidden ? $('#account-btn').getBoundingClientRect() : updateBtn.getBoundingClientRect();
  const width = 360;
  overlayKind = 'update';
  api.send('overlay:show', {
    rect: { x: r.right - width - 12 + 8, y: r.bottom + 8, width: width + 24, height: 320 },
    payload: { kind: 'update', update: u, accent: accent() },
  });
}
updateBtn.addEventListener('mousedown', (e) => e.preventDefault());
updateBtn.addEventListener('click', () => {
  if (updateBtn.classList.contains('busy')) return;
  if (overlayKind === 'update') { hideOverlay(); return; }
  if (updateState?.status === 'ready') { api.send('update:install'); return; }
  showUpdateCard();
});
window.addEventListener('mousedown', (e) => { if (overlayKind === 'update' && !e.target.closest('#update-btn')) hideOverlay(); });
api.on('update', renderUpdate);
api.on('update-announce', (u) => { if (!overlayKind) { renderUpdate(u); showUpdateCard(u); } });

// ------------------------------------------------------------------ extensions
$('#ext-btn').addEventListener('click', () => api.send('extensions:manage'));

// ------------------------------------------------------------------ permission bar
const permQueue = [];
function renderPerm() {
  const bar = $('#permbar');
  const p = permQueue[0];
  bar.hidden = !p;
  if (p) {
    const text = bar.querySelector('.infobar-text');
    text.textContent = '';
    const b = document.createElement('b');
    b.textContent = p.host;
    text.append(b, ` wants to ${p.label}`);
  }
}
$('#permbar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const p = permQueue[0];
  if (!act || !p) return;
  api.send('permission:respond', { id: p.id, allow: act === 'allow', remember: true });
  permQueue.shift();
  renderPerm();
});
api.on('permission', (p) => { permQueue.push(p); renderPerm(); });
api.on('permission-cancel', ({ id }) => {
  const i = permQueue.findIndex((p) => p.id === id);
  if (i >= 0) { permQueue.splice(i, 1); renderPerm(); }
});

// ------------------------------------------------------------------ find bar
const findbar = $('#findbar');
const findInput = $('#find-input');
function openFind() {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) api.send('find:start', { text: findInput.value });
}
function closeFind(focusPage = true) {
  if (findbar.hidden) return;
  findbar.hidden = true;
  $('#find-count').textContent = '';
  api.send('find:stop');
  if (focusPage) api.send('tab:focus-page');
}
function findStep(forward) {
  if (findbar.hidden) { openFind(); return; }
  if (findInput.value) api.send('find:start', { text: findInput.value, forward, next: true });
}
findInput.addEventListener('input', () => {
  if (findInput.value) api.send('find:start', { text: findInput.value });
  else { api.send('find:stop'); $('#find-count').textContent = ''; }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#find-next').addEventListener('click', () => findStep(true));
$('#find-prev').addEventListener('click', () => findStep(false));
$('#find-close').addEventListener('click', () => closeFind());
api.on('find-open', openFind);
api.on('find-close', () => closeFind(false));
api.on('find-step', ({ forward }) => findStep(forward));
api.on('find-result', (r) => {
  if (r.finalUpdate === false && !r.matches) return;
  $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results';
});

// ------------------------------------------------------------------ panel
const panel = initPanel({
  api,
  getActiveTab: activeTab,
  onLayout: reportSlot,
  setRunning: (running) => document.body.classList.toggle('agent-running', running),
});

api.on('fullscreen', (on) => document.body.classList.toggle('fullscreen', on));

// ------------------------------------------------------------------ state
api.on('tabs', (s) => {
  const switched = s.activeId !== state.activeId;
  state.tabs = s.tabs;
  state.groups = s.groups || [];
  state.activeId = s.activeId;
  renderTabs();
  renderToolbar();
  bookmarksBar.onTabs();
  panel.onTabChange(activeTab(), switched);
  if (switched) $('#zoom-badge').hidden = true;
});

const init = await api.invoke('shell:init');
state.tabs = init.tabs.tabs;
state.groups = init.tabs.groups || [];
state.activeId = init.tabs.activeId;
state.downloads = init.downloads;
bookmarksBar.set(init.bookmarks, init.savedGroups);
state.incognito = init.incognito;
state.account = init.account || {};
state.profile = init.profile || {};
document.body.classList.toggle('incognito', init.incognito);
document.body.classList.toggle('windows', init.platform === 'win32');
// Windows has no menu bar, so the ⋮ button opens the browser menu.
$('#menu-btn').hidden = init.platform === 'darwin';
$('#menu-btn').addEventListener('click', () => {
  const r = $('#menu-btn').getBoundingClientRect();
  api.send('app:menu', { x: r.right, y: r.bottom + 4 });
});
$('#incognito-badge').hidden = !init.incognito;
$('#beta-badge').hidden = !init.beta; // Lumio Beta (main/flavor.js)
$('#ext-area').hidden = !init.extensions;
renderTabs();
renderToolbar();
renderDownloads(false);
bookmarksBar.render();
renderAccount();
renderUpdate(init.update);
panel.init(init);
// The side panel's views share the panel's column (renderer/ui/side-panel.js).
const sidePanel = initSidePanel({ api, panel, modKey, activeTab });
sidePanel.init(init);
const sidebar = initSidebar({
  api,
  panel,
  getAi: () => panel.ai(),
  isNewTab: () => !activeTab()?.url, // asked from the new tab page: the chat opens full size
  onLayout: () => requestAnimationFrame(() => reportSlot()),
});
sidebar.init(init);
// Signing in or out changes what the sidebar shows.
let sidebarSignedIn = !!init.ai?.lumio?.signedIn;
api.on('ai-state', (s) => { if (!!s.lumio?.signedIn !== sidebarSignedIn) { sidebarSignedIn = !!s.lumio?.signedIn; sidebar.refresh(); } });
reportSlot();
if (!activeTab()?.url) setTimeout(() => address.focus(), 50);
