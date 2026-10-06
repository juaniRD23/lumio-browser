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

// A tab group's header row (batch 5's groups): its color and name; a click
// collapses or expands it, like the strip's chip.
const tabsLabel = (n) => `${n} tab${n === 1 ? '' : 's'}`;
function groupRow(g, send) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'vt-group';
  el.dataset.group = g.id;
  el.tabIndex = -1;
  el.innerHTML = '<i class="vt-gdot" aria-hidden="true"></i><span class="vt-gname"></span><span class="vt-gcount"></span>';
  el.addEventListener('click', () => send('groups:update', { id: el.dataset.group, collapsed: !el.classList.contains('collapsed') }));
  // Right-click: the group editor, like the strip's chip (renderer/ui/tab-groups.js).
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); document.dispatchEvent(new CustomEvent('lumio-group-edit', { detail: el.dataset.group })); });
  return el;
}
function updateGroupRow(el, g) {
  el.style.setProperty('--gc', `var(--group-${g.color})`);
  el.classList.toggle('collapsed', !!g.collapsed);
  el.classList.toggle('untitled', !g.title);
  el.querySelector('.vt-gname').textContent = g.title;
  el.querySelector('.vt-gcount').textContent = g.collapsed ? String(g.count) : '';
  const name = g.title || 'Unnamed group';
  el.setAttribute('aria-label', `${name}, ${tabsLabel(g.count)}, ${g.collapsed ? 'collapsed' : 'expanded'}`);
  el.setAttribute('aria-expanded', String(!g.collapsed));
  el.title = `${name} · ${tabsLabel(g.count)}\nClick to ${g.collapsed ? 'expand' : 'collapse'}`;
}

// Draws `tabs` into `list`, reusing each tab's row. Pinned tabs come first
// (the tab model keeps them there) and the first other tab is marked, for the
// line under the pinned ones. groups: the window's tab groups (each group's
// header comes before its tabs; a collapsed group's tabs are hidden).
export function renderRows(list, tabs, { activeId, shownId = null, rows, send, groups = [] }) {
  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, el] of rows) if (!ids.has(id)) { el.remove(); rows.delete(id); }
  const byId = new Map(groups.map((g) => [g.id, g]));
  list._groups ||= new Map(); // group id -> its header row
  for (const [id, el] of list._groups) if (!byId.has(id)) { el.remove(); list._groups.delete(id); }
  const order = [];
  let firstOther = true;
  tabs.forEach((t, i) => {
    const g = t.groupId && !t.pinned ? byId.get(t.groupId) : null;
    if (g && tabs[i - 1]?.groupId !== g.id) {
      let head = list._groups.get(g.id);
      if (!head) { head = groupRow(g, send); list._groups.set(g.id, head); }
      updateGroupRow(head, g);
      order.push(head);
    }
    let el = rows.get(t.id);
    if (!el) { el = createRow(t.id, send); rows.set(t.id, el); }
    updateRow(el, t, { activeId, shownId });
    el.classList.toggle('after-pins', !t.pinned && firstOther && i > 0);
    el.classList.toggle('grouped', !!g);
    el.classList.toggle('group-end', !!g && tabs[i + 1]?.groupId !== g.id);
    if (g) el.style.setProperty('--gc', `var(--group-${g.color})`); else el.style.removeProperty('--gc');
    el.hidden = !!g?.collapsed && t.id !== activeId; // (the tab you're on stays, as in the strip)
    if (!t.pinned) firstOther = false;
    order.push(el);
  });
  order.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
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
  // The rows it moves among (not group headers, nor a collapsed group's hidden tabs).
  const group = [...list.children].filter((x) => x.classList.contains('vt-tab') && !x.hidden && x.classList.contains('pinned') === pinned);
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
    // Its place among all the tabs: where the row it landed on is.
    if (dragging && target !== from) drop(id, tabs().findIndex((t) => t.id === Number(group[target].dataset.id)));
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => dragging;
}
