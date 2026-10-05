// Everyday navigation, the way Chrome does it: the history menus on Back and
// Forward, opening back/forward/reload in a new tab, the mouse's back and
// forward buttons, trackpad swipes, the link status bubble, per-site zoom,
// Esc to stop loading, view source, the JavaScript console, Open File…, Save
// Page As formats, the Home button and start pages, Use Selection for Find.
// main.js creates one Navigation and hands it the windows; the parts that
// don't need Electron are in zoom.js and startup.js.
const { Menu, dialog, clipboard, nativeImage, systemPreferences, ipcMain, session: electronSession } = require('electron');
const { pathToFileURL } = require('url');
const zoom = require('./zoom');
const startup = require('./startup');
const { PageHud } = require('./page-hud');
const { isSynthetic } = require('./synthetic-input');

const MAC = process.platform === 'darwin';
const MENU_ITEMS = 12; // Chrome's back and forward menus list up to 12 pages
const SWIPE_DISTANCE = 160; // px of sideways scrolling past the page's edge that goes back or forward
const MAX_PINCH = 5; // pinch-to-zoom up to 500%, like Chrome
const ICONS = 300; // favicons kept for the history menus

// Save Page As: the menu shows these, and the file's extension says which was
// picked (Electron doesn't report the chosen filter). "HTML only" is .htm so
// it can be told apart from "Complete".
const SAVE_FILTERS = [
  { name: 'Webpage, Complete', extensions: ['html'] },
  { name: 'Webpage, HTML Only', extensions: ['htm'] },
  { name: 'Webpage, Single File', extensions: ['mhtml'] },
];
function saveType(file) {
  if (/\.mht(ml)?$/i.test(file)) return 'MHTML';
  if (/\.htm$/i.test(file)) return 'HTMLOnly';
  return 'HTMLComplete';
}

const OPEN_FILTERS = [
  { name: 'Web pages, PDFs, pictures and text', extensions: ['html', 'htm', 'xhtml', 'shtml', 'mhtml', 'mht', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'txt', 'text', 'md', 'json', 'xml', 'csv', 'log'] },
  { name: 'All files', extensions: ['*'] },
];

// The pages a Back (dir 'back') or Forward menu lists: the nearest first.
function historyItems(entries, active, dir, max = MENU_ITEMS) {
  const out = [];
  const step = dir === 'back' ? -1 : 1;
  for (let i = active + step; i >= 0 && i < entries.length && out.length < max; i += step) {
    const e = entries[i] || {};
    out.push({ index: i, url: e.url || '', title: e.title || '' });
  }
  return out;
}

// Where a click opens something, from its mouse button and keys (Chrome's
// rules): middle-click or ⌘/Ctrl opens a background tab (with Shift, a
// foreground one), Shift alone a new window, otherwise the current tab.
function dispositionOf(e = {}) {
  if (e.button === 1 || (MAC ? e.metaKey : e.ctrlKey)) return e.shiftKey ? 'foreground' : 'background';
  if (e.shiftKey) return 'window';
  return 'current';
}

// A menu label: the page's title, or its address. On Windows & marks a shortcut letter.
function menuLabel({ title, url }) {
  const text = String(title || url || '').replace(/\s+/g, ' ').trim();
  const short = text.length > 60 ? text.slice(0, 60) + '…' : text;
  return MAC ? short : short.replace(/&/g, '&&');
}

const helpUrl = () => `${(require('../package.json').homepage || 'https://lumio-browser.gw607953.workers.dev').replace(/\/$/, '')}/#faq`;

class Navigation {
  // deps: { store, alive(), cur(), ensureWin(), normalWin(), createWindow(opts),
  //         openInternal(url), bookmarksChanged(), tabOfWc(wc) }
  constructor(deps) {
    this.deps = deps;
    this.wired = new WeakSet(); // tab webContents already set up
    this.applied = new WeakMap(); // session -> sites whose zoom was set this session
    this.mouseIndex = new WeakMap(); // webContents -> history index when a mouse back/forward button went down
    this.icons = new Map(); // page URL -> 16px favicon (newest last)
    this.swipeCheck = { at: 0, ok: true };
  }

  get store() { return this.deps.store; }
  windowOf(tab) { return this.deps.alive().find((w) => w.tabs === tab.owner) || null; }

  // ---------------------------------------------------------------- windows and tabs
  onWindowCreated(w) {
    w.hud = new PageHud(w);
    w.win.on('closed', () => w.hud.destroy());
    // Windows and Linux: the keyboard's (or some mice's) Back and Forward keys.
    w.win.on('app-command', (_e, command) => {
      if (command === 'browser-backward') w.tabs.back();
      else if (command === 'browser-forward') w.tabs.forward();
    });
    // macOS three-finger swipes ("Swipe between pages" with three fingers).
    // Chrome maps a swipe to the left to Back.
    if (MAC) {
      w.win.on('swipe', (_e, direction) => {
        if (direction === 'left') w.tabs.back();
        else if (direction === 'right') w.tabs.forward();
      });
    }
  }

  onTabActivated(w) { w.hud?.status('', null, { now: true }); }

  onViewCreated(_w, tab) {
    const wc = tab.view?.webContents;
    if (!wc || this.wired.has(wc)) return; // a tab moving to another window keeps its page
    this.wired.add(wc);
    // Trackpad pinch zooms the page in place, like Chrome (Cmd/Ctrl +/- still
    // changes the page zoom). Electron turns it off unless asked, and a new
    // document can forget it, so it's asked again on each one.
    const pinch = () => { if (!wc.isDestroyed()) Promise.resolve(wc.setVisualZoomLevelLimits(1, MAX_PINCH)).catch(() => {}); };
    pinch();
    wc.on('dom-ready', pinch);
    wc.on('update-target-url', (_e, url) => {
      const w = this.windowOf(tab);
      if (w && w.tabs.activeId === tab.id) w.hud?.status(url, tab);
    });
    wc.on('did-navigate', (_e, url) => this.applyZoom(tab, wc, url));
    // Icons for the history menus. Not for incognito: they're fetched outside its profile.
    wc.on('page-favicon-updated', (_e, icons) => { if (!tab.owner.incognito) this.cacheIcon(wc.getURL(), icons[0]); });
    // Esc stops a page that's loading (the page still gets the key).
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.shift || input.control || input.alt || input.meta) return;
      if (e.defaultPrevented || !wc.isLoading() || isSynthetic(wc) || this.windowOf(tab)?.ai?.isRunning()) return;
      wc.stop();
    });
  }

  // ---------------------------------------------------------------- history menus and new tabs
  // The Back (dir 'back') or Forward menu of the tab you're on, or null if it'd be empty.
  historyTemplate(w, dir) {
    const tab = w.tabs.active;
    const wc = tab?.view?.webContents;
    if (!wc || !['back', 'forward'].includes(dir)) return null;
    const h = wc.navigationHistory;
    const items = historyItems(h.getAllEntries(), h.getActiveIndex(), dir);
    if (!items.length) return null;
    return [
      ...items.map((it) => ({
        label: menuLabel(it),
        ...(this.icons.has(it.url) ? { icon: this.icons.get(it.url) } : {}),
        click: (_item, _win, ev) => this.openEntry(w, tab, it.index, dispositionOf(ev)),
      })),
      { type: 'separator' },
      { label: 'Show Full History', click: () => this.deps.openInternal('lumio://history/') },
    ];
  }

  historyMenu(w, { dir, x, y } = {}) {
    const template = this.historyTemplate(w, dir);
    if (!template) return null;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: w.win, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
    return menu;
  }

  // Middle-click (or ⌘/Ctrl-click) on Back, Forward or Reload: that page in a
  // new tab, with this tab's history so Back works there too.
  openInNew(w, which, disposition = 'background') {
    const tab = w.tabs.active;
    const h = tab?.view?.webContents.navigationHistory;
    if (!h) return null;
    const active = h.getActiveIndex();
    const index = which === 'back' ? active - 1 : which === 'forward' ? active + 1 : which === 'reload' ? active : -1;
    return this.openEntry(w, tab, index, disposition);
  }

  openEntry(w, tab, index, disposition = 'current') {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return null;
    const h = wc.navigationHistory;
    const entries = h.getAllEntries();
    const entry = entries[index];
    if (!entry) return null;
    if (disposition === 'current') { h.goToIndex(index); return tab; }
    if (disposition === 'window') return this.deps.createWindow({ incognito: w.incognito, urls: [entry.url] });
    const m = w.tabs;
    const copy = m.create(entry.url, { active: false, lazy: true, index: m.tabs.indexOf(tab) + 1, title: entry.title || undefined });
    copy.savedHistory = { entries, index }; // ensureView replays it
    m.ensureView(copy);
    if (disposition === 'foreground') m.activate(copy.id);
    m.changed();
    return copy;
  }

  // ---------------------------------------------------------------- mouse buttons and swipes
  // The mouse's back/forward buttons in a page (preload/internal.js). Chromium
  // may go back by itself; it's done here only if it didn't.
  onMouseButton(wc, { phase, dir } = {}) {
    const h = wc.navigationHistory;
    if (phase === 'down') { this.mouseIndex.set(wc, h.getActiveIndex()); return; }
    if (phase !== 'up' || !['back', 'forward'].includes(dir)) return;
    const before = this.mouseIndex.get(wc);
    this.mouseIndex.delete(wc);
    if (before == null) return;
    setTimeout(() => {
      if (wc.isDestroyed() || h.getActiveIndex() !== before) return;
      if (dir === 'back' && h.canGoBack()) h.goBack();
      else if (dir === 'forward' && h.canGoForward()) h.goForward();
    }, 60);
  }

  // macOS two-finger swipes: how far the page was scrolled sideways past its
  // edge (preload/internal.js). An arrow follows; far enough, it goes there.
  onSwipe(w, tab, wc, { dx, end } = {}) {
    if (!Number.isFinite(dx) || w.tabs.activeId !== tab.id || !w.hud || !this.swipeAllowed()) return;
    const back = dx < 0;
    const h = wc.navigationHistory;
    const can = back ? h.canGoBack() : h.canGoForward();
    const progress = can ? Math.min(1, Math.abs(dx) / SWIPE_DISTANCE) : 0;
    if (!end) {
      if (progress > 0) w.hud.swipe({ dir: back ? 'back' : 'forward', progress });
      return;
    }
    w.hud.swipe(null, progress >= 1);
    if (progress < 1) return;
    if (back) h.goBack(); else h.goForward();
  }

  // System Settings › Trackpad › Swipe between pages: Lumio follows it like Chrome does.
  swipeAllowed() {
    if (!MAC) return false;
    const now = Date.now();
    if (now - this.swipeCheck.at > 5000) {
      let value = '';
      try { value = systemPreferences.getUserDefault('AppleEnableSwipeNavigateWithScrolls', 'string'); } catch { /* keep the default: on */ }
      this.swipeCheck = { at: now, ok: value !== '0' };
    }
    return this.swipeCheck.ok;
  }

  // Alt/Option-click on a link downloads it.
  downloadLink(wc, url) {
    if (typeof url !== 'string' || url.length > 8_000_000 || !/^(https?|data|blob):/i.test(url)) return;
    wc.downloadURL(url);
  }

  // ---------------------------------------------------------------- favicons for the menus
  async cacheIcon(pageUrl, iconUrl) {
    if (!pageUrl || typeof iconUrl !== 'string' || this.icons.has(pageUrl)) return;
    try {
      let img = null;
      if (iconUrl.startsWith('data:image/')) img = nativeImage.createFromDataURL(iconUrl);
      else if (/^https?:/.test(iconUrl)) {
        // The shell draws tab icons from this session, so it's usually cached.
        const res = await electronSession.defaultSession.fetch(iconUrl);
        if (res.ok) img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
      }
      if (!img || img.isEmpty()) return;
      this.icons.set(pageUrl, img.resize({ width: 16, height: 16, quality: 'best' }));
      if (this.icons.size > ICONS) this.icons.delete(this.icons.keys().next().value);
    } catch { /* no icon: the menu shows the title alone */ }
  }

  // ---------------------------------------------------------------- zoom
  appliedSet(ses) {
    let set = this.applied.get(ses);
    if (!set) { set = new Set(); this.applied.set(ses, set); }
    return set;
  }

  // The first page of a site this session gets the site's saved level (or the
  // default). After that Chromium keeps the site's level for every tab, and a
  // level changed in incognito isn't undone on the next page.
  applyZoom(tab, wc, url) {
    const key = zoom.zoomKey(url);
    if (!key || wc.isDestroyed()) return;
    const set = this.appliedSet(tab.owner.session);
    if (set.has(key)) return;
    set.add(key);
    const want = zoom.zoomFor(this.store.settings, url);
    if (zoom.percentOf(wc.getZoomFactor()) !== want) wc.setZoomFactor(zoom.factorOf(want));
    tab.owner.changed();
  }

  // The default changed or a site's level was removed: open pages follow, and
  // every site picks its level up again on its next page.
  rezoom(host = null) {
    this.applied = new WeakMap();
    for (const w of this.deps.alive()) {
      for (const t of w.tabs.tabs) {
        const wc = t.view?.webContents;
        if (!wc || wc.isDestroyed()) continue;
        const url = wc.getURL();
        if (host && zoom.siteKey(url) !== host) continue;
        const want = zoom.zoomFor(this.store.settings, url);
        if (zoom.percentOf(wc.getZoomFactor()) !== want) wc.setZoomFactor(zoom.factorOf(want));
        this.appliedSet(w.tabs.session).add(zoom.zoomKey(url));
      }
      w.tabs.changed();
    }
  }

  // ---------------------------------------------------------------- commands
  viewSource(w) {
    const tab = w.tabs.active;
    const url = tab ? w.tabs.displayUrl(tab) : '';
    if (!url || url.startsWith('view-source:')) return null;
    return w.tabs.create('view-source:' + url, { index: w.tabs.tabs.indexOf(tab) + 1 });
  }

  // Developer tools, open on the Console.
  console(w) {
    const wc = w.tabs.wc();
    if (!wc) return;
    let tries = 0;
    const show = () => {
      const tools = wc.isDestroyed() ? null : wc.devToolsWebContents;
      if (!tools || tools.isDestroyed()) return;
      tools.executeJavaScript('typeof DevToolsAPI !== "undefined" && (DevToolsAPI.showPanel("console"), true)')
        .then((done) => { if (!done && ++tries < 15) setTimeout(show, 200); })
        .catch(() => {});
    };
    if (wc.isDevToolsOpened()) { show(); wc.devToolsWebContents?.focus(); return; }
    wc.once('devtools-opened', show);
    wc.openDevTools({ mode: 'detach' });
  }

  async openFile(w) {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openFile'], filters: OPEN_FILTERS });
    if (canceled || !filePaths?.[0]) return null;
    return this.openFiles(w, filePaths);
  }

  // Chrome opens the file in the tab you're on.
  openFiles(w, files) {
    const urls = files.map((f) => pathToFileURL(f).href);
    urls.forEach((url, i) => {
      if (i === 0 && w.tabs.active) w.tabs.navigate(url);
      else w.tabs.create(url);
    });
    w.focus();
    return urls;
  }

  goHome(w, disposition = 'current') {
    const url = startup.homeUrl(this.store.settings);
    if (disposition === 'window') return this.deps.createWindow({ incognito: w.incognito, urls: [url] });
    if (disposition === 'background' || disposition === 'foreground' || !w.tabs.active) {
      const at = w.tabs.tabs.indexOf(w.tabs.active) + 1;
      return w.tabs.create(url, { active: disposition !== 'background', index: at || undefined });
    }
    return w.tabs.navigate(url);
  }

  bookmarkAllTabs(w) {
    let added = 0;
    for (const t of w.tabs.tabs) {
      const url = w.tabs.displayUrl(t);
      if (!/^https?:/.test(url) || this.store.isBookmarked(url)) continue;
      this.store.toggleBookmark(url, t.title, t.favicon);
      added++;
    }
    if (added) this.deps.bookmarksChanged();
    w.emit('toast', { text: added ? `Bookmarked ${added} tab${added === 1 ? '' : 's'}` : 'These tabs are already bookmarked' });
    return added;
  }

  // ⌘E: the page's selected text becomes what Find looks for (and, on the Mac,
  // what every app's Find Next uses).
  async useSelectionForFind(w) {
    const wc = w.tabs.wc();
    if (!wc) return '';
    const raw = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'String(getSelection())' }]).catch(() => '');
    const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return '';
    if (MAC && !w.incognito) clipboard.writeFindText(text);
    w.emit('find-text', { text });
    return text;
  }

  // Delete Browsing Data…: the dialog on the History page (in a normal window).
  clearBrowsingData() {
    const url = 'lumio://history/#clear';
    const w = this.deps.normalWin();
    const tab = w?.tabs.tabs.find((t) => (t.pendingUrl || t.url || '').startsWith('lumio://history/'));
    if (!tab) { this.deps.openInternal(url); return; }
    w.tabs.activate(tab.id);
    const wc = tab.view?.webContents;
    if (wc?.getURL() === url) wc.reload(); else w.tabs.navigate(url, tab.id);
    w.focus();
  }

  openWeb(url) {
    const w = this.deps.normalWin() || this.deps.createWindow({ urls: [url] });
    if (!w.tabs.tabs.some((t) => t.url === url)) w.tabs.create(url);
    w.focus();
  }

  // What main.js adds to its menu commands.
  commands() {
    const withWin = (fn) => () => { const w = this.deps.cur(); return w ? fn(w) : undefined; };
    return {
      stop: withWin((w) => w.tabs.stop()),
      viewSource: withWin((w) => this.viewSource(w)),
      console: withWin((w) => this.console(w)),
      openFile: () => this.openFile(this.deps.ensureWin()),
      home: withWin((w) => this.goHome(w)),
      clearBrowsingData: () => this.clearBrowsingData(),
      help: () => this.openWeb(helpUrl()),
      bookmarkAllTabs: withWin((w) => this.bookmarkAllTabs(w)),
      useSelectionForFind: withWin((w) => this.useSelectionForFind(w)),
    };
  }

  // ---------------------------------------------------------------- settings
  prefs() {
    const s = this.store.settings;
    return { showHome: !!s.showHome, homeUrl: startup.homeUrl(s) };
  }

  settingsState() {
    const s = this.store.settings;
    return {
      showHome: !!s.showHome,
      homePage: s.homePage && s.homePage !== 'newtab' ? s.homePage : '',
      defaultZoom: zoom.defaultZoom(s),
      presets: zoom.PRESETS,
      zoomLevels: zoom.zoomList(s),
      startup: startup.startupMode(s),
      startupPages: startup.cleanPages(s.startupPages),
    };
  }

  setPref(key, value) {
    const store = this.store;
    if (key === 'showHome') store.setSetting('showHome', !!value);
    else if (key === 'homePage') {
      const url = value === 'newtab' || !value ? 'newtab' : startup.cleanUrl(value);
      if (!url) return { ok: false, error: 'Enter a web address, like example.com' };
      store.setSetting('homePage', url);
    } else if (key === 'defaultZoom') {
      if (!zoom.PRESETS.includes(Number(value))) return { ok: false };
      store.setSetting('defaultZoom', Number(value));
      this.rezoom();
    } else if (key === 'startupPages') {
      // One address that isn't a web page (a typo, a search) fails the whole list, so it's not lost quietly.
      const list = Array.isArray(value) ? value : [];
      if (list.some((p) => !startup.cleanUrl(typeof p === 'string' ? p : p?.url))) return { ok: false, error: 'Enter a web address, like example.com' };
      store.setSetting('startupPages', startup.cleanPages(list));
    } else return { ok: false };
    return { ok: true, ...this.settingsState() };
  }

  removeZoom(host) {
    if (zoom.forgetZoom(this.store, host)) this.rezoom(host);
    return this.settingsState();
  }

  // "Use current pages": the web pages open in Lumio's windows.
  currentPages() {
    const pages = [];
    for (const w of this.deps.alive()) {
      if (w.incognito) continue;
      for (const t of w.tabs.tabs) {
        const url = w.tabs.displayUrl(t);
        if (/^(https?|file):/.test(url)) pages.push({ url, title: t.title });
      }
    }
    return this.setPref('startupPages', pages);
  }

  // ---------------------------------------------------------------- IPC
  // handle/on/internalHandle: main.js's helpers (they find the sender's window or tab).
  register({ handle, on, internalHandle }) {
    // Toolbar (renderer/ui/navigation.js)
    on('tab:history-menu', (w, p) => this.historyMenu(w, p || {}));
    on('tab:nav-new', (w, p) => this.openInNew(w, p?.which, p?.disposition));
    on('tab:home', (w, p) => this.goHome(w, p?.disposition));
    handle('shell:nav-prefs', () => this.prefs());
    on('layout:slot', (w) => w.hud?.place());
    // The zoom bubble opened from the keyboard takes the keyboard, and gives it back.
    on('overlay:show', (w, msg) => { if (msg?.payload?.kind === 'zoom' && msg.payload.focus) w.overlay.webContents.focus(); });
    on('overlay:pick', (w, item) => { if (item?.kind === 'zoom' && item.refocus) w.win.webContents.focus(); });
    // The bubble and arrow views say how big they are.
    ipcMain.on('hud:size', (e, size) => this.deps.alive().find((w) => w.hud?.owns(e.sender))?.hud.onSize(e.sender, size || {}));
    // Pages (preload/internal.js), from their main frame only.
    const fromTab = (e) => (e.senderFrame && e.senderFrame === e.sender.mainFrame ? this.deps.tabOfWc(e.sender) : null);
    ipcMain.on('nav:mouse', (e, msg) => { if (fromTab(e)) this.onMouseButton(e.sender, msg || {}); });
    ipcMain.on('nav:swipe', (e, msg) => { const f = fromTab(e); if (f) this.onSwipe(f.w, f.tab, e.sender, msg || {}); });
    ipcMain.on('nav:download', (e, url) => { if (fromTab(e)) this.downloadLink(e.sender, url); });
    // Settings › Appearance, On startup and Zoom levels
    internalHandle('page:nav-settings', ['settings'], () => this.settingsState());
    internalHandle('page:nav-set', ['settings'], (_ctx, key, value) => this.setPref(String(key || ''), value));
    internalHandle('page:zoom-remove', ['settings'], (_ctx, host) => this.removeZoom(String(host || '')));
    internalHandle('page:startup-current', ['settings'], () => this.currentPages());
    // The Home button follows its settings, from here or from another device.
    let last = JSON.stringify(this.prefs());
    this.store.settingsFile.onSave(() => {
      const now = JSON.stringify(this.prefs());
      if (now === last) return;
      last = now;
      for (const w of this.deps.alive()) w.emit('nav-prefs', this.prefs());
    });
  }
}

module.exports = { Navigation, historyItems, dispositionOf, menuLabel, saveType, SAVE_FILTERS, OPEN_FILTERS, SWIPE_DISTANCE };
