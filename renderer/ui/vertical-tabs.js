// "Show tabs to the side": the window's tabs in a column next to the page
// instead of the strip across the top (main/tab-layout.js keeps the choice
// per window). The toolbar becomes the window's top row. Collapsed, the
// column shows only icons, and hovering it shows the full list as a flyout
// over the page (tab-flyout.js).
//
// The Lumio sidebar (sidebar.js) keeps its own place at the far left and its
// own toggle (⌘⇧S): the column sits beside the pages it switches between,
// right where the strip's tabs were, so nothing else moves around.
import { icons } from './icons.js';
import { renderRows, startReorder } from './tab-rows.js';

const $ = (sel) => document.querySelector(sel);
const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  collapse: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="M16 10l-2 2 2 2"/>'),
  expand: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="M14 10l2 2-2 2"/>'),
};
const HOVER_DELAY = 350; // ms on the collapsed column before the flyout opens
const FLYOUT_W = 260;

export function initVerticalTabs({ api, init, splitDrop, onLayout }) {
  const body = document.body;
  let layout = { vertical: false, collapsed: false };
  let state = init.tabs;
  let focusId = null; // the row that takes keyboard focus (roving tabindex)
  const rows = new Map();
  const send = (channel, payload) => api.send(channel, payload);

  // ---------------------------------------------------------------- the column
  const col = document.createElement('nav');
  col.id = 'vtabs';
  col.setAttribute('aria-label', 'Tabs');
  col.innerHTML = `
    <div class="vt-head">
      <button type="button" class="icon-btn small vt-toggle"></button>
      <span class="vt-badge"></span>
    </div>
    <div class="vt-scroll">
      <div class="vt-tabs" role="tablist" aria-orientation="vertical" aria-label="Tabs"></div>
      <button type="button" class="vt-new" title="New Tab (⌘T)" aria-label="New Tab"><span class="fav">${icons.plus}</span><span class="title">New tab</span></button>
    </div>`;
  $('#workspace').prepend(col);
  const list = col.querySelector('.vt-tabs');
  const toggle = col.querySelector('.vt-toggle');

  // The toolbar's start: room for the Mac's window buttons and the Lumio
  // sidebar's show button, which live in the tab strip otherwise.
  const lead = document.createElement('div');
  lead.className = 'vt-lead';
  lead.innerHTML = '<span class="vt-traffic"></span>';
  $('#toolbar').prepend(lead);

  const tabs = () => state.tabs;
  const shownId = () => {
    const s = state.split;
    if (!s) return null;
    return s.left === state.activeId ? s.right : s.right === state.activeId ? s.left : null;
  };

  function render() {
    renderRows(list, state.tabs, { activeId: state.activeId, shownId: shownId(), rows, send, groups: state.groups || [] });
    if (!rows.has(focusId)) focusId = state.activeId;
    for (const [id, el] of rows) el.tabIndex = id === focusId ? 0 : -1;
    if (flyoutOpen) showFlyout();
  }

  // ---------------------------------------------------------------- layout
  function apply(next) {
    const was = layout;
    layout = { vertical: !!next.vertical, collapsed: !!next.collapsed };
    body.classList.toggle('vtabs', layout.vertical);
    body.classList.toggle('vtabs-collapsed', layout.vertical && layout.collapsed);
    col.inert = !layout.vertical;
    // The sidebar's show button and the incognito badge move with the tabs.
    const strip = $('#tabstrip');
    const sbOpen = $('#sb-open');
    const badge = $('#incognito-badge');
    if (layout.vertical) {
      lead.append(sbOpen);
      col.querySelector('.vt-badge').append(badge);
    } else if (sbOpen.parentNode === lead) {
      strip.insertBefore(sbOpen, $('#tabs'));
      strip.append(badge);
    }
    toggle.innerHTML = layout.collapsed ? IC.expand : IC.collapse;
    toggle.title = layout.collapsed ? 'Expand tabs' : 'Collapse tabs';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!layout.collapsed));
    if (!layout.vertical || !layout.collapsed) hideFlyout();
    // Just collapsed under the pointer: wait until it really moves before
    // opening the flyout (the column shrinking makes the browser re-send
    // pointer events without the person doing anything).
    if (layout.collapsed && !was.collapsed) parkedAt = lastPointer;
    if (was.vertical !== layout.vertical || was.collapsed !== layout.collapsed) onLayout();
    if (layout.vertical) requestAnimationFrame(() => rows.get(state.activeId)?.scrollIntoView({ block: 'nearest' }));
  }
  toggle.addEventListener('click', () => send('layout:tabs', { collapsed: !layout.collapsed }));
  // The column's width animates; the page follows once it settles too.
  col.addEventListener('transitionend', (e) => { if (e.target === col && e.propertyName === 'width') onLayout(); });

  // ---------------------------------------------------------------- mouse
  col.querySelector('.vt-new').addEventListener('click', () => send('tab:new'));
  list.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.vt-tab');
    if (!el) return;
    hideFlyout();
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    startReorder(e, el, {
      list,
      tabs,
      onDown: (id) => { focusId = id; send('tab:activate', id); },
      track: (ev) => splitDrop.track(ev, Number(el.dataset.id)),
      finish: () => splitDrop.finish(Number(el.dataset.id)),
      drop: (id, index) => send('tab:move', { id, index }),
    });
  });
  // Away from a tab: the strip's menu (new tab, tabs at the top…).
  col.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.vt-tab')) return;
    e.preventDefault();
    send('tab:strip-context');
  });
  col.querySelector('.vt-scroll').addEventListener('dblclick', (e) => { if (!e.target.closest('.vt-tab, button')) send('tab:new'); });

  // ---------------------------------------------------------------- keyboard
  // Arrows move between tabs, Enter or Space opens one, Delete closes it,
  // Alt+Shift+arrows move it, the menu key opens its menu, Esc goes back to the page.
  list.addEventListener('keydown', (e) => {
    const el = e.target.closest('.vt-tab');
    if (!el) return;
    const id = Number(el.dataset.id);
    const order = state.tabs.map((t) => t.id);
    const i = order.indexOf(id);
    const go = (j) => {
      const next = rows.get(order[Math.max(0, Math.min(order.length - 1, j))]);
      if (!next) return;
      focusId = Number(next.dataset.id);
      for (const [rid, r] of rows) r.tabIndex = rid === focusId ? 0 : -1;
      next.focus();
    };
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step && e.altKey && e.shiftKey) {
      e.preventDefault();
      const t = state.tabs[i];
      const j = i + step;
      if (state.tabs[j] && !!state.tabs[j].pinned === !!t.pinned) send('tab:move', { id, index: j });
      return;
    }
    if (step) { e.preventDefault(); go(i + step); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); go(e.key === 'Home' ? 0 : order.length - 1); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); send('tab:activate', id); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); go(i + 1 < order.length ? i + 1 : i - 1); send('tab:close', id); return; }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); send('tab:context', id); return; }
    if (e.key === 'Escape') { e.preventDefault(); send('tab:focus-page'); }
  });
  list.addEventListener('focusin', (e) => {
    const el = e.target.closest('.vt-tab');
    if (el) focusId = Number(el.dataset.id);
  });

  // ---------------------------------------------------------------- flyout (collapsed)
  // The page covers the window's own HTML, so the full list is drawn by the
  // overlay above it. Main closes it when the pointer leaves.
  let hoverTimer = 0;
  let flyoutOpen = false;
  let quietUntil = 0; // just closed (a tab was picked in it): don't pop it right back
  function showFlyout() {
    const r = col.getBoundingClientRect();
    if (!r.width) return;
    flyoutOpen = true;
    api.send('overlay:show', {
      rect: { x: r.left, y: r.top, width: FLYOUT_W + 16, height: r.height },
      payload: { kind: 'vtabs', tabs: state.tabs, activeId: state.activeId, shownId: shownId() },
    });
  }
  function hideFlyout() {
    if (!flyoutOpen) return;
    flyoutOpen = false;
    api.send('overlay:hide', 'vtabs');
  }
  let lastPointer = null;
  let parkedAt = null;
  window.addEventListener('pointermove', (e) => { lastPointer = `${e.clientX},${e.clientY}`; }, true);
  const hover = (e) => {
    if (!layout.collapsed || e.buttons || Date.now() < quietUntil || flyoutOpen || hoverTimer) return;
    if (parkedAt && parkedAt === `${e.clientX},${e.clientY}`) return;
    parkedAt = null;
    hoverTimer = setTimeout(() => { hoverTimer = 0; showFlyout(); }, HOVER_DELAY);
  };
  col.addEventListener('pointerenter', hover);
  col.addEventListener('pointermove', hover);
  col.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); hoverTimer = 0; });
  api.on('overlay-picked', (m) => {
    if (m?.kind !== 'vtabs') return;
    flyoutOpen = false;
    quietUntil = Date.now() + 700;
  });

  // ---------------------------------------------------------------- state
  api.on('tabs', (s) => {
    const switched = s.activeId !== state.activeId;
    state = s;
    if (switched) focusId = s.activeId;
    render();
    if (switched && layout.vertical) rows.get(s.activeId)?.scrollIntoView({ block: 'nearest' });
  });
  api.on('tab-layout', apply);
  render();
  apply(init.tabLayout || layout);
}
