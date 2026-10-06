// Task Manager (Shift+Esc on Windows, Window › Task Manager on the Mac): a
// small window listing Lumio's processes (the browser, the GPU, each tab,
// extensions and helpers) with their memory, CPU, network and process ID.
// Its page (renderer/ui/taskmanager.*) asks for fresh rows every second.
// End process stops a page's process on purpose (its tab shows the error
// page, ready to reload); Lumio's own processes can't be ended.
const path = require('path');
const theme = require('./theme');
const { isHidden } = require('./hidden-pages');

const SHELL_PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const NET_WORLD = 1013; // the isolated world the network probe runs in
// Bytes a page has received since it loaded, from Resource Timing. It only
// sees the page's own requests (not other frames' or workers'), and sites
// that don't allow timing for their files count as 0: an estimate.
const NET_PROBE = `(() => {
  const s = globalThis.__lumioNet || (globalThis.__lumioNet = { bytes: 0 });
  if (!s.on) {
    s.on = true;
    const add = (list) => { for (const e of list.getEntries()) s.bytes += e.transferSize || e.encodedBodySize || 0; };
    for (const type of ['navigation', 'resource']) { try { new PerformanceObserver(add).observe({ type, buffered: true }); } catch {} }
  }
  return s.bytes;
})()`;

const ORDER = { browser: 0, gpu: 1, tab: 2, popup: 3, extension: 4, ai: 5, ui: 6, devtools: 7, utility: 8, other: 9 };

// "network.mojom.NetworkService" -> "Network Service"
const serviceLabel = (m) => m.name || String(m.serviceName || '').split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2') || m.type;

function ownerLabel(o) {
  if (o.kind === 'tab') return `${o.incognito ? 'Incognito tab' : 'Tab'}: ${o.title || 'Untitled'}`;
  if (o.kind === 'extension') return `Extension: ${o.title || 'Unknown'}`;
  if (o.kind === 'popup') return `Popup: ${o.title || 'Untitled'}`;
  if (o.kind === 'ai') return `Lumio AI: ${o.title || 'reading a page'}`;
  if (o.kind === 'devtools') return 'DevTools';
  return o.title || 'Lumio window';
}

// One row per process. metrics: app.getAppMetrics(); owners: pid -> what
// runs in it [{ kind, title, incognito?, favicon?, wcId? }]; net: wcId ->
// bytes per second.
function buildRows(metrics, owners = new Map(), net = new Map()) {
  return metrics.map((m) => {
    const list = [...(owners.get(m.pid) || [])].sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
    let kind;
    let title;
    if (m.type === 'Browser') { kind = 'browser'; title = 'Browser'; }
    else if (m.type === 'GPU') { kind = 'gpu'; title = 'GPU process'; }
    else if (m.type === 'Utility') { kind = 'utility'; title = `Utility: ${serviceLabel(m)}`; }
    else if (m.type === 'Tab' || list.length) { kind = list[0]?.kind || 'other'; title = list.length ? ownerLabel(list[0]) : 'Renderer'; }
    else { kind = 'utility'; title = m.name || m.type || 'Process'; }
    const rates = list.filter((o) => o.wcId != null && net.has(o.wcId)).map((o) => net.get(o.wcId));
    // Only pages can be ended: never the browser, the GPU, helpers or Lumio's own windows.
    const endable = list.length > 0 && list.every((o) => ['tab', 'popup', 'extension', 'ai'].includes(o.kind));
    return {
      pid: m.pid,
      kind,
      title,
      others: list.slice(1).map(ownerLabel),
      favicon: list[0]?.kind === 'tab' ? list[0].favicon || null : null,
      memory: Math.round((m.memory?.privateBytes || m.memory?.workingSetSize || 0) * 1024),
      cpu: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10,
      network: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0)) : null,
      canEnd: endable,
      canFocus: list[0]?.kind === 'tab',
    };
  });
}

class TaskManager {
  // windows: () => open browser windows. focusTab(w, tab): bring a tab forward.
  constructor({ windows, focusTab }) {
    this.windows = windows;
    this.focusTab = focusTab;
    this.win = null;
    this.net = new Map(); // wcId -> { bytes, at }
  }

  isOurs(wc) { return !!this.win && !this.win.isDestroyed() && this.win.webContents === wc; }

  open(near = null) {
    const { BrowserWindow } = require('electron');
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); return this.win; }
    const b = near && !near.isDestroyed() ? near.getBounds() : null;
    const win = new BrowserWindow({
      width: 760, height: 460, minWidth: 520, minHeight: 280,
      ...(b ? { x: Math.round(b.x + (b.width - 760) / 2), y: Math.round(b.y + 80) } : {}),
      title: 'Task Manager', show: false, autoHideMenuBar: true,
      backgroundColor: theme.colors(theme.isDark()).frame,
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    this.win = win;
    const stopTheme = theme.onChange(() => { if (!win.isDestroyed()) win.setBackgroundColor(theme.colors(theme.isDark()).frame); });
    win.on('closed', () => { stopTheme(); if (this.win === win) this.win = null; this.net.clear(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => { if (!process.env.LUMIO_HIDDEN) win.show(); });
    win.loadURL('lumio://taskmanager/');
    return win;
  }

  register(ipcMain) {
    ipcMain.handle('taskmanager:list', (e) => (this.isOurs(e.sender) ? this.list() : null));
    ipcMain.on('taskmanager:end', (e, pid) => { if (this.isOurs(e.sender)) this.end(Number(pid)); });
    ipcMain.on('taskmanager:focus', (e, pid) => { if (this.isOurs(e.sender)) this.focus(Number(pid)); });
  }

  // What runs in each process: pid -> [{ kind, title, … }] (and the
  // webContents, which the page never sees).
  owners() {
    const { webContents } = require('electron');
    const out = new Map();
    const seen = new Set();
    const add = (wc, owner) => {
      if (!wc || wc.isDestroyed() || seen.has(wc.id)) return;
      seen.add(wc.id);
      const pid = wc.getOSProcessId();
      if (!pid) return;
      if (!out.has(pid)) out.set(pid, []);
      out.get(pid).push({ ...owner, wcId: wc.id, wc });
    };
    for (const w of this.windows()) {
      for (const tab of w.tabs.tabs) add(tab.view?.webContents, { kind: 'tab', title: tab.title, incognito: w.incognito, favicon: tab.favicon, w, tab });
      for (const wc of [w.win.webContents, w.overlay.webContents, w.indicator?.bar?.webContents]) add(wc, { kind: 'ui', title: 'Lumio window' });
    }
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || seen.has(wc.id)) continue;
      const url = wc.getURL();
      let host = '';
      try { host = new URL(url).hostname; } catch { /* keep empty */ }
      if (isHidden(wc)) add(wc, { kind: 'ai', title: host });
      else if (url.startsWith('chrome-extension://')) {
        const ext = (wc.session.extensions || wc.session).getExtension?.(host);
        add(wc, { kind: 'extension', title: ext?.name || host });
      } else if (url.startsWith('devtools://')) add(wc, { kind: 'devtools' });
      else if (url.startsWith('lumio://')) add(wc, { kind: 'ui', title: `Lumio: ${wc.getTitle() || host}` });
      else add(wc, { kind: 'popup', title: wc.getTitle() || host });
    }
    return out;
  }

  // Bytes per second each web page received since the last refresh.
  async rates(owners) {
    const now = Date.now();
    const out = new Map();
    const probes = [];
    for (const list of owners.values()) {
      for (const o of list) {
        if (o.kind !== 'tab' && o.kind !== 'popup') continue;
        if (!/^https?:/.test(o.wc.getURL())) continue;
        probes.push(Promise.race([
          o.wc.executeJavaScriptInIsolatedWorld(NET_WORLD, [{ code: NET_PROBE }]),
          new Promise((r) => setTimeout(() => r(null), 400)),
        ]).catch(() => null).then((bytes) => {
          if (!Number.isFinite(bytes)) return;
          const prev = this.net.get(o.wcId);
          this.net.set(o.wcId, { bytes, at: now });
          // A new page starts its count again.
          out.set(o.wcId, prev && bytes >= prev.bytes ? ((bytes - prev.bytes) * 1000) / Math.max(250, now - prev.at) : 0);
        }));
      }
    }
    await Promise.all(probes);
    for (const id of this.net.keys()) if (!out.has(id)) this.net.delete(id);
    return out;
  }

  async list() {
    const { app } = require('electron');
    const owners = this.owners();
    const net = await this.rates(owners);
    return buildRows(app.getAppMetrics(), owners, net);
  }

  // End process: crash the pages in it (each tab then shows its error page).
  end(pid) {
    const list = this.owners().get(pid) || [];
    if (!list.length || !list.every((o) => ['tab', 'popup', 'extension', 'ai'].includes(o.kind))) return false;
    list[0].wc.forcefullyCrashRenderer();
    return true;
  }

  focus(pid) {
    const tab = (this.owners().get(pid) || []).find((o) => o.kind === 'tab');
    if (tab) this.focusTab(tab.w, tab.tab);
  }
}

// A page's memory, as the Task manager counts it (bytes), for its tab's hover
// card; null when its process isn't known. metrics: app.getAppMetrics().
function memoryOf(pid, metrics) {
  const m = pid > 0 ? (metrics || []).find((x) => x.pid === pid) : null;
  const kb = m?.memory?.privateBytes || m?.memory?.workingSetSize || 0;
  return kb ? Math.round(kb * 1024) : null;
}

module.exports = { TaskManager, buildRows, serviceLabel, memoryOf };
