// "Press Esc to exit full screen" and "Press Esc to show your cursor": when a
// page takes the whole screen or hides the pointer (pointer lock), Chrome says
// so for a few seconds, so a page can't pose as your desktop, another app or
// the browser without you knowing the way out. Electron draws nothing, so
// Lumio does: a small view of its own (renderer/ui/notice.html) at the top
// center of the page, above it, that fades away by itself. Being our view,
// the page can't hide it or draw over it.
// Esc itself is Chromium's: it leaves full screen and frees the pointer before
// the page sees the key. Pages may not lock the keyboard (main/features.js
// refuses keyboardLock), so Esc always works.
const { WebContentsView } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const SHOW_MS = 4000; // then it fades out (renderer/ui/notice.css) and goes
const FADE_MS = 400;
// A page that locks the pointer again soon after (a game closing its menu)
// isn't told again, like Chrome's silent re-lock.
const POINTER_AGAIN_MS = 30_000;
const TOP = 8; // from the top of the page
// Room around the bubble for its shadow, which must end inside the view or
// its edge shows as a gray box on a light page. notice.css puts the bubble
// PAD.top down and gives it --shadow-lift (20px of blur, 6px down).
const PAD = { x: 24, top: 16, bottom: 30 };

// The words: the site that went full screen, and what Esc does.
function noticeText({ host = '', fullscreen = false, pointer = false } = {}) {
  const action = fullscreen && pointer ? 'exit full screen and show your cursor' : fullscreen ? 'exit full screen' : 'show your cursor';
  return { title: fullscreen && host ? `${host} is now full screen` : '', action };
}

// The site's name as the address bar has it (punycode for look-alike names);
// none for files and Lumio's own pages.
function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.host : '';
  } catch { return ''; }
}

class AccessNotice {
  constructor(w) {
    this.w = w; // BrowserWin or PopupWin
    this.view = null;
    this.ready = false;
    this.data = null; // what's on screen: { tabId, fullscreen, pointer, title, action }
    this.size = { width: 420, height: 40 }; // the bubble's, until it measures itself
    this.timer = null;
  }

  attached() { return !!this.view && !this.w.closed && this.w.win.contentView.children.includes(this.view); }

  // A page went full screen (on), or left it.
  fullscreen(tab, on) {
    if (on) this.show(tab, { fullscreen: true, pointer: false });
    else if (this.data?.fullscreen) this.hide();
  }

  // A page locked the pointer (it may: main/features.js grants pointerLock).
  pointerLock(tab) {
    const page = tab.view?.webContents.getURL() || '';
    const last = tab.pointerNotice;
    if (last && last.page === page && Date.now() - last.at < POINTER_AGAIN_MS) return;
    tab.pointerNotice = { page, at: Date.now() };
    this.show(tab, { fullscreen: this.w.tabs.fullscreenTab === tab.id, pointer: true });
  }

  show(tab, { fullscreen, pointer }) {
    const { w } = this;
    if (w.closed || !tab?.view || tab !== w.tabs.active) return; // only over the page you're looking at
    this.data = { tabId: tab.id, fullscreen, pointer, ...noticeText({ host: hostOf(w.tabs.displayUrl(tab)), fullscreen, pointer }) };
    const view = this.ensure();
    w.win.contentView.addChildView(view); // on top of everything
    this.place();
    this.send();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), SHOW_MS + FADE_MS);
  }

  ensure() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor('#00000000');
    this.view = view;
    this.ready = false;
    view.webContents.once('did-finish-load', () => { this.ready = true; this.send(); });
    // A click on the bubble mustn't take the keyboard from the page (Esc has
    // to reach it), or from a dialog the page is waiting on.
    view.webContents.on('focus', () => {
      const dialog = this.w.dialogs?.shown && this.w.dialogs.view;
      (dialog ? dialog.webContents : this.w.tabs.wc())?.focus();
    });
    view.webContents.loadURL('lumio://notice/' + (this.w.incognito ? '?appearance=dark' : ''));
    return view;
  }

  send() {
    if (!this.ready || !this.view || this.view.webContents.isDestroyed()) return;
    const d = this.data;
    this.view.webContents.send('notice-data', d ? { title: d.title, action: d.action } : null);
  }

  // The bubble measured itself (renderer/ui/notice.js).
  resize({ width, height } = {}) {
    if (!(width > 0 && height > 0)) return;
    this.size = { width: Math.min(900, Math.ceil(width)), height: Math.min(120, Math.ceil(height)) };
    this.place();
  }

  // Top center of the page (the whole window, in full screen).
  place() {
    const tab = this.w.tabs.active;
    if (!this.attached() || !tab?.view) return;
    const b = tab.view.getBounds();
    const width = Math.min(this.size.width + PAD.x * 2, b.width);
    const height = Math.min(this.size.height + PAD.top + PAD.bottom, b.height);
    this.view.setBounds({ x: Math.round(b.x + (b.width - width) / 2), y: b.y + TOP, width, height });
  }

  hide() {
    clearTimeout(this.timer);
    this.timer = null;
    this.data = null;
    if (!this.attached()) return;
    this.send(); // clears it, so it can't flash old words when shown again
    this.w.win.contentView.removeChildView(this.view);
  }

  destroy() {
    clearTimeout(this.timer);
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }
}

module.exports = { AccessNotice, noticeText, SHOW_MS, POINTER_AGAIN_MS, PAD };
