// Network hooks for the tab sessions (normal and incognito).
//
// Electron keeps only one listener per webRequest event and session, so
// every feature that needs one adds a handler here instead of calling
// ses.webRequest itself:
//
//   const net = privacy.hooks(session);
//   net.add({
//     name: 'do-not-track',
//     active: () => true,                       // installed only while some handler is active
//     beforeRequest(details) { return false },  // true cancels the request; { redirectURL } sends it elsewhere
//     beforeSendHeaders(details, headers) {},   // change request headers in place
//     headersReceived(details, headers) {},     // change response headers in place
//   });
//   net.refresh();                              // after a setting changes what's active
//
// Handlers may be async and run in the order they were added. A listener is
// only installed while a handler that uses it is active, so with the default
// settings normal windows pay nothing per request.
//
// Third-party cookies (Settings › Privacy and security › Third-party cookies)
// live here too: Cookie and Set-Cookie headers are dropped on requests to a
// different site than the tab's top page.
const { hostOf } = require('./sites');

const WEB = /^(https?|wss?):/i;

// The address of the page a request belongs to (the tab's top frame).
function topUrlOf(details) {
  if (details.resourceType === 'mainFrame') return details.url;
  try { const top = details.frame?.top; if (top?.url) return top.url; } catch { /* frame is gone */ }
  try { const wc = details.webContents; if (wc && !wc.isDestroyed()) return wc.getURL(); } catch { /* closed */ }
  return '';
}

// Header names are case-insensitive; Electron keeps them as sent.
const headerKeys = (headers, name) => Object.keys(headers).filter((k) => k.toLowerCase() === name);
function dropHeader(headers, name) {
  const keys = headerKeys(headers, name);
  for (const k of keys) delete headers[k];
  return keys.length > 0;
}
function headerValue(headers, name) {
  const k = headerKeys(headers, name)[0];
  if (!k) return '';
  const v = headers[k];
  return Array.isArray(v) ? v.join(', ') : String(v ?? '');
}

const KINDS = ['beforeRequest', 'beforeSendHeaders', 'headersReceived'];

class NetworkHooks {
  constructor(session) {
    this.session = session;
    this.handlers = [];
    // The active handlers for each event, worked out by refresh() (not per request).
    this.current = { beforeRequest: [], beforeSendHeaders: [], headersReceived: [] };
  }

  add(handler) {
    this.handlers.push(handler);
    this.refresh();
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); this.refresh(); };
  }

  live(kind) { return this.current[kind]; }

  refresh() {
    const wr = this.session.webRequest;
    const run = { beforeRequest: this.runBeforeRequest, beforeSendHeaders: this.runSendHeaders, headersReceived: this.runHeadersReceived };
    const install = { beforeRequest: 'onBeforeRequest', beforeSendHeaders: 'onBeforeSendHeaders', headersReceived: 'onHeadersReceived' };
    for (const kind of KINDS) {
      const was = this.current[kind].length > 0;
      this.current[kind] = this.handlers.filter((h) => typeof h[kind] === 'function' && (!h.active || h.active()));
      const now = this.current[kind].length > 0;
      if (was !== now) wr[install[kind]](now ? (d, cb) => run[kind].call(this, d, cb) : null);
    }
  }

  // A handler that throws never blocks the request: it's skipped.
  async runBeforeRequest(details, callback) {
    if (!WEB.test(details.url)) return callback({});
    for (const h of this.live('beforeRequest')) {
      try {
        const answer = await h.beforeRequest(details);
        if (answer?.redirectURL) return callback({ redirectURL: answer.redirectURL });
        if (answer) return callback({ cancel: true });
      } catch (err) { console.error(`[lumio] ${h.name}:`, err?.message || err); }
    }
    callback({});
  }

  async runSendHeaders(details, callback) {
    if (!WEB.test(details.url)) return callback({});
    const headers = { ...details.requestHeaders };
    for (const h of this.live('beforeSendHeaders')) {
      try { await h.beforeSendHeaders(details, headers); } catch (err) { console.error(`[lumio] ${h.name}:`, err?.message || err); }
    }
    callback({ requestHeaders: headers });
  }

  async runHeadersReceived(details, callback) {
    if (!WEB.test(details.url) || !details.responseHeaders) return callback({});
    const headers = { ...details.responseHeaders };
    let changed = false;
    for (const h of this.live('headersReceived')) {
      try { if (await h.headersReceived(details, headers)) changed = true; } catch (err) { console.error(`[lumio] ${h.name}:`, err?.message || err); }
    }
    callback(changed ? { responseHeaders: headers } : {});
  }
}

const bySession = new WeakMap();
// The hooks for a session (made on first use).
function hooks(session) {
  if (!bySession.has(session)) bySession.set(session, new NetworkHooks(session));
  return bySession.get(session);
}

// ---------------------------------------------------------------- third-party cookies
// mode: 'allow', 'block-incognito' (the default) or 'block'. Sites allowed in
// Settings may use third-party cookies on their pages. Only cookies sent over
// the network are covered: a third-party frame's own scripts can still read
// document.cookie, which Electron doesn't let Lumio switch off per site.
function thirdPartyCookies({ settings, sites, incognito }) {
  let allowed = null; // sites allowed to use third-party cookies (resolved lazily)
  settings.onChange((_origin, id) => { if (!id || id === 'thirdPartyCookies') allowed = null; });
  const allowedSites = async () => {
    if (!allowed) {
      const list = settings.effectiveExceptions('thirdPartyCookies').filter((e) => e.value === 'allow');
      allowed = new Set(await Promise.all(list.map((e) => sites.siteOf(hostOf(e.origin)))));
    }
    return allowed;
  };
  const blocking = () => {
    const mode = settings.defaultOf('thirdPartyCookies');
    return mode === 'block' || (mode === 'block-incognito' && incognito);
  };
  // Is this request going to a different site than the page it's for?
  async function thirdParty(details) {
    if (details.resourceType === 'mainFrame') return false;
    const top = topUrlOf(details);
    if (!/^https?:/i.test(top)) return false; // Lumio's own pages, files: nothing to track across
    const [mine, theirs] = await Promise.all([sites.siteOf(hostOf(top)), sites.siteOf(hostOf(details.url))]);
    if (!mine || !theirs || mine === theirs) return false;
    return !(await allowedSites()).has(mine);
  }
  return {
    name: 'third-party-cookies',
    active: blocking,
    async beforeSendHeaders(details, headers) {
      if (headerKeys(headers, 'cookie').length && await thirdParty(details)) dropHeader(headers, 'cookie');
    },
    async headersReceived(details, headers) {
      return headerKeys(headers, 'set-cookie').length > 0 && await thirdParty(details) && dropHeader(headers, 'set-cookie');
    },
    thirdParty, // for tests
  };
}

module.exports = { hooks, NetworkHooks, thirdPartyCookies, topUrlOf, headerKeys, headerValue, dropHeader };
