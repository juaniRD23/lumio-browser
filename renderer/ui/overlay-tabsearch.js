// Search tabs (⌘⇧A, or the ⌄ button at the end of the tab strip), like
// Chrome's: a search box over every open tab, in every window, then the
// recently closed tabs and windows. Typing narrows the list (fuzzy, on titles
// and sites); ↑/↓ move, Enter switches to the tab (and its window) or reopens
// it, Esc closes. main/tab-search.js gives the list and does the switching.
import { icons, markSvg } from './icons.js';
import { fuzzySearch, highlight } from './fuzzy.mjs';
import { SAD_ICON } from './tabstrip.js';

const KEYS = [['title', 1], ['host', 0.9]];
const MAX_HEIGHT = 520;

let api = null;
let card = null;
let kindNow = () => null;
let data = { tabs: [], closed: [] };
let rows = []; // what's listed: { type: 'tab' | 'closed', item, marks }
let sel = 0;
let returnFocus = 'page';

const $ = (sel) => card.querySelector(sel);
const esc = (s) => highlight(s, []);

function iconFor(row) {
  const it = row.item;
  if (row.type === 'closed' && it.kind === 'window') return icons.tabs;
  if (it.crashed) return SAD_ICON;
  if (it.internal) return markSvg(14);
  if (it.favicon) return `<img src="${esc(it.favicon)}" alt="" draggable="false">`;
  return row.type === 'closed' ? icons.clock : icons.globe;
}

function rowHtml(row, i) {
  const it = row.item;
  const audio = row.type === 'tab' && (it.audible || it.muted) ? `<span class="ts-audio" title="${it.muted ? 'Muted' : 'Playing sound'}">${it.muted ? icons.muted : icons.volume}</span>` : '';
  const close = row.type === 'tab' ? `<button class="ts-x" data-close="${i}" tabindex="${i === sel ? 0 : -1}" aria-label="Close ${esc(it.title)}" title="Close tab">${icons.x}</button>` : '';
  return `<div class="ts-row${i === sel ? ' sel' : ''}" id="ts-row-${i}" role="option" aria-selected="${i === sel}" data-i="${i}">
    <span class="ts-fav">${iconFor(row)}</span>
    <span class="ts-text"><span class="ts-title">${highlight(it.title, row.marks.title)}</span>${it.host ? `<span class="ts-host">${highlight(it.host, row.marks.host)}</span>` : ''}</span>
    ${audio}${close}
  </div>`;
}

function renderList() {
  const q = $('#ts-input').value;
  const tabs = fuzzySearch(data.tabs, q, KEYS).map((r) => ({ type: 'tab', ...r }));
  const closed = fuzzySearch(data.closed, q, KEYS).map((r) => ({ type: 'closed', ...r }));
  rows = [...tabs, ...closed];
  sel = Math.max(0, Math.min(sel, rows.length - 1));
  const list = $('#ts-list');
  const head = (label, count) => `<div class="ts-head" role="presentation">${label}${count ? ` <span>${count}</span>` : ''}</div>`;
  list.innerHTML = rows.length
    ? (tabs.length ? head('Open tabs', tabs.length) + tabs.map((r, i) => rowHtml(r, i)).join('') : '')
      + (closed.length ? head('Recently closed') + closed.map((r, i) => rowHtml(r, tabs.length + i)).join('') : '')
    : `<div class="ts-empty">${q.trim() ? 'No tabs found' : 'No tabs'}</div>`;
  list.querySelectorAll('.ts-fav img').forEach((img) => { img.onerror = () => { img.outerHTML = icons.globe; }; });
  $('#ts-input').setAttribute('aria-activedescendant', rows.length ? `ts-row-${sel}` : '');
  fit();
}

function select(i, scroll = true) {
  if (!rows.length) return;
  sel = (i + rows.length) % rows.length;
  card.querySelectorAll('.ts-row').forEach((el) => {
    const on = Number(el.dataset.i) === sel;
    el.classList.toggle('sel', on);
    el.setAttribute('aria-selected', String(on));
    const x = el.querySelector('.ts-x');
    if (x) x.tabIndex = on ? 0 : -1;
  });
  $('#ts-input').setAttribute('aria-activedescendant', `ts-row-${sel}`);
  if (scroll) $(`#ts-row-${sel}`)?.scrollIntoView({ block: 'nearest' });
}

// The list's height follows what it shows (up to a limit; then it scrolls).
function fit() {
  requestAnimationFrame(() => {
    if (kindNow() !== 'tabsearch') return;
    const box = $('.ts');
    if (!box) return;
    // The rows' own height: the list stretches to the card, so its scrollHeight never shrinks.
    const rowsHeight = [...$('#ts-list').children].reduce((sum, el) => sum + el.offsetHeight, 0);
    const want = $('.ts-search').offsetHeight + rowsHeight + 12 + 2; // card padding and border
    api.send('overlay:size', { height: Math.min(want, MAX_HEIGHT) + 2 + 22 });
  });
}

function choose(i = sel) {
  const row = rows[i];
  if (!row) return;
  if (row.type === 'tab') api.send('overlay:pick', { kind: 'tabsearch', action: 'open', windowId: row.item.windowId, tabId: row.item.tabId });
  else api.send('overlay:pick', { kind: 'tabsearch', action: 'reopen', index: row.item.index });
}

function closeTab(i) {
  const row = rows[i];
  if (row?.type !== 'tab') return;
  api.send('tab:search-close', { windowId: row.item.windowId, tabId: row.item.tabId });
}

export function renderTabSearch(cardEl, payload) {
  card = cardEl;
  data = { tabs: payload.tabs || [], closed: payload.closed || [] };
  // An update (a tab was closed from the list) keeps what you typed.
  if (!payload.update || !$('#ts-input')) {
    sel = 0;
    returnFocus = payload.returnFocus === 'shell' ? 'shell' : 'page';
    card.innerHTML = `
      <div class="ts" role="dialog" aria-label="Search tabs">
        <label class="ts-search"><span class="ts-ic">${icons.search}</span>
          <input id="ts-input" type="text" placeholder="Search tabs" aria-label="Search tabs" role="combobox" aria-expanded="true" aria-controls="ts-list" aria-autocomplete="list" autocomplete="off" spellcheck="false"></label>
        <div id="ts-list" class="ts-list" role="listbox" aria-label="Tabs"></div>
      </div>`;
    $('#ts-input').addEventListener('input', () => { sel = 0; renderList(); });
  }
  renderList();
  $('#ts-input').focus();
}

export function initTabSearch(cardEl, bridge, getKind) {
  api = bridge;
  card = cardEl;
  kindNow = getKind;
  const mine = () => getKind() === 'tabsearch';
  // The box keeps the keyboard while you click around the list.
  card.addEventListener('mousedown', (e) => {
    if (!mine() || e.target.closest('input')) return;
    e.preventDefault();
    const x = e.target.closest('[data-close]');
    if (x) { closeTab(Number(x.dataset.close)); return; }
    const row = e.target.closest('.ts-row');
    if (row) choose(Number(row.dataset.i));
  });
  card.addEventListener('mousemove', (e) => {
    const row = mine() && e.target.closest('.ts-row');
    if (row && Number(row.dataset.i) !== sel) select(Number(row.dataset.i), false);
  });
  document.addEventListener('keydown', (e) => {
    if (!mine()) return;
    const onClose = e.target.closest?.('.ts-x');
    if (e.key === 'Escape') { e.preventDefault(); api.send('overlay:pick', { kind: 'tabsearch', refocus: returnFocus }); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(sel + (e.key === 'ArrowDown' ? 1 : -1));
      $('#ts-input').focus();
      return;
    }
    if (e.key === 'Enter' || (onClose && e.key === ' ')) {
      e.preventDefault();
      if (onClose) { closeTab(Number(onClose.dataset.close)); $('#ts-input').focus(); } else choose();
    }
  });
}
