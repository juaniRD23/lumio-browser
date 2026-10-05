// The bookmarks bar's folder menus (with submenus) and the star's edit
// bubble, drawn in the overlay above the page. The window
// (renderer/ui/bookmarks-bar.js) sends what to show; opening, moving,
// renaming and removing go to the main process (main/bookmarks-service.js).
// The overlay covers the page while they're open, so a click outside closes
// them, like a menu.
import { icons } from './icons.js';

const api = window.lumio;
const MIME = 'application/x-lumio-bookmarks'; // our own drags: { ids }
const SUBMENU_DELAY = 180; // pointing at a folder opens it after this
const DRAG_OPEN_DELAY = 550; // holding a drag over a folder opens it
const CHOOSE = '__choose'; // the folder menu's "Choose another folder…"

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isFolder = (n) => Array.isArray(n?.children);
const MAC = navigator.platform.startsWith('Mac');
const siteFavicon = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.origin}/favicon.ico` : ''; } catch { return ''; } };

const root = document.createElement('div');
root.id = 'bm-root';
root.hidden = true;
document.body.append(root);
const card = document.getElementById('card');
let kind = null;

const close = (extra = {}) => api.send('overlay:pick', { kind, ...extra });

api.on('overlay-data', (p) => {
  if (kind === 'bm-edit' && edit?.timer) sendEdit(); // a name still being typed
  const mine = p.kind === 'bm-menu' || p.kind === 'bm-edit';
  root.hidden = !mine;
  card.style.display = mine ? 'none' : '';
  if (!mine) { kind = null; root.innerHTML = ''; return; }
  if (p.kind !== kind) root.innerHTML = '';
  kind = p.kind;
  if (kind === 'bm-menu') showMenus(p); else showBubble(p);
});

// A click on the see-through part (the page under it) closes them.
root.addEventListener('mousedown', (e) => {
  if (e.target !== root) return;
  e.preventDefault();
  if (kind === 'bm-edit') done(); else close({ refocus: 'page' });
});

// ---------------------------------------------------------------- menus
// levels[0] is the folder clicked on the bar; each open submenu adds one.
let levels = [];
let focusDepth = 0; // the menu the arrow keys move in
let anchor = null;
let pointTimer = null;
let typed = { text: '', at: 0 };

function rowHtml(n, i) {
  if (isFolder(n)) {
    return `<div class="bm-row folder" role="menuitem" tabindex="-1" data-i="${i}" draggable="true" aria-haspopup="menu" aria-expanded="false"><span class="ic">${icons.folder}</span><span class="t">${esc(n.title)}</span><span class="chev">${icons.forward}</span></div>`;
  }
  const fallback = siteFavicon(n.url);
  const src = n.favicon || fallback;
  const img = src ? `<img src="${esc(src)}" alt=""${n.favicon && fallback && fallback !== n.favicon ? ` data-fallback="${esc(fallback)}"` : ''}>` : icons.globe;
  return `<div class="bm-row" role="menuitem" tabindex="-1" data-i="${i}" draggable="true" title="${esc(`${n.title}\n${n.url}`)}"><span class="ic">${img}</span><span class="t">${esc(n.title || n.url)}</span></div>`;
}

function menuHtml(folder) {
  const rows = folder.children.length
    ? folder.children.map(rowHtml).join('')
    : '<div class="bm-row empty" role="menuitem" aria-disabled="true" tabindex="-1" data-empty="1"><span class="t">(empty)</span></div>';
  return `<div class="bm-menu" role="menu" aria-label="${esc(folder.title)}">${rows}</div>`;
}

function fixIcons(el) {
  el.querySelectorAll('img').forEach((img) => {
    img.onerror = () => {
      if (img.dataset.fallback) { img.src = img.dataset.fallback; delete img.dataset.fallback; return; }
      img.outerHTML = icons.globe;
    };
  });
}

// Adds a menu for `folder` after level `depth - 1`, next to `fromRow` (or under the bar button).
function closeFrom(depth) {
  for (const l of levels.splice(depth)) l.el.remove();
  levels.at(-1)?.el.querySelectorAll('.bm-row.folder[aria-expanded="true"]').forEach((r) => r.setAttribute('aria-expanded', 'false'));
  focusDepth = Math.min(focusDepth, Math.max(0, levels.length - 1));
}

function openLevel(depth, folder, fromRow) {
  closeFrom(depth);
  const wrap = document.createElement('div');
  wrap.innerHTML = menuHtml(folder);
  const el = wrap.firstElementChild;
  root.append(el);
  fixIcons(el);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  let left;
  let top;
  if (depth === 0) {
    left = Math.max(6, Math.min(anchor.left - 4, vw - w - 6));
    top = 2;
  } else {
    fromRow.setAttribute('aria-expanded', 'true');
    const pr = levels[depth - 1].el.getBoundingClientRect();
    const rr = fromRow.getBoundingClientRect();
    left = pr.right - 4 + w <= vw - 4 ? pr.right - 4 : Math.max(4, pr.left - w + 4);
    top = rr.top - 7;
  }
  el.style.maxHeight = `${Math.max(120, vh - 16)}px`;
  el.style.left = `${left}px`;
  top = Math.max(2, Math.min(top, vh - el.offsetHeight - 10));
  el.style.top = `${top}px`;
  el.style.maxHeight = `${vh - top - 10}px`;
  levels[depth] = { el, folder, active: -1 };
  return levels[depth];
}

function showMenus(p) {
  anchor = p.anchor;
  // Redrawn with new contents (a drop, a rename): keep the open submenus.
  const path = p.keep ? levels.map((l) => l.folder.id) : [];
  const activeId = p.keep ? currentRowNode()?.id : null;
  closeFrom(0);
  openLevel(0, p.folder);
  for (let d = 1; d < path.length; d++) {
    const parent = levels[d - 1];
    const i = parent.folder.children.findIndex((n) => n.id === path[d]);
    if (i < 0) break;
    openLevel(d, parent.folder.children[i], rowAt(d - 1, i));
  }
  if (activeId) {
    const d = Math.min(focusDepth, levels.length - 1);
    const i = levels[d].folder.children.findIndex((n) => n.id === activeId);
    if (i >= 0) setActive(d, i, false);
  }
  if (p.keyboard) setActive(0, firstEnabled(0), true);
}

const rowAt = (depth, i) => levels[depth]?.el.querySelector(`.bm-row[data-i="${i}"]`) || null;
const rowsOf = (depth) => [...(levels[depth]?.el.querySelectorAll('.bm-row') || [])];
const firstEnabled = (depth) => (levels[depth]?.folder.children.length ? 0 : -1);
function currentRowNode() {
  const l = levels[focusDepth];
  return l && l.active >= 0 ? l.folder.children[l.active] : null;
}
function levelOf(el) { return levels.findIndex((l) => l.el.contains(el)); }

function setActive(depth, i, focus = true) {
  const l = levels[depth];
  if (!l) return;
  l.el.querySelectorAll('.bm-row.active').forEach((r) => r.classList.remove('active'));
  l.active = i;
  focusDepth = depth;
  const row = i >= 0 ? rowAt(depth, i) : l.el.querySelector('[data-empty]');
  if (!row) return;
  row.classList.add('active');
  if (focus) row.focus({ preventScroll: false });
}

// What a row does when chosen (click, Enter): a bookmark opens; a folder opens its submenu.
function choose(depth, i, { disposition = 'current', keyboard = false } = {}) {
  const n = levels[depth]?.folder.children[i];
  if (!n) return;
  if (isFolder(n)) {
    openLevel(depth + 1, n, rowAt(depth, i));
    if (keyboard) setActive(depth + 1, firstEnabled(depth + 1));
    return;
  }
  api.send('bookmarks:open', { id: n.id, disposition });
  close();
}

const dispositionOf = (e) => (e.button === 1 ? 'background' : (MAC ? e.metaKey : e.ctrlKey) ? (e.shiftKey ? 'tab' : 'background') : e.shiftKey ? 'window' : 'current');

root.addEventListener('mouseover', (e) => {
  if (kind !== 'bm-menu') return;
  const row = e.target.closest('.bm-row');
  if (!row || row.dataset.empty) return;
  const depth = levelOf(row);
  const i = +row.dataset.i;
  setActive(depth, i, false);
  clearTimeout(pointTimer);
  // Pointing at a folder opens it; at a bookmark, closes deeper menus. A short
  // wait lets the pointer cross other rows on its way to an open submenu.
  pointTimer = setTimeout(() => {
    const n = levels[depth]?.folder.children[i];
    if (!n) return;
    if (isFolder(n)) { if (levels[depth + 1]?.folder.id !== n.id) openLevel(depth + 1, n, row); } else closeFrom(depth + 1);
  }, SUBMENU_DELAY);
});
root.addEventListener('click', (e) => {
  if (kind !== 'bm-menu') return;
  const row = e.target.closest('.bm-row');
  if (!row || row.dataset.empty) return;
  clearTimeout(pointTimer);
  choose(levelOf(row), +row.dataset.i, { disposition: dispositionOf(e) });
});
root.addEventListener('auxclick', (e) => {
  if (kind !== 'bm-menu' || e.button !== 1) return;
  const row = e.target.closest('.bm-row');
  const n = row && levels[levelOf(row)]?.folder.children[+row.dataset.i];
  if (n) { api.send('bookmarks:open', { id: n.id, disposition: 'background' }); close(); }
});
root.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (kind !== 'bm-menu') return;
  const row = e.target.closest('.bm-row');
  const n = row && levels[levelOf(row)]?.folder.children[+row.dataset.i];
  if (n) api.send('bookmarks:context', n.id);
});

function menuKey(e) {
  const depth = Math.min(focusDepth, levels.length - 1);
  const l = levels[depth];
  if (!l) return;
  const count = l.folder.children.length;
  const move = (step) => { e.preventDefault(); if (count) setActive(depth, l.active < 0 ? (step > 0 ? 0 : count - 1) : (l.active + step + count) % count); };
  const n = l.folder.children[l.active];
  switch (e.key) {
    case 'ArrowDown': move(1); break;
    case 'ArrowUp': move(-1); break;
    case 'Home': e.preventDefault(); if (count) setActive(depth, 0); break;
    case 'End': e.preventDefault(); if (count) setActive(depth, count - 1); break;
    case 'ArrowRight':
      e.preventDefault();
      if (isFolder(n)) choose(depth, l.active, { keyboard: true });
      else if (depth === 0) close({ refocus: 'shell', move: 1 });
      break;
    case 'ArrowLeft':
    case 'Escape':
      e.preventDefault();
      if (depth > 0) { closeFrom(depth); setActive(depth - 1, levels[depth - 1].active); } else close(e.key === 'Escape' ? { refocus: 'shell' } : { refocus: 'shell', move: -1 });
      break;
    case 'Tab': e.preventDefault(); close({ refocus: 'shell' }); break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (l.active >= 0) choose(depth, l.active, { keyboard: true, disposition: (MAC ? e.metaKey : e.ctrlKey) ? 'tab' : e.shiftKey ? 'window' : 'current' });
      break;
    default: {
      // Typing a letter jumps to the next row that starts with it.
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || !count) return;
      const now = Date.now();
      typed = { text: (now - typed.at < 800 ? typed.text : '') + e.key.toLowerCase(), at: now };
      const start = typed.text.length > 1 ? Math.max(0, l.active) : l.active + 1;
      for (let k = 0; k < count; k++) {
        const j = (start + k) % count;
        if (String(l.folder.children[j].title || '').toLowerCase().startsWith(typed.text)) { setActive(depth, j); break; }
      }
    }
  }
}

// ---- drag and drop inside menus: reorder, into folders, out to the bar
function where(row, y) {
  const depth = levelOf(row);
  const folder = levels[depth].folder;
  const parentId = folder.dropParent || folder.id;
  const offset = folder.offset || 0;
  if (row.dataset.empty) return { depth, parentId, index: 0 };
  const i = +row.dataset.i;
  const r = row.getBoundingClientRect();
  const f = (y - r.top) / r.height;
  if (row.classList.contains('folder') && f > 0.25 && f < 0.75) return { depth, row, into: true, parentId: folder.children[i].id, index: null };
  return { depth, row, after: f >= 0.5, parentId, index: offset + i + (f >= 0.5 ? 1 : 0) };
}
let dragHold = null; // { row, timer }
function markDrop(t) {
  root.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-into'));
  if (t?.row) t.row.classList.add(t.into ? 'drop-into' : t.after ? 'drop-after' : 'drop-before');
  const row = t?.into ? t.row : null;
  if (dragHold?.row === row) return;
  clearTimeout(dragHold?.timer);
  dragHold = row ? { row, timer: setTimeout(() => { const d = levelOf(row); const n = levels[d]?.folder.children[+row.dataset.i]; if (n && isFolder(n)) openLevel(d + 1, n, row); }, DRAG_OPEN_DELAY) } : null;
}
root.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.bm-row');
  const n = row && levels[levelOf(row)]?.folder.children[+row.dataset.i];
  if (!n) return;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(MIME, JSON.stringify({ ids: [n.id] }));
  if (n.url) { e.dataTransfer.setData('text/uri-list', n.url); e.dataTransfer.setData('text/plain', n.url); }
  row.classList.add('dragging');
});
root.addEventListener('dragend', (e) => { e.target.closest?.('.bm-row')?.classList.remove('dragging'); markDrop(null); });
root.addEventListener('dragover', (e) => {
  const row = kind === 'bm-menu' && e.target.closest('.bm-row');
  const types = e.dataTransfer.types;
  if (!row || !(types.includes(MIME) || types.includes('text/uri-list'))) { markDrop(null); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = types.includes(MIME) ? 'move' : 'copy';
  markDrop(where(row, e.clientY));
});
root.addEventListener('drop', (e) => {
  const row = kind === 'bm-menu' && e.target.closest('.bm-row');
  if (!row) return;
  e.preventDefault();
  const t = where(row, e.clientY);
  markDrop(null);
  const dt = e.dataTransfer;
  if (dt.types.includes(MIME)) {
    let ids = [];
    try { ids = JSON.parse(dt.getData(MIME)).ids || []; } catch { /* not ours after all */ }
    if (ids.length) api.send('bookmarks:move', { ids, parentId: t.parentId, index: t.index });
  } else {
    const url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'))?.trim() || '';
    let title = '';
    try { title = new DOMParser().parseFromString(dt.getData('text/html') || '', 'text/html').querySelector('a')?.textContent.trim() || ''; } catch {}
    if (/^(https?|file):/i.test(url)) api.send('bookmarks:add', { url, title, parentId: t.parentId, index: t.index });
  }
  close();
});

// ---------------------------------------------------------------- the edit bubble
let edit = null; // { id, folder, parentId, timer, view }

function folderOptions(p) {
  const byId = new Map(p.folders.map((f) => [f.id, f]));
  const list = ['bar', 'other'];
  if (p.parentId === 'mobile') list.push('mobile');
  for (const id of p.recent) if (!list.includes(id)) list.push(id);
  if (!list.includes(p.parentId)) list.push(p.parentId);
  return list.filter((id) => byId.has(id)).map((id) => `<option value="${esc(id)}"${id === p.parentId ? ' selected' : ''}>${esc(byId.get(id).title)}</option>`).join('')
    + `<option disabled>──────────</option><option value="${CHOOSE}">Choose another folder…</option>`;
}

function showBubble(p) {
  const keepFocus = p.refresh && document.activeElement?.id;
  edit = { id: p.node.id, folder: p.node.folder, parentId: p.parentId, title: p.node.title, url: p.editUrl ? p.node.url : null, data: p, view: 'main' };
  const heading = p.heading || (p.node.folder ? 'Edit folder' : 'Edit bookmark');
  root.innerHTML = `<div class="bm-bubble" role="dialog" aria-labelledby="bmb-h">
    <div class="bmb-head" id="bmb-h">${esc(heading)}</div>
    <div class="bmb-main">
      <label class="bmb-field"><span>Name</span><input id="bmb-name" type="text" spellcheck="false" autocomplete="off" value="${esc(p.node.title)}"></label>
      ${p.editUrl ? `<label class="bmb-field"><span>URL</span><input id="bmb-url" type="text" spellcheck="false" autocomplete="off" value="${esc(p.node.url)}"></label>` : ''}
      <label class="bmb-field"><span>Folder</span><select id="bmb-folder">${folderOptions(p)}</select></label>
      <div class="bmb-actions"><button class="acc-btn ghost" data-act="remove">${p.node.folder ? 'Delete' : 'Remove'}</button>${p.reading ? '<button class="acc-btn ghost" data-act="reading" title="Save this page to read later">Add to reading list</button>' : ''}<span class="sp"></span><button class="acc-btn primary" data-act="done">Done</button></div>
    </div>
    <div class="bmb-pick" hidden>
      <div class="bmb-tree" role="tree" tabindex="0" aria-label="Folders"></div>
      <label class="bmb-field bmb-new" hidden><span>New folder name</span><input id="bmb-new" type="text" spellcheck="false" autocomplete="off" placeholder="New folder"></label>
      <div class="bmb-actions"><button class="acc-btn ghost" data-act="new">New folder</button><span class="sp"></span><button class="acc-btn ghost" data-act="cancel">Cancel</button><button class="acc-btn primary" data-act="save">Save</button></div>
    </div>
  </div>`;
  const el = root.firstElementChild;
  const vw = window.innerWidth;
  const w = el.offsetWidth;
  const left = p.anchor.align === 'left' ? p.anchor.left - 6 : p.anchor.right - w + 10;
  el.style.left = `${Math.max(8, Math.min(left, vw - w - 8))}px`;
  el.style.top = '2px';
  if (p.refresh) {
    el.classList.add('still');
    document.getElementById(keepFocus || 'bmb-folder')?.focus();
  } else {
    const name = document.getElementById('bmb-name');
    name.focus();
    name.select();
  }
}

// Edits apply as you go, so the bubble never loses one however it closes.
function sendEdit(extra = {}) {
  clearTimeout(edit.timer);
  edit.timer = null;
  api.send('bookmarks:edit', { id: edit.id, title: edit.title, ...(edit.url != null ? { url: edit.url } : {}), ...extra });
}
root.addEventListener('input', (e) => {
  if (kind !== 'bm-edit' || !edit || !e.target.matches('#bmb-name, #bmb-url')) return;
  edit[e.target.id === 'bmb-url' ? 'url' : 'title'] = e.target.value;
  clearTimeout(edit.timer);
  edit.timer = setTimeout(() => sendEdit(), 350);
});
root.addEventListener('change', (e) => {
  if (kind !== 'bm-edit' || !edit || e.target.id !== 'bmb-folder') return;
  const v = e.target.value;
  if (v === CHOOSE) { e.target.value = edit.parentId; openPicker(); return; }
  edit.parentId = v;
  sendEdit({ parentId: v });
});

// "Choose another folder…": every folder, as a tree, and New folder.
function openPicker() {
  edit.view = 'pick';
  edit.chosen = edit.parentId;
  const el = root.querySelector('.bm-bubble');
  el.querySelector('.bmb-main').hidden = true;
  el.querySelector('.bmb-pick').hidden = false;
  document.getElementById('bmb-h').textContent = 'Choose a folder';
  const tree = el.querySelector('.bmb-tree');
  tree.innerHTML = edit.data.folders.map((f) => `<div class="bmb-folder${f.id === edit.chosen ? ' on' : ''}" role="treeitem" aria-level="${f.depth + 1}" aria-selected="${f.id === edit.chosen}" data-id="${esc(f.id)}" style="padding-left:${10 + f.depth * 16}px">${icons.folder}<span>${esc(f.title)}</span></div>`).join('');
  tree.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  tree.focus();
}
function pick(id) {
  edit.chosen = id;
  root.querySelectorAll('.bmb-folder').forEach((r) => { const on = r.dataset.id === id; r.classList.toggle('on', on); r.setAttribute('aria-selected', String(on)); if (on) r.scrollIntoView({ block: 'nearest' }); });
}
function closePicker() {
  edit.view = 'main';
  const el = root.querySelector('.bm-bubble');
  el.querySelector('.bmb-pick').hidden = true;
  el.querySelector('.bmb-new').hidden = true;
  el.querySelector('.bmb-main').hidden = false;
  document.getElementById('bmb-h').textContent = edit.data.heading || (edit.folder ? 'Edit folder' : 'Edit bookmark');
  document.getElementById('bmb-folder').focus();
}
function savePicker() {
  const name = document.getElementById('bmb-new');
  const wantsNew = !name.closest('.bmb-new').hidden;
  if (wantsNew) {
    sendEdit({ newFolder: { parentId: edit.chosen, title: name.value.trim() || 'New folder' } }); // the bubble redraws with it
  } else if (edit.chosen && edit.chosen !== edit.parentId) {
    edit.parentId = edit.chosen;
    const select = document.getElementById('bmb-folder');
    if (![...select.options].some((o) => o.value === edit.chosen)) select.insertAdjacentHTML('afterbegin', `<option value="${esc(edit.chosen)}">${esc(edit.data.folders.find((f) => f.id === edit.chosen)?.title || 'Folder')}</option>`);
    select.value = edit.chosen;
    sendEdit({ parentId: edit.chosen });
  }
  closePicker();
}

function done(refocus = 'page') {
  if (edit) sendEdit();
  close({ refocus });
}

root.addEventListener('click', (e) => {
  if (kind !== 'bm-edit' || !edit) return;
  const folderRow = e.target.closest('.bmb-folder');
  if (folderRow) { pick(folderRow.dataset.id); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'done') done();
  else if (act === 'reading') { api.send('side:reading', { action: 'add-current' }); done(); }
  else if (act === 'remove') { clearTimeout(edit.timer); api.send('bookmarks:remove', edit.id); close({ refocus: 'page' }); } else if (act === 'cancel') closePicker();
  else if (act === 'save') savePicker();
  else if (act === 'new') { const f = root.querySelector('.bmb-new'); f.hidden = false; const i = document.getElementById('bmb-new'); i.focus(); i.select(); }
});
root.addEventListener('dblclick', (e) => { if (kind === 'bm-edit' && e.target.closest('.bmb-folder')) savePicker(); });

function bubbleKey(e) {
  if (edit.view === 'pick') {
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
    if (e.key === 'Enter') { e.preventDefault(); savePicker(); return; }
    if (e.target.closest('.bmb-tree') && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const list = edit.data.folders;
      const i = list.findIndex((f) => f.id === edit.chosen);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      pick(list[j].id);
    }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); done(); return; }
  if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); done(); }
}

document.addEventListener('keydown', (e) => {
  if (kind === 'bm-menu') menuKey(e);
  else if (kind === 'bm-edit' && edit) bubbleKey(e);
});
