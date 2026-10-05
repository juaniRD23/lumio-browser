// The tab group editor, drawn in the overlay above the page under the
// group's chip (renderer/ui/tab-groups.js opens it): the name, Chrome's nine
// colors, and New tab in group, Save group, Ungroup, Close group and Move
// group to new window. Changes apply as you go (main/groups-service.js).
const api = window.lumio;
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const NAMES = { grey: 'Grey', blue: 'Blue', red: 'Red', yellow: 'Yellow', green: 'Green', pink: 'Pink', purple: 'Purple', cyan: 'Cyan', orange: 'Orange' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  'new-tab': svg('<path d="M12 5v14M5 12h14"/>'),
  save: svg('<path d="M6 4h12v16l-6-4-6 4z"/>'),
  unsave: svg('<path d="M6 4h12v16l-6-4-6 4z"/><path d="M4 4l16 16"/>'),
  ungroup: svg('<rect x="3" y="6" width="7" height="12" rx="2"/><rect x="14" y="6" width="7" height="12" rx="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  'move-window': svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>'),
};

const root = document.createElement('div');
root.id = 'tg-root';
root.hidden = true;
document.body.append(root);
const card = document.getElementById('card');
let group = null; // the group being edited
let nameTimer = null;

api.on('overlay-data', (p) => {
  const mine = p.kind === 'tab-group';
  if (!mine) { if (group) flushName(); root.hidden = true; root.innerHTML = ''; group = null; return; }
  root.hidden = false;
  card.style.display = 'none';
  // Redrawn because something changed elsewhere: keep what's being typed.
  if (p.refresh && group?.id === p.group.id && root.firstElementChild) { update(p); return; }
  group = { ...p.group };
  draw(p);
});

function draw(p) {
  const g = p.group;
  const rows = [
    ['new-tab', 'New tab in group'],
    ...(p.canSave ? [[g.saved ? 'unsave' : 'save', g.saved ? 'Unsave group' : 'Save group']] : []),
    ['ungroup', 'Ungroup'],
    ['close', g.saved ? 'Close group' : 'Delete group'],
    ...(p.canMove ? [['move-window', 'Move group to new window']] : []),
  ];
  root.innerHTML = `<div class="tg-bubble" role="dialog" aria-label="Edit tab group">
    <input id="tg-name" type="text" spellcheck="false" autocomplete="off" maxlength="100" placeholder="Name this group" aria-label="Group name" value="${esc(g.title)}">
    <div class="tg-colors" role="radiogroup" aria-label="Group color">${COLORS.map((c) => `<button type="button" class="tg-color" role="radio" data-color="${c}" style="--sw: var(--group-${c})" aria-label="${NAMES[c]}" aria-checked="${c === g.color}" tabindex="${c === g.color ? 0 : -1}"></button>`).join('')}</div>
    <div class="tg-sep"></div>
    <div class="tg-actions" role="menu" aria-label="Group actions">${rows.map(([act, label]) => `<button type="button" class="tg-row" role="menuitem" data-act="${act}"><span class="ic">${ICONS[act]}</span><span>${label}</span></button>`).join('')}</div>
  </div>`;
  const el = root.firstElementChild;
  el.style.left = `${Math.max(8, Math.min(p.anchor.left - 4, window.innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = '2px';
  const name = document.getElementById('tg-name');
  name.focus();
  name.select();
}

// The same group changed elsewhere: its color and buttons follow; the name only if not being edited.
function update(p) {
  const name = document.getElementById('tg-name');
  if (document.activeElement !== name && nameTimer == null) name.value = p.group.title;
  group.color = p.group.color;
  root.querySelectorAll('.tg-color').forEach((b) => { const on = b.dataset.color === p.group.color; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
}

function flushName() {
  if (nameTimer == null || !group) return;
  clearTimeout(nameTimer);
  nameTimer = null;
  api.send('groups:update', { id: group.id, title: document.getElementById('tg-name')?.value ?? group.title });
}
const close = (refocus = true) => { flushName(); api.send('overlay:pick', { kind: 'tab-group', refocus }); };

root.addEventListener('input', (e) => {
  if (!group || e.target.id !== 'tg-name') return;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(flushName, 300);
});

function setColor(c) {
  if (!group || !COLORS.includes(c)) return;
  group.color = c;
  root.querySelectorAll('.tg-color').forEach((b) => { const on = b.dataset.color === c; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; if (on) b.focus(); });
  api.send('groups:update', { id: group.id, color: c });
}

root.addEventListener('click', (e) => {
  if (!group) return;
  const sw = e.target.closest('.tg-color');
  if (sw) { setColor(sw.dataset.color); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  flushName();
  api.send('groups:action', { id: group.id, action: act });
  close(act === 'save' || act === 'unsave');
});

// A click on the see-through part (the page under it) closes it.
root.addEventListener('mousedown', (e) => {
  if (e.target !== root) return;
  e.preventDefault();
  close(false);
});

document.addEventListener('keydown', (e) => {
  if (!group || root.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'Enter' && e.target.id === 'tg-name') { e.preventDefault(); close(); return; }
  // Arrows move between the colors, like radio buttons.
  if (e.target.closest('.tg-color') && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    const i = COLORS.indexOf(group.color);
    setColor(COLORS[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + COLORS.length) % COLORS.length]);
    return;
  }
  // Up and down move along the actions.
  if (e.target.closest('.tg-row') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const rows = [...root.querySelectorAll('.tg-row')];
    const i = rows.indexOf(e.target.closest('.tg-row'));
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
  }
});
