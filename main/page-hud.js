// Small views over the page, under any dropdown: the status bubble at the
// bottom-left corner (the address of the link under the pointer, as in
// Chrome) and the arrow that follows a two-finger swipe back or forward.
// A page's view covers the window's own HTML, so these are views of their
// own, each just big enough for what it shows (renderer/ui/hud.*).
const { WebContentsView, screen } = require('electron');
const path = require('path');

// Bundled by scripts/build-preload.mjs.
const PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const SWIPE_SIZE = 72;
const AVOID = 16; // the pointer this close to the bubble moves it to the other corner

class PageHud {
  constructor(w) {
    this.w = w; // BrowserWin
    this.views = {}; // kind -> WebContentsView, made when first needed
    this.waiting = {}; // kind -> the last message for a view whose page is still loading
    this.sizes = {}; // kind -> { width, height } its page asked for (swipe: { dir })
    this.url = '';
    this.side = 'left';
    this.mouseWc = null;
    this.onMouse = (_e, m) => this.avoid(m);
  }

  view(kind) {
    const old = this.views[kind];
    if (old && !old.webContents.isDestroyed()) return old;
    const v = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    v.setBackgroundColor('#00000000');
    v.setVisible(false);
    // Incognito windows are always dark (see main/protocol.js).
    v.webContents.loadURL(`lumio://overlay/hud.html?kind=${kind}${this.w.incognito ? '&appearance=dark' : ''}`);
    v.webContents.once('did-finish-load', () => {
      const msg = this.waiting[kind];
      delete this.waiting[kind];
      if (msg) v.webContents.send('hud', msg);
    });
    this.waiting[kind] = null;
    this.views[kind] = v;
    return v;
  }

  // Messages sent before the view's page is ready wait for it (only the last one matters).
  send(kind, msg) {
    const v = this.view(kind);
    if (kind in this.waiting) this.waiting[kind] = { ...(this.waiting[kind] || {}), ...msg };
    else v.webContents.send('hud', msg);
  }

  kindOf(wc) { return Object.keys(this.views).find((k) => this.views[k].webContents === wc) || null; }
  owns(wc) { return !!this.kindOf(wc); }

  // Where the page is: the active tab's view (full size in HTML full screen).
  page() {
    const tab = this.w.tabs.active;
    if (this.w.closed || !tab?.view || this.w.tabs.covered) return null;
    return tab.view.getBounds();
  }

  // Shows a view above the page and below a dropdown, if one is open.
  put(v, bounds) {
    const parent = this.w.win.contentView;
    const kids = parent.children;
    const page = this.w.tabs.active?.view;
    if (!kids.includes(v) || (page && kids.indexOf(v) < kids.indexOf(page))) {
      // Adding a view it already has would put it on top, over a dropdown.
      if (kids.includes(v)) parent.removeChildView(v);
      const overlay = parent.children.indexOf(this.w.overlay);
      if (overlay >= 0) parent.addChildView(v, overlay); else parent.addChildView(v);
    }
    v.setBounds(bounds);
    v.setVisible(true);
  }

  // ---------------------------------------------------------------- status bubble
  // url: the link under the pointer ('' when it leaves). now: hide at once (another tab).
  status(url, tab, { now = false } = {}) {
    url = String(url || '');
    if (!url && !this.views.status) return;
    const page = this.page();
    if (url && !page) return;
    if (url && !this.url) this.side = 'left';
    this.url = url;
    this.watchMouse(url ? tab : null);
    const width = page?.width || 0;
    this.send('status', {
      url,
      now,
      side: this.side,
      // Chrome's bubble takes up to a third of the page, and all of it after a moment.
      maxWidth: Math.max(220, Math.round(width / 3)),
      expandedWidth: Math.max(220, width - 24),
    });
  }

  // The pointer near the bubble: move it to the other bottom corner. (A view
  // under the pointer would take it off the link, and the bubble would blink.)
  // Returns whether it moved.
  avoid(m) {
    const size = this.sizes.status;
    const page = this.page();
    if (m?.type !== 'mouseMove' || !size || !page) return false;
    const near = m.x <= size.width + AVOID && m.y >= page.height - size.height - AVOID;
    const side = near ? 'right' : 'left';
    if (side === this.side) return false;
    this.side = side;
    this.send('status', { side });
    this.place();
    return true;
  }

  // Where the pointer is on the page now (it may not have moved since the link showed).
  pointer() {
    const page = this.page();
    if (!page) return null;
    const at = screen.getCursorScreenPoint();
    const content = this.w.win.getContentBounds();
    return { type: 'mouseMove', x: at.x - content.x - page.x, y: at.y - content.y - page.y };
  }

  watchMouse(tab) {
    const wc = tab?.view?.webContents || null;
    if (wc === this.mouseWc) return;
    if (this.mouseWc && !this.mouseWc.isDestroyed()) this.mouseWc.removeListener('before-mouse-event', this.onMouse);
    this.mouseWc = wc;
    if (wc) wc.on('before-mouse-event', this.onMouse);
  }

  // ---------------------------------------------------------------- swipe arrow
  // state: { dir: 'back' | 'forward', progress: 0…1 }, or null when the swipe ends (done: it went).
  swipe(state, done = false) {
    if (!state) {
      if (this.views.swipe) this.send('swipe', { swipe: null, done });
      return;
    }
    if (!this.page()) return;
    this.view('swipe');
    this.sizes.swipe = { dir: state.dir };
    this.place();
    this.send('swipe', { swipe: state });
  }

  // ---------------------------------------------------------------- layout
  // A view's page reports its size; 0 means it finished hiding.
  onSize(wc, { width, height } = {}) {
    const kind = this.kindOf(wc);
    if (!kind) return;
    const v = this.views[kind];
    if (!(width > 0 && height > 0)) {
      delete this.sizes[kind];
      v.setVisible(false);
      return;
    }
    if (kind === 'status') {
      this.sizes.status = { width: Math.min(Math.ceil(width), 4000), height: Math.min(Math.ceil(height), 80) };
      if (this.avoid(this.pointer())) return;
    }
    this.place();
  }

  place() {
    const page = this.page();
    const status = this.views.status;
    const size = this.sizes.status;
    if (status && size && page) {
      const width = Math.min(size.width, page.width);
      this.put(status, {
        x: this.side === 'left' ? page.x : page.x + page.width - width,
        y: page.y + page.height - size.height,
        width,
        height: size.height,
      });
    }
    const swipe = this.views.swipe;
    const dir = this.sizes.swipe?.dir;
    if (swipe && dir && page) {
      this.put(swipe, {
        x: dir === 'back' ? page.x : page.x + page.width - SWIPE_SIZE,
        y: Math.round(page.y + page.height / 2 - SWIPE_SIZE / 2),
        width: SWIPE_SIZE,
        height: SWIPE_SIZE,
      });
    }
  }

  destroy() {
    this.watchMouse(null);
    for (const v of Object.values(this.views)) if (!v.webContents.isDestroyed()) v.webContents.close();
    this.views = {};
  }
}

module.exports = { PageHud, SWIPE_SIZE };
