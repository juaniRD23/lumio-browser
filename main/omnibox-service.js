// The address bar's main-process side, wired up by main.js: suggestions
// (history, bookmarks, open tabs in every window, the search engine's
// suggestions, answers, actions), the empty-field suggestions and "Link you
// copied", switching to a tab, opening what was picked (and learning which
// addresses get typed), paste and go, its right-click menu, search engines
// for Settings and the welcome screen, and OpenSearch engines found on sites.
// The logic itself is in omnibox.js, search-engines.js and search-suggest.js.
const { app, clipboard, Menu } = require('electron');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const { parseInput, suggest, buildIndex, zeroSuggest, clipboardLink, withWwwCom } = require('./omnibox');
const engines = require('./search-engines');
const { RemoteSuggest, remoteAllowed, readCapped } = require('./search-suggest');

const CLIPBOARD_MS = 3 * 60 * 1000; // "Link you copied" shows for links copied in the last 3 minutes
const TYPED_MAX = 1000;
const EMPTY_INDEX = buildIndex([]);
const DISPOSITIONS = new Set(['current', 'tab', 'background', 'window']);

class OmniboxService {
  // windows(): the open BrowserWins. cmd: main.js's commands (actions use them).
  constructor({ store, dir, windows, cmd, openUrl, openInternal, fetch }) {
    this.store = store;
    this.windows = windows;
    this.cmd = cmd;
    this.openUrl = openUrl;
    this.openInternal = openInternal;
    this.remote = new RemoteSuggest({ fetchImpl: fetch });
    this.fetch = fetch;
    // Addresses typed or picked in the address bar: { url: { n, t } }. Only
    // ever counted for pages that are also in history.
    this.typedFile = new JsonFile(dir, 'omnibox.json', { typed: {} });
    if (!this.typedFile.data.typed || typeof this.typedFile.data.typed !== 'object') this.typedFile.data = { typed: {} };
    this.typedVersion = 0; // bumped on each change, so the index is rebuilt
    this.indexKey = '';
    this.indexCache = EMPTY_INDEX;
    this.inflight = new WeakMap(); // window -> AbortController of its search-engine request
    this.startedAt = Date.now();
    this.clip = { hash: null, seenAt: 0, dismissed: false };
    this.watched = new WeakSet();
    this.openSearchSeen = new Set();
    // Clearing or deleting history forgets the typed addresses too.
    let historyLength = store.history().length;
    store.historyFile.onSave(() => {
      const n = store.history().length;
      if (n < historyLength) setTimeout(() => this.pruneTyped(), 0);
      historyLength = n;
    });
    app.on('before-quit', () => { if (this.typedFile.timer) this.typedFile.flush(); });
  }

  get typed() { return this.typedFile.data.typed; }

  // ---- what's typed and visited
  index() {
    const h = this.store.history();
    const key = `${h.length}|${h.at(-1)?.time || 0}|${this.typedVersion}|${Math.floor(Date.now() / 3_600_000)}`;
    if (key !== this.indexKey) { this.indexCache = buildIndex(h, this.typed); this.indexKey = key; }
    return this.indexCache;
  }

  rememberTyped(url) {
    if (!/^https?:/.test(url)) return;
    const t = this.typed[url] || { n: 0, t: 0 };
    this.typed[url] = { n: t.n + 1, t: Date.now() };
    const keys = Object.keys(this.typed);
    if (keys.length > TYPED_MAX) {
      keys.sort((a, b) => this.typed[a].t - this.typed[b].t).slice(0, keys.length - TYPED_MAX).forEach((k) => delete this.typed[k]);
    }
    this.typedChanged();
  }

  typedChanged() {
    this.typedVersion++;
    this.typedFile.save();
  }

  // Typed addresses whose site isn't in history anymore are dropped.
  pruneTyped() {
    const hosts = new Set(this.store.history().map((h) => { try { return new URL(h.url).host.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }));
    let dropped = false;
    for (const url of Object.keys(this.typed)) {
      let host = '';
      try { host = new URL(url).host.toLowerCase().replace(/^www\./, ''); } catch { /* dropped below */ }
      if (!hosts.has(host)) { delete this.typed[url]; dropped = true; }
    }
    if (dropped) this.typedChanged();
  }

  // Tabs open in this window's other tabs and its other windows (incognito
  // windows only see incognito tabs, and normal ones only normal tabs).
  openTabs(w) {
    const out = [];
    for (const x of this.windows()) {
      if (x.incognito !== w.incognito) continue;
      for (const t of x.tabs.tabs) {
        if (x === w && t.id === w.tabs.activeId) continue;
        const url = x.tabs.displayUrl(t);
        if (!url || url.startsWith('lumio://error')) continue;
        out.push({ tabId: t.id, windowId: x.id, title: t.title, url });
      }
    }
    return out;
  }

  options(w, mode) {
    const s = this.store.settings;
    return {
      index: w.incognito ? EMPTY_INDEX : this.index(),
      bookmarks: this.store.bookmarks(),
      tabs: this.openTabs(w),
      searchTemplate: engines.defaultEngine(s).url,
      keywords: engines.keywords(s),
      mode,
    };
  }

  // The search engine's suggestions for `text`, cancelling this window's
  // previous request. null when a newer request replaced this one.
  async remoteFor(w, suggestUrl, text) {
    this.inflight.get(w)?.abort();
    const ac = new AbortController();
    this.inflight.set(w, ac);
    try {
      return await this.remote.fetch(suggestUrl, text, { signal: ac.signal });
    } catch {
      return ac.signal.aborted ? null : [];
    } finally {
      if (this.inflight.get(w) === ac) this.inflight.delete(w);
    }
  }

  // req: { text, keyword (a chip's shortcut), inline: false after Backspace,
  // remote: true to wait for the search engine's suggestions too }.
  async suggestFor(w, req) {
    const r = typeof req === 'string' ? { text: req } : req || {};
    const text = String(r.text ?? '').slice(0, 2048);
    const s = this.store.settings;
    const mode = r.keyword ? engines.forKeyword(s, String(r.keyword)) : null;
    const opts = { ...this.options(w, mode), inline: r.inline !== false };
    if (!r.remote) return suggest(text, opts);
    const engine = mode ? (mode.url ? mode : null) : engines.defaultEngine(s);
    if (!engine?.suggestUrl || !remoteAllowed(text, { incognito: w.incognito, enabled: s.searchSuggest !== false })) return null;
    const list = await this.remoteFor(w, engine.suggestUrl, text.trim());
    if (!list?.length) return null; // nothing to add
    return suggest(text, { ...opts, remote: list });
  }

  // ---- the empty address bar
  // A link copied in the last few minutes. Lumio can't know when something
  // was copied, so it counts from when it first saw it (or from launch).
  // The clipboard is only read here: when the empty address bar is clicked.
  clipboardRow(w) {
    if (w.incognito) return null;
    const text = clipboard.readText();
    const hash = text ? crypto.createHash('sha256').update(text).digest('base64') : '';
    const now = Date.now();
    if (hash !== this.clip.hash) {
      this.clip = { hash, seenAt: this.clip.hash === null ? this.startedAt : now, dismissed: false };
    }
    if (!text || this.clip.dismissed || now - this.clip.seenAt > CLIPBOARD_MS) return null;
    const url = clipboardLink(text);
    return url ? { type: 'clipboard', title: 'Link you copied', url } : null;
  }

  zero(w) {
    if (w.incognito) return [];
    const clip = this.clipboardRow(w);
    const current = w.tabs.active ? w.tabs.displayUrl(w.tabs.active) : '';
    const rows = zeroSuggest(this.index(), { exclude: current, limit: 6 }).filter((r) => r.url !== clip?.url);
    return clip ? [clip, ...rows] : rows;
  }

  // ---- doing what was picked
  // { url } of a row, or { input } typed (with { keyword } while a site
  // search chip shows; { www } for Ctrl+Enter), opened in `disposition`.
  open(w, req = {}) {
    const disposition = DISPOSITIONS.has(req.disposition) ? req.disposition : 'current';
    const s = this.store.settings;
    const typedInput = String(req.input ?? '').slice(0, 4096);
    const input = req.www ? withWwwCom(typedInput) : typedInput;
    let target;
    let typed = false;
    const engine = req.keyword ? engines.forKeyword(s, String(req.keyword)) : null;
    if (engine?.url && input.trim()) target = engines.searchUrl(engine, input);
    else if (typeof req.url === 'string' && req.url) {
      const parsed = parseInput(req.url, engines.defaultEngine(s).url);
      target = parsed?.url;
      typed = !!parsed && !parsed.isSearch && req.kind !== 'search';
    } else {
      const parsed = parseInput(input, engines.defaultEngine(s).url);
      target = parsed?.url;
      typed = !!parsed && !parsed.isSearch;
    }
    if (!target) return;
    if (typed && !w.incognito) this.rememberTyped(target);
    w.hideOverlay();
    if (disposition === 'current') w.tabs.navigate(target);
    else this.openUrl(target, disposition === 'window' && w.incognito ? 'incognito' : disposition, w);
  }

  switchTo(w, { windowId, tabId } = {}) {
    const target = this.windows().find((x) => x.id === windowId && x.incognito === w.incognito);
    if (!target || !target.tabs.get(tabId)) return false;
    w.hideOverlay();
    target.tabs.activate(tabId);
    if (target !== w) target.focus();
    return true;
  }

  action(w, which) {
    const run = {
      // Batch work on privacy may add a Clear browsing data dialog (cmd.clearBrowsingData).
      clearData: () => (this.cmd.clearBrowsingData ? this.cmd.clearBrowsingData() : this.openInternal('lumio://settings/#privacy')),
      passwords: () => this.cmd.passwords(),
      settings: () => this.cmd.settings(),
      incognito: () => this.cmd.newIncognito(),
    }[which];
    if (!run) return;
    w.hideOverlay();
    run();
  }

  remove(w, { url, type, toast } = {}) {
    if (type === 'clipboard') this.clip.dismissed = true;
    else if (w.incognito || typeof url !== 'string' || !/^https?:/.test(url)) return false;
    else {
      this.store.deleteHistory({ urls: [url] });
      if (this.typed[url]) { delete this.typed[url]; this.typedChanged(); }
    }
    if (toast) w.emit('toast', { text: type === 'clipboard' ? 'Removed' : 'Removed from history' });
    return true;
  }

  // What's on the clipboard, as one line (paste and go).
  pasteText() {
    return clipboard.readText().replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 4096);
  }

  pasteAndGo(w) {
    const text = this.pasteText();
    if (!text) return;
    w.hideOverlay();
    w.tabs.navigate(text);
  }

  // Right-click in the address bar: the usual editing, Paste and Go, and a
  // way to the search engine settings.
  contextMenu(w, { selection = false, empty = false } = {}) {
    const text = this.pasteText();
    const parsed = text ? parseInput(text, engines.defaultEngine(this.store.settings).url) : null;
    const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    Menu.buildFromTemplate([
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut', enabled: !!selection },
      { role: 'copy', enabled: !!selection },
      { role: 'paste', enabled: !!text },
      { label: parsed?.isSearch ? `Paste and Search for “${short}”` : 'Paste and Go', enabled: !!parsed, click: () => this.pasteAndGo(w) },
      { role: 'delete', enabled: !!selection },
      { type: 'separator' },
      { role: 'selectAll', enabled: !empty },
      { type: 'separator' },
      { label: 'Manage Search Engines and Site Search…', click: () => this.openInternal('lumio://settings/#search') },
    ]).popup({ window: w.win });
  }

  // ---- search engines (Settings › Search engine, the welcome screen)
  enginesState() {
    const s = this.store.settings;
    const pub = ({ id, name, keyword, url, builtin }) => ({ id, name, keyword, url, builtin: !!builtin });
    return {
      default: engines.defaultEngine(s).id,
      engines: engines.builtins().map(pub),
      custom: engines.custom(s).map(pub),
      found: engines.found(s).map(pub),
      suggest: s.searchSuggest !== false,
    };
  }

  apply(patch) {
    for (const [k, v] of Object.entries(patch || {})) this.store.setSetting(k, v);
  }

  // ---- OpenSearch: sites that describe their search (<link rel="search">)
  // become inactive entries in Settings (https only, the same site, once).
  watchTab(wc) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    wc.on('did-finish-load', () => { this.detectOpenSearch(wc).catch(() => {}); });
  }

  async detectOpenSearch(wc) {
    if (wc.isDestroyed()) return;
    const pageUrl = wc.getURL();
    let page;
    try { page = new URL(pageUrl); } catch { return; }
    if (page.protocol !== 'https:') return;
    const site = engines.siteOf(page.hostname);
    const s = this.store.settings;
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
    if ([...engines.all(s), ...engines.found(s)].some((e) => engines.siteOf(hostOf(e.url)) === site)) return;
    const href = await wc.executeJavaScriptInIsolatedWorld(1003, [{
      code: '(() => { const l = document.querySelector(\'link[rel~="search" i][type="application/opensearchdescription+xml" i][href]\'); return l ? l.href : null; })()',
    }]);
    if (typeof href !== 'string' || this.openSearchSeen.has(href) || this.openSearchSeen.size > 500) return;
    this.openSearchSeen.add(href);
    let doc;
    try { doc = new URL(href); } catch { return; }
    if (doc.protocol !== 'https:' || engines.siteOf(doc.hostname) !== site) return;
    const res = await this.fetch(doc.href, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const xml = await readCapped(res);
    const patch = engines.addFound(this.store.settings, engines.parseOpenSearch(xml, pageUrl));
    if (patch) this.apply(patch);
  }

  // ---- IPC (main.js's helpers: handle/on check the sender is a window's UI,
  // internalHandle that it's one of Lumio's own pages)
  register({ handle, on, internalHandle }) {
    handle('omnibox:suggest', (w, req) => this.suggestFor(w, req));
    handle('omnibox:zero', (w) => this.zero(w));
    handle('omnibox:keywords', () => engines.keywords(this.store.settings));
    handle('omnibox:remove', (w, req) => this.remove(w, req || {}));
    on('omnibox:open', (w, req) => this.open(w, req || {}));
    on('omnibox:switch-tab', (w, req) => this.switchTo(w, req || {}));
    on('omnibox:action', (w, which) => this.action(w, String(which || '')));
    on('omnibox:copy', (w, text) => {
      clipboard.writeText(String(text || '').slice(0, 200));
      w.hideOverlay();
      w.emit('toast', { text: 'Copied' });
    });
    on('omnibox:paste-go', (w) => this.pasteAndGo(w));
    on('omnibox:context', (w, state) => this.contextMenu(w, state || {}));

    const state = () => this.enginesState();
    internalHandle('page:search-engines', ['settings', 'welcome'], state);
    internalHandle('page:search-engine-save', ['settings'], (_ctx, entry) => {
      const res = engines.save(this.store.settings, entry || {});
      if (!res.ok) return { ok: false, error: res.error };
      this.apply(res.settings);
      return { ok: true, state: state() };
    });
    internalHandle('page:search-engine-delete', ['settings'], (_ctx, id) => { this.apply(engines.remove(this.store.settings, String(id))); return state(); });
    internalHandle('page:search-engine-activate', ['settings'], (_ctx, id) => { this.apply(engines.activate(this.store.settings, String(id))); return state(); });
    internalHandle('page:search-engine-default', ['settings', 'welcome'], (_ctx, id) => { this.apply(engines.setDefault(this.store.settings, String(id))); return state(); });
    internalHandle('page:search-suggest', ['settings'], (_ctx, enabled) => { this.store.setSetting('searchSuggest', !!enabled); return state(); });
  }
}

module.exports = { OmniboxService };
