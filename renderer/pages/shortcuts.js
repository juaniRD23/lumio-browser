// Settings › Keyboard shortcuts (lumio://settings/shortcuts): Lumio's
// commands and their keys (main/shortcuts.js). Click a shortcut (or press
// Enter on it) and press new keys; Esc cancels, Backspace removes it. Keys
// another command uses ask before they move over.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let mac = /Mac/.test(navigator.platform);
let commands = [];
let recording = null; // the id whose new keys are being pressed
let note = null; // { id, kind: 'error' | 'conflict', text, accel?, replaceable? }

// Keys that aren't letters, digits or F-keys, by where they are on the keyboard.
const CODES = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backquote: '`', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Escape: 'Escape', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);

// A key press as an accelerator ('Cmd+Shift+Y'). Letters follow the
// keyboard's layout, like the menus do; the rest go by key position.
function accelOf(e, isMac = mac) {
  let key = null;
  if (/^[a-z0-9]$/i.test(e.key) && !e.altKey) key = e.key.toUpperCase();
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = 'num' + e.code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODES[e.code] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(isMac ? 'Cmd' : 'Super');
  return [...mods, key].join('+');
}

function say(text) {
  // Cleared first, so the same words are read again.
  $('#sc-status').textContent = '';
  requestAnimationFrame(() => { $('#sc-status').textContent = text; });
}

const keyText = (c) => (recording === c.id ? 'Press keys…' : c.display || 'Add shortcut');
function item(c) {
  const n = note?.id === c.id ? note : null;
  const keyLabel = `${c.label}: ${c.display || 'no shortcut'}. Press Enter to change it.`;
  const noteHtml = !n ? '' : n.kind === 'conflict'
    ? `<div class="sc-note" role="alert"><span>${esc(n.text)}</span>${n.replaceable ? `<button type="button" class="btn small primary" data-act="replace">Use for ${esc(c.label)}</button><button type="button" class="btn small" data-act="cancel">Cancel</button>` : ''}</div>`
    : `<div class="sc-note err" role="alert">${esc(n.text)}</div>`;
  return `<div class="sc-item${recording === c.id ? ' rec' : ''}" data-id="${esc(c.id)}">
      <div class="row">
        <div class="grow"><div class="title">${esc(c.label)}</div>${c.custom ? `<div class="desc">Changed. Lumio’s own: ${esc(c.defaultDisplay || 'none')}</div>` : ''}</div>
        ${c.custom ? `<button type="button" class="btn small ghost" data-act="reset" aria-label="Reset ${esc(c.label)} to ${esc(c.defaultDisplay || 'no shortcut')}">Reset</button>` : ''}
        <button type="button" class="kbd${c.display ? '' : ' none'}" data-act="edit" aria-label="${esc(keyLabel)}" aria-pressed="${recording === c.id}">${esc(keyText(c))}</button>
      </div>${noteHtml}
    </div>`;
}

function render() {
  const q = $('#sc-q').value.trim().toLowerCase();
  const groups = new Map();
  for (const c of commands) {
    if (q && !c.label.toLowerCase().includes(q) && !c.display.toLowerCase().includes(q)) continue;
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  $('#sc-list').innerHTML = [...groups].map(([group, items]) => `<h2>${esc(group)}</h2><div class="card">${items.map(item).join('')}</div>`).join('')
    || '<div class="card"><div class="row"><div class="desc">No commands match.</div></div></div>';
  $('#sc-reset-all').hidden = !commands.some((c) => c.custom);
}

const keyButton = (id) => $(`.sc-item[data-id="${CSS.escape(id)}"] [data-act=edit]`);
const labelOf = (id) => commands.find((c) => c.id === id)?.label || '';

function start(id) {
  recording = id;
  note = null;
  render();
  keyButton(id)?.focus();
  say(`Press the new keys for ${labelOf(id)}. Esc cancels.`);
}

function stop() {
  if (!recording) return;
  const id = recording;
  recording = null;
  note = null;
  render();
  keyButton(id)?.focus();
}

async function save(id, accel, replace = false) {
  const res = await page.invoke('page:shortcut-set', id, accel, replace);
  if (res?.ok) {
    commands = res.commands;
    recording = null;
    note = null;
    render();
    keyButton(id)?.focus();
    const c = commands.find((x) => x.id === id);
    say(c?.display ? `${c.label} is now ${c.display}.` : `${c?.label || 'That command'} has no shortcut now.`);
  } else if (res?.conflict) {
    const k = res.conflict;
    const who = k.label ? `${k.label}` : 'another Lumio shortcut';
    if (k.replaceable) {
      recording = null;
      note = { id, kind: 'conflict', accel, replaceable: true, text: `${k.display} is used by ${who}.` };
      render();
      $(`.sc-item[data-id="${CSS.escape(id)}"] [data-act=replace]`)?.focus();
    } else {
      note = { id, kind: 'error', text: `${k.display} is used by ${who}, which can’t change. Try other keys.` };
      render();
      keyButton(id)?.focus();
    }
  } else {
    note = { id, kind: 'error', text: res?.error || 'That didn’t work. Try other keys.' };
    render();
    keyButton(id)?.focus();
  }
}

// While recording, every key press is the new shortcut (the menus don't see it).
document.addEventListener('keydown', (e) => {
  if (!recording) return;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === 'Tab' && plain) { stop(); return; } // the keyboard moves on
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat || MODIFIERS.has(e.key)) return;
  if (e.key === 'Escape' && plain) { stop(); say('Not changed.'); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && plain) { save(recording, null); return; }
  const accel = accelOf(e);
  if (!accel) { note = { id: recording, kind: 'error', text: 'Lumio can’t use that key. Try other keys.' }; render(); keyButton(recording)?.focus(); return; }
  save(recording, accel);
}, true);

$('#sc-list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = e.target.closest('.sc-item')?.dataset.id;
  if (!act || !id) return;
  if (act === 'edit') { if (recording === id) stop(); else start(id); }
  else if (act === 'reset') {
    const res = await page.invoke('page:shortcut-reset', id);
    commands = res.commands;
    note = null;
    render();
    keyButton(id)?.focus();
    say(`${labelOf(id)} is back to Lumio’s shortcut.`);
  } else if (act === 'replace' && note?.accel) save(id, note.accel, true);
  else if (act === 'cancel') { note = null; render(); keyButton(id)?.focus(); say('Not changed.'); }
});
// Clicking anywhere else stops recording.
document.addEventListener('mousedown', (e) => { if (recording && !e.target.closest(`.sc-item[data-id="${CSS.escape(recording)}"]`)) stop(); });
document.addEventListener('keydown', (e) => {
  if (!recording && note && e.key === 'Escape') { const id = note.id; note = null; render(); keyButton(id)?.focus(); }
});

$('#sc-q').addEventListener('input', () => { recording = null; render(); });
$('#sc-reset-all').addEventListener('click', async () => {
  const res = await page.invoke('page:shortcut-reset', null);
  commands = res.commands;
  recording = null;
  note = null;
  render();
  say('All shortcuts are back to Lumio’s.');
});

const first = await page.invoke('page:shortcuts');
if (first) {
  mac = first.mac;
  commands = first.commands;
}
render();
