// Secure DNS (Settings › Privacy and security › Security › Use secure DNS):
// look up site addresses over an encrypted connection (DNS over HTTPS), so
// the network you're on can't see or change which sites you visit.
//  - On, with your current provider (the default): Chromium's "automatic"
//    mode, which uses encrypted DNS when your provider offers it.
//  - On, with a provider you pick: only that provider, always encrypted.
//  - Off: your network's usual DNS.
// Applied with app.configureHostResolver when Lumio starts and whenever the
// setting changes.

const PROVIDERS = [
  { id: 'os', name: 'Your current service provider' },
  { id: 'cloudflare', name: 'Cloudflare (1.1.1.1)', template: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google', name: 'Google (Public DNS)', template: 'https://dns.google/dns-query{?dns}' },
  { id: 'quad9', name: 'Quad9 (9.9.9.9)', template: 'https://dns.quad9.net/dns-query' },
  { id: 'custom', name: 'Custom' },
];

// Is this a DNS-over-HTTPS address Chromium can use (RFC 8484)? An https
// URL, optionally ending in the {?dns} variable.
function validTemplate(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 500 || /\s/.test(t)) return false;
  const vars = t.match(/\{[^}]*\}/g) || [];
  if (vars.length > 1 || (vars[0] && vars[0] !== '{?dns}') || (vars[0] && !t.endsWith('{?dns}'))) return false;
  try {
    const u = new URL(t.replace('{?dns}', ''));
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch { return false; }
}

// The resolver options for a setting ({ on, provider, custom }).
function resolverOptions(dns = {}) {
  if (dns.on === false) return { secureDnsMode: 'off', secureDnsServers: [] };
  const p = PROVIDERS.find((x) => x.id === dns.provider) || PROVIDERS[0];
  const template = p.id === 'custom' ? String(dns.custom || '').trim() : p.template;
  if (!template || !validTemplate(template)) return { secureDnsMode: 'automatic', secureDnsServers: [] };
  return { secureDnsMode: 'secure', secureDnsServers: [template] };
}

// A DNS question for the A record of `name`, in the wire format DoH servers take.
function dnsQuery(name = 'example.com') {
  const labels = name.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  // id 0 (RFC 8484 asks for it, for caching), recursion desired, one question.
  const header = Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

// Does a custom provider answer? Asks it for example.com's address.
async function testProvider(template, fetchImpl, { timeout = 6000 } = {}) {
  if (!validTemplate(template)) return { ok: false, error: 'Enter an address that starts with https://' };
  const q = dnsQuery().toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = template.replace('{?dns}', '');
  const url = `${base}${base.includes('?') ? '&' : '?'}dns=${q}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/dns-message' }, signal: ctrl.signal, cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    const body = Buffer.from(await res.arrayBuffer());
    // A DNS answer: our id (0), "response" bit set, and no error code.
    const ok = res.ok && /dns-message/.test(type) && body.length >= 12 && body[2] & 0x80 && (body[3] & 0x0f) === 0;
    return ok ? { ok: true } : { ok: false, error: 'This doesn’t look like a secure DNS provider. Check the address.' };
  } catch {
    return { ok: false, error: 'Couldn’t reach this provider. Check the address and your connection.' };
  } finally {
    clearTimeout(timer);
  }
}

// app: Electron's app (configureHostResolver). Never throws: a bad setting
// must not stop Lumio from browsing.
function applySecureDns(app, dns) {
  const options = resolverOptions(dns);
  try { app.configureHostResolver(options); } catch (err) { console.error('[lumio] secure DNS:', err?.message || err); }
  return options;
}

module.exports = { PROVIDERS, validTemplate, resolverOptions, dnsQuery, testProvider, applySecureDns };
