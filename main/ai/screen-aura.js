// While Lumio controls the computer (mouse, keyboard, apps, screenshots), the
// screens it looks at or acts on get a blue glow around their edges and a Stop
// pill sits at the top of the screen the mouse is on. Only those screens glow:
// looking at one screen doesn't light up the others. The glow windows are
// click-through; none of these windows take focus, and all of them are left
// out of screen captures, so the AI never sees them in its screenshots.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'dist', 'shell.js');
const MARGIN = 16; // room around the pill for its shadow
const holders = new Map(); // AI controller -> ids of the displays it has used
const glows = new Map(); // display id -> its glow window
let pill = null;
let pillSize = { width: 360, height: 40 };
let listening = false;

const common = {
  show: false, frame: false, transparent: true, backgroundColor: '#00000000',
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
  focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, enableLargerThanScreen: true,
};

// Which displays a computer tool uses (pure, for tests): the one it takes a
// screenshot of, the ones under the points it clicks, moves, scrolls or drags
// to (coordinates come from the latest screenshot), else the one under the
// mouse (typing, keys, apps).
function pickDisplays(name, args = {}, { lastShot, cursor, displays, primaryId, nearest }) {
  const at = (x, y) => (lastShot && Number.isFinite(x) && Number.isFinite(y)
    ? nearest({ x: lastShot.bounds.x + x * (lastShot.bounds.width / lastShot.width), y: lastShot.bounds.y + y * (lastShot.bounds.height / lastShot.height) })
    : nearest(cursor));
  let ids;
  if (name === 'computer_screenshot') {
    const d = args.display;
    if (d === 'main') ids = [primaryId];
    else if (d && d !== 'cursor' && displays.some((x) => String(x.id) === String(d))) ids = [Number(d)];
    else ids = [nearest(cursor)];
  } else if (name === 'computer_drag') ids = [at(args.from_x, args.from_y), at(args.to_x, args.to_y)];
  else if (Number.isFinite(args.x) && Number.isFinite(args.y)) ids = [at(args.x, args.y)];
  else ids = [nearest(cursor)];
  return [...new Set(ids.filter((id) => id != null))];
}

function displaysFor(name, args, lastShot) {
  return pickDisplays(name, args, {
    lastShot,
    cursor: screen.getCursorScreenPoint(),
    displays: screen.getAllDisplays(),
    primaryId: screen.getPrimaryDisplay().id,
    nearest: (p) => screen.getDisplayNearestPoint(p).id,
  });
}

function float(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setContentProtection(true); // excluded from screenshots and screen sharing
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
}

function glowWindow(display) {
  const win = new BrowserWindow({ ...common, ...display.bounds, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.setIgnoreMouseEvents(true);
  win.setBounds(display.bounds); // macOS may have trimmed it to below the menu bar
  float(win);
  win.loadURL('lumio://aura/?mode=glow');
  return win;
}

function pillBounds() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = pillSize.width + MARGIN * 2;
  const height = pillSize.height + MARGIN * 2;
  return { x: Math.round(d.workArea.x + (d.workArea.width - width) / 2), y: d.workArea.y + 6, width, height };
}

function pillWindow() {
  const win = new BrowserWindow({ ...common, ...pillBounds(), acceptFirstMouse: true, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  float(win);
  win.loadURL('lumio://aura/?mode=pill');
  return win;
}

function close(win, fade) {
  if (!win || win.isDestroyed()) return;
  if (!fade) { win.destroy(); return; }
  win.webContents.send('aura', { out: true });
  setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 320);
}

// Brings the glow windows in line with the displays the holders have used.
function sync() {
  const want = new Set();
  for (const ids of holders.values()) for (const id of ids) want.add(id);
  const displays = screen.getAllDisplays();
  for (const [id, win] of glows) {
    if (want.has(id) && displays.some((d) => d.id === id)) continue;
    close(win, true);
    glows.delete(id);
  }
  for (const d of displays) if (want.has(d.id) && !glows.has(d.id)) glows.set(d.id, glowWindow(d));
  if (want.size && (!pill || pill.isDestroyed())) pill = pillWindow();
  if (!want.size) { close(pill, true); pill = null; }
  if (!listening) {
    listening = true;
    // A display that moved or changed size gets a new glow of the right size.
    const rebuild = () => {
      if (!holders.size) return;
      for (const win of glows.values()) close(win, false);
      glows.clear();
      sync();
    };
    screen.on('display-added', rebuild);
    screen.on('display-removed', rebuild);
    screen.on('display-metrics-changed', rebuild);
  }
}

// An AI controller is controlling the computer on these displays (by default
// the one under the mouse).
function acquire(owner, displayIds) {
  const ids = displayIds?.length ? displayIds : [screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id];
  const mine = holders.get(owner) || new Set();
  holders.set(owner, mine);
  for (const id of ids) mine.add(id);
  sync();
}

// ...and finished (or was stopped).
function release(owner) {
  if (!holders.delete(owner)) return;
  if (holders.size) { sync(); return; }
  for (const win of glows.values()) close(win, true);
  glows.clear();
  close(pill, true);
  pill = null;
}

function active() { return holders.size > 0; }

// CGWindowIDs (macOS) of our windows, so the Mac helper can also leave them
// out of its screenshots explicitly.
function windowIds() {
  return [...glows.values(), pill].filter((w) => w && !w.isDestroyed()).map((w) => {
    const m = /^window:(\d+):/.exec(w.getMediaSourceId());
    return m ? Number(m[1]) : null;
  }).filter((id) => id != null);
}

function register() {
  ipcMain.on('aura:stop', (e) => {
    if (!pill || e.sender !== pill.webContents) return;
    for (const owner of [...holders.keys()]) owner.stop();
  });
  ipcMain.on('aura:size', (e, size) => {
    if (!pill || e.sender !== pill.webContents || !(size?.width > 0 && size?.height > 0)) return;
    pillSize = { width: Math.min(700, Math.ceil(size.width)), height: Math.min(80, Math.ceil(size.height)) };
    pill.setBounds(pillBounds());
  });
}

module.exports = { acquire, release, active, windowIds, register, displaysFor, pickDisplays };
