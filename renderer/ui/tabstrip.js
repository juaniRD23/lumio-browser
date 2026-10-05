// The tab strip's extras, the way Chrome does them (shell.js draws the tabs;
// main/tab-strip.js, tab-drag.js and tab-search.js do the work):
//  - many tabs: once they're as narrow as they go, the strip scrolls sideways
//    (wheel or trackpad), fades at the edges, and keeps the tab you're on in view
//  - several tabs at once: Shift-click selects a range, ⌘/Ctrl-click adds or
//    removes one; the tab menu, ⌘W and dragging then act on all of them
//  - right-click the empty part of the strip: its own menu
//  - links, text and files dropped on the strip: on a tab, it opens them; between
//    tabs, a new tab there (an arrow shows where)
//  - pull tabs out of the strip and they become a window that follows the
//    pointer; let go over another window's strip and they join it there
//  - the Search tabs button (and ⌘⇧A): every open tab, in every window
//  - a crashed tab shows a sad face
import { dropTarget, insertIndex, markerX, rangeIds, toggleId, pulledOut } from './strip-math.mjs';

const IS_MAC = /Mac/.test(navigator.platform);
const FADE = 28; // px of fade at a scrolled strip's edges (tabstrip.css), kept clear when showing a tab

export const SAD_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01"/><path d="M8.6 16.3c1.9-1.8 4.9-1.8 6.8 0"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// api: the shell's bridge. getState(): { tabs, activeId }. overlays: the
// shell's dropdown (kind, show, hide, clear), for the tab search list.
export function initTabStrip({ api, getState, overlays }) {
  const strip = document.getElementById('tabstrip');
  const tabsEl = document.getElementById('tabs');
  const searchBtn = document.getElementById('tab-search-btn');
  tabsEl.setAttribute('aria-multiselectable', 'true');

  // (Not closed tabs still folding away in shell.js.)
  const tabEls = () => [...tabsEl.querySelectorAll(':scope > .tab:not(.closing)')];
  const idOf = (el) => Number(el.dataset.id);
  const elOf = (id) => tabsEl.querySelector(`:scope > .tab:not(.closing)[data-id="${id}"]`);
  const order = () => getState().tabs.map((t) => t.id);
  const rects = (els = tabEls()) => els.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });

  // ---------------------------------------------------------------- the marker
  // One arrow over the strip: where a drop or a dragged tab would land.
  const marker = document.createElement('div');
  marker.className = 'strip-marker';
  marker.hidden = true;
  marker.setAttribute('aria-hidden', 'true');
  strip.append(marker);
  let dropOn = null;
  function showMarker(x, on = null) {
    if (dropOn && dropOn !== on) dropOn.classList.remove('drop-on');
    dropOn = on;
    on?.classList.add('drop-on');
    if (x == null) { marker.hidden = true; return; }
    marker.hidden = false;
    marker.classList.toggle('on-tab', !!on);
    marker.style.transform = `translateX(${Math.round(x - strip.getBoundingClientRect().left)}px)`;
  }
  const hideMarker = () => showMarker(null);

  // ---------------------------------------------------------------- overflow
  function updateOverflow() {
    const over = tabsEl.scrollWidth > tabsEl.clientWidth + 1;
    tabsEl.classList.toggle('scrolls', over);
    tabsEl.classList.toggle('fade-start', over && tabsEl.scrollLeft > 1);
    tabsEl.classList.toggle('fade-end', over && tabsEl.scrollLeft < tabsEl.scrollWidth - tabsEl.clientWidth - 1);
  }
  // The tab you're on, scrolled into view (clear of the fade).
  function reveal(el, smooth = true) {
    if (!el || !tabsEl.classList.contains('scrolls')) return;
    const box = tabsEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let by = 0;
    if (r.left < box.left + FADE) by = r.left - box.left - FADE;
    else if (r.right > box.right - FADE) by = r.right - box.right + FADE;
    if (by) tabsEl.scrollBy({ left: by, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  }
  let shown = null; // the active tab's element last time
  function afterChange() {
    updateOverflow();
    const active = tabsEl.querySelector(':scope > .tab.active:not(.closing)');
    if (active !== shown) { reveal(active, !!shown); shown = active; }
  }
  // shell.js's strip animation ended: tabs are at their real widths now, so
  // the tab you're on is brought into view again.
  function settled() {
    updateOverflow();
    reveal(tabsEl.querySelector(':scope > .tab.active:not(.closing)'), false);
  }
  new ResizeObserver(afterChange).observe(tabsEl);
  new MutationObserver(afterChange).observe(tabsEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  tabsEl.addEventListener('scroll', updateOverflow, { passive: true });
  // A mouse wheel scrolls the strip sideways; trackpads already do.
  tabsEl.addEventListener('wheel', (e) => {
    if (!tabsEl.classList.contains('scrolls') || e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * tabsEl.clientWidth : e.deltaY;
    tabsEl.scrollBy({ left: px, behavior: Math.abs(px) >= 50 && !reducedMotion() ? 'smooth' : 'auto' });
  }, { passive: false });

  // ---------------------------------------------------------------- selection
  let selected = []; // ids in strip order, always with the tab you're on
  let anchor = null; // where a Shift-click range starts
  let lastActive = null;
  let expected = null; // { id, at }: a tab this module just asked to show
  let sent = '';
  const isSelected = (id) => selected.length > 1 && selected.includes(id);
  function paintSelection() {
    for (const el of tabEls()) el.classList.toggle('selected', isSelected(idOf(el)));
  }
  function tell() {
    if (selected.join() === sent) return;
    sent = selected.join();
    api.send('tab:selection', selected);
  }
  function select(ids) {
    selected = order().filter((id) => ids.includes(id));
    tell();
    paintSelection();
  }
  function show(id) {
    if (id !== getState().activeId) expected = { id, at: Date.now() };
    api.send('tab:activate', id);
  }
  // Each update: forget closed tabs, and switching tabs another way (a click
  // elsewhere, the keyboard) leaves just the new tab selected. While a tab
  // asked for here is still on its way, the selection waits for it.
  api.on('tabs', (s) => {
    const ids = s.tabs.map((t) => t.id);
    let next = selected.filter((id) => ids.includes(id));
    const waiting = expected && s.activeId !== expected.id && ids.includes(expected.id) && Date.now() - expected.at < 1000;
    if (!waiting) {
      if (s.activeId !== lastActive && s.activeId !== expected?.id) next = [];
      if (s.activeId != null && !next.includes(s.activeId)) next = [s.activeId];
      expected = null;
    }
    lastActive = s.activeId;
    if (anchor != null && !ids.includes(anchor)) anchor = null;
    selected = ids.filter((id) => next.includes(id));
    tell();
    queueMicrotask(paintSelection); // after shell.js has drawn the tabs
  });

  // Shift-click: from the anchor to here (⌘/Ctrl-Shift adds the range).
  // ⌘/Ctrl-click: this tab joins the selection, or leaves it.
  function selectClick(id, { range, toggle }) {
    const { activeId } = getState();
    if (range) {
      const span = rangeIds(order(), anchor ?? activeId, id);
      select(toggle ? [...selected, ...span] : span);
      if (id !== activeId) show(id);
      return;
    }
    const r = toggleId(order(), selected.length ? selected : [activeId], id, activeId);
    anchor = id;
    if (r.active !== activeId) show(r.active);
    select(r.selected);
  }

  // shell.js's startTabDrag asks first. True: handled here (a selection
  // click, or dragging several selected tabs); false: an ordinary click or
  // drag of one tab, which also makes it the only one selected.
  let grabbed = null; // where the pointer went down on the tab being dragged
  function pointerDown(e, el, id) {
    const toggle = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.shiftKey || toggle) { e.preventDefault(); selectClick(id, { range: e.shiftKey, toggle }); return true; }
    const r = el.getBoundingClientRect();
    grabbed = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (isSelected(id)) { dragSeveral(e, el, id); return true; }
    anchor = id;
    if (id !== getState().activeId) expected = { id, at: Date.now() };
    select([id]);
    return false;
  }

  // Several selected tabs dragged together: the one you hold follows the
  // pointer and the arrow shows where the group goes. A click without
  // dragging leaves just this tab selected (Chrome's rule).
  function dragSeveral(e, el, id) {
    const ids = selected.slice();
    const others = tabEls().filter((x) => !ids.includes(idOf(x)));
    const otherRects = rects(others);
    const start = el.getBoundingClientRect();
    const startX = e.clientX;
    let moving = false;
    let before = null;
    el.setPointerCapture(e.pointerId);
    const finish = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.style.transform = '';
      for (const x of tabEls()) x.classList.remove('dragging', 'drag-ghost');
      hideMarker();
    };
    function move(ev) {
      if (tearOff(ev, el, ids)) { finish(); return; }
      const dx = ev.clientX - startX;
      if (!moving && Math.abs(dx) < 5) return;
      if (!moving) {
        moving = true;
        el.classList.add('dragging');
        for (const x of tabEls()) if (x !== el && ids.includes(idOf(x))) x.classList.add('drag-ghost');
      }
      el.style.transform = `translateX(${dx}px)`;
      before = insertIndex(otherRects, start.left + start.width / 2 + dx);
      showMarker(markerX(otherRects, { index: before, on: null }));
    }
    function up() {
      finish();
      if (moving && before != null) api.send('tab:move-many', { ids, before });
      else if (!moving) { anchor = id; select([id]); show(id); }
    }
    function cancel() { finish(); }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  }

  // ---------------------------------------------------------------- pulling tabs out
  // Called on each move of a tab drag. Once the pointer is out of the strip,
  // main moves the tabs to a window of their own (or moves this window, when
  // they're all its tabs) and this window keeps sending where the pointer is
  // until the button comes up.
  let tear = null;
  function tearOff(ev, el, ids) {
    if (tear) return true;
    if (!pulledOut({ x: ev.clientX, y: ev.clientY }, strip.getBoundingClientRect(), { width: innerWidth })) return false;
    const whole = ids.length >= getState().tabs.length;
    const tab = el.getBoundingClientRect();
    const first = tabsEl.getBoundingClientRect();
    const at = grabbed || { x: tab.width / 2, y: tab.height / 2 };
    // Where the pointer is in the new window: on its first tab, where it held this one.
    const spot = whole ? { x: ev.clientX, y: ev.clientY } : { x: first.left + at.x, y: tab.top + at.y };
    api.send('tab:tear', { ids, screenX: ev.screenX, screenY: ev.screenY, grabX: spot.x, grabY: spot.y });
    hideMarker();
    // The tab's element goes away with it: the page itself keeps the pointer.
    const body = document.body;
    tear = { pointerId: ev.pointerId };
    try { body.setPointerCapture(ev.pointerId); } catch { /* the button is already up */ }
    const where = (e) => ({ screenX: e.screenX, screenY: e.screenY });
    const onMove = (e) => api.send('tab:drag-move', where(e));
    const done = (e, cancelled = false) => {
      if (!tear) return;
      tear = null;
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerup', onUp);
      body.removeEventListener('lostpointercapture', onLost);
      removeEventListener('keydown', onKey, true);
      if (cancelled) api.send('tab:drag-cancel');
      else api.send('tab:drag-end', where(e));
    };
    const onUp = (e) => done(e);
    const onLost = (e) => { if (e.target === body) done(e); }; // not the tab's own (it bubbles up)
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(e, true); } };
    body.addEventListener('pointermove', onMove);
    body.addEventListener('pointerup', onUp);
    body.addEventListener('lostpointercapture', onLost);
    addEventListener('keydown', onKey, true);
    return true;
  }

  // Another window's tabs are being dragged over this strip: show where
  // they'd land and tell main the spot. x: in this window.
  api.on('tab-drag-hint', (where) => {
    if (!where || !Number.isFinite(where.x)) { hideMarker(); return; }
    const r = rects();
    const index = insertIndex(r, where.x);
    showMarker(r.length ? markerX(r, { index, on: null }) : tabsEl.getBoundingClientRect().left);
    api.send('tab:drag-index', index);
  });
  // Where this strip is, so a tab dragged from another window can land on it.
  const reportStrip = () => {
    const r = strip.getBoundingClientRect();
    api.send('tab:strip-rect', { x: r.left, y: r.top, width: r.width, height: r.height });
  };
  new ResizeObserver(reportStrip).observe(strip);

  // ---------------------------------------------------------------- the strip's menu
  // Right-click the empty part of the strip (not a tab or a button).
  strip.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tab, button, #incognito-badge')) return;
    e.preventDefault();
    api.send('tab:strip-context');
  });

  // ---------------------------------------------------------------- drops
  const droppable = (dt) => dt && ['Files', 'text/uri-list', 'text/plain'].some((t) => dt.types.includes(t));
  // Middle half of a tab: onto it; the rest, and the empty strip: between tabs.
  function dropSpot(x) {
    const els = tabEls();
    const t = dropTarget(rects(els), x);
    return { ...t, el: t.on == null ? null : els[t.on], els };
  }
  strip.addEventListener('dragover', (e) => {
    if (!droppable(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const spot = dropSpot(e.clientX);
    const r = rects(spot.els);
    showMarker(r.length ? markerX(r, spot) : tabsEl.getBoundingClientRect().left, spot.el);
  });
  strip.addEventListener('dragleave', (e) => { if (!strip.contains(e.relatedTarget)) hideMarker(); });
  strip.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!droppable(dt)) return;
    e.preventDefault();
    const spot = dropSpot(e.clientX);
    hideMarker();
    const msg = { on: spot.el ? idOf(spot.el) : null, index: spot.index };
    const files = [...(dt.files || [])].map((f) => api.pathForFile?.(f)).filter(Boolean);
    if (files.length) msg.files = files;
    else {
      msg.url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'))?.trim() || '';
      msg.text = dt.getData('text/plain') || '';
    }
    if (msg.files || msg.url || msg.text.trim()) api.send('tab:drop', msg);
  });

  // ---------------------------------------------------------------- tab search
  // The button (like Chrome's ⌄ at the strip's end) and ⌘⇧A open the list;
  // pressing either again closes it.
  searchBtn.innerHTML = CHEVRON;
  let openOnDown = false;
  searchBtn.addEventListener('mousedown', (e) => { e.preventDefault(); openOnDown = overlays.kind === 'tabsearch'; });
  searchBtn.addEventListener('click', (e) => {
    const wasOpen = openOnDown || overlays.kind === 'tabsearch';
    openOnDown = false;
    if (wasOpen) { overlays.hide(); return; }
    openSearch(e.detail === 0 ? 'shell' : 'page'); // from the keyboard, back to the button after
  });
  api.on('tab-search', () => {
    if (overlays.kind !== 'tabsearch') { openSearch('page'); return; }
    overlays.hide();
    api.send('tab:focus-page'); // the list had the keyboard
  });
  api.on('overlay-picked', (msg) => {
    if (msg?.kind !== 'tabsearch') return;
    overlays.clear('tabsearch');
    if (msg.refocus === 'shell') searchBtn.focus();
  });
  async function openSearch(returnFocus) {
    const data = await api.invoke('shell:tab-search');
    if (!data) return;
    const r = searchBtn.getBoundingClientRect();
    const width = 380;
    const rows = data.tabs.length + data.closed.length;
    const height = Math.min(520, 64 + rows * 46 + (data.closed.length ? 30 : 0)) + 26;
    // The list's right edge lines up with the button (the view has 12 px of shadow room each side).
    overlays.show('tabsearch', { x: r.right - width - 12, y: r.bottom + 4, width: width + 24, height }, { kind: 'tabsearch', ...data, returnFocus });
  }

  // ---------------------------------------------------------------- each tab
  // shell.js calls this as it draws a tab.
  function decorate(el, t) {
    el.dataset.id = String(t.id);
    el.classList.toggle('selected', isSelected(t.id));
    el.classList.toggle('crashed', !!t.crashed);
    if (t.crashed) {
      el.title = `This tab crashed: ${t.title || 'Untitled'}${t.url ? '\n' + t.url : ''}`;
      const label = el.querySelector('.title');
      if (label) label.textContent = `Crashed: ${t.title || 'Untitled'}`;
    }
    el.setAttribute('aria-label', t.crashed ? `Crashed: ${t.title || 'Untitled'}` : t.title || 'Untitled');
  }

  return { pointerDown, tearOff, decorate, settled };
}
