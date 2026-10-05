// The collapsed tabs column's flyout: the full tab list, drawn by the
// overlay over the page while the pointer is on the column (vertical-tabs.js
// opens it; main/tab-layout.js closes it when the pointer leaves). A tab
// opens on click, so a press can still turn into dragging it.
import { icons } from './icons.js';
import { renderRows, startReorder } from './tab-rows.js';

const api = window.lumio;
const card = document.getElementById('card');
const rows = new Map();
let state = null;
let list = null;
let dragged = () => false;

// Its styles, shared with the column (only needed once a flyout opens).
const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = 'vertical-tabs.css';
document.head.append(css);

function build() {
  rows.clear();
  card.innerHTML = `<div class="vtf" aria-label="Tabs"><div class="vt-tabs" role="tablist" aria-orientation="vertical" aria-label="Tabs"></div>
    <button type="button" class="vt-new" aria-label="New Tab"><span class="fav">${icons.plus}</span><span class="title">New tab</span></button></div>`;
  list = card.querySelector('.vt-tabs');
  card.querySelector('.vt-new').addEventListener('click', () => api.send('tab:new'));
  list.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.vt-tab');
    if (!el) return;
    dragged = startReorder(e, el, { list, tabs: () => state.tabs, drop: (id, index) => api.send('tab:move', { id, index }) }) || (() => false);
  });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('.vt-tab');
    if (!el || e.target.closest('.x, .audio') || dragged()) return;
    api.send('tab:activate', Number(el.dataset.id));
  });
}

api.on('overlay-data', (payload) => {
  const on = payload?.kind === 'vtabs';
  document.body.classList.toggle('vtabs-flyout', on);
  if (!on) { list = null; return; } // another dropdown takes the card
  state = payload;
  if (!list || !card.contains(list)) build();
  renderRows(list, state.tabs, { activeId: state.activeId, shownId: state.shownId, rows, send: (c, p) => api.send(c, p) });
});
