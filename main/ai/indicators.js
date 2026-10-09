// What a window shows while Lumio works in the browser: every page it touches
// gets a soft blue glow (injected, click-through), and a Stop bar floats over
// the bottom of the page area. The bar is our own view, not part of the page,
// so a website can't see or press it.
const { WebContentsView } = require('electron');
const path = require('path');
const scripts = require('./tools/page-scripts');
const { inPage } = require('./tools/browser');

const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'dist', 'shell.js');
const MARGIN = 16; // room around the pill for its shadow

class PageIndicator {
  constructor(win) {
    this.w = win; // BrowserWin
    this.active = false;
    this.pages = new Map(); // webContents -> dom-ready listener (re-adds the glow after navigation)
    this.bar = null;
    this.barSize = { width: 250, height: 40 };
  }

  // Lumio is acting on this page: make it glow and show the Stop bar.
  touch(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (!this.active) { this.active = true; this.showBar(); }
    if (!this.pages.has(wc)) {
      const again = () => this.paint(wc);
      wc.on('dom-ready', again);
      this.pages.set(wc, again);
    }
    this.paint(wc);
  }

  paint(wc, opts = {}) {
    if (!this.active || wc.isDestroyed()) return Promise.resolve();
    return inPage(wc, scripts.aura, opts).catch(() => {});
  }

  // Lumio is working on this page right now (it read or acted on it in this task).
  working(wc) {
    return this.active && !!wc && this.pages.has(wc);
  }

  // Hide the glow for Lumio's own screenshot of the tab, then bring it back.
  capture(wc, hidden) {
    return this.pages.has(wc) ? this.paint(wc, { hidden }) : Promise.resolve();
  }

  label(text) {
    if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.send('aura', { label: String(text || '').slice(0, 80) });
  }

  end() {
    this.active = false;
    for (const [wc, again] of this.pages) {
      if (wc.isDestroyed()) continue;
      wc.removeListener('dom-ready', again);
      inPage(wc, scripts.aura, { remove: true }).catch(() => {});
    }
    this.pages.clear();
    this.hideBar();
  }

  // ---------------------------------------------------------------- Stop bar
  showBar() {
    if (this.w.closed) return;
    if (!this.bar || this.bar.webContents.isDestroyed()) {
      this.bar = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      this.bar.setBackgroundColor('#00000000');
      this.bar.webContents.loadURL('lumio://aura/?mode=bar');
    } else {
      this.bar.webContents.send('aura', { reset: true, label: '' });
    }
    this.w.win.contentView.addChildView(this.bar);
    this.place();
  }

  hideBar() {
    if (!this.bar || this.w.closed) return;
    if (this.w.win.contentView.children.includes(this.bar)) this.w.win.contentView.removeChildView(this.bar);
  }

  // Keeps the bar above the page (new or re-activated tabs are added on top).
  raise() {
    if (this.active && this.bar && !this.w.closed && this.w.win.contentView.children.includes(this.bar)) {
      this.w.win.contentView.addChildView(this.bar);
      // Dropdowns stay on top (one still being drawn goes on when it's ready).
      if (this.w.win.contentView.children.includes(this.w.overlay)) this.w.win.contentView.addChildView(this.w.overlay);
    }
  }

  resize({ width, height } = {}) {
    if (!(width > 0 && height > 0)) return;
    this.barSize = { width: Math.min(600, Math.ceil(width)), height: Math.min(80, Math.ceil(height)) };
    this.place();
  }

  // Bottom center of the page area.
  place() {
    if (!this.bar || this.w.closed) return;
    const slot = this.w.tabs.slot;
    const width = Math.min(this.barSize.width + MARGIN * 2, Math.max(0, slot.width));
    const height = this.barSize.height + MARGIN * 2;
    this.bar.setBounds({
      x: Math.round(slot.x + (slot.width - width) / 2),
      y: Math.round(slot.y + slot.height - height - 4),
      width: Math.round(width),
      height,
    });
  }

  destroy() {
    this.end();
    if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.close();
    this.bar = null;
  }
}

// Lumio AI is at work on this tab's page: it read or acted on it in the task
// running in its window (w), a helper AI has the tab, or such a page opened
// it (a tab, pop-up or window: main/tabs.js passes this on). Returns what
// says whether that AI is still at work, or null. While it is, the page
// can't open other apps (main.js openExternalLink).
function aiAtWork(w, tab) {
  if (tab.aiOpener?.()) return tab.aiOpener;
  if (!w?.ai?.isRunning() || !(tab.agent || w.indicator?.working?.(tab.view?.webContents))) return null;
  return () => !w.closed && !!w.ai?.isRunning();
}

module.exports = { PageIndicator, aiAtWork };
