// Screenshot (Share › Screenshot, File › Save and Share): freezes the page,
// lets you drag over an area or take the visible part or the whole page,
// then opens a small editor (pen, highlighter, arrow, text) with Copy,
// Download and Ask Lumio. The picture is copied to the clipboard as soon as
// it's taken. The view sits over the page (renderer/ui/screenshot.html) and
// goes away when you switch tabs or press Esc.
//
// The whole page comes from Chromium's DevTools protocol
// (Page.captureScreenshot with captureBeyondViewport), up to 16,384 pixels
// tall; a longer page is cut there and the editor says so.
const fs = require('fs');
const path = require('path');
const { app, clipboard, dialog, ipcMain, nativeImage, screen, WebContentsView } = require('electron');

const SHELL_PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const MAX_SIDE = 16384; // the tallest picture Chromium makes
const MAX_PIXELS = 60_000_000;
const MAX_PNG = 80 * 1024 * 1024;

// How big a whole-page picture can be: CSS size, the scale (sharp on Retina
// screens when it fits) and whether the page was cut.
function fullPageSize(content, viewportWidth, dpr) {
  const width = Math.max(1, Math.ceil(Math.min(content.width, viewportWidth || content.width)));
  let height = Math.max(1, Math.ceil(content.height));
  let scale = Math.max(1, dpr || 1);
  while (scale > 1 && (height * scale > MAX_SIDE || width * height * scale * scale > MAX_PIXELS)) scale = Math.max(1, scale - 0.5);
  const clipped = height * scale > MAX_SIDE || width * height * scale * scale > MAX_PIXELS;
  if (clipped) height = Math.floor(Math.min(MAX_SIDE / scale, MAX_PIXELS / (width * scale * scale)));
  return { width, height, scale, clipped };
}

class Screenshots {
  // toast(w, text): a note in the window.
  constructor({ toast = () => {} } = {}) {
    this.toast = toast;
    this.sessions = new Map(); // window -> { view, tab }
  }

  sessionOf(wc) {
    for (const [w, s] of this.sessions) if (s.view.webContents === wc) return { w, s };
    return null;
  }

  async start(w) {
    const tab = w.tabs.active;
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.cancel(w, false);
    const open = w.overlayKind; // a popover over the page closes first, and the shell hears so
    w.hideOverlay();
    if (open) w.emit('overlay-picked', { kind: open });
    let img;
    try { img = await wc.capturePage(); } catch { img = null; }
    if (!img || img.isEmpty()) { this.toast(w, 'Couldn’t take a screenshot of this page'); return; }
    if (w.closed || w.tabs.active !== tab) return;
    const bounds = tab.view.getBounds();
    const view = new WebContentsView({ webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(10);
    view.setBounds(bounds);
    w.win.contentView.addChildView(view);
    const s = {
      view,
      tab,
      resize: () => setImmediate(() => this.place(w)),
      closed: () => this.cancel(w, false),
    };
    this.sessions.set(w, s);
    w.win.on('resize', s.resize);
    w.win.once('closed', s.closed);
    const size = img.getSize();
    let host = '';
    try { host = new URL(w.tabs.displayUrl(tab)).host.replace(/^www\./, ''); } catch { /* not a web page */ }
    view.webContents.once('did-finish-load', () => {
      if (this.sessions.get(w) !== s) return;
      view.webContents.send('shot-data', { png: new Uint8Array(img.toPNG()), width: size.width, height: size.height, scale: size.width / Math.max(1, bounds.width), title: tab.title || '', host });
      view.webContents.focus();
    });
    view.webContents.loadURL(`lumio://overlay/screenshot.html${w.incognito ? '?appearance=dark' : ''}`).catch(() => {});
  }

  // Keeps the view over the page when the page's room changes (the window
  // resizing, the side panel opening).
  place(w) {
    const s = this.sessions.get(w);
    if (s?.tab.view) s.view.setBounds(s.tab.view.getBounds());
  }

  // Closes the screenshot view (Esc, Done, another tab, the window closing).
  cancel(w, refocus = true) {
    const s = this.sessions.get(w);
    if (!s) return;
    this.sessions.delete(w);
    try {
      w.win.off('resize', s.resize);
      w.win.off('closed', s.closed);
      if (w.win.contentView.children.includes(s.view)) w.win.contentView.removeChildView(s.view);
      if (refocus) s.tab.view?.webContents.focus();
    } catch { /* the window is closing */ }
    if (!s.view.webContents.isDestroyed()) s.view.webContents.close();
  }

  // The whole page, as a PNG.
  async fullPage(w, tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return { error: 'The page closed.' };
    const dbg = wc.debugger;
    let mine = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); mine = true; }
      const m = await dbg.sendCommand('Page.getLayoutMetrics');
      const content = m.cssContentSize || m.contentSize;
      const viewport = (m.cssLayoutViewport || m.layoutViewport || {}).clientWidth;
      const dpr = screen.getDisplayMatching(w.win.getBounds()).scaleFactor;
      const { width, height, scale, clipped } = fullPageSize(content, viewport, dpr);
      const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width, height, scale } });
      const png = Buffer.from(data, 'base64');
      const got = nativeImage.createFromBuffer(png).getSize();
      return { png: new Uint8Array(png), width: got.width, height: got.height, scale, clipped };
    } catch {
      return { error: 'Couldn’t capture the whole page. Close Developer Tools and try again, or take the visible part.' };
    } finally {
      if (mine) { try { dbg.detach(); } catch { /* already gone */ } }
    }
  }

  async save(w, png) {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' at ').replace(/:/g, '.');
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      defaultPath: path.join(app.getPath('downloads'), `Screenshot ${stamp}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { ok: false };
    try { fs.writeFileSync(filePath, png); return { ok: true }; } catch { return { ok: false, error: 'Couldn’t save the picture.' }; }
  }

  register() {
    const from = (e) => this.sessionOf(e.sender);
    const image = (png) => (png instanceof Uint8Array && png.length && png.length < MAX_PNG ? Buffer.from(png) : null);
    ipcMain.handle('shot:full', async (e) => { const f = from(e); return f ? this.fullPage(f.w, f.s.tab) : { error: 'Not allowed' }; });
    ipcMain.handle('shot:copy', (e, png) => {
      const buf = from(e) && image(png);
      if (!buf) return false;
      clipboard.writeImage(nativeImage.createFromBuffer(buf));
      return true;
    });
    ipcMain.handle('shot:save', (e, png) => { const f = from(e); const buf = image(png); return f && buf ? this.save(f.w, buf) : { ok: false }; });
    // Ask Lumio: the picture goes to the AI panel with a question to finish.
    ipcMain.on('shot:ask', (e, png) => {
      const f = from(e);
      const buf = image(png);
      if (!f || !buf) return;
      this.cancel(f.w, false);
      f.w.emit('ai-attach', { name: 'screenshot.png', type: 'image/png', data: new Uint8Array(buf) });
      f.w.askAI('What’s in this screenshot?', { draft: true });
    });
    ipcMain.on('shot:close', (e) => { const f = from(e); if (f) this.cancel(f.w); });
  }
}

module.exports = { Screenshots, fullPageSize };
