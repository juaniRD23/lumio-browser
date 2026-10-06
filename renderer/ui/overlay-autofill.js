// Autofill drawn above the page (main/autofill.js decides what's in them):
//  - 'formfill': the dropdown under a form field, with saved addresses,
//    cards or earlier entries. The field keeps the keyboard focus; its arrow
//    keys move the highlight here, Enter fills and Esc closes it
//    (preload/autofill.js), so this only handles the mouse.
//    Screen readers: the field is in the site's view and this list is in
//    Lumio's overlay, another view above it. Chromium's accessibility tree
//    can't link a node in one view to a node in another, so the field can't
//    get aria-expanded / aria-controls / aria-activedescendant pointing here
//    (and Lumio doesn't write into the site's own fields to fake it). The
//    best real thing: the list is a listbox of options with its active
//    option (aria-activedescendant, inside this view), and a polite live
//    region, which is read wherever the focus is, says when it opens (what
//    it offers and how to use it) and which item the arrow keys moved to.
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

// first: it was just opened (not new content for one on screen).
export function render(kind, payload, card, bridge, first = false) {
  api = bridge;
  delete card.dataset.prompt;
  if (kind === 'formfill') renderFill(payload, card, first);
  else { said = null; renderSave(payload, card); }
}

// The live region outside the card (the card is redrawn on every change,
// and a region has to stay in the page to be read), and what it last said.
let said = null; // { list: the items it announced, selected }
function liveRegion() {
  let el = document.getElementById('ff-live');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ff-live';
    el.className = 'ff-live';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.append(el);
  }
  return el;
}
// What it says: on opening (or when what it offers changed), its name, how
// many and the keys; when the highlight moves, the item and where it is.
// Saved names and addresses are the person's own: they're never translated.
export function announcement({ items = [], selected = -1, mode }, prev) {
  const list = items.map((it) => `${it.label}\n${it.sub || ''}`).join('\n\n');
  if (!prev || prev.list !== list) {
    const what = mode === 'card' ? 'Saved cards' : mode === 'address' ? 'Saved addresses' : 'Earlier entries';
    return { list, selected, text: `${what}, ${items.length}. Use the arrow keys to choose and Enter to fill.`, item: null };
  }
  if (selected === prev.selected || !items[selected]) return { list, selected, text: null, item: null };
  const it = items[selected];
  return { list, selected, text: `${selected + 1} of ${items.length}`, item: `${it.label}${it.sub ? `, ${it.sub}` : ''},` };
}
function announce(payload, first) {
  const next = announcement(payload, first ? null : said);
  said = { list: next.list, selected: next.selected };
  if (!next.text) return;
  const el = liveRegion();
  el.textContent = '';
  if (next.item) {
    const item = document.createElement('span');
    item.translate = false;
    item.textContent = next.item;
    el.append(item, ' ');
  }
  el.append(next.text);
}

function renderFill({ items = [], selected = -1, footer, mode }, card, first) {
  const rows = items.map((it, i) => `
    <div class="ff-row ${it.sub ? '' : 'one'} ${i === selected ? 'sel' : ''}" id="ff-opt-${i}" role="option" aria-selected="${i === selected}" aria-posinset="${i + 1}" aria-setsize="${items.length}" data-i="${i}">
      <span class="ic">${ICONS[it.type] || ICONS.history}</span>
      <span class="ff-main"><span class="ff-label">${esc(it.label)}</span>${it.sub ? `<span class="ff-sub">${esc(it.sub)}</span>` : ''}</span>
      ${it.removable ? `<button class="ff-x" data-x="${i}" title="Remove (Shift+Delete)" aria-label="Remove ${esc(it.label)}">${icons.x}</button>` : ''}
    </div>`).join('');
  const label = mode === 'card' ? 'Saved cards' : mode === 'address' ? 'Saved addresses' : 'Earlier entries';
  const active = selected >= 0 && selected < items.length ? ` aria-activedescendant="ff-opt-${selected}"` : '';
  card.innerHTML = `<div class="ff" id="ff-list" role="listbox" aria-label="${label}" tabindex="-1"${active}>${rows}</div>${footer ? `<button class="ff-foot" data-manage="${mode === 'card' ? 'cards' : 'addresses'}">${esc(footer)}</button>` : ''}`;
  card.querySelector('.ff-row.sel')?.scrollIntoView({ block: 'nearest' });
  announce({ items, selected, mode }, first);
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
