// Protocol handlers: a site like Gmail asks to open every mailto: link
// (navigator.registerProtocolHandler). Electron 43 accepts the call and does
// nothing with it, so the tab preload replaces it (preload/internal.js) and
// sends it here. Lumio asks in the permission bar ("mail.google.com wants
// to open all email links"). Allow saves the site's address for that scheme
// in settings.protocolHandlers; Block remembers not to ask that site again.
// Settings › Site settings › Protocol handlers lists both, with Remove.
//
// A link with a handled scheme then opens the site's page instead of
// another app: in a new tab next to the one you're on, so the page you were
// reading stays, or in the tab itself when it was opened just for the link.
//
// Limits: only a tab's top frame can register (that's where the preload
// runs); incognito windows use the saved handlers but can't add one; each
// scheme has one handler, the one allowed last; the schemes are the HTML
// standard's safe list plus web+name ones. Only links opened inside Lumio
// are routed: Lumio isn't the computer's mail app, so a mailto: link in
// another app still opens that app. A site can take its own handler back
// with navigator.unregisterProtocolHandler().

const SAFE_SCHEMES = new Set(['bitcoin', 'cabal', 'dat', 'did', 'doi', 'dweb', 'ethereum', 'ftp', 'geo', 'hyper', 'im', 'ipfs', 'ipns', 'irc',
  'ircs', 'magnet', 'mailto', 'matrix', 'mms', 'news', 'nntp', 'openpgp4fpr', 'sftp', 'sip', 'sms', 'smsto', 'ssb', 'ssh', 'tel', 'urn',
  'webcal', 'wtai', 'xmpp']);
const NAMES = { mailto: 'email', webcal: 'calendar', tel: 'phone number', sms: 'text message', smsto: 'text message' };
const KEY = 'protocolHandlers';

// What links a scheme makes, in words: 'email links', 'web+notes: links'.
const linksOf = (scheme) => (NAMES[scheme] ? `${NAMES[scheme]} links` : `${scheme}: links`);

// https, or http on this computer (what browsers count as secure).
function trustworthy(u) {
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || u.hostname.endsWith('.localhost'));
}

// The HTML standard's checks, which Lumio repeats instead of trusting the page.
// Returns { scheme, url, origin, host } or { error: DOMException name, message }.
function normalize(scheme, url, pageUrl) {
  const fail = (error, message) => ({ error, message });
  let page;
  try { page = new URL(String(pageUrl)); } catch { return fail('SecurityError', 'This page can’t register protocol handlers.'); }
  if (!trustworthy(page)) return fail('SecurityError', 'Only secure (https) pages can register protocol handlers.');
  const s = String(scheme ?? '').toLowerCase();
  if (!SAFE_SCHEMES.has(s) && !/^web\+[a-z]+$/.test(s)) return fail('SecurityError', `The scheme '${s}' can’t be handled by a website.`);
  const raw = String(url ?? '');
  if (!raw.includes('%s')) return fail('SyntaxError', 'The URL must contain %s.');
  let u;
  try { u = new URL(raw, page.href); } catch { return fail('SyntaxError', 'The URL isn’t valid.'); }
  if (!/^https?:$/.test(u.protocol) || u.origin !== page.origin) return fail('SecurityError', 'The URL must be on the same site as the page.');
  if (u.href.length > 2048) return fail('SyntaxError', 'The URL is too long.');
  return { scheme: s, url: u.href, origin: page.origin, host: page.host };
}

// Where a link goes with a handler: the first %s becomes the whole link, escaped.
const fill = (template, link) => template.replace('%s', encodeURIComponent(link));

const schemeOf = (url) => { const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || '')); return m ? m[1].toLowerCase() : ''; };

class ProtocolHandlers {
  // store: settings. tabOf(wc) -> { w, tab } for a tab's page.
  constructor({ store, tabOf }) {
    this.store = store;
    this.tabOf = tabOf;
    this.pending = new Map(); // id -> { scheme, url, origin, host, wcId, w }
    this.seq = 0;
  }

  // [{ scheme, url, origin, host, allowed, time }]: allowed ones are handlers, the others blocked sites.
  all() { return Array.isArray(this.store.settings[KEY]) ? this.store.settings[KEY] : []; }
  save(list) { this.store.setSetting(KEY, list); }
  handlerFor(scheme) { return this.all().find((h) => h.allowed && h.scheme === scheme) || null; }

  // Where a link with a handled scheme goes instead, or null.
  target(link) {
    const h = this.handlerFor(schemeOf(link));
    return h ? fill(h.url, link) : null;
  }

  // A page called navigator.registerProtocolHandler (from the preload).
  register(wc, pageUrl, scheme, url) {
    const found = this.tabOf(wc);
    if (!found || found.w.incognito) return { ok: false };
    const h = normalize(scheme, url, pageUrl);
    if (h.error) return { ok: false, error: h.error };
    const current = this.handlerFor(h.scheme);
    if (current?.url === h.url) return { ok: true }; // already
    if (this.all().some((x) => !x.allowed && x.scheme === h.scheme && x.origin === h.origin)) return { ok: false }; // blocked
    const asking = [...this.pending.values()];
    if (asking.some((p) => p.scheme === h.scheme && p.origin === h.origin) || asking.filter((p) => p.wcId === wc.id).length >= 3) return { ok: true };
    const id = `ph-${++this.seq}`; // apart from Permissions' numbers: both answer 'permission:respond'
    this.pending.set(id, { ...h, wcId: wc.id, w: found.w });
    const instead = current && current.origin !== h.origin ? ` instead of ${current.host}` : '';
    found.w.emit('permission', { id, origin: h.origin, host: h.host, permission: 'protocol-handler', label: `open all ${linksOf(h.scheme)}${instead}`, wcId: wc.id });
    return { ok: true, asked: id };
  }

  // The permission bar's answer (Allow or Block). Other ids are Permissions'.
  respond(id, allow) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    // One entry per site and scheme, and one handler per scheme.
    const rest = this.all().filter((x) => !(x.scheme === p.scheme && (x.origin === p.origin || (allow && x.allowed))));
    this.save([...rest, { scheme: p.scheme, url: p.url, origin: p.origin, host: p.host, allowed: !!allow, time: Date.now() }]);
    return true;
  }

  // The page that asked went away: take its question off the bar.
  cancelFor(wcId) {
    for (const [id, p] of this.pending) {
      if (p.wcId !== wcId) continue;
      this.pending.delete(id);
      if (!p.w.closed) p.w.emit('permission-cancel', { id });
    }
  }

  // A page called navigator.unregisterProtocolHandler: only its own site's
  // handler, with the same URL, goes away (a block stays).
  unregister(wc, pageUrl, scheme, url) {
    if (!this.tabOf(wc)) return false;
    const h = normalize(scheme, url, pageUrl);
    if (h.error) return false;
    const list = this.all();
    const rest = list.filter((x) => !(x.allowed && x.scheme === h.scheme && x.origin === h.origin && x.url === h.url));
    if (rest.length !== list.length) this.save(rest);
    return rest.length !== list.length;
  }

  remove(scheme, origin) {
    this.save(this.all().filter((x) => !(x.scheme === scheme && x.origin === origin)));
    return this.list();
  }

  // For Settings.
  list() {
    return this.all().map(({ scheme, url, origin, host, allowed }) => ({ scheme, url, origin, host, allowed, what: linksOf(scheme) }));
  }

  // Follows the navigations of a webContents: links with a handled scheme
  // go to the handler (only in tabs).
  watch(wc) {
    // A link or script in the page: open the handler beside it. One tab a
    // second at most, so a script can't open a flood of them.
    let opened = 0;
    wc.on('will-frame-navigate', (e) => {
      const to = this.target(e.url);
      const found = to && this.tabOf(wc);
      if (!found) return;
      e.preventDefault();
      if (Date.now() - opened < 1000) return;
      opened = Date.now();
      const { w, tab } = found;
      w.tabs.create(to, { index: w.tabs.tabs.indexOf(tab) + 1 });
    });
    // Lumio itself loading the link (a tab opened for a target=_blank link,
    // a bookmark): that tab goes to the handler. Not cancelable here, so
    // it loads the handler right after.
    wc.on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isSameDocument || e.initiator) return;
      const to = this.target(e.url);
      // A new tab's first page starts loading before the tab is in its window's list.
      if (to) setImmediate(() => { if (!wc.isDestroyed() && this.tabOf(wc)) wc.loadURL(to).catch(() => {}); });
    });
    wc.on('did-navigate', () => this.cancelFor(wc.id));
    const id = wc.id;
    wc.once('destroyed', () => this.cancelFor(id));
  }
}

module.exports = { ProtocolHandlers, normalize, fill, schemeOf, linksOf, trustworthy, SAFE_SCHEMES };
