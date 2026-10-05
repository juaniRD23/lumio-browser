import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const keyOf = (h) => `${h.time}|${h.url}`;

let all = await page.invoke('page:history'); // newest first
let view = 'history';
let site = null;
let shown = 300;
const selected = new Set();
let lastKey = null;
let visible = [];

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Escape, then wrap matches of the search in <mark>.
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function favicon(h) {
  if (h.favicon) return `<img src="${esc(h.favicon)}" alt="" loading="lazy">`;
  let origin = '';
  try { origin = new URL(h.url).origin; } catch {}
  return `<img src="${esc(origin)}/favicon.ico" alt="" loading="lazy">`;
}

function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  return all.filter((h) => (!site || host(h.url) === site)
    && (!q || h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)));
}

function render() {
  if (view !== 'history') return;
  const q = $('#search').value.trim();
  visible = filtered();
  $('#filter').hidden = !site;
  if (site) $('#filter span').textContent = `Only ${site}`;
  renderSelection();
  if (!visible.length) {
    $('#list').innerHTML = `<div class="empty">${q || site ? 'No history matches' : 'Pages you visit will show up here.'}</div>`;
    return;
  }
  let html = '';
  let last = '';
  for (const h of visible.slice(0, shown)) {
    const label = dayLabel(h.time);
    if (label !== last) { html += `<div class="day">${esc(label)}</div>`; last = label; }
    const k = keyOf(h);
    const time = new Date(h.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    html += `<div class="item ${selected.has(k) ? 'sel' : ''}" role="listitem" data-k="${esc(k)}">
      <input type="checkbox" ${selected.has(k) ? 'checked' : ''} aria-label="Select">
      <span class="time">${esc(time)}</span>${favicon(h)}
      <a class="title" href="${esc(h.url)}" title="${esc(h.url)}">${highlight(h.title || h.url, q)}</a>
      <button class="host" data-host="${esc(host(h.url))}" title="More from this site">${highlight(host(h.url), q)}</button>
      <span class="acts"><button data-act="tab" title="Open in a new tab">New tab</button><button data-act="remove" title="Remove from history">Remove</button></span>
    </div>`;
  }
  if (visible.length > shown) html += `<div class="more" id="more">Loading more…</div>`;
  $('#list').innerHTML = html;
  $('#list').querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.outerHTML = '<span class="dot"></span>'; }));
  const more = $('#more');
  if (more) new IntersectionObserver((entries, obs) => {
    if (entries.some((e) => e.isIntersecting)) { obs.disconnect(); shown += 300; render(); }
  }).observe(more);
}

function renderSelection() {
  $('#selbar').hidden = !selected.size;
  document.body.classList.toggle('selecting', selected.size > 0);
  $('#selcount').textContent = `${selected.size} selected`;
}

function entryFor(k) { return all.find((h) => keyOf(h) === k); }

async function remove(keys) {
  const entries = keys.map(entryFor).filter(Boolean).map(({ url, time }) => ({ url, time }));
  if (!entries.length) return;
  await page.invoke('page:history-delete', { entries });
  const gone = new Set(keys);
  all = all.filter((h) => !gone.has(keyOf(h)));
  keys.forEach((k) => selected.delete(k));
  render();
}

$('#list').addEventListener('click', async (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  const k = item.dataset.k;
  const h = entryFor(k);
  if (e.target.matches('input[type=checkbox]')) {
    const keys = visible.slice(0, shown).map(keyOf);
    if (e.shiftKey && lastKey && keys.includes(lastKey)) {
      const [a, b] = [keys.indexOf(lastKey), keys.indexOf(k)].sort((x, y) => x - y);
      keys.slice(a, b + 1).forEach((x) => selected.add(x));
    } else if (e.target.checked) selected.add(k); else selected.delete(k);
    lastKey = k;
    render();
    return;
  }
  const hostBtn = e.target.closest('button.host');
  if (hostBtn) { site = hostBtn.dataset.host; shown = 300; window.scrollTo(0, 0); render(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'remove') remove([k]);
  if (act === 'tab' && h) page.invoke('page:open', h.url, 'background');
});
$('#filter button').addEventListener('click', () => { site = null; render(); });
$('#sel-cancel').addEventListener('click', () => { selected.clear(); render(); });
$('#sel-delete').addEventListener('click', () => remove([...selected]));

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { shown = 300; if (view !== 'history') switchView('history'); else render(); }, 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape' && selected.size) { selected.clear(); render(); }
});

// ---- recently closed ----
async function renderClosed() {
  const list = await page.invoke('page:recently-closed');
  if (!list.length) { $('#closed').innerHTML = '<div class="empty">Tabs and windows you close show up here.</div>'; return; }
  $('#closed').innerHTML = list.map((e) => {
    const icon = e.kind === 'window'
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9h17"/></svg>'
      : e.favicon ? `<img src="${esc(e.favicon)}" alt="">` : '<span class="dot"></span>';
    const sub = e.kind === 'window'
      ? `Window · ${e.tabs.length} tab${e.tabs.length === 1 ? '' : 's'}: ${e.tabs.slice(0, 4).map((t) => t.title || host(t.url)).join(', ')}`
      : host(e.url);
    return `<div class="closed-item"><span class="ico">${icon}</span><div class="meta"><div class="t">${esc(e.kind === 'window' ? e.title : e.title || e.url)}</div><div class="s">${esc(sub)} · ${esc(ago(e.time))}</div></div><button class="btn" data-reopen="${e.index}">Reopen</button></div>`;
  }).join('');
}
$('#closed').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reopen]');
  if (!btn) return;
  await page.invoke('page:reopen-closed', Number(btn.dataset.reopen));
  renderClosed();
});

// ---- tabs open on your other devices (Lumio Sync) ----
async function renderDevices() {
  const list = await page.invoke('page:other-tabs').catch(() => []);
  if (!list.length) { $('#devices').innerHTML = '<div class="empty">Tabs open on your other computers show up here when Sync is on (Settings › Sync).</div>'; return; }
  $('#devices').innerHTML = list.map((d) => `<h3 class="dev-head">${esc(d.name)}<small>${esc(ago(d.at))}</small></h3>${d.windows.flatMap((w) => w.tabs).map((t) => `
    <div class="closed-item"><span class="ico"><span class="dot"></span></span><div class="meta"><div class="t">${esc(t.title || t.url)}</div><div class="s">${esc(host(t.url))}</div></div><button class="btn" data-open="${esc(t.url)}">Open</button></div>`).join('')}`).join('');
}
$('#devices').addEventListener('click', (e) => {
  const url = e.target.closest('[data-open]')?.dataset.open;
  if (url) page.invoke('page:open', url, 'tab');
});

function switchView(v) {
  view = v;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $('#list').hidden = v !== 'history';
  $('#closed').hidden = v !== 'closed';
  $('#devices').hidden = v !== 'devices';
  if (v === 'devices') { renderDevices(); return; }
  $('#filter').hidden = v !== 'history' || !site;
  $('#selbar').hidden = v !== 'history' || !selected.size;
  if (v === 'closed') renderClosed(); else render();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

// ---- clear browsing data ----
const dlg = $('#clear-dialog');
$('#clear-open').addEventListener('click', () => dlg.showModal());
// ⌘⇧⌫ / Ctrl+Shift+Delete opens lumio://history/#clear (main/navigation.js).
const clearAsked = () => { if (location.hash === '#clear' && !dlg.open) dlg.showModal(); };
clearAsked();
window.addEventListener('hashchange', clearAsked);
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'clear') return;
  const what = [...dlg.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
  if (!what.length) return;
  await page.invoke('page:clear-data', { range: Number($('#range').value), what });
  all = await page.invoke('page:history');
  selected.clear();
  if (view === 'closed') renderClosed(); else render();
});

const params = new URLSearchParams(location.search);
if (params.get('q')) $('#search').value = params.get('q');
if (params.get('view') === 'closed') switchView('closed'); else render();
