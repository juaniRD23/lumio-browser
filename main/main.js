// Lumio Browser — main process entry.
const {
  app, BrowserWindow, ipcMain, session, protocol, Menu, safeStorage, nativeImage, dialog, net, shell, desktopCapturer, webContents, Notification,
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
const { Updater, LATEST, compareVersions } = require('./updater');
const { generatePassword } = require('./passwords');
const importer = require('./importer');
const { Schedules, describe: describeSchedule } = require('./schedules');
const { Workflows } = require('./workflows');

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
let schedules = null; // scheduled tasks (main/schedules.js)
let workflows = null; // saved workflows (main/workflows.js)
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
  setupScreenShare(ses);
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
  get schedules() { return schedules; },
  get workflows() { return workflows; },
  notify: (w, title, body, chatId) => notifyChat(w, title, body, chatId),
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
  onPasskeyPromptClosed: (w) => passwords?.passkeyClosed(w),
  onScreenSharePickerClosed: (w) => shareCancel(w),
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

// A notification about a Lumio chat (scheduled tasks); clicking it opens the
// chat in that window, or the front window if that one closed.
function notifyChat(w, title, body, chatId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title).slice(0, 80), body: String(body || '').slice(0, 240) });
  n.on('click', () => {
    const target = windows.has(w) ? w : alive().find((x) => !x.incognito) || createWindow();
    target.focus();
    target.openChat(chatId, { full: false });
  });
  n.show();
}

// Scheduled tasks: every 20 s, run what's due in a normal window that isn't
// busy (opening one in the background if none is open).
const runningSchedules = new Set();
function runDueSchedules() {
  if (!schedules || quitting || !account?.state().signedIn) return;
  for (const task of schedules.due()) {
    if (runningSchedules.has(task.id)) continue;
    const normalWins = alive().filter((x) => !x.incognito);
    const w = normalWins.find((x) => x === lastFocused && !x.ai.isRunning()) || normalWins.find((x) => !x.ai.isRunning())
      || (normalWins.length ? null : createWindow({ focus: false }));
    if (!w) return; // every window is busy; try again on the next check
    runningSchedules.add(task.id);
    w.ai.runScheduled({ ...task, when: describeSchedule(task) })
      .catch(() => {})
      .finally(() => runningSchedules.delete(task.id));
  }
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
const ACCOUNT_PAGES = { manage: '/account', upgrade: '/account#plans', billing: '/account', home: '/' };

// Signing in happens on lumio-usa.online in a normal tab. When the site's
// session cookie appears in the normal profile, the account adopts it
// (watchLumioCookie) and the sign-in tab closes.
let signInTab = null; // { w, id }
async function signIn(from) {
  const res = account.startSignIn();
  // Already logged in to lumio-usa.online in this browser? Use that session.
  const [existing] = await normal.session.cookies.get({ url: account.base, name: account.cookieName }).catch(() => []);
  if (existing && await account.adopt(existing.value)) return { ok: true };
  const w = from && !from.incognito ? from : normalWin() || createWindow({ urls: [] });
  signInTab = { w, id: w.tabs.create(res.url).id };
  w.focus();
  return res;
}

function watchLumioCookie() {
  normal.session.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !account.pending || cookie.name !== account.cookieName) return;
    if (cookie.domain.replace(/^\./, '') !== account.host) return;
    account.adopt(cookie.value).then((ok) => {
      if (!ok || !signInTab) return;
      const { w, id } = signInTab;
      signInTab = null;
      const tab = !w.closed && w.tabs.get(id);
      // Close the sign-in tab if it's still on the website.
      if (tab && (() => { try { return new URL(w.tabs.displayUrl(tab)).hostname === account.host; } catch { return false; } })()) w.tabs.close(id);
      if (!w.closed) w.emit('toast', { text: 'Signed in to Lumio' });
    }).catch(() => {});
  });
}

// Signing out ends the Lumio session and forgets the website's cookie too.
async function signOutLumio() {
  await account.signOut();
  await normal.session.cookies.remove(account.base, account.cookieName).catch(() => {});
}

function openAccountPage(which, from) {
  const path = ACCOUNT_PAGES[which];
  if (!path) return;
  const w = from && !from.incognito ? from : normalWin() || createWindow({ urls: [] });
  w.tabs.create(account.url(path));
  w.focus();
}

// ---------------------------------------------------------------- plan and billing (Settings)
// The Lumio server talks to Stripe; Settings shows the plan, switches it,
// cancels (with a reason) or resumes it.
async function billingCall(path, body) {
  if (!account.token()) return { ok: false, error: 'Sign in to Lumio first.' };
  const r = await account.api(path, body ? { method: 'POST', body } : {}).catch(() => null);
  if (!r) return { ok: false, error: 'Couldn’t reach Lumio. Check your internet connection.' };
  if (r.status === 401) return { ok: false, error: 'Sign in to Lumio again (Settings › Lumio account).' };
  if (!r.ok) return { ok: false, error: r.data?.error || 'That didn’t work. Try again.' };
  if (body) await account.refresh().catch(() => {});
  return { ...r.data, ok: true };
}

// Subscribing happens in a Lumio window over the browser: Lumio's own
// /checkout page with Stripe's payment form inside it, never a trip to
// Stripe's site. Resolves when the window closes (the page closes itself
// after a successful payment), so Settings can show the new plan.
let checkoutWin = null;
async function openCheckout(w, plan) {
  if (!['plus', 'pro', 'max'].includes(plan)) return { ok: false, error: 'Choose Plus, Pro or Max.' };
  if (checkoutWin && !checkoutWin.isDestroyed()) { checkoutWin.focus(); return { ok: false, error: 'The payment window is already open.' }; }
  const token = account.token();
  if (!token) return { ok: false, error: 'Sign in to Lumio first.' };
  // The window uses the normal profile, signed in to the website as this account.
  await normal.session.cookies.set({
    url: account.base, name: account.cookieName, value: token, path: '/', httpOnly: true, sameSite: 'lax',
    secure: account.base.startsWith('https:'), expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
  }).catch(() => {});
  const [pw, ph] = w.win.getContentSize();
  const win = new BrowserWindow({
    parent: w.win, modal: true, show: false, width: Math.max(420, Math.min(980, pw - 40)), height: Math.max(520, Math.min(780, ph - 30)),
    minWidth: 400, minHeight: 480, title: 'Subscribe to Lumio', backgroundColor: '#070708', autoHideMenuBar: true,
    webPreferences: { session: normal.session, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  checkoutWin = win;
  const wc = win.webContents;
  // Links (terms, receipts) open in a normal tab; the window itself only goes to secure pages.
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) w.tabs.create(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!/^https:\/\//.test(url) && !url.startsWith(account.base)) e.preventDefault(); });
  win.once('ready-to-show', () => win.show());
  const closed = new Promise((resolve) => win.on('closed', resolve));
  win.loadURL(account.url(`/checkout?plan=${plan}&app=1`)).catch(() => {});
  await closed;
  checkoutWin = null;
  await account.refresh().catch(() => {});
  return { ok: true, plan: account.state().plan };
}

// Updating the card: Stripe's billing portal, in the same kind of window.
async function openCardWindow(w) {
  const r = await billingCall('/api/billing/portal', {});
  if (!r.ok || !r.url) return r.ok ? { ok: false, error: 'Billing isn’t available right now.' } : r;
  const [pw, ph] = w.win.getContentSize();
  const win = new BrowserWindow({
    parent: w.win, modal: true, width: Math.max(420, Math.min(900, pw - 40)), height: Math.max(520, Math.min(760, ph - 30)),
    title: 'Card and invoices', backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { session: normal.session, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) w.tabs.create(url); return { action: 'deny' }; });
  // Stripe's "Return to Lumio" link ends the visit.
  win.webContents.on('will-navigate', (e, url) => { if (url.startsWith(account.base)) { e.preventDefault(); win.close(); } });
  const closed = new Promise((resolve) => win.on('closed', resolve));
  win.loadURL(r.url).catch(() => {});
  await closed;
  await account.refresh().catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------- screen sharing
// getDisplayMedia (Google Meet, Zoom, Discord on the web). macOS 15+ shows its
// own picker (no Screen Recording permission needed); elsewhere Lumio shows
// the screens and windows to choose from, over the tab that asked.
const sharePending = new Map(); // id -> { callback, w, audio }
let nextShareId = 1;
function setupScreenShare(ses) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const wc = request.frame ? webContents.fromFrame(request.frame) : null;
    const w = wc && alive().find((x) => x.tabs.byWebContents(wc));
    const tab = w?.tabs.byWebContents(wc);
    if (!w || !tab) return callback({});
    let sources = [];
    try { sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } }); } catch { /* no permission */ }
    sources = sources.filter((s) => !/^Lumio Browser/.test(s.name) || s.id.startsWith('screen:'));
    if (!sources.length) {
      w.emit('toast', { text: process.platform === 'darwin' ? 'To share your screen, turn on Lumio Browser in System Settings › Privacy & Security › Screen Recording.' : 'Nothing to share right now.' });
      return callback({});
    }
    shareCancel(w);
    const id = nextShareId++;
    sharePending.set(id, { callback, w, audio: !!request.audioRequested, sources });
    let host = '';
    try { host = new URL(request.securityOrigin || wc.getURL()).host; } catch { /* keep empty */ }
    const b = tab.view?.getBounds() || { x: 0, y: 90, width: 900, height: 600 };
    const width = Math.min(560, b.width - 24);
    w.showOverlay(
      { x: b.x + Math.round((b.width - width) / 2), y: b.y + 12, width, height: Math.min(520, b.height - 24) },
      {
        kind: 'screenshare',
        share: {
          id, host,
          sources: sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() })),
        },
      },
    );
  }, { useSystemPicker: true });
}
function shareAnswer(id, sourceId) {
  const p = sharePending.get(id);
  if (!p) return;
  sharePending.delete(id);
  const source = sourceId && p.sources.find((s) => s.id === sourceId);
  // System audio can only be shared on Windows (loopback).
  p.callback(source ? { video: source, ...(p.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) } : {});
}
function shareCancel(w) {
  for (const [id, p] of sharePending) if (p.w === w) shareAnswer(id, null);
}

function profileState() { return { ...store.settings.profile }; }
const firstName = (name) => String(name || '').trim().split(/\s+/)[0].slice(0, 40) || null;

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
// confirmed: the person already chose "Update now" in the What's new card, so
// only ask again if Lumio AI is in the middle of a task.
async function startUpdate(w, { confirmed = false } = {}) {
  if (!updater || ['downloading', 'installing'].includes(updater.state.status)) return updater?.state || null;
  try { await updater.download(); } catch { return updater.state; }
  const working = alive().some((x) => x.ai.isRunning());
  if (!process.env.LUMIO_TEST && (!confirmed || working)) {
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

// A new version shows its What's new card once (urgent ones every launch
// until installed), in the window the person is using.
const announced = new Set();
function announceUpdate(state) {
  if (state.status !== 'available' || !state.latest || announced.has(state.latest)) return;
  if (!state.critical && store.settings.updateAnnounced === state.latest) return;
  announced.add(state.latest);
  if (!state.critical) store.setSetting('updateAnnounced', state.latest);
  const w = lastFocused && !lastFocused.win.isDestroyed() && !lastFocused.incognito ? lastFocused : alive().find((x) => !x.incognito);
  setTimeout(() => w?.emit('update-announce', state), 1200);
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

const ALL_PAGES = ['newtab', 'error', 'history', 'settings', 'downloads', 'bookmarks', 'extensions', 'passwords', 'welcome'];

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
  on('panel:full', (w, { on: covered, slot } = {}) => w.tabs.setCovered(!!covered, slot && Number.isFinite(slot.width) ? slot : null));
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
    if (item?.kind === 'screenshare') {
      const p = sharePending.get(Number(item.id));
      if (p?.w === w) shareAnswer(Number(item.id), typeof item.source === 'string' ? item.source : null);
    }
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
  on('account:sign-out', (w) => { w.hideOverlay(); signOutLumio(); });
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
  on('passwords:passkey', (w, d) => passwords.passkeyDecide(w, d || {}));
  handle('passwords:reveal-pending', (w, id) => passwords.revealPending(w, Number(id)));
  on('passwords:manage', (w) => { w.hideOverlay(); openInternal('lumio://passwords/'); });
  on('extensions:manage', () => openInternal('lumio://extensions/'));

  // ---- updates ----
  handle('update:state', () => updater?.state || null);
  on('update:install', (w) => { startUpdate(w); });
  on('update:now', (w) => { w.hideOverlay(); startUpdate(w, { confirmed: true }); });
  on('update:later', (w) => { w.hideOverlay(); });

  // ---- AI panel ----
  handle('ai:state', (w) => w.ai.state());
  handle('ai:set-reasoning', (w, id) => w.ai.setReasoning(id));
  handle('ai:set-mode', (w, mode) => w.ai.setMode(mode));
  handle('ai:send', (w, payload) => w.ai.send(payload));
  handle('ai:steer', (w, payload) => w.ai.steer(payload || {}));
  handle('ai:workflows', (w) => (w.incognito ? [] : workflows.list()));
  handle('ai:chats', (w) => w.ai.listChats());
  handle('ai:chat', (w, id) => w.ai.getChat(id));
  handle('ai:delete-chat', (w, id) => w.ai.deleteChat(id));
  handle('ai:connections', (w) => w.ai.connections());
  handle('ai:set-app', (w, name, on) => w.ai.setApp(String(name || ''), !!on));
  handle('ai:extract', (w, file) => w.ai.extractOffice(file || {}));
  handle('ai:voice-transcribe', (w, payload) => w.ai.transcribe(payload || {}));
  handle('ai:voice-speak', (w, payload) => w.ai.speak(payload || {}));
  handle('ai:tab-pdf', (w, tabId) => require('./ai/tools/browser').tabPdf(w.tabs, Number.isSafeInteger(tabId) ? tabId : null));
  on('ai:doc-built', (w, result) => w.ai.docBuilt(result || {}));
  on('ai:connect', (w, id) => { if (/^[a-z_]{2,40}$/.test(String(id))) w.tabs.create(`${account.base}/api/connect/${id}/start?next=/account`); });
  on('ai:open-file', (w, p) => { if (w.ai.ownsFile(p)) shell.openPath(p); });
  on('ai:show-file', (w, p) => { if (w.ai.ownsFile(p)) shell.showItemInFolder(p); });
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
    aiReady: w.ai.state().ready,
    incognito: w.incognito,
    // "Good morning, Juan": the profile name they chose, else their Lumio account name.
    name: firstName(store.settings.profile?.name || account.state().name),
    chats: w.incognito ? [] : w.ai.listChats().slice(0, 3),
  }));
  internalHandle('page:open-chat', ['newtab'], ({ w }, id) => w.openChat(String(id || '')));
  internalHandle('page:navigate', ALL_PAGES, ({ w, tab }, input) => w.tabs.navigate(input, tab.id));
  internalHandle('page:open', ALL_PAGES, ({ w }, url, disposition) => openUrl(String(url || ''), disposition, w));
  internalHandle('page:ask-ai', ['newtab'], ({ w }, text) => w.askAI(String(text || ''), { includePage: false, full: true }));

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
    memorySaver: store.settings.memorySaver !== false,
    memorySaverMinutes: store.settings.memorySaverMinutes || 60,
    offerPasswords: store.settings.offerPasswords !== false,
    autofillPasswords: store.settings.autofillPasswords !== false,
    platform: process.platform,
    searchEngine: store.settings.searchEngine,
    engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
    approvalMode: store.settings.approvalMode,
    showBookmarksBar: !!store.settings.showBookmarksBar,
    ai: w.ai.state(),
    version: app.getVersion(),
    update: updater?.state || null,
    isDefault: app.isDefaultProtocolClient('https'),
    importSources: importer.detect(),
    sitePermissions: Object.entries(normal.permissions.all()).map(([origin, perms]) => ({ origin, perms })),
  }));
  // Saved workflows (Settings › Workflows, and the new tab page)
  internalHandle('page:workflows', ['settings', 'newtab'], () => ({ workflows: workflows.list() }));
  internalHandle('page:workflow-update', ['settings'], (_ctx, id, patch) => { try { return { ok: true, workflow: workflows.update(String(id), patch || {}) }; } catch (err) { return { ok: false, error: err.message }; } });
  internalHandle('page:workflow-remove', ['settings'], (_ctx, id) => ({ ok: workflows.remove(String(id)) }));
  // Running one happens in the panel, which asks for any blanks first.
  internalHandle('page:workflow-run', ['settings', 'newtab'], ({ w }, id) => {
    if (!workflows.get(String(id))) return { ok: false, error: 'That workflow doesn’t exist anymore.' };
    store.setSetting('panelOpen', true);
    w.emit('ai-workflow', { id: String(id) });
    w.win.webContents.focus();
    return { ok: true };
  });

  // Scheduled tasks (Settings › Scheduled tasks)
  const scheduleReply = (fn) => { try { return { ok: true, ...fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  internalHandle('page:schedules', ['settings'], () => ({ tasks: schedules.list(), signedIn: !!account.state().signedIn }));
  internalHandle('page:schedule-add', ['settings'], (_ctx, spec) => scheduleReply(() => ({ task: schedules.add(spec || {}) })));
  internalHandle('page:schedule-update', ['settings'], (_ctx, id, patch) => scheduleReply(() => ({ task: schedules.update(String(id), patch || {}) })));
  internalHandle('page:schedule-remove', ['settings'], (_ctx, id) => ({ ok: schedules.remove(String(id)) }));
  internalHandle('page:schedule-run', ['settings'], ({ w }, id) => {
    const task = schedules.get(String(id));
    if (!task) return { ok: false, error: 'That scheduled task doesn’t exist anymore.' };
    if (runningSchedules.has(task.id) || w.ai.isRunning()) return { ok: false, error: 'Lumio is busy right now. Try again when it’s done.' };
    runningSchedules.add(task.id);
    w.ai.runScheduled({ ...task, when: describeSchedule(task), manual: true }).catch(() => {}).finally(() => runningSchedules.delete(task.id));
    return { ok: true };
  });
  internalHandle('page:schedule-open', ['settings'], ({ w }, id) => {
    const chatId = schedules.get(String(id))?.lastChatId;
    return { ok: !!chatId && w.openChat(chatId, { full: false }) };
  });
  internalHandle('page:check-updates', ['settings'], () => updater.check({ manual: true }));
  internalHandle('page:update-now', ['settings'], ({ w }) => startUpdate(w));
  internalHandle('page:set-setting', ['settings', 'passwords'], ({ w }, key, value) => {
    if (key === 'searchEngine' && SEARCH_ENGINES[value]) store.setSetting('searchEngine', value);
    if (key === 'approvalMode') w.ai.setMode(value);
    if (key === 'reasoning') w.ai.setReasoning(value);
    if (key === 'showBookmarksBar') setBookmarksBar(!!value);
    if (key === 'startup' && ['restore', 'newtab'].includes(value)) store.setSetting('startup', value);
    if (key === 'askDownload') store.setSetting('askDownload', !!value);
    if (key === 'offerPasswords') store.setSetting('offerPasswords', !!value);
    if (key === 'autofillPasswords') store.setSetting('autofillPasswords', !!value);
    if (key === 'memorySaver') store.setSetting('memorySaver', !!value);
    if (key === 'memorySaverMinutes' && [15, 30, 60, 120, 240].includes(Number(value))) store.setSetting('memorySaverMinutes', Number(value));
    services.broadcastAIState();
  });
  internalHandle('page:set-site-permission', ['settings'], (_ctx, origin, permission, value) => {
    if (typeof origin !== 'string' || typeof permission !== 'string') return;
    normal.permissions.set(origin, permission, value === 'allow' ? true : value === 'block' ? false : undefined);
  });
  internalHandle('page:make-default', ['settings', 'welcome'], () => makeDefaultBrowser());
  internalHandle('page:mac-permissions', ['settings'], ({ w }) => w.ai.macPermissions());
  internalHandle('page:mac-permissions-open', ['settings'], ({ w }, which) => w.ai.openMacPermissionSettings(which));
  internalHandle('page:passwords', ['passwords'], () => passwords.pageState());
  internalHandle('page:password-reveal', ['passwords'], ({ w }, id) => passwords.reveal(w, String(id)));
  internalHandle('page:password-copy', ['passwords'], ({ w }, id) => passwords.copy(w, String(id)));
  internalHandle('page:password-edit', ['passwords'], ({ w }, id, patch) => passwords.edit(w, String(id), patch));
  internalHandle('page:password-add', ['passwords'], (_ctx, entry) => passwords.add(entry));
  internalHandle('page:password-delete', ['passwords'], (_ctx, id) => passwords.store.remove(String(id)));
  internalHandle('page:passkey-delete', ['passwords'], async ({ w }, id) => ((await passwords.authorize(w, 'delete a passkey')) ? passwords.passkeys.remove(String(id)) : false));
  internalHandle('page:passwords-import', ['passwords'], ({ w }) => passwords.importFile(w));
  internalHandle('page:passwords-export', ['passwords'], ({ w }) => passwords.exportFile(w));
  internalHandle('page:password-never-remove', ['passwords'], (_ctx, site) => passwords.store.removeNever(String(site)));
  internalHandle('page:password-generate', ['passwords'], () => generatePassword());
  internalHandle('page:account', ['settings', 'newtab', 'welcome'], () => account.state());
  internalHandle('page:account-refresh', ['settings'], () => account.refresh());
  internalHandle('page:account-sign-in', ['settings', 'newtab', 'welcome'], ({ w }) => signIn(w));
  internalHandle('page:account-cancel', ['settings'], () => { account.cancelSignIn(); return account.state(); });
  internalHandle('page:account-sign-out', ['settings'], async () => { await signOutLumio(); return account.state(); });
  internalHandle('page:account-open', ['settings', 'newtab'], ({ w }, which) => openAccountPage(String(which), w));
  internalHandle('page:billing', ['settings'], () => billingCall('/api/billing/subscription'));
  internalHandle('page:billing-change', ['settings'], (_ctx, plan) => billingCall('/api/billing/change', { plan: String(plan || '') }));
  internalHandle('page:billing-cancel', ['settings'], (_ctx, form) => billingCall('/api/billing/cancel', { reason: String(form?.reason || ''), comment: String(form?.comment || '').slice(0, 1000) }));
  internalHandle('page:billing-resume', ['settings'], () => billingCall('/api/billing/resume', {}));
  internalHandle('page:billing-subscribe', ['settings'], ({ w }, plan) => openCheckout(w, String(plan || '')));
  internalHandle('page:billing-card', ['settings'], ({ w }) => openCardWindow(w));
  internalHandle('page:set-profile', ['settings'], (_ctx, patch) => setProfile(patch || {}));
  internalHandle('page:profile-photo', ['settings'], ({ w }) => pickProfilePhoto(w));
  internalHandle('page:choose-download-dir', ['settings'], async ({ w }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.settings.downloadDir || app.getPath('downloads') });
    if (!canceled && filePaths[0]) store.setSetting('downloadDir', filePaths[0]);
    return store.settings.downloadDir || app.getPath('downloads');
  });
  internalHandle('page:import', ['settings', 'welcome'], async (_ctx, id, opts) => {
    const o = opts || {};
    // Tests use a known key instead of the macOS Keychain.
    const secret = process.env.LUMIO_TEST ? process.env.LUMIO_IMPORT_SECRET : undefined;
    const res = await importer.importFrom(String(id), { store, passwordStore: passwords.store }, { bookmarks: o.bookmarks !== false, history: o.history !== false, passwords: !!o.passwords, ...(secret ? { secret } : {}) });
    if (res.ok) bookmarksChanged();
    return res;
  });
  internalHandle('page:import-sources', ['settings', 'welcome'], () => importer.detect());
  // An exported file: Safari/Chrome bookmarks (HTML) or passwords (CSV).
  internalHandle('page:import-file', ['settings', 'welcome'], async ({ w }, kind) => {
    const bookmarks = kind === 'bookmarks';
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
      properties: ['openFile'],
      filters: bookmarks ? [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }] : [{ name: 'Passwords (CSV)', extensions: ['csv'] }],
      message: bookmarks ? 'Choose the bookmarks file you exported (in Safari: File › Export › Bookmarks)' : 'Choose the passwords file you exported (in Safari: File › Export › Passwords)',
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const text = fs.readFileSync(filePaths[0], 'utf8');
      if (bookmarks) {
        const added = store.importBookmarks(importer.parseBookmarksHtml(text));
        bookmarksChanged();
        return { ok: true, bookmarks: added };
      }
      return { ok: true, passwords: passwords.store.importCsv(text) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Safari's files need Full Disk Access: open that page of System Settings.
  internalHandle('page:open-disk-access', ['settings', 'welcome'], () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'));

  // ---- first-run welcome ----
  internalHandle('page:welcome-state', ['welcome'], () => ({ platform: process.platform, sources: importer.detect(), account: account.state() }));
  // Lumio's own Keychain item (saved passwords and sign-ins): touching it now
  // makes macOS ask while the welcome screen explains what to click.
  internalHandle('page:keychain-check', ['welcome'], () => {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false };
    try {
      const probe = safeStorage.encryptString('lumio-keychain-check');
      return { ok: safeStorage.decryptString(probe) === 'lumio-keychain-check' };
    } catch { return { ok: false }; }
  });
  internalHandle('page:welcome-done', ['welcome'], ({ w, tab }) => {
    store.setSetting('onboarded', true);
    store.setSetting('panelOpen', true);
    w.tabs.navigate('lumio://newtab/', tab.id);
    w.emit('panel-open');
    return true;
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
  // Lumio's own UI (the window and its popups) may use the microphone for
  // voice mode in the AI panel, and no other device. Everything else keeps
  // Electron's defaults.
  const isShell = (wc) => !!wc && alive().some((w) => w.win.webContents === wc);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') return callback(true);
    const audioOnly = (details.mediaTypes || []).length > 0 && details.mediaTypes.every((t) => t === 'audio');
    callback(audioOnly && isShell(wc) && String(details.requestingUrl || '').startsWith('lumio://shell/'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => permission !== 'media' || (isShell(wc) && String(origin).startsWith('lumio://shell')));

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
    onChange: (state) => { alive().forEach((w) => { w.emit('account', state); w.ai.refreshCapabilities(); }); services.broadcastAIState(); },
  });
  account.refresh();
  watchLumioCookie();
  setInterval(() => { if (account.token()) account.refresh(); }, 10 * 60 * 1000).unref?.();
  workflows = new Workflows(app.getPath('userData'));
  workflows.onChange(() => alive().forEach((w) => w.emit('workflows-changed', {})));
  schedules = new Schedules(app.getPath('userData'));
  schedules.onChange(() => alive().forEach((w) => w.emit('schedules-changed', {})));
  setInterval(runDueSchedules, 20 * 1000).unref?.();
  setTimeout(runDueSchedules, 8000).unref?.(); // catch up after launch, once tabs and sign-in are back
  // Memory Saver: once a minute, tabs nobody has looked at for a while go to sleep.
  setInterval(() => {
    if (!store.settings.memorySaver) return;
    const minutes = Math.max(5, Number(store.settings.memorySaverMinutes) || 60);
    for (const w of alive()) if (!w.ai?.isRunning()) w.tabs.sleepIdle(minutes);
  }, 60 * 1000).unref?.();

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
    onChange: (state) => { alive().forEach((w) => w.emit('update', state)); announceUpdate(state); },
    quit: process.env.LUMIO_UPDATE_TARGET && process.env.LUMIO_TEST ? () => {} : () => app.quit(),
    openPath: (file) => shell.openPath(file),
    api: testUpdates ? process.env.LUMIO_UPDATE_API : LATEST,
    ...(process.env.LUMIO_TEST && process.env.LUMIO_UPDATE_TARGET ? { installTarget: process.env.LUMIO_UPDATE_TARGET, fakeExit: true } : {}),
  });
  if (app.isPackaged || testUpdates) {
    setTimeout(() => updater.check(), testUpdates ? 300 : 8000);
    setInterval(() => updater.check(), 60 * 60 * 1000).unref?.(); // every hour (GitHub allows 60/hour)
  }
  // Just updated? Say so once, with what's new.
  const lastVersion = store.settings.lastVersion;
  if (lastVersion && compareVersions(app.getVersion(), lastVersion) > 0) {
    setTimeout(() => { const w = lastFocused && !lastFocused.win.isDestroyed() ? lastFocused : alive()[0]; w?.emit('toast', { text: `Updated to Lumio Browser ${app.getVersion()}` }); }, 2500);
  }
  if (lastVersion !== app.getVersion()) store.setSetting('lastVersion', app.getVersion());
  normal.permissions = new Permissions(ses, { store, emitFor, persist: true });
  setupScreenShare(ses);

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
  // First launch: the welcome screens (people updating from an older version
  // already have history, bookmarks or tabs, and skip them).
  if (store.settings.onboarded !== true && (saved.length || store.history().length || store.bookmarks().length)) store.setSetting('onboarded', true);
  if (store.settings.onboarded !== true && (!process.env.LUMIO_TEST || process.env.LUMIO_TEST_WELCOME)) {
    store.setSetting('panelOpen', false);
    createWindow({ tabs: [{ url: 'lumio://welcome/', title: 'Welcome to Lumio Browser' }], active: 0 });
  } else if (saved.length) saved.forEach((s) => createWindow({ tabs: s.tabs, active: s.active, bounds: s.bounds }));
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
  get workflows() { return workflows; },
  get schedules() { return schedules; },
  get profiles() { return { normal, incognito: incog }; },
  get recentlyClosed() { return recentlyClosed; },
  screenAura,
  get updater() { return updater; },
  signIn: (w) => signIn(w || cur()),
  focus: (w) => { lastFocused = w; },
  createWindow,
  openUrl,
  clearData,
  cmd,
  snapshot,
  BrowserWindow,
};
