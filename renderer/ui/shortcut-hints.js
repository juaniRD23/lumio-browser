// Tooltips that end with a command's keys ("New Tab (⌘T)") show the keys the
// person picked in Settings › Keyboard shortcuts (main/shortcuts.js), or no
// keys when the command has none. Nothing is watched until a shortcut has
// been changed.
const api = window.lumio;
const MAC_MODS = '⌃⌥⇧⌘';
const PC_MODS = ['Ctrl', 'Win', 'Alt', 'Shift'];

// One spelling to compare keys by: '⌘⇧S' and '⇧⌘S' are the same keys.
export function canon(keys) {
  const s = String(keys).trim();
  const mac = /^([⌃⌥⇧⌘]+)(.+)$/.exec(s);
  if (mac) return [...mac[1]].sort((a, b) => MAC_MODS.indexOf(a) - MAC_MODS.indexOf(b)).join('') + mac[2];
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const key = parts.pop();
  return [...parts.sort((a, b) => PC_MODS.indexOf(a) - PC_MODS.indexOf(b)), key].join('+');
}

// A tooltip with the keys as they are now. swaps: canon(Lumio's keys) -> the keys now ('' for none).
export function retitle(title, swaps) {
  const m = /^(.*?)(\s*)\(([^()]+)\)$/.exec(title);
  if (!m || !swaps.has(canon(m[3]))) return title;
  const now = swaps.get(canon(m[3]));
  return now ? `${m[1]}${m[2]}(${now})` : m[1];
}

let swaps = new Map();
let observer = null;
// element -> { original: the title the UI gave it, written: what's shown instead }
const originals = new WeakMap();

function fix(el) {
  const current = el.getAttribute('title');
  if (current == null) return;
  const known = originals.get(el);
  // The UI may set a title again (Reload / Stop loading): that's the new original.
  const original = known && current === known.written ? known.original : current;
  const next = retitle(original, swaps);
  if (next === original) originals.delete(el); else originals.set(el, { original, written: next });
  if (next !== current) el.setAttribute('title', next);
}

function fixTree(node) {
  if (node.nodeType !== 1) return;
  if (node.hasAttribute('title')) fix(node);
  node.querySelectorAll('[title]').forEach(fix);
}

// list: [{ from, to }] from main/shortcuts.js hints().
export function applyHints(list) {
  swaps = new Map((Array.isArray(list) ? list : []).map(({ from, to }) => [canon(from), to]));
  // Changed tooltips go back too when every shortcut is Lumio's own again.
  fixTree(document.body);
  if (swaps.size && !observer) {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') fix(r.target);
        else r.addedNodes.forEach(fixTree);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  } else if (!swaps.size && observer) {
    observer.disconnect();
    observer = null;
  }
}

if (api) {
  api.on('shortcut-hints', applyHints);
  api.invoke('shell:shortcut-hints').then(applyHints, () => {});
}
