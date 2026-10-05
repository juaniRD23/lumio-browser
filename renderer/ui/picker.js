// "Who's using Lumio?" (main/picker.js): open a profile, add one, delete
// one (never the first), Guest mode, and whether this shows at launch.
// Keyboard: arrows move between profiles, Enter opens, Delete deletes,
// Shift+F10 or the context-menu key opens a profile's menu, Esc backs out.
import { icons, markSvg, avatarHtml } from './icons.js';

const api = window.lumio;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The avatar colors offered for a profile (main/profiles.js), pastels in light and dark.
const COLORS = ['#86b7ff', '#b58cff', '#7ee2a8', '#ffb86b', '#ff8fc7', '#ff7a7a', '#ffd479', '#e4e4e7'];
const COLOR_NAMES = ['Blue', 'Purple', 'Green', 'Orange', 'Pink', 'Red', 'Yellow', 'Gray'];

let state = { profiles: [], showPicker: true };
let menuFor = null; // the profile whose ⋯ menu is open
let deleting = null;
let addColor = COLORS[1];

$('.brand .mark').innerHTML = markSvg(28, true);
$('#guest .ic').innerHTML = icons.person;

// ---------------------------------------------------------------- the list
function render() {
  const list = $('#profiles');
  const focused = document.activeElement?.closest('.card')?.dataset.id;
  list.innerHTML = state.profiles.map((p, i) => `
    <div class="item" role="listitem" style="--i:${i}">
      <button class="card" type="button" data-id="${esc(p.id)}" aria-label="Open ${esc(p.name)}${p.email ? `, ${esc(p.email)}` : ''}">
        ${avatarHtml({ profile: p, size: 76 })}
        <span class="name">${esc(p.name)}</span>
        <span class="email">${esc(p.email || 'Not signed in')}</span>
      </button>
      <button class="more" type="button" data-more="${esc(p.id)}" aria-label="More for ${esc(p.name)}" aria-haspopup="menu" aria-expanded="false">${icons.dots}</button>
    </div>`).join('') + `
    <div class="item" role="listitem" style="--i:${state.profiles.length}">
      <button class="card add" type="button" id="add-card" aria-label="Add a profile"><span class="plus">${icons.plus}</span><span class="name">Add</span><span class="email">&nbsp;</span></button>
    </div>`;
  $('#show-picker').checked = !!state.showPicker;
  if (focused) list.querySelector(`.card[data-id="${CSS.escape(focused)}"]`)?.focus();
}

const cards = () => [...document.querySelectorAll('#profiles .card')];
$('#profiles').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) { openMenu(more); return; }
  const card = e.target.closest('.card');
  if (!card) return;
  if (card.id === 'add-card') showAdd(true);
  else open(card.dataset.id);
});
$('#profiles').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const all = cards();
  const i = all.indexOf(card);
  // How many cards fit on a row, for up and down.
  const perRow = Math.max(1, Math.round($('#profiles').clientWidth / card.parentElement.getBoundingClientRect().width));
  const go = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow, Home: -i, End: all.length - 1 - i }[e.key];
  if (go != null) {
    e.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, i + go))].focus();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && card.dataset.id) {
    e.preventDefault();
    askDelete(card.dataset.id);
  } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
    e.preventDefault();
    const more = card.parentElement.querySelector('[data-more]');
    if (more) openMenu(more);
  }
});

function open(id) {
  document.body.classList.add('opening');
  api.send('profiles:open', id);
}

// ---------------------------------------------------------------- ⋯ menu
const menu = $('#menu');
function openMenu(button) {
  const p = state.profiles.find((x) => x.id === button.dataset.more);
  if (!p) return;
  closeMenu();
  menuFor = { id: p.id, button };
  button.setAttribute('aria-expanded', 'true');
  menu.querySelector('[data-act=delete]').hidden = p.isDefault; // the first profile holds the app's settings
  const r = button.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.querySelector('button:not([hidden])').focus();
}
function closeMenu(refocus = false) {
  if (!menuFor) return;
  menuFor.button.setAttribute('aria-expanded', 'false');
  if (refocus) menuFor.button.focus();
  menuFor = null;
  menu.hidden = true;
}
menu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !menuFor) return;
  const { id } = menuFor;
  closeMenu();
  if (act === 'edit') api.send('profiles:edit', id);
  else if (act === 'delete') askDelete(id);
});
menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('button:not([hidden])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
});
document.addEventListener('mousedown', (e) => { if (menuFor && !e.target.closest('#menu, [data-more]')) closeMenu(); });

// ---------------------------------------------------------------- deleting
function askDelete(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p || p.isDefault) return;
  deleting = id;
  $('#confirm-title').textContent = `Delete “${p.name}”?`;
  $('#confirm').hidden = false;
  $('#confirm-cancel').focus();
}
function closeConfirm() {
  const id = deleting;
  deleting = null;
  $('#confirm').hidden = true;
  document.querySelector(`.card[data-id="${CSS.escape(id || '')}"]`)?.focus();
}
$('#confirm-cancel').addEventListener('click', closeConfirm);
$('#confirm-delete').addEventListener('click', () => {
  if (!deleting) return;
  api.send('profiles:remove', deleting);
  state.profiles = state.profiles.filter((p) => p.id !== deleting);
  deleting = null;
  $('#confirm').hidden = true;
  render();
  cards()[0]?.focus();
});
$('#confirm').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
  // Keep the keyboard inside the dialog.
  if (e.key === 'Tab') {
    const btns = [$('#confirm-cancel'), $('#confirm-delete')];
    const i = btns.indexOf(document.activeElement);
    e.preventDefault();
    btns[(i + (e.shiftKey ? -1 : 1) + 2) % 2].focus();
  }
});

// ---------------------------------------------------------------- adding
function renderAdd() {
  $('#add-preview').innerHTML = avatarHtml({ profile: { name: $('#add-name').value.trim(), color: addColor }, size: 84 });
  $('#add-colors').innerHTML = COLORS.map((c, i) => `<button type="button" class="swatch" role="radio" aria-checked="${c === addColor}" tabindex="${c === addColor ? 0 : -1}" aria-label="${COLOR_NAMES[i]}" data-color="${c}" style="background:${c}"></button>`).join('');
}
function showAdd(on) {
  $('#pick').hidden = on;
  $('#add').hidden = !on;
  if (on) {
    $('#add-name').value = '';
    // The first color no profile uses yet.
    addColor = COLORS.find((c) => !state.profiles.some((p) => p.color === c)) || COLORS[0];
    renderAdd();
    $('#add-name').focus();
  } else {
    if (location.hash) history.replaceState(null, '', location.pathname);
    $('#add-card')?.focus();
  }
}
$('#add-name').addEventListener('input', renderAdd);
$('#add-colors').addEventListener('click', (e) => {
  const c = e.target.closest('[data-color]')?.dataset.color;
  if (!c) return;
  addColor = c;
  renderAdd();
  $(`#add-colors [data-color="${c}"]`).focus();
});
$('#add-colors').addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  addColor = COLORS[(COLORS.indexOf(addColor) + step + COLORS.length) % COLORS.length];
  renderAdd();
  $(`#add-colors [data-color="${addColor}"]`).focus();
});
$('#add-cancel').addEventListener('click', () => showAdd(false));
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#add-done').disabled = true;
  document.body.classList.add('opening');
  api.send('profiles:add', { name: $('#add-name').value.trim(), color: addColor });
});
$('#add').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); showAdd(false); } });

// ---------------------------------------------------------------- the rest
$('#guest').addEventListener('click', () => { document.body.classList.add('opening'); api.send('profiles:guest'); });
$('#show-picker').addEventListener('change', (e) => api.send('profiles:show-picker', e.target.checked));

function apply(s) {
  if (!s) return;
  state = { ...state, ...s };
  document.body.classList.remove('opening');
  $('#add-done').disabled = false;
  render();
  if (s.mode === 'add' && $('#add').hidden) showAdd(true);
}
api.on('profiles-changed', apply);
apply(await api.invoke('profiles:state'));
if (location.hash === '#add') showAdd(true);
else cards()[0]?.focus();
