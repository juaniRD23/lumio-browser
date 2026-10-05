// The reading list, like Chrome's: pages saved to read later, each unread
// until you open it from the list (or mark it read). Shown in the side
// panel (renderer/ui/side-panel.js) and synced with Lumio Sync
// (main/sync/adapters.js, collection "readingList").
//
// Saved in userData/reading-list.json as { items: [...] }; an item is
// { id, url, title, favicon, added, read, updated }. The id comes from the
// address, so the same page saved on two devices is one item once they sync.
const crypto = require('crypto');

const MAX_ITEMS = 1000;
const MAX_URL = 4096;
const MAX_TITLE = 300;

const idFor = (url) => 'r' + crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TITLE);
// Only web pages go on the list (not Lumio's own pages or files).
function cleanUrl(u) {
  const s = String(u ?? '').trim();
  if (s.length > MAX_URL || !/^https?:\/\//i.test(s)) return '';
  try { return new URL(s).href; } catch { return ''; }
}
// Small icons only: a big data: URL would bloat the file.
const cleanIcon = (f) => (typeof f === 'string' && f.length <= 8192 && /^(https?:|data:image\/)/.test(f) ? f : null);

class ReadingList {
  // file: a JsonFile (main/store.js).
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    if (!Array.isArray(file.data?.items)) file.data = { items: [] };
    this.listeners = new Set();
  }

  get items() { return this.file.data.items; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() {
    this.file.save();
    for (const fn of this.listeners) fn();
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }
  byUrl(url) { const u = cleanUrl(url); return u ? this.get(idFor(u)) : null; }
  has(url) { return !!this.byUrl(url); }
  unread() { return this.items.filter((x) => !x.read).length; }

  // Newest first, unread before read (the side panel's two sections).
  list() {
    return [...this.items].sort((a, b) => (a.read - b.read) || (b.added - a.added))
      .map(({ id, url, title, favicon, added, read }) => ({ id, url, title, favicon, added, read }));
  }

  // Adds a page (again: it becomes unread and moves to the top). Returns it, or null.
  add(url, title, favicon) {
    const u = cleanUrl(url);
    if (!u) return null;
    const now = this.now();
    let item = this.get(idFor(u));
    if (item) Object.assign(item, { title: cleanTitle(title) || item.title, read: false, added: now, updated: now });
    else {
      item = { id: idFor(u), url: u, title: cleanTitle(title) || u, favicon: cleanIcon(favicon), added: now, read: false, updated: now };
      this.items.push(item);
      // Too many: the oldest read ones go first.
      if (this.items.length > MAX_ITEMS) {
        const old = [...this.items].sort((a, b) => (b.read - a.read) || (a.added - b.added))[0];
        this.items.splice(this.items.indexOf(old), 1);
      }
    }
    if (cleanIcon(favicon)) item.favicon = cleanIcon(favicon);
    this.changed();
    return item;
  }

  setRead(id, read = true) {
    const item = this.get(id);
    if (!item || item.read === !!read) return false;
    item.read = !!read;
    item.updated = this.now();
    this.changed();
    return true;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [item] = this.items.splice(i, 1);
    this.changed();
    return item;
  }

  // Undo for a removal.
  restore(item) {
    if (!item || this.get(item.id)) return false;
    const u = cleanUrl(item.url);
    if (!u || idFor(u) !== item.id) return false;
    this.items.push({ id: item.id, url: u, title: cleanTitle(item.title) || u, favicon: cleanIcon(item.favicon), added: Number(item.added) || this.now(), read: !!item.read, updated: this.now() });
    this.changed();
    return true;
  }

  // ---- Lumio Sync: one record per page, without its icon.
  syncEntries() {
    return this.items.map((x) => [x.id, { url: x.url, title: x.title, added: x.added, read: x.read, updated: x.updated }]);
  }

  // Other devices' changes ({ key, record | null }). Returns keys it rejected.
  applySynced(changes) {
    const rejected = [];
    for (const { key, record: r } of changes) {
      const i = this.items.findIndex((x) => x.id === key);
      if (!r) { if (i >= 0) this.items.splice(i, 1); continue; }
      const u = cleanUrl(r.url);
      if (!u || idFor(u) !== key) { rejected.push(key); continue; }
      const fields = { url: u, title: cleanTitle(r.title) || u, added: Number(r.added) || this.now(), read: !!r.read, updated: Number(r.updated) || this.now() };
      if (i >= 0) Object.assign(this.items[i], fields);
      else this.items.push({ id: key, favicon: null, ...fields });
    }
    this.file.save();
    for (const fn of this.listeners) fn();
    return rejected;
  }
}

module.exports = { ReadingList, idFor, cleanUrl };
