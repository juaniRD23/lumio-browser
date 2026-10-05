// Pop-ups and links from pages (main/tabs.js, main/features.js,
// main/popup-window.js) with stand-in pages: the pop-up blocker (one pop-up
// per click, sites you allowed, opening a blocked one again), sized pop-ups
// becoming pop-up windows with the page's settings, links to other apps,
// window management asking first, "Save … As…" always asking where, and
// where a pop-up window goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Just enough of Electron for these modules outside the app.
const electron = require.resolve('electron');
class WebContentsView {
  constructor({ webContents }) { this.webContents = webContents; }
  setBackgroundColor() {}
  setVisible() {}
  setBounds() {}
}
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => os.tmpdir() }, shell: {}, WebContentsView } };
const { TabManager } = require('../main/tabs.js');
const { Downloads, Permissions } = require('../main/features.js');
const { popupBounds, BAR } = require('../main/popup-window.js');

const event = () => ({ preventDefault() { this.defaultPrevented = true; } });

function fakePage(url) {
  const wc = new EventEmitter();
  Object.assign(wc, {
    url, destroyed: false, scripts: [],
    getURL: () => wc.url,
    getTitle: () => 'Page',
    isDestroyed: () => wc.destroyed,
    isCrashed: () => false,
    focus() {},
    setWindowOpenHandler(fn) { wc.open = fn; },
    loadURL: async (to) => { wc.loaded = to; },
    executeJavaScriptInIsolatedWorld: async (_world, [{ code }], gesture) => { wc.scripts.push({ code, gesture }); return true; },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    click() { wc.emit('input-event', event(), { type: 'mouseDown' }); },
    key() { wc.emit('before-input-event', event(), { type: 'keyDown', key: 'Enter' }); },
  });
  return wc;
}

// A window with one tab on `url`. Tabs the page opens are only recorded.
function setup(url = 'https://news.example/story', hooks = {}) {
  const children = [];
  const win = { contentView: { children, addChildView: (v) => children.push(v), removeChildView: (v) => children.splice(children.indexOf(v), 1) }, getContentSize: () => [1200, 800], setFullScreen() {} };
  const calls = { external: [], popups: [], created: [], closed: [] };
  const m = new TabManager({
    win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, incognito: true,
    hooks: {
      openExternal: (tab, req) => calls.external.push(req),
      openPopup: (tab, opts) => { calls.popups.push(opts); return opts.webContents; },
      onTabClosed: (_m, e) => calls.closed.push(e.url),
      ...hooks,
    },
  });
  m.create = (u, opts) => calls.created.push([u, opts]);
  const wc = fakePage(url);
  const view = { webContents: wc, setBackgroundColor() {}, setVisible() {}, setBounds() {}, getBounds: () => ({ x: 0, y: 80, width: 1200, height: 720 }), setBorderRadius() {} };
  const tab = { id: 1, owner: m, view, url, title: 'Story', pinned: false };
  m.tabs.push(tab);
  children.push(view);
  m.wire(tab);
  m.activeId = tab.id;
  const open = (u, { disposition = 'foreground-tab', features = '', frameName = '' } = {}) => wc.open({ url: u, disposition, features, frameName });
  const blocked = () => m.state().tabs[0].popupsBlocked;
  return { m, wc, tab, calls, open, blocked };
}

test('a page opens a tab or pop-up only right after a click or key press, one per click', () => {
  const { wc, tab, calls, open, blocked } = setup();
  assert.deepEqual(open('https://ads.example/1'), { action: 'deny' }, 'no click: blocked');
  assert.equal(calls.created.length, 0);
  assert.equal(blocked(), 1, 'listed for the address bar');
  wc.click();
  assert.deepEqual(open('https://news.example/next'), { action: 'deny' });
  assert.deepEqual(calls.created.map(([u]) => u), ['https://news.example/next'], 'after a click it opens');
  open('https://ads.example/2');
  assert.equal(calls.created.length, 1, 'one click, one pop-up');
  assert.equal(blocked(), 2);
  wc.key();
  open('https://news.example/other', { disposition: 'background-tab' });
  assert.deepEqual(calls.created[1], ['https://news.example/other', { active: false, index: 1 }], 'a key press counts too');
  // A click that's a while ago doesn't.
  wc.click();
  tab.activatedAt -= 1500;
  open('https://ads.example/3');
  assert.equal(calls.created.length, 2);
  assert.equal(blocked(), 3);
});

test('a site you allowed, and Lumio’s own pages, open pop-ups without a click', () => {
  const allowed = setup('https://mail.example/', { popupsAllowed: (pageUrl) => pageUrl.startsWith('https://mail.example/') });
  allowed.open('https://mail.example/compose');
  allowed.open('https://mail.example/compose2');
  assert.equal(allowed.calls.created.length, 2);
  const own = setup('lumio://newtab/');
  own.open('https://example.com/');
  assert.equal(own.calls.created.length, 1);
  assert.equal(own.blocked(), 0);
});

test('a sized window.open() becomes a pop-up window with the page’s settings and window.opener', () => {
  const { wc, calls, open } = setup();
  wc.click();
  const r = open('https://accounts.example/oauth?client=1', { disposition: 'new-window', features: 'width=500,height=600' });
  assert.equal(r.action, 'allow');
  assert.equal(r.outlivesOpener, true, 'closing the tab leaves it open, like Chrome');
  const prefs = r.overrideBrowserWindowOptions.webPreferences;
  assert.equal(prefs.autoplayPolicy, 'document-user-activation-required', 'sound waits for a click, like in tabs');
  assert.equal(prefs.disableDialogs, true);
  assert.equal(prefs.sandbox, true);
  assert.match(prefs.preload, /preload[\\/]internal\.js$/, 'passwords and Lumio’s dialogs work in it');
  const guest = { id: 77 };
  assert.equal(r.createWindow({ webContents: guest, width: 800 }), guest, 'the page Chromium made (keeping window.opener)');
  assert.deepEqual(calls.popups, [{ webContents: guest, url: 'https://accounts.example/oauth?client=1', features: 'width=500,height=600' }]);
  // Shift-click (no size) is a normal browser window.
  const opened = [];
  const shift = setup('https://news.example/', { openInNewWindow: (u) => opened.push(u) });
  shift.wc.click();
  assert.deepEqual(shift.open('https://news.example/a', { disposition: 'new-window' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://news.example/a']);
});

test('a pop-up window’s page says about:blank until it gets somewhere, so its opener can’t dress it up as the address it asked for', () => {
  const win = { contentView: { children: [], addChildView() {}, removeChildView() {} }, getContentSize: () => [520, 680], setFullScreen() {} };
  const m = new TabManager({ win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: {}, incognito: true });
  const guest = fakePage(''); // the page Chromium made for window.open()
  const tab = m.create('https://www.google.com/generate_204', { webContents: guest });
  assert.equal(m.state().tabs[0].url, 'about:blank', 'not the address it asked for: the opener may be writing into it');
  assert.equal(tab.title, 'about:blank');
  guest.emit('did-navigate', event(), 'https://accounts.example/signin');
  assert.equal(m.state().tabs[0].url, 'https://accounts.example/signin', 'once its page is there');
});

test('links to other apps go to the app prompt; dangerous schemes never open', () => {
  const { wc, calls, open, blocked } = setup('https://zoom.example/j/1');
  wc.click();
  assert.deepEqual(open('zoommtg://zoom.example/join?confno=1'), { action: 'deny' });
  assert.deepEqual(calls.external, [{ url: 'zoommtg://zoom.example/join?confno=1', requestingUrl: 'https://zoom.example/j/1' }]);
  assert.equal(calls.created.length, 0, 'no empty tab for it');
  open('zoommtg://zoom.example/join?confno=2');
  assert.equal(calls.external.length, 1, 'without a click it’s a blocked pop-up');
  assert.equal(blocked(), 1);
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'lumio://settings/', 'search-ms:query=x']) {
    wc.click();
    assert.deepEqual(open(u), { action: 'deny' }, u);
  }
  assert.equal(blocked(), 1, 'not even listed');
  assert.equal(calls.created.length + calls.external.length, 1);
});

test('picking a blocked pop-up: the page opens it again itself, once', () => {
  const { m, wc, tab, calls, open, blocked } = setup();
  open('https://pay.example/checkout', { disposition: 'new-window', features: 'popup,width=400', frameName: 'pay' });
  open('https://ads.example/');
  const [first] = tab.blockedPopups;
  m.openBlockedPopup(tab, first.id);
  assert.equal(blocked(), 1);
  assert.deepEqual(wc.scripts, [{ code: 'window.open("https://pay.example/checkout", "pay", "popup,width=400"); true', gesture: true }]);
  // The page's window.open() comes back: it goes through, this once.
  const again = open('https://pay.example/checkout', { disposition: 'new-window', features: 'popup,width=400', frameName: 'pay' });
  assert.equal(again.action, 'allow');
  again.createWindow({ webContents: { id: 9 } });
  assert.equal(calls.popups[0].url, 'https://pay.example/checkout');
  assert.deepEqual(open('https://pay.example/checkout', { disposition: 'new-window', features: 'popup,width=400' }), { action: 'deny' });
  // A new page starts with none.
  wc.url = 'https://news.example/next';
  wc.emit('did-navigate', event(), wc.url);
  assert.equal(blocked(), 0);
  m.openBlockedPopup(tab, first.id); // gone: nothing happens
  assert.equal(wc.scripts.length, 1);
});

test('typing mailto: opens the mail app (asking first), not a page; a click lets a page ask again', () => {
  const { m, wc, tab, calls } = setup();
  assert.equal(m.navigate('mailto:ada@example.com'), 'mailto:ada@example.com');
  assert.deepEqual(calls.external, [{ url: 'mailto:ada@example.com', typed: true }]);
  assert.equal(wc.loaded, undefined);
  tab.externalLock = true;
  wc.click();
  assert.equal(tab.externalLock, false);
  assert.equal(m.recentlyActivated(tab), true);
});

test('a page that closes itself (window.close()) closes its tab, like Chrome', () => {
  const { m, wc, calls } = setup();
  wc.destroyed = true;
  wc.emit('destroyed');
  assert.equal(m.tabs.length, 0);
  assert.deepEqual(calls.closed, ['https://news.example/story']);
});

// A session that records Lumio's permission handlers.
function fakeSession() {
  const s = new EventEmitter();
  s.setPermissionCheckHandler = (fn) => { s.check = fn; };
  s.setPermissionRequestHandler = (fn) => { s.request = fn; };
  return s;
}

test('window management asks first; links to other apps go to Lumio; pop-ups are blocked unless allowed', () => {
  const ses = fakeSession();
  const shown = [];
  const external = [];
  const p = new Permissions(ses, { store: null, persist: false, emitFor: (_id, channel, payload) => shown.push([channel, payload]), openExternal: (wc, d) => external.push(d.externalURL) });
  const wc = { id: 5, getURL: () => 'https://maps.example/' };
  assert.equal(ses.check(wc, 'window-management', 'https://maps.example'), false, 'not granted by itself any more');
  let answer = null;
  ses.request(wc, 'window-management', (ok) => { answer = ok; }, { requestingUrl: 'https://maps.example/' });
  assert.equal(answer, null, 'it waits for the person');
  assert.equal(shown[0][0], 'permission');
  assert.equal(shown[0][1].label, 'manage windows on all your displays');
  p.respond(shown[0][1].id, true);
  assert.equal(answer, true);
  assert.equal(ses.check(wc, 'window-management', 'https://maps.example'), true, 'remembered');

  // Electron asks to open another app: Lumio says no to Electron and handles it.
  let opened = null;
  ses.request(wc, 'openExternal', (ok) => { opened = ok; }, { externalURL: 'zoommtg://x', requestingUrl: 'https://maps.example/' });
  assert.equal(opened, false);
  assert.deepEqual(external, ['zoommtg://x']);

  // Site information: pop-ups (blocked by default), and window management once set.
  const rows = p.forOrigin('https://maps.example');
  assert.deepEqual(rows.find((r) => r.permission === 'popups'), { permission: 'popups', label: 'Pop-ups and redirects', value: undefined, choices: ['block', 'allow'] });
  assert.equal(rows.find((r) => r.permission === 'window-management')?.label, 'Window management');
  assert.equal(p.forOrigin('https://other.example').some((r) => r.permission === 'window-management'), false);
  assert.equal(p.allowsPopups('https://maps.example/a'), false);
  p.set('https://maps.example', 'popups', true);
  assert.equal(p.allowsPopups('https://maps.example/b?x=1'), true);
  assert.equal(p.allowsPopups('https://other.example/'), false);
  assert.equal(p.allowsPopups('not a url'), false);
});

test('"Save Link As…" always asks where; other downloads follow the setting', () => {
  const ses = fakeSession();
  const settings = { settings: { askDownload: false } };
  const d = new Downloads(ses, { settings, emit: () => {} });
  const download = (url) => {
    const item = new EventEmitter();
    Object.assign(item, {
      getFilename: () => 'report.pdf', getURL: () => url, getURLChain: () => [url], getTotalBytes: () => 10,
      getReceivedBytes: () => 0, getSavePath: () => '', isPaused: () => false,
      setSavePath(p) { item.savedTo = p; }, setSaveDialogOptions(o) { item.dialog = o; },
    });
    ses.emit('will-download', event(), item, {});
    return item;
  };
  const started = [];
  d.saveAs({ downloadURL: (u) => started.push(u) }, 'https://files.example/report.pdf');
  assert.deepEqual(started, ['https://files.example/report.pdf']);
  const asked = download('https://files.example/report.pdf');
  assert.ok(asked.dialog?.defaultPath.endsWith('report.pdf'), 'the Save dialog, in the download folder');
  assert.equal(asked.savedTo, undefined);
  const plain = download('https://files.example/report.pdf');
  assert.equal(plain.dialog, undefined, 'only that one download asks');
  assert.ok(plain.savedTo.endsWith('.pdf'));
});

test('a pop-up window: the size the page asked for, plus the bar, on the browser window’s screen', () => {
  const near = { x: 100, y: 100, width: 1200, height: 800 };
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(popupBounds('width=500,height=600', near, area), { x: 450, y: 153, width: 500, height: 600 + BAR });
  assert.deepEqual(popupBounds('popup=1,left=40,top=60, innerWidth=420, innerHeight=500', near, area), { x: 40, y: 60, width: 420, height: 500 + BAR });
  // Too big, too small or off screen: kept on it.
  assert.deepEqual(popupBounds('width=5000,height=20,left=-300,top=9999', near, area), { x: 0, y: 720, width: 1440, height: 180 });
  // No size: Lumio's default, centered.
  assert.deepEqual(popupBounds('noopener', null, area), { x: 460, y: 77, width: 520, height: 680 + BAR });
});
