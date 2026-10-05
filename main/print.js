// Print preview (File › Print…, ⌘P, the page's context menu), like Chrome's:
// a panel over the tab's page (renderer/ui/print.*) with a live preview of
// the printout and its settings. The preview is the page printed to PDF
// (webContents.printToPDF), drawn with pdf.js. "Save as PDF" writes that PDF
// where you choose; a printer gets the page from webContents.print() with
// the same settings and no second dialog. "Print using system dialog" (⌥⌘P,
// Ctrl+Shift+P) keeps the operating system's own dialog.
// The panel belongs to its tab: it hides while another tab is showing, and
// closes when the page navigates away or the tab closes.
const { WebContentsView, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const theme = require('./theme');

const PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');
const PAPER = ['Letter', 'Legal', 'Tabloid', 'A3', 'A4', 'A5'];
const PER_SHEET = [1, 2, 4, 6, 9, 16];
// Countries that use Letter paper; everywhere else starts on A4.
const LETTER = new Set(['US', 'CA', 'MX', 'CL', 'CO', 'VE', 'PH', 'CR', 'GT', 'PA', 'DO', 'PR', 'SV', 'NI', 'HN', 'BZ']);
const MINIMUM_MARGIN = 0.2; // inches, for "Minimum" in a PDF

// Chrome's header (date, title) and footer (address, page numbers).
const HEADER = '<div style="width:100%;padding:0 0.4in;font:8px system-ui,sans-serif;display:flex;justify-content:space-between;gap:24px"><span class="date"></span><span class="title" style="flex:1;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis"></span><span></span></div>';
const FOOTER = '<div style="width:100%;padding:0 0.4in;font:8px system-ui,sans-serif;display:flex;justify-content:space-between;gap:24px"><span class="url" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis"></span><span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The settings the panel sends, checked and filled in.
function cleanSettings(s = {}) {
  const ranges = Array.isArray(s.ranges)
    ? s.ranges.map((r) => [Math.round(Number(r?.[0])), Math.round(Number(r?.[1]))]).filter(([a, b]) => a >= 1 && b >= a && b < 100000).slice(0, 500)
    : null;
  return {
    destination: typeof s.destination === 'string' && s.destination ? s.destination.slice(0, 300) : 'pdf',
    ranges: ranges?.length ? ranges : null, // 1-based, inclusive; null: every page
    copies: clamp(Math.round(Number(s.copies) || 1), 1, 999),
    layout: s.layout === 'landscape' ? 'landscape' : 'portrait',
    color: s.color !== 'bw',
    paper: PAPER.includes(s.paper) ? s.paper : 'Letter',
    perSheet: PER_SHEET.includes(Number(s.perSheet)) ? Number(s.perSheet) : 1,
    margins: ['default', 'none', 'minimum'].includes(s.margins) ? s.margins : 'default',
    scale: clamp(Math.round(Number(s.scale) || 100), 10, 200),
    headers: !!s.headers && s.margins !== 'none',
    background: !!s.background,
  };
}

// webContents.printToPDF's options (pages: whether to keep only the chosen pages).
function pdfOptions(s, { pages = true } = {}) {
  const margin = s.margins === 'none' ? 0 : s.margins === 'minimum' ? MINIMUM_MARGIN : null;
  return {
    landscape: s.layout === 'landscape',
    printBackground: s.background,
    scale: s.scale / 100,
    pageSize: s.paper,
    ...(margin == null ? {} : { margins: { top: margin, bottom: margin, left: margin, right: margin } }),
    ...(s.headers ? { displayHeaderFooter: true, headerTemplate: HEADER, footerTemplate: FOOTER } : {}),
    ...(pages && s.ranges ? { pageRanges: s.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',') } : {}),
  };
}

// webContents.print's options, for a printer and no dialog.
function printOptions(s, { title = '', url = '' } = {}) {
  return {
    silent: true,
    deviceName: s.destination,
    printBackground: s.background,
    color: s.color,
    landscape: s.layout === 'landscape',
    margins: { marginType: s.margins === 'minimum' ? 'printableArea' : s.margins },
    scaleFactor: s.scale,
    pagesPerSheet: s.perSheet,
    copies: s.copies,
    collate: true,
    pageSize: s.paper,
    ...(s.headers ? { header: title, footer: url } : {}),
    ...(s.ranges ? { pageRanges: s.ranges.map(([a, b]) => ({ from: a - 1, to: b - 1 })) } : {}),
  };
}

// A file name from the page's title.
const fileName = (title) => `${String(title || 'Page').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'Page'}.pdf`;

class PrintPreview {
  // store: app-wide settings (the last choices are kept, like Chrome's).
  // downloadsDir(w): where Save as PDF starts. toast(w, text). dialog:
  // Electron's (tests pass a stand-in).
  constructor({ store, downloadsDir, toast, dialog: dialogs = dialog }) {
    Object.assign(this, { store, downloadsDir, toast, dialog: dialogs });
    this.open_ = new Map(); // window -> { view, tab, wc }
  }

  stateOf(w) { return this.open_.get(w) || null; }
  isOpen(w) { return this.open_.has(w); }

  // Opens over the window's active tab (or focuses the one already open).
  open(w, tab = w.tabs.active) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    const current = this.open_.get(w);
    if (current?.tab === tab) { current.view.webContents.focus(); return true; }
    if (current) this.close(w, { focusPage: false });
    // Chromium's PDF viewer prints the PDF itself: the system dialog does that.
    if (tab.pdf) { wc.print({}, () => {}); return true; }

    const view = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor(theme.colors(theme.isDark(w.incognito), w.incognito).page);
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(10);
    const entry = { view, tab, wc, w };
    this.open_.set(w, entry);
    // The page goes away or changes: so does its preview.
    entry.onNavigate = (details) => { if (details.isMainFrame && !details.isSameDocument) this.close(w, { focusPage: false }); };
    entry.onGone = () => this.close(w, { focusPage: false });
    wc.on('did-start-navigation', entry.onNavigate);
    wc.once('destroyed', entry.onGone);
    entry.onWindowClosed = () => this.close(w, { focusPage: false });
    w.win.once('closed', entry.onWindowClosed);

    w.win.contentView.addChildView(view);
    this.place(w);
    view.webContents.loadURL(`lumio://print/${w.incognito ? '?appearance=dark' : ''}`).catch(() => {});
    view.webContents.once('did-finish-load', () => { if (this.open_.get(w) === entry) view.webContents.focus(); });
    return true;
  }

  close(w, { focusPage = true } = {}) {
    const entry = this.open_.get(w);
    if (!entry) return;
    this.open_.delete(w);
    if (!entry.wc.isDestroyed()) {
      entry.wc.off('did-start-navigation', entry.onNavigate);
      entry.wc.off('destroyed', entry.onGone);
    }
    if (!w.win.isDestroyed()) {
      w.win.off('closed', entry.onWindowClosed);
      if (w.win.contentView.children.includes(entry.view)) w.win.contentView.removeChildView(entry.view);
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    if (focusPage && !entry.wc.isDestroyed()) entry.wc.focus();
  }

  // Over the page area (the shell reports it as the window resizes, and as
  // the sidebar or the AI panel open and close).
  place(w) {
    const entry = this.open_.get(w);
    if (!entry || w.win.isDestroyed()) return;
    entry.view.setBounds(w.tabs.slot);
  }

  // Another tab came to the front: the panel shows only over its own tab.
  tabActivated(w, tab) {
    const entry = this.open_.get(w);
    if (!entry) return;
    const mine = tab === entry.tab;
    entry.view.setVisible(mine);
    if (mine) {
      w.win.contentView.addChildView(entry.view); // back above the page
      this.place(w);
    }
  }

  // ---- what the panel asks for
  entryOf(sender) {
    for (const entry of this.open_.values()) if (entry.view.webContents === sender) return entry;
    return null;
  }

  init(entry) {
    const country = (() => { try { return app.getLocaleCountryCode(); } catch { return ''; } })();
    const saved = this.store.settings.printSettings || {};
    return {
      title: entry.wc.getTitle() || entry.tab.title || '',
      url: entry.wc.getURL(),
      platform: process.platform,
      settings: { paper: LETTER.has(country) ? 'Letter' : 'A4', ...saved },
    };
  }

  async printers(entry) {
    const list = await entry.wc.getPrintersAsync().catch(() => []);
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, description: p.description || '', isDefault: !!(p.isDefault || p.options?.isDefault === 'true' || p.options?.['printer-is-default'] === 'true') }));
  }

  // The whole printout (the panel shows only the chosen pages of it).
  async preview(entry, settings) {
    try {
      const pdf = await entry.wc.printToPDF(pdfOptions(cleanSettings(settings), { pages: false }));
      return { ok: true, pdf: new Uint8Array(pdf) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  remember(s) {
    const { destination, layout, color, paper, margins, scale, headers, background, perSheet } = s;
    this.store.setSetting('printSettings', { destination, layout, color: color ? 'color' : 'bw', paper, margins, scale, headers, background, perSheet });
  }

  async savePdf(entry, settings) {
    const s = cleanSettings(settings);
    let data;
    try { data = await entry.wc.printToPDF(pdfOptions(s)); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    const { canceled, filePath } = await this.dialog.showSaveDialog(entry.w.win, {
      defaultPath: path.join(this.downloadsDir(entry.w), fileName(entry.wc.getTitle())),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try { await fs.promises.writeFile(filePath, data); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    this.remember({ ...s, destination: 'pdf' });
    const { w } = entry;
    this.close(w);
    this.toast(w, 'Saved as PDF');
    return { ok: true, file: filePath };
  }

  print(entry, settings) {
    const s = cleanSettings(settings);
    if (s.destination === 'pdf') return { ok: false, error: 'Choose a printer.' };
    const { w, wc } = entry;
    const opts = printOptions(s, { title: wc.getTitle(), url: wc.getURL() });
    this.remember(s);
    this.close(w);
    wc.print(opts, (ok, reason) => {
      if (!ok && reason !== 'cancelled' && !w.closed) this.toast(w, 'Couldn’t print. Check the printer and try again.');
    });
    return { ok: true };
  }

  // The operating system's own print dialog, for this tab.
  systemDialog(w, tab = w.tabs.active) {
    const entry = this.open_.get(w);
    const wc = entry?.wc || tab?.view?.webContents;
    if (entry) this.close(w, { focusPage: false });
    if (wc && !wc.isDestroyed()) wc.print({}, () => {});
  }

  register(ipcMain) {
    const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
      const entry = this.entryOf(e.sender);
      if (!entry) throw new Error('Not allowed');
      return fn(entry, ...args);
    });
    handle('print:init', (entry) => this.init(entry));
    handle('print:printers', (entry) => this.printers(entry));
    handle('print:preview', (entry, settings) => this.preview(entry, settings));
    handle('print:save-pdf', (entry, settings) => this.savePdf(entry, settings));
    handle('print:print', (entry, settings) => this.print(entry, settings));
    ipcMain.on('print:close', (e) => { const entry = this.entryOf(e.sender); if (entry) this.close(entry.w); });
    ipcMain.on('print:system', (e) => { const entry = this.entryOf(e.sender); if (entry) this.systemDialog(entry.w); });
  }
}

module.exports = { PrintPreview, cleanSettings, pdfOptions, printOptions, fileName, PAPER, PER_SHEET };
