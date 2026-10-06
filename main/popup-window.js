// A pop-up a page opened with window.open() and a size, to sign in or pay:
// a small window of its own, like Chrome's. Its bar shows where the pop-up
// really is, which the page can't change: the lock or "Not secure" and the
// address (the page's title is the window's). "Open in tab" moves it into
// the browser window. Its page is wired like a tab's (TabManager, with one
// tab), so right-click, permission prompts, passwords, downloads, the page's
// dialogs and the pop-up blocker work as they do in a tab. It keeps
// window.opener, so the page that opened it hears back (postMessage), and it
// closes when its page calls window.close().
const { BrowserWindow, WebContentsView, screen } = require('electron');
const path = require('path');
const { TabManager } = require('./tabs');
const { BrowserWin } = require('./window');
const { DialogView } = require('./dialog-view');
const { AccessNotice } = require('./access-notice');
const theme = require('./theme');

const PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const BAR = 40; // the bar above the page (renderer/ui/popup.css)
const MIN = { width: 260, height: 180 };
const DEFAULT = { width: 520, height: 680 };

// Anything the pop-up opens besides its own page (a link in a new tab, a
// search from the right-click menu) goes to the browser window.
class PopupTabs extends TabManager {
  create(url, opts = {}) {
    if (this.tabs.length) return this.popup.openInBrowser(url);
    return super.create(url, opts);
  }

  // "Back to safety" with nowhere to go back to closes the pop-up.
  safeFallback() { this.popup.close(); }
}

// Where the pop-up goes: the size the page asked for (its page, plus the
// bar), at the place it asked for, kept on the screen the browser window is
// on. near: the browser window's bounds; area: that screen's work area.
function popupBounds(features, near, area) {
  const f = {};
  for (const part of String(features || '').split(/[,\s]+/)) {
    const [key, value] = part.split('=');
    if (key && value !== undefined) f[key.trim().toLowerCase()] = parseInt(value, 10);
  }
  const pick = (...keys) => keys.map((k) => f[k]).find((v) => Number.isFinite(v));
  const width = Math.min(Math.max(pick('width', 'innerwidth') || DEFAULT.width, MIN.width), area.width);
  const height = Math.min(Math.max((pick('height', 'innerheight') || DEFAULT.height) + BAR, MIN.height), area.height);
  const left = pick('left', 'screenx');
  const top = pick('top', 'screeny');
  const x = left ?? (near ? near.x + Math.round((near.width - width) / 2) : area.x + Math.round((area.width - width) / 2));
  const y = top ?? (near ? near.y + Math.round((near.height - height) / 3) : area.y + Math.round((area.height - height) / 3));
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

class PopupWin {
  // app: services from main.js. profile: the opener's ({ session, downloads,
  // permissions }). opener: the window it came from (a browser window, or
  // another pop-up). webContents: the page Chromium made for window.open().
  constructor(app, profile, { incognito = false, opener = null, webContents = null, url, features = '' }) {
    this.app = app;
    this.profile = profile;
    this.incognito = incognito;
    this.home = opener?.home || opener; // the browser window it belongs to
    this.indicator = { bar: null, place() {}, raise() {} }; // no Lumio AI here

    const near = opener && !opener.closed ? opener.win.getBounds() : null;
    const area = (near ? screen.getDisplayMatching(near) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
    const colors = theme.colors(theme.isDark(incognito), incognito);
    this.win = new BrowserWindow({
      ...popupBounds(features, near, area),
      useContentSize: true,
      minWidth: MIN.width,
      minHeight: MIN.height,
      title: 'Lumio Browser',
      backgroundColor: colors.frame,
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    if (process.platform !== 'darwin') this.win.setMenuBarVisibility(false);
    const query = incognito ? '?appearance=dark' : '';
    this.win.loadURL('lumio://popup/' + query);
    this.win.once('ready-to-show', () => {
      if (!process.env.LUMIO_HIDDEN) this.win.show();
      this.tabs.wc()?.focus();
    });

    this.overlay = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.loadURL('lumio://overlay/' + query);

    this.tabs = new PopupTabs({
      win: this.win,
      session: profile.session,
      store: profile.store, // the profile's (bookmarks, history, zoom and search settings)
      incognito,
      radius: 0,
      emit: (c, p) => this.emit(c, p),
      hooks: {
        onActivated: () => this.dialogs.sync(),
        onDialogs: () => this.dialogs.sync(),
        onLayout: () => { this.dialogs.place(); this.notice.place(); },
        onFullscreen: (tab, on) => this.notice.fullscreen(tab, on),
        onChanged: () => { if (!this.win.isDestroyed()) this.win.setTitle(this.tabs.active?.title || 'Lumio Browser'); },
        focusWindow: () => this.focus(),
        onLastTabClosed: () => this.close(),
        onViewDestroyed: (wc) => profile.permissions.dropFor(wc.id),
        openInNewWindow: (u, inc) => app.createWindow({ incognito: inc, urls: [u] }),
        openPopup: (tab, opts) => app.openPopup(this, tab, opts),
        openExternal: (tab, req) => app.openExternal(this, tab, req),
        dialogInProcess: (wc) => app.dialogInProcess(wc),
        popupsAllowed: (pageUrl) => profile.permissions.allowsPopups(pageUrl),
        saveAs: (wc, u) => profile.downloads.saveAs(wc, u),
        savePage: (tab) => app.savePage(this, tab),
      },
    });
    this.tabs.popup = this;
    this.dialogs = new DialogView(this); // the page's dialogs, over it
    this.notice = new AccessNotice(this); // "Press Esc to exit full screen"
    const [w, h] = this.win.getContentSize();
    this.tabs.setSlot({ x: 0, y: BAR, width: w, height: h - BAR }); // until the bar measures itself
    const tab = this.tabs.create(url, { webContents });
    tab.navigatingTo = url; // its first page may ask to sign in (main/page-dialogs.js)

    this.win.on('resize', () => this.tabs.layout());
    this.win.on('close', (e) => {
      const approved = this.closeApproved;
      this.closeApproved = false;
      if (approved) return;
      // Closing it may cancel downloads (the last Incognito window, or the
      // last window where that quits): ask first (confirmClose).
      if (app.downloadsAtRisk(this)) { e.preventDefault(); app.quitCancelled?.(); this.confirmClose(); return; }
      // A page you've used may ask "Leave site?" first.
      const t = this.tabs.active;
      if (t && this.tabs.anyMayAsk()) { e.preventDefault(); app.quitCancelled?.(); this.tabs.close(t.id); }
    });
    this.win.on('closed', () => {
      for (const t of this.tabs.tabs) {
        this.tabs.dismiss(t);
        // The page goes with its window, so the page that opened it sees it closed.
        const wc = t.view?.webContents;
        if (wc && !wc.isDestroyed()) wc.close();
      }
      this.notice.destroy();
      this.dialogs.destroy();
      if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.close();
      app.onPopupClosed(this);
    });
  }

  get closed() { return this.win.isDestroyed(); }

  emit(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  close() { if (!this.win.isDestroyed()) this.win.close(); }

  // Closes it once you agree to cancel the downloads that would end with it,
  // and its page agrees to leave.
  async confirmClose() {
    if (this.confirming) return;
    this.confirming = true;
    try {
      if (await this.app.confirmDownloads(this) && await this.tabs.confirmLeaveAll()) {
        this.closeApproved = true;
        this.close();
      }
    } finally {
      this.confirming = false;
    }
  }

  // A link it opens in a new tab: in the browser window.
  openInBrowser(url) { return this.app.openFromPopup(this, url); }

  // "Open in tab": the same page (still signed in, still linked to the page
  // that opened it) becomes a tab in the browser window, and the pop-up goes.
  openInTab() {
    const tab = this.tabs.active;
    if (!tab?.view) return;
    this.profile.permissions.dropFor(tab.view.webContents.id); // its prompt was in this window
    this.tabs.detach(tab.id);
    this.app.adoptFromPopup(this, tab);
    this.close();
  }
}

// Dropdowns (site information, passwords, blocked pop-ups) work as in a browser window.
PopupWin.prototype.showOverlay = BrowserWin.prototype.showOverlay;
PopupWin.prototype.hideOverlay = BrowserWin.prototype.hideOverlay;

module.exports = { PopupWin, popupBounds, BAR };
