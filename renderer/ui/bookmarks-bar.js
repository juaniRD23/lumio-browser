// The bookmarks bar under the address bar, like Chrome's: what's in the
// Bookmarks bar folder, with folders that open a menu (drawn above the page
// by renderer/ui/overlay-bookmarks.js) with submenus; what doesn't fit goes
// under »; Other bookmarks and All bookmarks sit at the right end. Drag a
// bookmark to move it, onto a folder to put it inside (hold to open the
// folder and drop in place), or drop a link to add it. The arrow keys move
// along the bar. It also opens the star's edit bubble.
import { icons } from './icons.js';

const MIME = 'application/x-lumio-bookmarks'; // our own drags: { ids }
const OPEN_DELAY = 550; // holding a drag over a folder opens it
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Imported bookmarks have no icon until the page is opened once: until then, the site's /favicon.ico.
const siteFavicon = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.origin}/favicon.ico` : ''; } catch { return ''; } };
const isFolder = (n) => Array.isArray(n?.children);

// overlay: { kind(), show(kind, rect, payload), hide(kind), closed(kind) },
// shell.js's one overlay. accent(): the profile's colors for the overlay.
export function initBookmarksBar({ api, bar, isMac, modKey, activeTab, reportSlot, accent, overlay }) {
  let data = { show: false, items: [], other: null, mobile: null, folders: [], recent: [] };
  let visible = null;
  let menu = null; // the open folder menu: { id, keyboard, drag }
  let bubble = null; // the open bubble: { id, heading, rect, editUrl }
  let savedGroups = []; // saved tab groups, at the bar's left end (main/groups-service.js)

  // ---- the tree, as the main process sent it
  const all = () => [{ id: 'bar', title: 'Bookmarks bar', children: data.items }, data.other, data.mobile].filter(Boolean);
  function find(id, list = all(), parent = null) {
    for (const n of list) {
      if (n.id === id) return { node: n, parent };
      if (isFolder(n)) { const f = find(id, n.children, n); if (f) return f; }
    }
    return null;
  }
  const button = (id) => bar.querySelector(`[data-id="${CSS.escape(id)}"]`);

  // ---- drawing
  const wanted = () => !!data.show || !activeTab()?.url; // the new tab page shows it even when it's off
  function iconHtml(b) {
    if (isFolder(b)) return icons.folder;
    const fallback = siteFavicon(b.url);
    const src = b.favicon || fallback;
    return src ? `<img src="${esc(src)}" alt=""${b.favicon && fallback && fallback !== b.favicon ? ` data-fallback="${esc(fallback)}"` : ''}>` : icons.globe;
  }
  function itemHtml(b, i) {
    const folder = isFolder(b);
    const tip = folder ? b.title : `${b.title}\n${b.url}`;
    return `<button class="bm-item${folder ? ' bm-folder' : ''}" data-id="${esc(b.id)}" data-i="${i}" draggable="true" tabindex="-1" title="${esc(tip)}"${folder ? ' aria-haspopup="menu" aria-expanded="false"' : ''}>${iconHtml(b)}<span>${esc(b.title || b.url)}</span></button>`;
  }
  function render() {
    visible = wanted();
    bar.hidden = !visible;
    if (!visible) { reportSlot(); return; }
    const { items } = data;
    const other = data.other?.children.length ? `<button class="bm-item bm-folder" data-id="other" tabindex="-1" aria-haspopup="menu" aria-expanded="false" title="Other bookmarks">${icons.folder}<span>Other bookmarks</span></button>` : '';
    const end = items.length || other ? `<span class="bm-end">${other}<button id="bm-all" class="bm-item" tabindex="-1" title="All bookmarks" aria-label="All bookmarks">${icons.list}<span>All bookmarks</span></button></span>` : '';
    bar.innerHTML = savedGroupsHtml() + (items.length
      ? `<span class="bm-items">${items.map(itemHtml).join('')}<button id="bm-more" class="icon-btn small" tabindex="-1" title="More bookmarks" aria-label="More bookmarks" aria-haspopup="menu" aria-expanded="false" hidden>${icons.more}</button></span>`
      : `<span class="bm-items"><span class="bm-empty">For quick access, bookmark pages with ${isMac ? '⌘D' : 'Ctrl+D'} or the ☆ in the address bar.</span><button id="bm-import" class="bm-link" tabindex="-1">Import bookmarks…</button></span>`) + end;
    bar.querySelectorAll('.bm-item img').forEach((img) => {
      img.onerror = () => {
        if (img.dataset.fallback) { img.src = img.dataset.fallback; delete img.dataset.fallback; return; }
        img.outerHTML = icons.globe;
      };
    });
    fit();
    roving();
    reportSlot();
    // An open menu follows the change (or closes if its folder is gone).
    if (menu && overlay.kind() === 'bm-menu') { if (menuButton(menu.id)) openMenu(menu.id, { keep: true }); else closeMenu(); }
  }
  function savedGroupsHtml() {
    if (!savedGroups.length) return '';
    return `<span class="bm-groups" role="group" aria-label="Saved tab groups">${savedGroups.map((g) => {
      const name = g.title || `${g.count} tab${g.count === 1 ? '' : 's'}`;
      return `<button class="bm-item bm-sg${g.open ? ' open' : ''}" data-sg="${esc(g.id)}" tabindex="-1" style="--gc: var(--group-${esc(g.color)})" title="${esc(name)} · ${g.open ? 'open' : 'saved'} tab group" aria-label="${esc(name)}, saved tab group${g.open ? ', open' : ''}"><i class="sg-dot"></i><span>${esc(name)}</span></button>`;
    }).join('')}</span>`;
  }
  // Hide what doesn't fit and list it under the » button.
  function fit() {
    const more = bar.querySelector('#bm-more');
    if (!more) return;
    const els = [...bar.querySelectorAll('.bm-items .bm-item')];
    els.forEach((el) => { el.hidden = false; });
    more.hidden = true;
    const box = bar.querySelector('.bm-items').getBoundingClientRect();
    const limit = box.right - 2;
    if (!els.length || els[els.length - 1].getBoundingClientRect().right <= limit) return;
    more.hidden = false;
    const room = limit - 30;
    els.forEach((el) => { if (el.getBoundingClientRect().right > room) el.hidden = true; });
  }
  // Only a new width changes what fits (not the bar sliding open or shut).
  let width = 0;
  new ResizeObserver(([e]) => { if (e.contentRect.width === width) return; width = e.contentRect.width; fit(); roving(); }).observe(bar);
  const hiddenItems = () => [...bar.querySelectorAll('.bm-items .bm-item[hidden]')].map((el) => data.items[+el.dataset.i]).filter(Boolean);

  // ---- keys: the bar is one stop for Tab; the arrows move along it.
  const stops = () => [...bar.querySelectorAll('.bm-item:not([hidden]), #bm-more:not([hidden]), #bm-import')];
  function roving() {
    const list = stops();
    if (!list.length) return;
    if (!list.some((el) => el.tabIndex === 0)) list[0].tabIndex = 0;
  }
  bar.addEventListener('focusin', (e) => {
    const el = e.target.closest('.bm-item, #bm-more, #bm-import');
    if (!el) return;
    for (const x of stops()) x.tabIndex = x === el ? 0 : -1;
  });
  bar.addEventListener('keydown', (e) => {
    const list = stops();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (j) => { e.preventDefault(); list[(j + list.length) % list.length].focus(); };
    if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && list[i].matches('.bm-folder, #bm-more')) {
      e.preventDefault();
      openMenu(menuId(list[i]), { keyboard: true });
    }
  });

  // ---- folder menus (in the overlay)
  const menuId = (el) => (el.id === 'bm-more' ? 'overflow' : el.dataset.id);
  const menuButton = (id) => (id === 'overflow' ? bar.querySelector('#bm-more:not([hidden])') : bar.querySelector(`.bm-folder[data-id="${CSS.escape(id)}"]:not([hidden])`));
  function menuFolder(id) {
    if (id === 'overflow') {
      const list = hiddenItems();
      // Moves and drops in this menu land on the bar, after what's showing.
      return { id: 'overflow', title: 'More bookmarks', children: list, dropParent: 'bar', offset: data.items.length - list.length };
    }
    return find(id)?.node || null;
  }
  // keep: redraw the open menu with new contents (it keeps its submenus).
  function openMenu(id, { keyboard = false, drag = false, keep = false } = {}) {
    const el = menuButton(id);
    const folder = menuFolder(id);
    if (!el || !folder) return;
    bar.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    el.setAttribute('aria-expanded', 'true');
    if (!keep) menu = { id, keyboard, drag };
    const r = el.getBoundingClientRect();
    const top = Math.round(bar.getBoundingClientRect().bottom);
    overlay.show('bm-menu', { x: 0, y: top, width: window.innerWidth, height: window.innerHeight - top }, {
      kind: 'bm-menu', folder, anchor: { left: r.left, right: r.right }, keyboard: keyboard && !keep, keep, accent: accent(),
    });
    if (keyboard && !keep) api.send('bookmarks:overlay-focus');
  }
  function closeMenu() {
    if (overlay.kind() === 'bm-menu') overlay.hide('bm-menu');
    bar.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    menu = null;
  }
  // The neighbor folder on the bar (← and → at the top of a menu, like Windows menus).
  function adjacentMenu(from, step) {
    const list = [...bar.querySelectorAll('.bm-folder:not([hidden]), #bm-more:not([hidden])')];
    const i = list.findIndex((el) => menuId(el) === from);
    return list.length > 1 && i >= 0 ? menuId(list[(i + step + list.length) % list.length]) : null;
  }

  // ---- clicks
  bar.addEventListener('click', (e) => {
    const sg = e.target.closest('.bm-sg');
    if (sg) { api.send('groups:open-saved', sg.dataset.sg); return; }
    if (e.target.closest('#bm-import')) { api.send('bookmarks:open', { url: 'lumio://settings/#import', disposition: 'tab' }); return; }
    if (e.target.closest('#bm-all')) { api.send('bookmarks:all'); return; }
    const opener = e.target.closest('.bm-folder, #bm-more');
    if (opener) {
      const id = menuId(opener);
      if (menu?.id === id && overlay.kind() === 'bm-menu') closeMenu(); else openMenu(id, { keyboard: e.detail === 0 });
      return;
    }
    const el = e.target.closest('.bm-item[data-id]');
    if (!el) return;
    api.send('bookmarks:open', { id: el.dataset.id, disposition: modKey(e) ? (e.shiftKey ? 'tab' : 'background') : e.shiftKey ? 'window' : 'current' });
  });
  // Middle click: a bookmark in a background tab, a folder's pages in tabs.
  bar.addEventListener('auxclick', (e) => {
    const el = e.target.closest('.bm-item[data-id]');
    if (el && e.button === 1) api.send('bookmarks:open', { id: el.dataset.id, disposition: 'background' });
  });
  // Moving along the bar with a menu open switches to that folder's menu.
  bar.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.bm-folder, #bm-more');
    if (el && menu && !menu.drag && overlay.kind() === 'bm-menu' && menuId(el) !== menu.id) openMenu(menuId(el));
  });
  // On a bookmark or folder: open, edit, delete…; on the bar itself: bookmark this tab, add a folder, the manager.
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sg = e.target.closest('.bm-sg');
    if (sg) { api.send('groups:saved-context', sg.dataset.sg); return; }
    const el = e.target.closest('.bm-item[data-id]');
    api.send('bookmarks:context', el ? el.dataset.id : null);
  });
  window.addEventListener('mousedown', (e) => {
    if (overlay.kind() === 'bm-menu' && !e.target.closest('.bm-folder, #bm-more')) closeMenu();
    if (overlay.kind() === 'bm-edit' && !e.target.closest('#star')) overlay.hide('bm-edit');
  });

  // ---- drag and drop
  let dragId = null; // a drag that started on the bar
  let hover = null; // { el, timer }: a folder a drag is held over
  const dragIds = (dt) => { try { return JSON.parse(dt.getData(MIME)).ids || []; } catch { return dragId ? [dragId] : []; } };
  const ours = (dt) => dragId != null || dt.types.includes(MIME);
  const droppedLink = (dt) => {
    const url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || '';
    let title = '';
    try { title = new DOMParser().parseFromString(dt.getData('text/html') || '', 'text/html').querySelector('a')?.textContent.trim() || ''; } catch {}
    return { url: url.trim(), title };
  };
  // Where a drop at x lands: inside a folder (its middle half), or before an item on the bar.
  function dropTarget(x, y) {
    const end = document.elementFromPoint(x, y)?.closest('.bm-end .bm-folder');
    if (end) return { into: end, parentId: end.dataset.id };
    const els = [...bar.querySelectorAll('.bm-items .bm-item:not([hidden])')];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (x >= r.right) continue;
      if (el.classList.contains('bm-folder') && el.dataset.id !== dragId && x > r.left + r.width / 4 && x < r.right - r.width / 4) return { into: el, parentId: el.dataset.id };
      return { before: el, parentId: 'bar', index: +el.dataset.i };
    }
    const last = els[els.length - 1];
    return { after: last, parentId: 'bar', index: last ? +last.dataset.i + 1 : 0 };
  }
  function mark(t) {
    bar.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((it) => it.classList.remove('drop-before', 'drop-after', 'drop-into'));
    t?.before?.classList.add('drop-before');
    t?.after?.classList.add('drop-after');
    t?.into?.classList.add('drop-into');
    // Held over a folder: it opens, to drop in place inside.
    const el = t?.into || null;
    if (hover?.el === el) return;
    clearTimeout(hover?.timer);
    hover = el ? { el, timer: setTimeout(() => openMenu(el.dataset.id, { drag: true }), OPEN_DELAY) } : null;
  }
  bar.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.bm-item[data-id]');
    if (!el) return;
    dragId = el.dataset.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(MIME, JSON.stringify({ ids: [dragId] }));
    const b = find(dragId)?.node;
    if (b?.url) { e.dataTransfer.setData('text/uri-list', b.url); e.dataTransfer.setData('text/plain', b.url); }
  });
  bar.addEventListener('dragover', (e) => {
    if (!ours(e.dataTransfer) && !e.dataTransfer.types.includes('text/uri-list')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = ours(e.dataTransfer) ? 'move' : 'copy';
    mark(dropTarget(e.clientX, e.clientY));
  });
  bar.addEventListener('dragleave', (e) => { if (!bar.contains(e.relatedTarget)) mark(null); });
  bar.addEventListener('drop', (e) => {
    if (!ours(e.dataTransfer) && !e.dataTransfer.types.includes('text/uri-list')) return;
    e.preventDefault();
    const t = dropTarget(e.clientX, e.clientY);
    mark(null);
    if (ours(e.dataTransfer)) {
      const list = dragIds(e.dataTransfer);
      if (list.length) api.send('bookmarks:move', { ids: list, parentId: t.parentId, index: t.index ?? null });
    } else {
      const { url, title } = droppedLink(e.dataTransfer);
      if (/^(https?|file):/i.test(url)) api.send('bookmarks:add', { url, title, parentId: t.parentId, index: t.index ?? null });
    }
    if (menu?.drag) closeMenu();
  });
  bar.addEventListener('dragend', () => {
    dragId = null;
    mark(null);
    bar.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    if (menu?.drag) closeMenu();
  });

  // ---- the star's bubble
  // Where it points: the bookmark or folder on the bar it's about, else the star.
  function anchorRect(anchor) {
    const onBar = anchor && visible && button(anchor);
    const el = onBar && !onBar.hidden ? onBar : document.getElementById('star');
    const r = (el && !el.hidden ? el : document.getElementById('omnibox')).getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom, align: el === onBar ? 'left' : 'right' };
  }
  function openBubble({ id, heading, anchor, refresh, reading }) {
    const found = find(id);
    if (!found) return;
    if (refresh && (!bubble || bubble.id !== id || overlay.kind() !== 'bm-edit')) return;
    const { node, parent } = found;
    const rect = refresh ? bubble.rect : anchorRect(anchor);
    bubble = { id, heading: heading ?? bubble?.heading, rect, editUrl: refresh ? bubble.editUrl : !!anchor, reading: refresh ? bubble.reading : !!reading };
    // A folder can't go inside itself.
    const inside = new Set();
    if (isFolder(node)) (function walk(n) { inside.add(n.id); n.children.forEach((c) => isFolder(c) && walk(c)); })(node);
    const top = Math.round(rect.bottom + 4);
    overlay.show('bm-edit', { x: 0, y: top, width: window.innerWidth, height: window.innerHeight - top }, {
      kind: 'bm-edit',
      node: { id: node.id, title: node.title, url: node.url || null, folder: isFolder(node) },
      parentId: parent?.id || 'bar',
      heading: bubble.heading,
      editUrl: bubble.editUrl && !isFolder(node),
      reading: bubble.reading && !isFolder(node), // the star's bubble also offers the reading list
      folders: data.folders.filter((f) => !inside.has(f.id)),
      recent: data.recent.filter((f) => !inside.has(f)),
      anchor: { left: rect.left, right: rect.right, align: rect.align },
      refresh: !!refresh,
      accent: accent(),
    });
    if (!refresh) api.send('bookmarks:overlay-focus');
  }
  // The star again while its bubble is open: just closes it.
  let starWasOpen = false;
  window.addEventListener('mousedown', (e) => { if (e.target.closest('#star')) starWasOpen = overlay.kind() === 'bm-edit'; }, true);
  window.addEventListener('click', (e) => {
    if (!e.target.closest('#star') || !starWasOpen) return;
    starWasOpen = false;
    e.stopImmediatePropagation();
    overlay.hide('bm-edit');
  }, true);

  api.on('overlay-picked', (msg) => {
    if (msg.kind === 'bm-edit') { overlay.closed('bm-edit'); bubble = null; return; }
    if (msg.kind !== 'bm-menu') return;
    overlay.closed('bm-menu');
    const from = menu?.id;
    closeMenu();
    const next = msg.move && from ? adjacentMenu(from, msg.move) : null;
    if (next) { openMenu(next, { keyboard: true }); return; }
    if (msg.refocus === 'shell' && from) menuButton(from)?.focus();
  });
  // Switching tabs closes the overlay (main/window.js): forget what was open.
  let activeId = null;
  api.on('tabs', (s) => {
    if (s.activeId === activeId) return;
    activeId = s.activeId;
    for (const k of ['bm-menu', 'bm-edit']) if (overlay.kind() === k) overlay.closed(k);
    if (menu) closeMenu();
    bubble = null;
  });

  api.on('saved-groups', (list) => { savedGroups = Array.isArray(list) ? list : []; if (visible != null) render(); });
  api.on('bookmarks', (b) => {
    data = b;
    render();
    if (b.bubble) openBubble(b.bubble);
  });

  return {
    set(b, groups = []) { data = b; savedGroups = groups; },
    render,
    // The active tab changed: the new tab page shows the bar even when it's off.
    onTabs() { if (wanted() !== visible) render(); },
  };
}
