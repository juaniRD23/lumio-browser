// Autofill drawn above the page (main/autofill.js decides what's in them):
//  - 'formfill': the dropdown under a form field, with saved addresses,
//    cards or earlier entries. The field keeps the keyboard focus; its arrow
//    keys move the highlight here, so this only handles the mouse.
//  - 'formsave': "Save address?" / "Save card?" after a form is sent. It
//    takes the focus, so Tab, Enter and Esc work.
import { icons } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  address: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'),
  card: svg('<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3 10h18M7 15h3"/>'),
  history: icons.clock,
};

export const KINDS = new Set(['formfill', 'formsave']);
let api = null;

export function render(kind, payload, card, bridge) {
  api = bridge;
  delete card.dataset.prompt;
  if (kind === 'formfill') renderFill(payload, card);
  else renderSave(payload, card);
}

function renderFill({ items = [], selected = -1, footer, mode }, card) {
  const rows = items.map((it, i) => `
    <div class="ff-row ${it.sub ? '' : 'one'} ${i === selected ? 'sel' : ''}" role="option" aria-selected="${i === selected}" data-i="${i}">
      <span class="ic">${ICONS[it.type] || ICONS.history}</span>
      <span class="ff-main"><span class="ff-label">${esc(it.label)}</span>${it.sub ? `<span class="ff-sub">${esc(it.sub)}</span>` : ''}</span>
      ${it.removable ? `<button class="ff-x" data-x="${i}" title="Remove (Shift+Delete)" aria-label="Remove ${esc(it.label)}">${icons.x}</button>` : ''}
    </div>`).join('');
  const label = mode === 'card' ? 'Saved cards' : mode === 'address' ? 'Saved addresses' : 'Earlier entries';
  card.innerHTML = `<div class="ff" role="listbox" aria-label="${label}">${rows}</div>${footer ? `<button class="ff-foot" data-manage="${mode === 'card' ? 'cards' : 'addresses'}">${esc(footer)}</button>` : ''}`;
  card.querySelector('.ff-row.sel')?.scrollIntoView({ block: 'nearest' });
}

function renderSave({ prompt: p }, card) {
  const update = p.action === 'update';
  const title = `${update ? 'Update' : 'Save'} ${p.what === 'card' ? 'card' : 'address'}?`;
  card.innerHTML = `
    <div class="fs" role="dialog" aria-labelledby="fs-title" aria-describedby="fs-note">
      <div class="pk-head">${ICONS[p.what] || ''}<span>${esc(p.host)}</span></div>
      <div class="fs-title" id="fs-title">${title}</div>
      <div class="fs-box">${p.lines.map((l, i) => `<div class="${i ? '' : 'fs-first'}">${esc(l)}</div>`).join('')}</div>
      <p class="fs-note" id="fs-note">${esc(p.note)}</p>
      <div class="pws-actions">
        ${update ? '' : '<button class="acc-btn ghost" data-fs="never">Never for this site</button>'}
        <span style="flex:1"></span>
        <button class="acc-btn ghost" data-fs="dismiss">Not now</button>
        <button class="acc-btn primary" data-fs="save">${update ? 'Update' : 'Save'}</button>
      </div>
    </div>`;
  card.dataset.prompt = String(p.id);
  card.querySelector('[data-fs=save]').focus({ preventScroll: true });
  measure(card);
}

// The bubble asks for the height it really needs.
function measure(card) {
  requestAnimationFrame(() => {
    card.style.height = 'auto';
    const h = card.getBoundingClientRect().height;
    card.style.height = '';
    api.send('overlay:size', { height: Math.ceil(h) + 2 + 22 });
  });
}

function decide(card, decision) {
  api.send('autofill:decide', { id: Number(card.dataset.prompt), decision });
}

// Mouse in the dropdown. Answers true when it handled the event.
export function mousedown(kind, e, card) {
  if (kind === 'formsave') return true; // buttons work on click, so keys work too
  e.preventDefault(); // keep the focus in the page's field
  const x = e.target.closest('[data-x]');
  if (x) { api.send('autofill:remove', { index: Number(x.dataset.x) }); return true; }
  const row = e.target.closest('[data-i]');
  if (row) api.send('autofill:pick', { index: Number(row.dataset.i) });
  else if (e.target.closest('[data-manage]')) api.send('autofill:manage', card.querySelector('[data-manage]').dataset.manage);
  return true;
}

export function click(kind, e, card) {
  if (kind !== 'formsave') return;
  const btn = e.target.closest('[data-fs]');
  if (btn) decide(card, btn.dataset.fs);
}

export function keydown(kind, e, card) {
  if (kind === 'formsave' && e.key === 'Escape') { e.preventDefault(); decide(card, 'dismiss'); }
}
