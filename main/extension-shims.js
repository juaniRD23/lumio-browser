// Stand-ins for extension APIs that Electron and electron-chrome-extensions
// don't have (see docs/extensions-support.md). preload/extension-shims.js
// adds them to extension pages and service workers only when they're
// missing; the work happens here, through the library's message router:
//   chrome.alarms      timers kept in main (and on disk), so they wake the
//                      service worker and survive a restart
//   chrome.sidePanel   the panel page opens in a new tab
//   chrome.identity    launchWebAuthFlow in a small sign-in window;
//                      getRedirectURL. getAuthToken (Chrome's Google account)
//                      isn't possible and says so.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'preload', 'extension-shims.js');
const MIN_ALARM_MS = 30_000; // Chrome's shortest alarm

function attach(ses) {
  ses.registerPreloadScript({ type: 'frame', id: 'lumio-extension-shims', filePath: PRELOAD });
  ses.registerPreloadScript({ type: 'service-worker', id: 'lumio-extension-shims-sw', filePath: PRELOAD });
}

// The extension a call came from, checked against the page or worker that
// sent it (the library takes the ID the caller names).
function callerId(event) {
  const id = event.extension?.id;
  const where = event.type === 'frame' ? event.sender?.getURL?.() : event.sender?.scope;
  if (!id || !String(where || '').startsWith(`chrome-extension://${id}/`)) throw new Error('Not allowed');
  return id;
}

class Alarms {
  constructor(file, fire) {
    this.file = file;
    this.fire = fire; // (extensionId, alarm)
    this.timers = new Map(); // `${id}\n${name}` -> timeout
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* best effort */ }
  }

  // Alarms saved before a restart: missed ones go off now, once.
  start(isInstalled) {
    for (const id of Object.keys(this.data)) {
      if (!isInstalled(id)) { delete this.data[id]; continue; }
      for (const a of this.data[id]) this.schedule(id, a);
    }
    this.save();
  }

  schedule(id, alarm) {
    const k = `${id}\n${alarm.name}`;
    clearTimeout(this.timers.get(k));
    const wait = Math.max(0, alarm.scheduledTime - Date.now());
    // setTimeout can't wait longer than ~24.8 days; check again then.
    const t = setTimeout(() => (wait > 2 ** 31 - 1 ? this.schedule(id, alarm) : this.ring(id, alarm.name)), Math.min(wait, 2 ** 31 - 1));
    t.unref?.();
    this.timers.set(k, t);
  }

  ring(id, name) {
    const list = this.data[id] || [];
    const alarm = list.find((a) => a.name === name);
    if (!alarm) return;
    this.fire(id, { ...alarm });
    if (alarm.periodInMinutes) {
      alarm.scheduledTime = Date.now() + Math.max(MIN_ALARM_MS, alarm.periodInMinutes * 60_000);
      this.schedule(id, alarm);
    } else {
      this.data[id] = list.filter((a) => a !== alarm);
      this.timers.delete(`${id}\n${name}`);
    }
    this.save();
  }

  create(id, name = '', info = {}) {
    const now = Date.now();
    const period = Number(info.periodInMinutes) > 0 ? Number(info.periodInMinutes) : null;
    let when = Number.isFinite(info.when) ? info.when : now + (Number(info.delayInMinutes) > 0 ? info.delayInMinutes * 60_000 : (period || 0) * 60_000);
    if (!process.env.LUMIO_TEST) when = Math.max(when, now + MIN_ALARM_MS);
    const alarm = { name: String(name), scheduledTime: when, ...(period ? { periodInMinutes: period } : {}) };
    this.data[id] = [...(this.data[id] || []).filter((a) => a.name !== alarm.name), alarm];
    this.schedule(id, alarm);
    this.save();
  }

  get(id, name = '') { return (this.data[id] || []).find((a) => a.name === String(name)) || undefined; }
  all(id) { return (this.data[id] || []).slice(); }

  clear(id, name) {
    const list = this.data[id] || [];
    const gone = list.filter((a) => name === undefined || a.name === String(name));
    for (const a of gone) { clearTimeout(this.timers.get(`${id}\n${a.name}`)); this.timers.delete(`${id}\n${a.name}`); }
    this.data[id] = list.filter((a) => !gone.includes(a));
    this.save();
    return gone.length > 0;
  }

  forget(id) { this.clear(id); delete this.data[id]; this.save(); }
}

// chrome.identity.launchWebAuthFlow: the sign-in page in a small window. It
// ends when the page goes to https://<id>.chromiumapp.org/..., which is
// handed back to the extension, or when the person closes the window.
function webAuthFlow(id, details, ses) {
  let url;
  try { url = new URL(String(details?.url || '')); } catch { return Promise.reject(new Error('Authorization page could not be loaded.')); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new Error('Authorization page could not be loaded.'));
  const done = `https://${id}.chromiumapp.org/`;
  const interactive = !!details.interactive;
  return new Promise((resolve, reject) => {
    const parent = BrowserWindow.getFocusedWindow() || undefined;
    const win = new BrowserWindow({
      width: 520, height: 680, show: false, parent, autoHideMenuBar: true, title: 'Sign in',
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let finished = false;
    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(silent);
      if (!win.isDestroyed()) win.destroy();
      if (err) reject(err); else resolve(value);
    };
    const check = (e, target) => {
      if (String(target).startsWith(done)) { e.preventDefault(); finish(null, String(target)); }
    };
    win.webContents.on('will-redirect', (e) => check(e, e.url));
    win.webContents.on('will-navigate', (e) => check(e, e.url));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish(new Error('The user did not approve access.')));
    // Not interactive: it must finish on its own, without showing anything.
    const silent = interactive ? null : setTimeout(() => finish(new Error('User interaction required.')), 10_000);
    if (interactive) win.once('ready-to-show', () => !finished && win.show());
    win.loadURL(url.href).catch(() => {});
  });
}

// Wires the stand-ins into an ExtensionManager (after its library starts).
function register(manager) {
  const router = manager.ece?.ctx?.router;
  if (!router?.handle) return;
  const handle = (name, fn) => router.handle(`lumio.${name}`, (event, ...args) => fn(callerId(event), ...args));

  // The profile's alarms (manager.dir: its folder).
  const alarms = new Alarms(path.join(manager.dir || app.getPath('userData'), 'extension-alarms.json'), (id, alarm) => router.sendEvent(id, 'lumio.alarms.onAlarm', alarm));
  manager.alarms = alarms;
  handle('alarms.create', (id, name, info) => { alarms.create(id, name, info || {}); });
  handle('alarms.get', (id, name) => alarms.get(id, name));
  handle('alarms.getAll', (id) => alarms.all(id));
  handle('alarms.clear', (id, name) => alarms.clear(id, name ?? ''));
  handle('alarms.clearAll', (id) => alarms.clear(id));
  setImmediate(() => alarms.start((id) => !!manager.api.getExtension(id) || manager.storeIds().includes(id)));
  manager.api.on('extension-unloaded', (_e, ext) => {
    // Removed (not just turned off or reloaded): its alarms go too.
    if (!manager.storeIds().includes(ext.id) && !manager.api.getExtension(ext.id) && !(manager.settings.unpackedExtensions || []).some((p) => p === ext.path)) alarms.forget(ext.id);
  });

  const panels = new Map(); // id -> { path, enabled, openPanelOnActionClick }
  const panelOf = (id) => {
    if (!panels.has(id)) {
      const m = manager.api.getExtension(id)?.manifest || {};
      panels.set(id, { path: m.side_panel?.default_path || '', enabled: true, openPanelOnActionClick: false });
    }
    return panels.get(id);
  };
  const openPanel = (id) => {
    const p = panelOf(id);
    if (!p.path || !p.enabled) return false;
    manager.hooks.createTab({ url: `chrome-extension://${id}/${String(p.path).replace(/^\//, '')}`, active: true });
    return true;
  };
  handle('sidePanel.setOptions', (id, opts = {}) => {
    const p = panelOf(id);
    if (typeof opts.path === 'string') p.path = opts.path;
    if (typeof opts.enabled === 'boolean') p.enabled = opts.enabled;
  });
  handle('sidePanel.getOptions', (id) => { const p = panelOf(id); return { path: p.path, enabled: p.enabled }; });
  handle('sidePanel.setPanelBehavior', (id, b = {}) => { if (typeof b.openPanelOnActionClick === 'boolean') panelOf(id).openPanelOnActionClick = b.openPanelOnActionClick; });
  handle('sidePanel.getPanelBehavior', (id) => ({ openPanelOnActionClick: panelOf(id).openPanelOnActionClick }));
  handle('sidePanel.open', (id) => { if (!openPanel(id)) throw new Error('No side panel to open.'); });
  // "Open the side panel when the toolbar button is clicked".
  const actions = manager.ece.api?.browserAction;
  if (typeof actions?.activateClick === 'function') {
    const original = actions.activateClick.bind(actions);
    actions.activateClick = (details) => (panels.get(details?.extensionId)?.openPanelOnActionClick && openPanel(details.extensionId) ? undefined : original(details));
  }

  handle('identity.launchWebAuthFlow', (id, details) => webAuthFlow(id, details, manager.session));
}

module.exports = { attach, register, Alarms, webAuthFlow, callerId, PRELOAD };
