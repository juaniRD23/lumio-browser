// What Lumio checks before a tab's page loads, for one profile (normal or
// incognito). In order:
//  1. Safe Browsing: a site on Lumio's lists of dangerous sites
//     (main/safe-browsing.js) is stopped. Frames from such sites are
//     stopped too, without a warning page.
//  2. Insecure forms: a secure (https) page sending a form to an http
//     address waits for "Send anyway".
//  3. Lookalikes: a site you've never visited that copies a well-known site
//     or one you visit often (main/lookalike.js) asks "Did you mean …?".
//  4. HTTPS-First ("Always use secure connections", off by default): http
//     addresses are opened as https. If that fails, or the site sends you
//     back to http, Lumio warns before opening the http page. Addresses on
//     this computer or the local network are left alone.
// A stopped page is replaced by Lumio's warning page (lumio://interstitial,
// renderer/pages/interstitial.*). From there the person goes back, or
// continues; continuing is remembered for the site until the profile ends
// (Lumio quits, or the last incognito window closes).
const privacy = require('./privacy');
const { lookalikeOf } = require('./lookalike');
const { isPrivateHost } = require('./safe-browsing');

const INTERSTITIAL = 'lumio://interstitial/';
// Load errors that aren't about https: the name doesn't exist, no internet,
// or the person stopped the page.
const NOT_HTTPS_ERRORS = new Set([-3, -105, -106, -137]);

// Names that don't belong to the public internet: intranet servers,
// printers, test machines.
const LOCAL_TLDS = new Set(['local', 'localhost', 'localdomain', 'test', 'example', 'invalid', 'internal', 'lan', 'home', 'corp', 'intranet', 'private', 'arpa']);

// Is a host left alone by HTTPS-First? IP addresses, single-word names
// (http://wiki/) and private names.
function isLocalName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.startsWith('[') || h.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (!h.includes('.')) return true;
  return LOCAL_TLDS.has(h.split('.').pop());
}

// The https address to try for an http one, or null. Only the default port
// is upgraded (other ports rarely speak https); ports maps test servers.
function httpsUrlFor(url, ports = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:') return null;
  if (u.port) {
    if (!ports[u.port]) return null;
    u.port = String(ports[u.port]);
  }
  u.protocol = 'https:';
  return u.href;
}

// The page a navigation starts from (its frame's address before it moves on).
function currentUrl(details) {
  try { if (details.frame?.url) return details.frame.url; } catch { /* frame is gone */ }
  try { return details.webContents?.getURL() || ''; } catch { return ''; }
}

// A form's body, ready to send again with loadURL.
function replayOptions(info) {
  if (!info.body?.length) return {};
  const postData = info.body.map((p) => (p.file ? { type: 'file', filePath: p.file } : { type: 'rawData', bytes: Buffer.from(p.bytes || []) })).filter((p) => p.filePath || p.bytes.length);
  const first = postData.find((p) => p.bytes)?.bytes.toString('latin1', 0, 200) || '';
  const boundary = /^--([^\r\n]+)\r\n/.exec(first)?.[1];
  return { postData, extraHeaders: `Content-Type: ${boundary ? `multipart/form-data; boundary=${boundary}` : 'application/x-www-form-urlencoded'}` };
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

class NavigationGuard {
  // settings(): Security settings (main/security.js). safeBrowsing: the
  // lists. sites: registrable domains (main/sites.js). targets(): sites to
  // compare lookalikes with. visited(host): has the person been there
  // before? isTab(wcId): is it a tab's page (only tabs show warnings)?
  constructor({ profile, settings, safeBrowsing, sites, targets = () => [], visited = () => false, isTab = () => false, ports = {} }) {
    this.profile = profile;
    this.settings = settings;
    this.safeBrowsing = safeBrowsing;
    this.sites = sites;
    this.targets = targets;
    this.visited = visited;
    this.isTab = isTab;
    this.ports = ports;
    this.blocked = new Map(); // wcId -> what stopped its page, until the page fails
    this.shown = new Map(); // wcId -> what its warning page is about
    this.upgrades = new Map(); // wcId -> { host, httpUrl, httpsUrl, at }: HTTPS-First trying https
    this.formHints = new Map(); // wcId -> { url, at }: the page's form is being sent (preload/internal.js)
    this.formPass = new Map(); // wcId -> url: "Send anyway", once
    this.allowed = { unsafe: new Set(), https: new Set(), lookalike: new Set() }; // hosts the person continued to
    this.unhook = privacy.hooks(profile.session).add({ name: 'navigation-guard', beforeRequest: (d) => this.beforeRequest(d) });
  }

  dispose() { this.unhook(); }

  async beforeRequest(d) {
    const main = d.resourceType === 'mainFrame';
    if (!main && d.resourceType !== 'subFrame') return false;
    let u;
    try { u = new URL(d.url); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname;
    const s = this.settings();
    const wcId = d.webContentsId;
    const tab = main && wcId != null && this.isTab(wcId);

    if (s.safeBrowsing !== 'off' && !this.allowed.unsafe.has(host)) {
      const hit = this.safeBrowsing.check(host, await this.sites.siteOf(host));
      if (hit) {
        if (tab) this.stop(wcId, { type: 'unsafe', url: d.url, threat: hit.threat });
        return true;
      }
    }
    if (!tab) return false;

    if (u.protocol === 'http:' && !isPrivateHost(host) && /^https:/i.test(currentUrl(d)) && this.isFormSubmission(wcId, d)) {
      if (this.formPass.get(wcId) === d.url) this.formPass.delete(wcId);
      else {
        this.stop(wcId, { type: 'form', url: d.url, method: d.method, body: d.method === 'POST' ? (d.uploadData || []).map((p) => ({ bytes: p.bytes, file: p.file })) : null });
        return true;
      }
    }

    if (s.lookalikes !== false && !isLocalName(host) && !this.allowed.lookalike.has(host) && !this.visited(host)) {
      const match = lookalikeOf(host, await this.sites.siteOf(host), this.targets());
      if (match) {
        this.stop(wcId, { type: 'lookalike', url: d.url, suggested: match.site });
        return true;
      }
    }

    if (s.httpsFirst && u.protocol === 'http:' && !isLocalName(host) && !this.allowed.https.has(host) && /^(GET|HEAD)$/i.test(d.method || 'GET')) {
      const up = this.upgrades.get(wcId);
      // The https site sent us back to http: it doesn't really support https.
      if (up && up.host === host && Date.now() - up.at < 30_000) {
        this.upgrades.delete(wcId);
        this.stop(wcId, { type: 'https', url: d.url, failedUrl: up.httpsUrl });
        return true;
      }
      const httpsUrl = httpsUrlFor(d.url, this.ports);
      if (httpsUrl) {
        this.upgrades.set(wcId, { host, httpUrl: d.url, httpsUrl, at: Date.now() });
        return { redirectURL: httpsUrl };
      }
    }
    return false;
  }

  // POST navigations are forms; a GET one is when the page said it's sending a form.
  isFormSubmission(wcId, d) {
    if (/^POST$/i.test(d.method || '')) return true;
    const hint = this.formHints.get(wcId);
    if (!hint || Date.now() - hint.at > 5000) return false;
    const same = hint.url.split('#')[0] === d.url.split('#')[0] || hint.url.split('?')[0] === d.url.split('?')[0];
    if (same) this.formHints.delete(wcId);
    return same;
  }

  // The page's preload saw a form being sent to `url`.
  formHint(wcId, url) {
    if (typeof url === 'string' && /^http:/i.test(url) && url.length < 8192) this.formHints.set(wcId, { url, at: Date.now() });
  }

  stop(wcId, info) { this.blocked.set(wcId, { ...info, at: Date.now() }); }

  // A tab's page failed to load (main/tabs.js asks before showing its error
  // page). True when Lumio shows its warning page instead.
  loadFailed(wc, code, url) {
    const b = this.blocked.get(wc.id);
    if (b && (code === -20 || b.url === url)) {
      this.blocked.delete(wc.id);
      this.show(wc, { failedUrl: b.url, ...b });
      return true;
    }
    const up = this.upgrades.get(wc.id);
    if (up && /^https:/i.test(url) && hostOf(url) === up.host) {
      this.upgrades.delete(wc.id);
      // No such site, or no connection at all: the usual error page says so better.
      if (NOT_HTTPS_ERRORS.has(code)) return false;
      this.show(wc, { type: 'https', url: up.httpUrl, failedUrl: url });
      return true;
    }
    return false;
  }

  // Is HTTPS-First trying this https address for this tab? A certificate
  // error there means "no https here": the tab shows Lumio's "Connection is
  // not secure" warning instead of a certificate warning.
  isUpgrade(wcId, url) {
    const up = this.upgrades.get(wcId);
    return !!up && /^https:/i.test(url) && hostOf(url) === up.host;
  }

  show(wc, info) {
    this.shown.set(wc.id, info);
    const q = new URLSearchParams({ type: info.type, url: info.url });
    if (info.threat) q.set('threat', info.threat);
    if (info.suggested) q.set('suggested', info.suggested);
    wc.loadURL(INTERSTITIAL + '?' + q).catch(() => {});
  }

  // What a tab's warning page is about. A page reloaded after Lumio
  // restarted only has its address: that's trusted, because web pages can't
  // open lumio:// pages.
  info(wc) {
    let info = this.shown.get(wc.id);
    if (!info) {
      try {
        const p = new URL(wc.getURL()).searchParams;
        if (['unsafe', 'https', 'lookalike', 'form'].includes(p.get('type')) && /^https?:/.test(p.get('url') || '')) {
          info = { type: p.get('type'), url: p.get('url'), threat: p.get('threat') || null, suggested: p.get('suggested') || null };
          this.shown.set(wc.id, info);
        }
      } catch { /* not a warning page */ }
    }
    if (!info) return null;
    const h = wc.navigationHistory;
    return { type: info.type, url: info.url, host: hostOf(info.url), threat: info.threat || null, suggested: info.suggested || null, canGoBack: h.getActiveIndex() > 0 };
  }

  // Continue to the page anyway.
  proceed(wc) {
    const info = this.shown.get(wc.id);
    if (!info) return false;
    const host = hostOf(info.url);
    if (info.type === 'unsafe') this.allowed.unsafe.add(host);
    if (info.type === 'https') this.allowed.https.add(host);
    if (info.type === 'lookalike') this.allowed.lookalike.add(host);
    if (info.type === 'form') this.formPass.set(wc.id, info.url);
    wc.loadURL(info.url, info.type === 'form' ? replayOptions(info) : {}).catch(() => {});
    return true;
  }

  // Lookalikes: go to the site it copies.
  goSuggested(wc) {
    const info = this.shown.get(wc.id);
    if (info?.type !== 'lookalike' || !info.suggested) return false;
    wc.loadURL(`https://${info.suggested}/`).catch(() => {});
    return true;
  }

  // Back to the page before the one that was stopped (or a new tab page).
  back(wc, fallback) {
    const info = this.shown.get(wc.id);
    const h = wc.navigationHistory;
    const entries = h.getAllEntries();
    for (let i = h.getActiveIndex() - 1; i >= 0; i--) {
      const url = entries[i]?.url || '';
      if (info && (url === info.url || url === info.failedUrl)) continue;
      h.goToIndex(i);
      return true;
    }
    wc.loadURL(fallback).catch(() => {});
    return true;
  }

  // Called for every tab page (and again after a rebuild).
  attach(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.lumioGuard) return;
    wc.lumioGuard = true;
    const id = wc.id;
    wc.on('did-navigate', (_e, url) => {
      this.upgrades.delete(id);
      // Keep history tidy: no entry for the page that was stopped, and none
      // for the warning once the person continued past it.
      setImmediate(() => { if (!wc.isDestroyed()) this.tidy(wc, url); });
      if (!url.startsWith(INTERSTITIAL)) this.shown.delete(id);
    });
    wc.once('destroyed', () => { for (const m of [this.blocked, this.shown, this.upgrades, this.formHints, this.formPass]) m.delete(id); });
  }

  tidy(wc, url) {
    const h = wc.navigationHistory;
    const i = h.getActiveIndex();
    if (i < 1) return;
    const prev = h.getEntryAtIndex(i - 1)?.url || '';
    const info = this.shown.get(wc.id);
    const stale = url.startsWith(INTERSTITIAL)
      ? info && (prev === info.failedUrl || prev === info.url)
      : prev.startsWith(INTERSTITIAL) && (() => { try { return hostOf(new URL(prev).searchParams.get('url')) === hostOf(url); } catch { return false; } })();
    if (stale) { try { h.removeEntryAtIndex(i - 1); } catch { /* it's fine to keep it */ } }
  }
}

module.exports = { NavigationGuard, isLocalName, httpsUrlFor, replayOptions, INTERSTITIAL };
