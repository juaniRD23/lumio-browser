// The side panel's main-process side, wired up by main.js. The right column
// of the window holds Lumio AI and, through a switcher at its top, Chrome's
// side panel views: Reading list, Bookmarks and History (drawn by
// renderer/ui/side-panel.js; Reading mode is the page-tools batch's). This
// answers what each view shows, opens what's picked in it, and keeps the
// reading list (main/reading-list.js).
const { JsonFile } = require('./store');
const { ReadingList } = require('./reading-list');

const VIEWS = new Set(['ai', 'reading', 'bookmarks', 'history', 'reader']);
const DISPOSITIONS = new Set(['current', 'tab', 'background', 'window', 'incognito']);
const HISTORY_ROWS = 150;
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

class SidePanel {
  // bookmarks: main/bookmarks-service.js (its tree() feeds the Bookmarks view).
  constructor({ dir, store, bookmarks, windows, openUrl }) {
    this.store = store;
    this.bookmarks = bookmarks;
    this.windows = windows;
    this.openUrl = openUrl;
    this.reading = new ReadingList(new JsonFile(dir, 'reading-list.json', { items: [] }));
    this.reading.onChange(() => this.changed('reading'));
  }

  // A view's data changed: windows showing it fetch it again.
  changed(view) {
    clearTimeout(this.timers?.[view]);
    (this.timers ||= {})[view] = setTimeout(() => {
      for (const w of this.windows()) w.emit('side-changed', { view, unread: this.reading.unread() });
    }, 30);
  }

  // Opens the panel on a view (the bookmarks bar's "All bookmarks", the menu).
  show(w, view) { if (w && VIEWS.has(view)) w.emit('side-panel', { view }); }

  data(w, view, query = '') {
    if (view === 'reading') return { items: this.reading.list(), unread: this.reading.unread(), canAdd: !w.incognito };
    if (view === 'bookmarks') return { roots: this.bookmarks.tree() };
    if (view === 'history') {
      // Incognito windows don't show what was visited in normal ones.
      if (w.incognito) return { items: [], incognito: true };
      const q = String(query || '').trim().toLowerCase().slice(0, 200);
      const h = this.store.history();
      const out = [];
      const icons = new Map();
      for (let i = h.length - 1; i >= 0 && out.length < HISTORY_ROWS; i--) {
        const e = h[i];
        if (e.favicon && !icons.has(originOf(e.url))) icons.set(originOf(e.url), e.favicon);
        if (q && !`${e.title || ''} ${e.url}`.toLowerCase().includes(q)) continue;
        out.push({ url: e.url, title: e.title || e.url, time: e.time, favicon: e.favicon || null });
      }
      for (const r of out) r.favicon ||= icons.get(originOf(r.url)) || null;
      return { items: out };
    }
    return null;
  }

  // ---- the reading list
  // Adds a page and says so. From the tab menu, a page's or link's menu, the
  // star's bubble or the panel's "Add current tab".
  add(w, url, title, favicon) {
    if (!w || w.incognito) return false;
    const had = this.reading.byUrl(url);
    const item = this.reading.add(url, title, favicon);
    if (!item) { w.emit('toast', { text: 'Only web pages can go on the reading list' }); return false; }
    w.emit('toast', { text: had ? 'Already on your reading list' : 'Added to reading list' });
    return true;
  }
  addTab(w, tab) {
    if (!tab) return false;
    return this.add(w, w.tabs.displayUrl(tab), tab.title, tab.favicon);
  }
  menuItem(w, tab) {
    const url = tab ? w.tabs.displayUrl(tab) : '';
    if (w.incognito || !/^https?:/.test(url)) return [];
    return [{ label: 'Add Tab to Reading List', click: () => this.addTab(w, tab) }];
  }

  register({ on, handle }) {
    handle('side:data', (w, view, query) => (VIEWS.has(view) ? this.data(w, view, query) : null));
    on('side:set', (_w, { view } = {}) => { if (VIEWS.has(view)) this.store.setSetting('sidePanelView', view); });
    on('side:open', (w, { url, disposition, readingId } = {}) => {
      if (typeof url !== 'string' || !/^(https?|file):/i.test(url)) return;
      const d = DISPOSITIONS.has(disposition) ? disposition : 'current';
      // Opening a reading list page marks it read, like Chrome.
      if (typeof readingId === 'string') this.reading.setRead(readingId, true);
      this.openUrl(url, d, w);
    });
    on('side:reading', (w, { action, id, item } = {}) => {
      if (action === 'add-current') this.addTab(w, w.tabs.active);
      else if (action === 'read' || action === 'unread') this.reading.setRead(String(id), action === 'read');
      else if (action === 'remove') this.reading.remove(String(id));
      else if (action === 'restore' && item && typeof item === 'object') this.reading.restore(item);
    });
  }
}

module.exports = { SidePanel, VIEWS };
