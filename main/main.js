// Lumio Browser — main process entry.
const {
  app, BrowserWindow, ipcMain, session, protocol, Menu, safeStorage, nativeImage, dialog, net, shell, desktopCapturer, webContents, Notification, nativeTheme,
} = require('electron');
const fs = require('fs');
const path = require('path');

const FLAVOR = require('./flavor');

// Lumio Beta keeps its own profile (bookmarks, sign-in, settings) next to the normal app's.
if (process.env.LUMIO_USER_DATA) app.setPath('userData', process.env.LUMIO_USER_DATA);
else if (FLAVOR.beta) app.setPath('userData', path.join(app.getPath('appData'), FLAVOR.name));
if (process.env.LUMIO_DOWNLOADS) app.setPath('downloads', process.env.LUMIO_DOWNLOADS); // tests
app.setName(FLAVOR.name);

// Before Electron starts: Lumio's language and graphics acceleration
// (Settings › Languages and › System), which apply from launch.
const started = require('./system').readEarly(app.getPath('userData'));
require('./i18n').init(app, started.uiLanguage);
if (!started.hardwareAcceleration) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  { scheme: 'lumio', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const { Store, SEARCH_ENGINES } = require('./store');
const { NEWTAB } = require('./tabs');
const { BrowserWin } = require('./window');
const { registerUiProtocol, registerPagesProtocol } = require('./protocol');
const theme = require('./theme');
const { chromeUserAgent, Downloads, Permissions } = require('./features');
const { buildMenu, buildBrowserMenu } = require('./menu');
const { suggest, topSites } = require('./omnibox');
const { ChatStore } = require('./ai/chats');
const { MacHelper } = require('./mac/helper');
const { ExtensionManager } = require('./extensions');
const { LumioAccount } = require('./account');
const { PasswordManager } = require('./password-manager');
const screenAura = require('./ai/screen-aura');
const { Updater, LATEST, BETAS, compareVersions } = require('./updater');
const { generatePassword } = require('./passwords');
const importer = require('./importer');
const { Schedules, describe: describeSchedule } = require('./schedules');
const { Workflows } = require('./workflows');
const { SiteTips } = require('./site-tips');
const { Projects } = require('./projects');
const { SyncEngine } = require('./sync/engine');
const syncAdapters = require('./sync/adapters');
const { CompanionBridge } = require('./sync/companion');
const { ProfileRegistry, DEFAULT_PROFILE } = require('./profiles');
const { PerformanceManager } = require('./perf');
const { TaskManager } = require('./task-manager');
const { ProfilePicker } = require('./picker');
const { PrintPreview } = require('./print');
const { System } = require('./system');
const languages = require('./languages');
const { t } = require('./i18n');

const IS_DEV = !app.isPackaged;

// A stray error in a callback shouldn't freeze the browser behind Electron's
// modal error box: log it and keep going.
process.on('uncaughtException', (err) => console.error('[lumio] uncaught exception:', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('[lumio] unhandled rejection:', err?.stack || err));

if (!process.env.LUMIO_TEST && !app.requestSingleInstanceLock()) app.quit();
// Windows shows an app's notifications only under its app ID, matched by its
// Start menu shortcut (set below). The Microsoft Store version has its own.
const WIN_APP_ID = 'online.lumio-usa.browser';
if (process.platform === 'win32' && !process.windowsStore) app.setAppUserModelId(WIN_APP_ID);

// What Lumio was asked to open: web addresses, and web pages or PDFs on disk
// ("Open with Lumio Browser" on Windows).
function launchTargets(argv) {
  const out = [];
  for (const a of argv) {
    if (/^https?:\/\//i.test(a)) out.push(a);
    else if (/\.(html?|xhtml|pdf|svg|webp)$/i.test(a) && !a.startsWith('-')) {
      try { if (fs.statSync(a).isFile()) out.push(require('url').pathToFileURL(path.resolve(a)).href); } catch { /* not a file */ }
    }
  }
  return out;
}

// Each profile (main/profiles.js) opens as { id, session, store, chats,
// downloads, permissions, account, passwords, sync, companion, extensions,
// schedules, workflows, siteTips, projects } (openProfile). A window's
// profile is w.profile; an incognito window's is an in-memory copy of its
// profile's (with .base pointing back), and Guest is a profile of its own.
let rootStore = null; // the first profile's settings, which also hold the app-wide ones (appearance, performance, updates)
let profiles = null; // the list of profiles
const loaded = new Map(); // profile id -> the open profile
let guest = null; // the Guest profile, while a Guest window is open
let helper = null;
let incogSeq = 0;
let updater = null;
let perf = null; // Settings › Performance (main/perf.js)
let taskManager = null;
let picker = null; // "Who's using Lumio?"
let printPreview = null; // File › Print… (main/print.js)
let system = null; // Settings › System (main/system.js)
let quitting = false;
const windows = new Set();
let lastFocused = null;
const recentlyClosed = []; // newest last: { kind: 'tab' | 'window', ... }
const pendingUrls = [];

// ---------------------------------------------------------------- windows
const alive = () => [...windows].filter((w) => !w.closed && !w.closing);
const cur = () => (lastFocused && !lastFocused.closed && !lastFocused.closing ? lastFocused : alive().at(-1)) || null;
// The profile a command is for: the front window's, else the last one used.
const curProfile = () => cur()?.profile.base || openProfile(profiles.lastUsed());
const normalWin = (base = curProfile()) => { const c = cur(); return c && !c.incognito && c.profile === base ? c : alive().reverse().find((w) => !w.incognito && w.profile === base) || null; };
const profileWindows = (p) => alive().filter((w) => w.profile.base === p.base);
const ensureWin = () => cur() || createWindow();
const windowOfWc = (wc) => alive().find((w) => w.win.webContents === wc || w.overlay.webContents === wc || w.indicator?.bar?.webContents === wc) || null;
const tabOfWc = (wc) => {
  for (const w of alive()) {
    const tab = w.tabs.byWebContents(wc);
    if (tab) return { w, tab };
  }
  return null;
};

function setupTabSession(ses, { incognito = false } = {}) {
  ses.setUserAgent(app.userAgentFallback);
  registerPagesProtocol(ses, { dark: incognito });
}

// Each profile's incognito windows share one in-memory session, wiped when
// the last one closes. Bookmarks, passwords and the Lumio account are the profile's.
function incognitoProfile(base) {
  if (base.incog) return base.incog;
  const partition = `lumio-incognito-${++incogSeq}`; // in memory only
  const ses = session.fromPartition(partition);
  setupTabSession(ses, { incognito: true });
  const detachLanguages = languages.attach(ses, base.store, app);
  const profile = { ...base, incognito: true, base, incog: null, partition, session: ses, chats: new ChatStore(null), detachLanguages };
  profile.downloads = new Downloads(ses, { settings: base.store, emit: (c, p) => alive().filter((w) => w.profile === profile).forEach((w) => w.emit(c, p)) });
  profile.permissions = new Permissions(ses, { store: base.store, emitFor, persist: false });
  setupScreenShare(ses);
  base.incog = profile;
  return profile;
}

function endIncognito(base) {
  const p = base.incog;
  base.incog = null;
  if (!p) return;
  p.detachLanguages();
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
  get helper() { return helper; },
  notify: (w, title, body, chatId) => { notifyChat(w, title, body, chatId); w.profile.companion?.notice({ title, body, chatId, hint: /needs your OK/.test(title) ? 'approval' : 'scheduled' }); },
  onEmit: (w, channel, payload) => w.profile.companion?.onEmit(w, channel, payload),
  createWindow: (opts) => createWindow(opts),
  onFocus: (w) => {
    const switched = lastFocused?.profile.base !== w.profile.base;
    lastFocused = w;
    if (!w.profile.guest) profiles.setLastUsed(w.profile.id);
    if (switched) menuChanged(); // the menu shows this profile's bookmarks bar and closed tabs
  },
  onClose: (w) => {
    if (quitting || w.incognito || w.profile.guest || !w.tabs.tabs.length) return;
    recentlyClosed.push({ kind: 'window', profileId: w.profile.id, ...w.session(), title: w.tabs.active?.title || 'Window', time: Date.now() });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    menuChanged();
  },
  onClosed: (w) => {
    windows.delete(w);
    if (lastFocused === w) lastFocused = null;
    if (w.incognito && !alive().some((x) => x.profile === w.profile)) endIncognito(w.profile.base);
    if (w.profile.guest && !alive().some((x) => x.profile === w.profile)) endGuest();
    saveSession();
  },
  onTabClosed: (w, entry) => {
    if (quitting || w.closing) return;
    if (w.incognito || w.profile.guest) {
      w.closedTabs.push(entry);
      if (w.closedTabs.length > 25) w.closedTabs.shift();
      return;
    }
    recentlyClosed.push({ kind: 'tab', profileId: w.profile.id, ...entry, windowId: w.id, time: Date.now() });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    menuChanged();
  },
  onSessionChanged: () => saveSession(),
  onViewCreated: (w, tab) => { if (!w.incognito && tab.view) w.profile.extensions?.addTab(tab.view.webContents, w.win); },
  onPasskeyPromptClosed: (w) => w.profile.passwords?.passkeyClosed(w),
  onScreenSharePickerClosed: (w) => shareCancel(w),
  onTabActivated: (w, tab) => { if (!w.incognito && tab.view) w.profile.extensions?.selectTab(tab.view.webContents); printPreview?.tabActivated(w, tab); },
  print: (w, tab) => printPreview.open(w, tab),
  savePage: (w, tab) => savePage(w, tab),
  contextMenuExtras: (w, tab, params) => (w.incognito || !tab.view ? [] : w.profile.extensions?.contextMenuItems(tab.view.webContents, params) || []),
  broadcastAIState: () => alive().forEach((w) => w.ai.emitState()),
};

// Windows: the Start menu shortcut carries Lumio's app ID (notifications need
// it). The setup program makes the shortcut; copies from the zip get one here.
function startMenuShortcut() {
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Lumio Browser.lnk');
    const exists = fs.existsSync(lnk);
    shell.writeShortcutLink(lnk, exists ? 'update' : 'create', { target: process.execPath, appUserModelId: WIN_APP_ID, description: 'Lumio Browser', icon: process.execPath, iconIndex: 0 });
  } catch (err) {
    console.error('[lumio] start menu shortcut:', err?.message || err);
  }
}

// opts.profile: the profile it's for (else the front window's). Guest has no incognito.
function createWindow(opts = {}) {
  const base = opts.profile || curProfile();
  const incognito = !!opts.incognito && !base.guest;
  const w = new BrowserWin(services, incognito ? incognitoProfile(base) : base, { ...opts, incognito, near: cur()?.win });
  windows.add(w);
  lastFocused = w;
  if (!base.guest) profiles.setLastUsed(base.id);
  perf.watchWindow(w);
  if (opts.focus !== false) w.win.once('ready-to-show', () => w.focus());
  return w;
}

// A notification about a Lumio chat (scheduled tasks); clicking it opens the
// chat in that window, or the front window if that one closed.
function notifyChat(w, title, body, chatId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: t(String(title)).slice(0, 80), body: t(String(body || '')).slice(0, 240) }); // in Lumio's language
  n.on('click', () => {
    const target = windows.has(w) ? w : normalWin(w.profile.base) || createWindow({ profile: w.profile.base });
    target.focus();
    target.openChat(chatId, { full: false });
  });
  n.show();
}

// Scheduled tasks: every 20 s, run what's due in a normal window that isn't
// busy (opening one in the background if none is open), for each open profile.
const runningSchedules = new Set();
function runDueSchedules() {
  if (quitting) return;
  for (const p of loaded.values()) runDueFor(p);
}
function runDueFor(p) {
  const { schedules, account } = p;
  if (!schedules || deleting.has(p.id) || !account.state().signedIn) return;
  for (const task of schedules.due()) {
    if (runningSchedules.has(task.id)) continue;
    const normalWins = alive().filter((x) => !x.incognito && x.profile === p);
    const w = normalWins.find((x) => x === lastFocused && !x.ai.isRunning()) || normalWins.find((x) => !x.ai.isRunning())
      || (normalWins.length ? null : createWindow({ profile: p, focus: false }));
    if (!w) return; // every window is busy; try again on the next check
    runningSchedules.add(task.id);
    w.ai.runScheduled({ ...task, when: describeSchedule(task) })
      .catch(() => {})
      .finally(() => runningSchedules.delete(task.id));
  }
}

// Save each profile's open normal windows so they come back next launch. When
// the last one closes (without quitting) the file keeps it, like Chrome on the Mac.
function saveSession() {
  if (quitting) return;
  for (const p of loaded.values()) {
    const list = alive().filter((w) => !w.incognito && w.profile === p).map((w) => w.session()).filter((s) => s.tabs.length);
    if (list.length) p.store.saveSession(list);
  }
}

let menuTimer = null;
function menuChanged() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => Menu.setApplicationMenu(buildMenu(cmd, menuState())), 50);
}
// The menu follows the front window's profile (before any window: the first profile's).
function menuState() {
  const id = cur()?.profile.id || DEFAULT_PROFILE;
  return {
    bookmarksBar: !!(cur()?.profile.store || rootStore).settings.showBookmarksBar,
    appearance: theme.appearance(),
    profiles: profiles ? (cur() ? profilesFor(cur()) : profilesList()) : [],
    recentlyClosed: recentlyClosed.map((e, index) => ({ e, index })).filter(({ e }) => e.profileId === id).slice(-10).reverse().map(({ e, index }) => ({
      label: e.kind === 'window' ? t(`${e.tabs.length} Tab${e.tabs.length === 1 ? '' : 's'} (${e.title})`) : e.title || e.url, // a page's title stays as it is
      index,
    })),
  };
}

// No index: the front window's profile's most recently closed tab or window
// (an incognito or Guest window's own closed tabs).
function reopenClosed(index) {
  const w = cur();
  if (index == null) {
    if (w?.incognito || w?.profile.guest) {
      const e = w.closedTabs.pop();
      if (e) w.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned });
      return;
    }
    index = recentlyClosed.findLastIndex((e) => e.profileId === (w?.profile.id || DEFAULT_PROFILE));
    if (index < 0) return;
  }
  const [e] = recentlyClosed.splice(index, 1);
  if (!e) return;
  menuChanged();
  if (!profiles.get(e.profileId)) return; // its profile was deleted
  const p = openProfile(e.profileId);
  if (e.kind === 'window') { createWindow({ profile: p, tabs: e.tabs, active: e.active, bounds: e.bounds }); return; }
  const target = alive().find((x) => x.id === e.windowId) || normalWin(p);
  if (!target) { createWindow({ profile: p, urls: [e.url] }); return; }
  target.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned });
  target.focus();
}

function moveTabToNewWindow(w, id) {
  if (w.tabs.tabs.length < 2) return;
  const tab = w.tabs.detach(id);
  if (!tab) return;
  if (printPreview.stateOf(w)?.tab === tab) printPreview.close(w, { focusPage: false }); // it belongs to the old window
  if (tab.view && !w.incognito) w.profile.extensions?.removeTab(tab.view.webContents);
  createWindow({ profile: w.profile.base, incognito: w.incognito, adopt: tab });
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
  print: () => { const w = cur(); if (w) printPreview.open(w); },
  printSystemDialog: () => { const w = cur(); if (w) printPreview.systemDialog(w); },
  savePage: () => { const w = cur(); if (w) savePage(w, w.tabs.active); },
  find: () => { const w = cur(); if (!w) return; w.win.webContents.focus(); w.emit('find-open'); },
  findStep: (forward) => cur()?.emit('find-step', { forward }),
  reload: (hard) => cur()?.tabs.reload(hard),
  zoom: (step) => cur()?.tabs.zoom(step),
  togglePanel: () => cur()?.emit('panel-toggle'),
  toggleSidebar: () => cur()?.emit('sidebar-toggle'),
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
  toggleBookmarksBar: () => { const p = curProfile(); setBookmarksBar(p, !p.store.settings.showBookmarksBar); },
  setAppearance: (value) => rootStore.setSetting('appearance', value),
  pinTab: () => { const w = cur(); const t = w?.tabs.active; if (t) w.tabs.setPinned(t.id, !t.pinned); },
  moveTabToNewWindow: () => { const w = cur(); if (w?.tabs.active) moveTabToNewWindow(w, w.tabs.activeId); },
  cycle: (dir) => cur()?.tabs.cycle(dir),
  tabIndex: (n) => cur()?.tabs.activateIndex(n),
  makeDefault: () => makeDefaultBrowser(),
  webStore: () => { const w = normalWin() || createWindow(); w.tabs.create('https://chromewebstore.google.com/'); w.focus(); },
  taskManager: () => taskManager.open(cur()?.win),
  profilePicker: () => picker.open(),
  addProfile: () => picker.open({ mode: 'add' }),
  openProfile: (id) => switchToProfile(id),
  newGuest: () => openGuest(),
};

function openInternal(url) {
  // Browser pages open in a normal window, even from incognito.
  const w = normalWin() || createWindow({ urls: [url] });
  const existing = w.tabs.tabs.find((t) => (t.pendingUrl || t.url || '').startsWith(url));
  if (existing) w.tabs.activate(existing.id);
  else w.tabs.create(url);
  w.focus();
}

function bookmarksPayload(store) {
  return {
    show: !!store.settings.showBookmarksBar,
    items: store.bookmarks().map(({ url, title, favicon }) => ({ url, title, favicon: favicon || store.faviconFor(url) || null })),
  };
}

// p: the profile whose bookmarks changed (its incognito windows show them too).
function bookmarksChanged(p) {
  const payload = bookmarksPayload(p.store);
  for (const w of alive()) if (w.profile.store === p.store) { w.tabs.changed(); w.emit('bookmarks', payload); }
}

function setBookmarksBar(p, show) {
  p.store.setSetting('showBookmarksBar', !!show);
  bookmarksChanged(p);
  menuChanged();
}

// Light or dark changed (main/theme.js): native colors follow in every window
// and the payment window, and the View menu shows the choice.
function appearanceChanged() {
  for (const w of alive()) w.applyAppearance();
  if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.setBackgroundColor(theme.colors(theme.isDark()).frame);
  menuChanged();
}

function toggleBookmark(w) {
  const tab = w?.tabs.active;
  if (!tab) return;
  const url = w.tabs.displayUrl(tab);
  if (!/^https?:/.test(url)) return;
  const added = w.profile.store.toggleBookmark(url, tab.view?.webContents.getTitle() || tab.title, tab.favicon); // the page's title now, not a moment ago
  bookmarksChanged(w.profile);
  w.emit('toast', { text: added ? 'Bookmarked' : 'Bookmark removed' });
}

function openUrl(url, disposition = 'tab', from = cur()) {
  if (!/^(https?|file|lumio|chrome-extension):/i.test(url)) return;
  const profile = from?.profile.base;
  if (disposition === 'window') createWindow({ profile, urls: [url] });
  else if (disposition === 'incognito') createWindow({ profile, incognito: true, urls: [url] });
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
    // Windows 11 opens Lumio Browser's own page (the setup program registers it);
    // Windows 10 shows the list.
    require('electron').shell.openExternal('ms-settings:defaultapps?registeredAppUser=Lumio%20Browser');
    cur()?.emit('toast', { text: 'In Windows Settings, choose Lumio Browser for web pages (and set it as default).' });
    return ok;
  }
  cur()?.emit('toast', { text: ok ? 'macOS will ask you to confirm Lumio as your default browser.' : 'Could not set the default browser from a development build.' });
  return ok;
}

// ---------------------------------------------------------------- account + profile
const ACCOUNT_PAGES = { manage: '/account', upgrade: '/account#plans', billing: '/account', home: '/' };

// Signing in happens on lumio-usa.online in a normal tab of the profile. When
// the site's session cookie appears in the profile's session, its account
// adopts it (watchLumioCookie) and the sign-in tab closes.
async function signIn(from) {
  const p = from?.profile.base || curProfile();
  const { account } = p;
  const res = account.startSignIn();
  // Already logged in to lumio-usa.online in this profile? Use that session.
  const [existing] = await p.session.cookies.get({ url: account.base, name: account.cookieName }).catch(() => []);
  if (existing && await account.adopt(existing.value)) return { ok: true };
  const w = from && !from.incognito ? from : normalWin(p) || createWindow({ profile: p, urls: [] });
  p.signInTab = { w, id: w.tabs.create(res.url).id };
  w.focus();
  return res;
}

function watchLumioCookie(p) {
  const { account } = p;
  p.session.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !account.pending || cookie.name !== account.cookieName) return;
    if (cookie.domain.replace(/^\./, '') !== account.host) return;
    account.adopt(cookie.value).then((ok) => {
      if (!ok || !p.signInTab) return;
      const { w, id } = p.signInTab;
      p.signInTab = null;
      const tab = !w.closed && w.tabs.get(id);
      // Close the sign-in tab if it's still on the website.
      if (tab && (() => { try { return new URL(w.tabs.displayUrl(tab)).hostname === account.host; } catch { return false; } })()) w.tabs.close(id);
      if (!w.closed) w.emit('toast', { text: 'Signed in to Lumio' });
    }).catch(() => {});
  });
}

// Signing out ends the Lumio session and forgets the website's cookie too.
async function signOutLumio(p) {
  await p.account.signOut();
  await p.session.cookies.remove(p.account.base, p.account.cookieName).catch(() => {});
}

function openAccountPage(which, from) {
  const path = ACCOUNT_PAGES[which];
  if (!path) return;
  const p = from?.profile.base || curProfile();
  const w = from && !from.incognito ? from : normalWin(p) || createWindow({ profile: p, urls: [] });
  w.tabs.create(p.account.url(path));
  w.focus();
}

// ---------------------------------------------------------------- plan and billing (Settings)
// The Lumio server talks to Stripe; Settings shows the plan, switches it,
// cancels (with a reason) or resumes it.
async function billingCall({ account }, path, body) {
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
  if (!['go', 'plus', 'pro', 'max'].includes(plan)) return { ok: false, error: 'Choose Go, Plus, Pro or Max.' };
  if (checkoutWin && !checkoutWin.isDestroyed()) { checkoutWin.focus(); return { ok: false, error: 'The payment window is already open.' }; }
  const { account, session: ses } = w.profile.base;
  const token = account.token();
  if (!token) return { ok: false, error: 'Sign in to Lumio first.' };
  // The window uses the profile's session, signed in to the website as this account.
  await ses.cookies.set({
    url: account.base, name: account.cookieName, value: token, path: '/', httpOnly: true, sameSite: 'lax',
    secure: account.base.startsWith('https:'), expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
  }).catch(() => {});
  const [pw, ph] = w.win.getContentSize();
  const win = new BrowserWindow({
    parent: w.win, modal: true, show: false, width: Math.max(420, Math.min(980, pw - 40)), height: Math.max(520, Math.min(780, ph - 30)),
    minWidth: 400, minHeight: 480, title: 'Subscribe to Lumio', backgroundColor: theme.colors(theme.isDark()).frame, autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
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
  const { account } = w.profile.base;
  const r = await billingCall(w.profile.base, '/api/billing/portal', {});
  if (!r.ok || !r.url) return r.ok ? { ok: false, error: 'Billing isn’t available right now.' } : r;
  const [pw, ph] = w.win.getContentSize();
  const win = new BrowserWindow({
    parent: w.win, modal: true, width: Math.max(420, Math.min(900, pw - 40)), height: Math.max(520, Math.min(760, ph - 30)),
    title: 'Card and invoices', backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { session: w.profile.base.session, contextIsolation: true, sandbox: true, nodeIntegration: false },
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

function profileState({ store }) { return { ...store.settings.profile }; }
const firstName = (name) => String(name || '').trim().split(/\s+/)[0].slice(0, 40) || null;

const THEMES = ['blue', 'purple', 'green', 'orange', 'pink', 'mono'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
// p: the profile (its windows, incognito ones too, show the new look).
function setProfile(p, patch = {}) {
  const { store } = p;
  const next = { ...store.settings.profile };
  if (typeof patch.name === 'string') next.name = patch.name.trim().slice(0, 40);
  if (typeof patch.color === 'string' && COLOR_RE.test(patch.color)) next.color = patch.color;
  if (THEMES.includes(patch.theme)) next.theme = patch.theme;
  if (patch.photo === null) next.photo = null;
  store.setSetting('profile', next);
  profileWindows(p).forEach((w) => w.emit('profile', next));
  profilesChanged();
  return next;
}

async function pickProfilePhoto(w) {
  const p = w.profile.base;
  const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }],
  });
  if (canceled || !filePaths[0]) return profileState(p);
  const img = nativeImage.createFromPath(filePaths[0]);
  if (img.isEmpty()) return { ...profileState(p), error: "That image couldn't be opened." };
  // Square-crop the center and keep it small; it's stored in settings.
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: 160, height: 160, quality: 'best' });
  const next = { ...p.store.settings.profile, photo: square.toDataURL() };
  p.store.setSetting('profile', next);
  profileWindows(p).forEach((x) => x.emit('profile', next));
  profilesChanged();
  return next;
}

// Clear a profile's browsing data. range: milliseconds back from now, or 0 for all time.
async function clearData(p, { range = 0, what = [] } = {}) {
  const { store } = p;
  const from = range ? Date.now() - range : null;
  if (what.includes('history')) { if (from) store.deleteHistory({ from }); else store.clearHistory(); }
  if (what.includes('downloads')) store.clearDownloads({ from });
  if (what.includes('cookies')) await p.session.clearStorageData();
  if (what.includes('cache')) await p.session.clearCache();
  if (what.includes('chats')) {
    alive().filter((w) => !w.incognito && w.profile === p).forEach((w) => w.ai.stop());
    p.chats.clear();
  }
  if (what.includes('permissions')) p.permissions.clear();
  if (what.includes('closed')) {
    for (let i = recentlyClosed.length - 1; i >= 0; i--) if (recentlyClosed[i].profileId === p.id) recentlyClosed.splice(i, 1);
    menuChanged();
  }
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
  if (!state.critical && rootStore.settings.updateAnnounced === state.latest) return;
  announced.add(state.latest);
  if (!state.critical) rootStore.setSetting('updateAnnounced', state.latest);
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
  handle('shell:init', (w) => {
    const { store, account, extensions } = w.profile;
    return {
      tabs: w.tabs.state(),
      downloads: w.profile.downloads.list(),
      panel: { open: store.settings.panelOpen, width: store.settings.panelWidth },
      sidebar: { open: store.settings.sidebarOpen !== false, getStarted: store.settings.getStartedDone !== true },
      ai: w.ai.state(),
      bookmarks: bookmarksPayload(store),
      account: account.state(),
      profile: profileState(w.profile),
      incognito: w.incognito,
      guest: !!w.profile.guest,
      profiles: profilesFor(w),
      partition: w.profile.partition, // the extension buttons' session
      perf: perf.shellState(),
      extensions: !w.incognito && !!extensions?.ece,
      platform: process.platform,
      version: app.getVersion(),
      beta: FLAVOR.beta,
      update: updater?.state || null,
    };
  });

  on('layout:slot', (w, rect) => { w.tabs.setSlot(rect); w.indicator.place(); printPreview.place(w); });
  on('aura:size', (w, size) => { if (w.indicator.bar?.webContents) w.indicator.resize(size); });
  on('panel:full', (w, { on: covered, slot } = {}) => w.tabs.setCovered(!!covered, slot && Number.isFinite(slot.width) ? slot : null));
  on('sidebar:set', (w, { open, getStarted } = {}) => {
    if (typeof open === 'boolean') w.profile.store.setSetting('sidebarOpen', open);
    if (getStarted === false) w.profile.store.setSetting('getStartedDone', true);
  });
  on('panel:set', (w, { open, width }) => {
    if (typeof open === 'boolean') w.profile.store.setSetting('panelOpen', open);
    if (typeof width === 'number') w.profile.store.setSetting('panelWidth', Math.round(Math.max(320, Math.min(760, width))));
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
  on('window:new', (w) => createWindow({ profile: w.profile.base }));
  on('app:menu', (w, { x, y }) => {
    buildBrowserMenu(cmd, menuState()).popup({ window: w.win, x: Math.max(0, Math.round(x) - 290), y: Math.round(y) });
  });
  on('window:incognito', (w) => createWindow({ profile: w.profile.base, incognito: true }));

  handle('omnibox:suggest', (w, text) => suggest(text, {
    history: w.incognito ? [] : w.profile.store.history(),
    bookmarks: w.profile.store.bookmarks(),
    searchTemplate: w.tabs.searchTemplate(),
  }));

  on('overlay:show', (w, { rect, payload }) => { w.showOverlay(rect, payload); perf.overlayShown(w, payload); });
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
    const items = w.profile.store.bookmarks().filter((b) => urls.includes(b.url));
    Menu.buildFromTemplate(items.map((b) => ({ label: b.title.slice(0, 60) || b.url, translate: false, click: () => openUrl(b.url, 'current', w) })))
      .popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
  });
  on('bookmarks:move', (w, { url, index }) => { w.profile.store.moveBookmark(url, index); bookmarksChanged(w.profile); });
  // A link, or the address bar's site icon, dropped on the bar.
  on('bookmarks:add', (w, { url, title, index }) => {
    url = String(url || '').trim();
    if (!/^(https?|file):/i.test(url) || url.length > 4096) return;
    const tab = w.tabs.tabs.find((t) => t.url === url);
    w.profile.store.addBookmarkAt(url, String(title || tab?.title || '').trim().slice(0, 300) || url, Number(index) || 0, tab?.favicon);
    bookmarksChanged(w.profile);
  });

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
  handle('account:state', (w) => w.profile.account.state());
  on('account:sign-in', (w) => { w.hideOverlay(); signIn(w); });
  on('account:cancel', (w) => w.profile.account.cancelSignIn());
  on('account:sign-out', (w) => { w.hideOverlay(); signOutLumio(w.profile.base); });
  on('account:open', (w, which) => { w.hideOverlay(); openAccountPage(which, w); });
  on('account:page', (w, which) => {
    w.hideOverlay();
    const pages = { passwords: 'lumio://passwords/', settings: 'lumio://settings/', profile: 'lumio://settings/#profile', plan: 'lumio://settings/#plan' };
    if (pages[which]) openInternal(pages[which]);
  });
  on('account:close-incognito', (w) => alive().filter((x) => x.incognito && x.profile === w.profile).forEach((x) => x.close()));
  on('account:close-guest', () => alive().filter((x) => x.profile.guest).forEach((x) => x.close()));

  // ---- profiles (account menu, the profile picker) ----
  registerProfileIpc();

  // ---- performance (the toolbar's Performance issues and Energy Saver buttons) ----
  on('perf:battery', (_w, b) => perf.setBattery(b || {}));
  // Keyboard users were in the popup: focus goes back to the window.
  const perfDone = (w) => { const keys = w.overlay.webContents.isFocused(); w.hideOverlay(); w.emit('overlay-picked', { kind: 'perf' }); if (keys) w.win.webContents.focus(); };
  on('perf:fix', (w) => { perfDone(w); perf.fix(w); });
  on('perf:dismiss', (w) => { perfDone(w); perf.dismiss(w); });
  on('perf:close', (w) => perfDone(w));
  on('perf:settings', (w) => { perfDone(w); openInternal('lumio://settings/#performance'); });
  handle('perf:alert', (w) => perf.alertPayload(w));

  // ---- passwords (dropdown under sign-in fields, save prompt) ----
  on('passwords:fill', (w, choice) => w.profile.passwords?.fill(w, choice || {}));
  on('passwords:decide', (w, d) => { w.hideOverlay(); w.profile.passwords?.decide(w, d || {}); });
  on('passwords:passkey', (w, d) => w.profile.passwords?.passkeyDecide(w, d || {}));
  handle('passwords:reveal-pending', (w, id) => w.profile.passwords?.revealPending(w, Number(id)) ?? null);
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
  handle('ai:workflows', (w) => (w.incognito ? [] : w.profile.workflows.list()));
  // The sidebar: projects, chats, scheduled tasks.
  const sidebarReply = (fn) => { try { return { ok: true, ...fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  handle('ai:projects', (w) => (w.incognito ? [] : w.profile.projects.list()));
  handle('ai:project-add', (w, spec) => sidebarReply(() => ({ project: w.profile.projects.add(spec || {}) })));
  handle('ai:project-update', (w, id, patch) => sidebarReply(() => ({ project: w.profile.projects.update(String(id), patch || {}) })));
  handle('ai:project-remove', (w, id) => sidebarReply(() => { w.profile.projects.remove(String(id)); w.profile.base.chats.unfile(String(id)); return {}; }));
  handle('ai:chat-rename', (w, id, title) => ({ ok: w.ai.chatStore.rename(String(id), title) }));
  handle('ai:chat-move', (w, id, projectId) => ({ ok: w.ai.chatStore.move(String(id), projectId && w.profile.projects.get(String(projectId)) ? String(projectId) : null) }));
  handle('ai:chat-search', (w, q) => w.ai.chatStore.search(String(q || '')));
  handle('ai:schedules', (w) => (w.incognito || !w.profile.schedules ? [] : w.profile.schedules.list().map(({ id, title, when, nextRun, paused, done }) => ({ id, title, when, nextRun, paused, done }))));
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
  on('ai:connect', (w, id) => { if (/^[a-z_]{2,40}$/.test(String(id))) w.tabs.create(`${w.profile.account.base}/api/connect/${id}/start?next=/account`); });
  on('ai:open-file', (w, p) => { if (w.ai.ownsFile(p)) shell.openPath(p); });
  on('ai:show-file', (w, p) => { if (w.ai.ownsFile(p)) shell.showItemInFolder(p); });
  on('ai:stop', (w) => w.ai.stop());
  on('ai:approve', (w, { callId, decision }) => w.ai.approve(callId, decision));
  on('ai:mac-permissions-open', (w, which) => w.ai.openMacPermissionSettings(which));
  handle('ai:mac-permissions', (w) => w.ai.macPermissions());
  on('open-url', (w, url) => w.tabs.create(url));

  // ---- internal pages ----
  internalHandle('page:newtab-data', ['newtab'], ({ w }) => {
    const { store, account } = w.profile;
    return {
      topSites: w.incognito ? [] : topSites(store.history(), 8),
      bookmarks: store.bookmarks().slice(-12).reverse(),
      engine: (SEARCH_ENGINES[store.settings.searchEngine] || SEARCH_ENGINES.google).name,
      aiReady: w.ai.state().ready,
      incognito: w.incognito,
      // "Good morning, Juan": the profile name they chose, else their Lumio account name.
      name: w.profile.guest ? null : firstName(store.settings.profile?.name || account.state().name),
      chats: w.incognito ? [] : w.ai.listChats().slice(0, 3),
    };
  });
  internalHandle('page:open-chat', ['newtab'], ({ w }, id) => w.openChat(String(id || '')));
  internalHandle('page:navigate', ALL_PAGES, ({ w, tab }, input) => w.tabs.navigate(input, tab.id));
  internalHandle('page:open', ALL_PAGES, ({ w }, url, disposition) => openUrl(String(url || ''), disposition, w));
  internalHandle('page:ask-ai', ['newtab'], ({ w }, text) => w.askAI(String(text || ''), { includePage: false, full: true }));

  internalHandle('page:history', ['history'], ({ w }) => w.profile.store.history().slice().reverse());
  internalHandle('page:history-delete', ['history'], ({ w }, what) => w.profile.store.deleteHistory(what || {}));
  internalHandle('page:history-clear', ['history', 'settings'], ({ w }) => w.profile.store.clearHistory());
  internalHandle('page:other-tabs', ['history'], ({ w }) => Object.values(w.profile.sync?.remoteTabs || {}).filter((d) => d?.windows?.length).sort((a, b) => (b.at || 0) - (a.at || 0)));
  internalHandle('page:recently-closed', ['history'], ({ w }) => recentlyClosed.map((e, index) => ({
    index,
    kind: e.kind,
    title: e.title,
    url: e.url || null,
    favicon: e.favicon || null,
    time: e.time,
    tabs: e.kind === 'window' ? e.tabs.map((t) => ({ title: t.title, url: t.url })) : undefined,
    profileId: e.profileId,
  })).filter((e) => e.profileId === w.profile.id).reverse());
  internalHandle('page:reopen-closed', ['history'], (_ctx, index) => reopenClosed(index));
  internalHandle('page:clear-data', ['history', 'settings', 'downloads'], ({ w }, opts) => clearData(w.profile.base, opts));

  internalHandle('page:downloads', ['downloads'], ({ w }) => w.profile.downloads.all());
  internalHandle('page:download-action', ['downloads'], ({ w }, id, action) => w.profile.downloads.action(id, action));
  internalHandle('page:downloads-clear', ['downloads'], ({ w }) => w.profile.downloads.clearAll());

  internalHandle('page:bookmarks', ['bookmarks', 'newtab'], ({ w }) => w.profile.store.bookmarks());
  internalHandle('page:bookmark-update', ['bookmarks'], ({ w }, url, patch) => { const ok = w.profile.store.updateBookmark(url, patch || {}); bookmarksChanged(w.profile); return ok; });
  internalHandle('page:bookmark-remove', ['bookmarks', 'newtab'], ({ w }, url) => { w.profile.store.removeBookmark(url); bookmarksChanged(w.profile); });
  internalHandle('page:bookmark-move', ['bookmarks'], ({ w }, url, index) => { w.profile.store.moveBookmark(url, index); bookmarksChanged(w.profile); });
  internalHandle('page:bookmarks-export', ['bookmarks'], ({ w }) => exportBookmarks(w));
  internalHandle('page:bookmarks-bar', ['bookmarks'], ({ w }) => !!w.profile.store.settings.showBookmarksBar);
  internalHandle('page:set-bookmarks-bar', ['bookmarks', 'settings'], ({ w }, show) => setBookmarksBar(w.profile, !!show));

  internalHandle('page:extensions', ['extensions'], ({ w }) => {
    const { extensions, store } = w.profile;
    return {
      available: !!extensions?.ece,
      developerMode: !!store.settings.developerMode,
      items: extensions?.ece ? extensions.list() : [],
    };
  });
  internalHandle('page:extension-toggle', ['extensions'], ({ w }, key, on_) => w.profile.extensions?.setEnabled(key, !!on_));
  internalHandle('page:extension-remove', ['extensions'], async ({ w }, key, name) => {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Remove “${name || 'this extension'}”?`,
    });
    if (response !== 0) return false;
    await w.profile.extensions?.remove(key);
    return true;
  });
  internalHandle('page:extension-reload', ['extensions'], ({ w }, key) => w.profile.extensions?.reload(key));
  internalHandle('page:extension-load-unpacked', ['extensions'], async ({ w }) => {
    if (!w.profile.extensions) return { ok: false, error: 'Extensions aren’t available here.' };
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openDirectory'], message: 'Choose an extension folder (with manifest.json)' });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    return w.profile.extensions.loadUnpacked(filePaths[0]);
  });
  internalHandle('page:extension-options', ['extensions'], ({ w }, id, page) => {
    if (!/^[a-p]{32}$/.test(id) || typeof page !== 'string') return;
    w.tabs.create(`chrome-extension://${id}/${page.replace(/^\//, '')}`);
  });
  internalHandle('page:set-developer-mode', ['extensions'], ({ w }, on_) => w.profile.store.setSetting('developerMode', !!on_));
  internalHandle('page:open-webstore', ['extensions', 'settings'], () => cmd.webStore());

  internalHandle('page:settings', ['settings'], ({ w }) => {
    const { store, account } = w.profile;
    return {
      account: account.state(),
      profile: profileState(w.profile),
      guest: !!w.profile.guest,
      startup: store.settings.startup,
      downloadDir: store.settings.downloadDir || app.getPath('downloads'),
      askDownload: !!store.settings.askDownload,
      offerPasswords: store.settings.offerPasswords !== false,
      autofillPasswords: store.settings.autofillPasswords !== false,
      platform: process.platform,
      searchEngine: store.settings.searchEngine,
      engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
      approvalMode: store.settings.approvalMode,
      showBookmarksBar: !!store.settings.showBookmarksBar,
      appearance: theme.appearance(),
      ai: w.ai.state(),
      version: app.getVersion(),
      update: updater?.state || null,
      isDefault: app.isDefaultProtocolClient('https'),
      importSources: importer.detect(),
      sitePermissions: Object.entries(w.profile.base.permissions.all()).map(([origin, perms]) => ({ origin, perms })),
    };
  });
  // Lumio Sync (Settings › Sync). Guest has none: it shows as off.
  const syncReply = async (fn) => { try { return { ok: true, ...(await fn()) }; } catch (err) { return { ok: false, error: err.message }; } };
  const syncOf = (w) => w.profile.sync || { state: () => ({ on: false, status: 'off', types: {}, requests: [] }), setPrefs() {}, keys: null, tick: async () => {}, answer() { throw new Error('Sync isn’t available in Guest mode.'); }, recoveryKey: () => null, useRecoveryKey() { throw new Error('Sync isn’t available in Guest mode.'); }, api: async () => ({ devices: [] }), deleteEverything: async () => ({}) };
  internalHandle('page:sync', ['settings'], ({ w }) => syncOf(w).state());
  internalHandle('page:sync-devices', ['settings'], ({ w }) => syncReply(async () => (syncOf(w).keys ? syncOf(w).api('/api/sync') : { devices: [] })));
  internalHandle('page:sync-set', ['settings'], ({ w }, prefs) => { syncOf(w).setPrefs(prefs || {}); return syncOf(w).state(); });
  internalHandle('page:sync-now', ['settings'], ({ w }) => syncReply(async () => { await syncOf(w).tick(); return syncOf(w).state(); }));
  internalHandle('page:sync-answer', ['settings'], ({ w }, id, approve) => syncReply(() => syncOf(w).answer(String(id), !!approve)));
  internalHandle('page:sync-recovery', ['settings'], ({ w }) => ({ key: syncOf(w).recoveryKey() }));
  internalHandle('page:sync-use-recovery', ['settings'], ({ w }, text) => syncReply(() => syncOf(w).useRecoveryKey(String(text || ''))));
  internalHandle('page:sync-remove-device', ['settings'], ({ w }, id) => syncReply(() => syncOf(w).api(`/api/sync/devices/${encodeURIComponent(String(id))}`, { method: 'DELETE' })));
  internalHandle('page:sync-delete-all', ['settings'], ({ w }) => syncReply(() => syncOf(w).deleteEverything()));

  // Saved workflows (Settings › Workflows, and the new tab page)
  internalHandle('page:workflows', ['settings', 'newtab'], ({ w }) => ({ workflows: w.profile.workflows.list() }));
  internalHandle('page:site-tips', ['settings'], ({ w }) => ({ sites: w.profile.siteTips.list() }));
  internalHandle('page:site-tip-remove', ['settings'], ({ w }, site, tip) => w.profile.siteTips.remove(String(site || ''), String(tip || '')));
  internalHandle('page:workflow-update', ['settings'], ({ w }, id, patch) => { try { return { ok: true, workflow: w.profile.workflows.update(String(id), patch || {}) }; } catch (err) { return { ok: false, error: err.message }; } });
  internalHandle('page:workflow-remove', ['settings'], ({ w }, id) => ({ ok: w.profile.workflows.remove(String(id)) }));
  // Running one happens in the panel, which asks for any blanks first.
  internalHandle('page:workflow-run', ['settings', 'newtab'], ({ w }, id) => {
    if (!w.profile.workflows.get(String(id))) return { ok: false, error: 'That workflow doesn’t exist anymore.' };
    w.profile.store.setSetting('panelOpen', true);
    w.emit('ai-workflow', { id: String(id) });
    w.win.webContents.focus();
    return { ok: true };
  });

  // Scheduled tasks (Settings › Scheduled tasks)
  const scheduleReply = (fn) => { try { return { ok: true, ...fn() }; } catch (err) { return { ok: false, error: err.message }; } };
  internalHandle('page:schedules', ['settings'], ({ w }) => ({ tasks: w.profile.schedules.list(), signedIn: !!w.profile.account.state().signedIn }));
  internalHandle('page:schedule-add', ['settings'], ({ w }, spec) => scheduleReply(() => ({ task: w.profile.schedules.add(spec || {}) })));
  internalHandle('page:schedule-update', ['settings'], ({ w }, id, patch) => scheduleReply(() => ({ task: w.profile.schedules.update(String(id), patch || {}) })));
  internalHandle('page:schedule-remove', ['settings'], ({ w }, id) => ({ ok: w.profile.schedules.remove(String(id)) }));
  internalHandle('page:schedule-run', ['settings'], ({ w }, id) => {
    const task = w.profile.schedules.get(String(id));
    if (!task) return { ok: false, error: 'That scheduled task doesn’t exist anymore.' };
    if (runningSchedules.has(task.id) || w.ai.isRunning()) return { ok: false, error: 'Lumio is busy right now. Try again when it’s done.' };
    runningSchedules.add(task.id);
    w.ai.runScheduled({ ...task, when: describeSchedule(task), manual: true }).catch(() => {}).finally(() => runningSchedules.delete(task.id));
    return { ok: true };
  });
  internalHandle('page:schedule-open', ['settings'], ({ w }, id) => {
    const chatId = w.profile.schedules.get(String(id))?.lastChatId;
    return { ok: !!chatId && w.openChat(chatId, { full: false }) };
  });
  internalHandle('page:check-updates', ['settings'], () => updater.check({ manual: true }));
  internalHandle('page:update-now', ['settings'], ({ w }) => startUpdate(w));
  internalHandle('page:set-setting', ['settings', 'passwords'], ({ w }, key, value) => {
    const { store } = w.profile;
    if (key === 'searchEngine' && SEARCH_ENGINES[value]) store.setSetting('searchEngine', value);
    if (key === 'approvalMode') w.ai.setMode(value);
    if (key === 'reasoning') w.ai.setReasoning(value);
    if (key === 'showBookmarksBar') setBookmarksBar(w.profile, !!value);
    if (key === 'appearance' && theme.APPEARANCES.includes(value)) rootStore.setSetting('appearance', value); // app-wide
    if (key === 'startup' && ['restore', 'newtab'].includes(value)) store.setSetting('startup', value);
    if (key === 'askDownload') store.setSetting('askDownload', !!value);
    if (key === 'offerPasswords') store.setSetting('offerPasswords', !!value);
    if (key === 'autofillPasswords') store.setSetting('autofillPasswords', !!value);
    services.broadcastAIState();
  });
  // Settings › Languages and › System, and Reset settings (main/languages.js, main/system.js)
  languages.register({ internalHandle, rootStore, app });
  system.register({
    internalHandle,
    shell,
    onReset: (w) => {
      const p = w.profile.base;
      bookmarksChanged(p);
      profileWindows(p).forEach((x) => x.emit('profile', profileState(p)));
      services.broadcastAIState();
      menuChanged();
    },
  });
  // Settings › Performance (app-wide: main/perf.js)
  internalHandle('page:performance', ['settings'], () => perf.pageState());
  internalHandle('page:set-performance', ['settings'], ({ w }, key, value) => (w.profile.guest ? perf.pageState() : perf.set(String(key), value))); // app-wide: not a Guest's
  internalHandle('page:task-manager', ['settings'], ({ w }) => { taskManager.open(w.win); });
  internalHandle('page:set-site-permission', ['settings'], ({ w }, origin, permission, value) => {
    if (typeof origin !== 'string' || typeof permission !== 'string') return;
    w.profile.base.permissions.set(origin, permission, value === 'allow' ? true : value === 'block' ? false : undefined);
  });
  internalHandle('page:make-default', ['settings', 'welcome'], () => makeDefaultBrowser());
  internalHandle('page:mac-permissions', ['settings'], ({ w }) => w.ai.macPermissions());
  internalHandle('page:mac-permissions-open', ['settings'], ({ w }, which) => w.ai.openMacPermissionSettings(which));
  internalHandle('page:passwords', ['passwords'], ({ w }) => w.profile.passwords.pageState());
  internalHandle('page:password-reveal', ['passwords'], ({ w }, id) => w.profile.passwords.reveal(w, String(id)));
  internalHandle('page:password-copy', ['passwords'], ({ w }, id) => w.profile.passwords.copy(w, String(id)));
  internalHandle('page:password-edit', ['passwords'], ({ w }, id, patch) => w.profile.passwords.edit(w, String(id), patch));
  internalHandle('page:password-add', ['passwords'], ({ w }, entry) => w.profile.passwords.add(entry));
  internalHandle('page:password-delete', ['passwords'], ({ w }, id) => w.profile.passwords.store.remove(String(id)));
  internalHandle('page:passkey-delete', ['passwords'], async ({ w }, id) => ((await w.profile.passwords.authorize(w, 'delete a passkey')) ? w.profile.passwords.passkeys.remove(String(id)) : false));
  internalHandle('page:passwords-import', ['passwords'], ({ w }) => w.profile.passwords.importFile(w));
  internalHandle('page:passwords-export', ['passwords'], ({ w }) => w.profile.passwords.exportFile(w));
  internalHandle('page:password-never-remove', ['passwords'], ({ w }, site) => w.profile.passwords.store.removeNever(String(site)));
  internalHandle('page:password-generate', ['passwords'], () => generatePassword());
  internalHandle('page:account', ['settings', 'newtab', 'welcome'], ({ w }) => w.profile.account.state());
  internalHandle('page:account-refresh', ['settings'], ({ w }) => w.profile.account.refresh());
  internalHandle('page:account-sign-in', ['settings', 'newtab', 'welcome'], ({ w }) => signIn(w));
  internalHandle('page:account-cancel', ['settings'], ({ w }) => { w.profile.account.cancelSignIn(); return w.profile.account.state(); });
  internalHandle('page:account-sign-out', ['settings'], async ({ w }) => { await signOutLumio(w.profile.base); return w.profile.account.state(); });
  internalHandle('page:account-open', ['settings', 'newtab'], ({ w }, which) => openAccountPage(String(which), w));
  internalHandle('page:billing', ['settings'], ({ w }) => billingCall(w.profile, '/api/billing/subscription'));
  internalHandle('page:billing-change', ['settings'], ({ w }, plan) => billingCall(w.profile, '/api/billing/change', { plan: String(plan || '') }));
  internalHandle('page:billing-cancel', ['settings'], ({ w }, form) => billingCall(w.profile, '/api/billing/cancel', { reason: String(form?.reason || ''), comment: String(form?.comment || '').slice(0, 1000) }));
  internalHandle('page:billing-resume', ['settings'], ({ w }) => billingCall(w.profile, '/api/billing/resume', {}));
  internalHandle('page:billing-redeem', ['settings'], ({ w }, code) => billingCall(w.profile, '/api/billing/redeem', { code: String(code || '').slice(0, 40) }));
  internalHandle('page:billing-subscribe', ['settings'], ({ w }, plan) => openCheckout(w, String(plan || '')));
  internalHandle('page:billing-card', ['settings'], ({ w }) => openCardWindow(w));
  internalHandle('page:set-profile', ['settings'], ({ w }, patch) => setProfile(w.profile.base, patch || {}));
  internalHandle('page:profile-photo', ['settings'], ({ w }) => pickProfilePhoto(w));
  internalHandle('page:profiles', ['settings'], ({ w }) => ({ count: profiles.count, guest: !!w.profile.guest }));
  internalHandle('page:profiles-manage', ['settings'], () => picker.open());
  internalHandle('page:choose-download-dir', ['settings'], async ({ w }) => {
    const { store } = w.profile;
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.settings.downloadDir || app.getPath('downloads') });
    if (!canceled && filePaths[0]) store.setSetting('downloadDir', filePaths[0]);
    return store.settings.downloadDir || app.getPath('downloads');
  });
  internalHandle('page:import', ['settings', 'welcome'], async ({ w }, id, opts) => {
    const o = opts || {};
    // Tests use a known key instead of the macOS Keychain.
    const secret = process.env.LUMIO_TEST ? process.env.LUMIO_IMPORT_SECRET : undefined;
    const res = await importer.importFrom(String(id), { store: w.profile.store, passwordStore: w.profile.passwords.store }, { bookmarks: o.bookmarks !== false, history: o.history !== false, passwords: !!o.passwords, ...(secret ? { secret } : {}) });
    if (res.ok) bookmarksChanged(w.profile);
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
        const added = w.profile.store.importBookmarks(importer.parseBookmarksHtml(text));
        bookmarksChanged(w.profile);
        return { ok: true, bookmarks: added };
      }
      return { ok: true, passwords: w.profile.passwords.store.importCsv(text) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Safari's files need Full Disk Access: open that page of System Settings.
  internalHandle('page:open-disk-access', ['settings', 'welcome'], () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'));

  // ---- first-run welcome ----
  internalHandle('page:welcome-state', ['welcome'], ({ w }) => ({ platform: process.platform, sources: importer.detect(), account: w.profile.account.state() }));
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
    w.profile.store.setSetting('onboarded', true);
    w.profile.store.setSetting('panelOpen', true);
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
  const rows = w.profile.store.bookmarks().map((b) => `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.round((b.time || Date.now()) / 1000)}">${esc(b.title)}</A>`).join('\n');
  fs.writeFileSync(filePath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${rows}\n</DL><p>\n`);
  return true;
}

function tabContextMenu(w, id) {
  const tab = w.tabs.get(id);
  if (!tab) return;
  const tabs = w.tabs;
  const i = tabs.tabs.indexOf(tab);
  const closedCount = w.incognito || w.profile.guest ? w.closedTabs.length : recentlyClosed.filter((e) => e.profileId === w.profile.id).length;
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
  const { store } = w.profile;
  const b = store.bookmarks().find((x) => x.url === url);
  if (!b) { barContextMenu(w); return; }
  Menu.buildFromTemplate([
    { label: 'Open', click: () => openUrl(url, 'current', w) },
    { label: 'Open in New Tab', click: () => openUrl(url, 'tab', w) },
    { label: 'Open in New Window', click: () => openUrl(url, 'window', w) },
    { label: 'Open in Incognito Window', click: () => openUrl(url, 'incognito', w) },
    { type: 'separator' },
    { label: 'Edit…', click: () => openInternal(`lumio://bookmarks/?edit=${encodeURIComponent(url)}`) },
    { label: 'Delete', click: () => { store.removeBookmark(url); bookmarksChanged(w.profile); } },
    { type: 'separator' },
    { label: 'Show Bookmarks Bar', type: 'checkbox', checked: !!store.settings.showBookmarksBar, click: () => cmd.toggleBookmarksBar() },
    { label: 'Bookmark Manager', click: () => cmd.bookmarksManager() },
  ]).popup({ window: w.win });
}

// Right-click on the bar itself, not on a bookmark.
function barContextMenu(w) {
  const { store } = w.profile;
  const tab = w.tabs.active;
  const url = tab ? w.tabs.displayUrl(tab) : '';
  const canAdd = /^https?:/.test(url) && !store.isBookmarked(url);
  Menu.buildFromTemplate([
    { label: 'Bookmark This Tab', enabled: canAdd, click: () => toggleBookmark(w) },
    { label: 'Import Bookmarks…', click: () => openInternal('lumio://settings/#import') },
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
  // Links wait while the profile picker is up, then open in the chosen profile.
  if (profiles && alive().length) openExternalUrls([url]); else pendingUrls.push(url);
});

app.on('second-instance', (_e, argv) => {
  const urls = launchTargets(argv.slice(1));
  if (urls.length && alive().length) openExternalUrls(urls);
  else if (urls.length && picker?.isOpen) pendingUrls.push(...urls);
  else if (urls.length) openExternalUrls(urls);
  else if (!alive().length && (picker?.isOpen || profiles?.wantsPicker())) picker.open();
  else ensureWin().focus();
});

// ---------------------------------------------------------------- profiles
// Opens a profile's services the first time it's used: its session, files,
// Lumio account, sync, extensions. It stays open until Lumio quits.
function openProfile(id) {
  if (loaded.has(id)) return loaded.get(id);
  const dir = profiles.dirOf(id);
  const store = id === DEFAULT_PROFILE ? rootStore : new Store(dir, safeStorage);
  const partition = profiles.partitionOf(id);
  const ses = session.fromPartition(partition);
  setupTabSession(ses);
  const detachLanguages = languages.attach(ses, store, app);
  const profile = { id, dir, partition, incognito: false, guest: false, incog: null, session: ses, store, chats: new ChatStore(store.chatsFile), timers: [], detachLanguages };
  profile.base = profile;
  loaded.set(id, profile);
  const wins = () => profileWindows(profile); // its windows, incognito ones too
  store.onBookmarkIcons = () => bookmarksChanged(profile);
  profile.downloads = new Downloads(ses, { store, emit: (c, p) => alive().filter((w) => w.profile === profile).forEach((w) => w.emit(c, p)) });

  const account = new LumioAccount({
    store,
    onChange: (state) => {
      wins().forEach((w) => { w.emit('account', state); w.ai.refreshCapabilities(); });
      services.broadcastAIState();
      profile.sync?.soon(500);
      // The picker shows who's signed in (kept while offline, cleared on sign-out).
      const known = state.signedIn || !account.token();
      if (known && profiles.remember(id, { email: state.email, accountName: state.name })) profilesChanged();
    },
  });
  profile.account = account;
  account.refresh();
  watchLumioCookie(profile);
  const refresher = setInterval(() => { if (account.token()) account.refresh(); }, 10 * 60 * 1000);
  refresher.unref?.();
  profile.timers.push(refresher);
  const workflows = new Workflows(dir);
  const siteTips = new SiteTips(dir);
  workflows.onChange(() => wins().forEach((w) => w.emit('workflows-changed', {})));
  const projects = new Projects(dir);
  // The sidebar refreshes when chats or projects change (a moment after, not per word).
  let sidebarTimer = null;
  const sidebarChanged = () => {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => wins().forEach((w) => w.emit('sidebar-changed', {})), 400);
  };
  projects.onChange(sidebarChanged);
  profile.chats.onChange(sidebarChanged);
  const schedules = new Schedules(dir);
  schedules.onChange(() => wins().forEach((w) => w.emit('schedules-changed', {})));
  Object.assign(profile, { workflows, siteTips, projects, schedules });

  const passwords = new PasswordManager({
    dir,
    safeStorage,
    settings: store,
    helper,
    findTab: tabOfWc,
    toast: (w, text) => w.emit('toast', { text }),
  });
  profile.passwords = passwords;

  // Lumio Sync: bookmarks, passwords, history, chats, workflows, settings and
  // open tabs on every device signed in to this Lumio account (encrypted here).
  const sync = new SyncEngine({
    dir,
    store,
    account,
    onState: (state) => wins().forEach((w) => w.emit('sync-state', state)),
    onPairRequest: (r) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: t(`“${r.name}” wants to sync with Lumio`), body: t(`Check that it shows ${r.code.replace(/(\d{3})/, '$1 ')}, then approve it in Settings › Sync.`) });
      n.on('click', () => { const w = normalWin(profile) || createWindow({ profile }); w.focus(); w.tabs.create('lumio://settings/#sync'); });
      n.show();
    },
  });
  // Each profile is a device of its own to Lumio Sync: "MacBook (Work)".
  if (id !== DEFAULT_PROFILE) sync.deviceName = `${sync.deviceName} (${profiles.describe(id).name})`.slice(0, 60);
  profile.sync = sync;
  sync.addAdapters([
    syncAdapters.bookmarks(store),
    syncAdapters.history(store),
    syncAdapters.passwords(passwords.store),
    syncAdapters.chats(profile.chats),
    syncAdapters.workflows(workflows),
    syncAdapters.projects(projects),
    syncAdapters.settings(store, { onApplied: () => { services.broadcastAIState(); menuChanged(); } }),
    syncAdapters.tabs({
      deviceId: sync.deviceId,
      deviceName: sync.deviceName,
      platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
      windows: () => alive().filter((w) => !w.incognito && w.profile === profile).map((w) => ({ tabs: w.tabs.sessionTabs() })),
      remote: sync.remoteTabs,
    }),
  ]);
  const syncSoon = () => sync.soon();
  for (const f of [store.bookmarksFile, store.historyFile, store.settingsFile, store.chatsFile, store.sessionFile, passwords.store.file]) f.onSave(syncSoon);
  workflows.onChange(syncSoon);
  projects.onChange(syncSoon);
  // Bookmarks from another device: redraw the bar.
  store.bookmarksFile.onSave(() => { if (sync.busy) bookmarksChanged(profile); });
  sync.start();
  const companion = new CompanionBridge({
    sync,
    windows: () => alive().filter((w) => !w.incognito && w.profile === profile),
    pickWindow: () => (lastFocused && !lastFocused.incognito && lastFocused.profile === profile && windows.has(lastFocused) ? lastFocused : normalWin(profile) || createWindow({ profile, focus: false })),
    openChat: (w, chatId) => w.openChat(chatId, { full: false }),
  });
  profile.companion = companion;
  companion.start();
  profile.permissions = new Permissions(ses, { store, emitFor, persist: true });
  setupScreenShare(ses);

  const extensions = new ExtensionManager({
    session: ses,
    dir,
    store,
    hooks: {
      // Extensions can open tabs and windows, but never Lumio's own pages.
      createTab: (details) => {
        const w = alive().find((x) => x.win.id === details.windowId && !x.incognito && x.profile === profile) || normalWin(profile) || createWindow({ profile });
        const tab = w.tabs.create(extensionUrl(details.url), { active: details.active !== false, index: details.index });
        return [tab.view.webContents, w.win];
      },
      selectTab: (wc) => { const f = tabOfWc(wc); if (f) { f.w.tabs.activate(f.tab.id); f.w.focus(); } },
      removeTab: (wc) => { const f = tabOfWc(wc); if (f) f.w.tabs.close(f.tab.id); },
      createWindow: (details) => {
        const urls = (Array.isArray(details.url) ? details.url : details.url ? [details.url] : []).map(extensionUrl);
        return createWindow({ profile, urls }).win;
      },
      removeWindow: (win) => alive().find((w) => w.win === win)?.close(),
      changed: () => alive().filter((w) => !w.incognito && w.profile === profile).forEach((w) => w.emit('extensions-changed')),
    },
  });
  profile.extensions = extensions;
  // Load extensions before restoring tabs so their content scripts run there,
  // but never hold up the first window for long.
  profile.ready = Promise.race([
    extensions.init().catch((err) => { console.error('Extensions failed to start:', err); extensions.ece = null; }),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  profilesChanged(); // "open" in the picker and menus
  return profile;
}

// Opens a profile's windows: its last session (or a new tab), or the welcome
// screens on a first launch. restore: Lumio restarted itself (Settings), so
// the tabs come back whatever the startup setting.
async function startProfile(p, { restore = false } = {}) {
  await p.ready;
  const { store } = p;
  const saved = store.settings.startup === 'newtab' && !restore ? [] : store.sessionWindows();
  // First launch: the welcome screens (people updating from an older version
  // already have history, bookmarks or tabs, and skip them).
  if (store.settings.onboarded !== true && (saved.length || store.history().length || store.bookmarks().length)) store.setSetting('onboarded', true);
  if (store.settings.onboarded !== true && (!process.env.LUMIO_TEST || process.env.LUMIO_TEST_WELCOME)) {
    store.setSetting('panelOpen', false);
    createWindow({ profile: p, tabs: [{ url: 'lumio://welcome/', title: 'Welcome to Lumio Browser' }], active: 0 });
  } else if (saved.length) saved.forEach((s) => createWindow({ profile: p, tabs: s.tabs, active: s.active, bounds: s.bounds }));
  else createWindow({ profile: p });
}

// A profile picked in the picker or the account menu: its window comes to
// the front, or its windows open.
// A profile still starting (its extensions load first) isn't started again
// by a second click: its windows would come back twice.
const starting = new Map(); // id -> startProfile promise
async function switchToProfile(id) {
  if (!profiles.get(id) || deleting.has(id)) return false;
  const p = openProfile(id);
  const w = normalWin(p);
  if (w) w.focus();
  else if (starting.has(id)) await starting.get(id);
  else {
    const run = startProfile(p).finally(() => starting.delete(id));
    starting.set(id, run);
    await run;
  }
  picker.close();
  if (pendingUrls.length) openExternalUrls(pendingUrls.splice(0));
  return true;
}

// Guest: a profile that's thrown away when its last window closes. Its tabs
// use an in-memory session; its files go in a folder that's wiped after.
function openGuest() {
  if (!guest) {
    const dir = profiles.guestDir(Date.now());
    const store = new Store(dir, safeStorage);
    store.setSetting('offerPasswords', false); // nothing here is kept
    const partition = `lumio-guest-${++incogSeq}`; // in memory only
    const ses = session.fromPartition(partition);
    setupTabSession(ses);
    const detachLanguages = languages.attach(ses, store, app);
    const profile = { id: 'guest', dir, partition, incognito: false, guest: true, incog: null, session: ses, store, chats: new ChatStore(null), timers: [], detachLanguages };
    profile.base = profile;
    const wins = () => alive().filter((w) => w.profile === profile);
    profile.downloads = new Downloads(ses, { settings: store, emit: (c, p) => wins().forEach((w) => w.emit(c, p)) });
    profile.permissions = new Permissions(ses, { store, emitFor, persist: false });
    profile.account = new LumioAccount({ store, onChange: (state) => { wins().forEach((w) => { w.emit('account', state); w.ai.refreshCapabilities(); }); services.broadcastAIState(); } });
    watchLumioCookie(profile);
    profile.passwords = new PasswordManager({ dir, safeStorage, settings: store, helper, findTab: tabOfWc, toast: (w, text) => w.emit('toast', { text }) });
    Object.assign(profile, { workflows: new Workflows(dir), siteTips: new SiteTips(dir), projects: new Projects(dir), schedules: new Schedules(dir) });
    setupScreenShare(ses);
    guest = profile;
  }
  const w = createWindow({ profile: guest });
  picker.close();
  return w;
}

// The last Guest window closed: sign out of Lumio there, and wipe everything.
function endGuest() {
  const p = guest;
  guest = null;
  if (!p) return;
  p.detachLanguages();
  p.session.clearStorageData().catch(() => {});
  p.session.clearCache().catch(() => {});
  const wipe = () => setTimeout(() => profiles.rm(p.dir), 1000); // after any pending writes
  if (p.account.token()) p.account.signOut().catch(() => {}).finally(wipe); else wipe();
}

// Deletes a profile (never the first one): closes its windows, signs it out
// of Lumio, and removes its files and session.
// Profiles being deleted: nothing opens them again meanwhile (a click in a
// menu, a scheduled task), or their folder would go out from under them.
const deleting = new Set();
async function deleteProfile(id) {
  if (id === DEFAULT_PROFILE || !profiles.get(id) || deleting.has(id)) return false;
  deleting.add(id);
  try { await removeProfile(id); } finally { deleting.delete(id); }
  return true;
}
async function removeProfile(id) {
  const p = loaded.get(id);
  if (p) {
    // A page that holds its window open gets 3 seconds before the window goes anyway.
    await Promise.all(profileWindows(p).map((w) => new Promise((resolve) => {
      w.win.once('closed', resolve);
      w.close();
      setTimeout(() => { if (!w.closed) w.win.destroy(); }, 3000);
    })));
    loaded.delete(id);
    p.detachLanguages();
    p.timers.forEach(clearInterval);
    p.sync.stop();
    p.companion.stop();
    if (p.account.token()) await p.account.signOut().catch(() => {});
    await p.session.clearStorageData().catch(() => {});
    await p.session.clearCache().catch(() => {});
    p.store.flushAll();
    await new Promise((r) => setTimeout(r, 600)); // let any last debounced file writes land before the folder goes
  }
  for (let i = recentlyClosed.length - 1; i >= 0; i--) if (recentlyClosed[i].profileId === id) recentlyClosed.splice(i, 1);
  profiles.remove(id);
  profilesChanged();
}

// What the picker and the account menus show, with open profiles' live names.
function profilesList() {
  return profiles.ids().map((id) => ({
    ...profiles.describe(id, loaded.get(id)?.store.settings.profile),
    open: alive().some((w) => w.profile.base.id === id && !w.profile.guest),
  }));
}
const profilesFor = (w) => profilesList().map((p) => ({ ...p, current: !w.profile.guest && p.id === w.profile.id }));
function profilesChanged() {
  for (const w of alive()) w.emit('profiles-changed', profilesFor(w));
  picker?.changed();
  menuChanged();
}

// The account menu ('profiles:…' from a window) and the picker window.
function registerProfileIpc() {
  const allowed = (e) => windowOfWc(e.sender) || picker.isOurs(e.sender);
  const onProfiles = (channel, fn) => ipcMain.on(channel, (e, ...args) => { if (allowed(e)) fn(...args); });
  ipcMain.handle('profiles:state', (e) => {
    if (!allowed(e)) throw new Error('Not allowed');
    return { profiles: profilesList(), showPicker: profiles.showPicker, platform: process.platform };
  });
  onProfiles('profiles:open', (id) => { switchToProfile(String(id)); });
  onProfiles('profiles:add', (spec) => {
    const p = profiles.add({ name: spec?.name, color: spec?.color });
    profilesChanged();
    switchToProfile(p.id);
  });
  onProfiles('profiles:guest', () => openGuest());
  onProfiles('profiles:remove', (id) => { deleteProfile(String(id)); });
  onProfiles('profiles:show-picker', (on) => { profiles.showPicker = !!on; picker.changed(); });
  onProfiles('profiles:manage', (mode) => picker.open({ mode: mode === 'add' ? 'add' : 'pick' }));
  // Edit: the profile's own Settings › Customize profile.
  onProfiles('profiles:edit', async (id) => {
    if (!(await switchToProfile(String(id)))) return;
    const w = normalWin(loaded.get(String(id)));
    if (w) { w.tabs.create('lumio://settings/#profile'); w.focus(); }
  });
}

app.whenReady().then(async () => {
  profiles = new ProfileRegistry(app.getPath('userData'));
  profiles.emptyTrash(); // what deleted profiles and Guest left behind
  rootStore = new Store(app.getPath('userData'), safeStorage);
  // Light or dark, before any window opens; changes then apply live.
  theme.init({ store: rootStore, nativeTheme });
  theme.onChange(appearanceChanged);
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

  setInterval(runDueSchedules, 20 * 1000).unref?.();
  setTimeout(runDueSchedules, 8000).unref?.(); // catch up after launch, once tabs and sign-in are back
  perf = new PerformanceManager({ store: rootStore, windows: alive, toast: (w, text) => w.emit('toast', { text }) });
  perf.start();
  taskManager = new TaskManager({ windows: alive, focusTab: (w, tab) => { w.tabs.activate(tab.id); w.focus(); } });
  taskManager.register(ipcMain);
  printPreview = new PrintPreview({
    store: rootStore,
    downloadsDir: (w) => w.profile.store.settings.downloadDir || app.getPath('downloads'),
    toast: (w, text) => w.emit('toast', { text }),
  });
  printPreview.register(ipcMain);
  system = new System({ app, rootStore, started });
  picker = new ProfilePicker({
    state: () => ({ profiles: profilesList(), showPicker: profiles.showPicker, platform: process.platform }),
    // Closed without picking anyone: like Chrome, Windows quits (a Mac keeps the app in the Dock).
    onClosed: () => { if (!alive().length && !quitting && process.platform !== 'darwin') app.quit(); },
  });
  // Each tab's password and passkey requests go to its own profile's manager.
  PasswordManager.register((wc) => tabOfWc(wc)?.w.profile.passwords || null);
  screenAura.register();

  // Updates from GitHub Releases (packaged builds; tests point it at a mock).
  const testUpdates = process.env.LUMIO_TEST && process.env.LUMIO_UPDATE_API;
  updater = new Updater({
    currentVersion: app.getVersion(),
    fetchImpl: (url, opts) => net.fetch(url, opts),
    workDir: path.join(app.getPath('temp'), `${FLAVOR.name} Update`),
    onChange: (state) => { alive().forEach((w) => w.emit('update', state)); announceUpdate(state); },
    quit: process.env.LUMIO_UPDATE_TARGET && process.env.LUMIO_TEST ? () => {} : () => app.quit(),
    openPath: (file) => shell.openPath(file),
    api: testUpdates ? process.env.LUMIO_UPDATE_API : FLAVOR.beta ? BETAS : LATEST,
    beta: FLAVOR.beta, appName: FLAVOR.name, bundleId: FLAVOR.bundleId, assetPrefix: FLAVOR.assetPrefix,
    store: !!process.windowsStore, // the Microsoft Store updates it
    ...(process.env.LUMIO_TEST && process.env.LUMIO_UPDATE_TARGET ? { installTarget: process.env.LUMIO_UPDATE_TARGET, fakeExit: true } : {}),
  });
  if (app.isPackaged || testUpdates) {
    setTimeout(() => updater.check(), testUpdates ? 300 : 8000);
    setInterval(() => updater.check(), 60 * 60 * 1000).unref?.(); // every hour (GitHub allows 60/hour)
  }
  // Just updated? Say so once, with what's new.
  const lastVersion = rootStore.settings.lastVersion;
  if (lastVersion && compareVersions(app.getVersion(), lastVersion) > 0) {
    setTimeout(() => { const w = lastFocused && !lastFocused.win.isDestroyed() ? lastFocused : alive()[0]; w?.emit('toast', { text: `Updated to Lumio Browser ${app.getVersion()}` }); }, 2500);
  }
  if (lastVersion !== app.getVersion()) rootStore.setSetting('lastVersion', app.getVersion());

  registerIpc();
  Menu.setApplicationMenu(buildMenu(cmd, menuState()));

  // Windows passes links to open on the command line.
  if (process.platform !== 'darwin' && !process.env.LUMIO_TEST) pendingUrls.push(...launchTargets(process.argv.slice(1)));
  // Several profiles: "Who's using Lumio?" first, unless that's turned off.
  // Otherwise (and after a restart from Settings) the profiles that were
  // open come back (or the last one used).
  if (profiles.wantsPicker() && !system.restarted && (!process.env.LUMIO_TEST || process.env.LUMIO_TEST_PICKER)) picker.open();
  else {
    const ids = profiles.lastOpen();
    for (const id of ids.length ? ids : [profiles.lastUsed()]) await startProfile(openProfile(id), { restore: system.restarted });
  }
  if (process.platform === 'win32' && app.isPackaged && !process.windowsStore) startMenuShortcut();
  if (pendingUrls.length && alive().length) openExternalUrls(pendingUrls.splice(0));

  app.on('activate', () => {
    if (alive().length) return;
    if (profiles.wantsPicker()) picker.open(); else createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.env.LUMIO_TEST) app.quit();
});

app.on('before-quit', () => {
  saveSession();
  if (profiles && !quitting) profiles.setLastOpen([...new Set(alive().filter((w) => !w.profile.guest).map((w) => w.profile.id))]);
  quitting = true;
  for (const w of alive()) w.ai.shutdown();
  helper?.stop();
  for (const p of loaded.values()) p.store.flushAll();
  profiles?.flush();
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
  // The front window's profile's (the first profile's before any window opens).
  get store() { return (cur()?.profile || openProfile(DEFAULT_PROFILE)).store; },
  get extensions() { return curProfile().extensions; },
  get account() { return curProfile().account; },
  get passwords() { return curProfile().passwords; },
  get workflows() { return curProfile().workflows; },
  get siteTips() { return curProfile().siteTips; },
  get schedules() { return curProfile().schedules; },
  get sync() { return curProfile().sync; },
  // normal/incognito: the front window's profile and its incognito session.
  get profiles() { const p = curProfile(); return { normal: p, incognito: p.incog, registry: profiles, loaded, guest, list: profilesList(), open: openProfile, start: switchToProfile, remove: deleteProfile, openGuest }; },
  get rootStore() { return rootStore; },
  get perf() { return perf; },
  get taskManager() { return taskManager; },
  get picker() { return picker; },
  get printPreview() { return printPreview; },
  get system() { return system; },
  get recentlyClosed() { return recentlyClosed; },
  screenAura,
  get updater() { return updater; },
  signIn: (w) => signIn(w || cur()),
  focus: (w) => { lastFocused = w; },
  createWindow,
  openUrl,
  clearData: (opts) => clearData(curProfile(), opts),
  cmd,
  snapshot,
  BrowserWindow,
};
