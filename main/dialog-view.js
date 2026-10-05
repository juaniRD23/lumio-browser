// The dialogs a page raises in its tab ("Leave site?", alert/confirm/prompt,
// HTTP sign-in, "Page unresponsive") are drawn by one view per window
// (renderer/ui/dialog.html): a card at the top center of the page area, like
// Chrome's. Native views cover the shell's HTML, so it's a view of its own,
// above the page and below the browser's dropdowns. It covers the whole page
// area, so the page can't be used until you answer, and being our own view,
// neither the page nor Lumio AI working in it can see or press it.
// Each tab keeps its own queue (TabManager.ask); the view shows the first
// dialog of the tab you're on, so switching tabs hides it and coming back
// shows it again.
const { WebContentsView } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');

class DialogView {
  constructor(w) {
    this.w = w; // BrowserWin
    this.view = null;
    this.ready = false;
    this.shown = null; // the dialog on screen
  }

  attached() { return !!this.view && !this.w.closed && this.w.win.contentView.children.includes(this.view); }

  ensure() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor('#00000000');
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(10); // the page's corners
    this.view = view;
    this.ready = false;
    view.webContents.once('did-finish-load', () => { this.ready = true; this.send(); });
    // If it ever crashes, the next dialog makes a new one.
    view.webContents.once('render-process-gone', () => {
      this.hide();
      if (this.view === view) this.view = null;
      setImmediate(() => this.sync());
    });
    view.webContents.loadURL('lumio://dialog/' + (this.w.incognito ? '?appearance=dark' : ''));
    return view;
  }

  // Shows the active tab's first dialog, or hides the view.
  sync() {
    const { w } = this;
    if (w.closed) return;
    const tab = w.tabs.active;
    const dialog = tab?.view && !w.tabs.covered ? tab.dialogs?.[0] || null : null;
    if (!dialog) { this.hide(); return; }
    const view = this.ensure();
    const kids = w.win.contentView.children;
    if (kids.indexOf(view) < kids.indexOf(tab.view)) {
      w.win.contentView.addChildView(view);
      // The Stop bar and an open dropdown stay on top.
      for (const top of [w.indicator.bar, w.overlayKind ? w.overlay : null]) {
        if (top && w.win.contentView.children.includes(top)) w.win.contentView.addChildView(top);
      }
    }
    this.place();
    if (this.shown !== dialog) {
      this.shown = dialog;
      this.send();
      view.webContents.focus();
    }
  }

  send() {
    if (!this.ready || !this.view || this.view.webContents.isDestroyed()) return;
    const d = this.shown;
    this.view.webContents.send('dialog-data', d ? { id: d.id, ...d.spec } : null);
  }

  // Over the whole page area (the window, for a full-screen video).
  place() {
    const tab = this.w.tabs.active;
    if (!this.attached() || !tab?.view) return;
    this.view.setBounds(tab.view.getBounds());
  }

  hide() {
    this.shown = null;
    if (!this.attached()) return;
    this.send(); // clears the card, so it can't flash old text when shown again
    const focused = this.view.webContents.isFocused();
    this.w.win.contentView.removeChildView(this.view);
    if (focused) this.w.tabs.wc()?.focus(); // back to the page, not nowhere
  }

  // The person answered the dialog on screen.
  answer({ id, button, values, checked } = {}) {
    const tab = this.w.tabs.active;
    if (tab && this.shown && this.shown.id === id) this.w.tabs.answer(tab, id, { button, values, checked });
  }

  destroy() {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }
}

module.exports = { DialogView };
