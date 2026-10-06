// End-to-end tests for site controls: the permission chip and bubble, site
// settings that act on pages (JavaScript, images, sound, PDFs, automatic
// downloads), third-party cookies, the Site settings and Delete browsing
// data pages, and deleting site data when windows close.
// Two local sites: 127.0.0.1 and localhost are different sites to Chromium.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lumio-site-e2e-'));
let L;
let site;
let a; // http://127.0.0.1:port
let b; // http://localhost:port, another site
const seen = []; // [path, cookie header] the server got

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
const go = async (url, expectTitle) => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), url);
  if (expectTitle) assert.ok(await until(async () => (await title()).includes(expectTitle)), `page "${expectTitle}" loaded`);
};
// The normal profile's site settings, from the main process.
const settings = (fn, arg) => L.main(new Function('_e', 'arg', `const s = global.lumio.profiles.normal.permissions.settings; return (${fn})(s, arg);`), arg);
const reset = () => settings((s) => { for (const x of s.sites()) s.resetSite(x.origin); for (const c of ['notifications', 'javascript', 'images', 'thirdPartyCookies', 'pdfDocuments', 'siteData', 'sound']) s.setDefault(c, ({ notifications: 'quiet', thirdPartyCookies: 'block-incognito', pdfDocuments: 'open', siteData: 'allow' })[c] || 'allow'); return true; });

before(async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    seen.push([u.pathname, q.headers.cookie || '']);
    // Cross-site cookies must be SameSite=None and Secure (local addresses count as secure).
    if (u.pathname === '/set') { r.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'cross=me; Path=/; SameSite=None; Secure; Max-Age=3600' }); r.end('<title>Cookie set</title>'); return; }
    if (u.pathname === '/set-plain') { r.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'who=me; Path=/; Max-Age=3600' }); r.end('<title>Cookie set</title>'); return; }
    if (u.pathname === '/pixel.png') { r.writeHead(200, { 'content-type': 'image/png', 'set-cookie': 'pixel=1; Path=/; SameSite=None' }); r.end(png); return; }
    if (u.pathname === '/embed') { r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<title>Embeds</title><img id="px" src="${u.searchParams.get('src')}">`); return; }
    if (u.pathname === '/js') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>No JS</title><script>document.title = "JS ran"</script>'); return; }
    if (u.pathname === '/img') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Images</title><img id="i" src="/pixel.png">'); return; }
    if (u.pathname === '/doc.pdf') { r.writeHead(200, { 'content-type': 'application/pdf' }); r.end('%PDF-1.4\n%%EOF\n'); return; }
    if (u.pathname.startsWith('/file')) { r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${u.pathname.slice(1)}.bin"` }); r.end(Buffer.alloc(1024, 1)); return; }
    if (u.pathname === '/two-downloads') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end('<title>Two downloads</title><a id="a1" href="/file-one" download></a><a id="a2" href="/file-two" download></a>');
      return;
    }
    if (u.pathname === '/ask') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Asks</title><p>asks</p>'); return; }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${u.pathname.slice(1)}</title><h1>${u.pathname}</h1>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  a = `http://127.0.0.1:${site.address().port}`;
  b = `http://localhost:${site.address().port}`;
  L = await launch({ env: { LUMIO_DOWNLOADS: path.join(tmp, 'downloads') } });
  fs.mkdirSync(path.join(tmp, 'downloads'), { recursive: true });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  await L?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a quiet notification request shows the chip; allowing it from the bubble remembers it', async () => {
  await reset();
  await go(`${a}/ask`, 'Asks');
  await L.page('window.__answer = null; Notification.requestPermission().then((p) => { window.__answer = p; }); true');
  assert.ok(await until(() => L.shell(`!document.getElementById('perm-chip').hidden && document.getElementById('perm-chip').classList.contains('quiet')`)), 'the quiet chip');
  assert.equal(await L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current)), null, 'no bubble by itself');
  await shot('site-01-quiet-chip');
  await L.shell(`document.getElementById('perm-chip').click(); true`);
  assert.ok(await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'permission')));
  const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
  assert.ok(await until(() => overlay(`!!document.querySelector('.pb [data-d=allow]')`)));
  await shot('site-02-quiet-bubble');
  await overlay(`document.querySelector('.pb [data-d=allow]').click(); true`);
  assert.equal(await until(() => L.page('window.__answer')), 'granted');
  assert.equal(await settings((s, o) => s.exception(o, 'notifications'), a), 'allow');
  assert.ok(await until(() => L.shell(`document.getElementById('perm-chip').hidden`)));
  await reset();
});

test('a question opens the bubble by itself; "Don’t allow" is remembered and blocks the next one', async () => {
  await reset();
  await settings((s) => s.setDefault('notifications', 'ask'));
  await go(`${b}/ask`, 'Asks');
  await L.page('window.__answer = null; Notification.requestPermission().then((p) => { window.__answer = p; }); true');
  assert.ok(await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'permission')), 'the bubble opens by itself');
  assert.equal(await L.shell(`document.querySelector('#perm-chip .pc-t').textContent`), 'Send notifications?');
  const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
  assert.ok(await until(() => overlay(`document.querySelectorAll('.pb-btn').length === 2`)), 'notifications: Allow / Don’t allow');
  await shot('site-03-bubble');
  await overlay(`document.querySelector('.pb [data-d=block]').click(); true`);
  assert.equal(await until(() => L.page('window.__answer')), 'denied');
  assert.equal(await settings((s, o) => s.exception(o, 'notifications'), b), 'block');
  // Asked again: blocked at once, with the crossed-out chip.
  await L.page('Notification.requestPermission(); true');
  assert.ok(await until(() => L.shell(`document.getElementById('perm-chip').classList.contains('blocked')`)));
  await reset();
});

test('JavaScript off for a site: its scripts don’t run, and the address bar says so', async () => {
  await reset();
  await go(`${a}/js`, 'JS ran');
  await settings((s, o) => s.set(o, 'javascript', 'block'), a);
  await go(`${a}/js?again`);
  assert.ok(await until(async () => (await title()) === 'No JS'), 'the script was blocked');
  assert.ok(await until(() => L.shell(`document.querySelector('#perm-chip .pc-t')?.textContent === 'JavaScript blocked'`)));
  await shot('site-04-js-blocked');
  // Other sites still run JavaScript.
  await go(`${b}/js`, 'JS ran');
  await reset();
});

test('images off for a site: its images don’t load', async () => {
  await reset();
  await settings((s, o) => s.set(o, 'images', 'block'), a);
  await go(`${a}/img`, 'Images');
  await L.wait(500);
  assert.equal(await L.page(`document.getElementById('i').naturalWidth`), 0);
  assert.ok(await until(() => L.shell(`document.querySelector('#perm-chip .pc-t')?.textContent === 'Images blocked'`)));
  await reset();
  await go(`${a}/img?again`, 'Images');
  assert.ok(await until(() => L.page(`document.getElementById('i').naturalWidth === 1`)));
});

test('third-party cookies: blocked for other sites in a page when Settings says so', async (t) => {
  await reset();
  await go(`${b}/set`, 'Cookie set'); // localhost sets a cookie as the page itself
  const embedded = async () => {
    seen.length = 0;
    await go(`${a}/embed?src=${encodeURIComponent(`${b}/pixel.png`)}&t=${Date.now()}`, 'Embeds');
    await until(async () => seen.some(([p]) => p === '/pixel.png'));
    return seen.find(([p]) => p === '/pixel.png')[1];
  };
  // Allowed in normal windows by default, if this Chromium sends cross-site cookies to a local address at all.
  if (!/cross=me/.test(await embedded())) { await reset(); t.skip('Chromium doesn’t send cross-site cookies to http://localhost here'); return; }
  await settings((s) => s.setDefault('thirdPartyCookies', 'block'));
  assert.doesNotMatch(await embedded(), /cross=me/, 'blocked: no cookies to the other site');
  // A site allowed to use them.
  await settings((s, o) => s.set(o, 'thirdPartyCookies', 'allow'), a);
  assert.match(await embedded(), /cross=me/);
  await reset();
});

test('sound: a muted site’s tab is muted when it gets there', async () => {
  await reset();
  await settings((s, o) => s.set(o, 'sound', 'block'), a);
  await go(`${a}/quiet-page`, 'quiet-page');
  assert.ok(await until(() => L.main(() => global.lumio.tabs.active.muted && global.lumio.tabs.wc().isAudioMuted())));
  await reset();
  await go(`${b}/loud-page`, 'loud-page');
  assert.ok(await until(() => L.main(() => !global.lumio.tabs.wc().isAudioMuted())), 'Lumio unmutes what it muted');
});

test('PDFs: "Download PDFs" saves them instead of opening them', async () => {
  await reset();
  await settings((s) => s.setDefault('pdfDocuments', 'download'));
  const before = await L.main(() => global.lumio.store.downloads().length);
  await go(`${a}/page-before-pdf`, 'page-before-pdf');
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${a}/doc.pdf`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.store.downloads().length)) > before), 'downloaded');
  assert.match(await L.main(() => global.lumio.tabs.wc().getURL()), /page-before-pdf/);
  await reset();
});

test('automatic downloads: a page’s second download without a click asks first', async () => {
  await reset();
  await go(`${a}/two-downloads`, 'Two downloads');
  const count = () => L.main(() => global.lumio.store.downloads().filter((d) => /file-(one|two)/.test(d.name)).length);
  const start = await count();
  await L.page(`document.getElementById('a1').click(); setTimeout(() => document.getElementById('a2').click(), 300); true`);
  assert.ok(await until(() => L.shell(`document.querySelector('#perm-chip .pc-t')?.textContent === 'Download files?'`)), 'the second one asks');
  assert.equal(await count(), start + 2, 'both listed; the second waits');
  const overlay = (code) => L.main((_e, c) => global.lumio.current.overlay.webContents.executeJavaScript(c), code);
  await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'permission'));
  await overlay(`document.querySelector('.pb [data-d=allow]').click(); true`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.store.downloads().filter((d) => /file-two/.test(d.name) && d.state === 'completed').length)) > 0), 'allowed: it finishes');
  assert.equal(await settings((s, o) => s.exception(o, 'automaticDownloads'), a), 'allow');
  await reset();
});

test('site info: cookies, settings with defaults, and Site settings opens the site’s page', async () => {
  await reset();
  await go(`${b}/set-plain?info`, 'Cookie set');
  const info = await L.shell(`window.lumio.invoke('site:info')`);
  assert.ok(info.cookies >= 1);
  assert.deepEqual(info.permissions.map((p) => p.permission).slice(0, 4), ['geolocation', 'camera', 'microphone', 'notifications']);
  assert.equal(info.permissions.find((p) => p.permission === 'notifications').default, 'quiet');
  await L.shell(`window.lumio.send('site:set-permission', { permission: 'javascript', value: 'block' }); true`);
  assert.ok(await until(async () => (await L.shell(`window.lumio.invoke('site:info')`)).reload), 'JavaScript needs a reload');
  await L.shell(`window.lumio.send('site:settings'); true`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())).startsWith('lumio://settings/content/siteDetails?site=')));
  assert.ok(await until(() => L.page(`document.querySelector('select[data-id=javascript]')?.value === 'block'`)));
  await shot('site-05-site-details');
  await L.page(`(() => { const s = document.querySelector('select[data-id=javascript]'); s.value = 'default'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`);
  assert.ok(await until(async () => (await settings((s, o) => s.exception(o, 'javascript'), b)) === undefined));
  await L.main(() => global.lumio.cmd.closeTab());
  await reset();
});

test('Site settings pages: categories, All sites with this site’s cookies, Third-party cookies', async () => {
  await go('lumio://settings/content', 'Site settings');
  assert.ok(await until(() => L.page(`document.querySelectorAll('a.row.link').length > 5`)));
  await go('lumio://settings/content/all', 'All sites');
  assert.ok(await until(() => L.page(`[...document.querySelectorAll('.site')].some((r) => r.dataset.site === 'localhost')`)), 'localhost has cookies');
  await shot('site-06-all-sites');
  await go('lumio://settings/cookies', 'Third-party cookies');
  await L.page(`document.querySelector('input[name=default][value=block]').click(); true`);
  assert.ok(await until(async () => (await settings((s) => s.defaultOf('thirdPartyCookies'))) === 'block'));
  await go('chrome://settings/content/javascript', 'JavaScript');
  await reset();
});

test('Delete browsing data: ⇧⌘⌫ opens it; a time range deletes only recent history and cookies', async () => {
  await go(`${a}/recent-page`, 'recent-page');
  await L.main((_e, u) => global.lumio.store.importHistory([{ url: u, title: 'Old visit', time: Date.now() - 10 * 86400000 }]), `${a}/old-visit`);
  await L.main(() => global.lumio.cmd.clearBrowsingData());
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://settings/clearBrowserData'));
  assert.ok(await until(() => L.page(`!/…/.test(document.getElementById('note-history')?.textContent || '…')`)), 'counts arrive');
  await shot('site-07-delete-browsing-data');
  await L.page(`(() => {
    const r = document.getElementById('range'); r.value = '3600000'; r.dispatchEvent(new Event('change'));
    document.querySelectorAll('#cd-list input[type=checkbox]').forEach((c) => { if (c.checked !== (c.value === 'history' || c.value === 'cookies')) c.click(); });
    document.getElementById('go').click();
    return true;
  })()`);
  assert.ok(await until(async () => !(await L.main(() => global.lumio.store.history().some((h) => h.url.endsWith('/recent-page'))))));
  assert.ok(await L.main(() => global.lumio.store.history().some((h) => h.title === 'Old visit')), 'older history stays');
  // The cookie localhost set this session is gone.
  assert.ok(await until(async () => (await L.main(() => global.lumio.profiles.normal.session.cookies.get({ name: 'who' }))).length === 0));
  // Opened on its own, it leaves for Settings when done.
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://settings/#privacy'));
  await L.main(() => global.lumio.cmd.closeTab());
});

test('data on exit: deleting when windows close keeps the sites allowed to save data', async () => {
  await reset();
  await go(`${a}/set-plain`, 'Cookie set');
  await go(`${b}/set-plain`, 'Cookie set');
  await settings((s) => s.setDefault('siteData', 'session'));
  await settings((s, o) => s.set(o, 'siteData', 'allow'), a);
  await L.main(() => global.lumio.profiles.normal.siteControls.clearSessionData());
  const left = await L.main(() => global.lumio.profiles.normal.session.cookies.get({ name: 'who' }).then((cs) => cs.map((c) => c.domain)));
  assert.deepEqual(left, ['127.0.0.1']);
  await reset();
});
