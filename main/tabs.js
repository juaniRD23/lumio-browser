// TabManager: the tabs of one browser window. Each tab is a WebContentsView
// laid out in the "page slot" rectangle that the shell reports. Tabs restored
// from the last session are created lazily (their page loads the first time
// they're activated). A tab can move to another window (detach + adopt), so
// its event handlers always look up the manager that currently owns it.
const { WebContentsView, Menu, clipboard, shell, app } = require('electron');
const { isSynthetic } = require('./synthetic-input');
const path = require('path');
const { parseInput, displayUrl } = require('./omnibox');
const { displayUrl: lookalikeSafeUrl } = require('./lookalike');
const { SEARCH_ENGINES } = require('./store');
const theme = require('./theme');

const NEWTAB = 'lumio://newtab/';
const INTERNAL_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');

let nextId = 1;

class TabManager {
  constructor({ win, session, store, emit, hooks, incognito = false }) {
    this.win = win;
    this.session = session;
    this.store = store;
    this.emit = emit; // (channel, payload) -> this window's shell
    this.hooks = hooks;
    this.incognito = incognito;
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
  create(url = NEWTAB, { active = true, index, title, lazy = false, pinned = false } = {}) {
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
    // Site settings that only apply when a page is made (main/site-controls.js).
    const insecure = !!this.hooks.allowInsecure?.(tab.pendingUrl || tab.url);
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: INTERNAL_PRELOAD,
        spellcheck: true,
        plugins: true, // built-in PDF viewer
        allowRunningInsecureContent: insecure,
        autoplayPolicy: this.store.settings.contentDefaults?.autoplay === 'allow' ? 'no-user-gesture-required' : 'document-user-activation-required',
      },
    });
    view.lumioInsecure = insecure;
    tab.view = view;
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(10);
    view.setBackgroundColor(this.pageBackground(tab.url));
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.wire(tab);
    this.hooks.onViewCreated?.(tab, this);
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
    if (!tab?.view || tab.id === this.activeId || tab.audible) return false;
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || wc.isLoading() || wc.isCurrentlyAudible() || wc.isBeingCaptured() || wc.isDevToolsOpened()) return false;
    const url = wc.getURL();
    if (!url || url.startsWith('lumio://')) return false; // internal pages are cheap
    const h = wc.navigationHistory;
    tab.savedHistory = { entries: h.getAllEntries(), index: h.getActiveIndex() };
    tab.pendingUrl = url;
    tab.url = url;
    tab.discarded = true;
    tab.loading = false;
    this.win.contentView.removeChildView(tab.view);
    tab.view = null;
    wc.close();
    this.changed();
    return true;
  }

  // Make a tab's page again, with its history, going to `url` (a site
  // setting that's fixed when a page is made changed: main/site-controls.js).
  rebuild(id, url) {
    const tab = this.get(id);
    if (!tab?.view) return;
    const wc = tab.view.webContents;
    const h = wc.navigationHistory;
    const entries = h.getAllEntries();
    let index = h.getActiveIndex();
    // Back, forward or reload keep the list; a new address follows the current page.
    if (entries[index - 1]?.url === url) index -= 1;
    else if (entries[index + 1]?.url === url) index += 1;
    else if (entries[index]?.url !== url) { entries.splice(index + 1, Infinity, { url, title: '' }); index += 1; }
    tab.savedHistory = { entries, index };
    tab.pendingUrl = url;
    this.win.contentView.removeChildView(tab.view);
    tab.view = null;
    wc.close();
    this.ensureView(tab);
    if (tab.id === this.activeId) this.activate(tab.id);
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
      if (!isMainFrame || code === -3 || url.startsWith('lumio://error')) return;
      // A page Lumio stopped (a dangerous site, HTTPS-First…) gets a warning page instead (main/navigation-guard.js).
      if (M().hooks.loadFailed?.(wc, code, url)) return;
      const q = new URLSearchParams({ code: String(code), desc, url });
      wc.loadURL('lumio://error/?' + q).catch(() => {});
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      const failed = M().displayUrl(tab);
      update({ loading: false });
      const q = new URLSearchParams({ code: 'crashed', desc: details.reason, url: failed });
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL('lumio://error/?' + q).catch(() => {}); }, 50);
    });
    wc.on('audio-state-changed', (e) => update({ audible: e.audible }));
    wc.on('enter-html-full-screen', () => {
      const m = M();
      m.fullscreenTab = tab.id;
      m.win.setFullScreen(true);
      m.layout();
      m.emit('fullscreen', true);
    });
    wc.on('leave-html-full-screen', () => {
      const m = M();
      m.fullscreenTab = null;
      m.win.setFullScreen(false);
      m.layout();
      m.emit('fullscreen', false);
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

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      const m = M();
      if (url.startsWith('lumio:') && !wc.getURL().startsWith('lumio:')) return { action: 'deny' };
      if (disposition === 'new-window') {
        // window.open() with a size is a real popup (OAuth, payments) that
        // keeps window.opener. Shift-click opens a normal browser window.
        if (features) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true },
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
    wc.once('destroyed', () => M().hooks.onViewDestroyed?.(wc));
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

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    const url = tab.pendingUrl || (tab.view ? tab.view.webContents.getURL() : tab.url);
    if (url && url !== NEWTAB) this.hooks.onTabClosed?.(this, { url, title: tab.title, favicon: tab.favicon, index: i, pinned: tab.pinned });
    if (tab.view) {
      this.win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    if (!this.tabs.length) {
      this.activeId = null;
      this.changed();
      this.hooks.onLastTabClosed?.();
      return;
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activate(next.id);
    }
    this.changed();
  }

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
    if (!tab) tab = this.create(parsed.url);
    else {
      this.ensureView(tab);
      tab.url = parsed.url;
      tab.view.webContents.loadURL(parsed.url).catch(() => {});
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

  back() { const wc = this.wc(); if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
  forward() { const wc = this.wc(); if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
  reload(hard = false) {
    const tab = this.active;
    if (!tab?.view) return;
    if (hard) tab.view.webContents.reloadIgnoringCache(); else tab.view.webContents.reload();
  }
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
    const radius = full ? 0 : 10;
    if (tab.view.lumioRadius !== radius && typeof tab.view.setBorderRadius === 'function') {
      tab.view.setBorderRadius(radius);
      tab.view.lumioRadius = radius;
    }
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
    if (url.startsWith('lumio://error') || url.startsWith('lumio://interstitial')) {
      try { return new URL(url).searchParams.get('url') || url; } catch { return url; }
    }
    return url;
  }

  // What a warning page (lumio://interstitial) is about, for the address bar's icon.
  warningOf(tab) {
    const url = tab.pendingUrl || tab.url || '';
    if (!url.startsWith('lumio://interstitial')) return null;
    try { return new URL(url).searchParams.get('type') || 'unsafe'; } catch { return 'unsafe'; }
  }

  state() {
    return {
      activeId: this.activeId,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        wcId: t.view ? t.view.webContents.id : null,
        title: t.title,
        url: this.displayUrl(t),
        // International addresses in their own letters, unless they could pass for another site (main/lookalike.js).
        shown: lookalikeSafeUrl(this.displayUrl(t)),
        warning: this.warningOf(t),
        capture: this.hooks.captureOf?.(t) || null, // camera, microphone or screen in use (main/capture.js)
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

    if (params.misspelledWord) {
      const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
      for (const word of suggestions) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
      if (!suggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: 'Add to Dictionary', click: () => this.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.create(params.linkURL, { active: false, index }) },
        { label: 'Open Link in New Window', click: () => this.hooks.openInNewWindow?.(params.linkURL, this.incognito) },
        ...(this.incognito ? [] : [{ label: 'Open Link in Incognito Window', click: () => this.hooks.openInNewWindow?.(params.linkURL, true) }]),
        { type: 'separator' },
        { label: 'Save Link As…', click: () => wc.downloadURL(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { label: 'Ask Lumio About This Link', click: () => this.hooks.askAI(`What is at this link? ${params.linkURL}`, { includePage: false }) },
      );
      sep();
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.create(params.srcURL, { active: false, index }) },
        { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      );
      sep();
    }
    if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL && /^https?:/.test(params.srcURL)) {
      items.push(
        { label: `Open ${params.mediaType === 'video' ? 'Video' : 'Audio'} in New Tab`, click: () => this.create(params.srcURL, { active: false, index }) },
        { label: `Save ${params.mediaType === 'video' ? 'Video' : 'Audio'} As…`, click: () => wc.downloadURL(params.srcURL) },
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
        ...(selection ? [{ type: 'separator' }, { label: 'Lumio', submenu: this.selectionActions(selection) }] : []),
      );
      sep();
    } else if (selection) {
      const short = selection.length > 28 ? selection.slice(0, 28) + '…' : selection;
      items.push(
        { role: 'copy' },
        { label: `Search ${engine.name} for “${short}”`, click: () => this.create(parseInput(selection, engine.url).url, { index }) },
        { label: `Ask Lumio About “${short}”`, click: () => this.hooks.askAI(`About this text from the page:\n\n> ${selection}\n\n`, { includePage: true, draft: true }) },
        { label: 'Lumio', submenu: this.selectionActions(selection) },
      );
      sep();
    }
    if (!params.linkURL && !selection && !params.isEditable && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: tab.canGoBack, click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: tab.canGoForward, click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Save Page As…', click: () => this.hooks.savePage?.(tab) },
        { label: 'Print…', click: () => wc.print() },
        { type: 'separator' },
        { label: 'Summarize This Page with Lumio', click: () => this.hooks.askAI('Summarize this page.', { includePage: true }) },
        { label: 'View Page Source', click: () => this.create('view-source:' + wc.getURL(), { index }) },
      );
      sep();
    }
    const extra = this.hooks.contextMenuExtras?.(tab, params) || [];
    if (extra.length) { items.push(...extra); sep(); }
    items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  openExternal(url) { shell.openExternal(url); }
}

module.exports = { TabManager, NEWTAB };
