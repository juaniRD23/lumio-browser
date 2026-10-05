// The side panel, like Chrome's, sharing the right column with Lumio AI: a
// small switcher at the top of the panel (Lumio AI, Reading list, Bookmarks,
// History, and Reading mode once the page tools add it) and a light view for
// each. The toolbar's side panel button opens the last view; Lumio AI's
// button and shortcuts open the chat. Data comes from main/side-panel.js.
//
// Another module can add a view: registerSideView('reader', { label,
// render(el, ctx) }) fills the Reading mode slot.
import { icons, markSvg } from './icons.js';

const VIEWS = ['ai', 'reading', 'bookmarks', 'history', 'reader'];
const LABELS = { ai: 'Lumio AI', reading: 'Reading list', bookmarks: 'Bookmarks', history: 'History', reader: 'Reading mode' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const isFolder = (n) => Array.isArray(n?.children);
const extra = new Map(); // views other modules add: name -> { label, render }

export function registerSideView(name, view) {
  if (!VIEWS.includes(name) || name === 'ai') return;
  extra.set(name, view);
  document.dispatchEvent(new CustomEvent('lumio-side-view', { detail: name }));
}

// When it happened, in a few words: "5 min ago", "Yesterday", "Mar 3".
function ago(t, now = Date.now()) {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  if (m < 60 * 48) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function dayLabel(t, now = new Date()) {
  const d = new Date(t);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return 'Today';
  if (t >= start - 86400000) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
function iconHtml(favicon) {
  return favicon ? `<img src="${esc(favicon)}" alt="" draggable="false">` : icons.globe;
}

// panel: the AI panel (open(), close(), isOpen()). modKey(e): ⌘ on the Mac.
export function initSidePanel({ api, panel, modKey, activeTab }) {
  const $ = (s) => document.querySelector(s);
  const sw = $('#side-switch');
  const box = $('#side-view');
  const btn = $('#side-btn');
  btn.innerHTML = icons.panel;
  let view = 'ai';
  let last = 'reading'; // the last view that isn't the chat (the side panel button opens it)
  let unread = 0;
  let query = { bookmarks: '', history: '' };
  let removed = null; // the reading list item just removed, for Undo
  let undoTimer = null;

  // ---- the switcher
  function drawSwitch() {
    sw.innerHTML = VIEWS.filter((v) => v !== 'reader' || extra.has('reader')).map((v) => {
      const icon = v === 'ai' ? markSvg(14) : icons[{ reading: 'list', bookmarks: 'star', history: 'clock', reader: 'page' }[v]];
      const badge = v === 'reading' && unread ? `<b class="ss-badge" aria-hidden="true">${unread > 99 ? '99+' : unread}</b>` : '';
      const label = LABELS[v] + (v === 'reading' && unread ? `, ${unread} unread` : '');
      return `<button type="button" class="ss-tab" role="tab" data-view="${v}" aria-selected="${v === view}" tabindex="${v === view ? 0 : -1}" title="${LABELS[v]}" aria-label="${esc(label)}">${icon}<span>${LABELS[v]}</span>${badge}</button>`;
    }).join('') + `<button type="button" class="icon-btn small ss-close" title="Hide side panel" aria-label="Hide side panel">${icons.panel}</button>`;
  }
  sw.addEventListener('click', (e) => {
    if (e.target.closest('.ss-close')) { panel.close(); renderBtn(); return; }
    const b = e.target.closest('.ss-tab');
    if (b) select(b.dataset.view, { focus: e.detail === 0 });
  });
  sw.addEventListener('keydown', (e) => {
    const tabs = [...sw.querySelectorAll('.ss-tab')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to == null) return;
    e.preventDefault();
    const b = tabs[(to + tabs.length) % tabs.length];
    select(b.dataset.view);
    sw.querySelector(`[data-view="${b.dataset.view}"]`)?.focus();
  });

  function select(next, { save = true, focus = false } = {}) {
    if (!VIEWS.includes(next) || (next === 'reader' && !extra.has('reader'))) next = 'ai';
    view = next;
    if (next !== 'ai') last = next;
    document.body.classList.toggle('side-other', next !== 'ai');
    $('#panel').setAttribute('aria-label', LABELS[next]);
    box.hidden = next === 'ai';
    drawSwitch();
    renderBtn();
    if (save) api.send('side:set', { view: next });
    if (next === 'ai') { if (focus) $('#prompt')?.focus(); return; }
    load(focus);
  }
  function renderBtn() {
    const on = panel.isOpen() && view !== 'ai';
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  // ---- the toolbar: the side panel button, and Lumio AI's button showing the chat
  btn.addEventListener('click', () => {
    if (panel.isOpen() && view !== 'ai') { panel.close(); renderBtn(); return; }
    panel.open();
    select(last, { focus: true });
  });
  // Lumio AI's button while another view shows: back to the chat (it doesn't hide the panel).
  $('#ai-toggle').addEventListener('click', (e) => {
    if (!panel.isOpen() || view === 'ai') return;
    e.stopImmediatePropagation();
    select('ai', { focus: true });
  }, true);
  // Anything that asks Lumio something shows the chat.
  for (const ev of ['ai-focus', 'ai-prefill', 'ai-open-chat', 'ai-workflow']) api.on(ev, () => { if (view !== 'ai') select('ai'); });
  api.on('panel-toggle', () => requestAnimationFrame(renderBtn));
  api.on('side-panel', ({ view: v } = {}) => { panel.open(); select(v, { focus: true }); });
  api.on('side-changed', ({ view: v, unread: n } = {}) => {
    if (typeof n === 'number' && n !== unread) { unread = n; drawSwitch(); }
    if (v === view) load();
  });
  api.on('bookmarks', () => { if (view === 'bookmarks') load(); });
  let historyTimer = null;
  api.on('tabs', () => {
    if (view !== 'history' || !panel.isOpen()) return;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(load, 800);
  });
  document.addEventListener('lumio-side-view', () => drawSwitch());

  // ---- the views
  let loadSeq = 0;
  async function load(focus = false) {
    const v = view;
    const seq = ++loadSeq;
    if (extra.has(v)) { extra.get(v).render(box, { api, activeTab }); return; }
    const data = await api.invoke('side:data', v, query[v] || '');
    if (seq !== loadSeq || v !== view || !data) return;
    const keep = box.contains(document.activeElement) && document.activeElement.matches('input') ? document.activeElement.selectionStart : null;
    if (v === 'reading') drawReading(data);
    else if (v === 'bookmarks') drawBookmarks(data);
    else if (v === 'history') drawHistory(data);
    if (keep != null) { const i = box.querySelector('input[type=search]'); if (i) { i.focus(); i.setSelectionRange(keep, keep); } }
    else if (focus) (box.querySelector('input[type=search], .sv-row, .sv-add') || box).focus();
  }

  function row({ url, title, favicon, sub, attrs = '', actions = '' }) {
    return `<div class="sv-row" role="listitem" tabindex="-1" data-url="${esc(url)}" ${attrs} title="${esc(`${title}\n${url}`)}"><span class="sv-ic">${iconHtml(favicon)}</span><span class="sv-text"><span class="sv-t">${esc(title)}</span><span class="sv-s">${esc(sub)}</span></span>${actions}</div>`;
  }
  function head(title, extraHtml = '') { return `<div class="sv-head"><h2>${esc(title)}</h2>${extraHtml}</div>`; }

  function drawReading({ items, unread: n, canAdd }) {
    unread = n;
    drawSwitch();
    const tab = activeTab();
    const canAddTab = canAdd && /^https?:/.test(tab?.url || '');
    const list = (rows, read) => rows.map((x) => row({
      url: x.url, title: x.title, favicon: x.favicon, sub: `${host(x.url)} · ${ago(x.added)}`,
      attrs: `data-rid="${esc(x.id)}"${read ? ' data-read="1"' : ''}`,
      actions: `<span class="sv-acts"><button type="button" class="icon-btn small" data-ract="${read ? 'unread' : 'read'}" tabindex="-1" title="${read ? 'Mark as unread' : 'Mark as read'}" aria-label="${read ? 'Mark as unread' : 'Mark as read'}">${read ? icons.list : icons.check}</button><button type="button" class="icon-btn small" data-ract="remove" tabindex="-1" title="Remove" aria-label="Remove">${icons.x}</button></span>`,
    })).join('');
    const unreadItems = items.filter((x) => !x.read);
    const readItems = items.filter((x) => x.read);
    box.innerHTML = head('Reading list', `<button type="button" class="sv-add btn" ${canAddTab ? '' : 'disabled'} title="${canAdd ? 'Save the page you’re on to read later' : 'Not available in Incognito'}">${icons.plus}<span>Add current tab</span></button>`)
      + (items.length ? '' : `<div class="sv-empty">${icons.list}<b>Your reading list is empty</b><span>Save pages to read later: right-click a tab or link, or use the ☆ in the address bar.</span></div>`)
      + (unreadItems.length ? `<h3 class="sv-sec">Unread</h3><div class="sv-list" role="list" aria-label="Unread">${list(unreadItems, false)}</div>` : '')
      + (readItems.length ? `<h3 class="sv-sec">Read</h3><div class="sv-list" role="list" aria-label="Read">${list(readItems, true)}</div>` : '')
      + (removed ? `<div class="sv-undo" role="status"><span>Removed from reading list</span><button type="button" class="sv-link" data-undo>Undo</button></div>` : '');
    fixImages();
  }

  function drawBookmarks({ roots }) {
    const q = query.bookmarks.trim().toLowerCase();
    let body = '';
    if (q) {
      const found = [];
      const walk = (n) => { if (isFolder(n)) n.children.forEach(walk); else if (`${n.title} ${n.url}`.toLowerCase().includes(q)) found.push(n); };
      roots.forEach(walk);
      body = found.length ? `<div class="sv-list" role="list">${found.slice(0, 200).map((b) => row({ url: b.url, title: b.title || b.url, favicon: b.favicon, sub: host(b.url) })).join('')}</div>` : '<div class="sv-empty"><span>No bookmarks match your search</span></div>';
    } else {
      const tree = (n, depth) => (isFolder(n)
        ? `<details class="sv-folder" ${depth === 0 && n.id === 'bar' ? 'open' : ''}><summary class="sv-row" tabindex="-1" style="--depth:${depth}"><span class="sv-ic">${icons.folder}</span><span class="sv-text"><span class="sv-t">${esc(n.title)}</span></span><span class="sv-count">${n.children.length}</span></summary><div role="group">${n.children.map((c) => tree(c, depth + 1)).join('') || `<div class="sv-none" style="--depth:${depth + 1}">Empty</div>`}</div></details>`
        : row({ url: n.url, title: n.title || n.url, favicon: n.favicon, sub: host(n.url), attrs: `style="--depth:${depth}"` }));
      body = `<div class="sv-list sv-tree" role="list">${roots.filter((r) => r.id !== 'mobile' || r.children.length).map((r) => tree(r, 0)).join('')}</div>`;
    }
    box.innerHTML = head('Bookmarks', '<button type="button" class="sv-link" data-open="lumio://bookmarks/">Manage</button>')
      + `<input type="search" class="sv-search" data-q="bookmarks" placeholder="Search bookmarks" aria-label="Search bookmarks" value="${esc(query.bookmarks)}">${body}`;
    fixImages();
  }

  function drawHistory({ items, incognito }) {
    let body = '';
    if (incognito) body = '<div class="sv-empty"><span>Incognito doesn’t show or save your history.</span></div>';
    else if (!items.length) body = `<div class="sv-empty"><span>${query.history ? 'No pages match your search' : 'Pages you visit show up here'}</span></div>`;
    else {
      let day = '';
      body = '<div class="sv-list" role="list">' + items.map((h) => {
        const d = dayLabel(h.time);
        const label = d !== day ? `<h3 class="sv-sec" role="presentation">${esc(d)}</h3>` : '';
        day = d;
        return label + row({ url: h.url, title: h.title, favicon: h.favicon, sub: `${host(h.url)} · ${new Date(h.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` });
      }).join('') + '</div>';
    }
    box.innerHTML = head('History', '<button type="button" class="sv-link" data-open="lumio://history/">Full history</button>')
      + (incognito ? '' : `<input type="search" class="sv-search" data-q="history" placeholder="Search history" aria-label="Search history" value="${esc(query.history)}">`) + body;
    fixImages();
  }
  function fixImages() { box.querySelectorAll('.sv-ic img').forEach((img) => { img.onerror = () => { img.outerHTML = icons.globe; }; }); }

  // ---- what you do in a view
  let searchTimer = null;
  box.addEventListener('input', (e) => {
    const q = e.target.dataset?.q;
    if (!q) return;
    query[q] = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, q === 'history' ? 200 : 60);
  });
  function openRow(el, e) {
    const disposition = e.button === 1 ? 'background' : modKey(e) ? (e.shiftKey ? 'tab' : 'background') : e.shiftKey ? 'window' : 'current';
    api.send('side:open', { url: el.dataset.url, disposition, ...(el.dataset.rid ? { readingId: el.dataset.rid } : {}) });
  }
  function removeReading(el) {
    removed = { id: el.dataset.rid, url: el.dataset.url, title: el.querySelector('.sv-t').textContent, read: !!el.dataset.read };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { removed = null; box.querySelector('.sv-undo')?.remove(); }, 6000);
    api.send('side:reading', { action: 'remove', id: el.dataset.rid });
  }
  box.addEventListener('click', (e) => {
    if (e.target.closest('.sv-add')) { api.send('side:reading', { action: 'add-current' }); return; }
    const open = e.target.closest('[data-open]');
    if (open) { api.send('side:open', { url: open.dataset.open, disposition: 'tab' }); return; }
    if (e.target.closest('[data-undo]')) {
      if (removed) api.send('side:reading', { action: 'restore', item: { ...removed, added: Date.now() } });
      removed = null;
      clearTimeout(undoTimer);
      return;
    }
    const act = e.target.closest('[data-ract]');
    const el = e.target.closest('.sv-row[data-url]');
    if (act && el) {
      if (act.dataset.ract === 'remove') removeReading(el);
      else api.send('side:reading', { action: act.dataset.ract, id: el.dataset.rid });
      return;
    }
    if (el) openRow(el, e);
  });
  box.addEventListener('auxclick', (e) => {
    const el = e.target.closest('.sv-row[data-url]');
    if (el && e.button === 1) openRow(el, e);
  });
  // Up and down move along the rows; Enter opens; Delete removes from the reading list.
  box.addEventListener('keydown', (e) => {
    const rows = [...box.querySelectorAll('.sv-row')].filter((r) => r.offsetParent);
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && e.target.matches('.sv-search')) { e.preventDefault(); rows[0]?.focus(); return; }
    if (i < 0) return;
    const el = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); rows[e.key === 'Home' ? 0 : rows.length - 1].focus(); }
    else if (e.key === 'Enter' && el.dataset.url) { e.preventDefault(); openRow(el, e); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && el.dataset.rid) { e.preventDefault(); rows[i + 1]?.focus(); removeReading(el); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && el.tagName === 'SUMMARY') { e.preventDefault(); el.parentElement.open = e.key === 'ArrowRight'; }
  });
  // Escape in a view goes back to the page.
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); api.send('tab:focus-page'); } });
  // Roving focus: the row you're on is the one Tab comes back to.
  box.addEventListener('focusin', (e) => {
    const r = e.target.closest('.sv-row');
    if (!r) return;
    box.querySelectorAll('.sv-row[tabindex="0"]').forEach((x) => { if (x !== r) x.tabIndex = -1; });
    r.tabIndex = 0;
  });

  return {
    init({ side } = {}) {
      unread = side?.unread || 0;
      const v = side?.view || 'ai';
      if (v !== 'ai') last = v;
      select(v, { save: false });
    },
    select,
    view: () => view,
  };
}
