// Site settings › All sites, and a site's own page: which sites keep data on
// this computer, how much, and deleting it. Sites are grouped by registrable
// domain (main/sites.js), like Chrome.
//
// Electron has no storage-use API, so Lumio asks Chromium through the
// DevTools protocol (Storage.getUsageAndQuota) on the Settings page that
// asked: it counts IndexedDB, Cache Storage, service workers and file
// systems, but not cookies or localStorage. Sites are found from cookies,
// history, site settings and IndexedDB folders; a site that only keeps
// localStorage and isn't in history doesn't show.
const fs = require('fs');
const path = require('path');
const { cookieUrl } = require('./browsing-data');

const ALL_DATA = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch', 'cache'];
const MAX_USAGE_LOOKUPS = 300;

const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
const hostOf = (origin) => { try { return new URL(origin).hostname; } catch { return ''; } };

// IndexedDB folders are named like https_www.example.com_0.indexeddb.leveldb.
function indexedDbOrigins(storagePath) {
  if (!storagePath) return [];
  let names = [];
  try { names = fs.readdirSync(path.join(storagePath, 'IndexedDB')); } catch { return []; }
  return names.map((n) => /^(https?)_(.+)_(\d+)\.indexeddb\.(leveldb|blob)$/.exec(n)).filter(Boolean)
    .map(([, scheme, host, port]) => originOf(`${scheme}://${host}${port !== '0' ? ':' + port : ''}`)).filter(Boolean);
}

class SiteData {
  constructor({ profile, store, sites }) {
    this.profile = profile;
    this.store = store;
    this.sites = sites;
  }

  get session() { return this.profile.session; }
  get settings() { return this.profile.permissions.settings; }

  // Bytes each origin keeps, read through the DevTools protocol on `wc` (a
  // Lumio page in the same profile). Unknown when that isn't possible.
  async usage(origins, wc) {
    const out = new Map();
    if (!wc || wc.isDestroyed() || !origins.length) return out;
    const dbg = wc.debugger;
    const attached = dbg.isAttached();
    try { if (!attached) dbg.attach('1.3'); } catch { return out; }
    try {
      for (let i = 0; i < origins.length; i += 20) {
        await Promise.all(origins.slice(i, i + 20).map(async (origin) => {
          const r = await dbg.sendCommand('Storage.getUsageAndQuota', { origin }).catch(() => null);
          if (r) out.set(origin, r.usage || 0);
        }));
      }
    } finally {
      if (!attached) { try { dbg.detach(); } catch { /* already gone */ } }
    }
    return out;
  }

  // Every site with data or settings: [{ site, usage, cookies, origins:
  // [{ origin, usage }], settings }], biggest first.
  async list(wc) {
    const cookies = await this.session.cookies.get({}).catch(() => []);
    const cookieHosts = new Map(); // host -> { count, secure }
    for (const c of cookies) {
      const h = String(c.domain).replace(/^\./, '');
      const e = cookieHosts.get(h) || { count: 0, secure: false };
      e.count++;
      e.secure ||= !!c.secure;
      cookieHosts.set(h, e);
    }
    const settled = new Set(this.settings.sites().map((s) => s.origin));
    const stored = new Set(indexedDbOrigins(this.session.storagePath));
    const visited = new Set();
    const history = this.store.history();
    for (let i = history.length - 1; i >= 0 && visited.size < 2000; i--) { const o = originOf(history[i].url); if (o) visited.add(o); }
    const cookieOrigins = [...cookieHosts].map(([h, e]) => originOf(`${e.secure ? 'https' : 'http'}://${h}`)).filter(Boolean);
    // Storage use is looked up for the likeliest origins first.
    const candidates = [...new Set([...stored, ...settled, ...cookieOrigins, ...visited])];
    const usage = await this.usage(candidates.slice(0, MAX_USAGE_LOOKUPS), wc);

    const groups = new Map();
    const group = async (origin) => {
      const site = await this.sites.siteOf(hostOf(origin));
      if (!groups.has(site)) groups.set(site, { site, usage: 0, cookies: 0, origins: new Map(), settings: false });
      return groups.get(site);
    };
    for (const origin of candidates) {
      const used = usage.get(origin) || 0;
      if (!used && !settled.has(origin) && !stored.has(origin)) continue;
      const g = await group(origin);
      g.origins.set(origin, (g.origins.get(origin) || 0) + used);
      g.usage += used;
      if (settled.has(origin)) g.settings = true;
    }
    for (const [host, { count }] of cookieHosts) {
      const g = await group(`https://${host}`);
      g.cookies += count;
      // A cookie for .example.com belongs to the site, not to an origin.
      if (!g.origins.size) g.origins.set(`https://${host}`, 0);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, origins: [...g.origins].map(([origin, used]) => ({ origin, usage: used })).sort((a, b) => b.usage - a.usage || a.origin.localeCompare(b.origin)) }))
      .sort((a, b) => b.usage - a.usage || b.cookies - a.cookies || a.site.localeCompare(b.site));
  }

  // One site's page: its storage and cookies.
  async details(origin, wc) {
    const site = await this.sites.siteOf(hostOf(origin));
    const cookies = await this.session.cookies.get({}).catch(() => []);
    const mine = [];
    for (const c of cookies) if (await this.sites.siteOf(String(c.domain).replace(/^\./, '')) === site) mine.push(c);
    const usage = await this.usage([origin], wc);
    return { origin, site, usage: usage.get(origin) ?? null, cookies: mine.length };
  }

  // Delete everything a site keeps (cookies go for the whole site, which is
  // how Chromium stores them). With permissions, its settings go too.
  async deleteSite(site, { permissions = false } = {}) {
    const origins = new Set([`https://${site}`, `http://${site}`]);
    for (const s of await this.list(null)) if (s.site === site) s.origins.forEach((o) => origins.add(o.origin));
    for (const s of this.settings.sites()) if (await this.sites.siteOf(hostOf(s.origin)) === site) origins.add(s.origin);
    // Cookies on hosts of this site that the list above didn't name.
    const cookies = await this.session.cookies.get({}).catch(() => []);
    for (const c of cookies) {
      if (await this.sites.siteOf(String(c.domain).replace(/^\./, '')) === site) await this.session.cookies.remove(cookieUrl(c), c.name).catch(() => {});
    }
    await this.session.clearData({ dataTypes: ALL_DATA, origins: [...origins] }).catch(() => {});
    if (permissions) for (const o of origins) this.settings.resetSite(o);
    return true;
  }

  async deleteAll() {
    await this.session.clearData({ dataTypes: ALL_DATA }).catch(() => {});
    return true;
  }
}

module.exports = { SiteData, indexedDbOrigins };
