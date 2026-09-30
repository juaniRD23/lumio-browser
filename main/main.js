// Lumio Browser — main process entry.
const {
  app, BrowserWindow, ipcMain, session, protocol, Menu, safeStorage, nativeImage, dialog, net, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

if (process.env.LUMIO_USER_DATA) app.setPath('userData', process.env.LUMIO_USER_DATA);
if (process.env.LUMIO_DOWNLOADS) app.setPath('downloads', process.env.LUMIO_DOWNLOADS); // tests
app.setName('Lumio Browser');

protocol.registerSchemesAsPrivileged([
  { scheme: 'lumio', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const { Store, SEARCH_ENGINES } = require('./store');
const { NEWTAB } = require('./tabs');
const { BrowserWin } = require('./window');
const { registerUiProtocol, registerPagesProtocol } = require('./protocol');
const { chromeUserAgent, Downloads, Permissions } = require('./features');
const { buildMenu, buildBrowserMenu } = require('./menu');
const { suggest, topSites } = require('./omnibox');
const { ChatStore } = require('./ai/chats');
const { MacHelper } = require('./mac/helper');
const { ExtensionManager } = require('./extensions');
const { LumioAccount } = require('./account');
const { PasswordManager } = require('./password-manager');
const screenAura = require('./ai/screen-aura');
const { Updater, LATEST } = require('./updater');
const { generatePassword } = require('./passwords');
const importer = require('./importer/chromium');

const IS_DEV = !app.isPackaged;

// A stray error in a callback shouldn't freeze the browser behind Electron's
// modal error box: log it and keep going.
process.on('uncaughtException', (err) => console.error('[lumio] uncaught exception:', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('[lumio] unhandled rejection:', err?.stack || err));

if (!process.env.LUMIO_TEST && !app.requestSingleInstanceLock()) app.quit();

let store = null;
let helper = null;
let normal = null; // the normal profile: { session, downloads, permissions, chats }
let incog = null; // the current incognito profile, while any incognito window is open
let incogSeq = 0;
let extensions = null;
let updater = null;
let account = null;
let passwords = null;
let quitting = false;
const windows = new Set();
let lastFocused = null;
const recentlyClosed = []; // newest last: { kind: 'tab' | 'window', ... }
const pendingUrls = [];

// ---------------------------------------------------------------- windows
const alive = () => [...windows].filter((w) => !w.closed && !w.closing);
const cur = () => (lastFocused && !lastFocused.closed && !lastFocused.closing ? lastFocused : alive().at(-1)) || null;
const normalWin = () => { const c = cur(); return c && !c.incognito ? c : alive().reverse().find((w) => !w.incognito) || null; };
const ensureWin = () => cur() || createWindow();
const windowOfWc = (wc) => alive().find((w) => w.win.webContents === wc || w.overlay.webContents === wc || w.indicator?.bar?.webContents === wc) || null;
const tabOfWc = (wc) => {
  for (const w of alive()) {
    const tab = w.tabs.byWebContents(wc);
    if (tab) return { w, tab };
  }
  return null;
};

function setupTabSession(ses) {
  ses.setUserAgent(app.userAgentFallback);
  registerPagesProtocol(ses);
}

function incognitoProfile() {
  if (incog) return incog;
  const ses = session.fromPartition(`lumio-incognito-${++incogSeq}`); // in memory only
  setupTabSession(ses);
  const profile = { incognito: true, session: ses, chats: new ChatStore(null) };
  profile.downloads = new Downloads(ses, { settings: store, emit: (c, p) => alive().filter((w) => w.profile === profile).forEach((w) => w.emit(c, p)) });
  profile.permissions = new Permissions(ses, { store, emitFor, persist: false });
  incog = profile;
  return profile;
}

function endIncognito() {
  const p = incog;
  incog = null;
  if (!p) return;
  p.session.clearStorageData().catch(() => {});
  p.session.clearCache().catch(() => {});
  p.session.clearAuthCache?.().catch?.(() => {});
}

function emitFor(wcId, channel, payload) {
  for (const w of alive()) {
    if (w.tabs.tabs.some((t) => t.view?.webContents.id === wcId)) { w.emit(channel, payload); return; }
  }
}

const services = {
  get store() { return store; },
  get helper() { return helper; },
  get account() { return account; },
  createWindow: (opts) => createWindow(opts),
  onFocus: (w) => { lastFocused = w; },
  onClose: (w) => {
    if (quitting || w.incognito || !w.tabs.tabs.length) return;
    recentlyClosed.push({ kind: 'window', ...w.session(), title: w.tabs.active?.title || 'Window', time: Date.now() });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    menuChanged();
  },
  onClosed: (w) => {
    windows.delete(w);
    if (lastFocused === w) lastFocused = null;
    if (w.incognito && !alive().some((x) => x.incognito)) endIncognito();
    saveSession();
  },
  onTabClosed: (w, entry) => {
    if (quitting || w.closing) return;
    if (w.incognito) {
      w.closedTabs.push(entry);
      if (w.closedTabs.length > 25) w.closedTabs.shift();
      return;
    }
    recentlyClosed.push({ kind: 'tab', ...entry, windowId: w.id, time: Date.now() });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    menuChanged();
  },
  onSessionChanged: () => saveSession(),
  onViewCreated: (w, tab) => { if (!w.incognito && tab.view) extensions?.addTab(tab.view.webContents, w.win); },
  onTabActivated: (w, tab) => { if (!w.incognito && tab.view) extensions?.selectTab(tab.view.webContents); },
  savePage: (w, tab) => savePage(w, tab),
  contextMenuExtras: (w, tab, params) => (w.incognito || !tab.view ? [] : extensions?.contextMenuItems(tab.view.webContents, params) || []),
  broadcastAIState: () => alive().forEach((w) => w.ai.emitState()),
};

function createWindow(opts = {}) {
  const incognito = !!opts.incognito;
  const w = new BrowserWin(services, incognito ? incognitoProfile() : normal, { ...opts, near: cur()?.win });
  windows.add(w);
  lastFocused = w;
  if (opts.focus !== false) w.win.once('ready-to-show', () => w.focus());
  return w;
}

// Save the open normal windows so they come back next launch. When the last
// one closes (without quitting) the file keeps it, like Chrome on the Mac.
function saveSession() {
  if (quitting || !store) return;
  const list = alive().filter((w) => !w.incognito).map((w) => w.session()).filter((s) => s.tabs.length);
  if (list.length) store.saveSession(list);
}

let menuTimer = null;
function menuChanged() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => Menu.setApplicationMenu(buildMenu(cmd, menuState())), 50);
}
function menuState() {
  return {
    bookmarksBar: !!store.settings.showBookmarksBar,
    recentlyClosed: recentlyClosed.slice(-10).reverse().map((e, i) => ({
      label: e.kind === 'window' ? `${e.tabs.length} Tab${e.tabs.length === 1 ? '' : 's'} (${e.title})` : e.title || e.url,
      index: recentlyClosed.length - 1 - i,
    })),
  };
}

function reopenClosed(index = recentlyClosed.length - 1) {
  const w = cur();
  if (w?.incognito && index === recentlyClosed.length - 1) {
    const e = w.closedTabs.pop();
    if (e) w.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned });
    return;
  }
  const [e] = recentlyClosed.splice(index, 1);
  if (!e) return;
  menuChanged();
  if (e.kind === 'window') { createWindow({ tabs: e.tabs, active: e.active, bounds: e.bounds }); return; }
  const target = alive().find((x) => x.id === e.windowId) || normalWin();
  if (!target) { createWindow({ urls: [e.url] }); return; }
  target.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned });
  target.focus();
}

function moveTabToNewWindow(w, id) {
  if (w.tabs.tabs.length < 2) return;
  const tab = w.tabs.detach(id);
  if (!tab) return;
  if (tab.view && !w.incognito) extensions?.removeTab(tab.view.webContents);
  createWindow({ incognito: w.incognito, adopt: tab });
}

async function savePage(w, tab) {
  const wc = tab?.view?.webContents;
  if (!wc) return;
  const name = (tab.title || 'page').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: path.join(app.getPath('downloads'), `${name}.html`),
    filters: [{ name: 'Web Page, Complete', extensions: ['html'] }],
  });
  if (canceled || !filePath) return;
  try {
    await wc.savePage(filePath, 'HTMLComplete');
    w.emit('toast', { text: 'Page saved' });
  } catch {
    w.emit('toast', { text: "Couldn't save this page" });
  }
}

function askAI(text, opts) { ensureWin().askAI(text, opts); }

const extensionUrl = (url) => (!url || /^lumio:/i.test(url) ? NEWTAB : url);

// ---------------------------------------------------------------- commands
const cmd = {
  isDev: IS_DEV,
  newTab: () => { const w = ensureWin(); w.tabs.create(NEWTAB); w.focus(); setTimeout(() => w.focusOmnibox(), 30); },
  newWindow: () => createWindow(),
  newIncognito: () => createWindow({ incognito: true }),
  closeTab: () => { const w = cur(); if (w) w.tabs.close(w.tabs.activeId); },
  closeWindow: () => cur()?.close(),
  reopenTab: () => reopenClosed(),
  reopenClosed: (index) => reopenClosed(index),
  focusOmnibox: () => cur()?.focusOmnibox(),
  print: () => cur()?.tabs.wc()?.print(),
  savePage: () => { const w = cur(); if (w) savePage(w, w.tabs.active); },
  find: () => { const w = cur(); if (!w) return; w.win.webContents.focus(); w.emit('find-open'); },
  findStep: (forward) => cur()?.emit('find-step', { forward }),
  reload: (hard) => cur()?.tabs.reload(hard),
  zoom: (step) => cur()?.tabs.zoom(step),
  togglePanel: () => cur()?.emit('panel-toggle'),
  focusAI: () => { const w = cur(); if (!w) return; w.win.webContents.focus(); w.emit('ai-focus'); },
  devtools: () => cur()?.tabs.wc()?.openDevTools({ mode: 'detach' }),
  shellDevtools: () => cur()?.win.webContents.openDevTools({ mode: 'detach' }),
  back: () => cur()?.tabs.back(),
  forward: () => cur()?.tabs.forward(),
  history: () => openInternal('lumio://history/'),
  downloads: () => openInternal('lumio://downloads/'),
  bookmarksManager: () => openInternal('lumio://bookmarks/'),
  extensions: () => openInternal('lumio://extensions/'),
  passwords: () => openInternal('lumio://passwords/'),
  about: () => openInternal('lumio://settings/#about'),
  settings: () => openInternal('lumio://settings/'),
  bookmark: () => toggleBookmark(cur()),
  toggleBookmarksBar: () => setBookmarksBar(!store.settings.showBookmarksBar),
  pinTab: () => { const w = cur(); const t = w?.tabs.active; if (t) w.tabs.setPinned(t.id, !t.pinned); },
  moveTabToNewWindow: () => { const w = cur(); if (w?.tabs.active) moveTabToNewWindow(w, w.tabs.activeId); },
  cycle: (dir) => cur()?.tabs.cycle(dir),
  tabIndex: (n) => cur()?.tabs.activateIndex(n),
  makeDefault: () => makeDefaultBrowser(),
  webStore: () => { const w = normalWin() || createWindow(); w.tabs.create('https://chromewebstore.google.com/'); w.focus(); },
};

function openInternal(url) {
  // Browser pages open in a normal window, even from incognito.
  const w = normalWin() || createWindow({ urls: [url] });
  const existing = w.tabs.tabs.find((t) => (t.pendingUrl || t.url || '').startsWith(url));
  if (existing) w.tabs.activate(existing.id);
  else w.tabs.create(url);
  w.focus();
}

function bookmarksPayload() {
  return {
    show: !!store.settings.showBookmarksBar,
    items: store.bookmarks().map(({ url, title, favicon }) => ({ url, title, favicon: favicon || null })),
  };
}

function bookmarksChanged() {
  const payload = bookmarksPayload();
  for (const w of alive()) { w.tabs.changed(); w.emit('bookmarks', payload); }
}

function setBookmarksBar(show) {
  store.setSetting('showBookmarksBar', !!show);
  bookmarksChanged();
  menuChanged();
}

function toggleBookmark(w) {
  const tab = w?.tabs.active;
  if (!tab) return;
  const url = w.tabs.displayUrl(tab);
  if (!/^https?:/.test(url)) return;
  const added = store.toggleBookmark(url, tab.title, tab.favicon);
  bookmarksChanged();
  w.emit('toast', { text: added ? 'Bookmarked' : 'Bookmark removed' });
}

function openUrl(url, disposition = 'tab', from = cur()) {
  if (!/^(https?|file|lumio|chrome-extension):/i.test(url)) return;
  if (disposition === 'window') createWindow({ urls: [url] });
  else if (disposition === 'incognito') createWindow({ incognito: true, urls: [url] });
  else {
    const w = from && !from.closed ? from : ensureWin();
    if (disposition === 'current' && w.tabs.active) w.tabs.navigate(url);
    else w.tabs.create(url, { active: disposition !== 'background' });
  }
}

function makeDefaultBrowser() {
  const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  if (process.platform === 'win32') {
    // Windows only lets the person choose, in Settings → Default apps.
    require('electron').shell.openExternal('ms-settings:defaultapps');
    cur()?.emit('toast', { text: 'Choose Lumio Browser under Web browser in Windows Settings.' });
    return ok;
  }
  cur()?.emit('toast', { text: ok ? 'macOS will ask you to confirm Lumio as your default browser.' : 'Could not set the default browser from a development build.' });
  return ok;
}

// ---------------------------------------------------------------- account + profile
// GPL: the About section links to the source code.
const SOURCE_URL = 'https://github.com/juaniRD23/lumio-browser';
const ACCOUNT_PAGES = { manage: '/?settings=account', upgrade: '/?settings=upgrade', billing: '/?settings=subscription', home: '/' };

async function signIn(from) {
  const res = await account.startSignIn();
  if (res.ok) {
    // Approve in a normal window (never incognito), next to the current tab.
    const w = from && !from.incognito ? from : normalWin() || createWindow({ urls: [] });
    w.tabs.create(res.url);
    w.focus();
  }
  return res;
}

function openAccountPage(which, from) {
  const path = ACCOUNT_PAGES[which];
  if (!path) return;
  const w = from && !from.incognito ? from : normalWin() || createWindow({ urls: [] });
  w.tabs.create(account.url(path));
  w.focus();
}

function profileState() { return { ...store.settings.profile }; }

const THEMES = ['blue', 'purple', 'green', 'orange', 'pink', 'mono'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
function setProfile(patch = {}) {
  const next = { ...store.settings.profile };
  if (typeof patch.name === 'string') next.name = patch.name.trim().slice(0, 40);
  if (typeof patch.color === 'string' && COLOR_RE.test(patch.color)) next.color = patch.color;
  if (THEMES.includes(patch.theme)) next.theme = patch.theme;
  if (patch.photo === null) next.photo = null;
  store.setSetting('profile', next);
  alive().forEach((w) => w.emit('profile', next));
  return next;
}

async function pickProfilePhoto(w) {
  const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }],
  });
  if (canceled || !filePaths[0]) return profileState();
  const img = nativeImage.createFromPath(filePaths[0]);
  if (img.isEmpty()) return { ...profileState(), error: "That image couldn't be opened." };
  // Square-crop the center and keep it small; it's stored in settings.
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: 160, height: 160, quality: 'best' });
  const next = { ...store.settings.profile, photo: square.toDataURL() };
  store.setSetting('profile', next);
  alive().forEach((x) => x.emit('profile', next));
  return next;
}

// Clear browsing data. range: milliseconds back from now, or 0 for all time.
async function clearData({ range = 0, what = [] } = {}) {
  const from = range ? Date.now() - range : null;
  if (what.includes('history')) { if (from) store.deleteHistory({ from }); else store.clearHistory(); }
  if (what.includes('downloads')) store.clearDownloads({ from });
  if (what.includes('cookies')) await normal.session.clearStorageData();
  if (what.includes('cache')) await normal.session.clearCache();
  if (what.includes('chats')) {
    alive().filter((w) => !w.incognito).forEach((w) => w.ai.stop());
    normal.chats.clear();
  }
  if (what.includes('permissions')) normal.permissions.clear();
  if (what.includes('closed')) { recentlyClosed.length = 0; menuChanged(); }
  return true;
}

// ---------------------------------------------------------------- updates
// The Update button: download and check the installer, then ask before restarting.
async function startUpdate(w) {
  if (!updater || ['downloading', 'installing'].includes(updater.state.status)) return updater?.state || null;
  try { await updater.download(); } catch { return updater.state; }
  if (!process.env.LUMIO_TEST) {
    const working = alive().some((x) => x.ai.isRunning());
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'info',
      message: `Lumio Browser ${updater.state.latest} is ready to install`,
      detail: `Lumio will restart and reopen your tabs.${working ? ' Lumio AI is working on a task right now; restarting will stop it.' : ''}`,
      buttons: ['Restart Now', 'Later', "What's New"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 2 && updater.state.notesUrl) openUrl(updater.state.notesUrl);
    if (response !== 0) return updater.state;
  }
  await updater.install().catch(() => {});
  return updater.state;
}

// ---------------------------------------------------------------- IPC
// Browser UI calls (shell + overlay) are routed to the window they came from.
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const w = windowOfWc(e.sender);
    if (!w) throw new Error('Not allowed');
    return fn(w, ...args);
  });
}
function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => { const w = windowOfWc(e.sender); if (w) fn(w, ...args); });
}

// Internal pages (lumio://newtab etc.) run in normal tab views; only their
// main frame, on an allowed lumio:// host, may call these.
function internalHandle(channel, hosts, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const frame = e.senderFrame;
    if (!frame || frame !== e.sender.mainFrame) throw new Error('Not allowed');
    let host;
    try {
      const u = new URL(frame.url);
      if (u.protocol !== 'lumio:') throw new Error();
      host = u.hostname;
    } catch { throw new Error('Not allowed'); }
    if (!hosts.includes(host)) throw new Error('Not allowed');
    const found = tabOfWc(e.sender);
    if (!found) throw new Error('Not allowed');
    return fn({ sender: e.sender, w: found.w, tab: found.tab }, ...args);
  });
}

const ALL_PAGES = ['newtab', 'error', 'history', 'settings', 'downloads', 'bookmarks', 'extensions', 'passwords'];

function registerIpc() {
  handle('shell:init', (w) => ({
    tabs: w.tabs.state(),
    downloads: w.profile.downloads.list(),
    panel: { open: store.settings.panelOpen, width: store.settings.panelWidth },
    ai: w.ai.state(),
    bookmarks: bookmarksPayload(),
    account: account.state(),
    profile: profileState(),
    incognito: w.incognito,
    extensions: !w.incognito && !!extensions?.ece,
    platform: process.platform,
    version: app.getVersion(),
    update: updater?.state || null,
  }));

  on('layout:slot', (w, rect) => { w.tabs.setSlot(rect); w.indicator.place(); });
  on('aura:size', (w, size) => { if (w.indicator.bar?.webContents) w.indicator.resize(size); });
  on('panel:set', (_w, { open, width }) => {
    if (typeof open === 'boolean') store.setSetting('panelOpen', open);
    if (typeof width === 'number') store.setSetting('panelWidth', Math.round(Math.max(320, Math.min(760, width))));
  });

  on('tab:new', (w, url) => w.tabs.create(url || NEWTAB));
  on('tab:close', (w, id) => w.tabs.close(id));
  on('tab:activate', (w, id) => w.tabs.activate(id));
  on('tab:move', (w, { id, index }) => w.tabs.move(id, index));
  on('tab:mute', (w, id) => w.tabs.toggleMute(id));
  on('tab:zoom', (w, step) => w.tabs.zoom(step));
  on('tab:back', (w) => w.tabs.back());
  on('tab:forward', (w) => w.tabs.forward());
  on('tab:reload', (w) => w.tabs.reload(false));
  on('tab:stop', (w) => w.tabs.stop());
  on('tab:navigate', (w, input) => { w.hideOverlay(); w.tabs.navigate(input); });
  on('tab:bookmark', (w) => toggleBookmark(w));
  on('tab:focus-page', (w) => w.tabs.wc()?.focus());
  on('tab:context', (w, id) => tabContextMenu(w, id));
  on('window:new', () => createWindow());
  on('app:menu', (w, { x, y }) => {
    buildBrowserMenu(cmd, menuState()).popup({ window: w.win, x: Math.max(0, Math.round(x) - 290), y: Math.round(y) });
  });
  on('window:incognito', () => createWindow({ incognito: true }));

  handle('omnibox:suggest', (w, text) => suggest(text, {
    history: w.incognito ? [] : store.history(),
    bookmarks: store.bookmarks(),
    searchTemplate: w.tabs.searchTemplate(),
  }));

  on('overlay:show', (w, { rect, payload }) => w.showOverlay(rect, payload));
  // The shell names the dropdown it means, so it can't close one it didn't open.
  on('overlay:hide', (w, kind) => { if (!kind || !w.overlayKind || w.overlayKind === kind) w.hideOverlay(); });
  // Dropdowns that size themselves (account menu, site info).
  on('overlay:size', (w, { height }) => {
    if (!w.win.contentView.children.includes(w.overlay) || !Number.isFinite(height)) return;
    const b = w.overlay.getBounds();
    const max = w.win.getContentSize()[1] - b.y - 8;
    w.overlay.setBounds({ ...b, height: Math.max(60, Math.min(Math.round(height), max)) });
  });
  on('overlay:pick', (w, item) => {
    w.hideOverlay();
    w.emit('overlay-picked', item);
  });

  // Electron: findNext=true starts a new search; false continues the current one.
  on('find:start', (w, { text, forward = true, next = false }) => {
    const wc = w.tabs.wc();
    if (wc && text) wc.findInPage(text, { forward, findNext: !next });
  });
  on('find:stop', (w) => w.tabs.wc()?.stopFindInPage('clearSelection'));

  on('download:action', (w, { id, action }) => {
    if (action === 'all') { w.hideOverlay(); openInternal('lumio://downloads/'); return; }
    w.profile.downloads.action(id, action);
  });
  on('permission:respond', (w, { id, allow, remember }) => w.profile.permissions.respond(id, allow, remember));

  // ---- bookmarks bar ----
  on('bookmarks:open', (w, { url, disposition }) => openUrl(url, disposition || 'current', w));
  on('bookmarks:context', (w, url) => bookmarkContextMenu(w, url));
  on('bookmarks:overflow', (w, { urls, x, y }) => {
    const items = store.bookmarks().filter((b) => urls.includes(b.url));
    Menu.buildFromTemplate(items.map((b) => ({ label: b.title.slice(0, 60) || b.url, click: () => openUrl(b.url, 'current', w) })))
      .popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
  });
  on('bookmarks:move', (_w, { url, index }) => { store.moveBookmark(url, index); bookmarksChanged(); });

  // ---- site info (lock icon) ----
  handle('site:info', (w) => siteInfo(w));
  on('site:set-permission', (w, { permission, value }) => {
    const info = siteInfo(w);
    if (!info) return;
    w.profile.permissions.set(info.origin, permission, value === 'allow' ? true : value === 'block' ? false : undefined);
    w.emit('site-info', siteInfo(w));
  });
  on('site:clear-data', async (w) => {
    const info = siteInfo(w);
    if (!info) return;
    await w.profile.session.clearStorageData({ origin: info.origin });
    w.profile.permissions.set(info.origin, 'geolocation', undefined);
    for (const p of ['media', 'notifications', 'clipboard-read', 'midi']) w.profile.permissions.set(info.origin, p, undefined);
    w.emit('toast', { text: `Cleared data for ${info.host}` });
    w.hideOverlay();
    w.tabs.reload(false);
  });
  on('site:settings', () => openInternal('lumio://settings/#sites'));

  // ---- account button ----
  handle('account:state', () => account.state());
  on('account:sign-in', (w) => { w.hideOverlay(); signIn(w); });
  on('account:cancel', () => account.cancelSignIn());
  on('account:sign-out', (w) => { w.hideOverlay(); account.signOut(); });
  on('account:open', (w, which) => { w.hideOverlay(); openAccountPage(which, w); });
  on('account:page', (w, which) => {
    w.hideOverlay();
    const pages = { passwords: 'lumio://passwords/', settings: 'lumio://settings/', profile: 'lumio://settings/#profile', plan: 'lumio://settings/#plan' };
    if (pages[which]) openInternal(pages[which]);
  });
  on('account:close-incognito', () => alive().filter((x) => x.incognito).forEach((x) => x.close()));

  // ---- passwords (dropdown under sign-in fields, save prompt) ----
  on('passwords:fill', (w, choice) => passwords.fill(w, choice || {}));
  on('passwords:decide', (w, d) => { w.hideOverlay(); passwords.decide(w, d || {}); });
  handle('passwords:reveal-pending', (w, id) => passwords.revealPending(w, Number(id)));
  on('passwords:manage', (w) => { w.hideOverlay(); openInternal('lumio://passwords/'); });
  on('extensions:manage', () => openInternal('lumio://extensions/'));

  // ---- updates ----
  handle('update:state', () => updater?.state || null);
  on('update:install', (w) => { startUpdate(w); });

  // ---- AI panel ----
  handle('ai:state', (w) => w.ai.state());
  handle('ai:set-key', (w, key) => w.ai.setKey(key));
  handle('ai:clear-key', (w) => w.ai.clearKey());
  handle('ai:models', (w, force) => w.ai.models(force));
  handle('ai:set-model', (w, id) => w.ai.setModel(id));
  handle('ai:set-mode', (w, mode) => w.ai.setMode(mode));
  handle('ai:send', (w, payload) => w.ai.send(payload));
  handle('ai:chats', (w) => w.ai.listChats());
  handle('ai:chat', (w, id) => w.ai.getChat(id));
  handle('ai:delete-chat', (w, id) => w.ai.deleteChat(id));
  on('ai:stop', (w) => w.ai.stop());
  on('ai:approve', (w, { callId, decision }) => w.ai.approve(callId, decision));
  on('ai:mac-permissions-open', (w, which) => w.ai.openMacPermissionSettings(which));
  handle('ai:mac-permissions', (w) => w.ai.macPermissions());
  on('open-url', (w, url) => w.tabs.create(url));

  // ---- internal pages ----
  internalHandle('page:newtab-data', ['newtab'], ({ w }) => ({
    topSites: w.incognito ? [] : topSites(store.history(), 8),
    bookmarks: store.bookmarks().slice(-12).reverse(),
    engine: (SEARCH_ENGINES[store.settings.searchEngine] || SEARCH_ENGINES.google).name,
    hasKey: w.ai.state().hasKey,
    incognito: w.incognito,
  }));
  internalHandle('page:navigate', ALL_PAGES, ({ w, tab }, input) => w.tabs.navigate(input, tab.id));
  internalHandle('page:open', ALL_PAGES, ({ w }, url, disposition) => openUrl(String(url || ''), disposition, w));
  internalHandle('page:ask-ai', ['newtab'], ({ w }, text) => w.askAI(String(text || ''), { includePage: false }));

  internalHandle('page:history', ['history'], () => store.history().slice().reverse());
  internalHandle('page:history-delete', ['history'], (_ctx, what) => store.deleteHistory(what || {}));
  internalHandle('page:history-clear', ['history', 'settings'], () => store.clearHistory());
  internalHandle('page:recently-closed', ['history'], () => recentlyClosed.map((e, index) => ({
    index,
    kind: e.kind,
    title: e.title,
    url: e.url || null,
    favicon: e.favicon || null,
    time: e.time,
    tabs: e.kind === 'window' ? e.tabs.map((t) => ({ title: t.title, url: t.url })) : undefined,
  })).reverse());
  internalHandle('page:reopen-closed', ['history'], (_ctx, index) => reopenClosed(index));
  internalHandle('page:clear-data', ['history', 'settings', 'downloads'], (_ctx, opts) => clearData(opts));

  internalHandle('page:downloads', ['downloads'], ({ w }) => w.profile.downloads.all());
  internalHandle('page:download-action', ['downloads'], ({ w }, id, action) => w.profile.downloads.action(id, action));
  internalHandle('page:downloads-clear', ['downloads'], ({ w }) => w.profile.downloads.clearAll());

  internalHandle('page:bookmarks', ['bookmarks', 'newtab'], () => store.bookmarks());
  internalHandle('page:bookmark-update', ['bookmarks'], (_ctx, url, patch) => { const ok = store.updateBookmark(url, patch || {}); bookmarksChanged(); return ok; });
  internalHandle('page:bookmark-remove', ['bookmarks', 'newtab'], (_ctx, url) => { store.removeBookmark(url); bookmarksChanged(); });
  internalHandle('page:bookmark-move', ['bookmarks'], (_ctx, url, index) => { store.moveBookmark(url, index); bookmarksChanged(); });
  internalHandle('page:bookmarks-export', ['bookmarks'], ({ w }) => exportBookmarks(w));
  internalHandle('page:bookmarks-bar', ['bookmarks'], () => !!store.settings.showBookmarksBar);
  internalHandle('page:set-bookmarks-bar', ['bookmarks', 'settings'], (_ctx, show) => setBookmarksBar(!!show));

  internalHandle('page:extensions', ['extensions'], () => ({
    available: !!extensions?.ece,
    developerMode: !!store.settings.developerMode,
    items: extensions?.ece ? extensions.list() : [],
  }));
  internalHandle('page:extension-toggle', ['extensions'], (_ctx, key, on_) => extensions?.setEnabled(key, !!on_));
  internalHandle('page:extension-remove', ['extensions'], async ({ w }, key, name) => {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove “${name || 'this extension'}”?`,
    });
    if (response !== 0) return false;
    await extensions?.remove(key);
    return true;
  });
  internalHandle('page:extension-reload', ['extensions'], (_ctx, key) => extensions?.reload(key));
  internalHandle('page:extension-load-unpacked', ['extensions'], async ({ w }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openDirectory'], message: 'Choose an extension folder (with manifest.json)' });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    return extensions.loadUnpacked(filePaths[0]);
  });
  internalHandle('page:extension-options', ['extensions'], ({ w }, id, page) => {
    if (!/^[a-p]{32}$/.test(id) || typeof page !== 'string') return;
    w.tabs.create(`chrome-extension://${id}/${page.replace(/^\//, '')}`);
  });
  internalHandle('page:set-developer-mode', ['extensions'], (_ctx, on_) => store.setSetting('developerMode', !!on_));
  internalHandle('page:open-webstore', ['extensions', 'settings'], () => cmd.webStore());

  internalHandle('page:settings', ['settings'], ({ w }) => ({
    account: account.state(),
    profile: profileState(),
    startup: store.settings.startup,
    downloadDir: store.settings.downloadDir || app.getPath('downloads'),
    askDownload: !!store.settings.askDownload,
    offerPasswords: store.settings.offerPasswords !== false,
    autofillPasswords: store.settings.autofillPasswords !== false,
    aiSource: store.settings.aiSource || 'auto',
    platform: process.platform,
    searchEngine: store.settings.searchEngine,
    engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
    approvalMode: store.settings.approvalMode,
    showBookmarksBar: !!store.settings.showBookmarksBar,
    ai: w.ai.state(),
    version: app.getVersion(),
    update: updater?.state || null,
    sourceUrl: SOURCE_URL,
    isDefault: app.isDefaultProtocolClient('https'),
    importSources: importer.detect(),
    sitePermissions: Object.entries(normal.permissions.all()).map(([origin, perms]) => ({ origin, perms })),
  }));
  internalHandle('page:check-updates', ['settings'], () => updater.check({ manual: true }));
  internalHandle('page:update-now', ['settings'], ({ w }) => startUpdate(w));
  internalHandle('page:set-setting', ['settings', 'passwords'], ({ w }, key, value) => {
    if (key === 'searchEngine' && SEARCH_ENGINES[value]) store.setSetting('searchEngine', value);
    if (key === 'approvalMode') w.ai.setMode(value);
    if (key === 'model') w.ai.setModel(value);
    if (key === 'showBookmarksBar') setBookmarksBar(!!value);
    if (key === 'startup' && ['restore', 'newtab'].includes(value)) store.setSetting('startup', value);
    if (key === 'askDownload') store.setSetting('askDownload', !!value);
    if (key === 'offerPasswords') store.setSetting('offerPasswords', !!value);
    if (key === 'autofillPasswords') store.setSetting('autofillPasswords', !!value);
    if (key === 'aiSource' && ['auto', 'lumio', 'openrouter'].includes(value)) store.setSetting('aiSource', value);
    services.broadcastAIState();
  });
  internalHandle('page:set-site-permission', ['settings'], (_ctx, origin, permission, value) => {
    if (typeof origin !== 'string' || typeof permission !== 'string') return;
    normal.permissions.set(origin, permission, value === 'allow' ? true : value === 'block' ? false : undefined);
  });
  internalHandle('page:set-key', ['settings'], ({ w }, key) => w.ai.setKey(key));
  internalHandle('page:clear-key', ['settings'], ({ w }) => { w.ai.clearKey(); });
  internalHandle('page:make-default', ['settings'], () => makeDefaultBrowser());
  internalHandle('page:mac-permissions', ['settings'], ({ w }) => w.ai.macPermissions());
  internalHandle('page:mac-permissions-open', ['settings'], ({ w }, which) => w.ai.openMacPermissionSettings(which));
  internalHandle('page:models', ['settings'], ({ w }, force) => w.ai.models(force));
  internalHandle('page:passwords', ['passwords'], () => passwords.pageState());
  internalHandle('page:password-reveal', ['passwords'], ({ w }, id) => passwords.reveal(w, String(id)));
  internalHandle('page:password-copy', ['passwords'], ({ w }, id) => passwords.copy(w, String(id)));
  internalHandle('page:password-edit', ['passwords'], ({ w }, id, patch) => passwords.edit(w, String(id), patch));
  internalHandle('page:password-add', ['passwords'], (_ctx, entry) => passwords.add(entry));
  internalHandle('page:password-delete', ['passwords'], (_ctx, id) => passwords.store.remove(String(id)));
  internalHandle('page:passwords-import', ['passwords'], ({ w }) => passwords.importFile(w));
  internalHandle('page:passwords-export', ['passwords'], ({ w }) => passwords.exportFile(w));
  internalHandle('page:password-never-remove', ['passwords'], (_ctx, site) => passwords.store.removeNever(String(site)));
  internalHandle('page:password-generate', ['passwords'], () => generatePassword());
  internalHandle('page:account', ['settings', 'newtab'], () => account.state());
  internalHandle('page:account-refresh', ['settings'], () => account.refresh());
  internalHandle('page:account-sign-in', ['settings', 'newtab'], ({ w }) => signIn(w));
  internalHandle('page:account-cancel', ['settings'], () => { account.cancelSignIn(); return account.state(); });
  internalHandle('page:account-sign-out', ['settings'], async () => { await account.signOut(); return account.state(); });
  internalHandle('page:account-open', ['settings', 'newtab'], ({ w }, which) => openAccountPage(String(which), w));
  internalHandle('page:set-profile', ['settings'], (_ctx, patch) => setProfile(patch || {}));
  internalHandle('page:profile-photo', ['settings'], ({ w }) => pickProfilePhoto(w));
  internalHandle('page:choose-download-dir', ['settings'], async ({ w }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.settings.downloadDir || app.getPath('downloads') });
    if (!canceled && filePaths[0]) store.setSetting('downloadDir', filePaths[0]);
    return store.settings.downloadDir || app.getPath('downloads');
  });
  internalHandle('page:import', ['settings'], (_ctx, id, opts) => {
    const res = importer.importFrom(String(id), store, opts || {});
    if (res.ok) bookmarksChanged();
    return res;
  });
}

function siteInfo(w) {
  const tab = w.tabs.active;
  const url = tab ? w.tabs.displayUrl(tab) : '';
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return {
    origin: u.origin,
    host: u.host,
    secure: u.protocol === 'https:',
    incognito: w.incognito,
    permissions: w.profile.permissions.forOrigin(u.origin),
  };
}

async function exportBookmarks(w) {
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: path.join(app.getPath('downloads'), 'lumio-bookmarks.html'),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (canceled || !filePath) return false;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = store.bookmarks().map((b) => `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.round((b.time || Date.now()) / 1000)}">${esc(b.title)}</A>`).join('\n');
  fs.writeFileSync(filePath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${rows}\n</DL><p>\n`);
  return true;
}

function tabContextMenu(w, id) {
  const tab = w.tabs.get(id);
  if (!tab) return;
  const tabs = w.tabs;
  const i = tabs.tabs.indexOf(tab);
  const closedCount = w.incognito ? w.closedTabs.length : recentlyClosed.length;
  Menu.buildFromTemplate([
    { label: 'New Tab to the Right', click: () => tabs.create(NEWTAB, { index: i + 1 }) },
    { type: 'separator' },
    { label: 'Reload', click: () => { tabs.activate(id); tabs.reload(); } },
    { label: 'Duplicate', click: () => tabs.create(tabs.displayUrl(tab) || NEWTAB, { index: i + 1 }) },
    { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => tabs.setPinned(id, !tab.pinned) },
    { label: tab.muted ? 'Unmute Site' : 'Mute Site', click: () => tabs.toggleMute(id) },
    { label: 'Move Tab to New Window', enabled: tabs.tabs.length > 1, click: () => moveTabToNewWindow(w, id) },
    { type: 'separator' },
    { label: 'Close Tab', click: () => tabs.close(id) },
    { label: 'Close Other Tabs', enabled: tabs.tabs.length > 1, click: () => tabs.tabs.filter((t) => t.id !== id && !t.pinned).forEach((t) => tabs.close(t.id)) },
    { label: 'Close Tabs to the Right', enabled: i < tabs.tabs.length - 1, click: () => tabs.tabs.slice(i + 1).forEach((t) => tabs.close(t.id)) },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: closedCount > 0, click: () => reopenClosed() },
  ]).popup({ window: w.win });
}

function bookmarkContextMenu(w, url) {
  const b = store.bookmarks().find((x) => x.url === url);
  if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => openUrl(url, 'current', w) },
    { label: 'Open in New Tab', click: () => openUrl(url, 'tab', w) },
    { label: 'Open in New Window', click: () => openUrl(url, 'window', w) },
    { label: 'Open in Incognito Window', click: () => openUrl(url, 'incognito', w) },
    { type: 'separator' },
    { label: 'Edit…', click: () => openInternal(`lumio://bookmarks/?edit=${encodeURIComponent(url)}`) },
    { label: 'Delete', click: () => { store.removeBookmark(url); bookmarksChanged(); } },
    { type: 'separator' },
    { label: 'Show Bookmarks Bar', type: 'checkbox', checked: !!store.settings.showBookmarksBar, click: () => cmd.toggleBookmarksBar() },
    { label: 'Bookmark Manager', click: () => cmd.bookmarksManager() },
  ]).popup({ window: w.win });
}

// ---------------------------------------------------------------- app
function openExternalUrls(urls) {
  if (!urls.length) return;
  const w = normalWin() || createWindow({ urls });
  if (w.tabs.tabs.some((t) => urls.includes(t.url))) { w.focus(); return; }
  urls.forEach((u) => w.tabs.create(u));
  w.focus();
}

app.on('open-url', (e, url) => {
  e.preventDefault();
  if (store && windows.size) openExternalUrls([url]); else pendingUrls.push(url);
});

app.on('second-instance', (_e, argv) => {
  const urls = argv.filter((a) => /^https?:\/\//.test(a));
  if (urls.length) openExternalUrls(urls); else ensureWin().focus();
});

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), safeStorage);
  helper = new MacHelper();
  app.userAgentFallback = chromeUserAgent();
  registerUiProtocol(session.defaultSession);

  const ses = session.fromPartition('persist:lumio');
  setupTabSession(ses);
  normal = {
    incognito: false,
    session: ses,
    chats: new ChatStore(store.chatsFile),
  };
  normal.downloads = new Downloads(ses, { store, emit: (c, p) => alive().filter((w) => !w.incognito).forEach((w) => w.emit(c, p)) });

  account = new LumioAccount({
    store,
    onChange: (state) => { alive().forEach((w) => w.emit('account', state)); services.broadcastAIState(); },
  });
  account.refresh();
  setInterval(() => { if (account.token()) account.refresh(); }, 10 * 60 * 1000).unref?.();

  passwords = new PasswordManager({
    dir: app.getPath('userData'),
    safeStorage,
    settings: store,
    helper,
    findTab: tabOfWc,
    toast: (w, text) => w.emit('toast', { text }),
  });
  passwords.register();
  screenAura.register();

  // Updates from GitHub Releases (packaged builds; tests point it at a mock).
  const testUpdates = process.env.LUMIO_TEST && process.env.LUMIO_UPDATE_API;
  updater = new Updater({
    currentVersion: app.getVersion(),
    fetchImpl: (url, opts) => net.fetch(url, opts),
    workDir: path.join(app.getPath('temp'), 'Lumio Browser Update'),
    onChange: (state) => alive().forEach((w) => w.emit('update', state)),
    quit: process.env.LUMIO_UPDATE_TARGET && process.env.LUMIO_TEST ? () => {} : () => app.quit(),
    openPath: (file) => shell.openPath(file),
    api: testUpdates ? process.env.LUMIO_UPDATE_API : LATEST,
    ...(process.env.LUMIO_TEST && process.env.LUMIO_UPDATE_TARGET ? { installTarget: process.env.LUMIO_UPDATE_TARGET, fakeExit: true } : {}),
  });
  if (app.isPackaged || testUpdates) {
    setTimeout(() => updater.check(), testUpdates ? 300 : 8000);
    setInterval(() => updater.check(), 6 * 60 * 60 * 1000).unref?.();
  }
  normal.permissions = new Permissions(ses, { store, emitFor, persist: true });

  extensions = new ExtensionManager({
    session: ses,
    store,
    hooks: {
      // Extensions can open tabs and windows, but never Lumio's own pages.
      createTab: (details) => {
        const w = alive().find((x) => x.win.id === details.windowId && !x.incognito) || normalWin() || createWindow();
        const tab = w.tabs.create(extensionUrl(details.url), { active: details.active !== false, index: details.index });
        return [tab.view.webContents, w.win];
      },
      selectTab: (wc) => { const f = tabOfWc(wc); if (f) { f.w.tabs.activate(f.tab.id); f.w.focus(); } },
      removeTab: (wc) => { const f = tabOfWc(wc); if (f) f.w.tabs.close(f.tab.id); },
      createWindow: (details) => {
        const urls = (Array.isArray(details.url) ? details.url : details.url ? [details.url] : []).map(extensionUrl);
        return createWindow({ urls }).win;
      },
      removeWindow: (win) => alive().find((w) => w.win === win)?.close(),
      changed: () => alive().filter((w) => !w.incognito).forEach((w) => w.emit('extensions-changed')),
    },
  });
  // Load extensions before restoring tabs so their content scripts run there,
  // but never hold up the first window for long.
  await Promise.race([
    extensions.init().catch((err) => { console.error('Extensions failed to start:', err); extensions.ece = null; }),
    new Promise((r) => setTimeout(r, 4000)),
  ]);

  registerIpc();
  Menu.setApplicationMenu(buildMenu(cmd, menuState()));

  const saved = store.settings.startup === 'newtab' ? [] : store.sessionWindows();
  if (saved.length) saved.forEach((s) => createWindow({ tabs: s.tabs, active: s.active, bounds: s.bounds }));
  else createWindow();
  // Windows passes links to open on the command line.
  if (process.platform !== 'darwin' && !process.env.LUMIO_TEST) pendingUrls.push(...process.argv.slice(1).filter((a) => /^https?:\/\//i.test(a)));
  if (pendingUrls.length) openExternalUrls(pendingUrls.splice(0));

  app.on('activate', () => { if (!alive().length) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.env.LUMIO_TEST) app.quit();
});

app.on('before-quit', () => {
  saveSession();
  quitting = true;
  for (const w of alive()) w.ai.shutdown();
  helper?.stop();
  store?.flushAll();
});

// Composite screenshot of a window (browser UI + active page) for tests.
async function snapshot(w = cur()) {
  if (!w) return null;
  const { win, overlay, tabs } = w;
  // Round-trip through PNG so every image is a plain 1x bitmap in real pixels.
  const pixels = (img) => nativeImage.createFromBuffer(img.toPNG());
  const base = pixels(await win.webContents.capturePage());
  const { width: W, height: H } = base.getSize();
  const scale = W / win.getContentSize()[0];
  const out = Buffer.from(base.toBitmap());
  const paste = async (view) => {
    const b = view.getBounds();
    const bw = Math.round(b.width * scale);
    const bh = Math.round(b.height * scale);
    const src = pixels(await view.webContents.capturePage()).resize({ width: bw, height: bh }).toBitmap();
    const x0 = Math.round(b.x * scale);
    const y0 = Math.round(b.y * scale);
    for (let y = 0; y < bh && y0 + y < H; y++) {
      for (let x = 0; x < bw && x0 + x < W; x++) {
        const s = (y * bw + x) * 4;
        const a = src[s + 3] / 255;
        if (a === 0) continue;
        const d = ((y0 + y) * W + (x0 + x)) * 4;
        for (let c = 0; c < 3; c++) out[d + c] = Math.round(src[s + c] * a + out[d + c] * (1 - a));
      }
    }
  };
  if (tabs.active?.view) await paste(tabs.active.view);
  const bar = w.indicator?.bar;
  if (bar && win.contentView.children.includes(bar)) await paste(bar);
  if (win.contentView.children.includes(overlay)) await paste(overlay);
  return nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG().toString('base64');
}

// Exposed for tests and debugging (main process only). tabs/ai/win refer to
// the current (last focused) window.
global.lumio = {
  get tabs() { return cur()?.tabs; },
  get ai() { return cur()?.ai; },
  get win() { return cur()?.win; },
  get current() { return cur(); },
  get windows() { return alive(); },
  get store() { return store; },
  get extensions() { return extensions; },
  get account() { return account; },
  get passwords() { return passwords; },
  get profiles() { return { normal, incognito: incog }; },
  get recentlyClosed() { return recentlyClosed; },
  screenAura,
  get updater() { return updater; },
  focus: (w) => { lastFocused = w; },
  createWindow,
  openUrl,
  clearData,
  cmd,
  snapshot,
  BrowserWindow,
};
