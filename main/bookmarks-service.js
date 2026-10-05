// The bookmarks' main-process side, wired up by main.js: the bookmarks bar
// (folders and their menus, drag and drop, right-click menus), the star's
// edit bubble, Bookmark All Tabs, the bookmark manager page
// (lumio://bookmarks), importing a bookmarks file and exporting one. The
// tree itself is main/bookmarks.js (store.marks).
const { Menu, dialog, app, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { isFolder, ROOT_IDS } = require('./bookmarks');

const DISPOSITIONS = new Set(['current', 'tab', 'background', 'window', 'incognito']);
const MANY_TABS = 20; // opening more than this at once asks first
const BUBBLE_KINDS = new Set(['bm-menu', 'bm-edit']); // the overlay's bookmark menus and bubble

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const ids = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string').slice(0, 5000);

class BookmarksService {
  // windows(): the open BrowserWins. cmd: main.js's commands.
  constructor({ store, windows, cmd, openUrl, openInternal, createWindow, menuChanged }) {
    this.store = store;
    this.marks = store.marks;
    this.windows = windows;
    this.cmd = cmd;
    this.openUrl = openUrl;
    this.openInternal = openInternal;
    this.createWindow = createWindow;
    this.menuChanged = menuChanged;
  }

  // ---- what the window shows
  // Copies of the folders for the window and the manager, each bookmark with
  // an icon: its own, else its site's from history.
  tree() {
    const icons = new Map();
    const h = this.store.history();
    for (let i = Math.max(0, h.length - 400); i < h.length; i++) if (h[i].favicon) icons.set(originOf(h[i].url), h[i].favicon);
    const copy = (n) => (isFolder(n)
      ? { id: n.id, title: n.title, children: n.children.map(copy) }
      : { id: n.id, title: n.title, url: n.url, time: n.time, favicon: n.favicon || icons.get(originOf(n.url)) || null });
    return this.marks.roots.map(copy);
  }

  // For the window: the bar's contents (items), Other and Mobile bookmarks,
  // every folder (for the bubble's folder menu) and the ones used lately.
  payload(extra = {}) {
    const [bar, other, mobile] = this.tree();
    return { show: !!this.store.settings.showBookmarksBar, items: bar.children, other, mobile, folders: this.marks.folders(), recent: this.marks.recentFolders(), ...extra };
  }

  changed() {
    const payload = this.payload();
    for (const w of this.windows()) {
      w.tabs.changed(); // the star
      w.emit('bookmarks', payload);
      // The bookmark manager redraws.
      for (const t of w.tabs.tabs) {
        const wc = t.view?.webContents;
        if (wc && !wc.isDestroyed() && (t.url || '').startsWith('lumio://bookmarks')) wc.send('bookmarks-changed');
      }
    }
  }

  setBar(show) {
    this.store.setSetting('showBookmarksBar', !!show);
    this.changed();
    this.menuChanged();
  }

  // The star's bubble (and Edit… on a bookmark or folder). anchor: the id of
  // something on the bar to point at, else the star. refresh: redraw the
  // open bubble (a folder was just made) without moving it.
  // reading: the star's bubble also offers "Add to reading list".
  bubble(w, id, heading, { anchor = null, refresh = false, reading = false } = {}) {
    if (!this.marks.get(id)) return;
    w.emit('bookmarks', this.payload({ bubble: { id, heading, anchor, refresh, reading: reading && !w.incognito } }));
  }

  // ⌘D or the star: bookmarks the page (in the folder used last) and opens the
  // bubble to name it or pick its folder; on a bookmarked page, just the bubble.
  star(w) {
    const tab = w?.tabs.active;
    if (!tab) return;
    const url = w.tabs.displayUrl(tab);
    if (!/^https?:/.test(url)) return;
    const [have] = this.marks.byUrl(url);
    if (have) { this.bubble(w, have.id, 'Edit bookmark', { reading: true }); return; }
    const node = this.marks.add(this.marks.lastFolder(), null, { url, title: tab.view?.webContents.getTitle() || tab.title, favicon: tab.favicon }); // the page's title now
    if (!node) return;
    this.changed();
    this.bubble(w, node.id, 'Bookmark added', { reading: true });
  }

  // ⇧⌘D: the window's web pages, in a new folder, then the bubble to name it.
  allTabs(w) {
    if (!w) return;
    const pages = w.tabs.tabs.map((t) => ({ url: w.tabs.displayUrl(t), title: t.title })).filter((p) => /^https?:/.test(p.url));
    if (!pages.length) { w.emit('toast', { text: 'No pages to bookmark' }); return; }
    const folder = this.marks.addFolder(this.marks.lastFolder(), null, 'Saved tabs');
    for (const p of pages) this.marks.add(folder.id, null, p);
    this.changed();
    this.bubble(w, folder.id, `Bookmarked ${pages.length} tab${pages.length === 1 ? '' : 's'}`);
  }

  // A folder's pages (and its folders'), opened at once; many ask first.
  async openAll(w, folderIds, disposition) {
    const urls = [];
    const walk = (n) => { if (isFolder(n)) n.children.forEach(walk); else urls.push(n.url); };
    for (const id of folderIds) { const n = this.marks.get(id); if (n) walk(n); }
    if (!urls.length) return 0;
    if (urls.length > MANY_TABS) {
      const { response } = await dialog.showMessageBox(w.win, { type: 'question', buttons: [`Open ${urls.length} tabs`, 'Cancel'], defaultId: 0, cancelId: 1, message: `Open ${urls.length} tabs?` });
      if (response !== 0) return 0;
    }
    if (disposition === 'window' || disposition === 'incognito') this.createWindow({ urls, incognito: disposition === 'incognito' });
    else urls.forEach((u, i) => w.tabs.create(u, { active: disposition !== 'background' && i === 0 }));
    return urls.length;
  }

  open(w, id, disposition) {
    const n = this.marks.get(id);
    if (!n) return;
    if (isFolder(n)) this.openAll(w, [id], disposition === 'current' ? 'tab' : disposition);
    else this.openUrl(n.url, disposition, w);
  }

  // ---- right-click menus (native): on a bookmark, a folder or the bar itself
  contextMenu(w, id) {
    const n = id && !ROOT_IDS.has(id) ? this.marks.get(id) : null;
    const where = n ? this.marks.parentOf(n.id) : this.marks.folder(ROOT_IDS.has(id) ? id : 'bar');
    const at = n ? where.children.indexOf(n) + 1 : where.children.length;
    const items = [];
    if (n && isFolder(n)) {
      const count = this.urlsIn(n);
      items.push(
        { label: `Open All (${count})`, enabled: count > 0, click: () => this.openAll(w, [n.id], 'tab') },
        { label: 'Open All in New Window', enabled: count > 0, click: () => this.openAll(w, [n.id], 'window') },
        { label: 'Open All in Incognito Window', enabled: count > 0, click: () => this.openAll(w, [n.id], 'incognito') },
        { type: 'separator' },
        { label: 'Rename…', click: () => this.bubble(w, n.id, 'Edit folder', { anchor: n.id }) },
        { label: 'Delete', click: () => { this.marks.remove([n.id]); this.changed(); w.emit('toast', { text: 'Folder deleted' }); } },
      );
    } else if (n) {
      items.push(
        { label: 'Open in New Tab', click: () => this.openUrl(n.url, 'tab', w) },
        { label: 'Open in New Window', click: () => this.openUrl(n.url, 'window', w) },
        { label: 'Open in Incognito Window', click: () => this.openUrl(n.url, 'incognito', w) },
        { type: 'separator' },
        { label: 'Edit…', click: () => this.bubble(w, n.id, 'Edit bookmark', { anchor: n.id }) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(n.url) },
        { label: 'Delete', click: () => { this.marks.remove([n.id]); this.changed(); } },
      );
    } else {
      const tab = w.tabs.active;
      const url = tab ? w.tabs.displayUrl(tab) : '';
      items.push(
        { label: 'Bookmark This Tab…', enabled: /^https?:/.test(url), click: () => this.star(w) },
        { label: 'Bookmark All Tabs…', click: () => this.allTabs(w) },
        { label: 'Import Bookmarks…', click: () => this.openInternal('lumio://settings/#import') },
      );
    }
    items.push(
      { type: 'separator' },
      { label: 'Add Folder…', click: () => { const f = this.marks.addFolder(where.id, at, 'New folder'); this.changed(); this.bubble(w, f.id, 'New folder', { anchor: f.id }); } },
      { type: 'separator' },
      { label: 'Show Bookmarks Bar', type: 'checkbox', checked: !!this.store.settings.showBookmarksBar, click: () => this.setBar(!this.store.settings.showBookmarksBar) },
      { label: 'Bookmark Manager', click: () => this.openInternal('lumio://bookmarks/') },
    );
    Menu.buildFromTemplate(items).popup({ window: w.win });
  }
  urlsIn(folder) { let n = 0; const walk = (f) => f.children.forEach((c) => (isFolder(c) ? walk(c) : n++)); walk(folder); return n; }

  // ---- files
  async exportFile(w) {
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      defaultPath: path.join(app.getPath('downloads'), 'lumio-bookmarks.html'),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, this.marks.toHtml());
    return true;
  }

  register({ on, internalHandle }) {
    // ---- the window: bookmarks bar, folder menus, the bubble
    on('bookmarks:open', (w, { id, url, disposition } = {}) => {
      const d = DISPOSITIONS.has(disposition) ? disposition : 'current';
      if (typeof id === 'string') this.open(w, id, d);
      else if (typeof url === 'string') this.openUrl(url, d, w);
    });
    on('bookmarks:context', (w, id) => this.contextMenu(w, typeof id === 'string' ? id : null));
    // index null: at the end of the folder (a drop onto a folder).
    const at = (index) => (index == null ? null : Number(index));
    on('bookmarks:move', (_w, { ids: list, parentId, index } = {}) => { if (this.marks.move(ids(list), String(parentId), at(index))) this.changed(); });
    // A link, or the address bar's site icon, dropped on the bar or in a
    // folder menu (moved there if it's bookmarked already).
    on('bookmarks:add', (w, { url, title, parentId, index } = {}) => {
      url = String(url || '').trim();
      if (!/^(https?|file):/i.test(url) || url.length > 4096) return;
      const [have] = this.marks.byUrl(url);
      if (have) this.marks.move([have.id], String(parentId || 'bar'), at(index));
      else {
        const tab = w.tabs.tabs.find((t) => t.url === url);
        this.marks.add(String(parentId || 'bar'), at(index), { url, title: String(title || tab?.title || '').trim() || url, favicon: tab?.favicon });
      }
      this.changed();
    });
    // The bubble: name and folder change as you go, so it never loses an edit.
    on('bookmarks:edit', (w, { id, title, url, parentId, newFolder } = {}) => {
      const n = this.marks.get(String(id));
      if (!n) return;
      if (typeof title === 'string' || typeof url === 'string') this.marks.update(n.id, { title, url });
      let to = typeof parentId === 'string' ? parentId : null;
      if (newFolder && typeof newFolder === 'object') to = this.marks.addFolder(String(newFolder.parentId || 'bar'), null, String(newFolder.title || ''))?.id || null;
      if (to && to !== this.marks.parentOf(n.id)?.id && this.marks.move([n.id], to, null)) this.marks.useFolder(to);
      this.changed();
      // A folder made just now: the bubble shows it in its menu.
      if (newFolder) this.bubble(w, n.id, null, { refresh: true });
    });
    on('bookmarks:remove', (w, id) => {
      const n = this.marks.get(String(id));
      if (!n) return;
      this.marks.remove([n.id]);
      this.changed();
      w.emit('toast', { text: isFolder(n) ? 'Folder deleted' : 'Bookmark removed' });
    });
    // "All bookmarks" at the bar's end: the side panel when there is one, else the manager.
    on('bookmarks:all', (w) => (this.cmd.sidePanel ? this.cmd.sidePanel('bookmarks', w) : this.openInternal('lumio://bookmarks/')));
    // A menu or bubble opened with the keyboard (or the star) takes the keys.
    on('bookmarks:overlay-focus', (w) => { if (!w.overlay.webContents.isDestroyed()) w.overlay.webContents.focus(); });
    // Closed with Esc or Done: the keys go back to the page, or to the bar.
    on('overlay:pick', (w, item) => {
      if (!BUBBLE_KINDS.has(item?.kind) || !item.refocus) return;
      if (item.refocus === 'page' && w.tabs.wc()) w.tabs.wc().focus();
      else w.win.webContents.focus();
    });

    // ---- the bookmark manager (lumio://bookmarks)
    const page = (channel, fn) => internalHandle(channel, ['bookmarks'], fn);
    const done = (v) => { this.changed(); return v; };
    page('page:bookmarks', () => ({ roots: this.tree(), showBar: !!this.store.settings.showBookmarksBar }));
    page('page:bookmark-add', (_c, parentId, index, entry) => done(this.marks.add(String(parentId), index, entry || {})?.id || null));
    page('page:bookmark-folder', (_c, parentId, index, title) => done(this.marks.addFolder(String(parentId), index, String(title || ''))?.id || null));
    page('page:bookmark-update', (_c, id, patch) => done(this.marks.update(String(id), patch || {})));
    page('page:bookmark-move', (_c, list, parentId, index) => done(this.marks.move(ids(list), String(parentId), index)));
    page('page:bookmark-remove', (_c, list) => done(this.marks.remove(ids(list))));
    page('page:bookmark-restore', (_c, removed) => done(this.marks.restore(removed)));
    page('page:bookmark-sort', (_c, folderId) => done(this.marks.sort(String(folderId))));
    page('page:bookmark-reorder', (_c, folderId, list) => done(this.marks.reorder(String(folderId), ids(list))));
    page('page:bookmark-open', ({ w }, list, disposition) => {
      const d = DISPOSITIONS.has(disposition) ? disposition : 'tab';
      const chosen = ids(list).map((id) => this.marks.get(id)).filter(Boolean);
      const folders = chosen.filter(isFolder).map((n) => n.id);
      const urls = chosen.filter((n) => !isFolder(n)).map((n) => n.url);
      if (folders.length) return this.openAll(w, folders, d === 'current' ? 'tab' : d);
      if (d === 'window' || d === 'incognito') { if (urls.length) this.createWindow({ urls, incognito: d === 'incognito' }); } else urls.forEach((u, i) => this.openUrl(u, i === 0 ? d : 'background', w));
      return urls.length;
    });
    page('page:bookmarks-export', ({ w }) => this.exportFile(w));
    page('page:bookmarks-bar', () => !!this.store.settings.showBookmarksBar);
    internalHandle('page:set-bookmarks-bar', ['bookmarks', 'settings'], (_c, show) => this.setBar(!!show));
  }
}

module.exports = { BookmarksService };
