// Name window (Window › Name Window…, or right-click the tab strip). The
// name becomes the window's title, which the macOS Window menu, Mission
// Control, the Dock and the Windows taskbar show, so a window for "Work" or
// "Trip" is easy to find. It's saved with the session. An empty name goes
// back to the usual title.

const MAX = 80;

// One line of plain text, at most MAX characters.
const clean = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX);

// Called once by BrowserWin, with the name a restored window had.
function init(w, name) {
  w.name = clean(name) || null;
  // The window's UI page has a <title> of its own; a name wins over it.
  w.win.on('page-title-updated', (e) => { if (w.name) e.preventDefault(); });
  if (w.name) w.win.setTitle(w.name);
}

// Returns whether the name changed.
function set(w, name) {
  const next = clean(name) || null;
  if (next === w.name || w.closed) return false;
  w.name = next;
  w.win.setTitle(next || w.win.webContents.getTitle() || 'Lumio Browser');
  w.app.onSessionChanged?.();
  return true;
}

// What the session file keeps.
const sessionField = (w) => (w.name ? { name: w.name } : {});

// The "Name this window" box, drawn by the overlay over the top of the page
// (renderer/ui/name-window.js). It answers on 'window:name'.
const BOX = { width: 380, height: 214 };
function ask(w) {
  if (!w || w.closed) return;
  const slot = w.tabs.slot;
  const [cw] = w.win.getContentSize();
  const x = Math.max(0, Math.min(Math.round(slot.x + (slot.width - BOX.width) / 2), cw - BOX.width));
  w.showOverlay({ x, y: Math.round(slot.y + 6), ...BOX }, { kind: 'namewindow', name: w.name || '', mac: process.platform === 'darwin' });
  w.overlay.webContents.focus();
}

// The box's answer: { name } to save, or { cancel: true }. The keyboard goes
// back to the page, unless the box closed because the person clicked
// somewhere else (blur), which keeps what they clicked. An answer from a box
// that's gone already (another popup took its place) changes nothing.
function answer(w, { name, cancel, blur } = {}) {
  if (w.overlayKind !== 'namewindow') return;
  w.hideOverlay();
  if (!cancel && typeof name === 'string') set(w, name);
  if (!blur) w.tabs.wc()?.focus();
}

module.exports = { init, set, ask, answer, sessionField, clean, MAX };
