// Certificate errors. Lumio never trusts a bad certificate by itself: the tab
// shows "Your connection is not private" (renderer/pages/cert.html), and only
// the person's "Proceed to … (unsafe)" there lets that site's certificate
// through, for this session only (incognito keeps its own list). The address
// bar then says "Not secure". Like Chrome, there's no way through for errors
// that are never safe to skip (a revoked certificate) or for sites that told
// the browser to always use a valid one (HSTS).

// Errors you may click through, as in Chrome. Anything else has no Proceed.
const OVERRIDABLE = new Set([
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_NO_REVOCATION_MECHANISM', 'ERR_CERT_UNABLE_TO_CHECK_REVOCATION', 'ERR_CERT_WEAK_SIGNATURE_ALGORITHM',
  'ERR_CERT_WEAK_KEY', 'ERR_CERT_NAME_CONSTRAINT_VIOLATION', 'ERR_CERT_VALIDITY_TOO_LONG', 'ERR_CERT_SYMANTEC_LEGACY',
]);

// Why the certificate failed, in a sentence for the Advanced section.
const REASONS = {
  ERR_CERT_COMMON_NAME_INVALID: 'Its security certificate is for a different website. This may be caused by a misconfiguration or an attacker intercepting your connection.',
  ERR_CERT_DATE_INVALID: "Its security certificate has expired or isn't valid yet. This may be caused by a misconfiguration, an attacker intercepting your connection, or your computer's clock being wrong.",
  ERR_CERT_AUTHORITY_INVALID: "Its security certificate isn't trusted by your computer. This may be caused by a misconfiguration or an attacker intercepting your connection.",
  ERR_CERT_REVOKED: 'Its security certificate has been revoked by the company that issued it.',
  ERR_CERT_WEAK_SIGNATURE_ALGORITHM: 'Its security certificate is signed with a weak method that attackers can forge.',
  ERR_CERT_WEAK_KEY: 'Its security certificate uses a weak key.',
};

// session -> Map(host -> Set(certificate fingerprints you chose to trust))
const exceptions = new WeakMap();
// session -> Map(host -> Promise<boolean>): does the site require HTTPS (HSTS)?
const hstsCache = new WeakMap();

// 'net::ERR_CERT_DATE_INVALID' or 'ERR_CERT_DATE_INVALID' -> 'ERR_CERT_DATE_INVALID'
const errorName = (error) => String(error || '').replace(/^net::/i, '').toUpperCase();
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

function isAllowed(ses, host, fingerprint) {
  return !!(ses && host && fingerprint && exceptions.get(ses)?.get(host)?.has(fingerprint));
}

function allow(ses, host, fingerprint) {
  if (!ses || !host || !fingerprint) return;
  if (!exceptions.has(ses)) exceptions.set(ses, new Map());
  const hosts = exceptions.get(ses);
  if (!hosts.has(host)) hosts.set(host, new Set());
  hosts.get(host).add(fingerprint);
}

// "Turn on warnings" in the site information popup.
function revoke(ses, host) {
  exceptions.get(ses)?.delete(host);
}

// Is this https page on a site whose certificate error you clicked through?
// The address bar then shows "Not secure" in red.
function bypassed(ses, url) {
  if (!ses || !/^https:/i.test(String(url || ''))) return false;
  return !!exceptions.get(ses)?.get(hostOf(url))?.size;
}

// What the warning page shows about a failed certificate (never its key).
function record(url, error, cert = {}) {
  const name = errorName(error);
  const day = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : '');
  const principal = (p, fallback) => [p?.commonName || fallback, ...(p?.organizations || [])].filter(Boolean).join(', ');
  return {
    url: String(url || ''),
    host: hostOf(url),
    error: name,
    code: `NET::${name}`,
    overridable: OVERRIDABLE.has(name),
    reason: REASONS[name] || "Its security certificate isn't valid.",
    fingerprint: String(cert.fingerprint || ''),
    cert: {
      subject: principal(cert.subject, cert.subjectName),
      issuer: principal(cert.issuer, cert.issuerName),
      validFrom: day(cert.validStart),
      validTo: day(cert.validExpiry),
      fingerprint: String(cert.fingerprint || ''),
    },
  };
}

// Does the site require a valid certificate (HSTS, including Chromium's
// built-in list)? The network stack turns such http:// requests into https://
// itself, before connecting, with "Non-Authoritative-Reason: HSTS". Asking for
// http://host/ without following redirects tells us; for other sites it's
// stopped at the first answer. IP addresses never use HSTS.
// request: (options) => ClientRequest (Electron's net.request; tests pass a stand-in).
function usesHsts(ses, host, { request = (o) => require('electron').net.request(o), timeout = 1500 } = {}) {
  let hostname;
  try { hostname = new URL(`https://${host}`).hostname; } catch { return Promise.resolve(false); }
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.startsWith('[')) return Promise.resolve(false);
  if (!hstsCache.has(ses)) hstsCache.set(ses, new Map());
  const cache = hstsCache.get(ses);
  if (!cache.has(hostname)) {
    cache.set(hostname, new Promise((resolve) => {
      let req = null;
      let timer = null;
      const done = (hsts) => {
        clearTimeout(timer);
        try { req?.abort(); } catch { /* already finished */ }
        resolve(hsts);
      };
      timer = setTimeout(() => done(false), timeout);
      try {
        req = request({ url: `http://${hostname}/`, session: ses, redirect: 'manual', credentials: 'omit' });
        req.on('redirect', (_status, _method, location, headers = {}) => {
          const reason = Object.entries(headers).find(([k]) => k.toLowerCase() === 'non-authoritative-reason')?.[1];
          done(/hsts/i.test(String(reason)) && /^https:/i.test(String(location)));
        });
        req.on('response', () => done(false));
        req.on('error', () => done(false));
        req.end();
      } catch {
        done(false);
      }
    }));
  }
  return cache.get(hostname);
}

module.exports = { OVERRIDABLE, isAllowed, allow, revoke, bypassed, record, usesHsts, errorName };
