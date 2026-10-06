// Small JSON-file stores in userData, written atomically and debounced.
// Secrets (the Lumio session) are encrypted with safeStorage (Keychain).
const fs = require('fs');
const path = require('path');
const { BookmarkTree } = require('./bookmarks');

class JsonFile {
  constructor(dir, name, fallback) {
    this.file = path.join(dir, name);
    this.fallback = fallback;
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = structuredClone(fallback);
    }
  }

  save(now = false) {
    clearTimeout(this.timer);
    for (const fn of this.listeners || []) fn();
    if (now) return this.flush();
    // Changes that never stop (a tab's title ticking) still get written, at least every 2 s.
    this.since ??= Date.now();
    this.timer = setTimeout(() => this.flush(), Date.now() - this.since >= 2000 ? 0 : 400);
  }

  // Told about every change (Lumio Sync uploads soon after).
  onSave(fn) { (this.listeners ||= new Set()).add(fn); return () => this.listeners.delete(fn); }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.since = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  reasoning: 'medium', // how hard Lumio AI thinks: 'low', 'medium' or 'high'
  approvalMode: 'ask',
  panelOpen: true,
  panelWidth: 380,
  sitePermissions: {},
  showBookmarksBar: true, // under the address bar, like Chrome's
  developerMode: false,
  disabledExtensions: [],
  unpackedExtensions: [],
  // Local profile shown on the account button (the Lumio account adds email + plan).
  profile: { name: '', color: '#86b7ff', photo: null, theme: 'blue' },
  startup: 'restore', // 'restore' windows and tabs, 'newtab', or the start 'pages'
  startupPages: [], // [{ url, title }] for startup: 'pages' (main/startup.js)
  showHome: false, // the Home button, off like in Chrome
  homePage: 'newtab', // or a web address
  defaultZoom: 100, // percent (main/zoom.js)
  zoomLevels: {}, // host -> percent, the sites zoomed to something else
  mutedSites: [], // origins muted with the tab menu's Mute site (main/site-mute.js)
  defaultBrowserPrompt: true, // "Lumio isn't your default browser" at startup (main/default-browser.js)
  defaultBrowserDismissals: 0, // times that bar was closed; it stops after 3
  downloadDir: null, // null = the Downloads folder
  askDownload: false, // ask where to save each file
  offerPasswords: true,
  autofillPasswords: true,
  memorySaver: true, // tabs you haven't looked at for a while give back their memory
  memorySaverMinutes: 60,
  appearance: 'system', // 'system', 'light' or 'dark' (main/theme.js; profile.theme is the accent)
  verticalTabs: false, // new windows show their tabs in a column at the side (main/tab-layout.js)
};

const HISTORY_DAYS = 90;
const HISTORY_MAX = 20000;

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
};

class Store {
  constructor(dir, safeStorage) {
    fs.mkdirSync(dir, { recursive: true });
    this.safeStorage = safeStorage;
    this.settingsFile = new JsonFile(dir, 'settings.json', DEFAULT_SETTINGS);
    this.settingsFile.data = { ...DEFAULT_SETTINGS, ...this.settingsFile.data };
    this.settingsFile.data.profile = { ...DEFAULT_SETTINGS.profile, ...(this.settingsFile.data.profile || {}) };
    this.historyFile = new JsonFile(dir, 'history.json', []);
    // Bookmarks are a tree of folders (main/bookmarks.js); before folders they
    // were a flat list in bookmarks.json, which becomes the Bookmarks bar.
    this.bookmarksFile = new JsonFile(dir, 'bookmark-tree.json', null);
    let legacy = null;
    if (!this.bookmarksFile.data) { try { legacy = JSON.parse(fs.readFileSync(path.join(dir, 'bookmarks.json'), 'utf8')); } catch { /* none */ } }
    this.marks = new BookmarkTree(this.bookmarksFile, { legacy });
    this.sessionFile = new JsonFile(dir, 'session.json', { windows: [] });
    this.downloadsFile = new JsonFile(dir, 'downloads.json', []);
    this.chatsFile = new JsonFile(dir, 'chats.json', []);
    this.secretsFile = new JsonFile(dir, 'secrets.json', {});
    // Since 0.4 the AI only runs on Lumio plans: drop the old key and model settings.
    if (this.secretsFile.data.openrouter) { delete this.secretsFile.data.openrouter; this.secretsFile.save(); }
    if ('model' in this.settings || 'aiSource' in this.settings) {
      delete this.settings.model;
      delete this.settings.aiSource;
      this.settingsFile.save();
    }
    // Since 0.6.5 the bookmarks bar is on by default (it used to be off): turned on once for everyone.
    if (!this.settings.bookmarksBarOn) {
      this.settings.showBookmarksBar = true;
      this.settings.bookmarksBarOn = true;
      this.settingsFile.save();
    }
    this.onBookmarkIcons = null; // set by main: a bookmark learned its site's icon
  }

  get settings() { return this.settingsFile.data; }
  setSetting(key, value) {
    this.settingsFile.data[key] = value;
    this.settingsFile.save();
  }

  // ---- secrets ----
  setSecret(name, value) {
    if (!value) {
      delete this.secretsFile.data[name];
    } else if (this.safeStorage?.isEncryptionAvailable()) {
      this.secretsFile.data[name] = { enc: this.safeStorage.encryptString(value).toString('base64') };
    } else {
      this.secretsFile.data[name] = { plain: value };
    }
    this.secretsFile.save(true);
  }
  getSecret(name) {
    const entry = this.secretsFile.data[name];
    if (!entry) return '';
    if (entry.plain) return entry.plain;
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
    } catch {
      return '';
    }
  }

  // ---- history ----
  // Entries are { url, title, time, favicon? }, oldest first. Kept 90 days.
  addVisit(url, title, favicon) {
    if (!/^https?:/.test(url)) return;
    const list = this.historyFile.data;
    const last = list[list.length - 1];
    if (last && last.url === url && Date.now() - last.time < 30_000) {
      if (title) last.title = title;
    } else {
      const prev = favicon || this.faviconFor(url);
      list.push({ url, title: title || url, time: Date.now(), ...(prev ? { favicon: prev } : {}) });
      this.pruneHistory();
    }
    this.historyFile.save();
  }
  pruneHistory() {
    const list = this.historyFile.data;
    const cutoff = Date.now() - HISTORY_DAYS * 86400000;
    let drop = 0;
    while (drop < list.length && list[drop].time < cutoff) drop++;
    drop = Math.max(drop, list.length - HISTORY_MAX);
    if (drop > 0) list.splice(0, drop);
  }
  updateTitle(url, title) {
    const list = this.historyFile.data;
    for (let i = list.length - 1; i >= Math.max(0, list.length - 20); i--) {
      if (list[i].url === url) { list[i].title = title; this.historyFile.save(); return; }
    }
  }
  updateFavicon(url, favicon) {
    if (!favicon || !/^https?:|^data:image\//.test(favicon)) return;
    const list = this.historyFile.data;
    for (let i = list.length - 1; i >= Math.max(0, list.length - 20); i--) {
      if (list[i].url === url) { list[i].favicon = favicon; this.historyFile.save(); break; }
    }
    this.learnBookmarkIcon(url, favicon);
  }
  // Bookmarks get their icon when the page is open (imported ones come without one).
  learnBookmarkIcon(url, favicon) {
    if (!this.marks.learnIcon(url, favicon)) return false;
    this.onBookmarkIcons?.();
    return true;
  }
  faviconFor(url) {
    const list = this.historyFile.data;
    let origin;
    try { origin = new URL(url).origin; } catch { return null; }
    for (let i = list.length - 1; i >= Math.max(0, list.length - 400); i--) {
      if (list[i].favicon && list[i].url.startsWith(origin + '/')) return list[i].favicon;
    }
    return null;
  }
  history() { return this.historyFile.data; }
  // Remove specific visits ({ url, time }), every visit to some URLs, a whole
  // site, or a time range.
  deleteHistory({ entries, urls, host, from, to } = {}) {
    const keys = entries ? new Set(entries.map((e) => `${e.time}|${e.url}`)) : null;
    const urlSet = urls ? new Set(urls) : null;
    const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const before = this.historyFile.data.length;
    this.historyFile.data = this.historyFile.data.filter((h) => {
      if (keys && keys.has(`${h.time}|${h.url}`)) return false;
      if (urlSet && urlSet.has(h.url)) return false;
      if (host && siteOf(h.url) === host) return false;
      if (from != null && h.time >= from && h.time <= (to ?? Infinity)) return false;
      return true;
    });
    this.historyFile.save();
    return before - this.historyFile.data.length;
  }
  clearHistory() {
    this.historyFile.data = [];
    this.historyFile.save(true);
  }
  importHistory(entries) {
    const seen = new Set(this.historyFile.data.map((h) => `${h.time}|${h.url}`));
    const fresh = entries.filter((h) => /^https?:/.test(h.url) && !seen.has(`${h.time}|${h.url}`));
    this.historyFile.data = [...this.historyFile.data, ...fresh].sort((a, b) => a.time - b.time);
    this.pruneHistory();
    this.historyFile.save(true);
    return fresh.length;
  }

  // ---- bookmarks ----
  // The tree is this.marks (main/bookmarks.js); the window's side of it is
  // main/bookmarks-service.js. Every bookmark as a flat list (for the
  // address bar's suggestions), and whether a page is bookmarked (the star).
  bookmarks() { return this.marks.urls(); }
  isBookmarked(url) { return this.marks.has(url); }
  // A flat list goes on the bar; { bar, other, mobile } keeps its folders.
  importBookmarks(items, opts) { return this.marks.import(items, opts); }

  // ---- Lumio Sync (main/sync): applying other devices' changes ----
  // history: { key: "time|url", record: { url, title, time } | null }
  applySyncedHistory(changes) {
    const list = this.historyFile.data;
    const keyOf = (h) => `${h.time}|${h.url}`;
    const drop = new Set(changes.filter((c) => !c.record).map((c) => c.key));
    const have = new Set(list.map(keyOf));
    const add = changes.filter((c) => c.record && !have.has(c.key) && /^https?:/.test(c.record.url)).map((c) => ({ url: c.record.url, title: c.record.title || c.record.url, time: Number(c.record.time) || Date.now() }));
    for (const c of changes) {
      if (!c.record || !have.has(c.key)) continue;
      const h = list.find((x) => keyOf(x) === c.key);
      if (h) h.title = c.record.title || h.title;
    }
    this.historyFile.data = [...list.filter((h) => !drop.has(keyOf(h))), ...add].sort((a, b) => a.time - b.time);
    this.pruneHistory();
    this.historyFile.save();
  }

  // ---- downloads (history of finished and running downloads) ----
  downloads() { return this.downloadsFile.data; }
  saveDownload(entry) {
    const list = this.downloadsFile.data;
    const i = list.findIndex((d) => d.id === entry.id);
    if (i >= 0) list[i] = entry; else list.unshift(entry);
    if (list.length > 300) list.length = 300;
    this.downloadsFile.save();
  }
  removeDownloads(ids) {
    const set = new Set(ids);
    this.downloadsFile.data = this.downloadsFile.data.filter((d) => !set.has(d.id));
    this.downloadsFile.save();
  }
  clearDownloads({ from } = {}) {
    this.downloadsFile.data = from != null ? this.downloadsFile.data.filter((d) => d.time < from || d.state === 'progressing') : this.downloadsFile.data.filter((d) => d.state === 'progressing');
    this.downloadsFile.save(true);
  }

  // ---- session: the open (non-incognito) windows and their tabs ----
  // earlier: windows of a crashed session that weren't restored (main/sessions.js).
  saveSession(windows, earlier = []) {
    this.sessionFile.data = { windows, ...(earlier.length ? { earlier } : {}) };
    this.sessionFile.save();
  }
  earlierWindows() {
    const d = this.sessionFile.data || {};
    return Array.isArray(d.earlier) ? d.earlier.filter((w) => w && Array.isArray(w.tabs) && w.tabs.length) : [];
  }
  sessionWindows() {
    const d = this.sessionFile.data || {};
    if (Array.isArray(d.windows)) return d.windows.filter((w) => w && Array.isArray(w.tabs) && w.tabs.length);
    if (Array.isArray(d.tabs) && d.tabs.length) return [{ tabs: d.tabs, active: d.active || 0 }]; // older single-window format
    return [];
  }

  flushAll() {
    for (const f of [this.settingsFile, this.historyFile, this.bookmarksFile, this.sessionFile, this.chatsFile, this.downloadsFile]) {
      if (f.timer) f.flush();
    }
  }
}

module.exports = { Store, JsonFile, SEARCH_ENGINES, DEFAULT_SETTINGS };
