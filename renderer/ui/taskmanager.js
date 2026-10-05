// Task Manager (main/task-manager.js): Lumio's processes with their memory,
// CPU, network and process ID, refreshed every second. Click a column to
// sort; arrows choose a row; Enter (or a double-click) shows that tab; End
// process stops the chosen page's process; Esc closes the window.
import { icons, markSvg } from './icons.js';

const api = window.lumio;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let rows = [];
let sort = { key: 'memory', dir: 'desc' };
let selected = null; // pid

const memory = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const rate = (n) => (n == null ? '–' : n < 1 ? '0' : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB/s` : `${(n / 1024 ** 2).toFixed(1)} MB/s`);
const KIND_ICON = { browser: markSvg(14), ui: markSvg(14), ai: markSvg(14), gpu: icons.bolt, utility: icons.gear, extension: icons.puzzle, devtools: icons.terminal, popup: icons.app, other: icons.app, tab: icons.globe };

function sorted() {
  const { key, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;
  const val = (r) => (key === 'title' ? r.title.toLowerCase() : r[key] ?? -1);
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : a.pid - b.pid) * sign;
  });
}

function icon(r) {
  if (r.favicon && /^(https?:|data:image\/)/.test(r.favicon)) return `<img src="${esc(r.favicon)}" alt="">`;
  return KIND_ICON[r.kind] || icons.app;
}

function render() {
  const list = sorted();
  if (!list.some((r) => r.pid === selected)) selected = null;
  $('#rows').innerHTML = list.map((r) => `
    <tr id="row-${r.pid}" data-pid="${r.pid}" aria-selected="${r.pid === selected}" class="${r.pid === selected ? 'sel' : ''}">
      <td class="task"><div class="cell"><span class="ic">${icon(r)}</span><span class="t" title="${esc([r.title, ...r.others].join('\n'))}">${esc(r.title)}</span>${r.others.length ? `<span class="others" title="${esc(r.others.join('\n'))}">+${r.others.length}</span>` : ''}</div></td>
      <td class="num">${memory(r.memory)}</td>
      <td class="num">${r.cpu.toFixed(1)}</td>
      <td class="num">${rate(r.network)}</td>
      <td class="num pid">${r.pid}</td>
    </tr>`).join('');
  $('#rows').querySelectorAll('img').forEach((img) => { img.onerror = () => { img.outerHTML = icons.globe; }; });
  if (selected != null) $('#rows').setAttribute('aria-activedescendant', `row-${selected}`); else $('#rows').removeAttribute('aria-activedescendant');
  const row = rows.find((r) => r.pid === selected);
  $('#end').disabled = !row?.canEnd;
  $('#end').title = row && !row.canEnd ? 'Only pages and extensions can be ended' : '';
  const total = rows.reduce((sum, r) => sum + r.memory, 0);
  $('#summary').textContent = rows.length ? `${rows.length} processes · ${memory(total)} in all` : '';
  document.querySelectorAll('th').forEach((th) => {
    const key = th.querySelector('button').dataset.key;
    th.setAttribute('aria-sort', key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function select(pid, scroll = false) {
  selected = pid;
  render();
  if (scroll) $(`#row-${pid}`)?.scrollIntoView({ block: 'nearest' });
}

async function refresh() {
  const next = await api.invoke('taskmanager:list').catch(() => null);
  if (Array.isArray(next)) { rows = next; render(); }
  setTimeout(refresh, 1000);
}

document.querySelector('thead').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (!key) return;
  // A new column starts with the biggest (or A to Z for names); again flips it.
  sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' ? 'asc' : 'desc' };
  render();
});
$('#rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-pid]');
  if (tr) select(Number(tr.dataset.pid));
});
$('#rows').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr[data-pid]');
  if (tr) api.send('taskmanager:focus', Number(tr.dataset.pid));
});
$('#rows').addEventListener('keydown', (e) => {
  const list = sorted();
  const i = list.findIndex((r) => r.pid === selected);
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
  if (step) {
    e.preventDefault();
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + step))];
    if (next) select(next.pid, true);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    const next = e.key === 'Home' ? list[0] : list.at(-1);
    if (next) select(next.pid, true);
  } else if (e.key === 'Enter' && selected != null) {
    e.preventDefault();
    api.send('taskmanager:focus', selected);
  }
});
$('#end').addEventListener('click', () => {
  if (selected == null) return;
  api.send('taskmanager:end', selected);
  $('#end').disabled = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

refresh();
$('#rows').focus();
