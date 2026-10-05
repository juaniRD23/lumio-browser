// The new tab page's shortcuts, like Chrome's (main/ntp-shortcuts.js keeps
// them): "My shortcuts" you add, edit and remove, or your most visited
// sites, or none. Each tile's ⋮ edits or removes it; every change can be
// undone from the toast. Customize (bottom right) picks which kind.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const svg = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const DOTS = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5.5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor"/></svg>';
const TOAST_MS = 10_000;

// A site's icon (its /favicon.ico), or its first letter when it has none.
export function icon(url, cls) {
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const letter = esc((host(url)[0] || '?').toUpperCase());
  return `<span class="${cls}" data-letter="${letter}"><img src="${esc(origin)}/favicon.ico" alt="" loading="lazy"></span>`;
}
export function fixIcons(root) {
  root.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => { const p = img.parentElement; img.remove(); if (p.dataset.letter) p.textContent = p.dataset.letter; });
  });
}

export async function initShortcuts({ page, incognito }) {
  const box = document.getElementById('sites');
  if (incognito) { box.hidden = true; return; }
  let state = await page.invoke('page:ntp-shortcuts').catch(() => null);
  if (!state) { box.hidden = true; return; }

  // ---- the tiles
  function render() {
    box.hidden = state.hidden;
    const items = state.items;
    const count = items.length + (state.canAdd ? 1 : 0);
    box.classList.toggle('wide', count > 8); // two rows of five, like Chrome's ten
    box.setAttribute('role', 'list');
    box.setAttribute('aria-label', state.custom ? 'My shortcuts' : 'Most visited sites');
    box.innerHTML = items.map((s, i) => {
      const name = s.title || host(s.url);
      const act = state.custom
        ? `<button type="button" class="tile-act" data-menu="${i}" aria-label="More actions for ${esc(name)}" aria-haspopup="menu" aria-expanded="false" title="More actions">${DOTS}</button>`
        : `<button type="button" class="tile-act" data-hide="${i}" aria-label="Don’t show ${esc(name)}" title="Don’t show on this page">${svg('<path d="M6 6l12 12M18 6L6 18"/>', 14)}</button>`;
      return `<div class="tile" role="listitem"><a class="site" href="${esc(s.url)}" title="${esc(name)}">${icon(s.url, 'ico')}<span class="name">${esc(name)}</span></a>${act}</div>`;
    }).join('') + (state.canAdd ? `<div class="tile" role="listitem"><button type="button" class="site add" id="sc-add">${`<span class="ico">${svg('<path d="M12 5v14M5 12h14"/>', 20)}</span>`}<span class="name">Add shortcut</span></button></div>` : '');
    fixIcons(box);
  }

  // Every change returns the new tiles (or { error }), and offers Undo.
  async function change(promise, text, { restore = false } = {}) {
    const res = await promise;
    if (!res || res.error) return res;
    state = res;
    render();
    toast(text, restore);
    return res;
  }

  // ---- the toast: what changed, Undo, and (after a removal) Restore default shortcuts
  const t = document.createElement('div');
  t.className = 'sc-toast';
  t.setAttribute('role', 'status');
  t.hidden = true;
  t.innerHTML = '<span class="sc-toast-text"></span><button type="button" class="sc-link" data-toast="undo">Undo</button><button type="button" class="sc-link" data-toast="restore">Restore default shortcuts</button>';
  document.body.append(t);
  let toastTimer = null;
  function toast(text, restore) {
    t.querySelector('.sc-toast-text').textContent = text;
    t.querySelector('[data-toast=restore]').hidden = !restore;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, TOAST_MS);
  }
  t.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-toast]')?.dataset.toast;
    if (!act) return;
    t.hidden = true;
    state = await page.invoke(act === 'undo' ? 'page:ntp-shortcuts-undo' : 'page:ntp-shortcuts-reset');
    render();
    if (act === 'restore') toast('Default shortcuts restored', false);
  });

  // ---- a tile's ⋮ menu: Edit shortcut, Remove
  const menu = document.createElement('div');
  menu.className = 'sc-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  menu.innerHTML = '<button type="button" role="menuitem" data-item="edit">Edit shortcut</button><button type="button" role="menuitem" data-item="remove">Remove</button>';
  document.body.append(menu);
  let menuFor = null; // { index, opener }
  function openMenu(index, opener) {
    menuFor = { index, opener };
    opener.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const r = opener.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + scrollX}px`;
    menu.style.top = `${r.bottom + 4 + scrollY}px`;
    menu.querySelector('button').focus();
  }
  function closeMenu(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuFor?.opener.setAttribute('aria-expanded', 'false');
    if (refocus) menuFor?.opener.focus();
    menuFor = null;
  }
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-item]')?.dataset.item;
    if (!item || !menuFor) return;
    const { index } = menuFor;
    closeMenu(item === 'remove');
    if (item === 'edit') openEditor(index);
    else change(page.invoke('page:ntp-shortcut-remove', state.items[index].url), 'Shortcut removed', { restore: true });
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.sc-menu, [data-menu]')) closeMenu(false); });

  box.addEventListener('click', (e) => {
    const m = e.target.closest('[data-menu]');
    if (m) { if (menuFor?.opener === m) closeMenu(); else { closeMenu(false); openMenu(+m.dataset.menu, m); } return; }
    const hide = e.target.closest('[data-hide]');
    if (hide) { change(page.invoke('page:ntp-shortcut-remove', state.items[+hide.dataset.hide].url), 'Shortcut removed', { restore: true }); return; }
    if (e.target.closest('#sc-add')) openEditor(null);
  });

  // ---- Add shortcut / Edit shortcut
  const editor = document.createElement('dialog');
  editor.className = 'sc-dialog';
  editor.setAttribute('aria-labelledby', 'sc-title');
  editor.innerHTML = `<form method="dialog" novalidate>
    <h2 class="sc-title" id="sc-title">Add shortcut</h2>
    <label class="sc-field"><span>Name</span><input id="sc-name" class="field" type="text" autocomplete="off" spellcheck="false" maxlength="100"></label>
    <label class="sc-field"><span>URL</span><input id="sc-url" class="field" type="text" autocomplete="off" spellcheck="false" placeholder="example.com" aria-describedby="sc-error"></label>
    <p class="sc-error" id="sc-error" role="alert"></p>
    <div class="sc-actions"><button type="button" class="btn ghost danger" id="sc-remove">Remove</button><span class="grow"></span><button type="button" class="btn" id="sc-cancel">Cancel</button><button type="submit" class="btn primary" id="sc-done">Done</button></div>
  </form>`;
  document.body.append(editor);
  const $ = (id) => editor.querySelector(`#${id}`);
  let editing = null; // the tile's index, or null for a new one
  function openEditor(index) {
    editing = index;
    const s = index == null ? null : state.items[index];
    $('sc-title').textContent = s ? 'Edit shortcut' : 'Add shortcut';
    $('sc-name').value = s?.title || '';
    $('sc-url').value = s?.url || '';
    $('sc-error').textContent = '';
    $('sc-remove').hidden = !s;
    $('sc-done').disabled = !s;
    editor.showModal();
    (s ? $('sc-name') : $('sc-url')).focus();
  }
  editor.addEventListener('input', () => { $('sc-done').disabled = !$('sc-url').value.trim(); $('sc-error').textContent = ''; });
  // Back to the tile it was about (redrawn, so the browser can't), unless the focus has moved on already.
  editor.addEventListener('close', () => {
    const at = document.activeElement;
    if (at && at !== document.body && !editor.contains(at)) return;
    (editing == null ? box.querySelector('#sc-add') : box.querySelectorAll('.site')[editing])?.focus();
  });
  $('sc-cancel').addEventListener('click', () => editor.close());
  $('sc-remove').addEventListener('click', async () => {
    const url = state.items[editing]?.url;
    editor.close();
    if (url) change(page.invoke('page:ntp-shortcut-remove', url), 'Shortcut removed', { restore: true });
  });
  editor.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await change(page.invoke('page:ntp-shortcut-save', editing, { title: $('sc-name').value, url: $('sc-url').value }), editing == null ? 'Shortcut added' : 'Shortcut edited');
    if (res?.error) { $('sc-error').textContent = res.error; $('sc-url').focus(); return; }
    editor.close();
  });

  // ---- Customize: My shortcuts or Most visited sites, and Show shortcuts
  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'sc-customize';
  custom.innerHTML = `${svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', 15)}<span>Customize</span>`;
  custom.setAttribute('aria-haspopup', 'dialog');
  document.body.append(custom);
  const panel = document.createElement('dialog');
  panel.className = 'sc-dialog';
  panel.setAttribute('aria-labelledby', 'sc-cust-title');
  panel.innerHTML = `<form method="dialog">
    <h2 class="sc-title" id="sc-cust-title">Shortcuts</h2>
    <div class="sc-choices" role="radiogroup" aria-label="Which shortcuts">
      <label class="sc-choice"><input type="radio" name="sc-mode" value="custom"><span><b>My shortcuts</b><small>Start with the sites you visit most. Add, edit or remove your own.</small></span></label>
      <label class="sc-choice"><input type="radio" name="sc-mode" value="mostVisited"><span><b>Most visited sites</b><small>Picked for you from the sites you visit most.</small></span></label>
    </div>
    <label class="sc-show"><span>Show shortcuts</span><span class="switch"><input type="checkbox" id="sc-show"><i></i></span></label>
    <div class="sc-actions"><span class="grow"></span><button type="submit" class="btn primary">Done</button></div>
  </form>`;
  document.body.append(panel);
  function syncPanel() {
    panel.querySelectorAll('[name=sc-mode]').forEach((r) => { r.checked = r.value === state.mode; r.disabled = state.hidden; });
    panel.querySelector('#sc-show').checked = !state.hidden;
  }
  custom.addEventListener('click', () => { syncPanel(); panel.showModal(); });
  panel.addEventListener('change', async (e) => {
    const opts = e.target.name === 'sc-mode' ? { mode: e.target.value } : e.target.id === 'sc-show' ? { hidden: !e.target.checked } : null;
    if (!opts) return;
    state = await page.invoke('page:ntp-shortcuts-set', opts);
    render();
    syncPanel();
  });
  panel.addEventListener('close', () => custom.focus());

  render();
}
