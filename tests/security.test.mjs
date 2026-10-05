// Security and privacy protections, without Electron: Safe Browsing's lists
// and download checks (main/safe-browsing.js), the warning pages' decisions
// (navigation-guard.js), lookalike sites and safe international addresses
// (lookalike.js), secure DNS (secure-dns.js), Password Checkup
// (password-checkup.js), tracking protection and unused permissions
// (privacy-extras.js), capture indicators (capture.js), client certificates
// (certificates.js), device choosers (device-chooser.js), the settings
// (security.js), and the hooks in features.js and protocol.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// A stand-in for the few Electron parts these modules touch outside a running app.
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => os.tmpdir() }, shell: {}, dialog: {}, webContents: { fromFrame: () => null, fromId: () => null } } };
const { Store } = require('../main/store.js');
const { SiteSettings, BY_ID } = require('../main/site-settings.js');
const { SiteResolver } = require('../main/sites.js');
const sb = require('../main/safe-browsing.js');
const { NavigationGuard, isLocalName, httpsUrlFor, replayOptions } = require('../main/navigation-guard.js');
const look = require('../main/lookalike.js');
const dns = require('../main/secure-dns.js');
const { PasswordCheckup, parseRange, sha1 } = require('../main/password-checkup.js');
const { PrivacyExtras, UnusedPermissions, trackerMatch } = require('../main/privacy-extras.js');
const { CaptureTracker, shareableTabs } = require('../main/capture.js');
const { ClientCertificates, certificateManager, certInfo } = require('../main/certificates.js');
const { DeviceChoosers, describe: describeDevice, listed } = require('../main/device-chooser.js');
const { readSettings, cleanPatch, DEFAULTS } = require('../main/security.js');
const { Downloads, Permissions } = require('../main/features.js');
const { resolveFile, PAGE_HOSTS } = require('../main/protocol.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-sec-'));
const store = () => new Store(tmp(), null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A small public suffix list: what Chromium's cookie check would say.
const SUFFIXES = new Set(['com', 'net', 'org', 'dev', 'test', 'uk', 'co.uk', 'ru']);
const resolver = () => new SiteResolver(async (host, domain) => !SUFFIXES.has(domain) && (host === domain || host.endsWith('.' + domain)));

function fakeSession() {
  const listeners = {};
  const wr = {};
  for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']) wr[name] = (fn) => { listeners[name] = fn; };
  const ses = new EventEmitter();
  return Object.assign(ses, { webRequest: wr, listeners, setPermissionCheckHandler: (fn) => { ses.check = fn; }, setPermissionRequestHandler: (fn) => { ses.request = fn; } });
}
const run = (ses, name, details) => new Promise((resolve) => ses.listeners[name](details, resolve));

// Safe Browsing with these hosts already listed.
function listsWith(hosts, threat = 'phishing') {
  const s = new sb.SafeBrowsing({ dir: tmp(), fetchImpl: async () => { throw new Error('offline'); }, sources: [{ id: 'test', threat, url: 'x' }] });
  s.lists.set('test', new sb.HashList(new BigUint64Array(hosts.map(sb.hashHost)).sort()));
  return s;
}

// ---------------------------------------------------------------- Safe Browsing
test('Safe Browsing: list lines in every common format; comments, IPs on this computer and junk are skipped', () => {
  assert.equal(sb.parseLine('evil.example.com'), 'evil.example.com');
  assert.equal(sb.parseLine('0.0.0.0 Evil.Example.com # tracker'), 'evil.example.com');
  assert.equal(sb.parseLine('||phish.example.net^'), 'phish.example.net');
  assert.equal(sb.parseLine('*.wild.example.org'), 'wild.example.org');
  assert.equal(sb.parseLine('# a comment'), null);
  assert.equal(sb.parseLine('127.0.0.1 localhost'), null);
  assert.equal(sb.parseLine('192.168.1.10'), null, 'a home network address is never listed');
  assert.equal(sb.parseLine('203.0.113.9'), '203.0.113.9');
  assert.equal(sb.parseLine('not a host!'), null);
  assert.deepEqual(sb.parseList('a.example.com\n\n! x\nb.example.com\r\n'), ['a.example.com', 'b.example.com']);
});

test('Safe Browsing: a listed host and its subdomains are found; well-known sites and local ones never are', async () => {
  const hashes = await sb.buildHashes('evil.example.com\nevil.example.com\nbad.github.io\ngoogle.com\ndocs.google.com\n');
  assert.equal(hashes.length, 3, 'duplicates and well-known sites are dropped');
  const s = new sb.SafeBrowsing({ dir: tmp(), fetchImpl: null, sources: [{ id: 'p', threat: 'phishing', url: 'x' }] });
  s.lists.set('p', new sb.HashList(hashes));
  assert.deepEqual(s.check('evil.example.com', 'example.com'), { threat: 'phishing', list: 'p' });
  assert.ok(s.check('login.evil.example.com', 'example.com'), 'a subdomain of a listed host');
  assert.equal(s.check('example.com', 'example.com'), null, 'the parent of a listed host is fine');
  assert.ok(s.check('bad.github.io', 'bad.github.io'), 'one person’s site on a hosting service');
  assert.equal(s.check('docs.google.com', 'google.com'), null, 'well-known sites are never blocked');
  assert.equal(s.check('localhost'), null);
  assert.deepEqual(sb.candidates('a.b.evil.co.uk', 'evil.co.uk'), ['a.b.evil.co.uk', 'b.evil.co.uk', 'evil.co.uk']);
});

test('Safe Browsing: lists download once a day, are saved, load back, and an unchanged list (304) is kept', async () => {
  const dir = tmp();
  const calls = [];
  let status = 200;
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers]);
    return status === 304 ? new Response(null, { status: 304 }) : new Response('evil.example.com\nphish.example.net\n', { status: 200, headers: { etag: '"v1"' } });
  };
  let now = 1_000_000;
  const sources = [{ id: 'p', threat: 'phishing', url: 'https://lists.test/p.txt' }];
  const a = new sb.SafeBrowsing({ dir, fetchImpl, sources, now: () => now, log: () => {} });
  assert.equal(a.status().ready, false);
  assert.equal(await a.refresh(), true);
  assert.equal(a.status().ready, true);
  assert.equal(a.status().count, 2);
  assert.ok(a.check('phish.example.net', 'example.net'));
  assert.equal(await a.refresh(), false, 'not again the same day');
  assert.equal(calls.length, 1);
  now += 864e5 + 1;
  status = 304;
  await a.refresh();
  assert.deepEqual(calls[1][1], { 'If-None-Match': '"v1"' }, 'asks whether the list changed');
  assert.ok(a.check('evil.example.com', 'example.com'), 'kept the list');
  const b = new sb.SafeBrowsing({ dir, fetchImpl, sources }).load();
  assert.ok(b.check('evil.example.com', 'example.com'), 'loads what was saved');
  // Only the lists' own addresses are fetched: never the sites you visit.
  assert.ok(calls.every(([url]) => url === 'https://lists.test/p.txt'));
});

test('Safe Browsing: a failed download keeps the last list and says so', async () => {
  const s = listsWith(['evil.example.com']);
  s.log = () => {};
  await s.refresh({ force: true });
  assert.match(s.status().error, /offline/);
  assert.ok(s.check('evil.example.com', 'example.com'));
});

test('downloads: from a listed site, a misleading name, or over http from a secure page', () => {
  const listed = (u) => (/evil\.example/.test(u) ? { threat: 'malware' } : null);
  assert.equal(sb.downloadDanger({ url: 'https://evil.example/setup.zip', listed }).kind, 'dangerous');
  assert.equal(sb.downloadDanger({ url: 'https://cdn.test/f', chain: ['https://evil.example/r', 'https://cdn.test/f'], listed }).kind, 'dangerous', 'a redirect through a listed site');
  assert.equal(sb.downloadDanger({ url: 'https://ok.test/invoice.pdf.exe', filename: 'invoice.pdf.exe' }).kind, 'deceptive');
  assert.equal(sb.downloadDanger({ url: 'https://ok.test/x', filename: 'photo‮gpj.exe' }).kind, 'deceptive', 'a right-to-left trick');
  assert.equal(sb.downloadDanger({ url: 'http://files.test/a.zip', filename: 'a.zip', pageUrl: 'https://shop.test/' }).kind, 'insecure');
  assert.equal(sb.downloadDanger({ url: 'http://localhost:8080/a.zip', filename: 'a.zip', pageUrl: 'https://shop.test/' }), null, 'this computer is fine');
  assert.equal(sb.downloadDanger({ url: 'http://files.test/a.zip', filename: 'a.zip', pageUrl: 'http://files.test/' }), null);
  assert.equal(sb.downloadDanger({ url: 'https://ok.test/report.pdf', filename: 'report.pdf', pageUrl: 'https://ok.test/' }), null);
  assert.equal(sb.downloadDanger({ url: 'https://ok.test/setup.dmg', filename: 'Lumio Setup.dmg', pageUrl: 'https://ok.test/' }), null, 'an ordinary installer');
});

// ---------------------------------------------------------------- the navigation guard
function guardSetup({ settings = {}, listed = [], visited = [], ports = {} } = {}) {
  const ses = fakeSession();
  const s = { safeBrowsing: 'standard', httpsFirst: false, lookalikes: true, ...settings };
  const guard = new NavigationGuard({
    profile: { session: ses },
    settings: () => s,
    safeBrowsing: listsWith(listed),
    sites: resolver(),
    targets: () => look.BRAND_TARGETS,
    visited: (h) => visited.includes(h),
    isTab: (id) => id === 7,
    ports,
  });
  const loads = [];
  const history = { entries: [{ url: 'https://start.example/' }], index: 0 };
  const wc = {
    id: 7,
    loadURL: (url, opts) => { loads.push([url, opts]); return Promise.resolve(); },
    getURL: () => history.entries[history.index].url,
    isDestroyed: () => false,
    navigationHistory: {
      getActiveIndex: () => history.index,
      getAllEntries: () => history.entries,
      getEntryAtIndex: (i) => history.entries[i],
      goToIndex: (i) => { history.went = i; },
      removeEntryAtIndex: (i) => history.entries.splice(i, 1),
    },
  };
  const nav = (url, extra = {}) => run(ses, 'onBeforeRequest', { url, resourceType: 'mainFrame', webContentsId: 7, method: 'GET', frame: { url: wc.getURL() }, ...extra });
  return { ses, s, guard, wc, loads, history, nav };
}

test('guard: a listed site is stopped and replaced by the warning page; Back to safety and proceeding', async () => {
  const { guard, wc, loads, nav, history } = guardSetup({ listed: ['evil.example.com'] });
  assert.deepEqual(await nav('https://evil.example.com/login'), { cancel: true });
  assert.equal(guard.loadFailed(wc, -20, 'https://evil.example.com/login'), true);
  const [shown] = loads.at(-1);
  assert.match(shown, /^lumio:\/\/interstitial\/\?type=unsafe&url=https%3A%2F%2Fevil\.example\.com%2Flogin&threat=phishing$/);
  history.entries.push({ url: shown });
  history.index = 1;
  assert.deepEqual(guard.info(wc), { type: 'unsafe', url: 'https://evil.example.com/login', host: 'evil.example.com', threat: 'phishing', suggested: null, canGoBack: true });
  guard.back(wc, 'lumio://newtab/');
  assert.equal(history.went, 0, 'back to the page before');
  guard.proceed(wc);
  assert.deepEqual(loads.at(-1), ['https://evil.example.com/login', {}]);
  assert.deepEqual(await nav('https://evil.example.com/login'), {}, 'allowed for the rest of the session');
  // Frames from a listed site are stopped silently; other pages are untouched.
  const { nav: nav2 } = guardSetup({ listed: ['evil.example.com'] });
  assert.deepEqual(await nav2('https://evil.example.com/ad', { resourceType: 'subFrame' }), { cancel: true });
  assert.deepEqual(await nav2('https://fine.example.org/'), {});
  assert.deepEqual(await nav2('https://evil.example.com/x.js', { resourceType: 'script' }), {}, 'only pages and frames are checked');
});

test('guard: No protection turns lists and lookalike warnings off', async () => {
  const { nav } = guardSetup({ listed: ['evil.example.com'], settings: { safeBrowsing: 'off', lookalikes: false } });
  assert.deepEqual(await nav('https://evil.example.com/'), {});
  assert.deepEqual(await nav('https://paypa1.com/'), {});
});

test('guard: HTTPS-First upgrades http pages, warns when https fails or sends you back, and leaves local names alone', async () => {
  const { guard, wc, loads, nav } = guardSetup({ settings: { httpsFirst: true } });
  assert.deepEqual(await nav('http://news.example.org/a?b=1'), { redirectURL: 'https://news.example.org/a?b=1' });
  assert.equal(guard.isUpgrade(7, 'https://news.example.org/a?b=1'), true);
  // https doesn't answer: "Connection is not secure", then Continue opens http.
  assert.equal(guard.loadFailed(wc, -102, 'https://news.example.org/a?b=1'), true);
  assert.match(loads.at(-1)[0], /type=https&url=http%3A%2F%2Fnews\.example\.org/);
  guard.proceed(wc);
  assert.deepEqual(loads.at(-1), ['http://news.example.org/a?b=1', {}]);
  assert.deepEqual(await nav('http://news.example.org/a?b=1'), {}, 'remembered for the site');
  // The https site redirects back to http.
  assert.deepEqual(await nav('http://loop.example.org/'), { redirectURL: 'https://loop.example.org/' });
  assert.deepEqual(await nav('http://loop.example.org/'), { cancel: true });
  assert.equal(guard.loadFailed(wc, -20, 'http://loop.example.org/'), true);
  // A name that doesn't exist gets the usual error page.
  await nav('http://gone.example.org/');
  assert.equal(guard.loadFailed(wc, -105, 'https://gone.example.org/'), false);
  for (const url of ['http://localhost:3000/', 'http://192.168.1.1/', 'http://router/', 'http://printer.local/', 'http://example.com:8080/']) {
    assert.deepEqual(await nav(url), {}, `${url} stays http`);
  }
  assert.deepEqual(await nav('http://site.example.org/form', { method: 'POST', frame: { url: 'http://site.example.org/' } }), {}, 'a form is never resent by an upgrade');
  assert.equal(isLocalName('wiki'), true);
  assert.equal(isLocalName('example.com'), false);
  assert.equal(httpsUrlFor('http://a.test:8080/x', { 8080: 8443 }), 'https://a.test:8443/x');
  assert.equal(httpsUrlFor('http://a.test:8080/x'), null);
});

test('guard: a lookalike of a well-known site asks "Did you mean …?"; visited sites and Ignore are left alone', async () => {
  const { guard, wc, loads, nav } = guardSetup({ visited: ['rnicrosoft.com'] });
  assert.deepEqual(await nav('https://paypa1.com/signin'), { cancel: true });
  guard.loadFailed(wc, -20, 'https://paypa1.com/signin');
  assert.match(loads.at(-1)[0], /type=lookalike&url=https%3A%2F%2Fpaypa1\.com%2Fsignin&suggested=paypal\.com$/);
  guard.goSuggested(wc);
  assert.deepEqual(loads.at(-1), ['https://paypal.com/', undefined]);
  guard.show(wc, { type: 'lookalike', url: 'https://paypa1.com/signin', suggested: 'paypal.com' });
  guard.proceed(wc);
  assert.deepEqual(await nav('https://paypa1.com/signin'), {}, 'Ignore');
  assert.deepEqual(await nav('https://rnicrosoft.com/'), {}, 'a site you’ve visited before');
  assert.deepEqual(await nav('https://www.wikipedia.org/'), {});
});

test('guard: a secure page sending a form over http waits for "Send anyway", which sends it again', async () => {
  const { guard, wc, loads, nav, history } = guardSetup();
  history.entries[0].url = 'https://shop.example.com/checkout';
  const body = [{ bytes: Buffer.from('card=4242&name=Ana') }];
  assert.deepEqual(await nav('http://pay.example.net/submit', { method: 'POST', uploadData: body }), { cancel: true });
  assert.equal(guard.loadFailed(wc, -20, 'http://pay.example.net/submit'), true);
  assert.match(loads.at(-1)[0], /type=form/);
  guard.proceed(wc);
  const [url, opts] = loads.at(-1);
  assert.equal(url, 'http://pay.example.net/submit');
  assert.equal(opts.postData[0].bytes.toString(), 'card=4242&name=Ana');
  assert.match(opts.extraHeaders, /x-www-form-urlencoded/);
  assert.deepEqual(await nav('http://pay.example.net/submit', { method: 'POST', uploadData: body }), {}, 'sent once');
  // A GET form: the page's preload said a form is going there.
  guard.formHint(7, 'http://search.example.net/find');
  assert.deepEqual(await nav('http://search.example.net/find?q=shoes'), { cancel: true });
  assert.deepEqual(await nav('http://search.example.net/find?q=shoes'), {}, 'a plain link there is fine');
  // From an http page, or to this computer, nothing is asked.
  history.entries[0].url = 'http://shop.example.com/';
  assert.deepEqual(await nav('http://pay.example.net/submit', { method: 'POST' }), {});
  const multipart = replayOptions({ body: [{ bytes: Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XyZ--') }] });
  assert.equal(multipart.extraHeaders, 'Content-Type: multipart/form-data; boundary=XyZ');
});

// ---------------------------------------------------------------- lookalikes
test('addresses: international names show in their own letters only when they can’t pass for another site', () => {
  assert.equal(look.displayHost('xn--mnchen-3ya.de'), 'münchen.de');
  assert.equal(look.displayHost('xn--e1afmkfd.xn--p1ai'), 'пример.рф', 'Cyrillic on a Cyrillic domain');
  assert.equal(look.displayHost('xn--fsqu00a.xn--3lr804guic'), '例子.卷筒纸');
  assert.equal(look.displayHost('xn--80ak6aa92e.com'), 'xn--80ak6aa92e.com', 'all-Cyrillic "apple" on .com stays punycode');
  assert.equal(look.displayHost('xn--pple-43d.com'), 'xn--pple-43d.com', 'Latin mixed with Cyrillic');
  assert.equal(look.displayHost('xn--facbook-ifb.com'), 'xn--facbook-ifb.com', 'an accented copy of a well-known site');
  assert.equal(look.displayUrl('https://xn--mnchen-3ya.de/karte?x=1'), 'https://münchen.de/karte?x=1');
  assert.equal(look.displayUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(look.labelSafe('ıntel', 'com'), false, 'a dotless i');
  assert.equal(look.labelSafe('日本ハム', 'jp'), true, 'Japanese mixes Han and Katakana');
});

test('lookalikes: copies of well-known sites, but not the same name elsewhere or popular sites one letter away', () => {
  const t = look.BRAND_TARGETS;
  const of = (host, site = host) => look.lookalikeOf(host, site, t)?.site || null;
  assert.equal(of('paypa1.com'), 'paypal.com');
  assert.equal(of('rnicrosoft.com'), 'microsoft.com');
  assert.equal(of('gooogle.com'), 'google.com');
  assert.equal(of('faceb00k.com'), 'facebook.com');
  assert.equal(of('xn--80aa0cbo65f.com'), 'paypal.com', 'Cyrillic letters that read "paypal"');
  assert.equal(of('paypal.com.account-help.net', 'account-help.net'), 'paypal.com');
  assert.equal(of('login.paypal-com.example.net', 'example.net'), 'paypal.com');
  assert.equal(of('amazon.de'), null, 'the same name in another country');
  assert.equal(of('mercadolivre.com.br', 'mercadolivre.com.br'), null, 'a real site one letter away');
  assert.equal(of('example.com'), null);
  assert.equal(of('site2.com'), null);
  assert.equal(look.lookalikeOf('myshopp.com', 'myshopp.com', [{ site: 'myshop.com' }])?.site, 'myshop.com', 'sites you visit often count too');
  assert.equal(look.skeleton('pаypa1'), 'paypal');
});

// ---------------------------------------------------------------- secure DNS
test('secure DNS: providers, custom addresses, and what Chromium is told', async () => {
  assert.deepEqual(dns.resolverOptions({ on: true, provider: 'os' }), { secureDnsMode: 'automatic', secureDnsServers: [] });
  assert.deepEqual(dns.resolverOptions({ on: true, provider: 'cloudflare' }), { secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query'] });
  assert.deepEqual(dns.resolverOptions({ on: true, provider: 'google' }).secureDnsServers, ['https://dns.google/dns-query{?dns}']);
  assert.deepEqual(dns.resolverOptions({ on: true, provider: 'quad9' }).secureDnsMode, 'secure');
  assert.deepEqual(dns.resolverOptions({ on: true, provider: 'custom', custom: 'https://dns.example/dns-query{?dns}' }).secureDnsServers, ['https://dns.example/dns-query{?dns}']);
  assert.deepEqual(dns.resolverOptions({ on: true, provider: 'custom', custom: 'http://dns.example/q' }), { secureDnsMode: 'automatic', secureDnsServers: [] }, 'a bad custom address falls back');
  assert.deepEqual(dns.resolverOptions({ on: false, provider: 'cloudflare' }), { secureDnsMode: 'off', secureDnsServers: [] });
  assert.equal(dns.validTemplate('https://dns.example/dns-query'), true);
  assert.equal(dns.validTemplate('https://user:pw@dns.example/q'), false);
  assert.equal(dns.validTemplate('https://dns.example/{?name}'), false);
  const q = dns.dnsQuery('example.com');
  assert.deepEqual([...q.subarray(0, 6)], [0, 0, 1, 0, 0, 1]);
  assert.equal(q.subarray(12, 25).toString('latin1'), '\x07example\x03com\x00');
  const answer = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  let asked = '';
  const ok = await dns.testProvider('https://dns.example/dns-query', async (url, init) => { asked = url; assert.equal(init.headers.accept, 'application/dns-message'); return new Response(answer, { headers: { 'content-type': 'application/dns-message' } }); });
  assert.deepEqual(ok, { ok: true });
  assert.match(asked, /^https:\/\/dns\.example\/dns-query\?dns=AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE$/);
  assert.equal((await dns.testProvider('https://dns.example/q', async () => new Response('<html>'))).ok, false);
  assert.equal((await dns.testProvider('https://dns.example/q', async () => { throw new Error('down'); })).ok, false);
  // A bad setting never stops Lumio.
  const app = { configureHostResolver: () => { throw new Error('bad'); } };
  const errors = console.error;
  console.error = () => {};
  assert.deepEqual(dns.applySecureDns(app, { on: true, provider: 'quad9' }).secureDnsMode, 'secure');
  console.error = errors;
});

// ---------------------------------------------------------------- Password Checkup
function passwordStore(passwords) {
  const entries = passwords.map((pw, i) => ({ id: `p${i}`, origin: `https://s${i}.test`, username: 'me', password: pw, created: 1, updated: 1 }));
  return {
    entries,
    secret: (id) => entries.find((e) => e.id === id)?.password,
    get: (id) => entries.find((e) => e.id === id),
    list: () => entries.map((e) => ({ id: e.id, weak: e.password.length < 8, reused: entries.filter((x) => x.password === e.password).length > 1 })),
  };
}

test('Password Checkup: only 5 characters of each password’s SHA-1 leave the computer; breaches, reuse and weak ones are counted', async () => {
  const leaked = 'password123';
  const safe = 'correct horse battery staple 2026';
  const st = passwordStore([leaked, safe, leaked]);
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([url, init.headers]);
    const prefix = url.slice(-5);
    const h = sha1(leaked);
    // Padding lines (count 0) and other suffixes come back too.
    const body = [`${'0'.repeat(35)}:0`, prefix === h.slice(0, 5) ? `${h.slice(5)}:2254650` : `${'A'.repeat(35)}:3`].join('\r\n');
    return new Response(body);
  };
  const c = new PasswordCheckup({ store: st, dir: tmp(), fetchImpl, now: () => 5000 });
  assert.equal(c.compromised(st.entries[0]), null, 'not checked yet');
  const summary = await c.run();
  assert.deepEqual(summary, { checked: 5000, total: 3, compromised: 2, unchecked: 0, reused: 2, weak: 0 });
  assert.equal(asked.length, 2, 'one request per hash prefix');
  for (const [url, headers] of asked) {
    assert.match(url, /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    assert.equal(headers['Add-Padding'], 'true');
    assert.ok(!url.includes(sha1(leaked).slice(5)) && !url.includes(leaked));
  }
  assert.deepEqual(c.flags(), { p0: true, p1: false, p2: true });
  st.entries[0].updated = 2; // the password changed: its result is stale
  assert.equal(c.compromised(st.entries[0]), null);
  assert.equal(parseRange('ABC:1\nnot a line').size, 0);
  const failing = new PasswordCheckup({ store: st, dir: tmp(), fetchImpl: async () => { throw new Error('offline'); } });
  assert.match((await failing.run()).error, /Couldn’t check/);
});

// ---------------------------------------------------------------- tracking protection
test('tracking protection: other sites’ ad and tracker requests are stopped; the site itself, and sites you allow, are not', async () => {
  const ses = fakeSession();
  const st = store();
  const siteSettings = new SiteSettings({ store: st });
  const s = { doNotTrack: false, gpc: true, webrtcProtect: true };
  const extras = new PrivacyExtras({ profile: { session: ses }, settings: () => s, siteSettings, sites: resolver(), extraTrackers: ['tracker.test'] });
  const req = (url, top, extra = {}) => run(ses, 'onBeforeRequest', { url, resourceType: 'script', webContentsId: 9, frame: { top: { url: top } }, ...extra });
  assert.equal(siteSettings.defaultOf('trackers'), 'block', 'on by default');
  assert.deepEqual(await req('https://www.google-analytics.com/analytics.js', 'https://news.example.com/'), { cancel: true });
  assert.deepEqual(await req('https://px.tracker.test/p.gif', 'https://news.example.com/', { resourceType: 'image' }), { cancel: true });
  assert.deepEqual(await req('https://ok.cdn.example.net/app.js', 'https://news.example.com/'), {});
  assert.deepEqual(await req('https://px.tracker.test/', 'https://px.tracker.test/', { resourceType: 'mainFrame' }), {}, 'opening a tracker’s own page');
  assert.deepEqual(await req('https://a.tracker.test/x.js', 'https://www.tracker.test/'), {}, 'the site you’re on');
  assert.equal(extras.blockedOn(9), 2);
  siteSettings.set('https://news.example.com', 'trackers', 'allow');
  assert.deepEqual(await req('https://www.google-analytics.com/analytics.js', 'https://news.example.com/'), {}, 'allowed in Site settings');
  assert.equal(trackerMatch('stats.g.doubleclick.net', new Set(['doubleclick.net'])), true);
  assert.equal(trackerMatch('notdoubleclick.net', new Set(['doubleclick.net'])), false);
  // Global Privacy Control (on) and Do Not Track (off by default) headers.
  const headers = async () => (await run(ses, 'onBeforeSendHeaders', { url: 'https://a.test/', requestHeaders: { Accept: '*/*' } })).requestHeaders;
  assert.deepEqual(await headers(), { Accept: '*/*', 'Sec-GPC': '1' });
  s.doNotTrack = true;
  assert.deepEqual(await headers(), { Accept: '*/*', 'Sec-GPC': '1', DNT: '1' });
  // WebRTC uses only the public network route while protection is on.
  const policies = [];
  const wc = { isDestroyed: () => false, setWebRTCIPHandlingPolicy: (p) => policies.push(p) };
  extras.applyWebRtc(wc);
  s.webrtcProtect = false;
  extras.applyWebRtc(wc);
  assert.deepEqual(policies, ['default_public_interface_only', 'default']);
  extras.dispose();
});

test('unused permissions: sites not visited for 90 days lose what they were allowed; "Allow again" brings it back', () => {
  const st = store();
  let now = 1_000_000_000_000;
  const siteSettings = new SiteSettings({ store: st });
  const unused = new UnusedPermissions({ store: st, siteSettings, now: () => now });
  siteSettings.set('https://old.example.com', 'camera', 'allow');
  siteSettings.set('https://old.example.com', 'javascript', 'block');
  siteSettings.set('https://busy.example.com', 'geolocation', 'allow');
  st.settings.siteSettingTimes['https://old.example.com'] = now - 100 * 864e5;
  st.settings.siteSettingTimes['https://busy.example.com'] = now - 100 * 864e5;
  unused.visited('https://busy.example.com/page');
  now += 3600_000;
  const done = unused.sweep();
  assert.deepEqual(done.map((d) => [d.origin, d.cats]), [['https://old.example.com', ['camera']]]);
  assert.equal(siteSettings.exception('https://old.example.com', 'camera'), undefined);
  assert.equal(siteSettings.exception('https://old.example.com', 'javascript'), 'block', 'content settings stay');
  assert.equal(siteSettings.exception('https://busy.example.com', 'geolocation'), 'allow');
  assert.deepEqual(unused.list().map((u) => [u.host, u.cats]), [['old.example.com', ['Camera']]]);
  assert.equal(unused.undo('https://old.example.com'), true);
  assert.equal(siteSettings.exception('https://old.example.com', 'camera'), 'allow');
  assert.deepEqual(unused.list(), []);
  assert.deepEqual(unused.sweep(), [], 'it counts as visited now');
});

// ---------------------------------------------------------------- capture indicators
test('capture: camera and microphone dots follow Lumio’s grants and the page’s count, which can only end them', () => {
  const changes = [];
  const c = new CaptureTracker({ findTab: () => null, onChange: (id, s) => changes.push([id, s]) });
  c.granted(5, ['camera', 'microphone']);
  assert.deepEqual(c.state(5), { camera: true, microphone: true, screen: null, sharedTo: null });
  c.report(5, { settled: { camera: 1, microphone: 1 }, live: { camera: 1, microphone: 1 } });
  assert.equal(c.state(5).camera, true);
  c.report(5, { settled: { camera: 1, microphone: 1 }, live: { camera: 0, microphone: 1 } });
  assert.deepEqual(c.state(5), { camera: false, microphone: true, screen: null, sharedTo: null });
  c.report(5, { settled: { camera: 0, microphone: 0 }, live: {} });
  assert.equal(c.state(5).microphone, true, 'a count that doesn’t add up can’t end anything');
  c.report(5, { settled: { camera: 'x' }, live: null });
  c.report(5, { settled: { camera: 1, microphone: 1 }, live: { camera: 0, microphone: 0 } });
  assert.equal(c.state(5), null);
  c.granted(5, ['camera']);
  c.ended(5);
  assert.equal(c.state(5), null, 'the page went away');
  assert.ok(changes.length > 3);
  c.granted(6, ['geolocation']);
  assert.equal(c.pages.has(6), false);
});

test('capture: a shared screen or tab shows on both tabs; macOS’s own picker is known from the page', async () => {
  const live = new Set([8]);
  const wcs = new Map([[8, { isDestroyed: () => false, isBeingCaptured: () => live.has(8) }], [5, { isDestroyed: () => false, send: (ch) => sent.push(ch), reload: () => sent.push('reload') }]]);
  const sent = [];
  const c = new CaptureTracker({ findTab: (id) => (wcs.has(id) ? { tab: { view: { webContents: wcs.get(id) } } } : null), poll: 20, stopWait: 30 });
  c.shared(5, { kind: 'tab', title: 'Slides', target: 8, host: 'meet.example.com' });
  assert.equal(c.state(5).screen, 'tab:Slides');
  assert.equal(c.state(8).sharedTo, 'meet.example.com');
  await wait(60);
  live.delete(8); // the capture stopped
  await wait(80);
  assert.equal(c.state(8), null);
  assert.equal(c.state(5), null);
  // macOS 15's picker: the site was allowed to ask, and the page says it shares.
  c.granted(4, ['screenShare']);
  assert.equal(c.state(4), null);
  c.report(4, { settled: { display: 1 }, live: { display: 1 } });
  assert.equal(c.state(4).screen, 'screen');
  c.report(4, { settled: { display: 1 }, live: { display: 0 } });
  assert.equal(c.state(4), null);
  // Stop sharing: the page is asked; one that keeps sharing is reloaded.
  c.shared(5, { kind: 'screen', title: 'Screen 1', host: 'meet.example.com' });
  assert.equal(c.stop(5), true);
  assert.deepEqual(sent, ['capture:stop']);
  await wait(60);
  assert.deepEqual(sent, ['capture:stop', 'reload']);
  const tabs = shareableTabs([{ tabs: { tabs: [{ title: 'A', view: { webContents: { id: 1, isDestroyed: () => false, getURL: () => 'https://a.test/' } } }, { title: 'Me', view: { webContents: wcs.get(5) } }, { title: 'Asleep', view: null }], displayUrl: () => 'https://a.test/' } }], wcs.get(5));
  assert.deepEqual(tabs.map((t) => t.id), ['tab:1']);
});

// ---------------------------------------------------------------- certificates
test('client certificates: the chooser, remembering the choice per site, and the same site asking twice', () => {
  const shown = [];
  const w = { showOverlay: (rect, payload) => shown.push(payload), overlay: { webContents: { focus: () => {} } } };
  const ses = {};
  const wc = { session: ses, isDestroyed: () => false };
  const certs = new ClientCertificates({ findTab: () => ({ w, tab: { view: { getBounds: () => ({ x: 0, y: 80, width: 1000, height: 700 }) } } }) });
  const list = [
    { fingerprint: 'sha256/aaa', subject: { commonName: 'Ana Pérez', organizations: ['Acme'] }, issuer: { commonName: 'Acme CA' }, validStart: 1700000000, validExpiry: 1800000000, serialNumber: '01' },
    { fingerprint: 'sha256/bbb', subjectName: 'Second', issuerName: 'Other CA' },
  ];
  const got = [];
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  certs.select(ev, wc, 'https://bank.example.com/login', list, (c) => got.push(c?.fingerprint || null));
  certs.select(ev, wc, 'https://bank.example.com/api', list, (c) => got.push(c?.fingerprint || null));
  assert.equal(ev.prevented, true);
  assert.equal(shown.length, 1, 'one chooser for the site');
  assert.deepEqual(shown[0].cert.items.map((i) => [i.subject, i.issuer]), [['Ana Pérez', 'Acme CA'], ['Second', 'Other CA']]);
  assert.equal(shown[0].cert.items[0].validExpiry, 1800000000000);
  certs.answer(shown[0].cert.id, 0);
  assert.deepEqual(got, ['sha256/aaa', 'sha256/aaa']);
  certs.select(ev, wc, 'https://bank.example.com/again', list, (c) => got.push(c?.fingerprint || null));
  assert.equal(got.at(-1), 'sha256/aaa', 'remembered until Lumio quits');
  certs.select(ev, wc, 'https://other.example.com/', list, (c) => got.push(c ? 'cert' : 'none'));
  certs.closed(w);
  assert.equal(got.at(-1), 'none');
  certs.select(ev, wc, 'https://other.example.com/', list, () => {});
  assert.equal(shown.length, 3, 'closing isn’t remembered: it asks again');
  assert.deepEqual(certInfo(list[0], 0).subjectLines, ['Ana Pérez', 'Acme']);
  assert.match(certificateManager('darwin', () => true), /Keychain Access\.app$/);
  assert.equal(certificateManager('darwin', () => false), null);
  assert.match(certificateManager('win32'), /certmgr\.msc$/);
  assert.equal(certificateManager('linux'), null);
});

// ---------------------------------------------------------------- device choosers
test('device choosers: a list to connect from, devices coming and going, blocked sites and cancelling', () => {
  const ses = fakeSession();
  const st = store();
  const settings = new SiteSettings({ store: st });
  const shown = [];
  const w = { closed: false, overlayKind: null, tabs: { tabs: [{ view: { webContents: { id: 3 }, getBounds: () => ({ x: 0, y: 80, width: 900, height: 600 }) } }] }, showOverlay: (rect, p) => { w.overlayKind = p.kind; shown.push(p); }, hideOverlay: () => { w.overlayKind = null; }, overlay: { webContents: { focus: () => {} } } };
  let page = 'https://maker.example.com/flash';
  const wc = { id: 3, isDestroyed: () => false, getURL: () => page };
  const choosers = new DeviceChoosers({ session: ses, settings, findTab: () => ({ w }) });
  const answers = [];
  const ev = { preventDefault() {} };
  ses.emit('select-serial-port', ev, [{ portId: 'p1', portName: 'cu.usbserial', displayName: 'Arduino Uno' }], wc, (id) => answers.push(id));
  assert.deepEqual(shown.at(-1).device.items, [{ id: 'p1', name: 'Arduino Uno', sub: 'cu.usbserial' }]);
  assert.equal(shown.at(-1).device.what, 'a serial port');
  ses.emit('serial-port-added', ev, { portId: 'p2', portName: 'cu.Bluetooth' }, wc);
  assert.equal(shown.at(-1).device.items.length, 2);
  ses.emit('serial-port-removed', ev, { portId: 'p1', portName: 'cu.usbserial' }, wc);
  assert.deepEqual(shown.at(-1).device.items.map((d) => d.id), ['p2']);
  choosers.answer(shown.at(-1).device.id, 'p2');
  assert.deepEqual(answers, ['p2']);
  // Cancelled when the chooser closes.
  ses.emit('select-serial-port', ev, [], wc, (id) => answers.push(id));
  choosers.closed(w);
  assert.equal(answers.at(-1), '');
  // A device the list didn't have is never connected.
  ses.emit('select-serial-port', ev, [{ portId: 'p3', portName: 'x' }], wc, (id) => answers.push(id));
  choosers.answer(shown.at(-1).device.id, 'p9');
  assert.equal(answers.at(-1), '');
  // A blocked site gets no chooser.
  settings.set('https://maker.example.com', 'serial', 'block');
  const before = shown.length;
  ses.emit('select-serial-port', ev, [{ portId: 'p1', portName: 'x' }], wc, (id) => answers.push(`blocked:${id}`));
  assert.equal(shown.length, before);
  assert.equal(answers.at(-1), 'blocked:');
  // Leaving the page cancels its question.
  page = 'https://other.example.com/';
  ses.emit('select-serial-port', ev, [{ portId: 'p1', portName: 'x' }], wc, (id) => answers.push(`left:${id}`));
  choosers.cancelFor(3);
  assert.equal(answers.at(-1), 'left:');
  assert.equal(describeDevice('usb', { deviceId: 'u1', vendorId: 0x2341, productId: 0x43 }).name, 'Unknown device (2341:0043)');
  assert.equal(describeDevice('bluetooth', { deviceId: 'AA:BB', deviceName: 'Heart rate' }).name, 'Heart rate');
  assert.deepEqual(listed('hid', [{ deviceId: 'h1', name: 'Pad' }, { deviceId: 'h1', name: 'Pad' }]).length, 1, 'one row per device');
  choosers.dispose();
  assert.equal(ses.listenerCount('select-serial-port'), 0);
});

// ---------------------------------------------------------------- settings and hooks
test('security settings: safe defaults, and only valid changes are kept', () => {
  const st = store();
  const s = readSettings(st);
  assert.equal(s.safeBrowsing, 'standard');
  assert.equal(s.httpsFirst, false);
  assert.equal(s.gpc, true);
  assert.equal(s.doNotTrack, false);
  assert.equal(s.webrtcProtect, true);
  assert.equal(s.lookalikes, true);
  assert.deepEqual(s.secureDns, DEFAULTS.secureDns);
  st.setSetting('security', { safeBrowsing: 'off', secureDns: { provider: 'quad9' } });
  assert.equal(readSettings(st).lookalikes, false, 'lookalike warnings come with Safe Browsing');
  assert.deepEqual(readSettings(st).secureDns, { on: true, provider: 'quad9', custom: '' });
  assert.deepEqual(cleanPatch({ safeBrowsing: 'enhanced', httpsFirst: 'yes', gpc: false, evil: 1, secureDns: { provider: 'nope', on: false, custom: '  https://d.example/q  ' } }),
    { gpc: false, secureDns: { on: false, custom: 'https://d.example/q' } });
  assert.deepEqual(cleanPatch({ secureDns: {} }), {});
});

test('features: a risky download waits for Keep or Discard; devices may open the chooser unless blocked; grants are reported', () => {
  const ses = fakeSession();
  const pushes = [];
  const dl = new Downloads(ses, { emit: (c, p) => pushes.push(p), settings: { settings: { downloadDir: tmp() } } });
  dl.danger = (item) => (item.getFilename().endsWith('.pdf.exe') ? { kind: 'deceptive', title: 'This file’s name is misleading', detail: '…' } : null);
  const fakeItem = (name) => {
    const it = new EventEmitter();
    let paused = false;
    Object.assign(it, { getFilename: () => name, getURL: () => `https://f.test/${name}`, getTotalBytes: () => 10, setSavePath() {}, setSaveDialogOptions() {}, getSavePath: () => '',
      pause: () => { paused = true; }, resume: () => { paused = false; }, isPaused: () => paused, cancel: () => { it.cancelled = true; }, getReceivedBytes: () => 0, canResume: () => true });
    return it;
  };
  const bad = fakeItem('invoice.pdf.exe');
  ses.emit('will-download', {}, bad, { getURL: () => 'https://f.test/' });
  assert.equal(bad.isPaused(), true, 'nothing is saved until the person decides');
  assert.equal(dl.list()[0].danger.kind, 'deceptive');
  dl.action(dl.list()[0].id, 'keep');
  assert.equal(bad.isPaused(), false);
  assert.equal(dl.list()[0].danger, undefined);
  const bad2 = fakeItem('photo.pdf.exe');
  ses.emit('will-download', {}, bad2, null);
  dl.action(dl.list()[0].id, 'resume');
  assert.equal(bad2.isPaused(), true, 'Resume doesn’t skip the question');
  dl.action(dl.list()[0].id, 'discard');
  assert.equal(bad2.cancelled, true);
  assert.equal(dl.list().some((d) => d.name === 'photo.pdf.exe'), false);
  const fine = fakeItem('notes.txt');
  ses.emit('will-download', {}, fine, null);
  assert.equal(fine.isPaused(), false);

  const pses = fakeSession();
  const perms = new Permissions(pses, { store: store(), emitFor: () => {} });
  const wc = { id: 4, getURL: () => 'https://maker.example.com/' };
  assert.equal(pses.check(wc, 'serial', 'https://maker.example.com', {}), true, 'the chooser is the question');
  perms.set('https://maker.example.com', 'serial', 'block');
  assert.equal(pses.check(wc, 'serial', 'https://maker.example.com', {}), false);
  const granted = [];
  perms.onGranted = (id, cats) => granted.push([id, cats]);
  perms.set('https://maker.example.com', 'camera', 'allow');
  return new Promise((resolve) => {
    pses.request(wc, 'media', (ok) => {
      assert.equal(ok, true);
      assert.deepEqual(granted, [[4, ['camera']]]);
      resolve();
    }, { mediaTypes: ['video'], requestingUrl: 'https://maker.example.com/' });
  });
});

test('pages: the warning page and the Security pages are served', () => {
  assert.ok(PAGE_HOSTS.has('interstitial'));
  assert.match(resolveFile(new URL('lumio://interstitial/?type=unsafe&url=x'), PAGE_HOSTS), /interstitial\.html$/);
  assert.match(resolveFile(new URL('lumio://settings/security'), PAGE_HOSTS), /security\.html$/);
  assert.match(resolveFile(new URL('lumio://settings/trackingProtection'), PAGE_HOSTS), /security\.html$/);
  assert.equal(BY_ID.trackers.default, 'block');
  for (const id of ['usb', 'hid', 'serial', 'bluetooth']) assert.doesNotMatch(BY_ID[id].desc, /doesn’t have a device picker/);
});
