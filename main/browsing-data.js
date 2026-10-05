// Delete browsing data (lumio://settings/clearBrowserData, ⇧⌘⌫, and the
// History page): how much each choice covers for a time range, and deleting
// it. Only the normal profile keeps data; incognito forgets everything when
// its windows close.
//
// Electron's cookies don't say when they were made, so CookieClock writes
// down when each cookie first appears. Deleting "cookies and other site
// data" for a time range removes the cookies set in that range (ones Lumio
// never saw being set count as older), and the storage of the sites you
// visited or that set cookies in it. The cache can only be emptied whole.
const { JsonFile } = require('./store');

const MIN = 60_000;
const RANGES = { '15m': 15 * MIN, hour: 60 * MIN, day: 24 * 60 * MIN, week: 7 * 24 * 60 * MIN, '4w': 28 * 24 * 60 * MIN, all: 0 };
// Site storage deleted with cookies for a time range (all of it otherwise).
const STORAGES = ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem'];

const cookieKey = (c) => `${c.domain}\t${c.path}\t${c.name}`;
const cookieUrl = (c) => `${c.secure ? 'https' : 'http'}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };

class CookieClock {
  constructor(dir, session) {
    this.file = new JsonFile(dir, 'cookie-times.json', {});
    this.timer = null;
    session.cookies.on('changed', (_e, cookie, cause, removed) => this.note(cookie, cause, removed));
  }

  // A replaced cookie keeps its first time, like Chrome's creation date.
  note(cookie, cause, removed) {
    const key = cookieKey(cookie);
    const times = this.file.data;
    if (removed) { if (!/overwrite/.test(cause) && key in times) { delete times[key]; this.soon(); } return; }
    if (key in times) return;
    times[key] = Date.now();
    this.soon();
  }

  // Cookies change all the time: write at most every 15 seconds.
  soon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.file.flush(); }, 15_000);
    this.timer.unref?.();
  }
  flush() { if (this.timer) { clearTimeout(this.timer); this.timer = null; this.file.flush(); } }

  time(cookie) { return this.file.data[cookieKey(cookie)] || 0; }

  // Forget cookies that are gone (session cookies end without telling).
  prune(cookies) {
    const live = new Set(cookies.map(cookieKey));
    for (const key of Object.keys(this.file.data)) if (!live.has(key)) delete this.file.data[key];
    this.soon();
  }

  reset() { this.file.data = {}; this.soon(); }
}

class BrowsingData {
  // profile: the normal profile ({ session, chats, permissions }).
  // recentlyClosed: main.js's list (changed in place); onClosedChanged
  // redraws the menu. stopAI stops Lumio AI in normal windows.
  constructor({ store, profile, passwords, clock, recentlyClosed, onClosedChanged = () => {}, stopAI = () => {}, siteOf = null }) {
    Object.assign(this, { store, profile, passwords, clock, recentlyClosed, onClosedChanged, stopAI, siteOf });
  }

  // range: milliseconds back from now, or 0 for all time.
  from(range) { return range ? Date.now() - range : null; }

  // The sites whose cookies or storage a time range covers.
  async cookieScope(from) {
    const all = await this.profile.session.cookies.get({}).catch(() => []);
    if (from == null) return { cookies: all, origins: new Set() };
    const cookies = all.filter((c) => this.clock.time(c) >= from);
    const origins = new Set(cookies.map((c) => originOf(cookieUrl(c))).filter(Boolean));
    for (const h of this.store.history()) if (h.time >= from) { const o = originOf(h.url); if (o) origins.add(o); }
    return { cookies, origins };
  }

  // How much each choice covers, for the dialog: { history, downloads,
  // cookieSites, cacheBytes, passwords, siteSettings, chats, closed }.
  async counts({ range = 0 } = {}) {
    const from = this.from(range);
    const since = (t) => from == null || (t || 0) >= from;
    const { cookies, origins } = await this.cookieScope(from);
    if (from == null) this.clock.prune(cookies);
    const hosts = new Set([...cookies.map((c) => String(c.domain).replace(/^\./, '')), ...[...origins].map((o) => new URL(o).hostname)]);
    const sites = this.siteOf ? new Set(await Promise.all([...hosts].map((h) => this.siteOf(h)))) : hosts;
    const pw = this.passwords;
    return {
      history: this.store.history().filter((h) => since(h.time)).length,
      downloads: this.store.downloads().filter((d) => d.state !== 'progressing' && since(d.time)).length,
      cookieSites: sites.size,
      cacheBytes: await this.profile.session.getCacheSize().catch(() => 0),
      passwords: (pw?.store.entries || []).filter((e) => since(e.updated || e.created)).length + (pw?.passkeys.list() || []).filter((k) => since(k.created)).length,
      siteSettings: this.profile.permissions.settings.count({ from }),
      chats: this.profile.chats.list().filter((c) => since(c.updatedAt)).length,
      closed: this.recentlyClosed.filter((e) => since(e.time)).length,
    };
  }

  // what: any of history, downloads, cookies, cache, passwords,
  // siteSettings, chats, closed.
  async clear({ range = 0, what = [] } = {}) {
    const from = this.from(range);
    const since = (t) => from == null || (t || 0) >= from;
    const ses = this.profile.session;
    // The sites to clean up come partly from history, so before it goes.
    const scope = what.includes('cookies') && from != null ? await this.cookieScope(from) : null;
    if (what.includes('history')) { if (from != null) this.store.deleteHistory({ from }); else this.store.clearHistory(); }
    if (what.includes('downloads')) this.store.clearDownloads({ from });
    if (what.includes('cookies')) {
      if (!scope) { await ses.clearStorageData(); this.clock.reset(); } else {
        const { cookies, origins } = scope;
        await Promise.all(cookies.map((c) => ses.cookies.remove(cookieUrl(c), c.name).catch(() => {})));
        await Promise.all([...origins].map((origin) => ses.clearStorageData({ origin, storages: STORAGES }).catch(() => {})));
      }
    }
    if (what.includes('cache')) await ses.clearCache();
    if (what.includes('passwords') && this.passwords) {
      for (const e of this.passwords.store.entries.filter((x) => since(x.updated || x.created))) this.passwords.store.remove(e.id);
      for (const k of this.passwords.passkeys.list().filter((x) => since(x.created))) this.passwords.passkeys.remove(k.id);
    }
    if (what.includes('siteSettings')) this.profile.permissions.settings.clear({ from });
    if (what.includes('chats')) {
      this.stopAI();
      if (from == null) this.profile.chats.clear();
      else for (const c of this.profile.chats.list().filter((x) => since(x.updatedAt))) this.profile.chats.delete(c.id);
    }
    if (what.includes('closed')) {
      const keep = this.recentlyClosed.filter((e) => !since(e.time));
      this.recentlyClosed.splice(0, this.recentlyClosed.length, ...keep);
      this.onClosedChanged();
    }
    return true;
  }
}

module.exports = { BrowsingData, CookieClock, RANGES, cookieKey, cookieUrl };
