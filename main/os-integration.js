// Lumio in the Dock, like Chrome:
//  - the Dock icon's menu: New Window, New Incognito Window (macOS)
//  - downloads: a progress bar on the Dock (or taskbar) icon while files
//    download, and on the Dock a count of finished downloads until you look
//    at them (the Downloads page or the downloads button)
// The parts that don't need Electron are plain functions (tests/tab-strip.test.mjs).
const { app, Menu } = require('electron');

const PROGRESS_EVERY = 250; // ms between progress bar updates

// One number for every download in progress: 0…1, 2 when some sizes aren't
// known yet (Electron shows that as an indeterminate bar), -1 for none.
function overallProgress(items) {
  const active = items.filter((d) => d.state === 'progressing');
  if (!active.length) return { progress: -1, mode: 'none' };
  if (active.some((d) => !(d.total > 0))) return { progress: 2, mode: 'indeterminate' };
  const total = active.reduce((a, d) => a + d.total, 0);
  const got = active.reduce((a, d) => a + Math.min(d.received || 0, d.total), 0);
  return { progress: Math.max(0, Math.min(1, got / total)), mode: active.every((d) => d.paused) ? 'paused' : 'normal' };
}

// The Dock's count: finished downloads you haven't looked at yet.
const badgeText = (finished) => (finished > 0 ? String(finished) : '');

class OsIntegration {
  // deps: { cmd, alive() }
  constructor(deps) {
    this.deps = deps;
    this.items = new Set(); // downloads in progress, in every profile
    this.finished = 0;
    this.timer = null;
    this.last = 0;
    // Every profile's downloads, incognito ones too (they're created later).
    app.on('session-created', (ses) => ses.on('will-download', (_e, item) => this.track(item)));
    // The Downloads page, however it opens.
    app.on('web-contents-created', (_e, wc) => wc.on('did-navigate', (_e2, url) => { if (String(url).startsWith('lumio://downloads')) this.seen(); }));
  }

  // At launch, once the app is ready.
  start() {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setMenu(Menu.buildFromTemplate([
        { label: 'New Window', click: () => this.deps.cmd.newWindow() },
        { label: 'New Incognito Window', click: () => this.deps.cmd.newIncognito() },
      ]));
    }
  }

  // ---------------------------------------------------------------- downloads
  track(item) {
    const d = { item };
    this.items.add(d);
    item.on('updated', () => this.progressSoon());
    item.once('done', (_e, state) => {
      this.items.delete(d);
      if (state === 'completed') this.finished++;
      this.badge();
      this.progress();
    });
    this.progress();
  }

  snapshot() {
    return [...this.items].map(({ item }) => ({ state: 'progressing', total: item.getTotalBytes(), received: item.getReceivedBytes(), paused: item.isPaused() }));
  }

  progressSoon() {
    if (this.timer) return;
    const wait = Math.max(0, PROGRESS_EVERY - (Date.now() - this.last));
    this.timer = setTimeout(() => { this.timer = null; this.progress(); }, wait);
  }

  progress() {
    this.last = Date.now();
    const { progress, mode } = overallProgress(this.snapshot());
    for (const w of this.deps.alive()) {
      if (w.win.isDestroyed()) continue;
      if (mode === 'none') w.win.setProgressBar(-1);
      else w.win.setProgressBar(progress, { mode });
    }
  }

  badge() {
    if (process.platform === 'darwin' && app.dock) app.dock.setBadge(badgeText(this.finished));
  }

  seen() {
    if (!this.finished) return;
    this.finished = 0;
    this.badge();
  }

  // A tab showed: the Downloads page counts as looking.
  onTabActivated(tab) {
    if (String(tab?.pendingUrl || tab?.url || '').startsWith('lumio://downloads')) this.seen();
  }

  // on: main.js's helper. The downloads button's list counts as looking.
  register({ on }) {
    on('overlay:show', (_w, msg) => { if (msg?.payload?.kind === 'downloads') this.seen(); });
  }
}

module.exports = { OsIntegration, overallProgress, badgeText };
