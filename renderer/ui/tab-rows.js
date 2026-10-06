// Tab rows for tabs shown to the side: the column next to the page
// (vertical-tabs.js) and its flyout over the page when the column is
// collapsed (tab-flyout.js, in the overlay). Both draw the same tab state the
// tab strip draws, and send the same tab:… messages.
import { icons, markSvg } from './icons.js';

const svg = (d, size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// Two pages side by side: a tab in a split view.
export const splitIcon = (size = 13) => svg('<rect x="3.5" y="5" width="7.2" height="14" rx="1.6"/><rect x="13.3" y="5" width="7.2" height="14" rx="1.6"/>', size);

export function faviconHtml(t) {
  if (t.loading) return '<span class="spinner"></span>';
  if (t.internal) return markSvg(14);
  if (t.favicon) return `<img src="${encodeURI(t.favicon)}" alt="" draggable="false">`;
  return icons.globe;
}

// What a screen reader hears for a tab.
function label(t) {
  const notes = [t.pinned && 'pinned', t.split && 'in split view', t.audible && !t.muted && 'playing audio', t.muted && 'muted', t.sleeping && 'sleeping', t.agent && `${t.agent.name} is working here`].filter(Boolean);
  return (t.title || 'Untitled') + (notes.length ? ` (${notes.join(', ')})` : '');
}

function createRow(id, send) {
  const el = document.createElement('div');
  el.className = 'vt-tab';
  el.dataset.id = String(id);
  el.setAttribute('role', 'tab');
  el.tabIndex = -1;
  el.innerHTML = `<span class="fav"></span><i class="agent-dot" hidden></i><span class="title"></span><i class="vt-split" hidden>${splitIcon()}</i><button type="button" class="audio" tabindex="-1" hidden></button><button type="button" class="x" tabindex="-1" aria-label="Close tab" title="Close tab">${icons.close}</button>`;
  el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); send('tab:close', id); });
  el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); send('tab:mute', id); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); send('tab:close', id); } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); send('tab:context', id); });
  return el;
}

function updateRow(el, t, { activeId, shownId }) {
  const active = t.id === activeId;
  el.classList.toggle('active', active);
  el.classList.toggle('shown', t.id === shownId); // the other side of the split on screen
  el.classList.toggle('pinned', !!t.pinned);
  el.classList.toggle('sleeping', !!t.sleeping);
  el.classList.toggle('split', !!t.split);
  el.classList.toggle('helped', !!t.agent);
  el.setAttribute('aria-selected', String(active));
  el.setAttribute('aria-label', label(t));
  el.title = (t.title || 'Untitled') + (t.url ? '\n' + t.url : '') + (t.sleeping ? '\nSleeping to save memory (Memory Saver)' : '')
    + (t.split ? '\nIn split view' : '') + (t.agent ? `\n${t.agent.name} is working here: ${t.agent.title}` : '');
  const dot = el.querySelector('.agent-dot');
  dot.hidden = !t.agent;
  if (t.agent) dot.style.setProperty('--c', t.agent.color);
  const fav = faviconHtml(t);
  if (el._fav !== fav) {
    el.querySelector('.fav').innerHTML = fav;
    el._fav = fav;
    const img = el.querySelector('.fav img');
    if (img) img.onerror = () => { el.querySelector('.fav').innerHTML = icons.globe; };
  }
  el.querySelector('.title').textContent = t.title || 'Untitled';
  el.querySelector('.vt-split').hidden = !t.split;
  const audio = el.querySelector('.audio');
  audio.hidden = !(t.audible || t.muted);
  audio.innerHTML = t.muted ? icons.muted : icons.volume;
  audio.title = t.muted ? 'Unmute site' : 'Mute site';
  audio.setAttribute('aria-label', audio.title);
}

// Draws `tabs` into `list`, reusing each tab's row. Pinned tabs come first
// (the tab model keeps them there) and the first other tab is marked, for the
// line under the pinned ones.
export function renderRows(list, tabs, { activeId, shownId = null, rows, send }) {
  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, el] of rows) if (!ids.has(id)) { el.remove(); rows.delete(id); }
  let firstOther = true;
  tabs.forEach((t, i) => {
    let el = rows.get(t.id);
    if (!el) { el = createRow(t.id, send); rows.set(t.id, el); }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    updateRow(el, t, { activeId, shownId });
    el.classList.toggle('after-pins', !t.pinned && firstOther && i > 0);
    if (!t.pinned) firstOther = false;
  });
}

// Drag to reorder: rows slide up or down, pinned tiles (a grid) show where
// the tab lands. `track(ev)` is asked on every move and returns true while
// the pointer is over a split view drop zone (then nothing moves); `finish()`
// returns true when the drop went there. `drop(id, index)` gets the tab's new
// index in the whole list.
export function startReorder(e, el, { list, tabs, onDown, track = () => false, finish = () => false, drop }) {
  if (e.button !== 0 || e.target.closest('.x, .audio')) return;
  const id = Number(el.dataset.id);
  onDown?.(id);
  const pinned = el.classList.contains('pinned');
  const group = [...list.children].filter((x) => x.classList.contains('pinned') === pinned);
  const offset = pinned ? 0 : tabs().filter((t) => t.pinned).length;
  const from = group.indexOf(el);
  const rects = group.map((x) => x.getBoundingClientRect());
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  let target = from;
  el.setPointerCapture(e.pointerId);
  const clear = () => group.forEach((x) => { if (x !== el) x.style.transform = ''; x.classList.remove('drop-before', 'drop-after'); });
  const move = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!dragging && Math.hypot(dx, dy) < 5) return;
    if (!dragging) { dragging = true; el.classList.add('dragging'); list.classList.add('reordering'); }
    if (track(ev)) { target = from; clear(); el.style.transform = `translate(${dx}px, ${dy}px)`; return; }
    if (pinned) {
      // A grid: the tile it's over (or past the last one).
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      const cx = rects[from].left + rects[from].width / 2 + dx;
      const cy = rects[from].top + rects[from].height / 2 + dy;
      let best = from;
      let dist = Infinity;
      rects.forEach((r, i) => { const d = Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2)); if (d < dist) { dist = d; best = i; } });
      target = best;
      clear();
      if (target !== from) group[target].classList.add(target < from ? 'drop-before' : 'drop-after');
      return;
    }
    // A list: rows between where it was and where it is make room.
    const min = rects[0].top - rects[from].top;
    const max = rects[rects.length - 1].top - rects[from].top;
    const y = Math.max(min, Math.min(max, dy));
    el.style.transform = `translateY(${y}px)`;
    const center = rects[from].top + rects[from].height / 2 + y;
    target = from;
    rects.forEach((r, i) => {
      const mid = r.top + r.height / 2;
      if (i < from && center < mid) target = Math.min(target, i);
      if (i > from && center > mid) target = Math.max(target, i);
    });
    const h = rects[from].height + 2;
    group.forEach((x, i) => {
      if (x === el) return;
      x.classList.add('shifting');
      const shift = i > from && i <= target ? -h : i < from && i >= target ? h : 0;
      x.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    clear();
    el.style.transform = '';
    group.forEach((x) => x.classList.remove('shifting'));
    el.classList.remove('dragging');
    list.classList.remove('reordering');
    if (finish()) return;
    if (dragging && target !== from) drop(id, offset + target);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => dragging;
}
