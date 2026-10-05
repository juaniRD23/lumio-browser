// Sites: the registrable domain of a host ("example.co.uk" for
// a.b.example.co.uk), which decides what counts as third-party.
//
// Lumio doesn't ship its own copy of the public suffix list: it asks
// Chromium's. Chromium refuses a cookie whose Domain is a public suffix
// (co.uk, github.io…) and accepts one for the registrable domain or below,
// so setting a test cookie in a throwaway in-memory session shows where the
// suffix ends. Answers are cached, so each new host costs one or two quick
// checks. If that check ever stops working (a self-test runs first), a small
// built-in list of common suffixes is used instead.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIp = (host) => IPV4.test(host) || host.includes(':') || host.startsWith('[');

// Second-level suffixes common enough to matter when the cookie check
// isn't available (country codes like co.uk, com.au, co.jp).
const FALLBACK_SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'sch', 'nhs', 'police']);
function fallbackSite(host) {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels.at(-1);
  const sld = labels.at(-2);
  const n = tld.length === 2 && FALLBACK_SLD.has(sld) ? 3 : 2;
  return labels.slice(-n).join('.');
}

class SiteResolver {
  // probe(host, domain) → Promise<boolean>: may `host` set a cookie for
  // `domain`? (false when `domain` is a public suffix.)
  constructor(probe) {
    this.probe = probe;
    this.cache = new Map(); // host -> site
    this.suffixes = new Set(); // domains known to be public suffixes
    this.pending = new Map();
    this.working = null; // the self-test's promise
  }

  // The cached answer, or undefined when it needs a check.
  cached(host) {
    const h = normalize(host);
    if (!h) return '';
    if (isIp(h) || !h.includes('.')) return h;
    return this.cache.get(h);
  }

  async siteOf(host) {
    const h = normalize(host);
    if (!h) return '';
    const hit = this.cached(h);
    if (hit !== undefined) return hit;
    if (!this.pending.has(h)) this.pending.set(h, this.resolve(h).finally(() => this.pending.delete(h)));
    return this.pending.get(h);
  }

  async resolve(host) {
    this.working ??= this.selfTest();
    let site = host;
    if (!(await this.working)) site = fallbackSite(host);
    else {
      const labels = host.split('.');
      // The shortest ending of the host that may hold cookies is the site.
      for (let i = labels.length - 1; i >= 0; i--) {
        const domain = labels.slice(i).join('.');
        if (this.suffixes.has(domain)) continue;
        if (await this.probe(host, domain).catch(() => false)) { site = domain; break; }
        this.suffixes.add(domain);
      }
    }
    this.cache.set(host, site);
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
    return site;
  }

  // The check must accept example.com and refuse com and co.uk.
  async selfTest() {
    try {
      const ok = await this.probe('www.example.com', 'example.com');
      const com = await this.probe('www.example.com', 'com');
      const couk = await this.probe('www.example.co.uk', 'co.uk');
      return ok && !com && !couk;
    } catch { return false; }
  }
}

function normalize(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

// The probe for Electron: a test cookie in an in-memory session that never
// loads a page. Cleared now and then so it doesn't grow.
function cookieProbe(session) {
  const ses = session.fromPartition('lumio-site-check');
  let count = 0;
  return async (host, domain) => {
    if (++count % 200 === 0) ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
    try {
      await ses.cookies.set({ url: `https://${host}/`, name: 'lumio_site_check', value: '1', domain: '.' + domain, path: '/', secure: true });
      return true;
    } catch { return false; }
  };
}

module.exports = { SiteResolver, cookieProbe, fallbackSite, hostOf, isIp };
