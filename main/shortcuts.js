// Keyboard shortcuts the person picks (lumio://settings/shortcuts).
//
// Lumio's commands are the application menu's items (main/menu.js) that
// come with a shortcut, plus any item given an `id`. settings.shortcuts maps
// a command's id to the keys chosen for it ('Cmd+Shift+Y'), or to null for
// none. apply() writes those into the menu template before it's built, so a
// new shortcut works everywhere the menu's shortcuts do, right away.
//
// A command's id is its menu label in lowercase ('Show/Hide Sidebar' is
// 'show-hide-sidebar'), so items added to the menu later can be changed too.
// Renaming an item forgets what was picked for it; nothing else breaks.

const IS_MAC = process.platform === 'darwin';

// Modifiers in the order the Mac shows them (⌃⌥⇧⌘).
const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
const MOD_NAMES = {
  cmd: 'Cmd', command: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', altgr: 'Alt', shift: 'Shift',
  cmdorctrl: 'CmdOrCtrl', commandorcontrol: 'CmdOrCtrl', super: 'Super', meta: 'Super',
};
const NAMED_KEYS = {
  plus: 'Plus', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', return: 'Enter', enter: 'Enter',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  esc: 'Escape', escape: 'Escape', num0: 'num0', num1: 'num1', num2: 'num2', num3: 'num3', num4: 'num4', num5: 'num5', num6: 'num6',
  num7: 'num7', num8: 'num8', num9: 'num9', numdec: 'numdec', numadd: 'numadd', numsub: 'numsub', nummult: 'nummult', numdiv: 'numdiv',
};
const PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);

// Shortcuts of the menu roles (Copy, Quit…), which Electron adds by itself.
// They can't be changed here, and nothing else can take them.
const ROLE_KEYS = {
  undo: ['CmdOrCtrl+Z', 'Edit › Undo'],
  redo: [IS_MAC ? 'Shift+CmdOrCtrl+Z' : 'Ctrl+Y', 'Edit › Redo'],
  cut: ['CmdOrCtrl+X', 'Edit › Cut'],
  copy: ['CmdOrCtrl+C', 'Edit › Copy'],
  paste: ['CmdOrCtrl+V', 'Edit › Paste'],
  pasteandmatchstyle: [IS_MAC ? 'Cmd+Alt+Shift+V' : 'Shift+CmdOrCtrl+V', 'Edit › Paste and Match Style'],
  selectall: ['CmdOrCtrl+A', 'Edit › Select All'],
  hide: ['Cmd+H', 'Hide Lumio Browser'],
  hideothers: ['Cmd+Alt+H', 'Hide Others'],
  quit: [IS_MAC ? 'Cmd+Q' : null, 'Quit'],
  minimize: ['CmdOrCtrl+M', 'Window › Minimize'],
  close: ['CmdOrCtrl+W', 'Close Window'],
  togglefullscreen: [IS_MAC ? 'Ctrl+Cmd+F' : 'F11', 'Full Screen'],
};

// What the computer itself uses: macOS's app switcher, Spotlight,
// screenshots…; Windows' Alt+F4, Alt+Tab…
const SYSTEM_KEYS = {
  mac: ['Cmd+Tab', 'Shift+Cmd+Tab', 'Cmd+Space', 'Ctrl+Space', 'Alt+Cmd+Space', 'Ctrl+Cmd+Space', 'Cmd+`', 'Shift+Cmd+`', 'Alt+Cmd+Escape',
    'Shift+Cmd+3', 'Shift+Cmd+4', 'Shift+Cmd+5', 'Ctrl+Cmd+Q', 'Alt+Cmd+D'],
  win: ['Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Delete', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Alt+Space', 'Alt+Escape', 'Ctrl+Alt+Tab'],
};

// 'CmdOrCtrl+Shift+t' -> { mods: ['Shift', 'Cmd'], key: 'T' } on the Mac. null if it isn't a shortcut.
function parse(accel, mac = IS_MAC) {
  if (typeof accel !== 'string' || !accel || accel.length > 60) return null;
  // '+' is a separator, except a last '+' on its own ('Cmd++').
  const parts = accel.endsWith('++') ? [...accel.slice(0, -2).split('+'), 'Plus'] : accel.split('+');
  const mods = new Set();
  let key = null;
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) return null;
    let mod = MOD_NAMES[p.toLowerCase()];
    if (mod === 'CmdOrCtrl') mod = mac ? 'Cmd' : 'Ctrl';
    if (mod === 'Super' && mac) mod = 'Cmd';
    if (mod) {
      if (key) return null; // modifiers come first
      mods.add(mod);
      continue;
    }
    if (key) return null; // one key only
    key = keyName(p);
    if (!key) return null;
  }
  if (!key) return null;
  return { mods: [...MODS, 'Super'].filter((m) => mods.has(m)), key };
}

function keyName(p) {
  if (/^[a-z0-9]$/i.test(p)) return p.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) return p.toUpperCase();
  if (PUNCTUATION.has(p)) return p;
  if (p === '+') return 'Plus';
  return NAMED_KEYS[p.toLowerCase()] || null;
}

const format = (s) => (s ? [...s.mods, s.key].join('+') : null);

// One spelling per shortcut, for this computer: 'CmdOrCtrl+T' is 'Cmd+T' on a Mac.
const normalize = (accel, mac = IS_MAC) => format(parse(accel, mac));

// How Settings shows a shortcut: ⇧⌘T on a Mac, Ctrl+Shift+T on Windows.
const MAC_SYMBOLS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
const MAC_KEYS = {
  Plus: '+', Space: 'Space', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: '⎋',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟',
};
const WIN_KEYS = { Plus: '+', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down', Super: 'Win' };
const numpad = (k) => (/^num\d$/.test(k) ? `Num ${k.slice(3)}` : { numdec: 'Num .', numadd: 'Num +', numsub: 'Num -', nummult: 'Num *', numdiv: 'Num /' }[k] || null);

function display(accel, mac = IS_MAC) {
  const s = parse(accel, mac);
  if (!s) return '';
  if (mac) return s.mods.map((m) => MAC_SYMBOLS[m] || m).join('') + (numpad(s.key) || MAC_KEYS[s.key] || s.key);
  // Windows writes Ctrl first, then Alt and Shift.
  const order = ['Ctrl', 'Super', 'Alt', 'Shift'];
  return [...order.filter((m) => s.mods.includes(m)).map((m) => WIN_KEYS[m] || m), numpad(s.key) || WIN_KEYS[s.key] || s.key].join('+');
}

// Can these keys be a Lumio shortcut? { accel } in its one spelling, or { error }.
function validate(accel, mac = IS_MAC) {
  const s = parse(accel, mac);
  if (!s) return { error: 'Lumio can’t use that key.' };
  const norm = format(s);
  if (s.mods.includes('Super')) return { error: 'Windows uses the Windows key for itself. Try Ctrl or Alt.' };
  if (SYSTEM_KEYS[mac ? 'mac' : 'win'].some((k) => normalize(k, mac) === norm)) return { error: `Your computer uses ${display(norm, mac)} for itself. Try other keys.` };
  // Function keys work on their own. Anything else needs ⌘ or ⌃ on a Mac
  // (⌥ alone types accented letters) and Ctrl or Alt on Windows, or it
  // would steal a key people type with.
  const fkey = /^F\d+$/.test(s.key);
  const strong = mac ? ['Cmd', 'Ctrl'] : ['Ctrl', 'Alt'];
  if (!fkey && !s.mods.some((m) => strong.includes(m))) {
    return { error: mac ? 'Add ⌘ or ⌃ to the keys (or use a function key, like F2).' : 'Add Ctrl or Alt to the keys (or use a function key, like F2).' };
  }
  return { accel: norm };
}

// 'Show/Hide Lumio AI' -> 'show-hide-lumio-ai'.
const slug = (label) => String(label || '').toLowerCase().replace(/…/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const idOf = (item) => item.id || slug(item.label);
const isCommand = (item) => item && !item.role && typeof item.click === 'function' && item.visible !== false && item.type !== 'separator'
  && (item.accelerator || item.id) && !!idOf(item);

// Every item of a menu template, with the top-level menu it's in.
function* walk(template, group = null) {
  for (const item of template || []) {
    if (!item) continue;
    yield { item, group: group ?? item.label ?? '' };
    if (Array.isArray(item.submenu)) yield* walk(item.submenu, group ?? item.label ?? '');
  }
}

// The commands a template offers: [{ id, label, group, accel (their own
// shortcut, or null) }], each id once (the first item with it).
function commands(template, mac = IS_MAC) {
  const out = [];
  const seen = new Set();
  for (const { item, group } of walk(template)) {
    if (!isCommand(item)) continue;
    const id = idOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(item.label).replace(/…$/, ''), group, accel: item.accelerator ? normalize(item.accelerator, mac) : null });
  }
  return out;
}

// What each command's shortcut is now: its own, or what was picked for it.
// A picked shortcut wins over any other command's own one.
function effective(template, overrides = {}, mac = IS_MAC) {
  const list = commands(template, mac);
  const picked = new Map(); // accel -> id
  for (const c of list) {
    if (!Object.hasOwn(overrides || {}, c.id) || overrides[c.id] == null) continue;
    const v = validate(overrides[c.id], mac);
    if (v.accel && !picked.has(v.accel)) picked.set(v.accel, c.id);
  }
  return list.map((c) => {
    let accel = c.accel;
    let custom = false;
    if (Object.hasOwn(overrides || {}, c.id)) {
      custom = true;
      const v = overrides[c.id] == null ? null : validate(overrides[c.id], mac);
      accel = v?.accel && picked.get(v.accel) === c.id ? v.accel : null;
    } else if (accel && picked.has(accel)) accel = null; // taken by a shortcut someone picked
    return { ...c, default: c.accel, accel, custom };
  });
}

// The template with the picked shortcuts in it. Hidden extra keys (F5 for
// Reload…) step aside when a picked shortcut uses them.
function apply(template, overrides = {}, mac = IS_MAC) {
  if (!overrides || !Object.keys(overrides).length) return template;
  const now = new Map(effective(template, overrides, mac).map((c) => [c.id, c]));
  const picked = new Set([...now.values()].filter((c) => c.custom && c.accel).map((c) => c.accel));
  const done = new Set();
  const copy = (items) => {
    const out = [];
    for (const item of items) {
      if (!item) continue;
      const next = { ...item };
      if (Array.isArray(item.submenu)) next.submenu = copy(item.submenu);
      if (isCommand(item) && !done.has(idOf(item))) {
        done.add(idOf(item));
        const c = now.get(idOf(item));
        if (c.accel !== c.default) { if (c.accel) next.accelerator = c.accel; else delete next.accelerator; }
      } else if (item.accelerator && picked.has(normalize(item.accelerator, mac))) {
        if (item.visible === false) continue; // a hidden extra key: drop it
        delete next.accelerator;
      }
      out.push(next);
    }
    return out;
  };
  return copy(template);
}

// Another menu laid out from the same commands (the ⋮ menu on Windows)
// shows the shortcuts as they are now: each item whose shortcut is a
// command's own one shows what that command has now.
function follow(template, overrides, items, mac = IS_MAC) {
  if (!overrides || !Object.keys(overrides).length) return items;
  const byDefault = new Map(effective(template, overrides, mac).filter((c) => c.default && c.accel !== c.default).map((c) => [c.default, c.accel]));
  const copy = (list) => list.map((item) => {
    const next = { ...item };
    if (Array.isArray(item.submenu)) next.submenu = copy(item.submenu);
    const key = item.accelerator && normalize(item.accelerator, mac);
    if (key && byDefault.has(key)) {
      if (byDefault.get(key)) next.accelerator = byDefault.get(key); else delete next.accelerator;
    }
    return next;
  });
  return copy(items);
}

// Who has these keys now (other than command `exceptId`): a command, a
// hidden extra key, a menu role (Copy, Quit…) or nobody.
function owner(template, overrides, accel, exceptId, mac = IS_MAC) {
  const list = effective(template, overrides, mac);
  const cmd = list.find((c) => c.accel === accel && c.id !== exceptId);
  if (cmd) return { kind: 'command', id: cmd.id, label: cmd.label, replaceable: true };
  for (const { item } of walk(template)) {
    if (item.role) {
      const role = ROLE_KEYS[String(item.role).toLowerCase()];
      const keys = item.accelerator || role?.[0];
      if (keys && normalize(keys, mac) === accel) return { kind: 'role', label: role?.[1] || String(item.label || item.role), replaceable: false };
    } else if (item.visible === false && item.accelerator && normalize(item.accelerator, mac) === accel) {
      // A hidden extra key for a command: name the command when it's the same action.
      const twin = [...walk(template)].find(({ item: x }) => isCommand(x) && x.click === item.click);
      const label = twin ? String(twin.item.label).replace(/…$/, '') : null;
      if (twin && idOf(twin.item) === exceptId) continue; // its own extra key
      return { kind: 'alias', label, replaceable: true };
    }
  }
  return null;
}

// The list Settings shows.
function list(template, overrides, mac = IS_MAC) {
  return effective(template, overrides, mac).map((c) => ({
    id: c.id, label: c.label, group: c.group, accel: c.accel, display: c.accel ? display(c.accel, mac) : '',
    default: c.default, defaultDisplay: c.default ? display(c.default, mac) : '', custom: c.custom,
  }));
}

// The window's tooltips name keys ("New Tab (⌘T)"); renderer/ui/shortcut-hints.js
// swaps them. For each command whose keys changed: its own keys and the keys
// now ('' for none), both as shown.
function hints(template, overrides, mac = IS_MAC) {
  return effective(template, overrides, mac).filter((c) => c.default && c.accel !== c.default)
    .map((c) => ({ from: display(c.default, mac), to: c.accel ? display(c.accel, mac) : '' }));
}

// Picks `accel` (null: no shortcut) for command `id`. Without `replace`, a
// conflict is reported instead of saved. Returns { ok, overrides } or
// { error } or { conflict: { label, replaceable, display } }.
function choose(template, overrides = {}, id, accel, { replace = false, mac = IS_MAC } = {}) {
  const cmd = commands(template, mac).find((c) => c.id === id);
  if (!cmd) return { error: 'That command isn’t in Lumio anymore.' };
  const next = { ...(overrides || {}) };
  if (accel == null) {
    if (cmd.accel) next[id] = null; else delete next[id];
    return { ok: true, overrides: next };
  }
  const v = validate(accel, mac);
  if (v.error) return { error: v.error };
  const who = owner(template, overrides, v.accel, id, mac);
  if (who) {
    const conflict = { ...who, display: display(v.accel, mac) };
    if (!who.replaceable || !replace) return { conflict };
    if (who.kind === 'command') next[who.id] = null; // it gives its shortcut up
  }
  if (v.accel === cmd.accel) delete next[id]; else next[id] = v.accel;
  return { ok: true, overrides: next };
}

// Back to Lumio's own shortcut: one command, or all of them (id null).
function reset(overrides = {}, id = null) {
  if (id == null) return {};
  const next = { ...(overrides || {}) };
  delete next[id];
  return next;
}

// Settings › Keyboard shortcuts (lumio://settings/shortcuts). template()
// gives the menu as it is now; changed() rebuilds the application menu.
function registerIpc({ internalHandle, store, template, changed, mac = IS_MAC }) {
  const overrides = () => store.settings.shortcuts || {};
  const reply = () => ({ ok: true, mac, commands: list(template(), overrides(), mac) });
  const save = (next) => { store.setSetting('shortcuts', next); changed(); return reply(); };
  internalHandle('page:shortcuts', ['settings'], () => reply());
  internalHandle('page:shortcut-set', ['settings'], (_ctx, id, accel, replace) => {
    const res = choose(template(), overrides(), String(id || ''), accel == null ? null : String(accel), { replace: !!replace, mac });
    return res.ok ? save(res.overrides) : res;
  });
  internalHandle('page:shortcut-reset', ['settings'], (_ctx, id) => save(reset(overrides(), id == null ? null : String(id))));
}

module.exports = { parse, normalize, display, validate, slug, commands, effective, apply, follow, owner, list, hints, choose, reset, registerIpc };
