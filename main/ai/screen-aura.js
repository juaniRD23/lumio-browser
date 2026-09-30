// While Lumio controls the computer (mouse, keyboard, apps, screenshots), every
// screen gets a blue glow around its edges and a Stop pill sits at the top of
// the screen the mouse is on. The glow windows are click-through; none of these
// windows take focus, and all of them are left out of screen captures, so the
// AI never sees them in its screenshots.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'dist', 'shell.js');
const MARGIN = 14; // room around the pill for its shadow
const holders = new Set(); // AI controllers currently controlling the computer
let glows = [];
let pill = null;
let pillSize = { width: 360, height: 40 };
let listening = false;

const common = {
  show: false, frame: false, transparent: true, backgroundColor: '#00000000',
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
  focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, enableLargerThanScreen: true,
};

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

function build() {
  glows = screen.getAllDisplays().map(glowWindow);
  pill = pillWindow();
  if (!listening) {
    listening = true;
    const rebuild = () => { if (holders.size) { teardown(false); build(); } };
    screen.on('display-added', rebuild);
    screen.on('display-removed', rebuild);
    screen.on('display-metrics-changed', rebuild);
  }
}

function teardown(fade = true) {
  const wins = [...glows, pill].filter((w) => w && !w.isDestroyed());
  glows = [];
  pill = null;
  for (const w of wins) {
    if (fade) {
      w.webContents.send('aura', { out: true });
      setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 320);
    } else w.destroy();
  }
}

// An AI controller started controlling the computer.
function acquire(owner) {
  holders.add(owner);
  if (!pill || pill.isDestroyed()) build();
}

// ...and finished (or was stopped).
function release(owner) {
  if (!holders.delete(owner)) return;
  if (!holders.size) teardown(true);
}

function active() { return holders.size > 0; }

// CGWindowIDs (macOS) of our windows, so the Mac helper can also leave them
// out of its screenshots explicitly.
function windowIds() {
  return [...glows, pill].filter((w) => w && !w.isDestroyed()).map((w) => {
    const m = /^window:(\d+):/.exec(w.getMediaSourceId());
    return m ? Number(m[1]) : null;
  }).filter((id) => id != null);
}

function register() {
  ipcMain.on('aura:stop', (e) => {
    if (!pill || e.sender !== pill.webContents) return;
    for (const owner of [...holders]) owner.stop();
  });
  ipcMain.on('aura:size', (e, size) => {
    if (!pill || e.sender !== pill.webContents || !(size?.width > 0 && size?.height > 0)) return;
    pillSize = { width: Math.min(700, Math.ceil(size.width)), height: Math.min(80, Math.ceil(size.height)) };
    pill.setBounds(pillBounds());
  });
}

module.exports = { acquire, release, active, windowIds, register };
