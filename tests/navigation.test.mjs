// Everyday navigation in the main process (main/navigation.js, main/menu.js),
// with a stand-in for Electron and for the windows and tabs: the history
// menus, opening back/forward/reload in a new tab, the mouse's back button,
// swipes, per-site zoom, Home and start-page settings, and the shortcuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- a stand-in Electron
const popups = [];
const ipc = {};
let findText = null;
let swipePref = '';
const electron = {
  Menu: { buildFromTemplate: (items) => ({ items, popup(opts) { popups.push({ items, opts }); } }) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(os.tmpdir(), 'page one.html')] }) },
  clipboard: { writeFindText: (t) => { findText = t; } },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, resize: () => 'icon-16' }), createFromBuffer: () => ({ isEmpty: () => true }) },
  systemPreferences: { getUserDefault: () => swipePref },
  ipcMain: { on: (channel, fn) => { ipc[channel] = fn; } },
  session: { defaultSession: { fetch: async () => ({ ok: false }) } },
  WebContentsView: class {},
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, // where the real pointer is: nowhere near the page
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron, children: [] };

const { Navigation, historyItems, dispositionOf, menuLabel, saveType, SAVE_FILTERS, SWIPE_DISTANCE } = require('../main/navigation.js');
const { buildMenu, buildBrowserMenu } = require('../main/menu.js');
const { PageHud } = require('../main/page-hud.js');
const { Store } = require('../main/store.js');

const MAC = process.platform === 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- stand-in tabs and windows
class History {
  constructor(entries, index) { this.entries = entries; this.index = index; }
  getAllEntries() { return this.entries.map((e) => ({ ...e })); }
  getActiveIndex() { return this.index; }
  canGoBack() { return this.index > 0; }
  canGoForward() { return this.index < this.entries.length - 1; }
  goBack() { this.index--; }
  goForward() { this.index++; }
  goToIndex(i) { this.index = i; }
}
function page(entries, index = entries.length - 1) {
  const on = {};
  const history = new History(entries, index);
  return {
    navigationHistory: history,
    zoomFactor: 1,
    loading: false,
    getURL: () => history.entries[history.index].url,
    isDestroyed: () => false,
    isLoading() { return this.loading; },
    stop() { this.stopped = true; },
    getZoomFactor() { return this.zoomFactor; },
    setZoomFactor(f) { this.zoomFactor = f; },
    setVisualZoomLevelLimits(min, max) { this.pinch = [min, max]; return Promise.resolve(); },
    downloadURL(url) { this.downloaded = url; },
    executeJavaScriptInIsolatedWorld: async () => '  some\nselected   words ',
    on(ev, fn) { (on[ev] ||= []).push(fn); return this; },
    removeListener(ev, fn) { on[ev] = (on[ev] || []).filter((f) => f !== fn); return this; },
    emit(ev, ...args) { (on[ev] || []).forEach((fn) => fn(...args)); },
  };
}
let nextId = 1;
class Tabs {
  constructor(session) { this.session = session; this.tabs = []; this.activeId = null; this.pushes = 0; }
  get active() { return this.tabs.find((t) => t.id === this.activeId) || null; }
  add(entries, index) {
    const tab = { id: nextId++, owner: this, title: entries[index ?? entries.length - 1].title, url: '', view: { webContents: page(entries, index) } };
    tab.url = tab.view.webContents.getURL();
    this.tabs.push(tab);
    this.activeId ??= tab.id;
    return tab;
  }
  create(url, { active = true, index, title, lazy } = {}) {
    const tab = { id: nextId++, owner: this, url, title, lazy, view: null };
    this.tabs.splice(index ?? this.tabs.length, 0, tab);
    if (active) this.activeId = tab.id;
    return tab;
  }
  ensureView(tab) { tab.restored = tab.savedHistory; tab.view = { webContents: page(tab.savedHistory?.entries || [{ url: tab.url, title: '' }], tab.savedHistory?.index) }; }
  activate(id) { this.activeId = id; }
  changed() { this.pushes++; }
  displayUrl(t) { return t.url; }
  navigate(url, id = this.activeId) { const t = this.tabs.find((x) => x.id === id); t.url = url; t.navigated = url; return url; }
  wc() { return this.active?.view?.webContents || null; }
  back() { this.wc().navigationHistory.goBack(); }
  forward() { this.wc().navigationHistory.goForward(); }
  stop() { this.wc().stop(); }
}
function setup() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-nav-')), null);
  const windows = [];
  const made = [];
  const opened = [];
  let bookmarks = 0;
  const win = (incognito = false) => {
    const w = { incognito, tabs: new Tabs({ incognito }), emitted: [], win: { on() {} }, overlay: { webContents: {} }, focus() {} };
    w.emit = (channel, payload) => w.emitted.push([channel, payload]);
    windows.push(w);
    return w;
  };
  const nav = new Navigation({
    store,
    alive: () => windows,
    cur: () => windows[0],
    ensureWin: () => windows[0],
    normalWin: () => windows.find((w) => !w.incognito),
    tabOfWc: (wc) => { for (const w of windows) { const tab = w.tabs.tabs.find((t) => t.view?.webContents === wc); if (tab) return { w, tab }; } return null; },
    createWindow: (opts) => { made.push(opts); return opts; },
    openInternal: (url) => opened.push(url),
    bookmarksChanged: () => { bookmarks++; },
  });
  return { store, nav, win, made, opened, bookmarks: () => bookmarks };
}
const ENTRIES = [
  { url: 'https://a.example/', title: 'A' },
  { url: 'https://b.example/', title: 'B & co' },
  { url: 'https://c.example/', title: '' },
  { url: 'https://d.example/', title: 'D' },
];

// ---------------------------------------------------------------- tests
test('history menus list the nearest pages first, up to 12', () => {
  assert.deepEqual(historyItems(ENTRIES, 2, 'back').map((e) => e.index), [1, 0]);
  assert.deepEqual(historyItems(ENTRIES, 2, 'forward').map((e) => e.index), [3]);
  assert.deepEqual(historyItems(ENTRIES, 0, 'back'), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.example/${i}`, title: `P${i}` }));
  assert.deepEqual(historyItems(many, 29, 'back').map((e) => e.title), ['P28', 'P27', 'P26', 'P25', 'P24', 'P23', 'P22', 'P21', 'P20', 'P19', 'P18', 'P17']);
  // Titles, else the address; long ones cut; & doubled on Windows (it marks a menu letter there).
  assert.equal(menuLabel({ title: '', url: 'https://c.example/' }), 'https://c.example/');
  assert.equal(menuLabel({ title: 'x'.repeat(80) }).length, 61);
  assert.equal(menuLabel({ title: 'B & co' }), MAC ? 'B & co' : 'B && co');
});

test('right-click on Back shows this tab’s history; items go there or open in a new tab', () => {
  const { nav, win, opened } = setup();
  const w = win();
  const tab = w.tabs.add(ENTRIES, 2);
  nav.icons.set('https://b.example/', 'icon-b');
  popups.length = 0;
  nav.historyMenu(w, { dir: 'back', x: 10.4, y: 80.6 });
  const { items, opts } = popups.at(-1);
  assert.deepEqual(opts.x, 10);
  assert.deepEqual(opts.y, 81);
  assert.deepEqual(items.map((i) => i.label || i.type), [menuLabel(ENTRIES[1]), 'A', 'separator', 'Show Full History']);
  assert.equal(items[0].icon, 'icon-b', 'with the page’s icon when Lumio has it');
  items.at(-1).click();
  assert.deepEqual(opened, ['lumio://history/']);
  // A plain click goes there.
  items[1].click(null, null, {});
  assert.equal(tab.view.webContents.navigationHistory.index, 0);
  // ⌘/Ctrl-click: a background tab next to this one, with the history kept.
  nav.historyMenu(w, { dir: 'forward', x: 0, y: 0 });
  const forward = popups.at(-1).items;
  assert.equal(forward[0].label, menuLabel(ENTRIES[1]));
  forward[0].click(null, null, MAC ? { metaKey: true } : { ctrlKey: true });
  const copy = w.tabs.tabs[1];
  assert.equal(w.tabs.activeId, tab.id, 'stays on this tab');
  assert.deepEqual(copy.restored.index, 1);
  assert.equal(copy.restored.entries.length, 4);
  assert.equal(copy.view.webContents.navigationHistory.canGoBack(), true, 'Back works in the new tab');
  // Nothing to list: no menu.
  popups.length = 0;
  assert.equal(nav.historyMenu(w, { dir: 'back' }), null);
  assert.equal(popups.length, 0);
});

test('middle-click on Back, Forward or Reload opens that page in a new tab (Shift: a window)', () => {
  const { nav, win, made } = setup();
  const w = win();
  const tab = w.tabs.add(ENTRIES, 2);
  const back = nav.openInNew(w, 'back', 'background');
  assert.equal(back.url, 'https://b.example/');
  assert.equal(w.tabs.tabs.indexOf(back), 1, 'right after this tab');
  assert.equal(w.tabs.activeId, tab.id);
  const reload = nav.openInNew(w, 'reload', 'foreground');
  assert.equal(reload.restored.index, 2);
  assert.equal(w.tabs.activeId, reload.id, 'Shift brings it to the front');
  w.tabs.activate(tab.id);
  nav.openInNew(w, 'forward', 'window');
  assert.deepEqual(made.at(-1), { incognito: false, urls: ['https://d.example/'] });
  assert.equal(nav.openInNew(w, 'nowhere', 'background'), null);
  // The same rules as the toolbar's clicks.
  assert.equal(dispositionOf({ button: 1 }), 'background');
  assert.equal(dispositionOf({ button: 1, shiftKey: true }), 'foreground');
  assert.equal(dispositionOf({ shiftKey: true }), 'window');
  assert.equal(dispositionOf({}), 'current');
  assert.equal(dispositionOf(MAC ? { metaKey: true } : { ctrlKey: true }), 'background');
});

test('the mouse’s back button goes back once, even if Chromium already did', async () => {
  const { nav, win } = setup();
  const w = win();
  const wc = w.tabs.add(ENTRIES, 3).view.webContents;
  const h = wc.navigationHistory;
  nav.onMouseButton(wc, { phase: 'down' });
  nav.onMouseButton(wc, { phase: 'up', dir: 'back' });
  await sleep(90);
  assert.equal(h.index, 2);
  // Chromium went back by itself between the press and the release.
  nav.onMouseButton(wc, { phase: 'down' });
  h.goBack();
  nav.onMouseButton(wc, { phase: 'up', dir: 'back' });
  await sleep(90);
  assert.equal(h.index, 1, 'not twice');
  // A release without its press (it began elsewhere) does nothing.
  nav.onMouseButton(wc, { phase: 'up', dir: 'forward' });
  await sleep(90);
  assert.equal(h.index, 1);
  nav.onMouseButton(wc, { phase: 'down' });
  nav.onMouseButton(wc, { phase: 'up', dir: 'forward' });
  await sleep(90);
  assert.equal(h.index, 2);
});

test('a two-finger swipe shows the arrow and goes back once it’s far enough (Mac)', { skip: !MAC && 'macOS only' }, () => {
  const { nav, win } = setup();
  const w = win();
  const tab = w.tabs.add(ENTRIES, 1);
  const wc = tab.view.webContents;
  const arrows = [];
  w.hud = { swipe: (state, done) => arrows.push(state ? { ...state } : { end: true, done }) };
  nav.onSwipe(w, tab, wc, { dx: -SWIPE_DISTANCE / 2 });
  assert.deepEqual(arrows.at(-1), { dir: 'back', progress: 0.5 });
  nav.onSwipe(w, tab, wc, { dx: -SWIPE_DISTANCE / 2, end: true });
  assert.deepEqual(arrows.at(-1), { end: true, done: false });
  assert.equal(wc.navigationHistory.index, 1, 'not far enough: stays');
  nav.onSwipe(w, tab, wc, { dx: -SWIPE_DISTANCE * 2, end: true });
  assert.equal(wc.navigationHistory.index, 0);
  // Nothing back there: no arrow.
  arrows.length = 0;
  nav.onSwipe(w, tab, wc, { dx: -50 });
  assert.deepEqual(arrows, []);
  nav.onSwipe(w, tab, wc, { dx: SWIPE_DISTANCE });
  assert.deepEqual(arrows.at(-1), { dir: 'forward', progress: 1 });
  // Swiping between pages turned off in System Settings.
  swipePref = '0';
  nav.swipeCheck.at = 0;
  arrows.length = 0;
  nav.onSwipe(w, tab, wc, { dx: SWIPE_DISTANCE, end: true });
  assert.deepEqual(arrows, []);
  assert.equal(wc.navigationHistory.index, 0);
  swipePref = '';
});

test('the status bubble moves to the other corner when the page’s pointer is near it, and stays there as it resizes', () => {
  const { win } = setup();
  const w = win();
  const tab = w.tabs.add(ENTRIES, 1);
  const wc = tab.view.webContents;
  const pageBounds = { x: 0, y: 80, width: 1000, height: 600 };
  tab.view.getBounds = () => pageBounds;
  w.win = { contentView: { children: [], addChildView() {}, removeChildView() {} }, getContentBounds: () => ({ x: 500, y: 300, width: 1000, height: 680 }) };
  const hud = new PageHud(w);
  const sent = [];
  const view = { webContents: { send: (_ch, msg) => sent.push(msg), isDestroyed: () => false }, setBounds(b) { this.bounds = b; }, setVisible() {} };
  hud.views.status = view;
  hud.status('https://a.example/far', tab);
  hud.onSize(view.webContents, { width: 300, height: 30 });
  assert.equal(hud.side, 'left', 'the real pointer is far from the bubble');
  // The pointer on a link in the bubble's corner (a mouse event in the page).
  wc.emit('before-mouse-event', {}, { type: 'mouseMove', x: 40, y: 590 });
  hud.status('https://a.example/corner', tab);
  assert.equal(hud.side, 'right');
  // The new address makes the bubble smaller: it stays away from that pointer.
  hud.onSize(view.webContents, { width: 200, height: 30 });
  assert.equal(hud.side, 'right', 'the page’s last mouse event, not the screen’s pointer');
  assert.equal(view.bounds.x + view.bounds.width, pageBounds.x + pageBounds.width);
  wc.emit('before-mouse-event', {}, { type: 'mouseMove', x: 500, y: 300 });
  assert.equal(hud.side, 'left');
  // Off the links, the page's pointer is forgotten (it's no longer watched).
  hud.status('', null);
  assert.equal(hud.mouse, null);
});

test('tab pages: pinch zoom on, Esc stops loading, Alt-click downloads only web links', () => {
  const { nav, win } = setup();
  const w = win();
  w.ai = { isRunning: () => false };
  const tab = w.tabs.add(ENTRIES, 0);
  const wc = tab.view.webContents;
  nav.onViewCreated(w, tab);
  assert.deepEqual(wc.pinch, [1, 5]);
  const esc = (input, e = {}) => wc.emit('before-input-event', e, { type: 'keyDown', key: 'Escape', ...input });
  esc({});
  assert.equal(wc.stopped, undefined, 'not loading: the page keeps Esc to itself');
  wc.loading = true;
  esc({ shift: true });
  esc({}, { defaultPrevented: true });
  assert.equal(wc.stopped, undefined);
  esc({});
  assert.equal(wc.stopped, true);
  nav.downloadLink(wc, 'javascript:alert(1)');
  nav.downloadLink(wc, 'file:///etc/passwd');
  assert.equal(wc.downloaded, undefined);
  nav.downloadLink(wc, 'https://files.example/report.pdf');
  assert.equal(wc.downloaded, 'https://files.example/report.pdf');
});

test('pages from a tab reach main only from its main frame', () => {
  const { nav, win } = setup();
  const w = win();
  const wc = w.tabs.add(ENTRIES, 0).view.webContents;
  nav.register({ handle() {}, on() {}, internalHandle() {} });
  wc.mainFrame = { id: 'main' };
  ipc['nav:download']({ sender: wc, senderFrame: { id: 'ad-iframe' } }, 'https://x.example/a.zip');
  assert.equal(wc.downloaded, undefined);
  ipc['nav:download']({ sender: wc, senderFrame: wc.mainFrame }, 'https://x.example/a.zip');
  assert.equal(wc.downloaded, 'https://x.example/a.zip');
  ipc['nav:download']({ sender: page(ENTRIES), senderFrame: null }, 'https://x.example/b.zip'); // not a tab
});

test('a site’s zoom comes back on its first page; changing the default rezooms open pages', () => {
  const { store, nav, win } = setup();
  const w = win();
  const incog = win(true);
  store.setSetting('zoomLevels', { 'b.example': 150 });
  const a = w.tabs.add([{ url: 'https://b.example/', title: 'B' }], 0);
  nav.applyZoom(a, a.view.webContents, 'https://b.example/');
  assert.equal(a.view.webContents.zoomFactor, 1.5);
  // Later pages of the site keep whatever the site is at now (Chromium shares it).
  a.view.webContents.zoomFactor = 1.75;
  nav.applyZoom(a, a.view.webContents, 'https://b.example/next');
  assert.equal(a.view.webContents.zoomFactor, 1.75);
  // Incognito starts from the saved levels too.
  const i = incog.tabs.add([{ url: 'https://b.example/', title: 'B' }], 0);
  nav.applyZoom(i, i.view.webContents, 'https://b.example/');
  assert.equal(i.view.webContents.zoomFactor, 1.5);
  // A new default reaches every open page without a level of its own.
  const other = w.tabs.add([{ url: 'https://other.example/', title: 'O' }], 0);
  assert.equal(nav.setPref('defaultZoom', 125).ok, true);
  assert.equal(other.view.webContents.zoomFactor, 1.25);
  assert.equal(a.view.webContents.zoomFactor, 1.5, 'the site keeps its level');
  // Removing the site's level sends it back to the default.
  const state = nav.removeZoom('b.example');
  assert.deepEqual(state.zoomLevels, []);
  assert.equal(a.view.webContents.zoomFactor, 1.25);
  assert.equal(nav.setPref('defaultZoom', 123).ok, false);
});

test('Home and start pages: settings are checked, and the Home button follows them', () => {
  const { store, nav, win } = setup();
  const w = win();
  w.tabs.add([{ url: 'https://news.example/', title: 'News' }], 0);
  w.tabs.add([{ url: 'lumio://settings/', title: 'Settings' }], 0);
  nav.register({ handle() {}, on() {}, internalHandle() {} });
  assert.equal(nav.setPref('homePage', 'a search phrase').ok, false);
  assert.equal(store.settings.homePage, 'newtab');
  const res = nav.setPref('homePage', 'portal.example');
  assert.equal(res.ok, true);
  assert.equal(res.homePage, 'https://portal.example/');
  nav.setPref('showHome', true);
  store.flushAll();
  assert.deepEqual(w.emitted.filter(([c]) => c === 'nav-prefs').at(-1)[1], { showHome: true, homeUrl: 'https://portal.example/' });
  // "Use current pages" takes the web pages that are open.
  const cur = nav.currentPages();
  assert.deepEqual(cur.startupPages.map((p) => p.url), ['https://news.example/']);
  // Home: this tab, or a new one.
  nav.goHome(w);
  assert.equal(w.tabs.active.navigated, 'https://portal.example/');
  const bg = nav.goHome(w, 'background');
  assert.equal(bg.url, 'https://portal.example/');
  assert.notEqual(w.tabs.activeId, bg.id);
  assert.equal(nav.setPref('startupPages', ['not a page']).ok, false, 'nothing valid: refused');
  assert.equal(nav.setPref('startupPages', ['https://news.example/', 'a typo or a search']).ok, false, 'one bad address isn’t dropped quietly');
  assert.deepEqual(store.settings.startupPages.map((p) => p.url), ['https://news.example/'], 'the list is unchanged');
  assert.equal(nav.setPref('startupPages', []).ok, true);
  assert.equal(nav.setPref('somethingElse', 1).ok, false);
});

test('view source, Use Selection for Find and Open File', async () => {
  const { store, nav, win, bookmarks } = setup();
  const w = win();
  const t = w.tabs.add([{ url: 'https://a.example/', title: 'A' }], 0);
  w.tabs.add([{ url: 'https://b.example/', title: 'B' }], 0);
  w.tabs.add([{ url: 'lumio://newtab/', title: 'New Tab' }], 0);
  const src = nav.viewSource(w);
  assert.equal(src.url, 'view-source:https://a.example/');
  assert.equal(w.tabs.tabs.indexOf(src), w.tabs.tabs.indexOf(t) + 1);
  // (Bookmark All Tabs is main/bookmarks-service.js allTabs: a new folder, like Chrome.)
  w.tabs.activate(t.id);
  assert.equal(await nav.useSelectionForFind(w), 'some selected words');
  assert.deepEqual(w.emitted.at(-1), ['find-text', { text: 'some selected words' }]);
  if (MAC) assert.equal(findText, 'some selected words', 'and every app’s Find Next');
  const urls = await nav.openFile(w);
  assert.equal(urls[0], pathToFileURL(path.join(os.tmpdir(), 'page one.html')).href);
  assert.match(urls[0], /^file:\/\/.*page%20one\.html$/);
  assert.equal(w.tabs.active.navigated, urls[0], 'in the tab you’re on, like Chrome');
});

test('Save Page As: the format follows the file type picked', () => {
  assert.deepEqual(SAVE_FILTERS.map((f) => f.name), ['Webpage, Complete', 'Webpage, HTML Only', 'Webpage, Single File']);
  assert.equal(saveType('/tmp/Page.html'), 'HTMLComplete');
  assert.equal(saveType('/tmp/Page.htm'), 'HTMLOnly');
  assert.equal(saveType('/tmp/Page.MHTML'), 'MHTML');
  assert.equal(saveType('/tmp/Page.mht'), 'MHTML');
  assert.equal(saveType('/tmp/Page'), 'HTMLComplete');
});

// Every shortcut in the menus, as Electron would see them on this computer.
function accelerators(items, out = []) {
  for (const it of items || []) {
    if (it.accelerator) out.push({ label: it.label, key: it.accelerator.replace('CmdOrCtrl', MAC ? 'Cmd' : 'Ctrl') });
    accelerators(it.submenu, out);
  }
  return out;
}

test('the menus have Chrome’s shortcuts, each used once', () => {
  const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => {}) });
  const keys = accelerators(buildMenu(cmd, {}).items);
  const seen = new Map();
  const dupes = [];
  for (const { label, key } of keys) {
    if (seen.has(key)) dupes.push(`${key}: ${seen.get(key)} / ${label}`);
    seen.set(key, label);
  }
  assert.deepEqual(dupes, []);
  const want = MAC
    ? ['Cmd+O', 'Cmd+.', 'Cmd+Alt+U', 'Cmd+Alt+J', 'Cmd+Alt+I', 'Cmd+Shift+Backspace', 'Cmd+Shift+J', 'Cmd+Alt+L', 'Cmd+Shift+H', 'Cmd+E', 'Cmd+G', 'Cmd+Shift+G', 'Cmd+D', 'Cmd+Shift+D', 'Cmd+Shift+B', 'Cmd+Alt+B', 'Cmd+Shift+O', 'Cmd+Y', 'Cmd+Shift+W', 'Cmd+Shift+N', 'Cmd+R', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Cmd+Alt+Right', 'Cmd+Alt+Left']
    : ['Ctrl+O', 'Ctrl+U', 'Ctrl+Shift+J', 'Ctrl+Shift+I', 'F12', 'Ctrl+Shift+Delete', 'Ctrl+J', 'Alt+Home', 'F1', 'Shift+F5', 'Ctrl+F5', 'F5', 'Ctrl+G', 'Ctrl+D', 'Ctrl+Shift+D', 'Ctrl+Shift+B', 'Ctrl+Shift+O', 'Ctrl+H', 'Ctrl+Shift+W', 'Ctrl+Shift+N', 'F11', 'Ctrl+Tab', 'Ctrl+Shift+Tab'];
  const missing = want.filter((k) => !seen.has(k));
  assert.deepEqual(missing, []);
  if (!MAC) {
    assert.equal(seen.get('Ctrl+J'), 'Downloads', 'Ctrl+J is Downloads on Windows, like Chrome');
    assert.equal(seen.get('Ctrl+Shift+J'), 'JavaScript Console');
  }
  // The ⋮ menu shows the same keys.
  const dots = buildBrowserMenu(cmd, {});
  assert.equal(dots.find((k) => k.label === 'Downloads').accel, MAC ? 'Cmd+Alt+L' : 'Ctrl+J');
});
