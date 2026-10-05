// Keyboard shortcuts for extension commands (manifest "commands"), like
// chrome://extensions/shortcuts. Shortcuts are kept in Chrome's own format
// ("Ctrl+Shift+Y", "Command+Shift+Y", "MacCtrl+Shift+Y"); Lumio turns them
// into Electron accelerators for its menu. No Electron imports
// (unit-tested in tests/extension-access.test.mjs).

// Commands that run the extension's toolbar button instead of an event.
const ACTION_COMMANDS = new Set(['_execute_action', '_execute_browser_action', '_execute_page_action']);

const KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right',
  'MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop',
]);
const MEDIA = new Set(['MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop']);
const MODS = ['Ctrl', 'Command', 'MacCtrl', 'Alt', 'Shift'];

// "ctrl + shift + y" → { mods: Set, key: 'Y' }, or null if it isn't a shortcut.
function parse(shortcut) {
  const parts = String(shortcut || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  let key = null;
  for (const raw of parts) {
    const mod = MODS.find((m) => m.toLowerCase() === raw.toLowerCase());
    if (mod) { mods.add(mod); continue; }
    const k = [...KEYS].find((x) => x.toLowerCase() === raw.toLowerCase());
    if (!k || key) return null;
    key = k;
  }
  return key ? { mods, key } : null;
}

// Chrome's rules: a key plus Ctrl or Alt (Command or MacCtrl on the Mac);
// Shift alone isn't enough. Media keys need nothing. Returns an error to
// show, or null when it's fine.
function validate(shortcut, { mac = false } = {}) {
  const p = parse(shortcut);
  if (!p) return 'Type a letter, number or arrow key with Ctrl or Alt.';
  if (MEDIA.has(p.key)) return p.mods.size ? 'Media keys work on their own.' : null;
  if (!mac && (p.mods.has('Command') || p.mods.has('MacCtrl'))) return 'Use Ctrl or Alt.';
  const main = mac ? ['Command', 'MacCtrl', 'Alt', 'Ctrl'] : ['Ctrl', 'Alt'];
  if (!main.some((m) => p.mods.has(m))) return mac ? 'Include ⌘, Control or Option.' : 'Include Ctrl or Alt.';
  return null;
}

// Chrome's order: Ctrl/Command, MacCtrl, Alt, Shift, key.
function format(p) {
  return [...MODS.filter((m) => p.mods.has(m)), p.key].join('+');
}

// A manifest's suggested key for this computer. On the Mac, Chrome reads
// "Ctrl" as Command.
function suggested(details, { mac = false, win = false } = {}) {
  const s = details?.suggested_key;
  const raw = typeof s === 'string' ? s : s && (mac ? s.mac : win ? s.windows : s.linux) || s?.default;
  const p = parse(raw);
  if (!p) return '';
  if (mac && p.mods.has('Ctrl')) { p.mods.delete('Ctrl'); p.mods.add('Command'); }
  return validate(format(p), { mac }) ? '' : format(p);
}

// The extension's commands with the shortcut each has now: what the person
// set ('' = none), else the manifest's suggestion.
function commandsFor(manifest, saved = {}, platform = {}) {
  const out = [];
  for (const [name, details] of Object.entries(manifest?.commands || {})) {
    const fallback = suggested(details, platform);
    out.push({
      name,
      description: details?.description || (ACTION_COMMANDS.has(name) ? 'Activate the extension' : name),
      action: ACTION_COMMANDS.has(name),
      shortcut: Object.hasOwn(saved, name) ? saved[name] : fallback,
      suggested: fallback,
    });
  }
  return out;
}

// Chrome format → Electron accelerator.
const KEY_ACCEL = { Comma: ',', Period: '.', MediaPrevTrack: 'MediaPreviousTrack' };
function toAccelerator(shortcut, { mac = false } = {}) {
  const p = parse(shortcut);
  if (!p) return null;
  const parts = [];
  if (p.mods.has('Command') || (mac && p.mods.has('Ctrl'))) parts.push('Command');
  if (p.mods.has('MacCtrl') || (!mac && p.mods.has('Ctrl'))) parts.push(mac ? 'Control' : 'Ctrl');
  if (p.mods.has('Alt')) parts.push('Alt');
  if (p.mods.has('Shift')) parts.push('Shift');
  parts.push(KEY_ACCEL[p.key] || p.key);
  return parts.join('+');
}

// An Electron accelerator in one canonical spelling, to spot two that are
// the same keys ("CmdOrCtrl+Shift+Y" and "Shift+Command+Y").
const ALIASES = { cmdorctrl: null, commandorcontrol: null, cmd: 'command', ctrl: 'control', option: 'alt', plus: '+', return: 'enter', esc: 'escape' };
function canonical(accel, { mac = false } = {}) {
  const parts = String(accel || '').toLowerCase().split(/\+(?!$)/).map((s) => s.trim()).filter(Boolean);
  const mods = new Set();
  let key = '';
  for (let p of parts) {
    if (p in ALIASES) p = ALIASES[p] ?? (mac ? 'command' : 'control');
    if (['command', 'control', 'alt', 'shift', 'super', 'meta'].includes(p)) mods.add(p === 'meta' || p === 'super' ? 'command' : p);
    else key = p;
  }
  return [...[...mods].sort(), key].join('+');
}

// How a shortcut reads: "⌘⇧Y" on the Mac, "Ctrl+Shift+Y" elsewhere.
const MAC_SYMBOLS = { Command: '⌘', MacCtrl: '⌃', Ctrl: '⌘', Alt: '⌥', Shift: '⇧' };
const KEY_LABEL = { Comma: ',', Period: '.', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space', PageUp: 'Page Up', PageDown: 'Page Down' };
function label(shortcut, { mac = false } = {}) {
  const p = parse(shortcut);
  if (!p) return '';
  if (mac) return ['MacCtrl', 'Alt', 'Shift', 'Command', 'Ctrl'].filter((m) => p.mods.has(m)).map((m) => MAC_SYMBOLS[m]).join('') + (KEY_LABEL[p.key] || p.key);
  return [...MODS.filter((m) => p.mods.has(m)).map((m) => (m === 'MacCtrl' ? 'Ctrl' : m)), KEY_LABEL[p.key] || p.key].join('+');
}

module.exports = { ACTION_COMMANDS, parse, validate, format, suggested, commandsFor, toAccelerator, canonical, label };
