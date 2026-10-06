// End-to-end tests for security and privacy: Safe Browsing's warning page,
// HTTPS-First, lookalike sites and international addresses, forms sent
// from a secure page over http, dangerous downloads, tracking protection
// and privacy signals, secure DNS, capture indicators, the Security and
// Tracking protection settings pages, and Password Checkup.
//
// Everything stays on this computer: LUMIO_HOST_RULES sends every name to
// 127.0.0.1, Safe Browsing reads its list from a local server
// (LUMIO_SAFE_BROWSING), HTTPS-First's upgrades go to a local https server
// (LUMIO_HTTPS_PORTS) whose self-signed certificate is made with openssl
// when the tests run (never kept) and trusted by its fingerprint
// (LUMIO_TEST_TRUST_CERT, main/security.js), and Password Checkup's fetch is
// replaced by a stub: the real Pwned Passwords API is never called.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lumio-security-e2e-'));
const downloadsDir = path.join(tmp, 'downloads');
const D = 'lumio-e2e.net'; // test names; .net isn't on Chromium's HSTS preload list (.dev is)
const TRACKER = 'ads.yieldmo.com'; // on Lumio's tracker list (main/security-lists.js)
const LISTED = ['evil', 'evil-tab', 'evil-off'].map((h) => `${h}.${D}`); // on the test Safe Browsing list

let L;
let site; // http server: every name (through the host rules)
let other; // a second http server whose https port has nothing listening
let secure; // https server, when openssl made a certificate
let P; // site's port
let P2; // other's port
let HP = 0; // secure's port
let certReason = ''; // why there's no https server
const seen = []; // { host, path, method, headers, secure, body }

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(150);
  }
};
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const url = () => L.main(() => global.lumio.tabs.wc().getURL());
const go = async (u, expectTitle) => {
  await L.main((_e, x) => global.lumio.tabs.navigate(x), u);
  if (expectTitle) assert.ok(await until(async () => (await title()).includes(expectTitle)), `page "${expectTitle}" loaded`);
};
const activeTab = () => L.main(() => { const s = global.lumio.tabs.state(); return s.tabs.find((t) => t.id === s.activeId); });
// The warning page (lumio://interstitial) of a type, ready with its buttons. Resolves its title.
const warning = async (type) => until(async () => {
  const u = await url();
  if (!u.startsWith('lumio://interstitial') || new URL(u).searchParams.get('type') !== type) return null;
  return L.page(`document.querySelector('#acts button') ? document.title : null`);
}, 15_000);
const act = (a) => L.page(`(() => { const b = document.querySelector('[data-act=${a}]'); if (!b) return false; b.click(); return true; })()`);
const security = (fn, arg) => L.main(new Function('_e', 'arg', `const s = global.lumio.security; return (${fn})(s, arg);`), arg);
const resetSecurity = () => L.main(() => { global.lumio.security.set({ safeBrowsing: 'standard', httpsFirst: false, doNotTrack: false, gpc: true, webrtcProtect: true, autoRevoke: true, secureDns: { on: true, provider: 'os', custom: '' } }); return true; });
// The normal profile's site settings.
const siteSettings = (fn, arg) => L.main(new Function('_e', 'arg', `const s = global.lumio.profiles.normal.permissions.settings; return (${fn})(s, arg);`), arg);
const downloads = () => L.main(() => global.lumio.profiles.normal.downloads.list());
const hits = (pred) => seen.filter(pred);

function handler(q, r) {
  const u = new URL(q.url, 'http://x');
  const host = String(q.headers.host || '').replace(/:\d+$/, '');
  const entry = { host, path: u.pathname, method: q.method, headers: q.headers, secure: !!q.socket.encrypted, body: '' };
  seen.push(entry);
  const html = (body, extra = {}) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); r.end(body); };
  if (u.pathname === '/sb-list.txt') { r.writeHead(200, { 'content-type': 'text/plain' }); r.end(`# test list\n${LISTED.join('\n')}\n`); return; }
  if (u.pathname === '/pixel.png') {
    r.writeHead(200, { 'content-type': 'image/png' });
    r.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    return;
  }
  if (u.pathname === '/embed-tracker') { html(`<title>Tracker page</title><img id="px" src="http://${TRACKER}:${P}/pixel.png?t=${Date.now()}">`); return; }
  if (u.pathname === '/form') {
    html(`<title>Form page</title><form method="POST" action="http://plain.${D}:${P}/submit"><input name="q" value="hello"><button id="send">Send</button></form>`);
    return;
  }
  if (u.pathname === '/submit') {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => { entry.body = body; html('<title>Submitted</title><p>thanks</p>'); });
    return;
  }
  if (u.pathname === '/dl-page') {
    html(`<title>Downloads page</title><a id="exe" href="/report.pdf.exe">report</a><a id="plain" href="http://plain.${D}:${P}/file.bin">file</a>`);
    return;
  }
  if (u.pathname === '/report.pdf.exe' || u.pathname === '/file.bin') {
    r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${u.pathname.slice(1)}"` });
    r.end(Buffer.alloc(256 * 1024, 1));
    return;
  }
  if (u.pathname === '/camera') { html('<title>Camera</title><p>camera</p>'); return; }
  html(`<title>Page ${u.pathname.slice(1)}</title><h1>${u.pathname}</h1>`);
}

// A self-signed certificate for the test names, made now with openssl.
function makeCert() {
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  const base = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=secure.${D}`];
  try {
    try {
      execFileSync('openssl', [...base, '-addext', `subjectAltName=DNS:secure.${D},DNS:*.${D}`], { stdio: 'ignore' });
    } catch {
      // Older openssl (or LibreSSL) without -addext: the name doesn't matter, the fingerprint is trusted.
      execFileSync('openssl', base, { stdio: 'ignore' });
    }
  } catch (err) {
    certReason = `openssl isn’t available here (${err.code || err.message})`;
    return null;
  }
  const pem = fs.readFileSync(cert, 'utf8');
  const fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('base64');
  return { key: fs.readFileSync(key), cert: pem, fingerprint };
}

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));

before(async () => {
  fs.mkdirSync(downloadsDir, { recursive: true });
  site = http.createServer(handler);
  other = http.createServer(handler);
  P = await listen(site);
  P2 = await listen(other);
  // A port with nothing listening: HTTPS-First's upgrade there fails.
  const closed = http.createServer();
  const CLOSED = await listen(closed);
  await new Promise((res) => closed.close(res));
  const tls = makeCert();
  if (tls) {
    secure = https.createServer({ key: tls.key, cert: tls.cert }, handler);
    HP = await listen(secure);
  }
  const ports = { [P2]: CLOSED, ...(HP ? { [P]: HP } : {}) };
  L = await launch({
    env: {
      LUMIO_DOWNLOADS: downloadsDir,
      LUMIO_HOST_RULES: 'MAP * 127.0.0.1',
      LUMIO_SAFE_BROWSING: `http://127.0.0.1:${P}/sb-list.txt`,
      LUMIO_HTTPS_PORTS: JSON.stringify(ports),
      ...(tls ? { LUMIO_TEST_TRUST_CERT: tls.fingerprint } : {}),
    },
    // A fake camera and microphone, so capture indicators can be tested anywhere.
    // (Not --use-fake-ui-for-media-stream: it would skip Lumio's permission handler.)
    args: ['--use-fake-device-for-media-stream'],
  });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await until(() => L.main(() => global.lumio.security.safeBrowsing.status().ready), 20_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
  other?.close();
  secure?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Safe Browsing
test('Safe Browsing: a listed site shows the red warning; Back to safety returns to the page before', async () => {
  await resetSecurity();
  assert.equal((await security((s) => s.safeBrowsing.status())).ready, true, 'the test list was downloaded');
  await go(`http://127.0.0.1:${P}/before-evil`, 'Page before-evil');
  const before = hits((h) => h.host === LISTED[0]).length;
  await go(`http://${LISTED[0]}:${P}/`);
  assert.equal(await warning('unsafe'), 'Dangerous site');
  assert.ok(await L.page(`document.body.classList.contains('alarm')`), 'the red warning');
  assert.equal(hits((h) => h.host === LISTED[0]).length, before, 'the site was never asked for the page');
  const tab = await activeTab();
  assert.equal(tab.warning, 'unsafe');
  assert.equal(tab.url, `http://${LISTED[0]}:${P}/`, 'the address bar shows the stopped address');
  await shot('security-01-unsafe');
  await act('back');
  assert.ok(await until(async () => (await url()) === `http://127.0.0.1:${P}/before-evil`), 'back to the page before');
});

test('Safe Browsing: in a new tab, Back to safety opens the new tab page', async () => {
  await resetSecurity();
  await L.main((_e, u) => { global.lumio.tabs.create(u); return true; }, `http://${LISTED[1]}:${P}/`);
  assert.equal(await warning('unsafe'), 'Dangerous site');
  await act('back');
  assert.ok(await until(async () => (await url()).startsWith('lumio://newtab')), 'a new tab page');
  await L.main(() => global.lumio.cmd.closeTab());
});

test('Safe Browsing: Details › visit this unsafe site continues, and is remembered for the site', async () => {
  await resetSecurity();
  await go(`http://${LISTED[0]}:${P}/proceed`);
  await warning('unsafe');
  await act('details');
  assert.ok(await until(() => L.page(`!document.getElementById('details').hidden && !!document.querySelector('#details [data-act=proceed]')`)));
  await shot('security-02-unsafe-details');
  await act('proceed');
  assert.ok(await until(async () => (await title()) === 'Page proceed'), 'the unsafe page loads');
  assert.equal((await activeTab()).warning, null);
  // Continuing is remembered for the site until Lumio quits.
  await go(`http://${LISTED[0]}:${P}/again`, 'Page again');
});

test('Safe Browsing: “No protection” turns the warnings off', async () => {
  await resetSecurity();
  await security((s) => s.set({ safeBrowsing: 'off' }));
  assert.equal((await security((s) => s.settings())).lookalikes, false, 'lookalike warnings go with it');
  await go(`http://${LISTED[2]}:${P}/unprotected`, 'Page unprotected');
  assert.ok(hits((h) => h.host === LISTED[2]).length > 0);
  await resetSecurity();
});

// ---------------------------------------------------------------- HTTPS-First
test('HTTPS-First: off by default, http pages load as they are', async () => {
  await resetSecurity();
  assert.equal((await security((s) => s.settings())).httpsFirst, false);
  await go(`http://secure.${D}:${P}/first-off`, 'Page first-off');
  assert.equal(await url(), `http://secure.${D}:${P}/first-off`);
});

test('HTTPS-First: on, an http address opens over https', async (t) => {
  if (!HP) { t.skip(`no https server: ${certReason}`); return; }
  await resetSecurity();
  await security((s) => s.set({ httpsFirst: true }));
  await go(`http://secure.${D}:${P}/first-on`, 'Page first-on');
  assert.equal(await url(), `https://secure.${D}:${HP}/first-on`);
  assert.ok(hits((h) => h.path === '/first-on' && h.secure).length > 0, 'the https server answered');
  assert.equal(hits((h) => h.path === '/first-on' && !h.secure).length, 0, 'never asked over http');
  await resetSecurity();
});

test('HTTPS-First: a site without https warns, and Continue to site opens the http page', async () => {
  await resetSecurity();
  await security((s) => s.set({ httpsFirst: true }));
  await go(`http://nohttps.${D}:${P2}/fallback`);
  assert.equal(await warning('https'), 'Connection is not secure');
  assert.equal((await activeTab()).warning, 'https');
  await shot('security-03-https-first');
  await act('proceed');
  assert.ok(await until(async () => (await title()) === 'Page fallback'));
  assert.equal(await url(), `http://nohttps.${D}:${P2}/fallback`);
  // Remembered for the site: the next page there isn't tried over https again.
  await go(`http://nohttps.${D}:${P2}/fallback-2`, 'Page fallback-2');
  assert.equal(await url(), `http://nohttps.${D}:${P2}/fallback-2`);
  await resetSecurity();
});

test('HTTPS-First: addresses on this computer are never upgraded', async () => {
  await resetSecurity();
  await security((s) => s.set({ httpsFirst: true }));
  await go(`http://127.0.0.1:${P}/local-first`, 'Page local-first');
  assert.equal(await url(), `http://127.0.0.1:${P}/local-first`);
  await go(`http://localhost:${P}/localhost-first`, 'Page localhost-first');
  assert.equal(await url(), `http://localhost:${P}/localhost-first`);
  await resetSecurity();
});

// ---------------------------------------------------------------- lookalikes
test('lookalikes: a copy of a well-known site asks “Did you mean …?”; Ignore continues', async () => {
  await resetSecurity();
  await go(`http://paypa1.com:${P}/login`);
  assert.equal(await warning('lookalike'), 'Did you mean paypal.com?');
  assert.ok(await L.page(`!!document.querySelector('[data-act=suggested]') && document.querySelector('[data-act=suggested]').textContent.includes('paypal.com')`));
  await shot('security-04-lookalike');
  await act('proceed');
  assert.ok(await until(async () => (await title()) === 'Page login'));
});

test('international addresses: mixed scripts stay in punycode, a plain one is shown in its own letters', async () => {
  await resetSecurity();
  // "аpple.com" with a Cyrillic а: a lookalike of apple.com, and never shown as letters.
  await go(`http://xn--pple-43d.com:${P}/idn`);
  assert.equal(await warning('lookalike'), 'Did you mean apple.com?');
  const spoof = await activeTab();
  assert.ok(spoof.shown.includes('xn--pple-43d.com'), `shown in punycode: ${spoof.shown}`);
  assert.ok(!spoof.shown.includes('аpple'));
  await go(`http://xn--mnchen-3ya.de:${P}/idn-ok`, 'Page idn-ok');
  const ok = await activeTab();
  assert.equal(ok.shown, `http://münchen.de:${P}/idn-ok`);
});

// ---------------------------------------------------------------- insecure forms
test('a secure page sending a form over http waits for Send anyway; Go back stays', async (t) => {
  if (!HP) { t.skip(`no https page: ${certReason}`); return; }
  await resetSecurity();
  const form = `https://secure.${D}:${HP}/form`;
  await go(form, 'Form page');
  const sent = () => hits((h) => h.path === '/submit' && h.method === 'POST').length;
  const before = sent();
  await L.page(`document.forms[0].requestSubmit(document.getElementById('send')); true`);
  assert.match(await warning('form'), /not secure/);
  assert.equal(sent(), before, 'nothing sent yet');
  await shot('security-05-insecure-form');
  await act('back');
  assert.ok(await until(async () => (await url()) === form), 'back on the form');
  // Again, and Send anyway: the form goes, with what was typed.
  await until(() => L.page(`!!document.forms[0]`));
  await L.page(`document.forms[0].requestSubmit(document.getElementById('send')); true`);
  await warning('form');
  await act('proceed');
  assert.ok(await until(async () => (await title()) === 'Submitted'));
  assert.equal(sent(), before + 1);
  assert.equal(hits((h) => h.path === '/submit' && h.method === 'POST').at(-1).body, 'q=hello');
});

// ---------------------------------------------------------------- downloads
const waitDownload = (name) => until(async () => (await downloads()).find((d) => d.name === name && d.danger) || null);

test('dangerous downloads: a misleading name waits for Keep or Discard', async () => {
  await resetSecurity();
  await go(`http://127.0.0.1:${P}/dl-page`, 'Downloads page');
  await L.page(`document.getElementById('exe').click(); true`);
  const d = await waitDownload('report.pdf.exe');
  assert.ok(d, 'listed, with a warning');
  assert.equal(d.danger.kind, 'deceptive');
  assert.equal(d.state, 'progressing');
  assert.equal(d.paused, true, 'it waits');
  await L.wait(500);
  const waiting = (await downloads()).find((x) => x.id === d.id);
  assert.equal(waiting.state, 'progressing', 'still waiting');
  assert.ok(waiting.danger, 'still warned about');
  // (A small file may have arrived whole already: it keeps a temporary name until it's kept.)
  assert.equal(fs.existsSync(d.path), false, 'not saved under its name yet');
  await shot('security-06-dangerous-download');
  // Discard: gone from the list, and not saved.
  await L.main((_e, id) => global.lumio.profiles.normal.downloads.action(id, 'discard'), d.id);
  assert.ok(await until(async () => !(await downloads()).some((x) => x.id === d.id)), 'discarded');
  assert.equal(fs.existsSync(d.path), false);
  // Again, and Keep: it finishes. (From the page loaded afresh: a second
  // download from the same page without a real click would first ask about
  // automatic downloads, main/site-controls.js.)
  await go(`http://127.0.0.1:${P}/dl-page?again`, 'Downloads page');
  await L.page(`document.getElementById('exe').click(); true`);
  const again = await until(async () => (await downloads()).find((x) => x.name === 'report.pdf.exe' && x.id !== d.id && x.danger) || null);
  assert.ok(again);
  await L.main((_e, id) => global.lumio.profiles.normal.downloads.action(id, 'keep'), again.id);
  const done = await until(async () => (await downloads()).find((x) => x.id === again.id && x.state === 'completed') || null, 15_000);
  assert.ok(done, 'kept: it completes');
  assert.equal(done.danger, undefined);
  assert.ok(fs.existsSync(done.path));
  await L.main((_e, id) => global.lumio.profiles.normal.downloads.action(id, 'remove'), again.id);
});

test('dangerous downloads: a file sent over http from a secure page waits too', async (t) => {
  if (!HP) { t.skip(`no https page: ${certReason}`); return; }
  await resetSecurity();
  await go(`https://secure.${D}:${HP}/dl-page`, 'Downloads page');
  await L.page(`document.getElementById('plain').click(); true`);
  const d = await waitDownload('file.bin');
  assert.ok(d, 'listed, with a warning');
  assert.equal(d.danger.kind, 'insecure');
  assert.equal(d.state, 'progressing');
  await L.main((_e, id) => global.lumio.profiles.normal.downloads.action(id, 'discard'), d.id);
  assert.ok(await until(async () => !(await downloads()).some((x) => x.id === d.id)));
});

// ---------------------------------------------------------------- tracking protection
test('tracking protection: trackers on other sites are blocked, unless the site is allowed', async () => {
  await resetSecurity();
  const origin = `http://news.${D}:${P}`;
  await siteSettings((s, o) => s.set(o, 'trackers', 'default'), origin);
  assert.equal(await siteSettings((s) => s.defaultOf('trackers')), 'block', 'on by default');
  const pixel = () => hits((h) => h.host === TRACKER && h.path === '/pixel.png').length;
  const before = pixel();
  await go(`${origin}/embed-tracker`, 'Tracker page');
  assert.ok(await until(() => L.main(() => global.lumio.profiles.normal.security.extras.blockedOn(global.lumio.tabs.wc().id) > 0)), 'counted as blocked');
  await L.wait(500);
  assert.equal(pixel(), before, 'the tracker was never asked');
  assert.equal(await L.page(`document.getElementById('px').naturalWidth`), 0);
  // This site is allowed its ads and trackers.
  await siteSettings((s, o) => s.set(o, 'trackers', 'allow'), origin);
  await go(`${origin}/embed-tracker?allowed`, 'Tracker page');
  assert.ok(await until(async () => pixel() > before), 'the tracker loads');
  assert.ok(await until(() => L.page(`document.getElementById('px').naturalWidth === 1`)));
  await siteSettings((s, o) => s.set(o, 'trackers', 'default'), origin);
});

test('privacy signals: Global Privacy Control by default, Do Not Track only when on', async () => {
  await resetSecurity();
  const last = (p) => hits((h) => h.path === p).at(-1)?.headers || {};
  await go(`http://signals.${D}:${P}/signals-1`, 'Page signals-1');
  assert.equal(last('/signals-1')['sec-gpc'], '1', 'Sec-GPC: 1');
  assert.equal(last('/signals-1').dnt, undefined, 'no DNT');
  assert.equal(await L.page('navigator.globalPrivacyControl'), true);
  await security((s) => s.set({ doNotTrack: true }));
  await go(`http://signals.${D}:${P}/signals-2`, 'Page signals-2');
  assert.equal(last('/signals-2').dnt, '1', 'DNT: 1');
  assert.equal(last('/signals-2')['sec-gpc'], '1');
  await security((s) => s.set({ doNotTrack: false, gpc: false }));
  await go(`http://signals.${D}:${P}/signals-3`, 'Page signals-3');
  assert.equal(last('/signals-3')['sec-gpc'], undefined, 'GPC off: not sent');
  assert.equal(last('/signals-3').dnt, undefined);
  assert.notEqual(await L.page('navigator.globalPrivacyControl'), true);
  await resetSecurity();
});

// ---------------------------------------------------------------- secure DNS
test('secure DNS: changing it keeps the other settings, and pages still load', async () => {
  await resetSecurity();
  await security((s) => s.set({ doNotTrack: true }));
  let st = await security((s) => s.set({ secureDns: { on: false } }));
  assert.equal(st.secureDns.on, false);
  assert.equal(st.secureDns.provider, 'os');
  assert.equal(st.doNotTrack, true, 'other settings kept');
  await go(`http://dns.${D}:${P}/dns-off`, 'Page dns-off');
  // A custom provider on this computer (it never answers): names Lumio maps
  // itself and addresses still work. Lumio can't check DNS over HTTPS here.
  st = await security((s, custom) => s.set({ secureDns: { on: true, provider: 'custom', custom } }), `https://doh.${D}/dns-query`);
  assert.deepEqual(st.secureDns, { on: true, provider: 'custom', custom: `https://doh.${D}/dns-query` });
  assert.deepEqual(await security((s) => s.store.settings.security.secureDns), st.secureDns, 'saved');
  await go(`http://127.0.0.1:${P}/dns-custom`, 'Page dns-custom');
  // Nonsense is left out.
  st = await security((s) => s.set({ secureDns: { provider: 'nope', on: 'yes' } }));
  assert.equal(st.secureDns.provider, 'custom');
  await resetSecurity();
  assert.deepEqual((await security((s) => s.settings())).secureDns, { on: true, provider: 'os', custom: '' });
});

// ---------------------------------------------------------------- capture indicators
test('capture indicators: a page using the camera gets the red dot until it stops', async (t) => {
  await resetSecurity();
  const origin = `http://127.0.0.1:${P}`;
  await siteSettings((s, o) => s.set(o, 'camera', 'allow'), origin);
  await go(`${origin}/camera`, 'Camera');
  const got = await L.page(`navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { window.__cam = s; return 'ok'; }, (e) => e.name)`);
  if (got !== 'ok') {
    await siteSettings((s, o) => s.set(o, 'camera', 'default'), origin);
    t.skip(`no camera here, even a fake one (${got})`);
    return;
  }
  assert.ok(await until(async () => (await activeTab()).capture?.camera === true), 'the tab uses the camera');
  assert.equal((await activeTab()).capture.microphone, false);
  assert.ok(await until(() => L.shell(`(() => { const t = document.querySelector('.tab.active'); return !!t && !t.querySelector('.rec-dot').hidden && t.title.includes('Using your camera'); })()`)), 'the red dot and tooltip');
  await shot('security-07-camera');
  await L.page(`window.__cam.getTracks().forEach((t) => t.stop()); true`);
  assert.ok(await until(async () => (await activeTab()).capture === null), 'stopping the camera ends it');
  assert.ok(await until(() => L.shell(`document.querySelector('.tab.active .rec-dot').hidden`)));
  await siteSettings((s, o) => s.set(o, 'camera', 'default'), origin);
});

// ---------------------------------------------------------------- settings pages
test('Settings › Security: Safe Browsing and Always use secure connections change the settings', async () => {
  await resetSecurity();
  await go('lumio://settings/security', 'Security');
  assert.ok(await until(() => L.page(`!document.getElementById('view').hasAttribute('aria-busy') && !!document.querySelector('input[data-key=httpsFirst]')`)));
  assert.ok(await L.page(`document.querySelector('input[name=sb][value=standard]').checked`));
  assert.match(await L.page(`document.getElementById('lists').textContent`), /Lists updated/, 'the test list counts');
  await shot('security-08-settings-security');
  await L.page(`document.querySelector('input[data-key=httpsFirst]').click(); true`);
  assert.ok(await until(async () => (await security((s) => s.settings())).httpsFirst === true));
  await L.page(`document.querySelector('input[name=sb][value=off]').click(); true`);
  assert.ok(await until(async () => (await security((s) => s.settings())).safeBrowsing === 'off'));
  await L.page(`document.querySelector('input[data-key=dnsOn]').click(); true`);
  assert.ok(await until(async () => (await security((s) => s.settings())).secureDns.on === false));
  assert.ok(await L.page(`document.getElementById('dns-row').hidden`));
  // Reloaded, the page shows what was saved.
  await go('lumio://settings/security?again', 'Security');
  assert.ok(await until(() => L.page(`document.querySelector('input[name=sb][value=off]')?.checked === true && document.querySelector('input[data-key=httpsFirst]').checked`)));
  await resetSecurity();
});

test('Settings › Tracking protection: ads and trackers, Do Not Track and GPC change the settings', async () => {
  await resetSecurity();
  await go('lumio://settings/trackingProtection', 'Tracking protection');
  assert.ok(await until(() => L.page(`!!document.querySelector('input[data-key=doNotTrack]')`)));
  assert.ok(await L.page(`document.querySelector('input[data-key=trackers]').checked && document.querySelector('input[data-key=gpc]').checked && !document.querySelector('input[data-key=doNotTrack]').checked`));
  await shot('security-09-settings-tracking');
  await L.page(`document.querySelector('input[data-key=doNotTrack]').click(); true`);
  assert.ok(await until(async () => (await security((s) => s.settings())).doNotTrack === true));
  await L.page(`document.querySelector('input[data-key=gpc]').click(); true`);
  assert.ok(await until(async () => (await security((s) => s.settings())).gpc === false));
  await L.page(`document.querySelector('input[data-key=trackers]').click(); true`);
  assert.ok(await until(async () => (await siteSettings((s) => s.defaultOf('trackers'))) === 'allow'));
  await L.page(`document.querySelector('input[data-key=trackers]').click(); true`);
  assert.ok(await until(async () => (await siteSettings((s) => s.defaultOf('trackers'))) === 'block'));
  await siteSettings((s) => s.setDefault('trackers', 'block'));
  await resetSecurity();
});

// ---------------------------------------------------------------- Password Checkup
test('Password Checkup: only hash prefixes are sent, and a breached password is flagged', async (t) => {
  const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
  const breachedPw = 'correct-horse-battery-e2e-1';
  const safePw = 'Another!Unbreached#Pass42';
  const breached = { [sha1(breachedPw).slice(0, 5)]: sha1(breachedPw).slice(5) };
  if (!(await L.main(() => global.lumio.passwords.store.available()))) { t.skip('password encryption isn’t available here'); return; }
  // Lumio's fetch for the checkup is replaced: the real service is never asked.
  await L.main((_e, map) => {
    const c = global.lumio.security.checkup;
    global.__checkupFetch = c.fetch;
    global.__checkupCalls = [];
    c.fetch = async (u, init) => {
      global.__checkupCalls.push({ url: String(u), padding: init?.headers?.['Add-Padding'] || null });
      const prefix = String(u).slice(-5);
      const lines = ['0123456789ABCDEF0123456789ABCDEF012:0'];
      if (map[prefix]) lines.push(`${map[prefix]}:42`);
      return new Response(lines.join('\r\n'), { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    return true;
  }, breached);
  const ids = await L.main((_e, pws) => pws.map((p, i) => global.lumio.passwords.store.save({ origin: `https://checkup-${i}.lumio-e2e.net`, username: 'sam', password: p })), [breachedPw, safePw]);
  try {
    const summary = await L.main(() => global.lumio.security.checkup.run());
    assert.equal(summary.error, undefined);
    assert.ok(summary.compromised >= 1);
    const flags = await L.main(() => global.lumio.security.checkup.flags());
    assert.equal(flags[ids[0]], true, 'the breached password');
    assert.equal(flags[ids[1]], false, 'the other one');
    const calls = await L.main(() => global.__checkupCalls);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.match(c.url, /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/, 'only a 5-character prefix');
      assert.equal(c.padding, 'true');
      assert.ok(!c.url.includes(breachedPw) && !c.url.includes(safePw));
    }
    // The Passwords page shows the result.
    await go('lumio://passwords', 'Passwords');
    const state = await until(() => L.page(`window.lumioPage.invoke('page:password-checkup')`));
    assert.equal(state.flags[ids[0]], true);
    await shot('security-10-password-checkup');
  } finally {
    await L.main((_e, list) => {
      const c = global.lumio.security.checkup;
      c.fetch = global.__checkupFetch;
      for (const id of list) global.lumio.passwords.store.remove(id);
      return true;
    }, ids);
  }
});
