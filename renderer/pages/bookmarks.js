import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

let items = [];
let editing = new URLSearchParams(location.search).get('edit');

function icon(b) {
  if (b.favicon) return `<img src="${esc(b.favicon)}" alt="">`;
  let origin = '';
  try { origin = new URL(b.url).origin; } catch {}
  return `<img src="${esc(origin)}/favicon.ico" alt="">`;
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const list = q ? items.filter((b) => b.url.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)) : items;
  if (!list.length) {
    $('#list').innerHTML = `<div class="empty">${q ? 'No bookmarks match' : 'No bookmarks yet. Press ⌘D on any page to add one.'}</div>`;
    return;
  }
  $('#list').innerHTML = list.map((b) => {
    if (b.url === editing) {
      return `<div class="bm-row editing" data-url="${esc(b.url)}">
        <input class="field" id="edit-title" value="${esc(b.title)}" aria-label="Name" placeholder="Name">
        <input class="field" id="edit-url" value="${esc(b.url)}" aria-label="URL" placeholder="https://…">
        <span class="acts"><button class="btn small ghost" data-act="cancel">Cancel</button><button class="btn small primary" data-act="save">Save</button></span>
      </div>`;
    }
    return `<div class="bm-row" draggable="${q ? 'false' : 'true'}" data-url="${esc(b.url)}">
      <span class="grip" title="Drag to reorder">⋮⋮</span>${icon(b)}
      <a class="t" href="${esc(b.url)}">${esc(b.title || b.url)}</a>
      <span class="u">${esc(pretty(b.url))}</span>
      <span class="acts"><button class="btn small ghost" data-act="edit">Edit</button><button class="btn small ghost danger" data-act="delete">Delete</button></span>
    </div>`;
  }).join('');
  $('#list').querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.outerHTML = '<span class="dot"></span>'; }));
  const t = $('#edit-title');
  if (t) { t.focus(); t.select(); }
}

async function load() {
  items = await page.invoke('page:bookmarks');
  render();
}

async function save(row) {
  const url = row.dataset.url;
  const title = $('#edit-title').value;
  const newUrl = $('#edit-url').value.trim();
  const ok = await page.invoke('page:bookmark-update', url, { title, url: newUrl });
  if (!ok) return;
  editing = null;
  history.replaceState(null, '', location.pathname);
  load();
}

$('#list').addEventListener('click', async (e) => {
  const row = e.target.closest('.bm-row');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!row || !act) return;
  if (act === 'edit') { editing = row.dataset.url; render(); }
  if (act === 'cancel') { editing = null; render(); }
  if (act === 'save') save(row);
  if (act === 'delete') { await page.invoke('page:bookmark-remove', row.dataset.url); load(); }
});
$('#list').addEventListener('keydown', (e) => {
  const row = e.target.closest('.bm-row.editing');
  if (!row) return;
  if (e.key === 'Enter') save(row);
  if (e.key === 'Escape') { editing = null; render(); }
});

// Drag to reorder.
let dragUrl = null;
$('#list').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.bm-row');
  if (!row) return;
  dragUrl = row.dataset.url;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
$('#list').addEventListener('dragover', (e) => {
  const row = e.target.closest('.bm-row');
  if (!dragUrl || !row) return;
  e.preventDefault();
  document.querySelectorAll('.drop-before').forEach((r) => r.classList.remove('drop-before'));
  row.classList.add('drop-before');
});
$('#list').addEventListener('drop', async (e) => {
  const row = e.target.closest('.bm-row');
  if (!dragUrl || !row) return;
  e.preventDefault();
  const to = items.findIndex((b) => b.url === row.dataset.url);
  const from = items.findIndex((b) => b.url === dragUrl);
  await page.invoke('page:bookmark-move', dragUrl, from < to ? to - 1 : to);
  load();
});
$('#list').addEventListener('dragend', () => {
  dragUrl = null;
  document.querySelectorAll('.dragging, .drop-before').forEach((r) => r.classList.remove('dragging', 'drop-before'));
});

$('#search').addEventListener('input', render);
$('#export').addEventListener('click', () => page.invoke('page:bookmarks-export'));

$('#bar-toggle').checked = await page.invoke('page:bookmarks-bar');
$('#bar-toggle').addEventListener('change', (e) => page.invoke('page:set-bookmarks-bar', e.target.checked));
await load();
