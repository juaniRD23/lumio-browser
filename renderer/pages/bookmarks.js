// lumio://bookmarks — the bookmark manager, like Chrome's: folders on the
// left, the open folder's contents on the right. Search, select several
// (⌘/Ctrl-click, ⇧-click, the arrow keys), drag to move or reorder, new
// folders, rename, edit addresses, sort by name, and delete with Undo.
// The tree lives in the main process (main/bookmarks.js); every change asks
// it, and it tells this page to redraw ("bookmarks-changed").
import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const isFolder = (n) => Array.isArray(n?.children);
const MAC = /Mac/.test(navigator.platform);
const mod = (e) => (MAC ? e.metaKey : e.ctrlKey);
const MIME = 'application/x-lumio-bookmarks'; // our own drags: { ids }, as on the bookmarks bar
const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const DOTS = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor"/></svg>';

let roots = [];
let index = new Map(); // id -> { node, parent }
let current = 'bar'; // the folder on the right
const expanded = new Set(['bar']);
let selected = new Set();
let anchorId = null; // where a ⇧-click range starts
let focusId = null;
let editing = null; // { id } a row being renamed, or { id: null, parentId, folder } a new one
let showBar = false;
let undo = null; // { text, run }
let toastTimer = null;
let dragIds = null;

const query = () => $('#search').value.trim();

// ---------------------------------------------------------------- data
async function load() {
  const res = await page.invoke('page:bookmarks');
  roots = res.roots;
  showBar = !!res.showBar;
  index = new Map();
  const walk = (n, parent) => { index.set(n.id, { node: n, parent }); if (isFolder(n)) n.children.forEach((c) => walk(c, n)); };
  roots.forEach((r) => walk(r, null));
  if (!folderOf(current)) current = 'bar';
  selected = new Set([...selected].filter((id) => index.has(id)));
  if (editing?.id && !index.has(editing.id)) editing = null;
  render();
}
const get = (id) => index.get(id)?.node || null;
const parentOf = (id) => index.get(id)?.parent || null;
const folderOf = (id) => (isFolder(get(id)) ? get(id) : null);
const pathOf = (id) => { const out = []; for (let n = get(id); n; n = parentOf(n.id)) out.unshift(n); return out; };
// A folder the open one is inside (the tree keeps those open).
const aboveCurrent = (id) => !query() && id !== current && pathOf(current).some((p) => p.id === id);
const countIn = (f) => { let n = 0; const walk = (x) => x.children.forEach((c) => (isFolder(c) ? walk(c) : n++)); walk(f); return n; };

// What the list shows: the open folder, or what matches the search.
function rows() {
  const q = query().toLowerCase().split(/\s+/).filter(Boolean);
  if (!q.length) return folderOf(current)?.children || [];
  const out = [];
  for (const { node } of index.values()) {
    if (!parentOf(node.id)) continue; // the three main folders
    const text = `${node.title} ${node.url || ''}`.toLowerCase();
    if (q.every((w) => text.includes(w))) out.push(node);
  }
  return out;
}

// ---------------------------------------------------------------- drawing
function iconHtml(n) {
  if (isFolder(n)) return `<span class="ic folder">${FOLDER_SVG}</span>`;
  let src = n.favicon;
  if (!src) { try { src = `${new URL(n.url).origin}/favicon.ico`; } catch { src = ''; } }
  return `<span class="ic">${src ? `<img src="${esc(src)}" alt="">` : '<i class="dot"></i>'}</span>`;
}

function renderTree() {
  const out = [];
  const walk = (f, depth) => {
    const kids = f.children.filter(isFolder);
    const open = expanded.has(f.id) || aboveCurrent(f.id);
    out.push(`<div class="tf${f.id === current && !query() ? ' on' : ''}" role="treeitem" tabindex="${f.id === current ? 0 : -1}" data-id="${esc(f.id)}" aria-level="${depth + 1}" aria-selected="${f.id === current && !query()}"${kids.length ? ` aria-expanded="${open}"` : ''} style="--depth:${depth}">
      <span class="tw${kids.length ? '' : ' none'}" data-twist="1">${kids.length ? CHEVRON : ''}</span>${FOLDER_SVG}<span class="tt">${esc(f.title)}</span></div>`);
    if (open) kids.forEach((k) => walk(k, depth + 1));
  };
  roots.forEach((r) => { if (r.id !== 'mobile' || r.children.length || current === 'mobile') walk(r, 0); });
  $('#tree').innerHTML = out.join('');
}

function rowHtml(n, searching) {
  if (editing && editing.id === n.id) return editRowHtml(n);
  const sel = selected.has(n.id);
  const where = searching ? `<span class="p">${esc(pathOf(n.id).slice(0, -1).map((p) => p.title).join(' › '))}</span>` : '';
  const count = isFolder(n) ? countIn(n) : 0;
  const sub = isFolder(n) ? `${count} bookmark${count === 1 ? '' : 's'}` : pretty(n.url);
  return `<div class="bm-row${isFolder(n) ? ' folder' : ''}${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" tabindex="${n.id === focusId ? 0 : -1}" draggable="true" data-id="${esc(n.id)}">
    ${iconHtml(n)}<span class="t">${esc(n.title || n.url)}</span><span class="u">${esc(sub)}</span>${where}
    <button class="iconbtn more" data-act="menu" tabindex="-1" aria-label="More actions for ${esc(n.title)}">${DOTS}</button></div>`;
}
function editRowHtml(n) {
  const folder = n ? isFolder(n) : editing.folder;
  return `<div class="bm-row editing" data-id="${esc(n?.id || '')}">
    <input class="field" id="edit-title" value="${esc(n?.title || (folder ? 'New folder' : ''))}" aria-label="Name" placeholder="Name">
    ${folder ? '' : `<input class="field" id="edit-url" value="${esc(n?.url || '')}" aria-label="URL" placeholder="https://…">`}
    <span class="acts"><button class="btn small ghost" data-act="cancel">Cancel</button><button class="btn small primary" data-act="save">Save</button></span>
  </div>`;
}

function renderList() {
  // A name or address being typed survives a redraw.
  const draft = editing && $('#edit-title') ? { title: $('#edit-title').value, url: $('#edit-url')?.value, focus: document.activeElement?.id } : null;
  const searching = !!query();
  const list = rows();
  if (focusId && !list.some((n) => n.id === focusId)) focusId = null;
  if (!focusId && list.length) focusId = list[0].id;
  let html = list.map((n) => rowHtml(n, searching)).join('');
  if (editing && !editing.id) html += editRowHtml(null); // adding a new one, at the end
  if (!html) html = `<div class="empty">${searching ? 'No bookmarks match' : current === 'bar' && index.size <= roots.length ? 'No bookmarks yet.' : `This folder is empty. Press ${MAC ? '⌘D' : 'Ctrl+D'} on a page to bookmark it.`}</div>`;
  $('#list').innerHTML = html;
  $('#list').querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.outerHTML = '<i class="dot"></i>'; }));
  const t = $('#edit-title');
  if (t && draft) {
    t.value = draft.title;
    if ($('#edit-url') && draft.url != null) $('#edit-url').value = draft.url;
    $(`#${draft.focus === 'edit-url' ? 'edit-url' : 'edit-title'}`)?.focus();
  } else if (t) { t.focus(); t.select(); }
}

function renderBar() {
  const searching = query();
  $('#crumbs').innerHTML = searching
    ? `<span class="crumb now">Search results</span>`
    : pathOf(current).map((f, i, a) => (i === a.length - 1 ? `<span class="crumb now">${esc(f.title)}</span>` : `<button class="crumb" data-go="${esc(f.id)}">${esc(f.title)}</button><span class="sep">›</span>`)).join('');
  const n = selected.size;
  $('#selbar').hidden = n < 2;
  $('#crumbs').hidden = n >= 2;
  $('#selcount').textContent = `${n} selected`;
}

function render() {
  renderTree();
  renderList();
  renderBar();
}

// ---------------------------------------------------------------- selection
function visibleIds() { return rows().map((n) => n.id); }
function select(id, { toggle = false, range = false } = {}) {
  if (range && anchorId) {
    const ids = visibleIds();
    const [a, b] = [ids.indexOf(anchorId), ids.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0 && b >= 0) selected = new Set(ids.slice(a, b + 1));
  } else if (toggle) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchorId = id;
  } else {
    selected = new Set([id]);
    anchorId = id;
  }
  focusId = id;
  paintSelection();
  focusRow(id);
}
// Selection changes redraw only the rows' marks, not the list.
function paintSelection() {
  for (const row of $('#list').querySelectorAll('.bm-row[data-id]:not(.editing)')) {
    const on = selected.has(row.dataset.id);
    row.classList.toggle('sel', on);
    row.setAttribute('aria-selected', String(on));
    row.tabIndex = row.dataset.id === focusId ? 0 : -1;
  }
  renderBar();
}
function focusRow(id) { $('#list').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus(); }
const chosen = () => [...selected].filter((id) => index.has(id));

function openFolder(id) {
  if (!folderOf(id)) return;
  current = id;
  for (const p of pathOf(id).slice(0, -1)) expanded.add(p.id);
  if (query()) $('#search').value = '';
  selected = new Set();
  focusId = null;
  editing = null;
  render();
}

// ---------------------------------------------------------------- actions
function toast(text, run = null) {
  undo = run ? { text, run } : null;
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !run;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; undo = null; }, 8000);
}
async function runUndo() {
  if (!undo) return;
  const u = undo;
  undo = null;
  $('#toast').hidden = true;
  await u.run();
}

async function remove(ids) {
  if (!ids.length) return;
  const one = ids.length === 1 ? get(ids[0]) : null;
  const removed = await page.invoke('page:bookmark-remove', ids);
  selected = new Set();
  const text = one ? `Deleted “${one.title}”` : `${removed.length} items deleted`;
  toast(text, async () => { await page.invoke('page:bookmark-restore', removed); await load(); });
  await load();
  $('#list').querySelector('.bm-row[tabindex="0"]')?.focus();
}
async function sortCurrent() {
  const before = await page.invoke('page:bookmark-sort', current);
  const folder = current;
  if (before) toast('Sorted by name', async () => { await page.invoke('page:bookmark-reorder', folder, before); await load(); });
  await load();
}
async function newFolder() {
  const id = await page.invoke('page:bookmark-folder', current, null, 'New folder');
  if (!id) return;
  editing = { id };
  focusId = id;
  selected = new Set([id]);
  await load();
}
function addBookmark() {
  if (query()) $('#search').value = '';
  editing = { id: null, parentId: current, folder: false };
  renderList();
}
function edit(id) {
  editing = { id };
  focusId = id;
  renderList();
}
async function save() {
  const title = $('#edit-title')?.value ?? '';
  const url = $('#edit-url')?.value.trim();
  const e = editing;
  if (!e) return;
  if (e.id) {
    await page.invoke('page:bookmark-update', e.id, { title, ...(url != null ? { url } : {}) });
  } else {
    const id = await page.invoke('page:bookmark-add', e.parentId, null, { title, url: /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url) ? url : `https://${url}` });
    if (!id) { $('#edit-url')?.setCustomValidity?.('Type a web address'); $('#edit-url')?.reportValidity?.(); return; }
    focusId = id;
  }
  editing = null;
  if (new URLSearchParams(location.search).has('edit')) history.replaceState(null, '', location.pathname);
  await load();
  if (focusId) focusRow(focusId);
}
function cancel() {
  const id = editing?.id;
  editing = null;
  renderList();
  if (id) focusRow(id);
}
const open = (ids, disposition) => page.invoke('page:bookmark-open', ids, disposition);

// ---------------------------------------------------------------- menus
// The ⋮ on a row (or a right-click), and the ⋮ at the top.
let menuFor = null;
function showMenu(items, x, y, opener) {
  const m = $('#menu');
  m.innerHTML = items.map((it) => (it === '-' ? '<div class="sep" role="separator"></div>'
    : `<button class="mi" role="${it.check != null ? 'menuitemcheckbox' : 'menuitem'}"${it.check != null ? ` aria-checked="${it.check}"` : ''} data-cmd="${it.cmd}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}${it.check ? '<span class="tick">✓</span>' : ''}</button>`)).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menuFor = { opener };
  opener?.setAttribute('aria-expanded', 'true');
  m.querySelector('.mi:not([disabled])')?.focus();
}
function hideMenu(refocus = true) {
  const m = $('#menu');
  if (m.hidden) return;
  m.hidden = true;
  menuFor?.opener?.setAttribute('aria-expanded', 'false');
  if (refocus) menuFor?.opener?.focus();
  menuFor = null;
}
function rowMenu(id, x, y, opener) {
  if (!selected.has(id)) { selected = new Set([id]); anchorId = id; focusId = id; paintSelection(); }
  const ids = chosen();
  const n = get(id);
  const many = ids.length > 1;
  const urls = ids.reduce((a, x) => a + (isFolder(get(x)) ? countIn(get(x)) : 1), 0);
  const items = many ? [
    { cmd: 'open-tab', label: `Open all (${urls})`, disabled: !urls },
    { cmd: 'open-window', label: 'Open all in new window', disabled: !urls },
    { cmd: 'open-incognito', label: 'Open all in Incognito window', disabled: !urls },
    '-', { cmd: 'delete', label: `Delete ${ids.length} items` },
  ] : isFolder(n) ? [
    { cmd: 'rename', label: 'Rename' },
    '-', { cmd: 'open-tab', label: `Open all (${urls})`, disabled: !urls },
    { cmd: 'open-window', label: 'Open all in new window', disabled: !urls },
    { cmd: 'open-incognito', label: 'Open all in Incognito window', disabled: !urls },
    '-', { cmd: 'delete', label: 'Delete' },
  ] : [
    { cmd: 'edit', label: 'Edit' },
    { cmd: 'copy', label: 'Copy URL' },
    '-', { cmd: 'open-tab', label: 'Open in new tab' },
    { cmd: 'open-window', label: 'Open in new window' },
    { cmd: 'open-incognito', label: 'Open in Incognito window' },
    ...(query() ? ['-', { cmd: 'show', label: 'Show in folder' }] : []),
    '-', { cmd: 'delete', label: 'Delete' },
  ];
  showMenu(items, x, y, opener || $('#list').querySelector(`[data-id="${CSS.escape(id)}"]`));
}
function topMenu() {
  const r = $('#more').getBoundingClientRect();
  showMenu([
    { cmd: 'add', label: 'Add new bookmark' },
    { cmd: 'new-folder', label: 'Add new folder' },
    { cmd: 'sort', label: 'Sort by name', disabled: !!query() || (folderOf(current)?.children.length || 0) < 2 },
    '-', { cmd: 'import', label: 'Import bookmarks' },
    { cmd: 'export', label: 'Export bookmarks' },
    '-', { cmd: 'bar', label: 'Show bookmarks bar', check: showBar },
  ], r.right - 220, r.bottom + 6, $('#more'));
}
async function command(cmd) {
  const ids = chosen();
  hideMenu(!['edit', 'rename', 'add', 'new-folder'].includes(cmd));
  if (cmd === 'edit' || cmd === 'rename') edit(ids[0]);
  else if (cmd === 'copy') { const n = get(ids[0]); if (n?.url && await navigator.clipboard.writeText(n.url).then(() => true, () => false)) toast('URL copied'); }
  else if (cmd === 'open-tab') open(ids, 'tab');
  else if (cmd === 'open-window') open(ids, 'window');
  else if (cmd === 'open-incognito') open(ids, 'incognito');
  else if (cmd === 'delete') remove(ids);
  else if (cmd === 'show') { const id = ids[0]; openFolder(parentOf(id).id); select(id); }
  else if (cmd === 'add') addBookmark();
  else if (cmd === 'new-folder') newFolder();
  else if (cmd === 'sort') sortCurrent();
  else if (cmd === 'import') page.invoke('page:open', 'lumio://settings/#import', 'tab');
  else if (cmd === 'export') page.invoke('page:bookmarks-export');
  else if (cmd === 'bar') page.invoke('page:set-bookmarks-bar', !showBar);
}
$('#menu').addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b && !b.disabled) command(b.dataset.cmd); });
$('#menu').addEventListener('keydown', (e) => {
  const items = [...$('#menu').querySelectorAll('.mi:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); } else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); } else if (e.key === 'End') { e.preventDefault(); items.at(-1)?.focus(); } else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); hideMenu(); }
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu, #more, [data-act=menu]')) hideMenu(false); });
$('#more').addEventListener('click', () => ($('#menu').hidden ? topMenu() : hideMenu()));

// ---------------------------------------------------------------- the list
$('#list').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'save') { save(); return; }
  if (act === 'cancel') { cancel(); return; }
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (!row) return;
  if (act === 'menu') { const r = e.target.closest('button').getBoundingClientRect(); rowMenu(row.dataset.id, r.right - 200, r.bottom + 4, e.target.closest('button')); return; }
  select(row.dataset.id, { toggle: mod(e), range: e.shiftKey });
});
$('#list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (!row) return;
  if (folderOf(row.dataset.id)) openFolder(row.dataset.id); else open([row.dataset.id], 'tab');
});
$('#list').addEventListener('auxclick', (e) => {
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (row && e.button === 1) open([row.dataset.id], 'background');
});
$('#list').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (!row) return;
  e.preventDefault();
  rowMenu(row.dataset.id, e.clientX, e.clientY);
});
$('#list').addEventListener('keydown', (e) => {
  if (e.target.closest('.editing')) {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    return;
  }
  const ids = visibleIds();
  const i = ids.indexOf(focusId);
  const go = (j) => { e.preventDefault(); if (!ids.length) return; const id = ids[Math.max(0, Math.min(ids.length - 1, j))]; if (e.shiftKey) select(id, { range: true }); else if (mod(e)) { focusId = id; paintSelection(); focusRow(id); } else select(id); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(ids.length - 1);
  else if (e.key === ' ' && focusId) { e.preventDefault(); select(focusId, { toggle: true }); } else if (e.key === 'Enter' && focusId) {
    e.preventDefault();
    if (folderOf(focusId) && !mod(e)) openFolder(focusId);
    else open(selected.size > 1 ? chosen() : [focusId], e.shiftKey ? 'window' : mod(e) ? 'background' : 'tab');
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); remove(chosen()); } else if (e.key === 'F2' && focusId) { e.preventDefault(); edit(focusId); } else if (e.key === 'a' && mod(e)) { e.preventDefault(); selected = new Set(ids); paintSelection(); } else if (e.key === 'Escape' && selected.size) { e.preventDefault(); selected = new Set(); paintSelection(); } else if (e.key === 'ArrowLeft' && !query() && parentOf(current)) { e.preventDefault(); openFolder(parentOf(current).id); $('#list').focus(); }
});
$('#list').addEventListener('input', (e) => e.target.setCustomValidity?.(''));
// The keys act on the row that has the focus, however it got there.
$('#list').addEventListener('focusin', (e) => {
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (row && row.dataset.id !== focusId) { focusId = row.dataset.id; paintSelection(); }
});
$('#selbar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-sel]')?.dataset.sel;
  if (act === 'open') open(chosen(), 'tab');
  else if (act === 'delete') remove(chosen());
  else if (act === 'clear') { selected = new Set(); paintSelection(); }
});
$('#crumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) openFolder(b.dataset.go); });

// ---------------------------------------------------------------- the folder tree
$('#tree').addEventListener('click', (e) => {
  const tf = e.target.closest('.tf');
  if (!tf) return;
  if (e.target.closest('[data-twist]') && tf.hasAttribute('aria-expanded')) {
    toggleFolder(tf.dataset.id, tf.getAttribute('aria-expanded') !== 'true');
    return;
  }
  openFolder(tf.dataset.id);
  $('#tree').querySelector(`[data-id="${CSS.escape(tf.dataset.id)}"]`)?.focus();
});
// Open or close a folder in the tree. Closing one the open folder is inside opens that one instead.
function toggleFolder(id, open) {
  if (open) expanded.add(id);
  else { expanded.delete(id); if (aboveCurrent(id)) openFolder(id); }
  renderTree();
  $('#tree').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
}
$('#tree').addEventListener('keydown', (e) => {
  const items = [...$('#tree').querySelectorAll('.tf')];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  const el = items[i];
  const id = el.dataset.id;
  const focus = (j) => { e.preventDefault(); const t = items[Math.max(0, Math.min(items.length - 1, j))]; items.forEach((x) => { x.tabIndex = -1; }); t.tabIndex = 0; t.focus(); };
  if (e.key === 'ArrowDown') focus(i + 1);
  else if (e.key === 'ArrowUp') focus(i - 1);
  else if (e.key === 'Home') focus(0);
  else if (e.key === 'End') focus(items.length - 1);
  else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (el.getAttribute('aria-expanded') === 'false') toggleFolder(id, true); else if (el.getAttribute('aria-expanded') === 'true') focus(i + 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (el.getAttribute('aria-expanded') === 'true') toggleFolder(id, false); else { const p = parentOf(id); if (p) $('#tree').querySelector(`[data-id="${CSS.escape(p.id)}"]`)?.focus(); }
  } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFolder(id); $('#tree').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus(); }
});

// ---------------------------------------------------------------- drag and drop
// Rows drag (with the rest of the selection) onto folders in the tree, onto
// folder rows, or between rows to reorder. Links from pages drop in too.
$('#list').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (!row) return;
  const id = row.dataset.id;
  if (!selected.has(id)) { selected = new Set([id]); anchorId = id; focusId = id; }
  dragIds = chosen();
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(MIME, JSON.stringify({ ids: dragIds }));
  const n = get(id);
  if (dragIds.length === 1 && n?.url) { e.dataTransfer.setData('text/uri-list', n.url); e.dataTransfer.setData('text/plain', n.url); }
  requestAnimationFrame(() => dragIds?.forEach((x) => $('#list').querySelector(`[data-id="${CSS.escape(x)}"]`)?.classList.add('dragging')));
});
const dropOk = (dt) => dt.types.includes(MIME) || dt.types.includes('text/uri-list');
// Where a drop lands in the list: into a folder row (its middle), before or after a row, or at the end.
function listTarget(e) {
  const row = e.target.closest('.bm-row[data-id]:not(.editing)');
  if (!row) return query() ? null : { parentId: current, index: null, end: true };
  const id = row.dataset.id;
  const r = row.getBoundingClientRect();
  const f = (e.clientY - r.top) / r.height;
  if (folderOf(id) && !dragIds?.includes(id) && f > 0.25 && f < 0.75) return { row, into: true, parentId: id, index: null };
  if (query()) return null; // search results aren't in one folder
  const i = folderOf(current).children.findIndex((c) => c.id === id);
  return { row, after: f >= 0.5, parentId: current, index: i + (f >= 0.5 ? 1 : 0) };
}
function markDrop(t, treeEl = null) {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  if (treeEl) treeEl.classList.add('drop-into');
  else if (t?.row) t.row.classList.add(t.into ? 'drop-into' : t.after ? 'drop-after' : 'drop-before');
}
async function drop(e, parentId, index) {
  e.preventDefault();
  markDrop(null);
  const dt = e.dataTransfer;
  if (dt.types.includes(MIME)) {
    let ids = [];
    try { ids = JSON.parse(dt.getData(MIME)).ids || []; } catch { ids = dragIds || []; }
    if (ids.length) await page.invoke('page:bookmark-move', ids, parentId, index);
    await load();
  } else {
    const url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'))?.trim() || '';
    let title = '';
    try { title = new DOMParser().parseFromString(dt.getData('text/html') || '', 'text/html').querySelector('a')?.textContent.trim() || ''; } catch {}
    if (/^https?:/i.test(url)) await page.invoke('page:bookmark-add', parentId, index, { url, title: title || url });
    await load();
  }
}
$('#list').addEventListener('dragover', (e) => {
  if (!dropOk(e.dataTransfer)) return;
  const t = listTarget(e);
  if (!t) { markDrop(null); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MIME) ? 'move' : 'copy';
  markDrop(t);
});
$('#list').addEventListener('drop', (e) => { if (!dropOk(e.dataTransfer)) return; const t = listTarget(e); if (t) drop(e, t.parentId, t.index); });
$('#tree').addEventListener('dragover', (e) => {
  const tf = e.target.closest('.tf');
  if (!tf || !dropOk(e.dataTransfer) || dragIds?.includes(tf.dataset.id)) { markDrop(null); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MIME) ? 'move' : 'copy';
  markDrop(null, tf);
});
$('#tree').addEventListener('drop', (e) => { const tf = e.target.closest('.tf'); if (tf && dropOk(e.dataTransfer)) drop(e, tf.dataset.id, null); });
document.addEventListener('dragend', () => { dragIds = null; markDrop(null); document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging')); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) markDrop(null); });

// ---------------------------------------------------------------- the rest
$('#search').addEventListener('input', () => { selected = new Set(); focusId = null; editing = null; render(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && focusId) { e.preventDefault(); focusRow(focusId); } });
$('#new-folder').addEventListener('click', () => { if (query()) $('#search').value = ''; newFolder(); });
$('#toast-undo').addEventListener('click', runUndo);
document.addEventListener('keydown', (e) => {
  if (e.key === 'z' && mod(e) && !e.shiftKey && undo && !e.target.matches('input')) { e.preventDefault(); runUndo(); }
  if (e.key === 'f' && mod(e)) { e.preventDefault(); $('#search').focus(); $('#search').select(); }
});
page.on('bookmarks-changed', () => load());

// ?edit=<id or address> (Edit… from elsewhere): open its folder and rename it.
await load();
const wanted = new URLSearchParams(location.search).get('edit');
if (wanted) {
  const n = get(wanted) || [...index.values()].map((x) => x.node).find((x) => x.url === wanted);
  if (n && parentOf(n.id)) {
    openFolder(parentOf(n.id).id);
    selected = new Set([n.id]);
    edit(n.id);
  }
}
