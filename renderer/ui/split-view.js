// Split view in the window (main/split-view.js keeps the pairs): two pages
// side by side in the page slot, each under a slim bar with its site and
// buttons to swap, separate or close it, and a divider between them to drag.
// The focused side has the accent ring; the toolbar shows that side.
//
// The pages are views above this HTML, so the panes are drawn here and
// their page areas reported to main (layout:split), which puts the pages
// exactly there. Dragging a tab onto an edge of the page previews the split
// the same way (layout:split-preview).
import { icons } from './icons.js';
import { faviconHtml, splitIcon } from './tab-rows.js';

const $ = (sel) => document.querySelector(sel);
const svg = (d) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  swap: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  separate: svg('<rect x="3.5" y="6" width="7" height="12" rx="1.5"/><rect x="13.5" y="6" width="7" height="12" rx="1.5"/><path d="M12 3v18" stroke-dasharray="2 2.5"/>'),
};
const MIN_PANE = 260; // as main/split-view.js
// Share of the page's width at each edge that takes a dropped tab. Narrow, so
// pulling a tab down into the rest of the page still tears it off into a
// window of its own (batch 4, renderer/ui/tabstrip.js).
const EDGE = 0.15;

export function initSplitView({ api, init }) {
  const slot = $('#slot');
  let state = init.tabs;
  let ratio = 0.5;
  let mode = null; // 'split' (a pair on screen), 'preview' (a tab dragged to an edge) or null
  let resizing = false;

  const box = document.createElement('div');
  box.id = 'split';
  box.hidden = true;
  const pane = (side) => `<section class="pane" data-side="${side}">
      <div class="pane-bar">
        <button type="button" class="pane-site"><span class="fav"></span><span class="pane-title"></span></button>
        <span class="pane-ask" hidden></span>
        <span class="pane-acts">
          <button type="button" class="pane-btn" data-act="swap" title="Swap sides" aria-label="Swap sides">${IC.swap}</button>
          <button type="button" class="pane-btn" data-act="separate" title="Separate tabs" aria-label="Separate tabs">${IC.separate}</button>
          <button type="button" class="pane-btn" data-act="close" title="Close this side" aria-label="Close this side">${icons.close}</button>
        </span>
      </div>
      <div class="pane-body"><div class="pane-hint"></div></div>
    </section>`;
  box.innerHTML = `${pane('left')}<div class="split-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Resize the two sides" aria-valuemin="0" aria-valuemax="100"><i></i></div>${pane('right')}`;
  slot.append(box);
  const panes = { left: box.querySelector('[data-side="left"]'), right: box.querySelector('[data-side="right"]') };
  const divider = box.querySelector('.split-divider');
  const tab = (id) => state.tabs.find((t) => t.id === id) || null;

  // ---------------------------------------------------------------- drawing
  function fill(side, t, { focused = false, hint = '' } = {}) {
    const p = panes[side];
    p.dataset.id = t ? String(t.id) : '';
    p.classList.toggle('focused', focused);
    // A permission this side's page asked for: the address bar's chip answers it for the focused side.
    const ask = mode === 'split' && t ? asking.find((a) => a.wcId === t.wcId) : null;
    const chip = p.querySelector('.pane-ask');
    chip.hidden = !ask;
    chip.textContent = ask ? `Asks to ${ask.label}` : '';
    chip.title = ask ? `${ask.host} wants to ${ask.label}. Click this side, then answer in the address bar.` : '';
    const fav = t ? faviconHtml(t) : splitIcon(14);
    if (p._fav !== fav) { p.querySelector('.fav').innerHTML = fav; p._fav = fav; }
    const img = p.querySelector('.fav img');
    if (img) img.onerror = () => { p.querySelector('.fav').innerHTML = icons.globe; };
    const title = t ? t.title || 'Untitled' : 'Your last tab';
    p.querySelector('.pane-title').textContent = title;
    const site = p.querySelector('.pane-site');
    site.title = t?.url ? `${title}\n${t.url}` : title;
    site.setAttribute('aria-label', focused ? `${title}, focused side` : `Focus ${title}`);
    p.querySelector('.pane-hint').textContent = hint;
  }

  function render() {
    const s = state.split;
    if (mode === 'preview') return; // a drag owns the panes until it ends
    mode = s ? 'split' : null;
    box.hidden = !s;
    box.classList.remove('preview');
    slot.classList.toggle('split', !!s);
    if (!s) { sent = ''; return; }
    if (!resizing) setRatio(s.ratio);
    fill('left', tab(s.left), { focused: state.activeId === s.left });
    fill('right', tab(s.right), { focused: state.activeId === s.right });
    report();
  }

  function setRatio(r) {
    const width = box.getBoundingClientRect().width || slot.getBoundingClientRect().width;
    const min = width > 0 ? Math.min(0.5, MIN_PANE / width) : 0.2;
    ratio = Math.max(min, Math.min(1 - min, Number.isFinite(r) ? r : 0.5));
    box.style.setProperty('--ratio', ratio);
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  // ---------------------------------------------------------------- where the pages go
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
  let frame = 0;
  let sent = ''; // what main last heard, so title and loading updates don't resend it
  function report() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (box.hidden) { sent = ''; return; }
      const a = rectOf(panes.left.querySelector('.pane-body'));
      const b = rectOf(panes.right.querySelector('.pane-body'));
      if (a.width < 2 || b.width < 2) return; // hidden under the full-size chat
      const msg = mode === 'split' && state.split ? ['layout:split', { left: state.split.left, right: state.split.right, a, b }]
        : mode === 'preview' && drag ? ['layout:split-preview', drag.side === 'left' ? a : b] : null;
      const key = JSON.stringify(msg);
      if (!msg || key === sent) return;
      sent = key;
      api.send(...msg);
    });
  }
  new ResizeObserver(report).observe(box);
  window.addEventListener('resize', report);

  // ---------------------------------------------------------------- the bars
  box.addEventListener('click', (e) => {
    if (mode !== 'split') return;
    const p = e.target.closest('.pane');
    const id = Number(p?.dataset.id);
    if (!id) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'swap') api.send('tab:split-swap', id);
    else if (act === 'separate') api.send('tab:split-separate', id);
    else if (act === 'close') api.send('tab:close', id);
    else if (e.target.closest('.pane-site')) { api.send('tab:activate', id); api.send('tab:focus-page'); }
  });
  box.addEventListener('contextmenu', (e) => {
    const id = Number(e.target.closest('.pane')?.dataset.id);
    if (mode !== 'split' || !id) return;
    e.preventDefault();
    api.send('tab:context', id);
  });

  // ---------------------------------------------------------------- the divider
  const commit = () => { if (state.split) api.send('tab:split-ratio', { id: state.split.left, ratio }); };
  divider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || mode !== 'split') return;
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('split-resizing');
    resizing = true;
    const r = box.getBoundingClientRect();
    const gap = divider.getBoundingClientRect().width;
    const move = (ev) => { setRatio((ev.clientX - r.left - gap / 2) / (r.width - gap)); report(); };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
      divider.classList.remove('dragging');
      document.body.classList.remove('split-resizing');
      resizing = false;
      commit();
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  });
  divider.addEventListener('dblclick', () => { setRatio(0.5); report(); commit(); });
  // Arrows move it (Shift: further), Home and End go to the ends, Enter evens it out.
  divider.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const to = { ArrowLeft: ratio - step, ArrowRight: ratio + step, Home: 0, End: 1, Enter: 0.5 }[e.key];
    if (to == null) return;
    e.preventDefault();
    setRatio(to);
    report();
    commit();
  });

  // ---------------------------------------------------------------- drag a tab to an edge
  // A tab dragged (in the strip or the column) onto the left or right edge of
  // the page previews the split: that tab's page takes that half, the tab you
  // were on gets the other. Letting go there makes the split.
  let drag = null; // { id, base, side }
  let pressActive = null;
  // The tab you were on, before pressing a tab made the pressed one active.
  document.addEventListener('pointerdown', () => { pressActive = state.activeId; }, true);

  function canSplit(id) {
    const t = tab(id);
    if (!t || t.pinned || state.split || state.tabs.filter((x) => !x.pinned).length < 2) return false;
    return !document.body.classList.contains('chat-full');
  }

  function track(ev, id) {
    const r = slot.getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    const zone = Math.max(80, r.width * EDGE);
    const side = inside && canSplit(id) ? (ev.clientX < r.left + zone ? 'left' : ev.clientX > r.right - zone ? 'right' : null) : null;
    if (side !== (drag?.side || null)) preview(side ? { id, base: pressActive !== id ? pressActive : null, side } : null);
    return !!side;
  }

  // Between the strip and the page (the toolbar), over a side of the page:
  // the tab may be on its way to that edge, so it isn't pulled out yet.
  function aims(ev, id) {
    const r = slot.getBoundingClientRect();
    const zone = Math.max(80, r.width * EDGE);
    return ev.clientY < r.top && ev.clientX >= r.left && ev.clientX <= r.right
      && (ev.clientX < r.left + zone || ev.clientX > r.right - zone) && canSplit(id);
  }

  function preview(next) {
    const was = drag;
    drag = next;
    if (!drag) {
      mode = null;
      box.classList.remove('preview');
      if (was) { api.send('layout:split-preview', null); sent = ''; }
      render();
      return;
    }
    mode = 'preview';
    box.hidden = false;
    box.classList.add('preview');
    slot.classList.add('split');
    setRatio(0.5);
    const other = drag.side === 'left' ? 'right' : 'left';
    fill(drag.side, tab(drag.id), { focused: true });
    fill(other, tab(drag.base), { hint: 'Let go to show these side by side' });
    report();
  }

  // Letting go of a dragged tab: true if it went into a split view.
  function finish(id) {
    if (!drag) return false;
    const { base, side } = drag;
    drag = null;
    mode = null;
    box.classList.remove('preview');
    api.send('tab:split', { id, base, side });
    // The new pair arrives with the next tab state; if main turned it down, the panes go.
    setTimeout(render, 400);
    return true;
  }

  // Permission requests, in the order the bar above the pages shows them
  // (shell.js answers the first one when Allow or Block is clicked).
  const asking = [];
  api.on('permission', (p) => { asking.push(p); render(); });
  api.on('permission-cancel', ({ id }) => { const i = asking.findIndex((a) => a.id === id); if (i >= 0) { asking.splice(i, 1); render(); } });
  // Answered in the address bar's permission chip (renderer/ui/permission-chip.js).
  api.on('overlay-picked', (pick) => { if (pick?.kind === 'permission' && pick.id != null) { const i = asking.findIndex((a) => a.id === pick.id); if (i >= 0) { asking.splice(i, 1); render(); } } });

  api.on('tabs', (s) => { state = s; render(); });
  render();
  return { track, aims, finish };
}
