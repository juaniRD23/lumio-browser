// Browser chrome: tab strip, toolbar, omnibox, info bars and page-slot layout.
import { icons, markSvg, avatarHtml } from './icons.js';
import { THEME_COLORS, accentFor, setAccent } from '/assets/theme-colors.js';
import { initPanel } from './ai-panel.js';
import { initSidebar } from './sidebar.js';
import { paintSiteIcon } from './site-icon.js';
import { popupsButton } from './popups-button.js';
import { reduced, dur, animate, cancel, slide, instantly } from './motion.js';
import { initNavigation } from './navigation.js';
import { initTabStrip, SAD_ICON } from './tabstrip.js';
import { initInfobars } from './infobars.js';
import { initOmnibox } from './omnibox.js';
import { initBookmarksBar } from './bookmarks-bar.js';
import { initTabGroups } from './tab-groups.js';
import { initSidePanel } from './side-panel.js';
import { initPermissionChip } from './permission-chip.js';
import { initCaptureBar, captureWords } from './capture-bar.js';
import { initPerf } from './perf.js';
import { initTranslate } from './translate.js';
import { initReadingMode } from './reading-mode.js';
import { initShare } from './share.js';
import { initMedia } from './media.js';
import { initExtensionsBar } from './extensions-bar.js';
import './keys.js';
import '/assets/ui-prefs.js';
import { initA11y, textScale } from './a11y.js';

const IS_MAC = /Mac/.test(navigator.platform);
// "Open in a new tab" modifier: ⌘ on the Mac, Ctrl elsewhere.
const modKey = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

const api = window.lumio;
const $ = (sel) => document.querySelector(sel);

const state = { tabs: [], groups: [], activeId: null, downloads: [], incognito: false, guest: false, account: {}, profile: {}, profiles: [] };
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
// Closed tabs stay in the strip, folding away, until their animation ends.
// (Group chips sit among them: tabs only.)
const liveTabs = () => [...tabsEl.children].filter((el) => el.classList.contains('tab') && !el.classList.contains('closing'));
let stripGroups = '[[],[]]'; // the groups the strip was laid out for (renderTabs)
// Tabs animate on what you do, not when the window first draws them.
const stripMoves = () => !document.body.classList.contains('no-anim') && !reduced() && !document.hidden;
let tabDrag = null; // a tab being dragged: other changes to the strip wait for the drop
let localMove = null; // a drop main hasn't confirmed yet: { id, index, until }

// Narrow tabs show just the icon (and the × on the tab you're on). Watched per
// tab, so it holds while tabs animate and when the window resizes.
const narrowWatch = new ResizeObserver((entries) => {
  for (const e of entries) e.target.classList.toggle('narrow', e.borderBoxSize[0].inlineSize < 76);
});
// Scrolling, several tabs at once, drops, pulling tabs out, tab search (tabstrip.js).
// Its tab search list is one of the dropdowns this file opens and closes.
const overlays = {
  get kind() { return overlayKind; },
  show(kind, rect, payload) { overlayKind = kind; api.send('overlay:show', { rect, payload: { ...payload, accent: accent() } }); },
  hide: () => hideOverlay(),
  clear(kind) { if (overlayKind === kind) overlayKind = null; },
};
const strip = initTabStrip({ api, getState: () => state, overlays });

function faviconHtml(t) {
  if (t.crashed) return SAD_ICON;
  if (t.loading) return '<span class="spinner"></span>';
  if (t.internal) return markSvg(14);
  if (t.favicon) return `<img src="${encodeURI(t.favicon)}" alt="" draggable="false">`;
  return icons.globe;
}

// Closing with the mouse (× or middle click) keeps the other tabs' widths,
// so the next × lands under the pointer (see freezeTabs).
function closeTabByMouse(id) {
  hideCard(true);
  freezeTabs();
  api.send('tab:close', id);
}

function createTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el._id = id;
  el.dataset.id = id;
  el.setAttribute('role', 'tab');
  el.innerHTML = '<span class="fav"></span><i class="agent-dot" hidden></i><span class="title"></span><i class="rec-dot" role="img" hidden></i><button class="audio" hidden></button><button class="x" aria-label="Close tab"></button>';
  el.querySelector('.x').innerHTML = icons.close;
  el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeTabByMouse(id); });
  el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); api.send('tab:mute', id); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTabByMouse(id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); hideCard(true); api.send('tab:context', id); });
  el.addEventListener('pointerdown', (e) => startTabDrag(e, el, id));
  el.addEventListener('pointerenter', () => cardEnter(id));
  el.addEventListener('pointerleave', cardLeave);
  narrowWatch.observe(el);
  return el;
}

function updateTabEl(el, t) {
  el.classList.toggle('active', t.id === state.activeId);
  el.classList.toggle('pinned', !!t.pinned);
  el.classList.toggle('sleeping', !!t.sleeping);
  el.setAttribute('aria-selected', String(t.id === state.activeId));
  // The hover card shows these; screen readers hear them here.
  const capture = captureWords(t.capture);
  el.setAttribute('aria-description', [t.shown || t.url, t.sleeping && 'Sleeping to save memory', t.agent && `${t.agent.name} is working here`, capture].filter(Boolean).join(' · '));
  // Camera, microphone or screen in use (renderer/ui/capture-bar.js).
  const rec = el.querySelector('.rec-dot');
  rec.hidden = !capture;
  if (capture) rec.setAttribute('aria-label', capture);
  // A helper AI is working in this tab: its color, the same as its row in the chat.
  const dot = el.querySelector('.agent-dot');
  dot.hidden = !t.agent;
  if (t.agent) dot.style.setProperty('--c', t.agent.color);
  el.classList.toggle('helped', !!t.agent);
  const fav = faviconHtml(t);
  if (el._fav !== fav) {
    const loaded = el._fav?.includes('spinner') && !t.loading;
    el.querySelector('.fav').innerHTML = fav;
    el._fav = fav;
    // The spinner gives way to the page's icon with a small pop.
    if (loaded && stripMoves()) animate(el.querySelector('.fav'), [{ opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1 }], { duration: 4, easing: 'spring' });
  }
  const img = el.querySelector('.fav img');
  if (img) img.onerror = () => { el.querySelector('.fav').innerHTML = icons.globe; };
  el.querySelector('.title').textContent = t.title || 'Untitled';
  const audio = el.querySelector('.audio');
  audio.hidden = !(t.audible || t.muted);
  audio.innerHTML = t.muted ? icons.muted : icons.volume;
  strip.decorate(el, t); // selected, crashed
}

// The tabs in the order to show: main's, with a drop it hasn't confirmed yet.
function stripOrder() {
  const tabs = state.tabs;
  if (!localMove) return tabs;
  const i = tabs.findIndex((t) => t.id === localMove.id);
  if (i < 0 || i === localMove.index || Date.now() > localMove.until) { localMove = null; return tabs; }
  const order = tabs.slice();
  order.splice(localMove.index, 0, ...order.splice(i, 1));
  return order;
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
  const order = stripOrder();
  const live = liveTabs();
  // Groups changed (a tab joined or left one, a group collapsed): the strip is laid out again.
  const groupsKey = JSON.stringify([state.groups || [], order.map((t) => t.groupId || '')]);
  const same = groupsKey === stripGroups && live.length === order.length && order.every((t, i) => live[i]._id === t.id && live[i].classList.contains('pinned') === !!t.pinned);
  if (same || tabDrag) {
    if (tabDrag) tabDrag.pending = true; // tabs opened or closed meanwhile show after the drop
    for (const t of order) { const el = tabEls.get(t.id); if (el) updateTabEl(el, t); }
    return;
  }
  stripGroups = groupsKey;
  hideCard(true);
  layoutStrip(() => {
    const ids = new Set(order.map((t) => t.id));
    for (const [id, el] of tabEls) {
      if (ids.has(id)) continue;
      tabEls.delete(id);
      el.classList.add('closing');
      el.setAttribute('aria-hidden', 'true');
    }
    for (const t of order) {
      let el = tabEls.get(t.id);
      if (!el) { el = createTabEl(t.id); tabEls.set(t.id, el); }
      updateTabEl(el, t);
    }
    // The tabs in order, each group's chip before its tabs (renderer/ui/tab-groups.js).
    let prev = null;
    for (const el of tabGroups.layout(order, tabEls, state.groups)) {
      // Right after the previous one, passing over tabs that are folding away.
      let at = prev ? prev.nextElementSibling : tabsEl.firstElementChild;
      while (at && at !== el && at.classList.contains('closing')) at = at.nextElementSibling;
      if (at !== el) tabsEl.insertBefore(el, at);
      prev = el;
    }
  });
}

// A tab held at a width while it animates, or while the strip is frozen.
function holdWidth(el, width) {
  el.style.flex = `0 0 ${width}px`;
  el.style.minWidth = '0px';
}
// No width, padding or gap: where a new tab starts and a closed one ends.
function fold(el) {
  holdWidth(el, 0);
  el.style.paddingInline = '0px';
  el.style.marginRight = '-2px'; // the strip's gap
  el.style.opacity = '0';
}
function release(el) {
  for (const p of ['flex', 'minWidth', 'paddingInline', 'marginRight', 'opacity']) el.style[p] = '';
}

// Chrome's trick for closing tabs in a row: while the pointer stays on the
// strip, the other tabs keep their widths, so the next tab's × slides under
// it. Leaving the strip lets them spread out again.
let frozen = false;
function freezeTabs() {
  frozen = true;
  for (const el of liveTabs()) {
    if (el.classList.contains('pinned')) continue;
    el._frozen = el.getBoundingClientRect().width;
    holdWidth(el, el._frozen);
  }
}
function thaw() {
  frozen = false;
  for (const el of liveTabs()) el._frozen = null;
}
// After a moment: the gaps between tabs belong to the window's drag area,
// which the pointer can brush past without really leaving.
let thawTimer = 0;
$('#tabstrip').addEventListener('pointerleave', () => {
  clearTimeout(thawTimer);
  thawTimer = setTimeout(() => {
    if (!frozen || tabDrag) return;
    thaw();
    layoutStrip(() => {});
  }, 250);
});
$('#tabstrip').addEventListener('pointerover', () => clearTimeout(thawTimer));
// A new window width lays the tabs out again at once.
let stripWidth = 0;
new ResizeObserver(([e]) => {
  if (e.contentRect.width === stripWidth) return;
  stripWidth = e.contentRect.width;
  if (!frozen) return;
  thaw();
  for (const el of liveTabs()) release(el);
}).observe($('#tabstrip'));

// Tabs open, close, get pinned or change places in `change`. Each tab then
// animates from where it was to where the strip's layout puts it: widths
// grow and shrink together (so neighbors and the + button make room as one),
// a new tab grows in from nothing while its icon and title fade in, a closed
// one folds away, and tabs that changed places glide there (FLIP).
let stripRun = 0;
function layoutStrip(change) {
  const animate = stripMoves();
  const before = new Map();
  if (animate) for (const el of tabsEl.children) before.set(el, el.getBoundingClientRect());
  const had = new Set(liveTabs());
  change();
  const run = ++stripRun;
  const live = liveTabs();
  const added = live.filter((el) => !had.has(el));
  if (added.length) thaw(); // a new tab: the strip spreads out again
  // Where everything goes: the natural layout (or the frozen widths), measured
  // with transitions off and closed tabs out of the way.
  tabsEl.classList.remove('sizing');
  tabsEl.classList.add('measuring');
  for (const el of live) {
    cancel(el, 'slide');
    if (frozen && el._frozen != null && !el.classList.contains('pinned')) holdWidth(el, el._frozen);
    else { el._frozen = null; release(el); }
  }
  const target = new Map(live.map((el) => [el, el.getBoundingClientRect().width]));
  tabsEl.classList.remove('measuring');
  const closing = [...tabsEl.children].filter((el) => el.classList.contains('closing'));
  if (!animate) {
    for (const el of closing) dropTabEl(el);
    strip.settled();
    return;
  }
  // Where everything was: the old widths, new tabs folded.
  for (const el of live) { const b = before.get(el); if (b) holdWidth(el, b.width); else fold(el); }
  for (const el of closing) holdWidth(el, before.get(el)?.width ?? 0);
  const chips = [...tabsEl.querySelectorAll(':scope > .tab-group-chip')];
  const start = new Map([...live, ...chips].map((el) => [el, el.getBoundingClientRect().left]));
  for (const el of [...live, ...chips]) {
    const b = before.get(el);
    if (b && Math.abs(b.left - start.get(el)) > 3) slide(el, b.left - start.get(el));
  }
  // Closing alone is an exit, a step quicker than opening.
  const step = added.length || !closing.length ? 3 : 2;
  tabsEl.style.setProperty('--strip-dur', `${dur(step)}ms`);
  tabsEl.classList.add('sizing');
  for (const el of live) {
    holdWidth(el, target.get(el));
    if (added.includes(el)) { el.style.paddingInline = el.style.marginRight = el.style.opacity = ''; enterTab(el); }
  }
  for (const el of closing) fold(el);
  setTimeout(() => settleStrip(run), dur(step) + 60);
}

// A new tab's icon pops and its title fades in as it grows.
function enterTab(el) {
  el.classList.add('entering');
  animate(el.querySelector('.fav'), [{ opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1 }], { duration: 4, easing: 'spring', delay: 40, fill: 'backwards' });
  animate(el.querySelector('.title'), [{ opacity: 0 }, { opacity: 1 }], { duration: 3, delay: 80, fill: 'backwards' });
}

// The animation is over: tabs go back to the strip's own layout (or stay
// frozen), and closed ones leave.
function settleStrip(run) {
  if (run !== stripRun) return; // a newer change took over
  tabsEl.classList.remove('sizing');
  for (const el of [...tabsEl.children]) {
    if (el.classList.contains('closing')) { dropTabEl(el); continue; }
    el.classList.remove('entering');
    if (!(frozen && el._frozen != null && !el.classList.contains('pinned'))) release(el);
  }
  strip.settled();
}

function dropTabEl(el) {
  narrowWatch.unobserve(el);
  el.remove();
}

function startTabDrag(e, el, id) {
  if (e.button !== 0 || e.target.closest('.x, .audio')) return;
  hideCard(true);
  if (strip.pointerDown(e, el, id)) return; // Shift/⌘-clicks, and dragging several tabs
  api.send('tab:activate', id);
  const els = liveTabs().filter((x) => !x.classList.contains('collapsed-away')); // (group chips stay put)
  const from = els.indexOf(el);
  // Pinned tabs stay first (main/tabs.js insert), so a tab moves within its group.
  const pins = els.filter((x) => x.classList.contains('pinned')).length;
  const [lo, hi] = el.classList.contains('pinned') ? [0, pins - 1] : [pins, els.length - 1];
  const startX = e.clientX;
  const drag = { pending: false };
  let rects = null; // where the tabs are when the drag starts
  let target = from;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (strip.tearOff(ev, el, [id])) { tornOff(); return; } // pulled out: a window of its own
    const dx = ev.clientX - startX;
    if (!rects && Math.abs(dx) < 5) return;
    if (!rects) {
      // Lifted: anything still animating jumps to its end, then the tabs are measured.
      tabDrag = drag;
      settleStrip(stripRun);
      for (const x of els) cancel(x, 'slide');
      el.classList.remove('settling');
      el.classList.add('dragging');
      rects = els.map((x) => x.getBoundingClientRect());
    }
    const min = rects[lo].left - rects[from].left;
    const max = rects[hi].left - rects[from].left;
    const clamped = Math.max(min, Math.min(max, dx));
    el.style.transform = `translateX(${clamped}px)`;
    const center = rects[from].left + rects[from].width / 2 + clamped;
    target = from;
    rects.forEach((r, i) => {
      const mid = r.left + r.width / 2;
      // At the very end of its range the tab is centered on the last one: that counts.
      if (i < from && center <= mid + 0.5) target = Math.min(target, i);
      if (i > from && center >= mid - 0.5) target = Math.max(target, i);
    });
    target = Math.max(lo, Math.min(hi, target));
    const w = rects[from].width + 2;
    els.forEach((x, i) => {
      if (x === el) return;
      x.classList.add('shifting');
      const shift = i > from && i <= target ? -w : i < from && i >= target ? w : 0;
      x.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };
  const stop = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', up);
  };
  // Pulled out of the strip (tabstrip.js tearOff): the tabs go back as they
  // were, and main's next update takes the tab away.
  const tornOff = () => {
    stop();
    if (!rects) return;
    tabDrag = null;
    for (const x of els) { x.style.transform = ''; x.classList.remove('shifting', 'dragging'); }
    renderTabs();
  };
  const up = () => {
    stop();
    if (!rects) return; // a click, not a drag
    tabDrag = null;
    // Dropped: the tab takes its new place in the strip right away (main
    // confirms a moment later), and every tab glides there from where it is
    // on screen; the dragged one lands with a spring.
    const seen = new Map(els.map((x) => [x, x.getBoundingClientRect().left]));
    for (const x of els) { x.style.transform = ''; x.classList.remove('shifting'); }
    el.classList.remove('dragging');
    if (target !== from) {
      tabsEl.insertBefore(el, target > from ? els[target].nextElementSibling : els[target]);
      // Its place among all the tabs (a collapsed group's tabs aren't in els).
      const index = state.tabs.findIndex((t) => t.id === els[target]._id);
      localMove = { id, index, until: Date.now() + 800 };
      api.send('tab:move', { id, index });
    }
    for (const x of els) {
      const dx = seen.get(x) - x.getBoundingClientRect().left;
      if (Math.abs(dx) >= 1) slide(x, dx, x === el ? { duration: 4, easing: 'spring' } : {});
    }
    el.classList.add('settling');
    setTimeout(() => el.classList.remove('settling'), dur(4));
    if (drag.pending) renderTabs();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up); // e.g. the window lost focus mid-drag: drop it there
}

$('#newtab').addEventListener('click', () => api.send('tab:new'));
$('#tabstrip').addEventListener('dblclick', (e) => { if (e.target.classList.contains('strip-drag')) { /* system zoom handles it */ } });

// ------------------------------------------------------------------ tab hover cards
// Resting on a tab shows a card under it: the page's title, its site and a
// small picture of the page (main/window.js showHoverCard). The overlay view
// draws it, so it can sit over the page. Once a card is up, moving along the
// tabs moves it there at once, like Chrome.
const CARD_DELAY = 500; // ms on a tab before its card shows
const CARD_WIDTH = 240; // overlay.css
let cardTab = null; // the tab whose card is up
let cardKey = '';
let cardTimer = 0;
let cardLeaveTimer = 0;
let cardWarmUntil = 0; // a card closed just now: the next one shows without waiting

function siteName(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'lumio:') return 'Lumio';
    if (u.protocol === 'file:') return 'File on this computer';
    return u.hostname.replace(/^www\./, '') || url;
  } catch { return url; }
}

function cardEnter(id) {
  clearTimeout(cardLeaveTimer);
  clearTimeout(cardTimer);
  if (tabDrag) return;
  if (cardTab != null || Date.now() < cardWarmUntil) showCard(id);
  else cardTimer = setTimeout(() => showCard(id), CARD_DELAY);
}

function cardLeave() {
  clearTimeout(cardTimer);
  clearTimeout(cardLeaveTimer);
  cardLeaveTimer = setTimeout(() => hideCard(), 80); // time to cross the gap to the next tab
}

function showCard(id) {
  const t = state.tabs.find((x) => x.id === id);
  const el = tabEls.get(id);
  // Menus and prompts keep the overlay; a dragged tab has no card.
  if (!t || !el || tabDrag || (overlayKind && overlayKind !== 'hovercard')) return;
  const r = el.getBoundingClientRect();
  // The view spans the strip, so the card can slide from tab to tab inside it.
  const left = Math.max(0, Math.round(tabsEl.getBoundingClientRect().left) - 12);
  const width = Math.round(window.innerWidth - left);
  const card = {
    id,
    x: Math.round(Math.max(0, Math.min(r.left - left - 12, width - 24 - CARD_WIDTH))),
    title: t.title || 'Untitled',
    site: siteName(t.url),
    sleeping: !!t.sleeping,
    agent: t.agent ? { name: t.agent.name, title: t.agent.title, color: t.agent.color } : null,
  };
  const key = JSON.stringify(card);
  if (cardTab === id && key === cardKey && overlayKind === 'hovercard') return;
  cardTab = id;
  cardKey = key;
  overlayKind = 'hovercard';
  api.send('tab:hovercard', { rect: { x: left, y: Math.round(r.bottom) + 2, width, height: 300 }, card });
}

// instant: you clicked or dragged, so the next card waits again.
function hideCard(instant = false) {
  clearTimeout(cardTimer);
  clearTimeout(cardLeaveTimer);
  if (cardTab == null) return;
  cardTab = null;
  cardKey = '';
  cardWarmUntil = instant ? 0 : Date.now() + 300;
  if (overlayKind !== 'hovercard') return; // a menu took the overlay meanwhile
  overlayKind = null;
  api.send('tab:hovercard', { hide: true });
}
tabsEl.addEventListener('wheel', () => hideCard(true), { passive: true });
window.addEventListener('blur', () => hideCard(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) hideCard(true); });

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
  paintSiteIcon(el, omniFocused ? null : t);
  if (omniFocused || !t?.url) el.innerHTML = icons.search; // typing: it's a search box
}

function renderToolbar() {
  const t = activeTab();
  $('#back').disabled = !t?.canGoBack;
  $('#forward').disabled = !t?.canGoForward;
  $('#reload').innerHTML = t?.loading ? icons.stop : icons.reload;
  $('#reload').title = t?.loading ? 'Stop loading' : 'Reload (⌘R)';
  // t.shown: the address with international names in their own letters when they're safe to show (main/lookalike.js).
  if (!omniFocused) {
    address.value = prettyUrl(t?.shown || t?.url || '');
    address.classList.toggle('url-view', !!t?.url);
  } else if (!omniEdited && address.value !== (t?.shown || t?.url || '')) {
    // The page changed under a focused, untouched address bar (a bookmark,
    // a link, or Lumio navigating): show the new address.
    address.value = t?.shown || t?.url || '';
  }
  const star = $('#star');
  star.hidden = !t?.url || !/^https?:/.test(t.url);
  star.classList.toggle('on', !!t?.bookmarked);
  star.innerHTML = t?.bookmarked ? icons.starFilled : icons.star;
  siteIcon(t);
  popups.render(t);
  renderZoomBadge(t?.zoom);
  if (typeof renderPwKey === 'function') renderPwKey();
  // With several profiles, the window's title says whose it is (Guest's too).
  const name = state.profiles.length > 1 && state.profiles.find((p) => p.current)?.name;
  const who = state.guest ? ' (Guest)' : name ? ` (${name})` : '';
  document.title = `${t ? `${t.title} — ` : ''}Lumio Browser${state.incognito ? ' (Incognito)' : ''}${who}`;
  // Extension buttons show the state for the active tab.
  const ext = $('#ext-actions');
  if (t?.wcId && ext.getAttribute('tab') !== String(t.wcId)) ext.setAttribute('tab', String(t.wcId));
}

$('#back').addEventListener('click', () => api.send('tab:back'));
$('#forward').addEventListener('click', () => api.send('tab:forward'));
$('#reload').addEventListener('click', () => api.send(activeTab()?.loading ? 'tab:stop' : 'tab:reload'));
$('#star').addEventListener('click', () => api.send('tab:bookmark'));
initNavigation({ api }); // history menus, new-tab clicks, mouse buttons, Home

address.addEventListener('focus', () => {
  omniFocused = true;
  omniEdited = false;
  omnibox.classList.add('focused');
  const t = activeTab();
  address.value = t?.shown || t?.url || '';
  address.classList.remove('url-view');
  swapSiteIcon(() => siteIcon(t));
  // (select() would take focus back if it moved on within the frame: F6 twice.)
  requestAnimationFrame(() => { if (document.activeElement === address) address.select(); });
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
  swapSiteIcon(renderToolbar);
});
// Focusing the field turns the lock into a search icon (and back): a quick crossfade.
function swapSiteIcon(change) {
  const el = $('#site-icon');
  const was = el.innerHTML;
  change();
  if (el.innerHTML !== was) animate(el, [{ opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1 }], { duration: 2 });
}
// Typing, suggestions, chips and the address bar's keys (renderer/ui/omnibox.js).
const omni = initOmnibox({
  api,
  address,
  box: omnibox,
  activeTab,
  ask: (text) => { panel.open(); panel.sendText(text); },
  edited: () => { omniEdited = true; },
  textScale,
  overlay: {
    open: () => overlayKind === 'suggest',
    show: (rect, payload) => { overlayKind = 'suggest'; api.send('overlay:show', { rect, payload }); },
    hide: () => { if (overlayKind === 'suggest') hideOverlay(); },
  },
});

function hideOverlay() {
  if (!overlayKind) return;
  const kind = overlayKind;
  overlayClosed();
  api.send('overlay:hide', kind);
}
function overlayClosed() {
  overlayKind = null;
  accountBtn.classList.remove('open');
  menuBtn.classList.remove('open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
// Where a dropdown grows from: the middle of its button.
const anchorOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

// Main closed what this window opened (a tab switch, a choice in it, a
// click outside the ⋮ menu), or the pointer moved to a suggestion, which
// Enter now opens.
api.on('overlay-state', ({ kind, closed, hover } = {}) => {
  if (kind === 'suggest' && overlayKind === 'suggest' && Number.isInteger(hover)) omni.onHover(hover);
  if (closed && kind === overlayKind) overlayClosed();
});
api.on('overlay-picked', (msg) => {
  if (msg.kind === 'suggest') omni.onPicked(msg);
  if (['downloads', 'siteinfo', 'account', 'autofill', 'update', 'zoom'].includes(msg.kind)) { overlayKind = null; accountBtn.classList.remove('open'); }
  if (msg.kind === 'popups') { overlayKind = null; if (!$('#popups-btn').hidden) $('#popups-btn').focus(); }
  if (msg.kind === 'zoom' && msg.refocus) zoomBadge.focus();
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
    payload: { kind: 'pwsave', prompt, accent: accent(), anchor: anchorOf(pwKey) },
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
    payload: { kind: 'siteinfo', info, anchor: anchorOf(siteBtn) },
  });
}
siteBtn.addEventListener('mousedown', (e) => { if (!omniFocused) e.preventDefault(); });
siteBtn.addEventListener('click', () => {
  if (omniFocused || !siteBtn.classList.contains('clickable')) return;
  if (overlayKind === 'siteinfo') hideOverlay(); else showSiteInfo();
});
api.on('site-info', (info) => { if (overlayKind === 'siteinfo' && info) showSiteInfo(info); });
window.addEventListener('mousedown', (e) => { if (overlayKind === 'siteinfo' && !e.target.closest('#site-icon')) hideOverlay(); });

// ------------------------------------------------------------------ blocked pop-ups
const popupsBtn = $('#popups-btn');
const popups = popupsButton(popupsBtn, api);
popupsBtn.addEventListener('mousedown', (e) => { if (!omniFocused) e.preventDefault(); });
popupsBtn.addEventListener('click', async () => {
  if (overlayKind === 'popups') { hideOverlay(); return; }
  if (await popups.show()) overlayKind = 'popups';
});
window.addEventListener('mousedown', (e) => { if (overlayKind === 'popups' && !e.target.closest('#popups-btn')) hideOverlay(); });

// ------------------------------------------------------------------ toast + zoom
// Short notes ("Bookmarked", "Link copied"…) over the end of the address. A
// new one goes in front and older ones wait in a stack just behind it, each
// getting its full time once it's in front: longer notes stay longer, and the
// pointer on one pauses it. Screen readers hear each (a polite live region).
const toastStack = $('#toast');
toastStack.hidden = false;
toastStack.setAttribute('role', 'status');
toastStack.setAttribute('aria-live', 'polite');
const toasts = []; // newest first: { el, text, left (ms still to show), since, timer }
let toastHeld = false;
const readTime = (text) => Math.min(6000, Math.max(2000, text.length * 55));
function toast(text) {
  const front = toasts[0];
  if (front?.text === text) { pauseToast(); front.left = readTime(text); runToast(); return; }
  pauseToast();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  el.title = text;
  el.addEventListener('pointerenter', () => { toastHeld = true; pauseToast(); });
  el.addEventListener('pointerleave', () => { toastHeld = false; runToast(); });
  toastStack.prepend(el);
  toasts.unshift({ el, text, left: readTime(text), since: 0, timer: 0 });
  while (toasts.length > 3) dropToast(toasts.pop());
  stackToasts();
  runToast();
}
// Those behind the front one show as blank cards of its width, just peeking out.
function stackToasts() {
  const width = toasts[0]?.el.offsetWidth || 0;
  toasts.forEach((t, i) => {
    t.el.style.setProperty('--depth', i);
    t.el.classList.toggle('behind', i > 0);
    t.el.style.width = i ? `${width}px` : '';
  });
}
// Only the front note's time runs.
function runToast() {
  const t = toasts[0];
  if (!t || toastHeld || t.since) return;
  t.since = Date.now();
  t.timer = setTimeout(() => { toasts.shift(); dropToast(t); stackToasts(); runToast(); }, t.left);
}
function pauseToast() {
  const t = toasts[0];
  if (!t?.since) return;
  clearTimeout(t.timer);
  t.left = Math.max(1000, t.left - (Date.now() - t.since));
  t.since = 0;
}
function dropToast(t) {
  clearTimeout(t.timer);
  if (t.el.matches(':hover')) toastHeld = false;
  t.el.classList.add('out');
  setTimeout(() => t.el.remove(), dur(2) + 50);
}
api.on('toast', ({ text }) => toast(text));

// Zoom: the badge shows when a page isn't at the default zoom. Zooming, or
// clicking the badge, opens the bubble under it (overlay-zoom.js): the level,
// − and +, and Reset. Opened by zooming, it goes away by itself.
const zoomBadge = $('#zoom-badge');
let zoomAuto = false;
function renderZoomBadge(percent) {
  zoomBadge.hidden = !percent;
  if (!percent) return;
  zoomBadge.textContent = `${percent}%`;
  zoomBadge.title = `Zoom: ${percent}%`;
  zoomBadge.setAttribute('aria-label', `Zoom: ${percent}%. Change zoom`);
}
function showZoomBubble(percent, { auto = false, focus = false } = {}) {
  const anchor = [zoomBadge, $('#star'), omnibox].find((el) => !el.hidden);
  const r = anchor.getBoundingClientRect();
  const width = 250;
  overlayKind = 'zoom';
  zoomAuto = auto;
  api.send('overlay:show', {
    rect: { x: r.right - width - 12 + 8, y: r.bottom + 8, width: width + 24, height: 54 + 26 },
    payload: { kind: 'zoom', percent, auto, focus, accent: accent() },
  });
}
api.on('zoom', ({ level, zoomed }) => {
  renderZoomBadge(zoomed ? level : null);
  if (!overlayKind || overlayKind === 'zoom') showZoomBubble(level, { auto: !overlayKind || zoomAuto });
});
zoomBadge.addEventListener('mousedown', (e) => e.preventDefault());
zoomBadge.addEventListener('click', (e) => {
  if (overlayKind === 'zoom' && !zoomAuto) { hideOverlay(); return; }
  // From the keyboard (Enter or Space), the bubble takes the keyboard.
  showZoomBubble(activeTab()?.zoom || 100, { focus: e.detail === 0 });
});
window.addEventListener('mousedown', (e) => { if (overlayKind === 'zoom' && !e.target.closest('#zoom-badge')) hideOverlay(); });

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
  // A new download nudges the button (its first one also opens its slot, shell.css).
  if (started) animate(dlBtn, [{ translate: '0 -4px' }, { translate: '0 0' }], { duration: 4, easing: 'spring' });
  // A risky file waits for Keep or Discard: open the bubble once so the person sees why.
  const risky = items.filter((d) => d.danger && !warned.has(d.id));
  risky.forEach((d) => warned.add(d.id));
  if (risky.length && (!overlayKind || overlayKind === 'downloads')) showDownloads();
  else if (overlayKind === 'downloads') showDownloads();
}
const warned = new Set(); // risky downloads whose bubble already opened by itself
function showDownloads() {
  const r = dlBtn.getBoundingClientRect();
  const width = 360;
  const height = Math.min(420, Math.ceil((state.downloads.reduce((h, d) => h + (d.danger ? 118 : 54), 0) + 56) * textScale())) + 26 + 38;
  overlayKind = 'downloads';
  api.send('overlay:show', {
    rect: { x: r.right - width + 12, y: r.bottom + 2, width: width + 24, height },
    payload: { kind: 'downloads', items: state.downloads, anchor: anchorOf(dlBtn) },
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
  accountBtn.innerHTML = avatarHtml({ profile: state.profile, account: state.account, incognito: state.incognito, guest: state.guest, size: 26 });
  accountBtn.classList.toggle('connecting', !!state.account.connecting);
  const a = state.account;
  accountBtn.title = state.incognito ? 'Incognito' : state.guest ? 'Guest'
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
    payload: { kind: 'account', account: state.account, profile: state.profile, incognito: state.incognito, guest: state.guest, profiles: state.profiles, accent: accent(), anchor: anchorOf(accountBtn) },
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
api.on('profiles-changed', (list) => { state.profiles = Array.isArray(list) ? list : []; renderAccount(); renderToolbar(); });

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
  const btn = updateBtn.hidden ? $('#account-btn') : updateBtn;
  const r = btn.getBoundingClientRect();
  const width = 360;
  overlayKind = 'update';
  api.send('overlay:show', {
    rect: { x: r.right - width - 12 + 8, y: r.bottom + 8, width: width + 24, height: 320 },
    payload: { kind: 'update', update: u, accent: accent(), anchor: anchorOf(btn) },
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
api.on('update-announce', (u) => { if (!overlayKind || overlayKind === 'hovercard') { renderUpdate(u); showUpdateCard(u); } });

// ------------------------------------------------------------------ ⋮ menu
// Chrome's main menu, on every platform (the Mac keeps its menu bar too).
// Main builds it and the overlay draws it over the whole window
// (main/window.js showMenu). This window keeps the keyboard meanwhile, so
// text you were editing stays as it was, and sends the menu its keys.
const menuBtn = $('#menu-btn');
let shellFocusAt = 0; // when this window's UI last took the keyboard (from the page, or another app)
let menuFrom = 'shell';
window.addEventListener('focus', () => { shellFocusAt = performance.now(); });
// A click that brought the keyboard here took it from the page, which gets it back after.
menuBtn.addEventListener('pointerdown', () => { menuFrom = performance.now() - shellFocusAt < 150 ? 'page' : 'shell'; });
menuBtn.addEventListener('mousedown', (e) => e.preventDefault()); // the field you're in keeps its caret
menuBtn.addEventListener('click', (e) => {
  if (overlayKind === 'menu') { hideOverlay(); return; }
  const r = menuBtn.getBoundingClientRect();
  const from = e.detail ? menuFrom : 'shell'; // detail 0: Enter or Space
  overlayKind = 'menu';
  menuBtn.classList.add('open');
  menuBtn.setAttribute('aria-expanded', 'true');
  api.send('app:menu', {
    anchor: anchorOf(menuBtn),
    at: { right: Math.round(r.right), top: Math.round(r.bottom + 4) },
    keyboard: !e.detail, // opened from the keyboard: its first row is selected
    from,
    // Cut, Copy and Paste act on the text field you're in, or else the page.
    edit: from === 'shell' && !!document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable]:not([contenteditable=false])'),
  });
});
const MENU_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End']);
const MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph']);
window.addEventListener('keydown', (e) => {
  if (overlayKind !== 'menu' || e.isComposing) return;
  // Tab, or a shortcut (which still does what it does), closes it.
  if (e.key === 'Tab' || ((e.metaKey || e.ctrlKey || e.altKey) && !MODIFIERS.has(e.key))) { hideOverlay(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!MENU_KEYS.has(e.key) && e.key.length !== 1) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  api.send('overlay:key', e.key);
}, true);
// It was placed for this window's size.
window.addEventListener('resize', () => { if (overlayKind === 'menu') hideOverlay(); });

// ------------------------------------------------------------------ bars over the page
initInfobars({ api }); // Restore pages?, the default browser

// ------------------------------------------------------------------ permission chip
// Site permission questions and blocked notices (renderer/ui/permission-chip.js).
const permChip = initPermissionChip({
  api,
  getActiveTab: activeTab,
  overlay: {
    show: (kind, rect, payload) => { overlayKind = kind; api.send('overlay:show', { rect, payload }); },
    hide: (kind) => { if (overlayKind === kind) hideOverlay(); },
    picked: () => { overlayKind = null; },
    kind: () => overlayKind,
  },
});

// ------------------------------------------------------------------ capture bar
// "Sharing this tab" / "Sharing your screen" with Stop sharing (renderer/ui/capture-bar.js).
initCaptureBar({ api });

// ------------------------------------------------------------------ find bar
// Each tab keeps its own: switching tabs hides the bar (the page keeps its
// highlights) and coming back shows it again with the same words, like Chrome.
const findbar = $('#findbar');
const findInput = $('#find-input');
const findTabs = new Map(); // tab id -> { text, count } while its bar is open
function openFind() {
  findbar.hidden = false;
  // Toasts make way for it (shell.css #toast).
  omnibox.style.setProperty('--find-room', `${findbar.offsetWidth + 6}px`);
  findInput.focus();
  findInput.select();
  if (findInput.value) api.send('find:start', { text: findInput.value });
}
function closeFind(focusPage = true) {
  findTabs.delete(state.activeId);
  if (findbar.hidden) return;
  findbar.hidden = true;
  omnibox.style.removeProperty('--find-room');
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
// Main says this before another tab shows.
function parkFind() {
  if (findbar.hidden) return;
  findTabs.set(state.activeId, { text: findInput.value, count: $('#find-count').textContent });
  findbar.hidden = true;
}
function restoreFind() {
  for (const id of findTabs.keys()) if (!state.tabs.some((t) => t.id === id)) findTabs.delete(id);
  const saved = findTabs.get(state.activeId);
  if (!saved || !findbar.hidden) return;
  findInput.value = saved.text;
  $('#find-count').textContent = saved.count;
  findbar.hidden = false;
}
api.on('find-open', openFind);
api.on('find-close', parkFind);
// ⌘E (Use Selection for Find): the page's selection is what Find looks for next.
api.on('find-text', ({ text }) => {
  findInput.value = text;
  if (!findbar.hidden) api.send('find:start', { text });
});
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

// ------------------------------------------------------------------ page tools
// Translate, Reading mode and Share sit in the address bar, media controls in
// the toolbar (renderer/ui/translate.js, reading-mode.js, share.js, media.js).
// Their popovers hang over the page, in the overlay view.
const pageOverlay = {
  get kind() { return overlayKind; },
  open: (kind, rect, payload) => { overlayKind = kind; api.send('overlay:show', { rect, payload }); },
  close: hideOverlay,
  picked: () => { overlayKind = null; },
};
const translate = initTranslate({ api, activeTab, isTyping: () => omniFocused, getAccent: () => accent(), overlay: pageOverlay });
const readingMode = initReadingMode({ api, activeTab, onLayout: reportSlot });
const share = initShare({ api, activeTab, overlay: pageOverlay, getAccent: () => accent() });
const media = initMedia({ api, activeTab, overlay: pageOverlay, getAccent: () => accent() });
const renderPageTools = () => { translate.render(); readingMode.onTabs(); share.render(); media.render(); };

// ------------------------------------------------------------------ state
api.on('tabs', (s) => {
  const switched = s.activeId !== state.activeId;
  const was = activeTab();
  state.tabs = s.tabs;
  state.groups = s.groups || [];
  state.activeId = s.activeId;
  renderTabs();
  const toolbar = () => {
    renderToolbar();
    bookmarksBar.onTabs(); // the new tab page shows the bar even when it's off
  };
  // A tab switch swaps the toolbar and bookmarks bar at once, like the page;
  // changes on the same tab (a bookmark, an icon appearing) animate.
  if (switched) instantly([$('#toolbar'), $('#bookmarks-bar')], toolbar); else toolbar();
  const t = activeTab();
  if (!switched && t?.bookmarked && was?.id === t.id && !was.bookmarked) popStar();
  renderLoad(t, switched);
  if (cardTab != null) showCard(cardTab);
  panel.onTabChange(t, switched);
  renderPageTools();
  restoreFind();
  permChip.update(switched, s.tabs.map((x) => x.wcId).filter((id) => id != null));
});

// Bookmarking a page pops its star.
function popStar() {
  animate($('#star'), [{ scale: 0.5, rotate: '-25deg' }, { scale: 1, rotate: '0deg' }], { duration: 5, easing: 'spring' });
}

// ------------------------------------------------------------------ load progress
// A thin accent line along the address bar's bottom edge while the page you're
// on loads. Main reports real steps (tab.progress: started .1, the page
// answered .35, its document is ready .7); between them the line creeps on
// toward the next, slowing down, like nprogress. Done, it fills and fades.
const load = { id: null, p: 0, on: false, timer: 0 };
function setLoad(p, ms = 0, easing = 'out') {
  omnibox.style.setProperty('--load', p.toFixed(3));
  omnibox.style.setProperty('--load-dur', `${ms}ms`);
  omnibox.style.setProperty('--load-ease', `var(--ease-${easing})`);
}
function creep(p) {
  if (reduced()) { setLoad(p); return; }
  const next = p < 0.35 ? 0.35 : p < 0.7 ? 0.7 : 0.95;
  setLoad(p + (next - p) * 0.8, 3000);
}
function renderLoad(t, switched) {
  const loading = !!t?.loading;
  const p = loading ? Math.max(0.1, t.progress || 0) : 0;
  if (switched || (t?.id ?? null) !== load.id || (loading && !load.on)) {
    // Another tab, or a new load: start from where it is, at once.
    clearTimeout(load.timer);
    load.id = t?.id ?? null;
    load.on = loading;
    load.p = p;
    instantly([omnibox], () => { omnibox.classList.toggle('loading', loading); setLoad(loading && !switched ? 0 : p); });
    if (loading) creep(p);
    return;
  }
  if (loading) {
    if (p > load.p) { load.p = p; creep(p); }
    return;
  }
  if (!load.on) return;
  // Done: fill, fade, then reset unseen.
  load.on = false;
  setLoad(1, dur(3));
  load.timer = setTimeout(() => {
    omnibox.classList.remove('loading');
    load.timer = setTimeout(() => setLoad(0), dur(3));
  }, dur(3));
}

const init = await api.invoke('shell:init');
state.tabs = init.tabs.tabs;
state.groups = init.tabs.groups || [];
state.activeId = init.tabs.activeId;
state.downloads = init.downloads;
bookmarksBar.set(init.bookmarks, init.savedGroups);
state.incognito = init.incognito;
state.account = init.account || {};
state.profile = init.profile || {};
state.guest = !!init.guest;
state.profiles = init.profiles || [];
document.body.classList.toggle('incognito', init.incognito);
document.body.classList.toggle('windows', init.platform === 'win32');
$('#incognito-badge').hidden = !init.incognito;
$('#beta-badge').hidden = !init.beta; // Lumio Beta (main/flavor.js)
$('#ext-area').hidden = !init.extensions;
if (init.extensions && init.partition) $('#ext-actions').setAttribute('partition', init.partition); // this profile's extensions
initPerf(api, init);
// The pinned extension buttons and the puzzle-piece menu (renderer/ui/extensions-bar.js),
// with this profile's extensions.
if (init.extensions) initExtensionsBar({ api, button: $('#ext-btn'), list: $('#ext-actions'), partition: init.partition });
renderTabs();
renderToolbar();
renderLoad(activeTab(), true);
renderPageTools();
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
initA11y({ api, tabsEl, address });
// Signing in or out changes what the sidebar shows.
let sidebarSignedIn = !!init.ai?.lumio?.signedIn;
api.on('ai-state', (s) => { if (!!s.lumio?.signedIn !== sidebarSignedIn) { sidebarSignedIn = !!s.lumio?.signedIn; sidebar.refresh(); } });
reportSlot();
if (!activeTab()?.url) setTimeout(() => address.focus(), 50);
