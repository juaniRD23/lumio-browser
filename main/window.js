// One browser window: the shell page (tab strip, toolbar, bookmarks bar, AI
// panel), an overlay view for dropdowns drawn above the page, the window's
// tabs and its Lumio AI controller. Incognito windows use a throwaway
// profile (see main.js) and never write history, sessions or chats to disk.
const { BrowserWindow, WebContentsView, screen } = require('electron');
const path = require('path');
const { TabManager, NEWTAB } = require('./tabs');
const { AIController } = require('./ai/controller');
const { PageIndicator } = require('./ai/indicators');

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
  // app: services from main.js. profile: { session, downloads, permissions, chats }.
  constructor(app, profile, { incognito = false, tabs = null, active = 0, bounds = null, urls = [], adopt = null, near = null } = {}) {
    this.app = app;
    this.profile = profile;
    this.id = nextWindowId++;
    this.incognito = incognito;
    this.closedTabs = []; // incognito only; normal windows use the app-wide list
    this.closing = false;

    this.win = new BrowserWindow({
      ...(visibleBounds(bounds) || defaultBounds(near)),
      minWidth: 760,
      minHeight: 500,
      title: incognito ? 'Lumio Browser (Incognito)' : 'Lumio Browser',
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
        // Windows: our tab strip is the title bar; Windows draws its own
        // minimize / maximize / close buttons at its right end.
        : { titleBarStyle: 'hidden', titleBarOverlay: { color: incognito ? '#0d0b12' : '#080808', symbolColor: '#a8a8a8', height: 40 }, autoHideMenuBar: true }),
      backgroundColor: incognito ? '#0d0b12' : '#080808',
      show: false,
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    if (process.platform !== 'darwin') this.win.setMenuBarVisibility(false);
    this.win.loadURL('lumio://shell/');
    this.win.once('ready-to-show', () => { if (!process.env.LUMIO_HIDDEN) this.win.show(); });

    this.overlay = new WebContentsView({
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.loadURL('lumio://overlay/');

    const emit = (c, p) => this.emit(c, p);
    this.tabs = new TabManager({
      win: this.win,
      session: profile.session,
      store: app.store,
      incognito,
      emit,
      hooks: {
        askAI: (text, opts) => this.askAI(text, opts),
        isAgentRunning: () => this.ai?.isRunning(),
        stopAgent: () => this.ai?.stop(),
        onFound: (tabId, result) => { if (tabId === this.tabs.activeId) this.emit('find-result', result); },
        onActivated: (tab) => { this.hideOverlay(); this.emit('find-close'); this.indicator.raise(); app.onTabActivated(this, tab); },
        onLastTabClosed: () => this.close(),
        onTabClosed: (_m, entry) => app.onTabClosed(this, entry),
        onChanged: () => app.onSessionChanged(),
        onViewCreated: (tab) => { this.indicator.raise(); app.onViewCreated(this, tab); },
        onAdopted: (tab) => app.onViewCreated(this, tab),
        onViewDestroyed: (wc) => profile.permissions.dropFor(wc.id),
        openInNewWindow: (url, inc) => app.createWindow({ incognito: inc, urls: [url] }),
        savePage: (tab) => app.savePage(this, tab),
        contextMenuExtras: (tab, params) => app.contextMenuExtras(this, tab, params),
      },
    });
    this.indicator = new PageIndicator(this);
    this.ai = new AIController({
      store: app.store,
      chats: profile.chats,
      tabs: this.tabs,
      emit,
      helper: app.helper,
      account: app.account,
      indicator: this.indicator,
      onSettingsChanged: () => app.broadcastAIState(),
    });

    if (adopt) this.tabs.adopt(adopt);
    else if (!(tabs && this.tabs.restore(tabs, active))) {
      if (urls.length) urls.forEach((u, i) => this.tabs.create(u, { active: i === 0 }));
      else this.tabs.create(NEWTAB);
    }

    this.win.on('focus', () => app.onFocus(this));
    this.win.on('resize', () => this.tabs.layout());
    this.win.on('close', () => { this.closing = true; app.onClose(this); });
    this.win.on('closed', () => {
      this.ai.shutdown();
      this.indicator.destroy();
      app.onClosed(this);
    });
    this.win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.ai.isRunning()) { this.ai.stop(); e.preventDefault(); }
    });
  }

  get closed() { return this.win.isDestroyed(); }

  emit(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  focus() {
    this.app.onFocus(this); // don't wait for the OS focus event
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  close() { if (!this.win.isDestroyed()) this.win.close(); }

  focusOmnibox() {
    if (this.win.isDestroyed()) return; // closed before a delayed focus ran
    this.win.webContents.focus();
    this.emit('focus-omnibox');
  }

  showOverlay(rect, payload) {
    const [w, h] = this.win.getContentSize();
    const x = Math.max(0, Math.min(Math.round(rect.x), w - 40));
    const y = Math.max(0, Math.round(rect.y));
    this.overlay.setBounds({ x, y, width: Math.min(Math.round(rect.width), w - x), height: Math.min(Math.round(rect.height), h - y) });
    this.win.contentView.addChildView(this.overlay);
    this.overlayKind = payload?.kind || null;
    this.overlay.webContents.send('overlay-data', payload);
  }

  hideOverlay() {
    const kind = this.overlayKind;
    this.overlayKind = null;
    if (kind === 'passkey') this.app.onPasskeyPromptClosed?.(this);
    if (!this.win.isDestroyed() && this.win.contentView.children.includes(this.overlay)) {
      this.win.contentView.removeChildView(this.overlay);
    }
  }

  // full: open the chat full size, over the page (asked from the new tab page).
  askAI(text, opts = {}) {
    this.app.store.setSetting('panelOpen', true);
    this.emit('ai-prefill', { text, includePage: !!opts.includePage, send: !opts.draft, full: !!opts.full });
    this.win.webContents.focus();
  }

  // A recent chat picked on the new tab page, opened full size.
  openChat(id) {
    if (!this.profile.chats.get(id)) return false;
    this.app.store.setSetting('panelOpen', true);
    this.emit('ai-open-chat', { id, full: true });
    this.win.webContents.focus();
    return true;
  }

  session() {
    return { tabs: this.tabs.sessionTabs(), active: Math.max(0, this.tabs.tabs.findIndex((t) => t.id === this.tabs.activeId)), bounds: this.win.getBounds() };
  }
}

module.exports = { BrowserWin };
