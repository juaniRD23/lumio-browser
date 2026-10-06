// Tab groups in the tab strip, like Chrome's: a chip with the group's name
// and color before its tabs, a line in that color under them, click the chip
// to collapse or expand the group, right-click it (or press the context menu
// key) for the group editor (drawn in the overlay by overlay-groups.js), and
// drag the chip to move the whole group. The groups themselves live in the
// main process (main/tab-groups.js); shell.js asks this module where the
// chips go when it draws the tabs.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tabsLabel = (n) => `${n} tab${n === 1 ? '' : 's'}`;

// overlay: { kind(), show(kind, rect, payload), hide(kind), closed(kind) }.
export function initTabGroups({ api, tabsEl, getState, accent, overlay }) {
  const chips = new Map(); // group id -> chip element
  let groups = new Map(); // group id -> { id, title, color, collapsed, savedId, count }
  let editing = null; // the group whose editor is open

  function chipFor(g) {
    let el = chips.get(g.id);
    if (!el) {
      el = document.createElement('button');
      el.className = 'tab-group-chip';
      el.type = 'button';
      el.dataset.group = g.id;
      el.innerHTML = '<span class="tg-name"></span>';
      el.addEventListener('pointerdown', (e) => startDrag(e, el, g.id));
      el.addEventListener('click', (e) => { if (!el.dataset.dragged) toggle(g.id); delete el.dataset.dragged; e.stopPropagation(); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); openEditor(g.id); });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openEditor(g.id, { keyboard: true }); }
      });
      chips.set(g.id, el);
    }
    el.style.setProperty('--gc', `var(--group-${g.color})`);
    el.classList.toggle('ink-dark', g.color === 'yellow' || g.color === 'orange');
    el.classList.toggle('collapsed', !!g.collapsed);
    el.classList.toggle('untitled', !g.title);
    el.classList.toggle('saved', !!g.savedId);
    el.querySelector('.tg-name').textContent = g.title;
    const name = g.title || 'Unnamed group';
    el.setAttribute('aria-label', `${name}, ${tabsLabel(g.count)}, ${g.collapsed ? 'collapsed' : 'expanded'}`);
    el.setAttribute('aria-expanded', String(!g.collapsed));
    el.title = `${name} · ${tabsLabel(g.count)}\nClick to ${g.collapsed ? 'expand' : 'collapse'} · Right-click for options`;
    return el;
  }

  function toggle(id) {
    const g = groups.get(id);
    if (g) api.send('groups:update', { id, collapsed: !g.collapsed });
  }

  // shell.js: the strip's elements in order (chips before their groups' tabs),
  // and each tab's group look. tabEls: tab id -> element.
  function layout(tabs, tabEls, groupList = []) {
    groups = new Map(groupList.map((g) => [g.id, g]));
    for (const [id, el] of chips) if (!groups.has(id)) { el.remove(); chips.delete(id); }
    const order = [];
    tabs.forEach((t, i) => {
      const g = t.groupId ? groups.get(t.groupId) : null;
      if (g && tabs[i - 1]?.groupId !== g.id) order.push(chipFor(g));
      const el = tabEls.get(t.id);
      el.classList.toggle('grouped', !!g);
      if (g) el.dataset.groupId = g.id; else delete el.dataset.groupId;
      el.classList.toggle('group-end', !!g && tabs[i + 1]?.groupId !== g.id);
      el.classList.toggle('collapsed-away', !!g?.collapsed);
      el.toggleAttribute('inert', !!g?.collapsed);
      if (g) el.style.setProperty('--gc', `var(--group-${g.color})`); else el.style.removeProperty('--gc');
      order.push(el);
    });
    // The editor follows renames and color changes made elsewhere.
    if (editing && overlay.kind() === 'tab-group') { if (groups.has(editing)) openEditor(editing, { refresh: true }); else overlay.hide('tab-group'); }
    return order;
  }

  // ---- the editor (overlay-groups.js draws it)
  function openEditor(id, { keyboard = false, refresh = false } = {}) {
    const g = groups.get(id);
    // Tabs to the side (batch 7d): the column's group row stands in for the chip.
    const shown = (el) => el && el.getBoundingClientRect().width > 0;
    const chip = [chips.get(id), document.querySelector(`.vt-group[data-group="${CSS.escape(id)}"]`)].find(shown) || chips.get(id);
    if (!g || !chip) return;
    editing = id;
    const r = chip.getBoundingClientRect();
    const top = Math.round(r.bottom + 4);
    const s = getState();
    overlay.show('tab-group', { x: 0, y: top, width: window.innerWidth, height: window.innerHeight - top }, {
      kind: 'tab-group',
      group: { id: g.id, title: g.title, color: g.color, saved: !!g.savedId, count: g.count },
      canMove: s.tabs.length > g.count,
      canSave: !s.incognito,
      anchor: { left: r.left },
      refresh,
      accent: accent(),
    });
    if (!refresh || keyboard) api.send('groups:overlay-focus');
  }
  api.on('tab-group-edit', ({ id } = {}) => openEditor(id));
  document.addEventListener('lumio-group-edit', (e) => openEditor(e.detail));
  api.on('overlay-picked', (msg) => {
    if (msg.kind !== 'tab-group') return;
    overlay.closed('tab-group');
    const id = editing;
    editing = null;
    if (msg.refocus) chips.get(id)?.focus();
  });
  window.addEventListener('mousedown', (e) => {
    if (overlay.kind() === 'tab-group' && !e.target.closest('.tab-group-chip')) overlay.hide('tab-group');
  });
  // Switching tabs closes the overlay (main/window.js).
  let activeId = null;
  api.on('tabs', (s) => {
    if (s.activeId === activeId) return;
    activeId = s.activeId;
    if (overlay.kind() === 'tab-group') overlay.closed('tab-group');
    editing = null;
  });

  // ---- dragging a chip moves the whole group
  function startDrag(e, chip, id) {
    if (e.button !== 0) return;
    const members = [...tabsEl.querySelectorAll('.tab.grouped')].filter((el) => el.dataset.groupId === id);
    const block = [chip, ...members.filter((el) => !el.classList.contains('collapsed-away'))];
    // What it can go between: other groups (as one piece) and ungrouped tabs, never pinned ones.
    const units = [];
    for (const t of getState().tabs) {
      if (t.pinned || t.groupId === id) continue;
      const el = tabsEl.querySelector(`.tab[data-id="${t.id}"]`);
      const last = units[units.length - 1];
      if (t.groupId && last?.group === t.groupId) { if (!el.classList.contains('collapsed-away')) last.els.push(el); continue; }
      if (t.groupId) {
        const els = [chips.get(t.groupId), el].filter((x) => x && !x.classList.contains('collapsed-away'));
        units.push({ group: t.groupId, els, first: t.id });
      } else units.push({ els: [el], first: t.id });
    }
    const rectOf = (els) => { const a = els[0].getBoundingClientRect(); const b = els[els.length - 1].getBoundingClientRect(); return { left: a.left, right: b.right }; };
    const home = rectOf(block);
    const rects = units.map((u) => rectOf(u.els));
    const startX = e.clientX;
    let dragging = false;
    let target = null;
    chip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < 5) return;
      dragging = true;
      chip.dataset.dragged = '1';
      block.forEach((el) => { el.classList.add('dragging-group'); el.style.transform = `translateX(${dx}px)`; });
      const center = (home.left + home.right) / 2 + dx;
      // Before the first unit whose middle is right of the block's middle.
      const i = rects.findIndex((r) => (r.left + r.right) / 2 > center);
      target = i < 0 ? { before: null } : { before: units[i].first };
    };
    const up = () => {
      chip.removeEventListener('pointermove', move);
      chip.removeEventListener('pointerup', up);
      chip.removeEventListener('pointercancel', up);
      block.forEach((el) => { el.style.transform = ''; el.classList.remove('dragging-group'); });
      if (dragging && target) api.send('groups:move', { id, before: target.before });
    };
    chip.addEventListener('pointermove', move);
    chip.addEventListener('pointerup', up);
    chip.addEventListener('pointercancel', up);
  }
  return { layout, openEditor };
}
