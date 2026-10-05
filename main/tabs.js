// TabManager: the tabs of one browser window. Each tab is a WebContentsView
// laid out in the "page slot" rectangle that the shell reports. Tabs restored
// from the last session are created lazily (their page loads the first time
// they're activated). A tab can move to another window (detach + adopt), so
// its event handlers always look up the manager that currently owns it.
const { WebContentsView, Menu, clipboard, app } = require('electron');
const { isSynthetic } = require('./synthetic-input');
const path = require('path');
const { parseInput, displayUrl } = require('./omnibox');
const { SEARCH_ENGINES } = require('./store');
const theme = require('./theme');
const certErrors = require('./cert-errors');
const { classify } = require('./external-protocols');

const NEWTAB = 'lumio://newtab/';
const INTERNAL_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
// Every page's settings: a tab's, and a pop-up's (main/popup-window.js).
const PAGE_PREFS = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  preload: INTERNAL_PRELOAD,
  spellcheck: true,
  plugins: true, // built-in PDF viewer
  // Electron's alert/confirm are app-wide message boxes (and it has no
  // prompt): the preload gives the tab's page Lumio's dialogs in the tab
  // instead (main/page-dialogs.js), and the rest (frames) are turned off.
  disableDialogs: true,
  // Sound waits until you click or type in the page, like Chrome. (Lumio's
  // own voice plays in the window, not in a tab.)
  autoplayPolicy: 'document-user-activation-required',
};
// Input that counts as using a page (Chrome's "user activation"): a click or
// tap, or a key other than Esc (Esc only ever closes things, so a page can't
// get a pop-up out of it). Only a page you've used may ask "Leave site?", or
// open a pop-up or another app.
const POINTER = new Set(['mouseDown', 'touchEnd', 'pointerDown', 'gestureTap']);
const isUse = (input) => POINTER.has(input.type) || ((input.type === 'keyDown' || input.type === 'rawKeyDown') && !!input.key && input.key !== 'Escape');
// How long after that click the page may open its pop-up. Electron doesn't
// say whether window.open() came from a click, so Lumio watches the input
// itself (see noteActivation()); a second at most, and one pop-up per click.
const ACTIVATION_MS = 1000;
const PASS_MS = 3000; // a blocked pop-up you picked: how long the page has to open it
const LEAVE_MS = 3000; // a beforeunload answer this late isn't about our navigation any more
const CATCH_MS = 1500; // how long a page that asked may take to start leaving
const CLOSE_MS = 5000; // a page that doesn't answer beforeunload is closed anyway
const BLOCKED_MAX = 20; // blocked pop-ups listed per page

let nextId = 1;
let nextDialogId = 1;
let nextPopupId = 1;

class TabManager {
  // radius: the page's corners (a pop-up's page has none).
  constructor({ win, session, store, emit, hooks, incognito = false, radius = 10 }) {
    this.win = win;
    this.session = session;
    this.store = store;
    this.emit = emit; // (channel, payload) -> this window's shell
    this.hooks = hooks;
    this.incognito = incognito;
    this.radius = radius;
    this.tabs = [];
    this.activeId = null;
    this.slot = { x: 0, y: 84, width: 800, height: 600 };
    this.fullscreenTab = null;
    this.pushTimer = null;
  }

  get active() { return this.tabs.find((t) => t.id === this.activeId) || null; }
  get(id) { return this.tabs.find((t) => t.id === id) || null; }
  byWebContents(wc) { return this.tabs.find((t) => t.view?.webContents === wc) || null; }
  searchTemplate() { return (SEARCH_ENGINES[this.store.settings.searchEngine] || SEARCH_ENGINES.google).url; }
  pinnedCount() { return this.tabs.filter((t) => t.pinned).length; }
  // What a tab shows before its page paints: Lumio's own pages follow light
  // or dark; websites get white, like in Chrome.
  pageBackground(url) { return url.startsWith('lumio:') ? theme.colors(theme.isDark(this.incognito), this.incognito).page : '#ffffff'; }

  // ---------- lifecycle ----------
  // webContents: a page Chromium already made (a pop-up's), shown as it is.
  // Its address shows once it gets there: until then it's the blank page the
  // page that opened it may still be writing into, so it says about:blank.
  create(url = NEWTAB, { active = true, index, title, lazy = false, pinned = false, webContents = null } = {}) {
    if (webContents) url = 'about:blank';
    const tab = {
      id: nextId++,
      owner: this,
      view: null,
      url,
      title: title || (url === NEWTAB ? 'New Tab' : displayUrl(url)),
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      audible: false,
      muted: false,
      crashed: false,
      pinned: !!pinned,
      pendingUrl: lazy ? url : null,
      lastActive: Date.now(),
      madeContents: webContents,
    };
    if (!lazy) this.ensureView(tab);
    this.insert(tab, index);
    if (active || !this.activeId) this.activate(tab.id);
    this.changed();
    return tab;
  }

  // Pinned tabs always come first.
  insert(tab, index) {
    const pins = this.pinnedCount();
    const lo = tab.pinned ? 0 : pins;
    const hi = tab.pinned ? pins : this.tabs.length;
    const at = index == null ? hi : Math.max(lo, Math.min(index, hi));
    this.tabs.splice(at, 0, tab);
  }

  ensureView(tab) {
    if (tab.view) return tab.view;
    const made = tab.madeContents;
    tab.madeContents = null;
    const view = new WebContentsView(made ? { webContents: made } : { webPreferences: { session: this.session, ...PAGE_PREFS } });
    tab.view = view;
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(this.radius);
    view.setBackgroundColor(this.pageBackground(tab.url));
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.wire(tab);
    this.hooks.onViewCreated?.(tab, this);
    if (made) return view; // Chromium loads it, keeping window.opener
    const url = tab.pendingUrl || tab.url;
    tab.pendingUrl = null;
    // A tab Memory Saver put to sleep comes back with its back/forward history.
    const saved = tab.savedHistory;
    tab.savedHistory = null;
    tab.discarded = false;
    if (saved?.entries?.length) {
      view.webContents.navigationHistory.restore(saved).catch(() => view.webContents.loadURL(url).catch(() => {}));
    } else {
      view.webContents.loadURL(url).catch(() => {});
    }
    return view;
  }

  // Memory Saver: closes the page of a tab you haven't looked at for a while,
  // keeping its address, title, icon and history; it reloads when you return.
  // Never the tab you're on, one playing sound, loading, being captured
  // (screen share, camera) or with devtools open.
  discard(id) {
    const tab = this.get(id);
    if (!tab?.view || tab.id === this.activeId || tab.audible || tab.dialogs?.length || tab.closing) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || wc.isLoading() || wc.isCurrentlyAudible() || wc.isBeingCaptured() || wc.isDevToolsOpened()) return false;
    const url = wc.getURL();
    if (!url || url.startsWith('lumio://')) return false; // internal pages are cheap
    this.putToSleep(tab, this.snapshot(tab));
    wc.close();
    return true;
  }

  // A page's address and back/forward history, to bring it back later.
  snapshot(tab) {
    const wc = tab.view.webContents;
    const h = wc.navigationHistory;
    return { url: wc.getURL(), history: { entries: h.getAllEntries(), index: h.getActiveIndex() } };
  }

  // The tab keeps its place, title and history without a page; opening it
  // loads the page again.
  putToSleep(tab, { url, history }) {
    tab.savedHistory = history;
    tab.pendingUrl = url;
    tab.url = url;
    tab.discarded = true;
    tab.loading = false;
    if (tab.view) this.win.contentView.removeChildView(tab.view);
    tab.view = null;
    this.dismiss(tab);
    this.changed();
  }

  // Tabs not looked at for `minutes` (and not pinned to anything playing).
  sleepIdle(minutes, now = Date.now()) {
    let n = 0;
    for (const t of this.tabs) {
      if (t.view && t.id !== this.activeId && now - (t.lastActive || now) >= minutes * 60_000 && this.discard(t.id)) n++;
    }
    return n;
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const M = () => tab.owner;
    const update = (patch) => { Object.assign(tab, patch); M().changed(); };
    const remember = (fn) => { if (!M().incognito) fn(M().store); };

    // Chrome's rule for "Leave site?": only a page you've clicked or typed in
    // may ask (each new page starts untouched). A click or key press also lets
    // the page open a pop-up or another app. Keys only show up in
    // before-input-event (keys typed in a frame from another site too).
    const used = (_e, input) => {
      if (!isUse(input)) return;
      tab.touched = true;
      M().noteActivation(tab);
    };
    wc.on('input-event', used);
    wc.on('before-input-event', used);

    wc.on('did-start-loading', () => update({ loading: true, crashed: false }));
    wc.on('did-stop-loading', () => update({ loading: false, ...M().navState(wc) }));
    // PDFs open in Chromium's viewer: the panel offers "Summarize this PDF"
    // and reads the file itself (page text tools see only the viewer).
    wc.on('did-finish-load', () => {
      if (!/^(https?|file):/.test(wc.getURL())) { if (tab.pdf) update({ pdf: false }); return; }
      wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'document.contentType' }])
        .then((type) => { if (!wc.isDestroyed() && !!tab.pdf !== (type === 'application/pdf')) update({ pdf: type === 'application/pdf' }); })
        .catch(() => {});
    });
    wc.on('page-title-updated', (_e, title) => {
      update({ title });
      remember((s) => s.updateTitle(wc.getURL(), title));
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      update({ favicon: icons[0] || null });
      if (icons[0]) remember((s) => s.updateFavicon(wc.getURL(), icons[0]));
    });
    wc.on('did-navigate', (_e, url) => {
      M().leftPage(tab);
      tab.touched = false;
      // They were the old page's: its blocked pop-ups, and its dialogs "in a
      // row" or blocked ("Don't allow … to show more dialogs"), like Chrome.
      tab.blockedPopups = null;
      tab.dialogStreak = null;
      tab.dialogsBlocked = null;
      tab.view.setBackgroundColor(M().pageBackground(url));
      update({ url, favicon: null, ...M().navState(wc) });
      remember((s) => s.addVisit(url, wc.getTitle()));
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      update({ url, ...M().navState(wc) });
      remember((s) => s.addVisit(url, wc.getTitle(), tab.favicon));
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // A stopped navigation's site may no longer ask to sign in over this page.
      if (isMainFrame && code === -3 && url === tab.navigatingTo) tab.navigatingTo = null;
      if (!isMainFrame || code === -3) return; // -3: replaced by another navigation, or stopped
      M().leftPage(tab);
      if (url.startsWith('lumio://error')) return;
      const q = new URLSearchParams({ code: String(code), desc, url });
      // Certificate errors (-200…-299) get "Your connection is not private".
      const page = code <= -200 && code > -300 ? 'cert.html' : '';
      wc.loadURL(`lumio://error/${page}?` + q).catch(() => {});
    });
    wc.on('render-process-gone', (_e, details) => {
      // They were the old page's ("Leave site?" too, unless it's about closing the tab).
      const leave = tab.dialogs?.some((d) => d.spec.kind === 'leave' && d.spec.about !== 'close');
      M().dismiss(tab, leave ? ['js', 'unresponsive', 'leave'] : ['js', 'unresponsive']);
      if (details.reason === 'clean-exit') return;
      const failed = M().displayUrl(tab);
      update({ loading: false });
      // "Exit page" in "Page unresponsive" stopped it on purpose.
      const q = new URLSearchParams(tab.exited ? { code: 'hung', desc: '', url: failed } : { code: 'crashed', desc: details.reason, url: failed });
      tab.exited = false;
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL('lumio://error/?' + q).catch(() => {}); }, 50);
    });

    // A navigation in the main frame starts: the page's open dialogs are moot.
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      tab.navigatingTo = d.url; // whose sign-in requests may ask (main/page-dialogs.js)
      M().dismiss(tab, ['js', 'auth', 'unresponsive', 'external']);
    });
    wc.on('did-redirect-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) tab.navigatingTo = d.url; });

    // The page's beforeunload asks to stay. Electron wants the answer right
    // away, so Lumio says "stay" and asks in the tab instead; "Leave" then does
    // the same thing again, this time without asking (see askLeave).
    wc.on('will-prevent-unload', (e) => {
      // "Leave" was chosen already, or it's a helper AI's own tab (only it typed there).
      // (A "Leave" only counts for a little while: one whose navigation never
      // happened, a download say, mustn't wave through a close hours later.)
      if ((tab.allowUnload && Date.now() - tab.allowUnload < LEAVE_MS) || tab.agent) { tab.allowUnload = 0; e.preventDefault(); return; }
      const action = tab.leaving && Date.now() - tab.leaving.at < LEAVE_MS ? tab.leaving : null;
      tab.leaving = null;
      if (action) { M().askLeave(tab, action); return; }
      // The page is leaving by itself (a link, a form). A form you just sent
      // goes without asking, so what you typed in it isn't lost.
      if (Date.now() - (tab.sentForm || 0) < CATCH_MS) { tab.sentForm = 0; e.preventDefault(); return; }
      // While "Leave site?" is up, or once it asked since your last click or
      // key press in the page, the page just stays: like Chrome, it asks once
      // per thing you do, so a page can't keep asking, or push away the
      // question about closing it.
      if (tab.dialogs?.some((d) => d.spec.kind === 'leave') || tab.usedSinceAsked === false) return;
      // Otherwise let its beforeunload pass, and catch where it goes, just
      // below, to ask first.
      e.preventDefault();
      tab.catchLeave = Date.now();
    });
    wc.on('will-navigate', (e) => {
      const caught = Date.now() - (tab.catchLeave || 0) < CATCH_MS;
      tab.catchLeave = 0;
      const url = e.url || '';
      if (!caught || /^lumio:/i.test(url)) return;
      e.preventDefault();
      M().askLeave(tab, {
        kind: 'navigate',
        at: Date.now(),
        // From the page again, so the site gets the same request the page made
        // (not one that looks typed in the address bar).
        redo: () => {
          if (wc.isDestroyed()) return;
          tab.allowUnload = Date.now();
          wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `location.assign(${JSON.stringify(url)})` }]).catch(() => {});
        },
      });
    });

    // The page stopped responding: wait, or leave it, like Chrome.
    wc.on('unresponsive', () => {
      // Waiting for the person to answer its own dialog isn't being stuck, nor
      // is waiting on one in another tab or pop-up that shares its process
      // (an alert() there stops this page too; "Exit page" would end both).
      if (tab.dialogs?.some((d) => d.spec.kind === 'js' || d.spec.kind === 'unresponsive') || M().hooks.dialogInProcess?.(wc)) return;
      M().ask(tab, {
        kind: 'unresponsive',
        title: 'Page unresponsive',
        message: 'You can wait for it to become responsive or exit the page.',
        buttons: [{ id: 'exit', label: 'Exit page' }, { id: 'wait', label: 'Wait', primary: true }],
        cancel: 'wait',
      }).then(({ button }) => {
        if (button !== 'exit' || wc.isDestroyed()) return;
        tab.exited = true;
        wc.forcefullyCrashRenderer(); // its tab then says the page stopped responding
      });
    });
    wc.on('responsive', () => M().dismiss(tab, ['unresponsive']));
    wc.on('audio-state-changed', (e) => update({ audible: e.audible }));
    // A page in full screen gets "Press Esc to exit full screen" (main/access-notice.js).
    wc.on('enter-html-full-screen', () => {
      const m = M();
      m.fullscreenTab = tab.id;
      m.win.setFullScreen(true);
      m.layout();
      m.emit('fullscreen', true);
      m.hooks.onFullscreen?.(tab, true);
    });
    wc.on('leave-html-full-screen', () => {
      const m = M();
      m.fullscreenTab = null;
      m.win.setFullScreen(false);
      m.layout();
      m.emit('fullscreen', false);
      m.hooks.onFullscreen?.(tab, false);
    });
    wc.on('found-in-page', (_e, result) => M().hooks.onFound?.(tab.id, result));
    wc.on('zoom-changed', (_e, dir) => M().zoom(dir === 'in' ? 1 : -1, tab.id));

    // Web pages may not navigate to (or open) internal lumio:// pages.
    const guard = (e) => {
      const target = e.url || '';
      if (target.startsWith('lumio:') && !wc.getURL().startsWith('lumio:')) e.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame) guard(e); });

    // New tabs and windows from the page: links with target=_blank, window.open().
    wc.setWindowOpenHandler(({ url, disposition, features, frameName }) => {
      const m = M();
      const page = wc.getURL();
      const own = page.startsWith('lumio:'); // Lumio's own pages
      const kind = classify(url);
      if (!own && (url.startsWith('lumio:') || (kind !== 'web' && kind !== 'external'))) return { action: 'deny' }; // file:, javascript:, data:…
      // The pop-up blocker: only right after a click or key press in the page,
      // or from a site the person allowed. Lumio's and extensions' own pages
      // aren't blocked, like in Chrome.
      if (!own && !page.startsWith('chrome-extension:') && !m.mayOpenPopup(tab, url)) {
        m.blockPopup(tab, { url, features, frameName });
        return { action: 'deny' };
      }
      // A link to another app (mailto:, zoommtg:…) asks in this tab; no tab opens for it.
      if (kind === 'external') {
        m.hooks.openExternal(tab, { url, requestingUrl: page });
        return { action: 'deny' };
      }
      if (disposition === 'new-window') {
        // window.open() with a size is a real pop-up (sign-in, payments): a
        // small window of its own, with the page's settings, an address bar
        // the page can't change, and window.opener (main/popup-window.js).
        // Shift-click opens a normal browser window.
        if (features) {
          return {
            action: 'allow',
            outlivesOpener: true, // like Chrome: closing the tab leaves its pop-up open
            overrideBrowserWindowOptions: { webPreferences: PAGE_PREFS },
            createWindow: (options) => m.hooks.openPopup(tab, { webContents: options.webContents || null, url, features }),
          };
        }
        m.hooks.openInNewWindow?.(url, m.incognito);
        return { action: 'deny' };
      }
      const index = m.tabs.indexOf(tab) + 1;
      m.create(url, { active: disposition !== 'background-tab', index });
      return { action: 'deny' };
    });

    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && M().hooks.isAgentRunning?.() && !isSynthetic(wc)) {
        M().hooks.stopAgent();
        e.preventDefault();
      }
    });

    wc.on('context-menu', (_e, params) => M().contextMenu(tab, params));
    wc.once('destroyed', () => {
      const m = M();
      m.hooks.onViewDestroyed?.(wc);
      // The page closed itself (window.close()): its tab goes too, like Chrome.
      if (tab.view?.webContents === wc && m.tabs.includes(tab) && !tab.closing && !m.win.isDestroyed?.()) m.remove(tab);
    });
  }

  // ---------- pop-ups and other apps ----------
  // The person clicked or typed in the tab's page (or in a frame on it, see
  // preload/internal.js): the page may open one pop-up now, and another app
  // again.
  noteActivation(tab) {
    tab.activatedAt = Date.now();
    tab.usedSinceAsked = true; // "Leave site?" may ask again (not used up by a pop-up)
    tab.externalLock = false;
  }
  recentlyActivated(tab) { return Date.now() - (tab.activatedAt || 0) <= ACTIVATION_MS; }

  // Chrome's pop-up rule: a page may open a window or tab right after a click
  // or key press in it (one per click), or any time if you allowed its site.
  // A blocked one you clicked in the address bar's list gets through once.
  mayOpenPopup(tab, url) {
    const pass = tab.popupPass;
    tab.popupPass = null;
    if (pass && pass.url === url && Date.now() - pass.at <= PASS_MS) return true;
    if (this.hooks.popupsAllowed?.(tab.view.webContents.getURL())) return true;
    if (!this.recentlyActivated(tab)) return false;
    tab.activatedAt = 0; // used up
    return true;
  }

  // Lists a blocked pop-up for the address bar's "Pop-up blocked" icon.
  blockPopup(tab, { url, features = '', frameName = '' }) {
    const list = (tab.blockedPopups ||= []);
    list.push({ id: nextPopupId++, url, features, frameName });
    if (list.length > BLOCKED_MAX) list.shift();
    this.changed();
  }

  // The person picked a blocked pop-up: the page opens it again itself, so a
  // sign-in window still talks back to the page that opened it (window.opener).
  openBlockedPopup(tab, id) {
    const i = tab.blockedPopups?.findIndex((p) => p.id === id) ?? -1;
    const wc = tab.view?.webContents;
    if (i < 0 || !wc || wc.isDestroyed()) return;
    const [p] = tab.blockedPopups.splice(i, 1);
    this.changed();
    tab.popupPass = { url: p.url, at: Date.now() };
    const args = [p.url, p.frameName || '_blank', p.features].map((a) => JSON.stringify(a)).join(', ');
    wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `window.open(${args}); true` }], true).catch(() => {});
  }

  navState(wc) {
    const h = wc.navigationHistory;
    return { canGoBack: h.canGoBack(), canGoForward: h.canGoForward() };
  }

  // Take a tab out of this window without closing its page.
  detach(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const [tab] = this.tabs.splice(i, 1);
    if (tab.view) this.win.contentView.removeChildView(tab.view);
    if (this.fullscreenTab === id) this.fullscreenTab = null;
    if (this.activeId === id) {
      this.activeId = null;
      if (this.tabs.length) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
      else this.hooks.onDialogs?.(); // its dialog goes with it
    }
    this.changed();
    return tab;
  }

  // Take in a tab detached from another window.
  adopt(tab, { index, active = true } = {}) {
    tab.owner = this;
    if (tab.view) {
      tab.view.setVisible(false);
      this.win.contentView.addChildView(tab.view);
    }
    this.insert(tab, index);
    this.hooks.onAdopted?.(tab, this);
    if (active || !this.activeId) this.activate(tab.id);
    this.changed();
  }

  // Closing a tab. A web page you've used runs its beforeunload first and may
  // ask "Leave site?" in the tab; the tab goes once its page has closed.
  // force: no asking (a helper AI's own tab, where only the AI typed).
  close(id, { force = false } = {}) {
    const tab = this.get(id);
    if (!tab || tab.closing) return;
    // The last tab is the window: when closing the window needs asking first
    // (downloads it would cancel), the window closes instead, and the tab
    // stays if you cancel.
    if (!force && this.tabs.length === 1 && this.hooks.closeWindowFirst?.()) return;
    if (force || !this.mayAsk(tab)) { this.remove(tab); return; }
    const closing = this.closePage(tab);
    tab.closing = closing;
    closing.then((ok) => {
      if (tab.closing === closing) tab.closing = null;
      if (ok) tab.owner.remove(tab);
    });
  }

  // Could this tab's page ask "Leave site?" Chrome's rules: a web page, alive,
  // that you've clicked or typed in. One showing its own alert() closes
  // without asking (its dialog is dismissed).
  mayAsk(tab) {
    const wc = tab.view?.webContents;
    return !!wc && !wc.isDestroyed() && !!tab.touched && !tab.agent && !wc.isCrashed()
      && /^(https?|file):/i.test(wc.getURL()) && !tab.dialogs?.some((d) => d.spec.kind === 'js');
  }
  anyMayAsk() { return this.tabs.some((t) => t.closing || this.mayAsk(t)); }

  // Closes the tab's page after its beforeunload, which may ask "Leave site?".
  // Resolves true once the page has closed, false if the person stays.
  closePage(tab) {
    const wc = tab.view.webContents;
    return new Promise((resolve) => {
      let timer = null;
      const finish = (ok) => {
        clearTimeout(timer);
        wc.removeListener('destroyed', finish);
        if (tab.leaving === action) tab.leaving = null;
        resolve(ok !== false);
      };
      const action = {
        kind: 'close',
        at: Date.now(),
        redo: () => { if (!wc.isDestroyed()) wc.close(); },
        stay: () => finish(false),
        asked: () => clearTimeout(timer), // the person takes the time they need
      };
      wc.once('destroyed', finish);
      tab.leaving = action;
      // A page that doesn't answer is closed anyway, like Chrome.
      timer = setTimeout(() => { action.redo(); finish(true); }, CLOSE_MS);
      wc.close({ waitForBeforeUnload: true });
    });
  }

  // Before the window closes or Lumio quits, like Chrome: each web page you've
  // used runs its beforeunload in turn and may ask "Leave site?". Pages close
  // as they agree, but their tabs stay (asleep, like Memory Saver's), so if
  // you stay on one, the window is all still there. Resolves false then.
  async confirmLeaveAll() {
    // Alerts first, all at once: one left up would stall every page sharing
    // its process, and a stalled page is closed without asking.
    for (const tab of this.tabs) if (tab.owner === this) this.dismiss(tab, ['js']);
    for (const tab of [...this.tabs]) {
      if (tab.owner !== this) continue;
      if (tab.closing) { if (!(await tab.closing)) return false; continue; }
      this.dismiss(tab, ['js']);
      if (!this.mayAsk(tab)) continue;
      const saved = this.snapshot(tab);
      const closing = this.closePage(tab);
      tab.closing = closing;
      const ok = await closing;
      if (tab.closing === closing) tab.closing = null;
      if (!ok) return false;
      if (tab.owner === this && this.tabs.includes(tab)) this.putToSleep(tab, saved);
    }
    return true;
  }

  // Takes a tab out and closes its page, without asking.
  remove(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    const id = tab.id;
    this.tabs.splice(i, 1);
    this.dismiss(tab);
    const wc = tab.view?.webContents;
    const live = !!wc && !wc.isDestroyed();
    const url = tab.pendingUrl || (live ? wc.getURL() : tab.url);
    if (url && url !== NEWTAB) this.hooks.onTabClosed?.(this, { url, title: tab.title, favicon: tab.favicon, index: i, pinned: tab.pinned });
    if (tab.view) {
      this.win.contentView.removeChildView(tab.view);
      if (live) wc.close();
    }
    if (!this.tabs.length) {
      this.activeId = null;
      this.changed();
      this.hooks.onDialogs?.();
      this.hooks.onLastTabClosed?.();
      return;
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activate(next.id);
    }
    this.changed();
  }

  // ---------- leaving a page ----------
  // A navigation Lumio starts (address bar, reload, back, forward) that the
  // page's beforeunload may stop: kept so "Leave" can do it again.
  leaveBy(tab, kind, run) {
    this.dismiss(tab, ['js', 'unresponsive']); // a page waiting on its own dialog can't answer
    tab.leaving = { kind, at: Date.now(), redo: () => { tab.allowUnload = Date.now(); run(); } };
    run();
  }

  // The page asked to confirm leaving: "Leave site?" (or "Reload site?") in
  // its tab. Leave does the action again without asking; Cancel stays.
  askLeave(tab, action) {
    action.asked?.();
    tab.usedSinceAsked = false;
    this.dismiss(tab, ['leave']);
    // Closing: show the page it's about (its window too, when quitting), like Chrome.
    if (action.kind === 'close') { this.activate(tab.id); this.hooks.focusWindow?.(); }
    const reload = action.kind === 'reload';
    this.ask(tab, {
      kind: 'leave',
      about: action.kind,
      title: reload ? 'Reload site?' : 'Leave site?',
      message: 'Changes you made may not be saved.',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'leave', label: reload ? 'Reload' : 'Leave', primary: true }],
      cancel: 'cancel',
    }).then(({ button }) => {
      if (button === 'leave') { action.redo(); return; }
      action.stay?.();
      // The address bar goes back to the page you stayed on.
      const wc = tab.view?.webContents;
      if (wc && !wc.isDestroyed() && wc.getURL()) { tab.url = wc.getURL(); tab.owner.changed(); }
    });
  }

  // A main-frame navigation ended (it committed or failed): a remembered
  // navigation, and a "Leave" already given, are used up.
  leftPage(tab) {
    tab.navigatingTo = null;
    tab.allowUnload = 0;
    tab.catchLeave = 0; // a new page never inherits the old one's "Leave site?"
    if (tab.leaving?.kind !== 'close') tab.leaving = null;
  }

  // ---------- dialogs in the tab ----------
  // Queues a dialog in a tab; main/dialog-view.js draws the tab's first one
  // over its page. spec: { kind, title, message, note, error, fields,
  // checkbox, buttons: [{ id, label, primary }], cancel }. Resolves with
  // { button, values, checked } once answered, or with the cancel button if
  // the dialog is dismissed (its tab closed, its page moved on).
  ask(tab, spec) {
    return new Promise((resolve) => {
      if (!tab.owner.tabs.includes(tab)) { resolve({ button: spec.cancel, values: {}, checked: false, dismissed: true }); return; }
      (tab.dialogs ||= []).push({ id: nextDialogId++, spec, resolve });
      tab.owner.dialogsChanged(tab);
    });
  }

  // The person's answer, from the dialog view: only a button and fields the dialog has.
  answer(tab, id, { button, values, checked } = {}) {
    const d = tab.dialogs?.find((x) => x.id === id);
    if (!d || !d.spec.buttons.some((b) => b.id === button)) return;
    const clean = {};
    for (const f of d.spec.fields || []) clean[f.name] = String(values?.[f.name] ?? '').slice(0, 10_000);
    tab.dialogs = tab.dialogs.filter((x) => x !== d);
    d.resolve({ button, values: clean, checked: !!checked && !!d.spec.checkbox });
    this.dialogsChanged(tab);
  }

  // Closes the tab's dialogs of these kinds (all of them by default) as if cancelled.
  dismiss(tab, kinds = null) {
    const gone = (tab.dialogs || []).filter((d) => !kinds || kinds.includes(d.spec.kind));
    if (!gone.length) return;
    tab.dialogs = tab.dialogs.filter((d) => !gone.includes(d));
    for (const d of gone) d.resolve({ button: d.spec.cancel, values: {}, checked: false, dismissed: true });
    tab.owner.dialogsChanged(tab);
  }

  dialogsChanged(tab) { if (tab.id === this.activeId) this.hooks.onDialogs?.(); }

  activate(id) {
    const tab = this.get(id);
    if (!tab) return;
    const prev = this.active;
    if (prev) prev.lastActive = Date.now();
    tab.lastActive = Date.now();
    this.activeId = id;
    this.ensureView(tab);
    for (const t of this.tabs) if (t.view) { t.view.setVisible(t.id === id); t.view.lumioCovered = false; }
    // Keep the active page on top of the other tabs (and below any overlay).
    // Re-adding a view detaches it briefly, so skip it when it's already on top.
    const children = this.win.contentView.children.filter((v) => this.tabs.some((t) => t.view === v));
    if (children[children.length - 1] !== tab.view) this.win.contentView.addChildView(tab.view);
    this.hooks.onActivated?.(tab, this);
    this.layout();
    this.changed();
  }

  move(id, toIndex) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    this.insert(tab, toIndex);
    this.changed();
  }

  setPinned(id, pinned) {
    const tab = this.get(id);
    if (!tab || tab.pinned === !!pinned) return;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    tab.pinned = !!pinned;
    this.insert(tab, pinned ? this.pinnedCount() : this.pinnedCount());
    this.changed();
  }

  activateIndex(n) {
    const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (tab) this.activate(tab.id);
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  // ---------- navigation ----------
  navigate(input, id = this.activeId) {
    const parsed = parseInput(input, this.searchTemplate());
    if (!parsed) return null;
    let tab = this.get(id);
    // mailto: (typed, or a bookmark) opens the mail app, not a page.
    if (classify(parsed.url) === 'external') {
      if (tab) this.hooks.openExternal(tab, { url: parsed.url, typed: true });
      return parsed.url;
    }
    if (!tab) tab = this.create(parsed.url);
    else {
      this.ensureView(tab);
      tab.url = parsed.url;
      const wc = tab.view.webContents;
      this.leaveBy(tab, 'navigate', () => wc.loadURL(parsed.url).catch(() => {}));
    }
    tab.view.webContents.focus();
    this.changed();
    return parsed.url;
  }

  // What a helper AI sees of the tabs: only its own, which counts as the
  // active one. It works in the background: activating does nothing and
  // navigating doesn't take keyboard focus, so the person's view never jumps.
  scoped(tab) {
    const m = this;
    const alive = () => m.tabs.includes(tab);
    const nope = () => { throw new Error('Helpers work only in their own tab.'); };
    return {
      get active() { return alive() ? tab : null; },
      get activeId() { return tab.id; },
      get tabs() { return alive() ? [tab] : []; },
      get: (id) => (id === tab.id && alive() ? tab : null),
      activate: () => {},
      ensureView: (t) => m.ensureView(t),
      displayUrl: (t) => m.displayUrl(t),
      searchTemplate: () => m.searchTemplate(),
      get session() { return m.session; },
      wc: () => tab.view?.webContents,
      back: () => m.back(tab.id),
      forward: () => m.forward(tab.id),
      navigate(input) {
        const parsed = parseInput(input, m.searchTemplate());
        if (!parsed || !alive()) return null;
        m.ensureView(tab);
        tab.url = parsed.url;
        tab.view.webContents.loadURL(parsed.url).catch(() => {});
        m.changed();
        return parsed.url;
      },
      create: nope,
      close: nope,
    };
  }

  // A helper AI is working in this tab: a colored dot on it (null removes it).
  setAgent(id, agent) {
    const tab = this.get(id);
    if (!tab) return;
    tab.agent = agent;
    this.changed();
  }

  wc(id = this.activeId) {
    const tab = this.get(id);
    return tab && tab.view ? tab.view.webContents : null;
  }

  // Back, forward and reload: the page you leave may ask first (leaveBy).
  back(id = this.activeId) {
    const wc = this.wc(id);
    if (wc?.navigationHistory.canGoBack()) this.leaveBy(this.get(id), 'back', () => wc.navigationHistory.goBack());
  }
  forward(id = this.activeId) {
    const wc = this.wc(id);
    if (wc?.navigationHistory.canGoForward()) this.leaveBy(this.get(id), 'forward', () => wc.navigationHistory.goForward());
  }
  reload(hard = false, id = this.activeId) {
    const wc = this.wc(id);
    if (wc) this.leaveBy(this.get(id), 'reload', () => (hard ? wc.reloadIgnoringCache() : wc.reload()));
  }

  // "Back to safety" on a warning page: the last page before the one that
  // failed, or a new tab page.
  backToSafety(id) {
    const tab = this.get(id);
    const wc = this.wc(id);
    if (!wc) return;
    const failed = this.displayUrl(tab);
    const h = wc.navigationHistory;
    const entries = h.getAllEntries();
    for (let i = h.getActiveIndex() - 1; i >= 0; i--) {
      const url = entries[i]?.url || '';
      if (url && url !== failed && !url.startsWith('lumio://error')) { h.goToIndex(i); return; }
    }
    this.safeFallback(tab);
  }
  // Nowhere to go back to: a new tab page (a pop-up closes instead).
  safeFallback(tab) { tab.view.webContents.loadURL(NEWTAB).catch(() => {}); }
  stop() { this.wc()?.stop(); }

  zoom(step, id = this.activeId) {
    const wc = this.wc(id);
    if (!wc) return;
    const level = step === 0 ? 0 : Math.max(-4, Math.min(5, wc.getZoomLevel() + step * 0.5));
    wc.setZoomLevel(level);
    this.emit('zoom', { level: Math.round(Math.pow(1.2, level) * 100) });
  }

  toggleMute(id) {
    const tab = this.get(id);
    if (!tab?.view) return;
    tab.muted = !tab.muted;
    tab.view.webContents.setAudioMuted(tab.muted);
    this.changed();
  }

  // Quick Lumio AI actions for highlighted text (right-click › Lumio).
  selectionActions(selection) {
    const quoted = selection.slice(0, 8000).split('\n').map((l) => `> ${l}`).join('\n');
    const ask = (instruction, includePage = false) => this.hooks.askAI(`${instruction}\n\n${quoted}`, { includePage });
    let lang = 'English';
    try { lang = new Intl.DisplayNames(['en'], { type: 'language' }).of(app.getLocale().split('-')[0]) || 'English'; } catch { /* keep English */ }
    return [
      { label: 'Explain', click: () => ask('Explain this simply, using the page for context:', true) },
      { label: 'Summarize', click: () => ask('Summarize this in a few short bullet points:') },
      { label: `Translate to ${lang}`, click: () => ask(`Translate this into ${lang}. If it's already in ${lang}, translate it into English.`) },
      { label: 'Fix grammar and spelling', click: () => ask('Fix the grammar and spelling of this text. Reply with just the corrected text:') },
    ];
  }

  // ---------- layout ----------
  setSlot(rect) {
    this.slot = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
    };
    this.layout();
  }

  // Full-size Lumio chat covers the page area: hide the page underneath.
  setCovered(on, rect) {
    this.covered = !!on;
    if (rect) this.setSlot(rect);
    else this.layout();
    this.hooks.onDialogs?.(); // a dialog hides with its page
  }

  layout() {
    const tab = this.active;
    if (!tab?.view) return;
    if (tab.view.lumioCovered !== !!this.covered) {
      tab.view.setVisible(!this.covered);
      tab.view.lumioCovered = !!this.covered;
    }
    const full = this.fullscreenTab === tab.id;
    if (full) {
      const [w, h] = this.win.getContentSize();
      tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
    } else {
      tab.view.setBounds(this.slot);
    }
    // Setting the corner radius rebuilds the view's layer; only do it when it changes.
    const radius = full ? 0 : this.radius;
    if (tab.view.lumioRadius !== radius && typeof tab.view.setBorderRadius === 'function') {
      tab.view.setBorderRadius(radius);
      tab.view.lumioRadius = radius;
    }
    this.hooks.onLayout?.();
  }

  // Light or dark changed: Lumio's own pages get the new background (their
  // CSS follows by itself) and hear the new setting, so Settings shows it.
  applyAppearance() {
    for (const t of this.tabs) {
      const wc = t.view?.webContents;
      if (!wc || wc.isDestroyed() || !t.url.startsWith('lumio:')) continue;
      t.view.setBackgroundColor(this.pageBackground(t.url));
      wc.send('appearance', theme.appearance());
    }
  }

  // ---------- state for the shell ----------
  displayUrl(tab) {
    const url = tab.pendingUrl || tab.url || '';
    if (url.startsWith(NEWTAB)) return '';
    if (url.startsWith('lumio://error')) {
      try { return new URL(url).searchParams.get('url') || url; } catch { return url; }
    }
    return url;
  }

  state() {
    return {
      activeId: this.activeId,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        wcId: t.view ? t.view.webContents.id : null,
        title: t.title,
        url: this.displayUrl(t),
        internal: (t.pendingUrl || t.url || '').startsWith('lumio:'),
        favicon: t.favicon,
        loading: t.loading,
        canGoBack: t.canGoBack,
        canGoForward: t.canGoForward,
        audible: t.audible,
        muted: t.muted,
        sleeping: !!t.discarded,
        pdf: !!t.pdf,
        agent: t.agent || null,
        crashed: t.crashed,
        pinned: t.pinned,
        bookmarked: this.store.isBookmarked(this.displayUrl(t)),
        popupsBlocked: t.blockedPopups?.length || 0,
        // A certificate warning, or a site you went past one for: "Not secure" in red.
        notSecure: (t.pendingUrl || t.url || '').startsWith('lumio://error/cert') || certErrors.bypassed(this.session, this.displayUrl(t)),
      })),
    };
  }

  // What the session file keeps for this window.
  sessionTabs() {
    return this.tabs
      .map((t) => ({ url: t.pendingUrl || t.url, title: t.title, ...(t.pinned ? { pinned: true } : {}) }))
      .filter((t) => t.url && !t.url.startsWith('lumio://error'));
  }

  changed() {
    if (this.pushTimer) return;
    this.pushTimer = setImmediate(() => {
      this.pushTimer = null;
      this.emit('tabs', this.state());
      this.hooks.onChanged?.(this);
    });
  }

  restore(list = [], active = 0) {
    if (!list.length) return false;
    list.forEach((t, i) => this.create(t.url, { active: false, lazy: i !== active, title: t.title, pinned: !!t.pinned }));
    const target = this.tabs[Math.min(active, this.tabs.length - 1)];
    if (target) this.activate(target.id);
    return true;
  }

  // ---------- context menu ----------
  contextMenu(tab, params) {
    const wc = tab.view.webContents;
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
    const index = this.tabs.indexOf(tab) + 1;
    const engine = SEARCH_ENGINES[this.store.settings.searchEngine] || SEARCH_ENGINES.google;
    const ai = !!this.hooks.askAI; // a pop-up has no Lumio AI

    if (params.misspelledWord) {
      const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
      for (const word of suggestions) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
      if (!suggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: 'Add to Dictionary', click: () => this.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }
    if (params.linkURL) {
      // A mailto: or other app's link opens that app (asking first), wherever you open it.
      const openLink = (how) => () => (classify(params.linkURL) === 'external' ? this.hooks.openExternal(tab, { url: params.linkURL, typed: true }) : how());
      items.push(
        { label: 'Open Link in New Tab', click: openLink(() => this.create(params.linkURL, { active: false, index })) },
        { label: 'Open Link in New Window', click: openLink(() => this.hooks.openInNewWindow?.(params.linkURL, this.incognito)) },
        ...(this.incognito ? [] : [{ label: 'Open Link in Incognito Window', click: openLink(() => this.hooks.openInNewWindow?.(params.linkURL, true)) }]),
        { type: 'separator' },
        { label: 'Save Link As…', click: () => this.hooks.saveAs(wc, params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        ...(ai ? [{ label: 'Ask Lumio About This Link', click: () => this.hooks.askAI(`What is at this link? ${params.linkURL}`, { includePage: false }) }] : []),
      );
      sep();
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.create(params.srcURL, { active: false, index }) },
        { label: 'Save Image As…', click: () => this.hooks.saveAs(wc, params.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      );
      sep();
    }
    if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL && /^https?:/.test(params.srcURL)) {
      items.push(
        { label: `Open ${params.mediaType === 'video' ? 'Video' : 'Audio'} in New Tab`, click: () => this.create(params.srcURL, { active: false, index }) },
        { label: `Save ${params.mediaType === 'video' ? 'Video' : 'Audio'} As…`, click: () => this.hooks.saveAs(wc, params.srcURL) },
      );
      sep();
    }
    const selection = (params.selectionText || '').trim();
    if (params.isEditable) {
      items.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
        { role: 'selectAll' },
        ...(selection && ai ? [{ type: 'separator' }, { label: 'Lumio', submenu: this.selectionActions(selection) }] : []),
      );
      sep();
    } else if (selection) {
      const short = selection.length > 28 ? selection.slice(0, 28) + '…' : selection;
      items.push(
        { role: 'copy' },
        { label: `Search ${engine.name} for “${short}”`, click: () => this.create(parseInput(selection, engine.url).url, { index }) },
        ...(ai ? [
          { label: `Ask Lumio About “${short}”`, click: () => this.hooks.askAI(`About this text from the page:\n\n> ${selection}\n\n`, { includePage: true, draft: true }) },
          { label: 'Lumio', submenu: this.selectionActions(selection) },
        ] : []),
      );
      sep();
    }
    if (!params.linkURL && !selection && !params.isEditable && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: tab.canGoBack, click: () => this.back(tab.id) },
        { label: 'Forward', enabled: tab.canGoForward, click: () => this.forward(tab.id) },
        { label: 'Reload', click: () => this.reload(false, tab.id) },
        { type: 'separator' },
        { label: 'Save Page As…', click: () => this.hooks.savePage?.(tab) },
        { label: 'Print…', click: () => wc.print() },
        { type: 'separator' },
        ...(ai ? [{ label: 'Summarize This Page with Lumio', click: () => this.hooks.askAI('Summarize this page.', { includePage: true }) }] : []),
        { label: 'View Page Source', click: () => this.create('view-source:' + wc.getURL(), { index }) },
      );
      sep();
    }
    const extra = this.hooks.contextMenuExtras?.(tab, params) || [];
    if (extra.length) { items.push(...extra); sep(); }
    items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }
}

module.exports = { TabManager, NEWTAB };
