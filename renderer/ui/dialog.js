// A page's dialog in its tab: alert/confirm/prompt, "Leave site?", HTTP
// sign-in, "Page unresponsive" (main/dialog-view.js shows this view over the
// page). Keyboard: Enter is the main button, Esc cancels, Tab stays inside.
// Messages come from websites, so everything is set as text, never as HTML.
import { icons } from './icons.js';

const api = window.lumio;
const $ = (s) => document.querySelector(s);
const card = $('#card');
// "Open <App>?" ignores Open for a moment after it appears, so a double-click
// a page set up under where it shows can't open the app, like Chrome.
const GUARD_MS = 500;
let spec = null;
let shownAt = 0;
let lastFocus = null;

function line(el, text) {
  el.hidden = !text;
  el.replaceChildren();
  if (!text) return;
  el.insertAdjacentHTML('afterbegin', icons.warn); // our own icon; the text goes in as text
  el.append(document.createTextNode(text));
}

function render(d) {
  spec = d;
  shownAt = performance.now();
  card.hidden = !d;
  if (!d) { $('#d-fields').replaceChildren(); return; } // a typed password doesn't linger
  $('#d-title').textContent = d.title || '';
  $('#d-message').textContent = d.message || '';
  line($('#d-note'), d.note);
  line($('#d-error'), d.error);

  const fields = $('#d-fields');
  fields.replaceChildren(...(d.fields || []).map((f) => {
    const label = document.createElement('label');
    label.className = 'field';
    const input = document.createElement('input');
    input.type = f.type === 'password' ? 'password' : 'text';
    input.name = f.name;
    input.value = f.value || '';
    input.spellcheck = false;
    input.autocomplete = f.autocomplete || 'off';
    if (f.label) label.append(Object.assign(document.createElement('span'), { textContent: f.label }));
    else input.setAttribute('aria-labelledby', 'd-message'); // prompt(): the question is its label
    label.append(input);
    return label;
  }));

  const check = $('#d-check');
  check.hidden = !d.checkbox;
  check.querySelector('input').checked = false;
  check.querySelector('span').textContent = d.checkbox?.label || '';

  // The main button goes last (on the right), like the browser's other prompts.
  const buttons = [...(d.buttons || [])].sort((a, b) => !!a.primary - !!b.primary);
  $('#d-buttons').replaceChildren(...buttons.map((b) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = b.label;
    el.dataset.id = b.id;
    if (b.primary) el.className = 'primary';
    return el;
  }));

  // Start where you'd type: the first field (its text selected), else the main button.
  card.classList.remove('nudge');
  const first = fields.querySelector('input');
  const target = first || $('#d-buttons .primary') || $('#d-buttons button');
  target?.focus();
  if (first) first.select();
}

function answer(button) {
  if (!spec || !button) return;
  if (spec.kind === 'external' && button !== spec.cancel && performance.now() - shownAt < GUARD_MS) return;
  const values = {};
  for (const input of $('#d-fields').querySelectorAll('input')) values[input.name] = input.value;
  const checked = !$('#d-check').hidden && $('#d-check input').checked;
  for (const b of $('#d-buttons').querySelectorAll('button')) b.disabled = true; // one answer only
  api.send('dialog:answer', { id: spec.id, button, values, checked });
  spec = null;
}

const focusables = () => [...card.querySelectorAll('input, button')].filter((el) => !el.disabled && !el.closest('[hidden]'));

$('#d-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) answer(b.dataset.id);
});

document.addEventListener('keydown', (e) => {
  if (!spec || e.isComposing) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    answer(spec.cancel);
  } else if (e.key === 'Enter') {
    const b = e.target.closest?.('button');
    e.preventDefault();
    answer(b ? b.dataset.id : spec.buttons.find((x) => x.primary)?.id);
  } else if (e.key === 'Tab') {
    // Focus stays in the dialog.
    const list = focusables();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === list.length - 1 ? 0 : i + 1);
    e.preventDefault();
    list[next].focus();
  }
});

// A click on the page around the card keeps focus in the dialog.
card.addEventListener('focusin', (e) => { lastFocus = e.target; });
document.addEventListener('mousedown', (e) => {
  if (!spec || card.contains(e.target)) return;
  e.preventDefault();
  (lastFocus && card.contains(lastFocus) ? lastFocus : focusables()[0])?.focus();
  card.classList.remove('nudge');
  void card.offsetWidth; // restart the animation
  card.classList.add('nudge');
});

api.on('dialog-data', render);
