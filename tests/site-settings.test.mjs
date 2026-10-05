// Site settings (main/site-settings.js), sites (main/sites.js), the network
// hooks and third-party cookies (main/privacy.js), permission prompts
// (main/features.js), what settings do to pages (main/site-controls.js),
// deleting browsing data (main/browsing-data.js) and the settings pages'
// addresses (main/protocol.js). No Electron: sessions and pages are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../main/store.js');
const { SiteSettings, CATEGORIES, BY_ID, originOf } = require('../main/site-settings.js');
const { SiteResolver, fallbackSite } = require('../main/sites.js');
const privacy = require('../main/privacy.js');
const { Permissions, categoriesFor } = require('../main/features.js');
const { SiteControls } = require('../main/site-controls.js');
const { BrowsingData, CookieClock } = require('../main/browsing-data.js');
const { indexedDbOrigins } = require('../main/site-data.js');
const { resolveFile, PAGE_HOSTS } = require('../main/protocol.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-site-'));
const store = () => new Store(tmp(), null);

// A public suffix list small enough to read: what Chromium's cookie check would say.
const SUFFIXES = new Set(['com', 'org', 'uk', 'co.uk', 'io', 'github.io', 'test']);
const fakeProbe = (calls = []) => async (host, domain) => { calls.push(domain); return !SUFFIXES.has(domain) && (host === domain || host.endsWith('.' + domain)); };
const resolver = () => new SiteResolver(fakeProbe());

// A session's webRequest with the listeners Lumio installs.
function fakeSession() {
  const listeners = {};
  const wr = {};
  for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']) wr[name] = (fn) => { listeners[name] = fn; };
  const handlers = {};
  return {
    webRequest: wr,
    listeners,
    handlers,
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
    cleared: [],
    clearStorageData: async (o) => { handlers.cleared = o; },
    clearData: async (o) => { handlers.clearData = o; },
  };
}
// Runs one listener and resolves with what it answered.
const run = (ses, name, details) => new Promise((resolve) => ses.listeners[name](details, resolve));
const wcAt = (url, id = 7) => ({ id, getURL: () => url, isDestroyed: () => false });

// ---------------------------------------------------------------- site settings
test('categories: every one has words for each option and a list name for each exception', () => {
  for (const c of CATEGORIES) {
    for (const v of c.options) assert.ok(c.text[v], `${c.id} says what ${v} means`);
    assert.ok(c.options.includes(c.default), `${c.id}'s default is an option`);
    for (const v of c.kind === 'global' ? [] : c.exceptions || ['allow', 'block']) assert.ok(c.lists[v], `${c.id} names its ${v} list`);
    if (c.kind === 'permission' && c.prompt) assert.ok(c.chip && c.blocked, `${c.id} has chip words`);
  }
  for (const id of ['geolocation', 'camera', 'microphone', 'notifications', 'clipboard', 'popups', 'sound', 'automaticDownloads', 'javascript', 'images', 'insecureContent', 'windowManagement', 'midi', 'usb', 'hid', 'serial', 'bluetooth', 'fileEditing', 'protectedContent', 'backgroundSync', 'thirdPartyCookies', 'siteData', 'pdfDocuments']) {
    assert.ok(BY_ID[id], `${id} exists`);
  }
});

test('site settings: defaults, exceptions per origin, typed sites and bad values', () => {
  const s = new SiteSettings({ store: store() });
  assert.equal(s.value('https://a.com', 'geolocation'), 'ask');
  assert.equal(s.value('https://a.com', 'notifications'), 'quiet', 'notification requests are quiet by default');
  assert.equal(s.value('https://a.com', 'popups'), 'block');
  assert.equal(s.defaultOf('thirdPartyCookies'), 'block-incognito');
  assert.equal(s.set('a.com', 'geolocation', 'allow'), true, 'a typed site means https');
  assert.equal(s.exception('https://a.com', 'geolocation'), 'allow');
  assert.equal(s.store.settings.sitePermissions['https://a.com'].geolocation, true, 'stored as true, like older versions');
  assert.equal(s.set('https://a.com/some/page', 'javascript', 'block'), true);
  assert.equal(s.value('https://a.com', 'javascript'), 'block');
  assert.equal(s.set('https://a.com', 'insecureContent', 'block'), false, 'insecure content can only be allowed');
  assert.equal(s.set('https://a.com', 'pdfDocuments', 'download'), false, 'PDFs have no per-site setting');
  assert.equal(s.set('javascript:alert(1)', 'images', 'block'), false);
  assert.equal(s.set('https://a.com', 'nope', 'allow'), false);
  assert.equal(s.set('https://a.com', 'siteData', 'session'), true);
  assert.equal(s.value('https://a.com', 'siteData'), 'session');
  // Back to the default; the last one removes the site.
  for (const id of ['geolocation', 'javascript']) s.set('https://a.com', id, 'ask');
  s.set('https://a.com', 'siteData', 'default');
  assert.deepEqual(s.store.settings.sitePermissions, {});
  assert.deepEqual(s.store.settings.siteSettingTimes, {});
  // Defaults change for every site; choosing the built-in one forgets it.
  assert.equal(s.setDefault('geolocation', 'block'), true);
  assert.equal(s.value('https://b.com', 'geolocation'), 'block');
  assert.equal(s.setDefault('geolocation', 'allow'), false, 'location can’t be allowed for every site');
  s.setDefault('geolocation', 'ask');
  assert.deepEqual(s.store.settings.contentDefaults, {});
  assert.equal(originOf('http://localhost:3000/x'), 'http://localhost:3000');
  assert.equal(originOf('file:///etc/passwd'), null);
});

test('site settings: older permission names move to the categories', () => {
  const st = store();
  st.setSetting('sitePermissions', { 'https://meet.example': { media: true, 'clipboard-read': false, geolocation: true, midiSysex: false } });
  const s = new SiteSettings({ store: st });
  assert.deepEqual(st.settings.sitePermissions['https://meet.example'], { camera: true, microphone: true, clipboard: false, geolocation: true, midi: false });
  assert.equal(s.value('https://meet.example', 'camera'), 'allow');
});

test('incognito inherits blocks and content settings, never "allowed" permissions', () => {
  const st = store();
  const normal = new SiteSettings({ store: st });
  const incog = new SiteSettings({ store: st, persist: false, parent: normal });
  normal.set('https://a.com', 'camera', 'allow');
  normal.set('https://a.com', 'microphone', 'block');
  normal.set('https://a.com', 'javascript', 'block');
  normal.set('https://a.com', 'thirdPartyCookies', 'allow');
  assert.equal(incog.value('https://a.com', 'camera'), 'ask');
  assert.equal(incog.value('https://a.com', 'microphone'), 'block');
  assert.equal(incog.value('https://a.com', 'javascript'), 'block');
  assert.deepEqual(incog.effectiveExceptions('thirdPartyCookies'), [{ origin: 'https://a.com', value: 'allow' }]);
  // Its own choices stay in memory and win.
  incog.set('https://a.com', 'javascript', 'allow');
  assert.equal(incog.value('https://a.com', 'javascript'), 'allow');
  assert.equal(normal.value('https://a.com', 'javascript'), 'block');
  assert.equal(st.settings.sitePermissions['https://a.com'].javascript, false);
  // It hears the normal profile's changes until it's disposed.
  const heard = [];
  incog.onChange((o, id) => heard.push(id));
  normal.setDefault('images', 'block');
  incog.dispose();
  normal.setDefault('images', 'allow');
  assert.deepEqual(heard, ['images']);
});

test('site settings: recent changes, reset and deleting a time range', () => {
  const s = new SiteSettings({ store: store() });
  s.set('https://old.com', 'geolocation', 'block');
  s.set('https://new.com', 'sound', 'block');
  s.store.settings.siteSettingTimes['https://old.com'] = Date.now() - 10 * 864e5;
  assert.equal(s.count(), 2);
  assert.equal(s.count({ from: Date.now() - 3600e3 }), 1);
  assert.equal(s.clear({ from: Date.now() - 3600e3 }), 1);
  assert.deepEqual(s.sites().map((x) => x.origin), ['https://old.com']);
  assert.equal(s.resetSite('old.com'), true);
  assert.deepEqual(s.sites(), []);
});

// ---------------------------------------------------------------- sites
test('sites: the registrable domain comes from the cookie check, cached', async () => {
  const calls = [];
  const r = new SiteResolver(fakeProbe(calls));
  assert.equal(await r.siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(await r.siteOf('www.example.com'), 'example.com');
  assert.equal(await r.siteOf('me.github.io'), 'me.github.io', 'a private suffix');
  assert.equal(await r.siteOf('github.io'), 'github.io');
  assert.equal(await r.siteOf('127.0.0.1'), '127.0.0.1');
  assert.equal(await r.siteOf('localhost'), 'localhost');
  assert.equal(r.cached('www.example.com'), 'example.com');
  const before = calls.length;
  assert.equal(await r.siteOf('WWW.EXAMPLE.COM.'), 'example.com');
  assert.equal(calls.length, before, 'answered from the cache');
});

test('sites: a few common suffixes when the cookie check doesn’t work', async () => {
  const r = new SiteResolver(async () => { throw new Error('no cookies'); });
  assert.equal(await r.siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(await r.siteOf('cdn.example.com'), 'example.com');
  assert.equal(fallbackSite('example.com'), 'example.com');
});

// ---------------------------------------------------------------- network hooks
test('network hooks: installed only while a handler is active; a failing handler never blocks', async () => {
  const ses = fakeSession();
  const net = privacy.hooks(ses);
  assert.equal(privacy.hooks(ses), net, 'one per session');
  let on = false;
  net.add({ name: 'boom', active: () => on, beforeRequest: () => { throw new Error('boom'); } });
  net.add({ name: 'cancel-x', active: () => on, beforeRequest: (d) => d.url.includes('/x') });
  assert.equal(ses.listeners.onBeforeRequest, undefined);
  on = true;
  net.refresh();
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await run(ses, 'onBeforeRequest', { url: 'https://a.com/x' }), { cancel: true });
    assert.deepEqual(await run(ses, 'onBeforeRequest', { url: 'https://a.com/y' }), {});
  } finally { console.error = quiet; }
  assert.deepEqual(await run(ses, 'onBeforeRequest', { url: 'lumio://settings/x' }), {}, 'Lumio’s own pages are never touched');
  on = false;
  net.refresh();
  assert.equal(ses.listeners.onBeforeRequest, null, 'uninstalled');
});

test('third-party cookies: dropped for other sites in a page, by mode, with exceptions', async () => {
  const st = store();
  const settings = new SiteSettings({ store: st });
  const sites = resolver();
  const ses = fakeSession();
  const net = privacy.hooks(ses);
  const tpc = privacy.thirdPartyCookies({ settings, sites, incognito: false });
  net.add(tpc);
  const page = 'https://news.example.com/story';
  const req = (url, type = 'image', top = page) => ({ url, resourceType: type, webContents: { isDestroyed: () => false, getURL: () => top }, requestHeaders: { Cookie: 'id=1' }, responseHeaders: { 'Set-Cookie': ['id=2'], 'content-type': ['image/png'] } });
  assert.equal(ses.listeners.onBeforeSendHeaders, undefined, 'normal windows allow them by default');
  settings.setDefault('thirdPartyCookies', 'block');
  net.refresh();
  // A tracker on the page: no cookies either way.
  assert.deepEqual((await run(ses, 'onBeforeSendHeaders', req('https://ads.tracker.io/p.gif'))).requestHeaders, {});
  assert.deepEqual(await run(ses, 'onHeadersReceived', req('https://ads.tracker.io/p.gif')), { responseHeaders: { 'content-type': ['image/png'] } });
  // The site's own subdomains, and the page itself, keep theirs.
  assert.deepEqual((await run(ses, 'onBeforeSendHeaders', req('https://cdn.example.com/a.js', 'script'))).requestHeaders, { Cookie: 'id=1' });
  assert.deepEqual((await run(ses, 'onBeforeSendHeaders', req('https://ads.tracker.io/', 'mainFrame'))).requestHeaders, { Cookie: 'id=1' });
  assert.deepEqual(await run(ses, 'onHeadersReceived', req('https://cdn.example.com/a.js', 'script')), {});
  // Lumio's own pages aren't a site.
  assert.deepEqual((await run(ses, 'onBeforeSendHeaders', req('https://ads.tracker.io/f.ico', 'image', 'lumio://newtab/'))).requestHeaders, { Cookie: 'id=1' });
  // A site allowed in Settings: its embedded sites keep cookies.
  settings.set('example.com', 'thirdPartyCookies', 'allow');
  assert.deepEqual((await run(ses, 'onBeforeSendHeaders', req('https://ads.tracker.io/p.gif'))).requestHeaders, { Cookie: 'id=1' });
  // "Block in Incognito" only blocks there.
  settings.setDefault('thirdPartyCookies', 'block-incognito');
  net.refresh();
  assert.equal(ses.listeners.onBeforeSendHeaders, null);
  const incog = privacy.thirdPartyCookies({ settings: new SiteSettings({ store: st, persist: false, parent: settings }), sites, incognito: true });
  assert.equal(incog.active(), true);
  assert.equal(await incog.thirdParty(req('https://ads.tracker.io/p.gif', 'image', 'https://shop.org/')), true);
});

// ---------------------------------------------------------------- permission prompts
function permissions(opts = {}) {
  const ses = fakeSession();
  const emitted = [];
  const st = opts.store || store();
  const p = new Permissions(ses, { store: st, emitFor: (wcId, channel, payload) => emitted.push([channel, payload]), ...opts });
  const request = (permission, details = {}, wc = wcAt('https://maps.example/')) => new Promise((resolve) => ses.handlers.request(wc, permission, resolve, { requestingUrl: wc.getURL(), ...details }));
  const check = (permission, origin = 'https://maps.example', details = {}, wc = wcAt('https://maps.example/')) => ses.handlers.check(wc, permission, origin, details);
  return { p, ses, emitted, request, check, st };
}

test('permissions: the bubble’s three answers, remembered or not', async () => {
  const { p, emitted, request, check } = permissions();
  let answer = request('geolocation');
  const [, ask] = emitted.at(-1);
  assert.equal(emitted.at(-1)[0], 'permission');
  assert.deepEqual({ host: ask.host, quiet: ask.quiet, once: ask.once, cats: ask.cats.map((c) => c.id), prompt: ask.cats[0].prompt }, { host: 'maps.example', quiet: false, once: true, cats: ['geolocation'], prompt: 'Know your location' });
  assert.equal(check('geolocation'), false);
  p.respond(ask.id, 'once');
  assert.equal(await answer, true);
  assert.equal(check('geolocation'), true, 'allowed this time…');
  assert.equal(p.settings.exception('https://maps.example', 'geolocation'), undefined, '…without remembering it');
  p.navigated(7, 'https://maps.example/other');
  assert.equal(check('geolocation'), true, 'still on the site');
  p.navigated(7, 'https://elsewhere.example/');
  assert.equal(check('geolocation'), false, 'gone once the tab leaves the site');
  answer = request('geolocation');
  p.respond(emitted.at(-1)[1].id, 'allow');
  assert.equal(await answer, true);
  assert.equal(p.settings.exception('https://maps.example', 'geolocation'), 'allow');
  assert.equal(await request('geolocation'), true, 'remembered: no question');
  // Don't allow: remembered, and the next request is blocked with a notice.
  answer = request('clipboard-read');
  p.respond(emitted.at(-1)[1].id, 'block');
  assert.equal(await answer, false);
  assert.equal(await request('clipboard-read'), false);
  assert.equal(emitted.at(-1)[0], 'permission-blocked');
  assert.deepEqual(emitted.at(-1)[1].cat, 'clipboard');
  assert.equal(emitted.at(-1)[1].label, 'Clipboard blocked');
  // Dismissed: no for now, asked again next time.
  answer = request('midi');
  p.respond(emitted.at(-1)[1].id, 'dismiss');
  assert.equal(await answer, false);
  assert.equal(p.settings.exception('https://maps.example', 'midi'), undefined);
});

test('permissions: notifications are quiet, camera and microphone are asked together, screens every time', async () => {
  const { p, emitted, request, check } = permissions();
  request('notifications');
  assert.equal(emitted.at(-1)[1].quiet, true);
  assert.equal(emitted.at(-1)[1].once, false, 'Allow / Don’t allow only');
  const both = request('media', { mediaTypes: ['video', 'audio'] });
  const ask = emitted.at(-1)[1];
  assert.deepEqual(ask.cats.map((c) => c.id), ['camera', 'microphone']);
  p.respond(ask.id, 'allow');
  assert.equal(await both, true);
  assert.equal(check('media', 'https://maps.example', { mediaType: 'video' }), true);
  // The microphone blocked: a camera-and-microphone request fails without asking.
  p.settings.set('https://maps.example', 'microphone', 'block');
  assert.equal(await request('media', { mediaTypes: ['video', 'audio'] }), false);
  assert.equal(await request('media', { mediaTypes: ['video'] }), true);
  // Screen capture is asked each time and never remembered.
  const screen = request('media', { mediaTypes: [] });
  assert.deepEqual(emitted.at(-1)[1].cats.map((c) => c.id), ['screenShare']);
  p.respond(emitted.at(-1)[1].id, 'allow');
  assert.equal(await screen, true);
  request('media', { mediaTypes: [] });
  assert.equal(emitted.at(-1)[0], 'permission', 'asked again');
  assert.deepEqual(categoriesFor('window-management'), ['windowManagement']);
  assert.equal(check('window-management'), false, 'window management is no longer granted without asking');
  assert.equal(check('background-sync'), true, 'background sync is allowed by default');
  assert.equal(check('fullscreen'), true);
  assert.equal(await request('fileSystem', { fileAccessType: 'readable', filePath: '/tmp/a.txt' }), true, 'reading a file the person picked');
  request('fileSystem', { fileAccessType: 'writable', filePath: '/Users/me/notes.txt' });
  assert.equal(emitted.at(-1)[1].detail, 'notes.txt');
  assert.equal(await request('storage-access'), false);
});

test('permissions: one answer settles the same question, and leaving cancels', async () => {
  const { p, emitted, request } = permissions();
  const a = request('geolocation');
  const b = request('geolocation');
  assert.equal(emitted.filter(([c]) => c === 'permission').length, 1, 'one bubble for both');
  p.respond(emitted.at(-1)[1].id, 'block');
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  const c = request('notifications');
  const id = emitted.at(-1)[1].id;
  p.navigated(7, 'https://maps.example/next');
  assert.equal(await c, false);
  assert.deepEqual(emitted.at(-1), ['permission-cancel', { id }]);
});

test('permissions: incognito asks again for what normal windows allowed', async () => {
  const st = store();
  const normal = permissions({ store: st });
  normal.p.settings.set('https://maps.example', 'geolocation', 'allow');
  const incog = permissions({ store: st, persist: false, parent: normal.p.settings });
  incog.request('geolocation');
  assert.equal(incog.emitted.at(-1)[0], 'permission');
});

// ---------------------------------------------------------------- what settings do to pages
function controls() {
  const st = store();
  const ses = fakeSession();
  const emitted = [];
  const profile = { session: ses, incognito: false };
  profile.permissions = new Permissions(ses, { store: st, emitFor: (id, c, p) => emitted.push([c, p]) });
  const tabs = [];
  const sc = new SiteControls({ profile, sites: resolver(), emitFor: (id, c, p) => emitted.push([c, p]), tabs: () => tabs });
  return { sc, ses, st, emitted, settings: profile.permissions.settings, tabs };
}
const docReq = (url, type, top = url) => ({ url, resourceType: type, webContentsId: 7, webContents: { isDestroyed: () => false, getURL: () => top }, responseHeaders: { 'content-type': ['text/html'] } });

test('JavaScript off: a script-src none policy on the site’s pages and frames, and its scripts aren’t fetched', async () => {
  const { sc, ses, settings } = controls();
  assert.equal(ses.listeners.onHeadersReceived, undefined, 'nothing to do by default');
  settings.set('https://quiet.example', 'javascript', 'block');
  assert.deepEqual(ses.handlers.cleared, { origin: 'https://quiet.example', storages: ['serviceworkers'] }, 'its service worker goes too');
  const res = await run(ses, 'onHeadersReceived', { ...docReq('https://quiet.example/', 'mainFrame'), responseHeaders: { 'content-security-policy': ["default-src 'self'"] } });
  assert.deepEqual(res.responseHeaders['content-security-policy'], ["default-src 'self'", "script-src 'none'"]);
  const frame = await run(ses, 'onHeadersReceived', docReq('https://widget.other/', 'subFrame', 'https://quiet.example/'));
  assert.deepEqual(frame.responseHeaders['Content-Security-Policy'], ["script-src 'none'"], 'frames follow the page they’re in');
  assert.deepEqual(await run(ses, 'onBeforeRequest', docReq('https://cdn.other/app.js', 'script', 'https://quiet.example/')), { cancel: true });
  assert.deepEqual(await run(ses, 'onHeadersReceived', docReq('https://busy.example/', 'mainFrame')), {}, 'other sites keep JavaScript');
  assert.equal(sc.anyBlocked('javascript'), true);
});

test('images off: the site’s images are cancelled, with one notice per page', async () => {
  const { ses, settings, emitted } = controls();
  settings.setDefault('images', 'block');
  const img = docReq('https://img.cdn/x.png', 'image', 'https://text.example/');
  assert.deepEqual(await run(ses, 'onBeforeRequest', img), { cancel: true });
  assert.deepEqual(await run(ses, 'onBeforeRequest', img), { cancel: true });
  const notices = emitted.filter(([c]) => c === 'permission-blocked');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1].label, 'Images blocked');
  settings.set('https://text.example', 'images', 'allow');
  assert.deepEqual(await run(ses, 'onBeforeRequest', img), {});
});

test('PDFs: downloaded instead of opened when Settings says so', async () => {
  const { ses, settings } = controls();
  settings.setDefault('pdfDocuments', 'download');
  const pdf = (disposition) => run(ses, 'onHeadersReceived', { ...docReq('https://docs.example/a.pdf', 'mainFrame'), responseHeaders: { 'Content-Type': ['application/pdf'], ...(disposition ? { 'content-disposition': [disposition] } : {}) } });
  assert.deepEqual((await pdf()).responseHeaders['Content-Disposition'], ['attachment']);
  assert.deepEqual((await pdf('inline; filename="a.pdf"')).responseHeaders['Content-Disposition'], ['attachment; filename="a.pdf"']);
  assert.deepEqual(await pdf('attachment'), {});
});

test('automatic downloads: the second one without a click asks; a click or Save Link As doesn’t', async () => {
  const { sc, emitted } = controls();
  const wc = wcAt('https://files.example/');
  assert.equal(sc.gate(wc, 'https://files.example/1.zip'), true);
  const second = sc.gate(wc, 'https://files.example/2.zip');
  assert.equal(typeof second.then, 'function');
  assert.deepEqual(emitted.at(-1)[1].cats.map((c) => c.id), ['automaticDownloads']);
  sc.page(7).interacted = true; // a click on the page
  assert.equal(sc.gate(wc, 'https://files.example/3.zip'), true);
  sc.page(7).savedLinks = [{ url: 'https://files.example/4.zip', time: Date.now() }];
  assert.equal(sc.gate(wc, 'https://files.example/4.zip'), true);
  sc.permissions.respond(emitted.at(-1)[1].id, 'block');
  assert.equal(await second, false);
  assert.equal(await sc.gate(wc, 'https://files.example/5.zip'), false, 'blocked for the site now');
  assert.equal(sc.gate(wcAt('lumio://downloads/', 8), 'https://x/'), true);
});

test('sound: a muted site’s tabs are muted, and only Lumio’s mute is undone', () => {
  const { sc, settings, tabs } = controls();
  let muted = false;
  let changed = 0;
  const tab = { muted: false, owner: { changed: () => changed++ }, view: { webContents: { isDestroyed: () => false, getURL: () => 'https://loud.example/', setAudioMuted: (m) => { muted = m; } } } };
  tabs.push({ tab });
  settings.set('https://loud.example', 'sound', 'block');
  assert.equal(muted, true);
  assert.equal(tab.muted, true);
  settings.set('https://loud.example', 'sound', 'default');
  assert.equal(muted, false);
  tab.muted = true; // muted from the tab strip
  muted = true;
  sc.applySound(tab);
  assert.equal(muted, true, 'stays muted');
  assert.ok(changed >= 2);
});

test('insecure content and reloads: only allowed secure sites, and changes since the page loaded', () => {
  const { sc, settings } = controls();
  settings.set('https://old-cms.example', 'insecureContent', 'allow');
  assert.equal(sc.insecureAllowed('https://old-cms.example/page'), true);
  assert.equal(sc.insecureAllowed('https://other.example/'), false);
  const wc = wcAt('https://news.example/');
  sc.page(7).loaded = sc.onLoadValues(wc.getURL());
  assert.equal(sc.needsReload(wc), false);
  settings.set('https://news.example', 'javascript', 'block');
  assert.equal(sc.needsReload(wc), true);
});

test('data on exit: everything but allowed sites, or only the sites set to clear', () => {
  const { sc, settings } = controls();
  assert.equal(sc.exitPlan(), null);
  settings.set('https://temp.example', 'siteData', 'session');
  assert.deepEqual(sc.exitPlan().origins, ['https://temp.example']);
  settings.setDefault('siteData', 'session');
  settings.set('https://keep.example', 'siteData', 'allow');
  const plan = sc.exitPlan();
  assert.deepEqual(plan.excludeOrigins, ['https://keep.example']);
  assert.ok(plan.dataTypes.includes('cookies') && !plan.dataTypes.includes('cache'));
});

// ---------------------------------------------------------------- browsing data
test('delete browsing data: counts and deletes a time range', async () => {
  const st = store();
  const now = Date.now();
  st.importHistory([{ url: 'https://old.example/', title: 'Old', time: now - 10 * 864e5 }, { url: 'https://new.example/a', title: 'New', time: now - 60e3 }]);
  st.saveDownload({ id: 'd1', name: 'a.zip', state: 'completed', time: now - 60e3 });
  st.saveDownload({ id: 'd2', name: 'b.zip', state: 'completed', time: now - 10 * 864e5 });
  let cookies = [
    { name: 'old', domain: '.old.example', path: '/', secure: true },
    { name: 'new', domain: 'tracker.example', path: '/', secure: false },
  ];
  const removed = [];
  const cleared = [];
  const ses = {
    cookies: {
      on: (_e, fn) => { ses.fire = fn; },
      get: async () => cookies,
      remove: async (url, name) => { removed.push([url, name]); cookies = cookies.filter((c) => c.name !== name); },
    },
    clearStorageData: async (o) => cleared.push(o || 'all'),
    clearCache: async () => cleared.push('cache'),
    getCacheSize: async () => 5e6,
  };
  const clock = new CookieClock(tmp(), ses);
  ses.fire(null, cookies[1], 'explicit', false); // set just now
  clock.file.data['.old.example\t/\told'] = now - 10 * 864e5;
  const chats = [{ id: 'c1', updatedAt: now - 1000 }, { id: 'c2', updatedAt: now - 10 * 864e5 }];
  const settings = new SiteSettings({ store: st });
  settings.set('https://x.example', 'geolocation', 'block');
  const closed = [{ time: now - 1000 }, { time: now - 10 * 864e5 }];
  const passwords = { store: { entries: [{ id: 'p1', created: now - 1000 }, { id: 'p2', created: now - 10 * 864e5 }], remove(id) { this.entries = this.entries.filter((e) => e.id !== id); } }, passkeys: { list: () => [], remove: () => {} } };
  const bd = new BrowsingData({
    store: st, passwords, clock, recentlyClosed: closed,
    profile: { session: ses, permissions: { settings }, chats: { list: () => chats, delete: (id) => chats.splice(chats.findIndex((c) => c.id === id), 1), clear: () => chats.splice(0) } },
    siteOf: async (h) => h.split('.').slice(-2).join('.'),
  });
  const hour = 3600e3;
  assert.deepEqual(await bd.counts({ range: hour }), { history: 1, downloads: 1, cookieSites: 2, cacheBytes: 5e6, passwords: 1, siteSettings: 1, chats: 1, closed: 1 });
  await bd.clear({ range: hour, what: ['history', 'downloads', 'cookies', 'passwords', 'siteSettings', 'chats', 'closed'] });
  assert.deepEqual(st.history().map((h) => h.title), ['Old']);
  assert.deepEqual(st.downloads().map((d) => d.id), ['d2']);
  assert.deepEqual(removed, [['http://tracker.example/', 'new']], 'only the cookie set in the range');
  assert.deepEqual(cleared.map((c) => c.origin).sort(), ['http://tracker.example', 'https://new.example'], 'storage of the sites used in the range');
  assert.deepEqual(passwords.store.entries.map((e) => e.id), ['p2']);
  assert.deepEqual(chats.map((c) => c.id), ['c2']);
  assert.equal(closed.length, 1);
  assert.equal(settings.count(), 0);
  // All time: everything, in one go.
  await bd.clear({ range: 0, what: ['cookies', 'cache'] });
  assert.ok(cleared.includes('all') && cleared.includes('cache'));
  assert.deepEqual(clock.file.data, {});
});

test('cookie clock: a replaced cookie keeps its first time; a deleted one is forgotten', () => {
  const ses = { cookies: { on: (_e, fn) => { ses.fire = fn; } } };
  const clock = new CookieClock(tmp(), ses);
  const c = { name: 'id', domain: '.a.com', path: '/' };
  ses.fire(null, c, 'explicit', false);
  const first = clock.time(c);
  ses.fire(null, c, 'overwrite', true);
  ses.fire(null, c, 'explicit', false);
  assert.equal(clock.time(c), first);
  ses.fire(null, c, 'explicit', true);
  assert.equal(clock.time(c), 0);
  clock.flush();
});

// ---------------------------------------------------------------- addresses and folders
test('settings sub-pages have their own files; IndexedDB folders name their sites', () => {
  const page = (u) => path.basename(resolveFile(new URL(u), PAGE_HOSTS) || '');
  assert.equal(page('lumio://settings/content'), 'site-settings.html');
  assert.equal(page('lumio://settings/content/siteDetails?site=https%3A%2F%2Fa.com'), 'site-settings.html');
  assert.equal(page('lumio://settings/cookies'), 'site-settings.html');
  assert.equal(page('lumio://settings/clearBrowserData'), 'clear-data.html');
  assert.equal(page('lumio://settings/site-settings.js'), 'site-settings.js');
  assert.equal(page('lumio://history/content'), 'content', 'only under Settings');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'IndexedDB', 'https_www.example.com_0.indexeddb.leveldb'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'IndexedDB', 'http_localhost_3000.indexeddb.leveldb'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'IndexedDB', 'chrome-extension_abc_0.indexeddb.leveldb'), { recursive: true });
  assert.deepEqual(indexedDbOrigins(dir).sort(), ['http://localhost:3000', 'https://www.example.com']);
});

// ---------------------------------------------------------------- rebuilding a tab
test('rebuilding a tab keeps its history: back, forward or a new address', () => {
  const { TabManager } = require('../main/tabs.js');
  const rebuild = (entries, index, url) => {
    let closed = false;
    const tab = { id: 1, view: { webContents: { navigationHistory: { getAllEntries: () => entries.map((u) => ({ url: u, title: u })), getActiveIndex: () => index }, close: () => { closed = true; } } } };
    const m = Object.assign(Object.create(TabManager.prototype), {
      tabs: [tab], activeId: 1, win: { contentView: { removeChildView: () => {} } },
      ensureView: (t) => { t.view = { rebuilt: true }; }, activate: () => {}, changed: () => {},
    });
    m.rebuild(1, url);
    assert.ok(closed && tab.view.rebuilt);
    return [tab.savedHistory.entries.map((e) => e.url), tab.savedHistory.index, tab.pendingUrl];
  };
  assert.deepEqual(rebuild(['https://a/', 'https://b/'], 1, 'https://a/'), [['https://a/', 'https://b/'], 0, 'https://a/'], 'back');
  assert.deepEqual(rebuild(['https://a/', 'https://b/'], 0, 'https://b/'), [['https://a/', 'https://b/'], 1, 'https://b/'], 'forward');
  assert.deepEqual(rebuild(['https://a/', 'https://b/'], 1, 'https://b/'), [['https://a/', 'https://b/'], 1, 'https://b/'], 'the same page again');
  assert.deepEqual(rebuild(['https://a/', 'https://b/', 'https://c/'], 1, 'https://d/'), [['https://a/', 'https://b/', 'https://d/'], 2, 'https://d/'], 'a new address drops what was ahead');
});
