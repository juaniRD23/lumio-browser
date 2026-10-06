// The app's lifecycle, with stand-ins for Electron: "Press Esc to exit full
// screen" and "Press Esc to show your cursor" (main/access-notice.js), files
// Lumio opens from Finder, the Dock or the command line (main/open-files.js,
// build/mac-documents.mjs), asking before downloads are canceled by quitting
// or closing (main/features.js), and the Help menus.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MAC_DOCUMENT_TYPES } from '../build/mac-documents.mjs';
const require = createRequire(import.meta.url);

// Just enough of Electron for these modules outside the app.
class FakeView {
  constructor() {
    this.bounds = null;
    const wc = new EventEmitter();
    Object.assign(wc, {
      sent: [], destroyed: false, url: '',
      isDestroyed: () => wc.destroyed,
      send: (channel, payload) => wc.sent.push([channel, payload]),
      loadURL: (url) => { wc.url = url; setImmediate(() => wc.emit('did-finish-load')); },
      close: () => { wc.destroyed = true; },
    });
    this.webContents = wc;
  }
  setBackgroundColor() {}
  setBounds(b) { this.bounds = b; }
}
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => os.tmpdir() }, shell: {}, WebContentsView: FakeView, Menu: { buildFromTemplate: (t) => t } },
};
const { AccessNotice, noticeText, SHOW_MS, POINTER_AGAIN_MS } = require('../main/access-notice.js');
const { OPENABLE, fileUrl, launchTargets } = require('../main/open-files.js');
const { Downloads, Permissions, closingCancels, downloadsWarning } = require('../main/features.js');
const { TabManager } = require('../main/tabs.js');
const { buildMenu, buildBrowserMenu } = require('../main/menu.js');

const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- the notice
// A window with a page in its active tab (and one in a background tab).
function fakeWindow({ url = 'https://video.example/watch', incognito = false } = {}) {
  const children = [];
  const win = {
    contentView: {
      children,
      addChildView: (v) => { if (children.includes(v)) children.splice(children.indexOf(v), 1); children.push(v); },
      removeChildView: (v) => children.splice(children.indexOf(v), 1),
    },
  };
  const page = (u) => ({ webContents: { url: u, focused: 0, getURL() { return this.url; }, focus() { this.focused++; } }, getBounds: () => ({ x: 0, y: 84, width: 1200, height: 700 }) });
  const tab = { id: 1, url, view: page(url) };
  const other = { id: 2, url: 'https://other.example/', view: page('https://other.example/') };
  const tabs = { active: tab, fullscreenTab: null, displayUrl: (t) => t.url, wc: () => tabs.active.view.webContents };
  children.push(tab.view);
  const w = { win, tabs, incognito, closed: false };
  return { w, tab, other, children };
}
const lastSent = (notice) => notice.view.webContents.sent.at(-1);

test('the words: the site that went full screen, and what Esc does', () => {
  assert.deepEqual(noticeText({ host: 'video.example', fullscreen: true }), { title: 'video.example is now full screen', action: 'exit full screen' });
  assert.deepEqual(noticeText({ host: 'game.example', pointer: true }), { title: '', action: 'show your cursor' });
  assert.deepEqual(noticeText({ host: 'game.example', fullscreen: true, pointer: true }), { title: 'game.example is now full screen', action: 'exit full screen and show your cursor' });
  assert.deepEqual(noticeText({ fullscreen: true }), { title: '', action: 'exit full screen' }, 'a file has no site to name');
});

test('full screen: a bubble of its own on top, at the top center of the page, that goes after a few seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { w, tab, children } = fakeWindow();
    const notice = new AccessNotice(w);
    tab.view.getBounds = () => ({ x: 0, y: 0, width: 1440, height: 900 }); // full screen: the whole window
    notice.fullscreen(tab, true);
    assert.equal(notice.view.webContents.url, 'lumio://notice/');
    assert.equal(children.includes(notice.view), false, 'not before its page loads (an empty view would take clicks)');
    await tick();
    assert.equal(children.at(-1), notice.view, 'above the page');
    assert.deepEqual(lastSent(notice), ['notice-data', { title: 'video.example is now full screen', action: 'exit full screen' }]);
    // It measured itself: the view fits the bubble and its shadow, centered.
    notice.resize({ width: 480, height: 38 });
    assert.deepEqual(notice.view.bounds, { x: (1440 - 528) / 2, y: 8, width: 528, height: 84 });
    // A click on it gives the keyboard back to the page, so Esc reaches it.
    notice.view.webContents.emit('focus');
    assert.equal(tab.view.webContents.focused, 1);
    mock.timers.tick(SHOW_MS + 500);
    assert.equal(children.includes(notice.view), false, 'gone after it fades');
    assert.deepEqual(lastSent(notice), ['notice-data', null], 'cleared, so it never flashes old words');
  } finally {
    mock.timers.reset();
  }
});

test('leaving full screen or switching tabs takes it away; a background tab never shows one', async () => {
  const { w, tab, other, children } = fakeWindow();
  const notice = new AccessNotice(w);
  notice.fullscreen(tab, true);
  notice.fullscreen(tab, false);
  assert.equal(children.includes(notice.view), false);
  notice.fullscreen(tab, true);
  notice.hide(); // what switching tabs does (main/window.js onActivated)
  assert.equal(children.includes(notice.view), false);
  notice.fullscreen(other, true);
  notice.pointerLock(other);
  assert.equal(children.includes(notice.view), false, 'only over the page you see');
  // Incognito's is dark, like the rest of its window.
  const inc = fakeWindow({ incognito: true });
  const n2 = new AccessNotice(inc.w);
  n2.fullscreen(inc.tab, true);
  assert.equal(n2.view.webContents.url, 'lumio://notice/?appearance=dark');
  notice.destroy();
  assert.equal(notice.view, null);
});

test('pointer lock: "show your cursor", once for a page that locks it again soon after, again on a new page', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const { w, tab, children } = fakeWindow({ url: 'https://game.example/play' });
    const notice = new AccessNotice(w);
    notice.pointerLock(tab);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(lastSent(notice), ['notice-data', { title: '', action: 'show your cursor' }]);
    mock.timers.tick(SHOW_MS + 500);
    const count = notice.view.webContents.sent.length;
    notice.pointerLock(tab); // the game's menu closed: it locks again by itself
    assert.equal(children.includes(notice.view), false);
    assert.equal(notice.view.webContents.sent.length, count);
    mock.timers.tick(POINTER_AGAIN_MS);
    notice.pointerLock(tab);
    assert.deepEqual(lastSent(notice), ['notice-data', { title: '', action: 'show your cursor' }], 'a while later it says so again');
    mock.timers.tick(SHOW_MS + 500);
    tab.view.webContents.url = 'https://game.example/level-2';
    notice.pointerLock(tab);
    assert.equal(children.at(-1), notice.view, 'a new page is told again');
    // In full screen, one Esc does both.
    w.tabs.fullscreenTab = tab.id;
    tab.view.webContents.url = 'https://game.example/level-3';
    notice.pointerLock(tab);
    assert.deepEqual(lastSent(notice), ['notice-data', { title: 'game.example is now full screen', action: 'exit full screen and show your cursor' }]);
  } finally {
    mock.timers.reset();
  }
});

test('pages may lock the pointer (Lumio is told, to show the notice) and go full screen, but never lock the keyboard', () => {
  const session = { setPermissionCheckHandler(fn) { this.check = fn; }, setPermissionRequestHandler(fn) { this.request = fn; } };
  const locked = [];
  new Permissions(session, { store: { settings: {} }, emitFor: () => {}, persist: false, onPointerLock: (wc) => locked.push(wc.id) });
  const wc = { id: 7, getURL: () => 'https://game.example/' };
  const answer = (permission) => { let v; session.request(wc, permission, (x) => { v = x; }, { requestingUrl: 'https://game.example/' }); return v; };
  assert.equal(answer('pointerLock'), true);
  assert.deepEqual(locked, [7]);
  assert.equal(answer('fullscreen'), true);
  assert.equal(answer('keyboardLock'), false, 'Esc always reaches the browser');
  assert.deepEqual(locked, [7]);
});

test('entering and leaving full screen tells the window (for the notice)', () => {
  const calls = [];
  const win = { contentView: { children: [], addChildView() {}, removeChildView() {} }, getContentSize: () => [1200, 800], setFullScreen: (on) => calls.push(['window', on]) };
  const m = new TabManager({ win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: { onFullscreen: (t, on) => calls.push(['notice', t.id, on]) } });
  const wc = Object.assign(new EventEmitter(), { getURL: () => 'https://video.example/', setWindowOpenHandler() {}, isDestroyed: () => false });
  const tab = { id: 3, owner: m, view: { webContents: wc, setBounds() {}, setVisible() {}, setBorderRadius() {} }, url: 'https://video.example/' };
  m.tabs.push(tab);
  m.activeId = 3;
  m.wire(tab);
  wc.emit('enter-html-full-screen');
  assert.equal(m.fullscreenTab, 3);
  wc.emit('leave-html-full-screen');
  assert.deepEqual(calls, [['window', true], ['notice', 3, true], ['window', false], ['notice', 3, false]]);
});

test('after leaving full screen, a page that still thinks it is full screen is let out once the window is', async () => {
  let leave = null;
  const scripts = [];
  const win = { contentView: { children: [], addChildView() {}, removeChildView() {} }, getContentSize: () => [1200, 800], setFullScreen() {}, isFullScreen: () => true, once: (ev, fn) => { if (ev === 'leave-full-screen') leave = fn; } };
  const m = new TabManager({ win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: {} });
  const wc = Object.assign(new EventEmitter(), { getURL: () => 'https://video.example/', setWindowOpenHandler() {}, isDestroyed: () => false, executeJavaScript: async (code, gesture) => { scripts.push([code, gesture]); return true; } });
  let bounds = { x: 0, y: 80, width: 1200, height: 720 };
  const sizes = [];
  const tab = { id: 4, owner: m, view: { webContents: wc, setBounds(b) { bounds = { ...b }; sizes.push(b.height); }, getBounds: () => ({ ...bounds }), setVisible() {}, setBorderRadius() {} }, url: 'https://video.example/' };
  m.tabs.push(tab);
  m.activeId = 4;
  m.wire(tab);
  wc.emit('enter-html-full-screen');
  wc.emit('leave-html-full-screen');
  assert.equal(typeof leave, 'function', 'waits for the window to be out (the Mac animates it)');
  assert.equal(scripts.length, 0);
  bounds = { x: 0, y: 80, width: 1200, height: 720 };
  sizes.length = 0;
  leave();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(scripts.map(([code, gesture]) => [code.slice(0, 40), gesture]), [['!!document.fullscreenElement', true], ['document.fullscreenElement ? document.ex', true]], 'it asks the page, then lets it out');
  // Its view's size changes (so Chromium tells the page again, now out of full screen), and comes back.
  assert.deepEqual(sizes, [719]);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(sizes, [719, 720]);
  assert.deepEqual(bounds, { x: 0, y: 80, width: 1200, height: 720 });
});

test('a page that left full screen by itself is left alone', async () => {
  let leave = null;
  const scripts = [];
  const win = { contentView: { children: [], addChildView() {}, removeChildView() {} }, getContentSize: () => [1200, 800], setFullScreen() {}, isFullScreen: () => true, once: (ev, fn) => { if (ev === 'leave-full-screen') leave = fn; } };
  const m = new TabManager({ win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: {} });
  const wc = Object.assign(new EventEmitter(), { getURL: () => 'https://video.example/', setWindowOpenHandler() {}, isDestroyed: () => false, executeJavaScript: async (code) => { scripts.push(code); return false; } });
  const sizes = [];
  const tab = { id: 5, owner: m, view: { webContents: wc, setBounds(b) { sizes.push(b.height); }, getBounds: () => ({ x: 0, y: 80, width: 1200, height: 720 }), setVisible() {}, setBorderRadius() {} }, url: 'https://video.example/' };
  m.tabs.push(tab);
  m.activeId = 5;
  m.wire(tab);
  wc.emit('enter-html-full-screen');
  wc.emit('leave-html-full-screen');
  sizes.length = 0;
  leave();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(scripts, ['!!document.fullscreenElement']);
  assert.deepEqual(sizes, [], 'its view keeps its size');
});

// ---------------------------------------------------------------- files from Finder, the Dock, the command line
test('files Lumio opens: web pages, PDFs, pictures and text that exist; nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-open-'));
  try {
    const make = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); return f; };
    for (const name of ['page.html', 'Page.HTM', 'doc.xhtml', 'paper.pdf', 'logo.svg', 'photo.JPG', 'pic.jpeg', 'shot.png', 'anim.gif', 'img.webp', 'img.avif', 'old.bmp', 'favicon.ico', 'notes.txt', 'with space #1.pdf']) {
      const url = fileUrl(make(name));
      assert.ok(url?.startsWith('file:///'), name);
      assert.equal(decodeURIComponent(new URL(url).pathname).endsWith(name), true, `${name}: the right file`);
    }
    for (const name of ['setup.exe', 'archive.zip', 'script.js', 'run.sh', 'data.json', 'page.html.app']) assert.equal(fileUrl(make(name)), null, `${name} isn't opened`);
    fs.mkdirSync(path.join(dir, 'folder.html'));
    assert.equal(fileUrl(path.join(dir, 'folder.html')), null, 'a folder');
    assert.equal(fileUrl(path.join(dir, 'missing.pdf')), null, 'a file that isn’t there');
    assert.equal(fileUrl('--flag.html'), null, 'a command-line switch');
    assert.equal(fileUrl(undefined), null);
    // Windows' command line: addresses, and files.
    const page = make('a.html');
    assert.deepEqual(launchTargets(['--allow-file-access', 'https://example.com/x', page, 'ftp://example.com/', make('b.zip')]), ['https://example.com/x', fileUrl(page)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('macOS is told exactly the kinds of files Lumio opens, as the default only for web pages', () => {
  // The file extensions behind each type macOS knows.
  const UTI = {
    'public.html': ['html', 'htm'], 'public.xhtml': ['xhtml', 'xht'], 'com.adobe.pdf': ['pdf'], 'public.svg-image': ['svg'],
    'public.png': ['png'], 'public.jpeg': ['jpg', 'jpeg'], 'com.compuserve.gif': ['gif'], 'org.webmproject.webp': ['webp'],
    'public.avif': ['avif'], 'com.microsoft.bmp': ['bmp'], 'com.microsoft.ico': ['ico'],
  };
  const declared = MAC_DOCUMENT_TYPES.flatMap((t) => [...(t.LSItemContentTypes || []).flatMap((u) => UTI[u] || [`unknown ${u}`]), ...(t.CFBundleTypeExtensions || [])]);
  assert.deepEqual([...declared].sort(), [...OPENABLE].sort());
  for (const t of MAC_DOCUMENT_TYPES) {
    assert.equal(t.CFBundleTypeRole, 'Viewer');
    assert.equal(t.LSHandlerRank, t.CFBundleTypeName === 'HTML document' ? undefined : 'Alternate', `${t.CFBundleTypeName}: never taken from Preview`);
  }
  assert.equal(MAC_DOCUMENT_TYPES.some((t) => t.LSItemContentTypes?.includes('public.plain-text')), false, 'not all text: source code would download');
});

// ---------------------------------------------------------------- downloads when quitting or closing
function fakeItem() {
  const item = new EventEmitter();
  Object.assign(item, {
    paused: false, cancelled: false,
    cancel: () => { item.cancelled = true; },
    getURLChain: () => ['https://files.example/big.zip'], getURL: () => 'https://files.example/big.zip', getFilename: () => 'big.zip',
    getTotalBytes: () => 100, getReceivedBytes: () => 10, setSavePath() {}, getSavePath: () => '', isPaused: () => item.paused,
  });
  return item;
}

test('downloads still going are counted, paused ones too, finished ones not; ending Incognito cancels them', () => {
  const ses = new EventEmitter();
  const d = new Downloads(ses, { emit: () => {}, settings: { settings: {} } });
  const items = [fakeItem(), fakeItem(), fakeItem()];
  for (const item of items) ses.emit('will-download', {}, item, { id: 1 });
  assert.equal(d.inProgress(), 3);
  items[0].paused = true;
  items[0].emit('updated', {}, 'progressing');
  assert.equal(d.inProgress(), 3, 'paused is still in progress');
  items[1].emit('done', {}, 'completed');
  items[2].emit('done', {}, 'cancelled');
  assert.equal(d.inProgress(), 1);
  d.cancelAll();
  assert.deepEqual(items.map((i) => i.cancelled), [true, false, false], 'only the unfinished one');
});

test('which closes cancel downloads: the last window where that quits, the last Incognito window', () => {
  const base = { lastWindow: false, lastIncognito: false, total: 2, incognito: 0 };
  assert.deepEqual(closingCancels({ ...base, platform: 'win32', lastWindow: true }), { kind: 'quit', count: 2 });
  assert.deepEqual(closingCancels({ ...base, platform: 'linux', lastWindow: true }), { kind: 'quit', count: 2 });
  assert.equal(closingCancels({ ...base, platform: 'darwin', lastWindow: true }), null, 'the Mac keeps running, and downloading');
  assert.equal(closingCancels({ ...base, platform: 'win32' }), null, 'other windows are still open');
  assert.equal(closingCancels({ ...base, platform: 'win32', lastWindow: true, total: 0 }), null, 'nothing downloading');
  assert.deepEqual(closingCancels({ ...base, platform: 'darwin', lastIncognito: true, incognito: 1 }), { kind: 'incognito', count: 1 });
  assert.equal(closingCancels({ ...base, platform: 'darwin', lastIncognito: true, incognito: 0 }), null, 'normal downloads go on');
  assert.deepEqual(closingCancels({ ...base, platform: 'win32', lastWindow: true, lastIncognito: true, total: 3, incognito: 1 }), { kind: 'quit', count: 3 }, 'quitting covers all of them');
});

test('the question: how many, what happens, and Cancel is the default', () => {
  assert.deepEqual(downloadsWarning({ kind: 'quit', count: 1, platform: 'darwin' }), {
    type: 'warning', message: '1 download is in progress. Quit anyway?', detail: 'Quitting will cancel it.', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
  });
  const win = downloadsWarning({ kind: 'quit', count: 3, platform: 'win32' });
  assert.equal(win.message, '3 downloads are in progress. Exit anyway?');
  assert.equal(win.detail, 'Exiting will cancel them.');
  assert.deepEqual(win.buttons, ['Exit', 'Cancel']);
  const inc = downloadsWarning({ kind: 'incognito', count: 2, platform: 'darwin' });
  assert.equal(inc.message, '2 downloads are in progress. Close Incognito anyway?');
  assert.equal(inc.detail, 'Closing the last Incognito window will cancel them.');
  assert.deepEqual([inc.buttons, inc.defaultId, inc.cancelId], [['Close', 'Cancel'], 1, 1]);
});

test('closing the last tab closes the window instead when that needs asking, so Cancel keeps the tab', () => {
  let risk = true;
  const asked = [];
  const removed = [];
  const win = { contentView: { children: [], addChildView() {}, removeChildView() {} } };
  const m = new TabManager({ win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: { closeWindowFirst: () => { asked.push('window'); return risk; }, onTabClosed: (_m, e) => removed.push(e.url) } });
  const tab = { id: 1, owner: m, view: null, url: 'https://files.example/', pendingUrl: 'https://files.example/' };
  m.tabs.push(tab);
  m.activeId = 1;
  m.close(1);
  assert.deepEqual(asked, ['window']);
  assert.equal(m.tabs.length, 1, 'the tab waits for the window’s answer');
  m.close(1, { force: true });
  assert.equal(m.tabs.length, 0, 'a forced close doesn’t ask');
  // With two tabs, closing one is just closing a tab.
  m.tabs.push({ ...tab, id: 2 }, { ...tab, id: 3 });
  risk = false;
  asked.length = 0;
  m.close(2);
  assert.deepEqual(asked, []);
  assert.deepEqual(m.tabs.map((t) => t.id), [3]);
});

// ---------------------------------------------------------------- Help
test('Help, in the menu bar and the ⋮ menu: Terms of Service, Privacy Policy, open-source licenses', () => {
  const cmd = new Proxy({}, { get: (_t, name) => (name === 'isDev' ? false : name) }); // each command is its own name
  const help = buildMenu(cmd).find((m) => m.role === 'help');
  // (With batch 7c's help center, Report an issue, What's new, Version Info and Experiments.)
  const MAC = process.platform === 'darwin';
  assert.deepEqual(help.submenu.filter((i) => i.label).map((i) => [i.label, i.click]), [
    [MAC ? 'Lumio Browser Help' : 'Help center', 'helpCenter'], [MAC ? 'Report an Issue…' : 'Report an issue…', 'reportIssue'], [MAC ? 'What’s New' : 'What’s new', 'whatsNew'],
    ['Version Info', 'versionPage'], ['Experiments', 'flagsPage'],
    ['Terms of Service', 'terms'], ['Privacy Policy', 'privacy'], ['Open-Source Licenses', 'credits'],
  ]);
  const dots = buildBrowserMenu(cmd);
  const sub = dots.find((i) => i.label === 'Help').submenu.filter((i) => i.label && typeof i.run === 'string');
  assert.deepEqual(sub.map((i) => [i.label, i.run]), [['About Lumio Browser', 'about'], ['Help center', 'helpCenter'], ['Report an issue…', 'reportIssue'], ['What’s new', 'whatsNew'], ['Terms of Service', 'terms'], ['Privacy Policy', 'privacy'], ['Open-source licenses', 'credits']]);
  assert.equal(dots.at(-1).run, 'quit', 'Exit still quits (and main.js asks first)');
});
