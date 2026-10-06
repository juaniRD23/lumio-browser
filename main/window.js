// One browser window: the shell page (tab strip, toolbar, bookmarks bar, AI
// panel), an overlay view for dropdowns drawn above the page, the window's
// tabs and its Lumio AI controller. Each window belongs to one profile (its
// session, settings, bookmarks, account: see main.js). Incognito windows use
// a throwaway copy of it and never write history, sessions or chats to disk;
// Guest windows' profile is thrown away when the last one closes.
const { BrowserWindow, WebContentsView, screen } = require('electron');
const path = require('path');
const { TabManager, NEWTAB } = require('./tabs');
const { AIController } = require('./ai/controller');
const { PageIndicator } = require('./ai/indicators');
const { DialogView } = require('./dialog-view');
const { AccessNotice } = require('./access-notice');
const { menuModel } = require('./menu');
const theme = require('./theme');

// Bundled by scripts/build-preload.mjs (it includes the extension toolbar code).
const SHELL_PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');

let nextWindowId = 1;

function defaultBounds(near) {
  if (near && !near.isDestroyed()) {
    // Cascade new windows from the current one, like other browsers.
    const b = near.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const x = b.x + 28 + b.width > wa.x + wa.width ? wa.x + 20 : b.x + 28;
    const y = b.y + 28 + b.height > wa.y + wa.height ? wa.y + 20 : b.y + 28;
    return { x, y, width: b.width, height: b.height };
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const width = Math.min(1480, wa.width - 60);
  const height = Math.min(940, wa.height - 40);
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

function visibleBounds(b) {
  if (!b) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const overlap = Math.max(0, Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x))
    * Math.max(0, Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y));
  return overlap > 200 * 200 ? b : null;
}

class BrowserWin {
  // app: services from main.js. profile: { session, store, account, downloads, permissions, chats, … }.
  // maximized: as it was when the session was saved. inactive: shown without
  // taking focus (a tab being dragged out, main/tab-drag.js).
  constructor(app, profile, { incognito = false, tabs = null, active = 0, groups = [], bounds = null, urls = [], adopt = null, near = null, maximized = false, inactive = false } = {}) {
    this.app = app;
    this.profile = profile;
    this.id = nextWindowId++;
    this.incognito = incognito;
    this.closedTabs = []; // incognito only; normal windows use the app-wide list
    this.closing = false;

    const colors = theme.colors(theme.isDark(incognito), incognito);
    this.win = new BrowserWindow({
      ...(visibleBounds(bounds) || defaultBounds(near)),
      minWidth: 760,
      minHeight: 500,
      title: incognito ? 'Lumio Browser (Incognito)' : profile.guest ? 'Lumio Browser (Guest)' : 'Lumio Browser',
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
        // Windows: our tab strip is the title bar; Windows draws its own
        // minimize / maximize / close buttons at its right end.
        : { titleBarStyle: 'hidden', titleBarOverlay: { color: colors.frame, symbolColor: colors.symbol, height: 40 }, autoHideMenuBar: true }),
      backgroundColor: colors.frame,
      show: false,
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    if (process.platform !== 'darwin') this.win.setMenuBarVisibility(false);
    // Incognito is always dark: its UI is served already dark (main/protocol.js).
    const query = incognito ? '?appearance=dark' : '';
    this.win.loadURL('lumio://shell/' + query);
    this.win.once('ready-to-show', () => {
      if (process.env.LUMIO_HIDDEN) return;
      if (maximized) this.win.maximize(); // shows it too
      else if (inactive) this.win.showInactive();
      else this.win.show();
    });

    this.overlay = new WebContentsView({
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.loadURL('lumio://overlay/' + query);
    // The overlay's side of showing and hiding (showOverlay), and the ⋮ menu.
    this.overlaySeq = 0;
    this.overlayIn = -1;
    const fromOverlay = this.overlay.webContents.ipc;
    fromOverlay.on('overlay:ready', (_e, msg) => this.overlayReady(msg || {}));
    fromOverlay.on('overlay:gone', (_e, msg) => this.overlayGone(msg || {}));
    fromOverlay.on('overlay:hover', (_e, index) => { if (this.overlayKind === 'suggest') this.emit('overlay-state', { kind: 'suggest', hover: index }); });
    fromOverlay.on('overlay:menu', (_e, msg) => this.menuPicked(msg || {}));
    // While the menu is open, the keys typed in the window (which keeps the
    // keyboard, and so the text you were editing) go to it.
    this.win.webContents.ipc.on('overlay:key', (_e, key) => {
      if (this.overlayKind === 'menu' && typeof key === 'string') this.overlay.webContents.send('overlay-data', { op: 'key', key });
    });
    // Like a native menu, it closes when the window loses focus.
    this.win.on('blur', () => { if (this.overlayKind === 'menu') this.hideOverlay(); });

    const emit = (c, p) => this.emit(c, p);
    this.tabs = new TabManager({
      win: this.win,
      session: profile.session,
      store: profile.store,
      incognito,
      guest: !!profile.guest,
      emit,
      hooks: {
        askAI: (text, opts) => this.askAI(text, opts),
        isAgentRunning: () => this.ai?.isRunning(),
        stopAgent: () => this.ai?.stop(),
        onFound: (tabId, result) => { if (tabId === this.tabs.activeId) this.emit('find-result', result); },
        onActivated: (tab) => { this.hideOverlay(); this.emit('find-close'); this.notice.hide(); this.dialogs.sync(); this.indicator.raise(); app.onTabActivated(this, tab); },
        onDialogs: () => this.dialogs.sync(),
        onLayout: () => { this.dialogs.place(); this.notice.place(); },
        onFullscreen: (tab, on) => this.notice.fullscreen(tab, on),
        focusWindow: () => this.focus(),
        closeWindowFirst: () => { if (!app.downloadsAtRisk(this)) return false; this.close(); return true; },
        onLastTabClosed: () => this.close(),
        onTabClosed: (_m, entry) => app.onTabClosed(this, entry),
        onChanged: () => app.onSessionChanged(),
        onViewCreated: (tab) => { this.indicator.raise(); app.onViewCreated(this, tab); },
        onAdopted: (tab) => app.onViewCreated(this, tab),
        onViewDestroyed: (wc) => profile.permissions.dropFor(wc.id),
        allowInsecure: (url) => !!profile.siteControls?.insecureAllowed(url),
        loadFailed: (wc, code, url) => !!app.loadFailed?.(this, wc, code, url),
        captureOf: (tab) => app.captureOf?.(tab),
        openInNewWindow: (url, inc) => app.createWindow({ profile: profile.base, incognito: inc, urls: [url] }),
        openPopup: (tab, opts) => app.openPopup(this, tab, opts),
        openExternal: (tab, req) => app.openExternal(this, tab, req),
        dialogInProcess: (wc) => app.dialogInProcess(wc),
        popupsAllowed: (pageUrl) => profile.permissions.allowsPopups(pageUrl),
        saveAs: (wc, url) => profile.downloads.saveAs(wc, url),
        savePage: (tab) => app.savePage(this, tab),
        print: (tab) => app.print(this, tab),
        contextMenuExtras: (tab, params) => app.contextMenuExtras(this, tab, params),
        readingList: (url, title) => app.addToReadingList(this, url, title),
        pageMenu: (section, tab, params) => app.pageMenu?.(this, section, tab, params),
      },
    });
    this.indicator = new PageIndicator(this);
    this.dialogs = new DialogView(this); // a page's dialogs, over its tab
    this.notice = new AccessNotice(this); // "Press Esc to exit full screen"
    this.ai = new AIController({
      store: profile.store,
      chats: profile.chats,
      tabs: this.tabs,
      emit,
      helper: app.helper,
      account: profile.account,
      indicator: this.indicator,
      // Guest keeps nothing, so Lumio doesn't schedule or learn there.
      schedules: incognito || profile.guest ? null : profile.schedules,
      workflows: incognito ? null : profile.workflows,
      siteTips: profile.siteTips,
      learnTips: !incognito && !profile.guest,
      projects: incognito ? null : profile.projects,
      notify: (title, body, chatId) => app.notify(this, title, body, chatId),
      onSettingsChanged: () => app.broadcastAIState(),
    });

    if (adopt) this.tabs.adopt(adopt);
    else if (!(tabs && this.tabs.restore(tabs, active, groups))) {
      if (urls.length) urls.forEach((u, i) => this.tabs.create(u, { active: i === 0 }));
      else this.tabs.create(NEWTAB);
    }

    this.win.on('focus', () => app.onFocus(this));
    this.win.on('resize', () => this.tabs.layout());
    this.win.on('close', (e) => {
      const approved = this.closeApproved;
      this.closeApproved = false;
      // Pages you've used may ask "Leave site?" first, one at a time, and
      // closing may cancel downloads (the last Incognito window, or the last
      // window where that quits): ask before any of it (confirmClose).
      if (!approved && (this.tabs.anyMayAsk() || app.downloadsAtRisk(this))) { e.preventDefault(); app.quitCancelled?.(); this.confirmClose(); return; }
      this.closing = true;
      app.onClose(this);
    });
    this.win.on('closed', () => {
      this.ai.shutdown();
      this.indicator.destroy();
      this.notice.destroy();
      // Pages waiting on a dialog get their answer (as cancelled), so none is left stuck.
      for (const tab of this.tabs.tabs) this.tabs.dismiss(tab);
      this.dialogs.destroy();
      app.onClosed(this);
    });
    this.win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.ai.isRunning()) { this.ai.stop(); e.preventDefault(); }
    });
  }

  get closed() { return this.win.isDestroyed(); }

  // Light or dark changed (main/theme.js): the native colors behind the UI
  // follow; the pages' CSS follows by itself.
  applyAppearance() {
    if (this.win.isDestroyed()) return;
    const c = theme.colors(theme.isDark(this.incognito), this.incognito);
    this.win.setBackgroundColor(c.frame);
    if (process.platform !== 'darwin') this.win.setTitleBarOverlay({ color: c.frame, symbolColor: c.symbol });
    this.emit('ui-prefs', theme.uiPrefs());
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.send('ui-prefs', theme.uiPrefs());
    this.tabs.applyAppearance();
  }

  emit(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
    // The ⋮ menu's zoom row follows the page's zoom, from its buttons or the keyboard.
    if (channel === 'zoom' && this.overlayKind === 'menu') this.overlay.webContents.send('overlay-data', { op: 'zoom', level: payload.level });
    this.app.onEmit?.(this, channel, payload); // the phone companion follows Lumio's work
  }

  focus() {
    this.app.onFocus(this); // don't wait for the OS focus event
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  close() { if (!this.win.isDestroyed()) this.win.close(); }

  // Closes the window once you agree to cancel the downloads it would end
  // (main.js confirmDownloads) and every page that asks agrees
  // (TabManager.confirmLeaveAll).
  async confirmClose() {
    if (this.confirming) return;
    this.confirming = true;
    try {
      if (!(await this.app.confirmDownloads(this))) {
        if (!this.tabs.tabs.length) this.tabs.create(NEWTAB); // its last page closed itself: don't leave it empty
        return;
      }
      if (await this.tabs.confirmLeaveAll()) {
        this.closeApproved = true;
        this.close();
      }
    } finally {
      this.confirming = false;
    }
  }

  focusOmnibox() {
    if (this.win.isDestroyed()) return; // closed before a delayed focus ran
    this.win.webContents.focus();
    this.emit('focus-omnibox');
  }

  // Dropdowns, prompts and menus over the page (renderer/ui/overlay.js). A
  // new one comes in steps, so it never shows what was there before: the
  // overlay draws it unseen and says how tall it is (op 'show', then
  // overlay:ready), the view goes on top, and it plays its entrance (op
  // 'in'). The same one again (new suggestions, a download's progress) just
  // updates. payload.anchor, in window coordinates, is where it grows from;
  // payload.focus gives it the keyboard once it's on screen.
  showOverlay(rect, payload) {
    const [w, h] = this.win.getContentSize();
    const x = Math.max(0, Math.min(Math.round(rect.x), w - 40));
    const y = Math.max(0, Math.round(rect.y));
    const bounds = { x, y, width: Math.min(Math.round(rect.width), w - x), height: Math.min(Math.round(rect.height), h - y) };
    const kind = payload?.kind || null;
    const entered = this.overlayIn === this.overlaySeq;
    if (kind && kind === this.overlayKind && !this.overlayLeaving) {
      if (entered && this.overlayFits) bounds.height = this.overlay.getBounds().height; // it sizes itself (overlay:size)
      this.overlayBounds = bounds;
      if (entered) this.overlay.setBounds(bounds);
      // Back on top if another view went over it meanwhile (the AI's working bar).
      const views = this.win.contentView.children;
      if (entered && views[views.length - 1] !== this.overlay) this.win.contentView.addChildView(this.overlay);
      this.overlay.webContents.send('overlay-data', { ...payload, width: bounds.width, height: bounds.height });
      return;
    }
    const attached = this.win.contentView.children.includes(this.overlay);
    // It takes the place of another: a chooser's or the screen sharing
    // picker's question is cancelled (overlayClosed), so the page isn't left waiting.
    if (this.overlayKind && this.overlayKind !== kind) this.overlayClosed();
    clearTimeout(this.overlayLeaving);
    this.overlayLeaving = null;
    this.overlayKind = kind;
    this.overlayBounds = bounds;
    this.overlayFits = false;
    // Focus goes to it once it's on screen: dropdowns opened from the
    // keyboard, and the ones you type in (tab search, the bookmark bubble,
    // the tab group editor).
    this.overlayFocus = !!(payload?.focus || payload?.keyboard || ['tabsearch', 'bm-edit', 'tab-group'].includes(kind));
    const seq = ++this.overlaySeq;
    const a = payload?.anchor;
    const origin = a && Number.isFinite(a.x) && Number.isFinite(a.y) ? { x: Math.round(a.x - x), y: Math.round(a.y - y) } : null;
    // wait: something may still be on screen, which the overlay clears first.
    this.overlay.webContents.send('overlay-data', { ...payload, op: 'show', seq, wait: attached, origin, width: bounds.width, height: bounds.height });
    clearTimeout(this.overlayWait);
    this.overlayWait = setTimeout(() => this.overlayReady({ seq }), 150); // in case it can't draw (its window is hidden)
  }

  // The overlay drew it: size it (height, for those that fit what's in
  // them), put it on top and play its entrance.
  overlayReady({ seq, height } = {}) {
    if (seq !== this.overlaySeq || !this.overlayKind || this.win.isDestroyed()) return;
    clearTimeout(this.overlayWait);
    const b = this.overlayBounds;
    if (Number.isFinite(height)) {
      b.height = Math.max(60, Math.min(Math.round(height), this.win.getContentSize()[1] - b.y - 8));
      this.overlayFits = true;
    }
    this.overlay.setBounds(b);
    if (this.overlayIn === seq) return; // already in: only its height changed
    this.overlayIn = seq;
    const views = this.win.contentView.children;
    if (views[views.length - 1] !== this.overlay) this.win.contentView.addChildView(this.overlay);
    if (this.overlayFocus) this.overlay.webContents.focus();
    this.overlay.webContents.send('overlay-data', { op: 'in', seq });
  }

  // It plays its exit, then the view comes off once the overlay has drawn
  // an empty frame (overlay:gone), so the next one can't flash this one.
  // now: no exit (the pointer is on it, and it mustn't take a click meant
  // for what's under it). quiet: see overlayClosed.
  hideOverlay({ now = false, quiet = false } = {}) {
    this.overlayClosed(quiet);
    if (this.win.isDestroyed()) return;
    clearTimeout(this.overlayWait);
    if (this.overlayLeaving && !now) return; // on its way out already
    const seq = ++this.overlaySeq; // one still being drawn won't come in
    if (!this.win.contentView.children.includes(this.overlay)) return;
    this.overlay.webContents.send('overlay-data', { op: 'out', seq, now });
    if (now) this.detachOverlay();
    else this.overlayLeaving = setTimeout(() => this.detachOverlay(), 400); // if it never says it's done
  }

  // What was showing is closed (hidden, or another took its place), so
  // whoever waits on it hears. quiet: the shell asked, so it knows;
  // otherwise it hears (overlay-state) that what it opened has closed.
  overlayClosed(quiet = false) {
    const kind = this.overlayKind;
    this.overlayKind = null;
    if (kind === 'passkey') this.app.onPasskeyPromptClosed?.(this);
    if (kind === 'screenshare') this.app.onScreenSharePickerClosed?.(this);
    if (kind) this.app.onOverlayClosed?.(this, kind);
    if (kind === 'menu') this.menuClosed();
    if (kind && !quiet) this.emit('overlay-state', { kind, closed: true });
  }

  overlayGone({ seq } = {}) {
    if (seq === this.overlaySeq && this.overlayLeaving) this.detachOverlay();
  }

  detachOverlay() {
    clearTimeout(this.overlayLeaving);
    this.overlayLeaving = null;
    if (!this.win.isDestroyed() && this.win.contentView.children.includes(this.overlay)) this.win.contentView.removeChildView(this.overlay);
  }

  // The ⋮ menu (main/menu.js buildBrowserMenu), over the whole window like a
  // native menu: a click anywhere outside it only closes it. from: where the
  // keyboard was ('page' or the window's own UI), which gets it back after.
  // Opened from the keyboard (⋮ focused, so no text is being edited), the
  // menu takes the keyboard itself, so screen readers follow its rows.
  showMenu({ anchor, at, keyboard = false, from } = {}, entries) {
    const { items, actions } = menuModel(entries);
    this.menuActions = actions;
    this.menuFrom = from === 'page' ? 'page' : 'shell';
    const [width, height] = this.win.getContentSize();
    this.showOverlay({ x: 0, y: 0, width, height }, { kind: 'menu', items, anchor, at, keyboard: !!keyboard, focus: !!keyboard });
  }

  // A choice in the menu: it closes first, so whatever the command opens
  // gets the keyboard. Zoom's − and + leave it open.
  menuPicked({ id, close } = {}) {
    if (this.overlayKind !== 'menu') return;
    if (close) { this.hideOverlay(); return; }
    const action = this.menuActions?.get(id);
    if (!action) return;
    if (!action.keepOpen) this.hideOverlay();
    action.run();
  }

  // A click in the menu gave it the keyboard (and one on ⋮ took it from the
  // page): hand it back.
  menuClosed() {
    this.menuActions = null;
    if (this.win.isDestroyed()) return;
    const ui = this.win.webContents;
    const back = this.menuFrom === 'page' ? this.tabs.wc() : ui;
    if (back && (this.overlay.webContents.isFocused() || (back !== ui && ui.isFocused()))) back.focus();
  }

  // A tab's hover card (shell.js showCard). The overlay, as wide as the tab
  // strip, draws it under the tab: at once with the picture this window kept
  // of the page, then again with a fresh one when there's reason to take it
  // (the tab you're on, or a page not pictured yet). Menus and prompts keep
  // the overlay: no card over them.
  async showHoverCard({ rect, card } = {}) {
    const tab = this.tabs.get(card?.id);
    if (!tab || !rect || (this.overlayKind && this.overlayKind !== 'hovercard')) return;
    this.cardTab = tab.id;
    const url = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() : '';
    const payload = { ...card, kind: 'hovercard', shot: this.tabs.canPreview(tab), preview: tab.preview?.src || null };
    this.showOverlay(rect, payload);
    if (!payload.shot || (tab.id !== this.tabs.activeId && tab.preview && tab.preview.url === url)) return;
    const shot = await this.tabs.capturePreview(tab);
    if (shot && shot.src !== payload.preview && !this.win.isDestroyed() && this.overlayKind === 'hovercard' && this.cardTab === tab.id) {
      this.overlay.webContents.send('overlay-data', { ...payload, preview: shot.src });
    }
  }

  // The shell's card is done: it fades out (hideOverlay). now: the pointer
  // came onto the card, which goes at once.
  hideHoverCard({ now = false } = {}) {
    if (this.overlayKind !== 'hovercard') return;
    this.cardTab = null;
    this.hideOverlay({ now, quiet: true });
  }

  // full: open the chat full size, over the page (asked from the new tab page).
  askAI(text, opts = {}) {
    this.profile.store.setSetting('panelOpen', true);
    this.emit('ai-prefill', { text, includePage: !!opts.includePage, send: !opts.draft, full: !!opts.full });
    this.win.webContents.focus();
  }

  // A recent chat picked on the new tab page, opened full size (or in the
  // side panel, from a notification or Settings).
  openChat(id, { full = true } = {}) {
    if (!this.profile.chats.get(id)) return false;
    this.profile.store.setSetting('panelOpen', true);
    this.emit('ai-open-chat', { id, full });
    this.win.webContents.focus();
    return true;
  }

  // Each tab with its back/forward pages (main/sessions.js).
  session() {
    return {
      tabs: this.tabs.sessionTabs({ history: true }),
      groups: this.tabs.groups.session(),
      active: Math.max(0, this.tabs.tabs.findIndex((t) => t.id === this.tabs.activeId)),
      bounds: this.win.isMaximized() ? this.win.getNormalBounds() : this.win.getBounds(),
      ...(this.win.isMaximized() ? { maximized: true } : {}),
    };
  }
}

module.exports = { BrowserWin };
