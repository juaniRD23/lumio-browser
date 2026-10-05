// A stand-in Electron for main-process tests that use real TabManagers
// (main/tabs.js): each page is a fake webContents with a back/forward
// history, and windows are small objects shaped like main/window.js's
// BrowserWin. Import this before anything that requires main/ modules.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const popups = []; // menus shown: { items, opts }
export const dock = { menu: null, badge: '' };

class History {
  constructor() { this.entries = []; this.index = -1; this.restores = []; }
  current() { return this.entries[this.index] || null; }
  push(url, title = '') { this.entries.splice(this.index + 1); this.entries.push({ url, title }); this.index = this.entries.length - 1; }
  restore({ entries, index }) {
    this.restores.push({ entries, index });
    this.entries = entries.map((e) => ({ ...e }));
    this.index = index ?? entries.length - 1;
    return Promise.resolve();
  }
  getAllEntries() { return this.entries.map((e) => ({ ...e })); }
  getActiveIndex() { return this.index; }
  getEntryAtIndex(i) { return this.entries[i] ? { ...this.entries[i] } : null; }
  length() { return this.entries.length; }
  canGoBack() { return this.index > 0; }
  canGoForward() { return this.index < this.entries.length - 1; }
  goBack() { this.index--; }
  goForward() { this.index++; }
  goToIndex(i) { this.index = i; }
  removeEntryAtIndex(i) { if (i === this.index || !this.entries[i]) return false; this.entries.splice(i, 1); if (i < this.index) this.index--; return true; }
}

let wcIds = 0;
export class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = ++wcIds;
    this.navigationHistory = new History();
    this.destroyed = false;
    this.audioMuted = false;
    this.zoom = 1;
    this.reloads = 0;
  }
  // Loading a page commits it at once.
  loadURL(url) {
    this.navigationHistory.push(url);
    this.emit('did-navigate', {}, url);
    return Promise.resolve();
  }
  getURL() { return this.navigationHistory.current()?.url || ''; }
  getTitle() { return this.navigationHistory.current()?.title || ''; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit('destroyed'); }
  setAudioMuted(on) { this.audioMuted = !!on; }
  getZoomFactor() { return this.zoom; }
  setZoomFactor(f) { this.zoom = f; }
  setWindowOpenHandler() {}
  focus() { this.focused = true; }
  isFocused() { return !!this.focused; }
  reload() { this.reloads++; }
  isLoading() { return false; }
  stop() {}
  send() {}
}

class WebContentsView {
  constructor() { this.webContents = new FakeWebContents(); this.visible = true; }
  setBorderRadius() {}
  setBackgroundColor() {}
  setVisible(on) { this.visible = on; }
  getVisible() { return this.visible; }
  setBounds(b) { this.bounds = b; }
  getBounds() { return this.bounds || { x: 0, y: 0, width: 0, height: 0 }; }
}

export const app = Object.assign(new EventEmitter(), {
  getLocale: () => 'en-US',
  dock: { setMenu(m) { dock.menu = m; }, setBadge(t) { dock.badge = t; } },
});

const electron = {
  WebContentsView,
  app,
  Menu: { buildFromTemplate: (items) => ({ items, popup(opts) { popups.push({ items, opts }); } }) },
  clipboard: { writeText() {} },
  shell: { openExternal() {} },
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron, children: [] };

const { TabManager } = require('../main/tabs.js');
const { Store } = require('../main/store.js');
const theme = require('../main/theme.js');

export function makeStore() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-tabs-test-')), null);
  theme.init({ store, nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }) });
  return store;
}

// A browser window with real tabs. world: { store, windows, closed } shared
// by the windows of one test.
let winIds = 0;
export function makeWindow(world, { incognito = false, tabs = null, active = 0, urls = [], adopt = null, bounds = { x: 100, y: 80, width: 1000, height: 700 } } = {}) {
  const children = [];
  const w = {
    id: ++winIds,
    incognito,
    closedTabs: [],
    emitted: [],
    focused: 0,
    stripRect: null,
    win: {
      destroyed: false,
      bounds: { ...bounds },
      opacity: 1,
      progress: [],
      contentView: {
        children,
        addChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); children.push(v); },
        removeChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
      },
      getContentSize() { return [this.bounds.width, this.bounds.height]; },
      getContentBounds() { return { ...this.bounds }; },
      getSize() { return [this.bounds.width, this.bounds.height]; },
      setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; },
      setOpacity(o) { this.opacity = o; },
      setFullScreen() {},
      isDestroyed() { return this.destroyed; },
      isMinimized() { return false; },
      isVisible() { return true; },
      show() { this.shown = true; },
      setProgressBar(p, opts) { this.progress.push([p, opts?.mode || null]); },
      webContents: new FakeWebContents(),
    },
    overlay: new WebContentsView(),
    get closed() { return this.win.destroyed; },
    emit(channel, payload) { this.emitted.push([channel, payload]); },
    focus() { this.focused++; },
    close() {
      if (this.win.destroyed) return;
      this.win.destroyed = true;
      world.windows.splice(world.windows.indexOf(this), 1);
    },
    showOverlay(rect, payload) { this.overlay.setBounds(rect); this.overlayKind = payload?.kind || null; this.overlayData = payload; },
    hideOverlay() { this.overlayKind = null; },
  };
  w.tabs = new TabManager({
    win: w.win,
    session: {},
    store: world.store,
    incognito,
    emit: (c, p) => w.emit(c, p),
    hooks: {
      onTabClosed: (_m, entry) => (world.onTabClosed ? world.onTabClosed(w, entry) : (incognito ? w.closedTabs : (world.closed ||= [])).push(entry)),
      onLastTabClosed: () => w.close(),
      onViewCreated: (tab) => world.onViewCreated?.(w, tab),
      onAdopted: (tab) => world.onViewCreated?.(w, tab),
      onActivated: () => w.hideOverlay(),
    },
  });
  world.windows.push(w);
  if (adopt) w.tabs.adopt(adopt);
  else if (!(tabs && w.tabs.restore(tabs, active))) {
    if (urls.length) urls.forEach((u, i) => w.tabs.create(u, { active: i === 0 }));
    else w.tabs.create('lumio://newtab/');
  }
  return w;
}

// Opens pages one after another in a tab, so it has a back/forward history.
export function browse(w, tab, urls) {
  w.tabs.ensureView(tab);
  for (const url of urls) tab.view.webContents.loadURL(url);
  const titles = tab.view.webContents.navigationHistory.entries;
  titles.forEach((e) => { e.title ||= `Title of ${e.url}`; });
  return tab;
}

export const settle = () => new Promise((r) => setImmediate(r));
