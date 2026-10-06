// Lumio Browser — main process entry.
const {
  app, BrowserWindow, ipcMain, session, protocol, Menu, safeStorage, nativeImage, dialog, net, shell, desktopCapturer, webContents, Notification, nativeTheme, systemPreferences,
} = require('electron');
const fs = require('fs');
const path = require('path');

const FLAVOR = require('./flavor');

// Lumio Beta keeps its own profile (bookmarks, sign-in, settings) next to the normal app's.
if (process.env.LUMIO_USER_DATA) app.setPath('userData', process.env.LUMIO_USER_DATA);
else if (FLAVOR.beta) app.setPath('userData', path.join(app.getPath('appData'), FLAVOR.name));
if (process.env.LUMIO_DOWNLOADS) app.setPath('downloads', process.env.LUMIO_DOWNLOADS); // tests
app.setName(FLAVOR.name);
// Experiments (lumio://flags-lite) are Chromium switches, so they're set before the app starts.
require('./flags').applyAtStartup(app, app.getPath('userData'));
// Force dark mode for web contents is a startup switch too (main/force-dark.js).
require('./force-dark').applyAtStartup(app);

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
const { PopupWin } = require('./popup-window');
const external = require('./external-protocols');
const { registerUiProtocol, registerPagesProtocol, setPageAttributes } = require('./protocol');
const accessibility = require('./accessibility');
const theme = require('./theme');
const { chromeUserAgent, Downloads, Permissions, closingCancels, downloadsWarning } = require('./features');
const { fileUrl, launchTargets } = require('./open-files');
const { credits } = require('./credits');
const { SiteResolver, cookieProbe } = require('./sites');
const { SiteControls } = require('./site-controls');
const { SiteData } = require('./site-data');
const { BrowsingData, CookieClock } = require('./browsing-data');
const { registerSiteIpc } = require('./site-ipc');
const { Security } = require('./security');
const { buildMenu, buildBrowserMenu, menuTemplate } = require('./menu');
const { OmniboxService } = require('./omnibox-service');
const { BookmarksService } = require('./bookmarks-service');
const { NtpShortcuts } = require('./ntp-shortcuts');
const { GroupsService } = require('./groups-service');
const { SidePanel } = require('./side-panel');
const searchEngines = require('./search-engines');
const { ChatStore } = require('./ai/chats');
const { MacHelper } = require('./mac/helper');
const { ExtensionManager } = require('./extensions');
const { ExtensionsUI } = require('./extensions-ui');
const { Help } = require('./help');
const devtools = require('./devtools');
const menuExtras = require('./menu-extras');
const { menuCommands } = require('./menu-commands');
const { Handoff, contextMenuItems: macContextItems } = require('./mac-integration');
const { LumioAccount } = require('./account');
const { PasswordManager } = require('./password-manager');
const { AutofillManager, attachAutofill } = require('./autofill');
const screenAura = require('./ai/screen-aura');
const { Updater, LATEST, BETAS, compareVersions } = require('./updater');
const { generatePassword } = require('./passwords');
const importer = require('./importer');
const { Schedules, describe: describeSchedule } = require('./schedules');
const { Workflows } = require('./workflows');
const { SiteTips } = require('./site-tips');
const { Projects } = require('./projects');
const certErrors = require('./cert-errors');
const pageDialogs = require('./page-dialogs');
const { SyncEngine } = require('./sync/engine');
const syncAdapters = require('./sync/adapters');
const { CompanionBridge } = require('./sync/companion');
const { Navigation, SAVE_FILTERS, saveType } = require('./navigation');
const { startupPlan, STARTUP } = require('./startup');
const { Sessions, launchPlan, windowOptions } = require('./sessions');
const { Infobars } = require('./infobars');
const defaultBrowser = require('./default-browser');
const { TabStrip } = require('./tab-strip');
const { TabSearch } = require('./tab-search');
const { TabDrag } = require('./tab-drag');
const { SiteMute } = require('./site-mute');
const { OsIntegration } = require('./os-integration');
const sadTab = require('./sad-tab');
const { shareableTabs } = require('./capture');
const { ProfileRegistry, DEFAULT_PROFILE } = require('./profiles');
const { PerformanceManager } = require('./perf');
const { TaskManager } = require('./task-manager');
const { ProfilePicker } = require('./picker');
const { PrintPreview } = require('./print');
const { System } = require('./system');
const languages = require('./languages');
const { t } = require('./i18n');
const { Translator } = require('./translate');
const { Reader } = require('./reader');
const { MediaHub } = require('./media');
const { ShareTools } = require('./share');
const { Screenshots } = require('./screenshot');
const { Apps } = require('./apps');
const { appIdFromArgv } = require('./app-launchers');
const { PageMenu } = require('./page-menu');
const tabLayout = require('./tab-layout');
const powerUser = require('./power-user');
const forceDark = require('./force-dark');

const IS_DEV = !app.isPackaged;

// A stray error in a callback shouldn't freeze the browser behind Electron's
// modal error box: log it and keep going.
process.on('uncaughtException', (err) => console.error('[lumio] uncaught exception:', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('[lumio] unhandled rejection:', err?.stack || err));
// Opt-in crash reports (Settings › Privacy): Crashpad has to start before the app is ready.
const crashReports = require('./crash-reports').setup(app);
// Protected content (Widevine) on DRM builds; nothing at all on stock Electron (main/drm.js).
const drm = require('./drm').setup(app, { theme });

if (!process.env.LUMIO_TEST && !app.requestSingleInstanceLock()) app.quit();
// Windows shows an app's notifications only under its app ID, matched by its
// Start menu shortcut (set below). The Microsoft Store version has its own.
const WIN_APP_ID = 'online.lumio-usa.browser';
if (process.platform === 'win32' && !process.windowsStore) app.setAppUserModelId(WIN_APP_ID);

// Each profile (main/profiles.js) opens as { id, session, store, chats,
// downloads, permissions, account, passwords, sync, companion, extensions,
// schedules, workflows, siteTips, projects, bookmarks, omnibox, groups,
// sidePanel, siteControls, siteData, browsingData } (openProfile). A window's
// profile is w.profile; an incognito window's is an in-memory copy of its
// profile's (with .base pointing back), and Guest is a profile of its own.
let rootStore = null; // the first profile's settings, which also hold the app-wide ones (appearance, performance, updates)
let profiles = null; // the list of profiles
const loaded = new Map(); // profile id -> the open profile
let guest = null; // the Guest profile, while a Guest window is open
let helper = null;
let incogSeq = 0;
let updater = null;
let siteMute = null; // Mute site (main/site-mute.js), for every profile
let sites = null; // registrable domains (main/sites.js)
let security = null; // security and privacy protections (main/security.js)
let perf = null; // Settings › Performance (main/perf.js)
let taskManager = null;
let picker = null; // "Who's using Lumio?"
let printPreview = null; // File › Print… (main/print.js)
let system = null; // Settings › System (main/system.js)
// Page tools, for every profile (translating pages and reading mode are each
// profile's: profile.translator, profile.reader).
let media = null; // the toolbar's media controls (main/media.js)
let shareTools = null; // Share, QR codes, Send to your devices (main/share.js)
let screenshots = null; // the screenshot tool (main/screenshot.js)
let apps = null; // installed web apps (main/apps.js), each kept with the profile it came from
let pageMenu = null; // the page tools' right-click items (main/page-menu.js)
let waitingProfiles = null; // started for an installed app: the profiles whose windows come back once the browser is opened
let help = null; // Help menu, Report an issue, lumio://version and flags-lite (main/help.js), for every profile
const handoff = new Handoff(app); // the page you're on, offered to your other Apple devices
let quitting = false;
let launched = false; // the first windows are open: links and files from other apps open right away
const windows = new Set();
const popups = new Set(); // pop-up windows pages opened (main/popup-window.js)
let lastFocused = null;
const recentlyClosed = []; // newest last: { kind: 'tab' | 'window', ... }
const pendingUrls = []; // links and files other apps asked Lumio to open before it was ready

// ---------------------------------------------------------------- windows
const alive = () => [...windows].filter((w) => !w.closed && !w.closing);
const alivePopups = () => [...popups].filter((p) => !p.closed);
// Browser windows and pop-ups: what has tabs (a pop-up has one).
const tabHolders = () => [...alive(), ...alivePopups()];
const cur = () => (lastFocused && !lastFocused.closed && !lastFocused.closing ? lastFocused : alive().at(-1)) || null;
// The profile a command is for: the front window's, else the last one used.
const curProfile = () => cur()?.profile.base || openProfile(profiles.lastUsed());
const normalWin = (base = curProfile()) => { const c = cur(); return c && !c.incognito && c.profile === base ? c : alive().reverse().find((w) => !w.incognito && w.profile === base) || null; };
const profileWindows = (p) => alive().filter((w) => w.profile.base === p.base);
const ensureWin = () => cur() || createWindow();
// The pop-up you're in: page commands (close, reload, print…) are for it.
const focusedPopup = () => alivePopups().find((p) => p.win.isFocused()) || null;
const pageWin = () => focusedPopup() || cur();
const windowOfWc = (wc) => tabHolders().find((w) => w.win.webContents === wc || w.overlay.webContents === wc || w.indicator?.bar?.webContents === wc || w.dialogs?.view?.webContents === wc || w.notice?.view?.webContents === wc) || null;
const tabOfWc = (wc) => {
  for (const w of tabHolders()) {
    const tab = w.tabs.byWebContents(wc);
    if (tab) return { w, tab };
  }
  return null;
};

function setupTabSession(ses, { incognito = false } = {}) {
  ses.setUserAgent(app.userAgentFallback);
  registerPagesProtocol(ses, { dark: incognito });
  attachAutofill(ses); // (Edit › Spelling and Grammar follows each profile's setting: main/languages.js)
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
  profile.downloads = new Downloads(ses, { settings: base.store, emit: (c, p) => alive().filter((w) => w.profile === profile).forEach((w) => w.emit(c, p)), gate: (wc, url) => profile.siteControls.gate(wc, url) });
  profile.permissions = new Permissions(ses, { store: base.store, emitFor, persist: false, parent: base.permissions.settings, openExternal: externalRequest, onPointerLock: pointerLocked });
  profile.siteControls = siteControlsFor(profile);
  security.addProfile(profile);
  setupScreenShare(ses);
  base.incog = profile;
  return profile;
}

function endIncognito(base) {
  const p = base.incog;
  base.incog = null;
  if (!p) return;
  if (!alive().some((w) => w.incognito)) siteMute?.forgetIncognito(); // the last incognito window of every profile
  p.downloads.cancelAll(); // closing the last Incognito window asked first (confirmDownloads)
  p.siteControls.dispose();
  security?.removeProfile(p);
  p.detachLanguages();
  p.session.clearStorageData().catch(() => {});
  p.session.clearCache().catch(() => {});
  p.session.clearAuthCache?.().catch?.(() => {});
}

function emitFor(wcId, channel, payload) {
  for (const w of tabHolders()) {
    if (w.tabs.tabs.some((t) => t.view?.webContents.id === wcId)) { w.emit(channel, payload); return; }
  }
  apps?.emitFor(wcId, channel, payload); // a site in an installed app's window
}

// Site settings that act on a profile's pages (main/site-controls.js).
function siteControlsFor(profile) {
  const tabs = () => alive().filter((w) => w.profile === profile).flatMap((w) => w.tabs.tabs.map((tab) => ({ w, tab })));
  return new SiteControls({ profile, sites, emitFor, tabs });
}

const services = {
  get helper() { return helper; },
  notify: (w, title, body, chatId) => { notifyChat(w, title, body, chatId); w.profile.companion?.notice({ title, body, chatId, hint: /needs your OK/.test(title) ? 'approval' : 'scheduled' }); },
  onEmit: (w, channel, payload) => w.profile.companion?.onEmit(w, channel, payload),
  createWindow: (opts) => createWindow(opts),
  onFocus: (w) => {
    const switched = lastFocused?.profile.base !== w.profile.base;
    lastFocused = w;
    handoff.update(w);
    if (!w.profile.guest) profiles.setLastUsed(w.profile.id);
    if (switched) menuChanged(); // the menu shows this profile's bookmarks bar and closed tabs
  },
  onClose: (w) => {
    if (quitting || w.incognito || w.profile.guest || !w.tabs.tabs.length) return;
    recentlyClosed.push({ kind: 'window', profileId: w.profile.id, ...w.session(), title: w.name || w.tabs.active?.title || 'Window', time: Date.now() });
    if (recentlyClosed.length > 25) recentlyClosed.shift();
    menuChanged();
  },
  onClosed: (w) => {
    windows.delete(w);
    if (lastFocused === w) lastFocused = null;
    if (w.incognito && !tabHolders().some((x) => x.profile === w.profile)) endIncognito(w.profile.base); // its pop-ups too
    if (w.profile.guest && !tabHolders().some((x) => x.profile === w.profile)) endGuest();
    // "Delete data … when you close all windows": on the Mac that's quitting.
    if (!quitting && process.platform !== 'darwin' && !w.incognito && !w.profile.guest && !alive().some((x) => !x.incognito && x.profile === w.profile)) w.profile.siteControls?.clearSessionData();
    saveSession();
    handoff.update(cur());
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
  onSessionChanged: () => { saveSessionSoon(); handoff.update(cur()); for (const p of openProfiles()) p.groups?.follow(); },
  addToReadingList: (w, url, title) => w.profile.sidePanel?.add(w, url, title),
  // Closing a window may cancel downloads: what, and asking first.
  downloadsAtRisk: (holder) => downloadsAtRisk(holder),
  // A window stopped a quit to ask "Leave site?": the app keeps running.
  quitCancelled: () => { quitting = false; },
  confirmDownloads: (holder) => confirmDownloads(downloadsAtRisk(holder), holder.win),
  onViewCreated: (w, tab) => {
    w.profile.siteControls?.attach(tab);
    security?.attach(w, tab);
    navigation.onViewCreated(w, tab);
    tabStrip.onViewCreated(w, tab);
    w.profile.base.translator?.wire(tab);
    w.profile.base.reader?.wire(tab);
    media?.wire(tab);
    shareTools?.wire(tab);
    if (!w.incognito && tab.view) {
      w.profile.extensions?.addTab(tab.view.webContents, w.win);
      // A tab already in the strip that isn't the one shown (opened in the background).
      const shown = w.tabs.active?.view?.webContents;
      if (shown && w.tabs.tabs.includes(tab) && tab.id !== w.tabs.activeId) w.profile.extensions?.selectTab(shown);
    }
    if (!w.incognito && tab.view) w.profile.omnibox?.watchTab(tab.view.webContents); // sites' OpenSearch engines
  },
  onPasskeyPromptClosed: (w) => w.profile.passwords?.passkeyClosed(w),
  onScreenSharePickerClosed: (w) => shareCancel(w),
  onOverlayClosed: (w, kind) => { security?.overlayClosed(w, kind); shareTools?.overlayClosed(w, kind); },
  loadFailed: (w, wc, code, url) => security?.loadFailed(w, wc, code, url),
  captureOf: (tab) => security?.captureOf(tab),
  onTabActivated: (w, tab) => {
    navigation.onTabActivated(w);
    osIntegration.onTabActivated(tab);
    shareTools?.tabChanged(w, tab);
    screenshots?.cancel(w, false);
    if (!w.incognito && tab.view) w.profile.extensions?.selectTab(tab.view.webContents);
    printPreview?.tabActivated(w, tab);
  },
  print: (w, tab) => printPreview.open(w, tab),
  savePage: (w, tab) => savePage(w, tab),
  pageMenu: (w, section, tab, params) => pageMenu?.items(w, section, tab, params) || [],
  // existing: the menu so far (Look Up and Speech only when page tools didn't add them).
  contextMenuExtras: (w, tab, params, existing = []) => {
    const base = w.profile.base;
    const tools = [...(base.reader?.menuItems(w, tab, params) || []), ...(base.translator?.menuItems(w, tab, params) || [])];
    const ext = w.incognito || !tab.view ? [] : w.profile.extensions?.contextMenuItems(tab.view.webContents, params) || [];
    const mac = tab.view ? macContextItems(tab.view.webContents, params, existing) : []; // Look Up and Speech on the Mac
    return [tools, ext, mac].filter((g) => g.length).flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g));
  },
  // An extension's new tab page (chrome_url_overrides), if one replaces Lumio's
  // (the window's profile's extensions; never in incognito or Guest).
  newTabUrl: (w) => (w.incognito ? null : w.profile.base.extUi?.newTabUrl(w) || null),
  isNewTabUrl: (url) => openProfiles().some((p) => p.extUi?.isNewTabUrl(url)),
  broadcastAIState: () => alive().forEach((w) => w.ai.emitState()),
  openExternal: (w, tab, req) => openExternalLink(w, tab, req),
  // Is a page in this page's process waiting on its alert()/confirm()/prompt()?
  dialogInProcess: (wc) => {
    const pid = wc.getProcessId();
    return tabHolders().some((h) => h.tabs.tabs.some((t) => {
      const other = t.view?.webContents;
      return other && other !== wc && !other.isDestroyed() && other.getProcessId() === pid && t.dialogs?.some((d) => d.spec.kind === 'js');
    }));
  },
  // window.open() with a size: a pop-up window. Returns its page.
  openPopup: (w, _tab, { webContents, url, features }) => {
    const p = new PopupWin(services, w.profile, { incognito: w.incognito, opener: w, webContents, url, features });
    popups.add(p);
    return webContents || p.tabs.wc();
  },
  onPopupClosed: (p) => {
    popups.delete(p);
    if (p.incognito && !tabHolders().some((x) => x.incognito)) endIncognito();
  },
  openFromPopup: (p, url) => {
    const home = popupHome(p);
    const w = home || createWindow({ incognito: p.incognito, urls: [url] });
    const tab = home ? w.tabs.create(url) : w.tabs.active;
    w.focus();
    return tab;
  },
  adoptFromPopup: (p, tab) => {
    const home = popupHome(p);
    if (home) home.tabs.adopt(tab);
    (home || createWindow({ incognito: p.incognito, adopt: tab })).focus();
  },
};

// The browser window a pop-up's tabs go to: the one it came from, else one
// of the same kind (normal or incognito); null when there's none left.
function popupHome(p) {
  return p.home && !p.home.closed && !p.home.closing ? p.home : alive().find((w) => w.profile === p.profile) || null;
}

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
  // Started for an installed app: the browser's last windows come back with the first browser window.
  if (waitingProfiles) startWaitingProfiles();
  const base = opts.profile || curProfile();
  const incognito = !!opts.incognito && !base.guest;
  const w = new BrowserWin(services, incognito ? incognitoProfile(base) : base, { ...opts, incognito, near: cur()?.win });
  windows.add(w);
  navigation.onWindowCreated(w);
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
    // The first profile's file also keeps a crashed run's windows (main/sessions.js).
    if (list.length) p.store.saveSession(list, p.id === DEFAULT_PROFILE ? sessions.pending() : []);
  }
}
// Tabs change all the time (loading, titles), and each save reads every tab's
// back/forward history, so those changes are gathered into one save every
// quarter second at most.
let sessionTimer = null;
function saveSessionSoon() {
  if (sessionTimer) return;
  sessionTimer = setTimeout(() => { sessionTimer = null; saveSession(); }, 250);
}

let menuTimer = null;
function menuChanged() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => Menu.setApplicationMenu(apps?.focusedMenu() || buildMenu(cmd, menuState())), 50); // an app window in front keeps its own
}
// History changes with every page, so its menu items follow a little later,
// and only when they changed (a rebuild closes an open menu on the Mac).
let historyMenuTimer = null;
let historyMenuItems = '';
function historyMenuSoon() {
  clearTimeout(historyMenuTimer);
  historyMenuTimer = setTimeout(() => {
    const now = JSON.stringify(menuExtras.recentHistory(curProfile().store));
    if (now !== historyMenuItems) { historyMenuItems = now; menuChanged(); }
  }, 2000);
}
// The menu follows the front window's profile (before any window: the first profile's).
function menuState() {
  const id = cur()?.profile.id || DEFAULT_PROFILE;
  return {
    // Its history, bookmarks, name and account (main/menu-extras.js); DevTools' dock is Lumio's.
    ...menuExtras.state({ store: (cur()?.profile || loaded.get(DEFAULT_PROFILE))?.store || rootStore, account: (cur()?.profile || loaded.get(DEFAULT_PROFILE))?.account, devtoolsDock: devtools.mode(rootStore) }),
    extensionKeys: (cur()?.profile.base || loaded.get(DEFAULT_PROFILE))?.extUi?.menuKeys() || [],
    bookmarksBar: !!(cur()?.profile.store || rootStore).settings.showBookmarksBar,
    appearance: theme.appearance(),
    ...powerUser.menuState(rootStore), // Caret Browsing's checkmark, the shortcuts people picked (Lumio's own)
    profiles: profiles ? (cur() ? profilesFor(cur()) : profilesList()) : [],
    recentlyClosed: recentlyClosed.map((e, index) => ({ e, index })).filter(({ e }) => e.profileId === id).slice(-10).reverse().map(({ e, index }) => ({
      label: e.kind === 'window' ? t(`${e.tabs.length} Tab${e.tabs.length === 1 ? '' : 's'} (${e.title})`) : e.title || e.url, // a page's title stays as it is
      index,
      favicon: e.kind === 'tab' ? e.favicon || null : null,
      window: e.kind === 'window',
      tabs: e.kind === 'window' ? e.tabs.map((x) => x.title || x.url) : null, // a closed window's tabs, each reopenable
    })),
  };
}

// Tabs and windows come back with their back/forward history (main/sessions.js).
// index: an entry picked from a list (always that one); none: the front
// window's profile's last one (incognito and Guest windows keep their own).
// tabIndex: just that tab of a closed window (History › Recently Closed).
// (Entries from before profiles have no profileId: they're the first profile's.)
const closedProfile = (e) => e.profileId || DEFAULT_PROFILE;
function reopenClosed(index = null, tabIndex = null, w = cur()) {
  if (index == null) {
    if (w?.incognito || w?.profile.guest) {
      const e = w.closedTabs.pop();
      if (e) w.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned, history: e.history });
      return;
    }
    index = recentlyClosed.findLastIndex((e) => closedProfile(e) === (w?.profile.id || DEFAULT_PROFILE));
    if (index < 0) return;
  }
  const entry = recentlyClosed[index];
  if (!entry || !profiles.get(closedProfile(entry))) return; // its profile was deleted
  const p = openProfile(closedProfile(entry));
  if (entry.kind === 'window' && Number.isInteger(tabIndex) && entry.tabs.length > 1) {
    const [t] = entry.tabs.splice(tabIndex, 1);
    if (!t) return;
    entry.active = Math.min(entry.active || 0, entry.tabs.length - 1);
    menuChanged();
    const target = normalWin(p);
    if (!target) { createWindow({ profile: p, tabs: [t], active: 0 }); return; }
    target.tabs.create(t.url, { title: t.title, history: t.history });
    target.focus();
    return;
  }
  const [e] = recentlyClosed.splice(index, 1);
  menuChanged();
  if (e.kind === 'window') { createWindow({ profile: p, ...windowOptions(e) }); return; }
  const target = alive().find((x) => x.id === e.windowId && x.profile === p) || (w && w.profile === p && !w.incognito && !w.closed ? w : normalWin(p));
  if (!target) { createWindow({ profile: p, tabs: [{ url: e.url, title: e.title, history: e.history }], active: 0 }); return; }
  target.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned, history: e.history });
  target.focus();
}

async function savePage(w, tab) {
  const wc = tab?.view?.webContents;
  if (!wc) return;
  const name = (tab.title || 'page').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: path.join(app.getPath('downloads'), `${name}.html`),
    filters: SAVE_FILTERS,
  });
  if (canceled || !filePath) return;
  try {
    await wc.savePage(filePath, saveType(filePath));
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
  // In a focused pop-up window, that window; otherwise every selected tab, like Chrome.
  closeTab: () => { const p = focusedPopup(); if (p) p.close(); else tabStrip.closeSelected(cur()); },
  closeWindow: () => pageWin()?.close(),
  reopenTab: () => reopenClosed(),
  reopenClosed: (index, tabIndex) => reopenClosed(index, tabIndex),
  focusOmnibox: () => cur()?.focusOmnibox(),
  // F6 / Shift+F6: the next or previous part of the window (renderer/ui/a11y.js).
  focusPane: (dir) => {
    const w = cur();
    if (!w) return;
    const fromPage = !!w.tabs.wc()?.isFocused();
    w.win.webContents.focus();
    w.emit('focus-pane', { dir, fromPage });
  },
  // Print preview (main/print.js); a pop-up window's page gets the system dialog.
  print: () => { const p = focusedPopup(); if (p) p.tabs.wc()?.print(); else { const w = cur(); if (w) printPreview.open(w); } },
  printSystemDialog: () => { const p = focusedPopup(); if (p) p.tabs.wc()?.print(); else { const w = cur(); if (w) printPreview.systemDialog(w); } },
  savePage: () => { const w = pageWin(); if (w) savePage(w, w.tabs.active); },
  find: () => { const w = cur(); if (!w || focusedPopup()) return; w.win.webContents.focus(); w.emit('find-open'); },
  findStep: (forward) => cur()?.emit('find-step', { forward }),
  reload: (hard) => pageWin()?.tabs.reload(hard),
  zoom: (step) => pageWin()?.tabs.zoom(step),
  togglePanel: () => cur()?.emit('panel-toggle'),
  toggleSidebar: () => cur()?.emit('sidebar-toggle'),
  focusAI: () => { const w = cur(); if (!w) return; w.win.webContents.focus(); w.emit('ai-focus'); },
  devtools: () => devtools.open(pageWin()?.tabs.wc(), rootStore), // docked where they were last (main/devtools.js)
  shellDevtools: () => cur()?.win.webContents.openDevTools({ mode: 'detach' }),
  back: () => pageWin()?.tabs.back(),
  forward: () => pageWin()?.tabs.forward(),
  history: () => openInternal('lumio://history/'),
  clearBrowsingData: () => openInternal('lumio://settings/clearBrowserData'),
  downloads: () => openInternal('lumio://downloads/'),
  bookmarksManager: () => openInternal('lumio://bookmarks/'),
  extensions: () => openInternal('lumio://extensions/'),
  passwords: () => openInternal('lumio://passwords/'),
  about: () => openInternal('lumio://settings/#about'),
  terms: () => openLegal('terms'),
  privacy: () => openLegal('privacy'),
  credits: () => openInternal('lumio://credits/'),
  settings: () => openInternal('lumio://settings/'),
  bookmark: () => { const w = cur(); w?.profile.bookmarks?.star(w); },
  bookmarkAllTabs: () => { const w = cur(); w?.profile.bookmarks?.allTabs(w); },
  sidePanel: (view, w = cur()) => w?.profile.sidePanel?.show(w, view),
  addToReadingList: () => { const w = cur(); w?.profile.sidePanel?.addTab(w, w?.tabs.active); },
  toggleBookmarksBar: () => { const p = curProfile(); p.bookmarks.setBar(!p.store.settings.showBookmarksBar); },
  setAppearance: (value) => rootStore.setSetting('appearance', value),
  pinTab: () => { const w = cur(); const t = w?.tabs.active; if (t) w.tabs.setPinned(t.id, !t.pinned); },
  moveTabToNewWindow: () => { const w = cur(); if (w?.tabs.active) tabStrip.moveToNewWindow(w, [w.tabs.activeId]); },
  tabSearch: () => cur()?.emit('tab-search'),
  cycle: (dir) => cur()?.tabs.cycle(dir),
  tabIndex: (n) => cur()?.tabs.activateIndex(n),
  makeDefault: () => makeDefaultBrowser(),
  nameWindow: () => powerUser.nameWindow(cur()),
  toggleCaretBrowsing: () => powerUser.toggleCaretBrowsing(cur()),
  webStore: () => { const w = normalWin() || createWindow(); w.tabs.create('https://chromewebstore.google.com/'); w.focus(); },
  fullscreen: () => { const w = cur(); if (w) w.win.setFullScreen(!w.win.isFullScreen()); },
  quit: () => app.quit(),
  taskManager: () => taskManager.open(cur()?.win),
  profilePicker: () => picker.open(),
  addProfile: () => picker.open({ mode: 'add' }),
  openProfile: (id) => switchToProfile(id),
  newGuest: () => openGuest(),
  readingMode: () => { const w = cur(); if (!w) return; w.win.webContents.focus(); w.emit('reader-open', { toggle: true }); },
  translatePage: () => { const w = cur(); if (w?.tabs.active) w.emit('translate-prompt', { tabId: w.tabs.activeId, force: true }); },
  // Save and share: copy, qr, send, open (the Share popover), screenshot, save, install, shortcut, native (main/share.js).
  share: (what) => { const w = cur(); if (w) shareTools.command(w, what); },
  apps: () => openInternal('lumio://apps/'),
  safetyCheck: () => openInternal('lumio://settings/#safety'), // Settings › Safety check (batch 6)
};

// Back/forward menus, swipes, the link status bubble, zoom, Home, start pages… (main/navigation.js)
const navigation = new Navigation({
  // Zoom levels, the home page and start pages: the front window's profile's
  // (the first profile's before any window opens).
  get store() { return cur()?.profile.base.store || rootStore; },
  alive, cur, ensureWin, normalWin, tabOfWc,
  createWindow: (opts) => createWindow(opts),
  openInternal: (url) => openInternal(url),
});
Object.assign(cmd, navigation.commands());

// The tab strip: its menus, several tabs at once, moving and dragging tabs
// between windows, drops, tab search (main/tab-strip.js, tab-drag.js,
// tab-search.js); bars over the page; sessions with each tab's history
// (main/sessions.js); the Dock and taskbar (main/os-integration.js).
const infobars = new Infobars();
// (Sessions with crash restore are the first profile's: the others reopen what they had.)
const sessions = new Sessions({ infobars, recentlyClosed, createWindow: (opts) => createWindow({ profile: openProfile(DEFAULT_PROFILE), ...opts }), recentChanged: () => menuChanged() });
// A window's profile's closed tabs and windows (Recently Closed, tab search, the tab menu).
const ownsClosed = (w, e) => closedProfile(e) === w.profile.base.id;
const tabStrip = new TabStrip({
  alive, recentlyClosed, ownsClosed,
  createWindow: (opts) => createWindow(opts),
  reopenClosed: (w) => reopenClosed(null, null, w),
  bookmarkAllTabs: (w) => w.profile.bookmarks?.allTabs(w),
  removeExtensionTab: (wc, w) => w.profile.extensions?.removeTab(wc),
  detached: (w, tab) => { if (printPreview?.stateOf(w)?.tab === tab) printPreview.close(w, { focusPage: false }); },
  get siteMute() { return siteMute; },
  // Tab groups, the reading list, split view and tabs to the side in the tab
  // menu (main/groups-service.js, side-panel.js, split-view.js, tab-layout.js).
  menuExtras: (w, ids, tab) => ({
    groups: w.profile.groups?.menuItems(w, tab, ids) || [],
    reading: w.profile.sidePanel?.menuItem(w, tab) || [],
    split: ids.length === 1 ? w.tabs.split.menuItems(tab) : [], // (a split pairs two tabs)
    layout: tabLayout.menuItems(w, w.profile.store),
  }),
  stripExtras: (w) => [{ label: 'Name Window…', click: () => powerUser.nameWindow(w) }, { type: 'separator' }, ...tabLayout.menuItems(w, w.profile.store)],
});
const tabSearch = new TabSearch({ alive, recentlyClosed, ownsClosed, reopenClosed: (index) => reopenClosed(index) });
const tabDrag = new TabDrag({ alive, cur, strip: tabStrip });
const osIntegration = new OsIntegration({ cmd, alive });

function openInternal(url) {
  // Browser pages open in a normal window, even from incognito.
  const w = normalWin() || createWindow({ urls: [url] });
  const existing = w.tabs.tabs.find((t) => (t.pendingUrl || t.url || '').startsWith(url));
  if (existing) w.tabs.activate(existing.id);
  else w.tabs.create(url);
  w.focus();
}

// Lumio's Terms of Service and Privacy Policy, on the Lumio website (its
// address follows main/account.js), in a normal window like Lumio's pages.
const LEGAL = { terms: '/terms', privacy: '/privacy' };
function openLegal(which) {
  const p = curProfile();
  const url = p.account.url(LEGAL[which]);
  const w = normalWin(p);
  if (!w) { createWindow({ profile: p, urls: [url] }); return; }
  w.tabs.create(url);
  w.focus();
}
// Light or dark changed (main/theme.js): native colors follow in every window
// and the payment window, and the View menu shows the choice.
function appearanceChanged() {
  for (const w of alive()) w.applyAppearance();
  apps?.applyAppearance();
  if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.setBackgroundColor(theme.colors(theme.isDark()).frame);
  menuChanged();
}

function openUrl(url, disposition = 'tab', from = cur()) {
  // A mailto: bookmark opens the mail app (asking first), from the tab you're on.
  if (external.classify(url) === 'external') { (from && !from.closed ? from : ensureWin()).tabs.navigate(url); return; }
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
// getDisplayMedia (Google Meet, Zoom, Discord on the web). Lumio shows the
// screens, windows and other tabs to choose from, over the tab that asked.
// Its picker lists screens and windows only when macOS lets Lumio record the
// screen; without that, macOS 15+ shows its own picker instead (it needs no
// permission, but can't share a tab). macOS restarts an app whose Screen
// Recording permission changes, so checking once per session is enough.
// What's shared is tracked for the capture indicators (main/capture.js).
const screenRecordingAllowed = () => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted';
const sharePending = new Map(); // id -> { callback, w, audio, sources, wcId, host }
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
    // Another tab of this profile, with its sound; tabs need no macOS permission.
    const tabs = shareableTabs(alive().filter((x) => x.profile === w.profile), wc);
    if (!sources.length && !tabs.length) {
      w.emit('toast', { text: process.platform === 'darwin' ? 'To share your screen, turn on Lumio Browser in System Settings › Privacy & Security › Screen Recording.' : 'Nothing to share right now.' });
      return callback({});
    }
    shareCancel(w);
    const id = nextShareId++;
    let host = '';
    try { host = new URL(request.securityOrigin || wc.getURL()).host; } catch { /* keep empty */ }
    sharePending.set(id, { callback, w, audio: !!request.audioRequested, sources, wcId: wc.id, host });
    const b = tab.view?.getBounds() || { x: 0, y: 90, width: 900, height: 600 };
    const width = Math.min(560, b.width - 24);
    w.showOverlay(
      { x: b.x + Math.round((b.width - width) / 2), y: b.y + 12, width, height: Math.min(560, b.height - 24) },
      {
        kind: 'screenshare',
        share: {
          id, host, audio: !!request.audioRequested,
          // No screens to list on a Mac means Screen Recording is off for Lumio.
          screensOff: !sources.length && process.platform === 'darwin',
          sources: sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() })),
          tabs: tabs.map((t) => ({ id: t.id, name: t.name, url: t.url, favicon: t.favicon })),
        },
      },
    );
  }, { useSystemPicker: !screenRecordingAllowed() });
}
// tabAudio: share a tab's sound too (when the site asked for sound).
function shareAnswer(id, sourceId, { tabAudio = true } = {}) {
  const p = sharePending.get(id);
  if (!p) return;
  sharePending.delete(id);
  const answer = (streams) => { try { p.callback(streams); return true; } catch { return false; } }; // the page may be gone
  const target = /^tab:\d+$/.test(sourceId || '') ? webContents.fromId(Number(sourceId.slice(4))) : null;
  if (target && !target.isDestroyed() && tabOfWc(target)?.w.profile === p.w.profile) {
    if (answer({ video: target.mainFrame, ...(p.audio && tabAudio ? { audio: target.mainFrame } : {}) })) {
      security?.capture.shared(p.wcId, { kind: 'tab', title: target.getTitle(), target: target.id, host: p.host });
    }
    return;
  }
  const source = sourceId && p.sources.find((s) => s.id === sourceId);
  // System audio can only be shared on Windows (loopback).
  if (answer(source ? { video: source, ...(p.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) } : {}) && source) {
    security?.capture.shared(p.wcId, { kind: source.id.startsWith('screen:') ? 'screen' : 'window', title: source.name, host: p.host });
  }
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

// Clear a profile's browsing data (main/browsing-data.js). range:
// milliseconds back from now, or 0 for all time.
function clearData(p, { range = 0, what = [] } = {}) {
  return p.browsingData.clear({ range: Number(range) || 0, what: Array.isArray(what) ? what.map(String) : [] });
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

const ALL_PAGES = ['newtab', 'error', 'history', 'settings', 'downloads', 'bookmarks', 'extensions', 'passwords', 'welcome', 'credits', 'version', 'flags-lite'];

function registerIpc() {
  handle('shell:init', (w) => {
    const { store, account, extensions } = w.profile;
    return {
      tabs: w.tabs.state(),
      downloads: w.profile.downloads.list(),
      panel: { open: store.settings.panelOpen, width: store.settings.panelWidth },
      sidebar: { open: store.settings.sidebarOpen !== false, getStarted: store.settings.getStartedDone !== true },
      tabLayout: w.tabLayout, // tabs at the top or to the side (main/tab-layout.js)
      ai: w.ai.state(),
      bookmarks: w.profile.bookmarks.payload(),
      savedGroups: w.incognito ? [] : w.profile.groups.payload(),
      side: { view: store.settings.sidePanelView || 'ai', unread: w.profile.sidePanel.reading.unread() },
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

  on('layout:slot', (w, rect) => { w.tabs.setSlot(rect); w.indicator.place(); printPreview.place(w); screenshots.place(w); });
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
  on('tab:bookmark', (w) => w.profile.bookmarks.star(w));
  on('tab:focus-page', (w) => w.tabs.wc()?.focus());
  on('tab:hovercard', (w, msg) => (msg?.hide ? w.hideHoverCard({ now: !!msg.now }) : w.showHoverCard(msg)));
  on('window:new', (w) => createWindow({ profile: w.profile.base }));
  // Tabs to the side (main/tab-layout.js) and split view (main/split-view.js).
  on('layout:tabs', (w, patch) => tabLayout.set(w, patch || {}, w.profile.store));
  on('layout:split', (w, rects) => w.tabs.split.setRects(rects));
  on('layout:split-preview', (w, rect) => w.tabs.split.setPreview(rect));
  on('tab:split', (w, { id, base, side } = {}) => w.tabs.split.dropOnEdge(id, { base, side }));
  on('tab:split-ratio', (w, { id, ratio } = {}) => w.tabs.split.setRatio(id, ratio));
  on('tab:split-swap', (w, id) => w.tabs.split.swap(id));
  on('tab:split-separate', (w, id) => w.tabs.split.separate(id));
  // The ⋮ menu, drawn by the overlay (main/window.js showMenu). edit: the
  // shell had a text field focused, so Cut, Copy and Paste act there, not on the page.
  on('app:menu', (w, opts = {}) => {
    const wc = w.tabs.wc();
    const url = w.tabs.active ? w.tabs.displayUrl(w.tabs.active) : '';
    // The bookmarks bar's own pages (folders open from the bar itself).
    const marks = w.profile.bookmarks.payload().items.filter((b) => b.url);
    w.showMenu(opts, buildBrowserMenu(cmd, {
      ...menuState(),
      zoom: wc ? Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100) : 100,
      bookmarked: w.profile.bookmarks.isBookmarked(url),
      bookmarks: marks,
      open: (u) => openUrl(u, 'current', w),
      whatsNew: updater?.state?.notesUrl ? () => openUrl(updater.state.notesUrl, 'tab', w) : null,
      edit: (op) => {
        const target = opts.edit ? w.win.webContents : w.tabs.wc();
        if (!target) return;
        target.focus();
        target[op]();
      },
    }));
  });
  on('window:incognito', (w) => createWindow({ profile: w.profile.base, incognito: true }));

  // (The address bar's suggestions: each profile's OmniboxService, addProfileServices.)

  on('overlay:show', (w, { rect, payload }) => { w.showOverlay(rect, payload); perf.overlayShown(w, payload); });
  // The shell names the dropdown it means, so it can't close one it didn't open.
  on('overlay:hide', (w, kind) => { if (!kind || !w.overlayKind || w.overlayKind === kind) w.hideOverlay({ quiet: true }); });
  // Dropdowns that size themselves (account menu, site info).
  on('overlay:size', (w, { height }) => {
    if (!w.win.contentView.children.includes(w.overlay) || !Number.isFinite(height)) return;
    const b = w.overlay.getBounds();
    const max = w.win.getContentSize()[1] - b.y - 8;
    w.overlay.setBounds({ ...b, height: Math.max(60, Math.min(Math.round(height), max)) });
  });
  // A page's dialog in its tab was answered: only by the dialog view itself
  // (main/dialog-view.js), not the window's other views.
  ipcMain.on('dialog:answer', (e, answer) => {
    const w = windowOfWc(e.sender);
    if (w && e.sender === w.dialogs?.view?.webContents) w.dialogs.answer(answer || {});
  });
  // "Press Esc to exit full screen" measured itself (main/access-notice.js).
  on('notice:size', (w, size) => w.notice.resize(size || {}));
  // A pop-up window's bar (renderer/ui/popup.html).
  handle('popup:init', (w) => (w instanceof PopupWin ? { tabs: w.tabs.state(), incognito: w.incognito, platform: process.platform } : null));
  on('popup:open-in-tab', (w) => { if (w instanceof PopupWin) w.openInTab(); });
  on('overlay:pick', (w, item) => {
    if (item?.kind === 'screenshare') {
      const p = sharePending.get(Number(item.id));
      if (p?.w === w) shareAnswer(Number(item.id), typeof item.source === 'string' ? item.source : null, { tabAudio: item.audio !== false });
    }
    // The blocked pop-ups list took the keyboard (payload.focus): it goes back to the bar.
    const giveBack = item?.kind === 'popups' && w.overlay.webContents.isFocused();
    w.hideOverlay();
    if (giveBack) w.win.webContents.focus();
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

  // (Bookmarks, tab groups and saved groups, the side panel and reading list,
  // and the new tab page's shortcuts are each profile's: addProfileServices.)

  // ---- site info (lock icon) ----
  handle('site:info', (w) => siteInfo(w));
  // value: 'allow', 'block', 'session', or 'default' to go back to the default.
  on('site:set-permission', async (w, { permission, value }) => {
    const info = await siteInfo(w);
    if (!info) return;
    w.profile.permissions.set(info.origin, String(permission), String(value));
    w.emit('site-info', await siteInfo(w));
  });
  on('site:reset-permissions', async (w) => {
    const info = await siteInfo(w);
    if (!info) return;
    w.profile.permissions.settings.resetSite(info.origin);
    w.emit('site-info', await siteInfo(w));
  });
  on('site:clear-data', async (w) => {
    const info = await siteInfo(w);
    if (!info) return;
    await w.profile.session.clearStorageData({ origin: info.origin });
    w.emit('toast', { text: `Cleared data for ${info.host}` });
    w.hideOverlay();
    w.tabs.reload(false);
  });
  on('site:settings', async (w) => {
    const info = await siteInfo(w);
    openInternal(info && !w.incognito ? `lumio://settings/content/siteDetails?site=${encodeURIComponent(info.origin)}` : 'lumio://settings/content');
  });
  // Pop-ups the page tried to open on its own (the address bar's icon).
  handle('site:popups', async (w) => {
    const tab = w.tabs.active;
    if (!tab?.blockedPopups?.length) return null;
    const info = await siteInfo(w); // only a website can be always allowed
    w.popupsSite = info?.origin || null; // what "Always allow" is about
    return {
      host: info?.host || null,
      allowed: !!info && w.profile.permissions.allowsPopups(info.origin),
      items: tab.blockedPopups.map(({ id, url }) => ({ id, url })),
    };
  });
  on('site:popup-open', (w, id) => { const tab = w.tabs.active; if (tab) w.tabs.openBlockedPopup(tab, Number(id)); });
  on('site:popups-allow', async (w, allow) => {
    const info = await siteInfo(w);
    // Only the site the list was shown for: the page may have moved on since.
    // (Site settings › Pop-ups and redirects; "Continue blocking" goes back to the default.)
    if (info && info.origin === w.popupsSite) w.profile.permissions.set(info.origin, 'popups', allow ? 'allow' : 'default');
  });
  // "Turn on warnings": forget the certificate you went past for this site.
  on('site:cert-revoke', async (w) => {
    const info = await siteInfo(w);
    if (!info?.certBypass) return;
    certErrors.revoke(w.profile.session, info.host);
    await w.profile.session.closeAllConnections?.().catch(() => {}); // connections that already trust it
    w.hideOverlay();
    w.tabs.reload(false);
  });

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
  on('account:close-incognito', (w) => tabHolders().filter((x) => x.incognito && x.profile === w.profile).forEach((x) => x.close())); // its pop-ups too
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

  // ---- media controls, Share, screenshots and installed apps
  media.register({ handle, on, tabOfWc });
  shareTools.register({ handle, on });
  screenshots.register();
  apps.register({ on, internalHandle });

  // ---- internal pages ----
  internalHandle('page:newtab-data', ['newtab'], ({ w }) => {
    const { store, account } = w.profile;
    return {
      bookmarks: store.marks.recent(12),
      engine: searchEngines.defaultEngine(store.settings).name,
      aiReady: w.ai.state().ready,
      incognito: w.incognito,
      // "Good morning, Juan": the profile name they chose, else their Lumio account name.
      name: w.profile.guest ? null : firstName(store.settings.profile?.name || account.state().name),
      chats: w.incognito ? [] : w.ai.listChats().slice(0, 3),
    };
  });
  internalHandle('page:open-chat', ['newtab'], ({ w }, id) => w.openChat(String(id || '')));
  accessibility.register({ internalHandle, store: rootStore }); // Lumio's own look: for every profile
  // (Customize Lumio, the New Tab page's sheet, is each profile's: addProfileServices.)
  internalHandle('page:navigate', ALL_PAGES, ({ w, tab }, input) => w.tabs.navigate(input, tab.id));
  internalHandle('page:open', ALL_PAGES, ({ w }, url, disposition) => openUrl(String(url || ''), disposition, w));
  internalHandle('page:ask-ai', ['newtab'], ({ w }, text) => w.askAI(String(text || ''), { includePage: false, full: true }));

  // "Your connection is not private" (renderer/pages/cert.html, under the
  // error host). The page only shows details: Proceed uses what Lumio itself
  // recorded for the tab when the certificate failed, never the page's word.
  const certFor = (sender, tab) => {
    let failed = '';
    try { failed = new URL(sender.getURL()).searchParams.get('url') || ''; } catch { /* no address */ }
    return tab.certError && tab.certError.url === failed ? tab.certError : null;
  };
  internalHandle('page:cert-info', ['error'], async ({ sender, tab }) => {
    const rec = certFor(sender, tab);
    if (!rec) return null;
    const hsts = rec.overridable && await certErrors.usesHsts(sender.session, rec.host);
    return { host: rec.host, code: rec.code, reason: rec.reason, cert: rec.cert, hsts, canProceed: rec.overridable && !hsts };
  });
  internalHandle('page:cert-proceed', ['error'], async ({ sender, w, tab }) => {
    const rec = certFor(sender, tab);
    if (!rec?.overridable || await certErrors.usesHsts(sender.session, rec.host)) return false;
    certErrors.allow(sender.session, rec.host, rec.fingerprint);
    tab.certError = null;
    w.tabs.navigate(rec.url, tab.id);
    return true;
  });
  internalHandle('page:cert-back', ['error'], ({ w, tab }) => w.tabs.backToSafety(tab.id));

  // Open-source licenses (renderer/pages/credits.html).
  internalHandle('page:credits', ['credits'], ({ w }) => ({ ...credits(), terms: w.profile.account.url(LEGAL.terms), privacy: w.profile.account.url(LEGAL.privacy) }));

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
    profileId: closedProfile(e),
  })).filter((e) => e.profileId === w.profile.id).reverse());
  internalHandle('page:reopen-closed', ['history'], (_ctx, index) => { if (Number.isInteger(index)) reopenClosed(index); });
  internalHandle('page:clear-data', ['history', 'settings', 'downloads'], async ({ w }, opts) => {
    const done = await clearData(w.profile.base, opts);
    w.emit('toast', { text: 'Browsing data deleted' });
    return done;
  });
  // (Site settings and Delete browsing data's pages: registerSiteIpc, each profile's in addProfileServices.)

  internalHandle('page:downloads', ['downloads'], ({ w }) => w.profile.downloads.all());
  internalHandle('page:download-action', ['downloads'], ({ w }, id, action) => w.profile.downloads.action(id, action));
  internalHandle('page:downloads-clear', ['downloads'], ({ w }) => w.profile.downloads.clearAll());

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
      verticalTabs: !!store.settings.verticalTabs, // tabs to the side (main/tab-layout.js)
      ai: w.ai.state(),
      version: app.getVersion(),
      update: updater?.state || null,
      isDefault: app.isDefaultProtocolClient('https'),
      legal: { terms: account.url(LEGAL.terms), privacy: account.url(LEGAL.privacy) },
      importSources: importer.detect(),
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
    if (key === 'showBookmarksBar') w.profile.bookmarks.setBar(!!value);
    // Tabs to the side: the profile's choice, for its windows now and new ones.
    if (key === 'verticalTabs') { store.setSetting('verticalTabs', !!value); profileWindows(w.profile.base).forEach((x) => tabLayout.set(x, { vertical: !!value }, store)); }
    if (key === 'appearance' && theme.APPEARANCES.includes(value)) rootStore.setSetting('appearance', value); // app-wide
    if (key === 'startup' && STARTUP.includes(value)) store.setSetting('startup', value);
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
    beforeRelaunch: (w) => powerUser.confirmRelaunch(w), // asks while Lumio AI is busy
    onReset: (w) => {
      const p = w.profile.base;
      p.bookmarks.changed();
      profileWindows(p).forEach((x) => x.emit('profile', profileState(p)));
      services.broadcastAIState();
      menuChanged();
    },
  });
  // Settings › Performance (app-wide: main/perf.js)
  internalHandle('page:performance', ['settings'], () => perf.pageState());
  internalHandle('page:set-performance', ['settings'], ({ w }, key, value) => (w.profile.guest ? perf.pageState() : perf.set(String(key), value))); // app-wide: not a Guest's
  internalHandle('page:task-manager', ['settings'], ({ w }) => { taskManager.open(w.win); });
  internalHandle('page:make-default', ['settings', 'welcome'], () => makeDefaultBrowser());
  // "Send crash reports to Lumio" (main/crash-reports.js): Settings › Privacy and the welcome screens.
  internalHandle('page:crash-reports', ['settings', 'welcome'], () => crashReports.state());
  // Crash reports are Lumio's own setting (the computer owner's: Guest can't change it).
  internalHandle('page:set-crash-reports', ['settings', 'welcome'], ({ w }, on) => (w.profile.guest ? crashReports.state() : crashReports.setEnabled(rootStore, on === true)));
  internalHandle('page:protected-content', ['settings'], () => drm.status());
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
    if (res.ok) w.profile.bookmarks.changed();
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
        const added = w.profile.store.importBookmarks(importer.parseBookmarksHtml(text), { folder: 'Imported' });
        w.profile.bookmarks.changed();
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

  navigation.register({ handle, on, internalHandle });
  infobars.register({ handle, on });
  tabStrip.register({ on, internalHandle });
  tabSearch.register({ handle, on });
  tabDrag.register({ on });
  osIntegration.register({ on });
  defaultBrowser.register({ internalHandle, store: rootStore, infobars, alive });
  sadTab.register({ internalHandle });
}

async function siteInfo(w) {
  const tab = w.tabs.active;
  const url = tab ? w.tabs.displayUrl(tab) : '';
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  // On the certificate warning, or past one: not private.
  const certError = (tab.pendingUrl || tab.url || '').startsWith('lumio://error/cert');
  const certBypass = !certError && certErrors.bypassed(w.profile.session, url);
  // Cookies are kept per site (example.com), whichever page set them.
  const site = await sites.siteOf(u.hostname);
  const cookies = await w.profile.session.cookies.get({ domain: site }).catch(() => []);
  return {
    origin: u.origin,
    host: u.host,
    secure: u.protocol === 'https:' && !certError && !certBypass,
    certError,
    certBypass,
    incognito: w.incognito,
    permissions: w.profile.permissions.forOrigin(u.origin),
    cookies: cookies.length,
    trackers: w.profile.security?.extras.blockedOn(tab.view?.webContents.id) || 0, // stopped on this page
    reload: w.profile.siteControls.needsReload(tab.view?.webContents),
  };
}

// ---------------------------------------------------------------- app
// Each in a new tab, like Chrome (opening the same file again too).
function openExternalUrls(urls) {
  if (!urls.length) return;
  const w = normalWin();
  if (!w) { createWindow({ urls }); return; }
  urls.forEach((u) => w.tabs.create(u));
  w.focus();
}

// Links and files other apps hand to Lumio. They can come before Lumio is
// ready (they launched it): those wait for the first windows.
function openFromSystem(url) {
  // (While the profile picker is up, they wait for the profile chosen there.)
  if (launched && (alive().length || !picker?.isOpen)) openExternalUrls([url]); else pendingUrls.push(url);
}

app.on('open-url', (e, url) => {
  e.preventDefault();
  openFromSystem(url);
});

// macOS: a file opened with Lumio from Finder ("Open With", a double-click
// when Lumio is the default) or dropped on its Dock icon. Kinds it can't show
// are left to macOS, which says it can't open them.
app.on('open-file', (e, file) => {
  const url = fileUrl(file);
  if (!url) return;
  e.preventDefault();
  openFromSystem(url);
});

// ---------------------------------------------------------------- links to other apps
// mailto:, zoommtg:, slack:… (the rules are in main/external-protocols.js):
// open the app, after asking in the tab, or do nothing. typed: from the
// address bar or a bookmark. requestingUrl and isMainFrame: the frame that
// asked, when a page did.
async function openExternalLink(w, tab, { url, typed = false, requestingUrl = '', isMainFrame = true }) {
  const wc = tab.view?.webContents;
  if (!url || !wc || wc.isDestroyed() || tab.agent) return; // a helper AI's tab has nobody to ask
  if (tab.dialogs?.some((d) => d.spec.kind === 'external')) return; // one prompt at a time
  const origin = typed ? null : external.originOf(requestingUrl || wc.getURL());
  const topOrigin = external.originOf(wc.getURL());
  const key = external.permissionKey(url);
  const verdict = external.decide({
    url,
    typed,
    origin,
    isMainFrame,
    topOrigin,
    // A frame from another site needs a click inside a frame, not on the page.
    activated: tab.owner.recentlyActivated(tab, { frame: !isMainFrame && origin !== topOrigin }),
    locked: !!tab.externalLock,
    remembered: !!origin && w.profile.permissions.remembered(origin, key) === true,
  });
  if (verdict === 'deny') return;
  tab.externalLock = true; // the next one waits for another click in the page
  const target = external.escapeUrl(url);
  const name = target && external.appLabel(app.getApplicationNameForProtocol(target));
  if (!name) return; // no app on this computer opens it
  if (verdict === 'ask') {
    const answer = await tab.owner.ask(tab, external.askSpec({ app: name, origin, incognito: w.incognito }));
    if (answer.button !== 'open') return;
    if (answer.checked && origin) w.profile.permissions.set(origin, key, true);
  }
  shell.openExternal(target).catch(() => {});
}

// Chromium asked to open another app for a page (a link, a frame, a redirect).
function externalRequest(wc, details) {
  const found = tabOfWc(wc);
  if (found) openExternalLink(found.w, found.tab, { url: details.externalURL, requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame !== false });
}

// A click in a frame from another site on a tab's page (preload/internal.js
// sees the page get the person's activation while focus is in that frame):
// it counts like a click on the page, so a "Sign in with…" button there can
// open its pop-up.
ipcMain.on('user-activation', (e) => {
  const found = e.senderFrame === e.sender.mainFrame && tabOfWc(e.sender);
  if (found) found.tab.owner.noteActivation(found.tab, { frame: true });
});

// The person sent a form on a tab's page (preload/internal.js): it may leave
// without "Leave site?", so the form's data isn't lost (main/tabs.js).
ipcMain.on('form-sent', (e) => {
  const found = e.senderFrame === e.sender.mainFrame && tabOfWc(e.sender);
  if (found) found.tab.sentForm = Date.now();
});

// A page hid the pointer (pointer lock): "Press Esc to show your cursor".
function pointerLocked(wc) {
  const found = tabOfWc(wc);
  if (found) found.w.notice.pointerLock(found.tab);
}

// ---------------------------------------------------------------- page dialogs and safety
// alert(), confirm() and prompt() from a tab's page (preload/internal.js).
// The page waits on this synchronous message until the person answers in
// its tab (main/page-dialogs.js).
ipcMain.on('js-dialog', (e, req) => {
  const reply = (value) => { try { e.returnValue = value ?? null; } catch { /* the page is gone */ } };
  const kind = ['alert', 'confirm', 'prompt'].includes(req?.kind) ? req.kind : null;
  const found = kind && tabOfWc(e.sender);
  const frame = e.senderFrame;
  if (!found || !frame || frame !== e.sender.mainFrame) { reply(pageDialogs.blankAnswer(kind)); return; }
  pageDialogs.jsDialog(found.tab, { kind, message: req.message, value: req.value, url: frame.url })
    .then(reply, () => reply(pageDialogs.blankAnswer(kind)));
});

// HTTP sign-in (Basic, Digest, proxies) for a tab or a pop-up's page: "Sign
// in to access this site" over it. Anything else (Lumio's own requests, its
// hidden pages) is cancelled, as Electron does by default.
app.on('login', (event, wc, details, authInfo, callback) => {
  const found = wc && tabOfWc(wc);
  if (!found) return;
  event.preventDefault();
  pageDialogs.signIn(found.tab, { details, authInfo })
    .then((creds) => (creds ? callback(creds.username, creds.password) : callback()), () => callback());
});

// A certificate Chromium doesn't trust. Only one you chose to go past (on the
// "Your connection is not private" page) is let through, for this session;
// for a tab's page, what failed is kept for that page to show.
app.on('certificate-error', (event, wc, url, error, cert, callback, isMainFrame) => {
  event.preventDefault();
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  // (Only for an error you could have gone past: a certificate since revoked isn't.)
  const ok = !!wc && certErrors.OVERRIDABLE.has(certErrors.errorName(error)) && certErrors.isAllowed(wc.session, host, cert?.fingerprint);
  const found = !ok && isMainFrame && wc && tabOfWc(wc);
  if (found) found.tab.certError = certErrors.record(url, error, cert);
  callback(ok);
});

// A page handed off from an iPhone, iPad or another Mac.
handoff.listen((url) => { if (launched && windows.size) openExternalUrls([url]); else pendingUrls.push(url); });

app.on('second-instance', (_e, argv) => {
  const urls = launchTargets(argv.slice(1));
  // Still starting (extensions, the DRM wait): links wait for the first
  // windows, and nothing opens before Lumio's messages and menu are set up.
  if (!launched) { pendingUrls.push(...urls); return; }
  if (apps?.launch(argv)) return; // an installed app's launcher (main/app-launchers.js)
  if (urls.length && alive().length) openExternalUrls(urls);
  else if (urls.length && picker?.isOpen) pendingUrls.push(...urls);
  else if (urls.length) openExternalUrls(urls);
  else if (!alive().length && (picker?.isOpen || profiles?.wantsPicker())) picker.open();
  else ensureWin().focus();
});

// ---------------------------------------------------------------- profiles
// Opens a profile's services the first time it's used: its session, files,
// Lumio account, sync, extensions. It stays open until Lumio quits.
// Services kept per profile (bookmarks, the reading list and saved groups,
// search engines, site data…) register their messages once: each message goes
// to the instance of the profile of the window it came from (an incognito
// window's profile's).
const routes = new Map(); // "kind channel" -> Map(profile id -> handler)
function profileIpc(profile) {
  const route = (kind, real, windowOf) => (channel, ...rest) => {
    const fn = rest.pop();
    const key = `${kind} ${channel}`;
    if (!routes.has(key)) {
      const byProfile = new Map();
      routes.set(key, byProfile);
      real(channel, ...rest, (first, ...args) => {
        const handler = byProfile.get(windowOf(first)?.profile.base.id);
        if (!handler) { if (kind === 'on') return undefined; throw new Error('Not allowed'); }
        return handler(first, ...args);
      });
    }
    routes.get(key).set(profile.id, fn);
  };
  return {
    on: route('on', on, (w) => w),
    handle: route('handle', handle, (w) => w),
    internalHandle: route('internal', internalHandle, (ctx) => ctx.w),
  };
}
// Every profile's and Guest's own services from the other parts of Lumio.
function addProfileServices(profile) {
  const { store, dir } = profile;
  const ipc = profileIpc(profile);
  const wins = () => alive().filter((w) => w.profile.base === profile);
  const inProfile = (opts = {}) => createWindow({ profile, ...opts });
  profile.bookmarks = new BookmarksService({ store, windows: wins, cmd, openUrl, openInternal, createWindow: inProfile, menuChanged });
  profile.groups = new GroupsService({
    dir,
    windows: wins,
    createWindow: inProfile,
    detached: (w, tab) => { if (tab.view && !w.incognito) w.profile.extensions?.removeTab(tab.view.webContents); },
  });
  profile.sidePanel = new SidePanel({ dir, store, bookmarks: profile.bookmarks, windows: wins, openUrl });
  profile.omnibox = new OmniboxService({ store, dir, windows: wins, cmd, openUrl, openInternal, fetch: (url, init) => net.fetch(url, init) });
  profile.siteData = new SiteData({ profile, store, sites });
  profile.browsingData = new BrowsingData({
    store, profile, passwords: profile.passwords, recentlyClosed,
    ownsClosed: (e) => closedProfile(e) === profile.id,
    clock: new CookieClock(dir, profile.session),
    // Recently closed windows waiting in the session file go too (main/sessions.js).
    onClosedChanged: () => { if (profile.id === DEFAULT_PROFILE) sessions.forget(alive()); menuChanged(); saveSessionSoon(); },
    stopAI: () => wins().filter((w) => !w.incognito).forEach((w) => w.ai.stop()),
    siteOf: (host) => sites.siteOf(host),
  });
  // Translating pages and reading mode: their settings are the profile's.
  profile.translator = new Translator({ store, account: profile.account, windowOf: (tab) => tabHolders().find((w) => w.tabs === tab.owner) || null });
  profile.reader = new Reader({ store });
  profile.translator.register(ipc);
  profile.reader.register(ipc);
  profile.autofill?.register({ ...ipc, pages: false }); // (the pages' own messages: AutofillManager.registerPages)
  profile.bookmarks.register(ipc);
  profile.groups.register(ipc);
  profile.sidePanel.register(ipc);
  profile.omnibox.register(ipc);
  new NtpShortcuts({ store }).register(ipc);
  // Customize Lumio (the New Tab page's sheet): the theme is Lumio's, for every profile.
  const customizeStore = {
    get settings() { return store.settings; },
    setSetting: (key, value) => (key === 'appearance' ? rootStore : store).setSetting(key, value),
  };
  require('./customize').register({ internalHandle: ipc.internalHandle, store: customizeStore, dir, dialog, nativeImage, theme, setProfile: (patch) => setProfile(profile, patch) });
  registerSiteIpc({ on: ipc.on, internalHandle: ipc.internalHandle, normal: () => profile, store, siteData: profile.siteData, browsingData: profile.browsingData, openInternal });
}

// The profiles open now, and Guest's.
const openProfiles = () => [...loaded.values(), ...(guest ? [guest] : [])];

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
  store.onBookmarkIcons = () => profile.bookmarks?.changed();
  profile.downloads = new Downloads(ses, { store, emit: (c, p) => alive().filter((w) => w.profile === profile).forEach((w) => w.emit(c, p)), gate: (wc, url) => profile.siteControls?.gate(wc, url) ?? true });

  const account = new LumioAccount({
    store,
    onChange: (state) => {
      wins().forEach((w) => { w.emit('account', state); w.ai.refreshCapabilities(); });
      services.broadcastAIState();
      profile.sync?.soon(500);
      menuChanged(); // Profiles › Sign In / Manage Your Lumio Account
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
  // Addresses, cards and form entries (main/autofill.js).
  profile.autofill = new AutofillManager({ dir, safeStorage, settings: store, helper, findTab: tabOfWc, toast: (w, text) => w.emit('toast', { text }), openPage: (url) => openInternal(url) });
  store.historyFile.onSave(historyMenuSoon); // History › Recently Visited
  profile.permissions = new Permissions(ses, { store, emitFor, persist: true, openExternal: externalRequest, onPointerLock: pointerLocked });
  addProfileServices(profile);

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
    syncAdapters.bookmarkTree(store),
    syncAdapters.readingList(profile.sidePanel.reading),
    syncAdapters.savedGroups(profile.groups.saved),
    syncAdapters.history(store),
    syncAdapters.passwords(passwords.store),
    syncAdapters.passkeys(passwords.passkeys),
    syncAdapters.addresses(profile.autofill.store),
    syncAdapters.cards(profile.autofill.store),
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
  for (const f of [store.bookmarksFile, store.historyFile, store.settingsFile, store.chatsFile, store.sessionFile, passwords.store.file, passwords.passkeys.file, profile.autofill.store.file]) f.onSave(syncSoon);
  // Passkeys tell sites they're backed up while Lumio Sync carries them.
  passwords.passkeys.backedUp = () => sync.status === 'ready' && sync.prefs.on && sync.prefs.types.passkeys;
  workflows.onChange(syncSoon);
  profile.sidePanel.reading.onChange(syncSoon);
  profile.groups.saved.onChange(syncSoon);
  projects.onChange(syncSoon);
  // Bookmarks from another device: redraw the bar.
  store.bookmarksFile.onSave(() => { if (sync.busy) profile.bookmarks.changed(); });
  sync.start();
  const companion = new CompanionBridge({
    sync,
    windows: () => alive().filter((w) => !w.incognito && w.profile === profile),
    pickWindow: () => (lastFocused && !lastFocused.incognito && lastFocused.profile === profile && windows.has(lastFocused) ? lastFocused : normalWin(profile) || createWindow({ profile, focus: false })),
    openChat: (w, chatId) => w.openChat(chatId, { full: false }),
    onTab: (tab) => shareTools?.receiveTab(tab, profile), // Send to your devices, from another computer
  });
  profile.companion = companion;
  companion.start();
  profile.siteControls = siteControlsFor(profile);
  profile.siteControls.registerQuit(app);
  security?.addProfile(profile); // (the profiles opened before it existed are added when it starts)
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
      changed: () => { alive().filter((w) => !w.incognito && w.profile === profile).forEach((w) => w.emit('extensions-changed')); profile.extUi?.changed(); },
      activate: (extId) => profile.extUi?.activate(extId),
      commandsChanged: () => menuChanged(),
      toast: (text) => normalWin(profile)?.emit('toast', { text }),
    },
  });
  profile.extensions = extensions;
  // The toolbar's pinned extensions, the puzzle menu, shortcuts and an
  // extension's new tab page (main/extensions-ui.js).
  profile.extUi = new ExtensionsUI({
    extensions, store,
    windows: () => alive().filter((w) => w.profile === profile),
    current: () => (cur()?.profile === profile ? cur() : normalWin(profile)),
    openInternal, menuChanged,
  });
  profile.extUi.register(profileIpc(profile));
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
// The first profile started at launch keeps the crash check and "Restore
// pages?" (main/sessions.js): one run of Lumio, one marker.
let sessionsBegun = false;
// deferred: the browser opened after an installed app (startWaitingProfiles),
// so a window already open in it is enough when there's nothing to restore.
async function startProfile(p, { restore = false, deferred = false } = {}) {
  await p.ready;
  await drm.whenReady(); // DRM builds: Widevine before the first window, 15 s at most (once per run)
  // Quit while it waited (Cmd+Q on the waiting window): opening windows now
  // would stall the quit and leave Lumio unable to quit or save its tabs.
  if (quitting) return;
  // Site data that should have gone when Lumio last closed (if it couldn't finish).
  if (!p.cleanedUp) { p.cleanedUp = true; await p.siteControls.clearSessionData(); }
  const { store } = p;
  // Settings › On startup (main/startup.js); a restart from Settings brings the windows back.
  const lastSession = store.sessionWindows();
  const want = restore ? { ...store.settings, startup: 'restore' } : store.settings;
  let plan;
  if (!sessionsBegun && p.id === DEFAULT_PROFILE) {
    sessionsBegun = true;
    // After a crash nothing reopens by itself; the bar offers the last session.
    plan = sessions.begin(startupPlan(want, () => lastSession), lastSession, app.getPath('userData'), store.earlierWindows());
    if (plan.recent.length) menuChanged(); // the last session, under History › Recently Closed
  } else plan = launchPlan(startupPlan(want, () => lastSession), { lastSession });
  // First launch: the welcome screens (people updating from an older version
  // already have history, bookmarks or tabs, and skip them).
  if (store.settings.onboarded !== true && (lastSession.length || store.history().length || store.bookmarks().length)) store.setSetting('onboarded', true);
  const firstRun = store.settings.onboarded !== true && !p.guest;
  if (firstRun && (!process.env.LUMIO_TEST || process.env.LUMIO_TEST_WELCOME)) {
    store.setSetting('panelOpen', false);
    createWindow({ profile: p, tabs: [{ url: 'lumio://welcome/', title: 'Welcome to Lumio Browser' }], active: 0 });
  } else if (plan.windows.length) plan.windows.forEach((s) => createWindow({ profile: p, ...windowOptions(s) }));
  else if (!(deferred && normalWin(p))) createWindow({ profile: p, urls: plan.urls });
  const w = normalWin(p);
  // "Restore pages?" after a crash, and "Lumio isn't your default browser".
  if (p.id === DEFAULT_PROFILE) sessions.offerRestore(w);
  const offerDefault = defaultBrowser.shouldOffer(rootStore.settings, {
    isDefault: app.isDefaultProtocolClient('https'), packaged: app.isPackaged, test: !!process.env.LUMIO_TEST, firstRun,
  });
  if (offerDefault && w) defaultBrowser.offerDefaultBrowser(w, { store: rootStore, infobars, makeDefault: () => makeDefaultBrowser() });
}

// Lumio was started by an installed app's launcher: the profiles that were
// open come back with the first browser window (or a click on the Dock).
function startWaitingProfiles() {
  const ids = waitingProfiles || [];
  waitingProfiles = null;
  for (const id of ids) {
    if (!profiles.get(id) || starting.has(id)) continue;
    const run = startProfile(openProfile(id), { deferred: true }).catch((err) => console.error('[lumio] starting a profile:', err)).finally(() => starting.delete(id));
    starting.set(id, run);
  }
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
    profile.downloads = new Downloads(ses, { settings: store, emit: (c, p) => wins().forEach((w) => w.emit(c, p)), gate: (wc, url) => profile.siteControls?.gate(wc, url) ?? true });
    profile.permissions = new Permissions(ses, { store, emitFor, persist: false, openExternal: externalRequest, onPointerLock: pointerLocked });
    profile.account = new LumioAccount({ store, onChange: (state) => { wins().forEach((w) => { w.emit('account', state); w.ai.refreshCapabilities(); }); services.broadcastAIState(); } });
    watchLumioCookie(profile);
    profile.passwords = new PasswordManager({ dir, safeStorage, settings: store, helper, findTab: tabOfWc, toast: (w, text) => w.emit('toast', { text }) });
    profile.autofill = new AutofillManager({ dir, safeStorage, settings: store, helper, findTab: tabOfWc, toast: (w, text) => w.emit('toast', { text }), openPage: (url) => openInternal(url) });
    Object.assign(profile, { workflows: new Workflows(dir), siteTips: new SiteTips(dir), projects: new Projects(dir), schedules: new Schedules(dir) });
    addProfileServices(profile);
    profile.siteControls = siteControlsFor(profile);
    security.addProfile(profile);
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
  p.siteControls?.dispose();
  security?.removeProfile(p);
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
    p.siteControls?.dispose();
    security?.removeProfile(p);
    for (const byProfile of routes.values()) byProfile.delete(id); // its services stop answering
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
  // Logging out, restarting or shutting down the computer quits without
  // "Leave site?" (like Chrome), or macOS would say Lumio stopped the log out.
  require('electron').powerMonitor.on('shutdown', () => { quitAsked = true; });
  profiles = new ProfileRegistry(app.getPath('userData'));
  profiles.emptyTrash(); // what deleted profiles and Guest left behind
  rootStore = new Store(app.getPath('userData'), safeStorage);
  siteMute = new SiteMute(rootStore); // muted sites, for every profile
  // Light or dark, before any window opens; changes then apply live.
  theme.init({ store: rootStore, nativeTheme });
  theme.onChange(appearanceChanged);
  helper = new MacHelper();
  app.userAgentFallback = chromeUserAgent();
  setPageAttributes(() => accessibility.htmlAttrs(accessibility.prefs(rootStore.settings)));
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

  // The Mac menu bar's Tab, Profiles and View › Developer menus, History and
  // Bookmarks items (main/menu-extras.js), and Help: for the front window's
  // profile (spelling is each profile's, main/languages.js; DevTools' dock is Lumio's).
  const frontStore = {
    get settings() { return { ...curProfile().store.settings, devtoolsDock: rootStore.settings.devtoolsDock }; },
    setSetting: (key, value) => (key === 'devtoolsDock' ? rootStore : curProfile().store).setSetting(key, value),
  };
  // (Batch 4's stop and View Source in main/navigation.js stay.)
  for (const [name, fn] of Object.entries(menuCommands({
    cur,
    store: frontStore,
    sessions: () => [], // (languages.attach turns spelling on and off in the profile's sessions)
    openUrl,
    openInternal,
    signedIn: () => !!curProfile().account.state().signedIn,
    signIn,
    openAccountPage,
    menuChanged,
  }))) cmd[name] ??= fn;
  help = new Help({
    accountOf: (w) => (w && !w.closed ? w.profile.base : curProfile()).account,
    store: rootStore, // the experiments (lumio://flags-lite) are Lumio's
    current: cur,
    profileDir: (w) => (w?.profile.base || curProfile()).dir,
    // The help center and release notes open in a normal window of the front profile.
    openUrl: (url) => { const w = normalWin(); if (w) { w.tabs.create(url); w.focus(); } else createWindow({ urls: [url] }); },
    openInternal,
  });
  Object.assign(cmd, help.commands());
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
  // Addresses, cards and form entries go to the tab's profile's autofill too (main/autofill.js).
  AutofillManager.registerPages((wc) => tabOfWc(wc)?.w.profile.autofill || null);
  screenAura.register();

  // Updates from GitHub Releases (packaged builds; tests point it at a mock).
  const testUpdates = process.env.LUMIO_TEST && process.env.LUMIO_UPDATE_API;
  updater = new Updater({
    currentVersion: app.getVersion(),
    fetchImpl: (url, opts) => net.fetch(url, opts),
    workDir: path.join(app.getPath('temp'), `${FLAVOR.name} Update`),
    onChange: (state) => { alive().forEach((w) => w.emit('update', state)); announceUpdate(state); },
    // Restarting to update asks first, like quitting, before it sets anything up.
    // It doesn't ride on a quit question someone else is already answering.
    confirmQuit: () => (confirmingQuit ? Promise.resolve(false) : askToQuit()),
    // Through the normal quit, which asks again about anything new since
    // (a download, a page used during the install).
    quit: process.env.LUMIO_UPDATE_TARGET && process.env.LUMIO_TEST ? () => {} : () => app.quit(),
    stayed: () => wakeActiveTabs(),
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

  // Page tools: media controls, Share, screenshots, installed apps and their
  // right-click items. Installed apps keep the profile they came from: its
  // session (signed in there), its permissions, its windows for links.
  const toast = (w, text) => w.emit('toast', { text });
  const appProfile = (id) => openProfile(id && profiles.get(id) ? id : DEFAULT_PROFILE);
  const openInProfile = (url, id) => {
    if (!/^https?:/i.test(url || '')) return;
    const p = appProfile(id);
    const w = normalWin(p);
    if (!w) { createWindow({ profile: p, urls: [url] }); return; }
    w.tabs.create(url);
    w.focus();
  };
  media = new MediaHub({ windows: alive });
  screenshots = new Screenshots({ toast });
  apps = new Apps({
    dir: app.getPath('userData'),
    session: (id) => appProfile(id).session,
    permissions: (id) => appProfile(id).permissions,
    openUrl: openInProfile,
    cmd,
    restoreMenu: () => Menu.setApplicationMenu(buildMenu(cmd, menuState())),
    toast,
    ...(process.env.LUMIO_TEST ? { launcherDir: path.join(app.getPath('userData'), 'Lumio Apps') } : {}), // tests keep ~/Applications clean
  });
  // Send to your devices goes through the window's profile's Lumio Sync.
  shareTools = new ShareTools({
    syncOf: (w) => (w?.incognito ? null : w?.profile.base.sync || null),
    companionOf: (w) => (w?.incognito ? null : w?.profile.base.companion || null),
    savePage,
    openUrl: (url, profile) => openInProfile(url, profile?.id),
    screenshots,
    apps,
    tabOfWc,
    windowOf: (tab) => alive().find((w) => w.tabs === tab.owner) || null,
  });
  pageMenu = new PageMenu({ share: shareTools, toast });

  // Security and privacy (main/security.js): its settings are Lumio's, for
  // every profile; Password Checkup looks at the front window's profile's passwords.
  sites = new SiteResolver(cookieProbe(session));
  const frontPasswords = {
    get entries() { return curProfile().passwords.store.entries; },
    secret: (id) => curProfile().passwords.store.secret(id),
  };
  security = new Security({
    store: rootStore, sites, passwords: { store: frontPasswords }, updater,
    extensions: () => curProfile().extensions,
    windows: alive,
    findTab: tabOfWc,
    userData: app.getPath('userData'),
  });
  for (const p of openProfiles()) security.addProfile(p); // any opened before

  registerIpc();
  security.registerIpc({ on, internalHandle });
  help.register({ handle, on, internalHandle });
  // Window names, shortcuts, caret browsing, force dark, protocol handlers
  // (main/power-user.js): Lumio's own settings, for every profile.
  forceDark.migrate(rootStore); // lumio://flags-lite's old "Dark mode for all websites"
  powerUser.setup({ store: rootStore, on, handle, internalHandle, windows: alive, tabOf: tabOfWc, menuChanged, menuTemplate: () => menuTemplate(cmd, menuState()) });
  Menu.setApplicationMenu(buildMenu(cmd, menuState()));

  osIntegration.start(); // the Dock menu and download progress
  // Started by an installed app's launcher: just that app, like Chrome. The
  // browser's windows come back once it's opened (createWindow, activate).
  const launchedApp = appIdFromArgv(process.argv);
  const appRec = launchedApp ? apps.get(launchedApp) : null;
  // Windows passes links to open on the command line.
  if (process.platform !== 'darwin' && !process.env.LUMIO_TEST) pendingUrls.push(...launchTargets(process.argv.slice(1)));
  // Several profiles: "Who's using Lumio?" first, unless that's turned off.
  // Otherwise (and after a restart from Settings) the profiles that were
  // open come back (or the last one used).
  if (appRec?.window && apps.open(launchedApp)) {
    const ids = profiles.lastOpen();
    waitingProfiles = ids.length ? ids : [profiles.lastUsed()];
  } else if (profiles.wantsPicker() && !system.restarted && (!process.env.LUMIO_TEST || process.env.LUMIO_TEST_PICKER)) picker.open();
  else {
    const ids = profiles.lastOpen();
    for (const id of ids.length ? ids : [profiles.lastUsed()]) await startProfile(openProfile(id), { restore: system.restarted });
  }
  if (appRec && !appRec.window) apps.open(launchedApp); // a shortcut that opens in a tab
  if (process.platform === 'win32' && app.isPackaged && !process.windowsStore) startMenuShortcut();
  if (pendingUrls.length && alive().length) openExternalUrls(pendingUrls.splice(0));
  launched = true;

  app.on('activate', () => {
    if (alive().length) return;
    if (waitingProfiles) startWaitingProfiles();
    else if (profiles.wantsPicker()) picker.open(); else createWindow();
  });
});

// Closing the last window quits on Windows and Linux, like Chrome. Closing it
// already asked about its downloads and pages (BrowserWin.confirmClose), so
// quitting doesn't ask again. The Mac keeps running without windows; the Dock
// icon opens a new one.
app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !process.env.LUMIO_TEST) return;
  quitNow();
});

// ---------------------------------------------------------------- quitting
const downloading = (profile) => profile?.downloads.inProgress() || 0;
// Every open profile's (and Guest's) downloads, and their incognito windows'.
const allDownloading = () => openProfiles().reduce((n, p) => n + downloading(p) + downloading(p.incog), 0);

// Downloads closing this window (or pop-up) would cancel: { kind, count } or
// null. Quitting asks for itself, so nothing while it's under way.
function downloadsAtRisk(holder) {
  if (quitting) return null;
  const others = tabHolders().filter((x) => x !== holder);
  return closingCancels({
    platform: process.platform,
    lastWindow: !others.length,
    // (Each profile has its own Incognito: closing its last window ends it.)
    lastIncognito: holder.incognito && !others.some((x) => x.incognito && x.profile === holder.profile),
    total: allDownloading(),
    incognito: holder.incognito ? downloading(holder.profile) : 0,
  });
}

// "2 downloads are in progress. Quit anyway?" before they're canceled, over
// the window (parent) when there is one. Resolves true to go on. Tests answer
// it themselves (global.lumio.answerDownloads).
let answerDownloads = null;
async function confirmDownloads(risk, parent) {
  if (!risk?.count) return true;
  const box = downloadsWarning({ ...risk, platform: process.platform });
  if (answerDownloads) return (await answerDownloads(box)) === 0;
  const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
  return response === 0;
}

// Quitting, from any menu, the keyboard or the Dock, asks first: about
// downloads it would cancel, then pages you've used ("Leave site?", window by
// window: TabManager.confirmLeaveAll), pop-ups too; it goes on once you agree.
let confirmingQuit = null;
let quitAsked = false; // the next quit already asked (confirmQuit, or the last window closing)
// Resolves true once the person agrees to quit (nothing quits yet).
function askToQuit() {
  confirmingQuit ||= (async () => {
    const count = allDownloading();
    if (!(await confirmDownloads({ kind: 'quit', count }, cur()?.win))) return false;
    for (const w of tabHolders()) {
      if (await w.tabs.confirmLeaveAll()) continue;
      wakeActiveTabs();
      return false;
    }
    return true;
  })().finally(() => { confirmingQuit = null; });
  return confirmingQuit;
}
// You stayed (or an update failed to install): a window whose pages already
// agreed shows its tab again (they went to sleep, like Memory Saver's).
function wakeActiveTabs() {
  for (const h of tabHolders()) { const t = h.tabs.active; if (t && !t.view) h.tabs.activate(t.id); }
}
async function confirmQuit() {
  if (confirmingQuit) return;
  if (await askToQuit()) quitNow();
}
// Quits without asking again (the person already agreed).
function quitNow() {
  quitAsked = true;
  app.quit();
}

app.on('before-quit', (e) => {
  const asked = quitAsked;
  quitAsked = false;
  if (!asked && (allDownloading() || tabHolders().some((w) => w.tabs.anyMayAsk()))) {
    e.preventDefault();
    confirmQuit();
    return;
  }
  saveSession();
  if (profiles && !quitting) profiles.setLastOpen([...new Set(alive().filter((w) => !w.profile.guest).map((w) => w.profile.id))]);
  quitting = true;
  for (const w of alive()) w.ai.shutdown();
  helper?.stop();
  for (const p of loaded.values()) {
    p.store.flushAll();
    // The reading list and saved groups keep their own files (saved a moment after each change).
    for (const file of [p.sidePanel?.reading.file, p.groups?.saved.file]) if (file?.timer) file.flush();
    p.browsingData?.clock.flush();
  }
  profiles?.flush();
});

// Quitting for real (nothing stopped it): next launch reopens normally.
app.on('will-quit', () => sessions.end());

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
  // A view shown a moment ago may have no frame yet (macOS: UnknownVizError):
  // it's tried again for a moment, then left out of the picture.
  const capture = async (view) => {
    for (let i = 0; ; i++) {
      try {
        const img = await view.webContents.capturePage();
        if (!img.isEmpty()) return img;
      } catch (e) { if (i >= 10) throw e; }
      if (i >= 10) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const paste = async (view) => {
    const b = view.getBounds();
    const bw = Math.round(b.width * scale);
    const bh = Math.round(b.height * scale);
    const img = bw > 0 && bh > 0 ? await capture(view).catch(() => null) : null;
    if (!img) return;
    const src = pixels(img).resize({ width: bw, height: bh }).toBitmap();
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
  for (const t of tabs.tabs) if (t.view && tabs.split.isShown(t.id)) await paste(t.view); // both sides of a split view
  const bar = w.indicator?.bar;
  if (bar && win.contentView.children.includes(bar)) await paste(bar);
  for (const v of Object.values(w.hud?.views || {})) if (win.contentView.children.includes(v) && v.getVisible()) await paste(v);
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
  get popups() { return alivePopups(); },
  // The front window's profile's (the first profile's before any window opens).
  get store() { return (cur()?.profile || openProfile(DEFAULT_PROFILE)).store; },
  get extensions() { return curProfile().extensions; },
  get extUi() { return curProfile().extUi; },
  get help() { return help; },
  handoff,
  get autofill() { return curProfile().autofill; },
  get account() { return curProfile().account; },
  get passwords() { return curProfile().passwords; },
  get workflows() { return curProfile().workflows; },
  get siteTips() { return curProfile().siteTips; },
  get schedules() { return curProfile().schedules; },
  get sync() { return curProfile().sync; },
  get omnibox() { return curProfile().omnibox; },
  get bookmarks() { return curProfile().bookmarks; },
  get groups() { return curProfile().groups; },
  get sidePanel() { return curProfile().sidePanel; },
  // normal/incognito: the front window's profile and its incognito session.
  get profiles() { const p = curProfile(); return { normal: p, incognito: p.incog, registry: profiles, loaded, guest, list: profilesList(), open: openProfile, start: switchToProfile, remove: deleteProfile, openGuest }; },
  get rootStore() { return rootStore; },
  get perf() { return perf; },
  get taskManager() { return taskManager; },
  get picker() { return picker; },
  get printPreview() { return printPreview; },
  get system() { return system; },
  get recentlyClosed() { return recentlyClosed; },
  certErrors,
  get nav() { return navigation; },
  get tabStrip() { return tabStrip; },
  get tabSearch() { return tabSearch; },
  get tabDrag() { return tabDrag; },
  get sessions() { return sessions; },
  get infobars() { return infobars; },
  get siteMute() { return siteMute; },
  get osIntegration() { return osIntegration; },
  get sites() { return sites; },
  get siteData() { return curProfile().siteData; },
  get browsingData() { return curProfile().browsingData; },
  get security() { return security; },
  get pageTools() { return { media, share: shareTools, screenshots, apps, pageMenu }; },
  screenAura,
  set answerDownloads(fn) { answerDownloads = fn; },
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
