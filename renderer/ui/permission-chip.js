// The permission chip in the address bar, and the bubble under it.
//  - A site asks (camera, location…): the chip says so ("Use your
//    location?") and Lumio's bubble opens under it with "Allow while
//    visiting the site", "Allow this time" and "Don't allow". Clicking
//    elsewhere or Esc leaves the question in the chip; it's answered "no"
//    when the tab moves on.
//  - Quiet requests (notifications, by default) only show the chip, crossed
//    out; clicking it offers "Allow for this site".
//  - Something Lumio blocked on the page (a blocked permission, JavaScript,
//    images) shows a crossed-out icon for a moment, then just the icon.
// The bubble is drawn by the overlay (renderer/ui/overlay-site.js), because
// pages are native views that cover the window's own HTML.
import { siteIcon } from '/assets/site-icons.js';

// overlay: { show(kind, rect, payload), hide(kind), picked(), kind() } from
// shell.js, which keeps track of the one overlay a window has.
// isTyping: the person is typing in the address bar (the field can stay this
// document's activeElement while the page has the keyboard, so that alone
// doesn't say so).
// accept(request): which questions the chip takes (a pop-up window's bar
// asks the others in its permission bar, renderer/ui/permbar.js).
// anchor: the field the bubble opens under (the address bar).
export function initPermissionChip({ api, getActiveTab, overlay, isTyping = () => false, accept = () => true, anchor = 'omnibox' }) {
  const chip = document.getElementById('perm-chip');
  const live = document.getElementById('perm-live');
  const omnibox = document.getElementById(anchor);
  const pages = new Map(); // wcId -> { requests: [], blocked: Map(cat -> info) }
  const seen = new Set(); // questions whose bubble already opened by itself
  let collapseTimer = 0;
  let collapsed = false;
  let shownKey = '';

  const pageOf = (wcId) => {
    if (!pages.has(wcId)) pages.set(wcId, { requests: [], blocked: new Map() });
    return pages.get(wcId);
  };
  const active = () => { const t = getActiveTab(); return t?.wcId != null ? pageOf(t.wcId) : null; };
  const bubbleOpen = () => overlay.kind() === 'permission';

  // What the chip shows for the active tab: a question, or what was blocked.
  function current() {
    const p = active();
    if (!p) return null;
    const req = p.requests[0];
    if (req) return { mode: req.quiet ? 'quiet' : 'ask', req, key: `r${req.id}` };
    if (p.blocked.size) { const list = [...p.blocked.values()]; return { mode: 'blocked', list, key: `b${list.map((b) => b.cat).join()}` }; }
    return null;
  }

  function render() {
    const now = current();
    chip.hidden = !now;
    chip.setAttribute('aria-expanded', String(bubbleOpen()));
    if (!now) { shownKey = ''; if (bubbleOpen()) overlay.hide('permission'); return; }
    const first = now.mode === 'blocked' ? now.list[0] : null;
    const cat = now.req ? now.req.cats[0] : first;
    const text = now.mode === 'ask' ? cat.chip : now.mode === 'quiet' ? cat.blocked : now.list.length > 1 ? 'Blocked on this page' : first.label;
    chip.innerHTML = `${siteIcon(now.req ? cat.id : first.cat, { size: 15, blocked: now.mode !== 'ask' })}<span class="pc-t"></span>`;
    chip.querySelector('.pc-t').textContent = text;
    chip.setAttribute('aria-label', now.mode === 'ask' ? `${now.req.host} asks: ${now.req.cats.map((c) => c.prompt).join(', ')}` : text);
    chip.title = text;
    if (now.key !== shownKey) {
      shownKey = now.key;
      live.textContent = now.mode === 'ask' ? `${now.req.host} wants to ${now.req.cats.map((c) => c.prompt.toLowerCase()).join(' and ')}` : text;
      // A question keeps its words until it's answered; notices shrink to an icon.
      collapsed = false;
      clearTimeout(collapseTimer);
      if (now.mode !== 'ask') collapseTimer = setTimeout(() => { collapsed = true; render(); }, 6000);
    }
    chip.className = `perm-chip ${now.mode}${collapsed && !bubbleOpen() ? ' collapsed' : ''}`;
  }

  function payloadFor(now) {
    if (now.mode === 'blocked') return { mode: 'blocked', wcId: getActiveTab().wcId, host: now.list[0].host, blocked: now.list };
    const r = now.req;
    return { mode: now.mode, id: r.id, wcId: r.wcId, host: r.host, cats: r.cats, once: r.once, detail: r.detail };
  }

  // focus: opened from the keyboard or a click, so the bubble takes focus.
  function open(focus = false) {
    const now = current();
    if (!now) return;
    const r = chip.getBoundingClientRect();
    const o = omnibox.getBoundingClientRect();
    overlay.show('permission', { x: r.left - 14, y: o.bottom + 4, width: 364, height: 300 }, { kind: 'permission', focus, ...payloadFor(now) });
    if (focus) api.send('permission:focus-bubble');
    render();
  }

  // A question opens its bubble by itself once, unless something else is open
  // or the person is typing an address.
  function autoOpen() {
    const now = current();
    if (!now || now.mode !== 'ask' || seen.has(now.req.id) || overlay.kind() || isTyping()) return;
    seen.add(now.req.id);
    open(false);
  }

  chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where it is
  chip.addEventListener('click', () => {
    if (bubbleOpen()) overlay.hide('permission'); else open(true);
    render();
  });
  window.addEventListener('mousedown', (e) => { if (bubbleOpen() && !e.target.closest('#perm-chip')) { overlay.hide('permission'); render(); } });

  api.on('permission', (req) => {
    if (!accept(req)) return;
    pageOf(req.wcId).requests.push(req);
    render();
    autoOpen();
  });
  // The question went away (the tab moved on, or another answer settled it).
  api.on('permission-cancel', ({ id }) => {
    if (bubbleOpen() && current()?.req?.id === id) overlay.hide('permission');
    for (const p of pages.values()) p.requests = p.requests.filter((r) => r.id !== id);
    seen.delete(id);
    render();
  });
  api.on('permission-blocked', (info) => {
    pageOf(info.wcId).blocked.set(info.cat, info);
    render();
  });
  // The tab moved to another page.
  api.on('permission-reset', ({ wcId }) => {
    pageOf(wcId).blocked.clear();
    render();
  });
  // Esc in the bubble: the chip gets the keyboard back.
  api.on('permission-focus', () => { overlay.picked(); if (!chip.hidden) chip.focus(); render(); });
  api.on('overlay-picked', (pick) => {
    if (pick?.kind !== 'permission') return;
    overlay.picked();
    for (const p of pages.values()) {
      if (pick.id != null) p.requests = p.requests.filter((r) => r.id !== pick.id);
      if (pick.allowed) p.blocked.delete(pick.allowed);
    }
    seen.delete(pick.id);
    render();
    if (pick.keyboard) api.send('tab:focus-page');
  });

  return {
    // The tabs changed: wcIds are the pages still open.
    update(switched, wcIds) {
      for (const id of pages.keys()) if (!wcIds.includes(id)) pages.delete(id);
      if (switched && bubbleOpen()) overlay.hide('permission');
      render();
      autoOpen();
    },
  };
}
