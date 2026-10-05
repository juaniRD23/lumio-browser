// The page tools' main-process side, with a stand-in for Electron, its
// windows and tabs: Share (main/share.js) and websites' navigator.share(),
// Send to your devices (and its relay message, main/sync/companion.js),
// media controls (main/media.js), the right-click items (main/page-menu.js),
// the whole-page screenshot (main/screenshot.js) and installed apps with
// their Mac launchers (main/apps.js, main/app-launchers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- a stand-in Electron
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A PNG header with a size: enough for the stand-in nativeImage.
function png(width, height) {
  const b = Buffer.alloc(33);
  PNG_SIG.copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const image = (width, height) => ({
  isEmpty: () => !width,
  getSize: () => ({ width, height }),
  resize: (s) => image(s.width, s.height),
  toPNG: () => png(width, height),
  toDataURL: () => `data:image/png;base64,${png(width, height).toString('base64')}`,
});
const E = {
  clipboard: { text: null, image: null, writeText(t) { this.text = t; }, writeImage(i) { this.image = i; } },
  notifications: [],
  shared: [],
  emoji: 0,
  handlers: {},
};
const electron = {
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => '/src/lumio', isEmojiPanelSupported: () => true, showEmojiPanel: () => { E.emoji++; } },
  clipboard: E.clipboard,
  dialog: { showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: (c, fn) => { E.handlers[c] = fn; }, on: (c, fn) => { E.handlers[c] = fn; } },
  nativeImage: {
    createFromBuffer: (buf) => (buf.subarray(0, 8).equals(PNG_SIG) ? image(buf.readUInt32BE(16), buf.readUInt32BE(20)) : image(0, 0)),
    createFromPath: () => image(0, 0),
  },
  Notification: class {
    static isSupported() { return true; }
    constructor(opts) { this.opts = opts; this.handlers = {}; E.notifications.push(this); }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { this.shown = true; }
  },
  ShareMenu: class { constructor(item) { this.item = item; } popup(opts) { E.shared.push({ item: this.item, opts }); setTimeout(() => opts.callback?.(), 5); } },
  screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu() {} },
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null },
  WebContentsView: class {},
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };

const { ShareTools, cleanShareData } = require('../main/share.js');
const { MediaHub, bestArtwork } = require('../main/media.js');
const { PageMenu } = require('../main/page-menu.js');
const { fullPageSize, Screenshots } = require('../main/screenshot.js');
const { Apps, appDetails } = require('../main/apps.js');
const launchers = require('../main/app-launchers.js');
const { CompanionBridge } = require('../main/sync/companion.js');
const C = require('../main/sync/crypto.js');

const MAC = process.platform === 'darwin';
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- stand-in windows and tabs
function makeTab(id, url, { title = `Tab ${id}`, favicon = null, wc = {} } = {}) {
  const handlers = {};
  const webContents = {
    id: 100 + id,
    url,
    destroyed: false,
    sent: [],
    getURL() { return this.url; },
    isDestroyed() { return this.destroyed; },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    once(ev, fn) { (handlers[ev] ||= []).push(fn); },
    send(c, p) { this.sent.push([c, p]); },
    getZoomFactor: () => 1,
    mainFrame: { framesInSubtree: [] },
    ...wc,
  };
  webContents.mainFrame.parent = null;
  if (!webContents.mainFrame.framesInSubtree.length) webContents.mainFrame.framesInSubtree = [webContents.mainFrame];
  const tab = { id, url, title, favicon, view: { webContents, getBounds: () => ({ x: 0, y: 80, width: 800, height: 600 }) } };
  tab.fire = (ev, ...args) => (handlers[ev] || []).forEach((fn) => fn(...args));
  return tab;
}
function makeWindow(tabs, { incognito = false, id = 1, focused = true } = {}) {
  const w = {
    id,
    incognito,
    closed: false,
    overlayKind: null,
    emitted: [],
    hidden: 0,
    asked: [],
    win: { isFocused: () => focused, webContents: { focus() {} } },
    overlay: { webContents: { focus() {} } },
    emit(c, p) { this.emitted.push([c, p]); },
    hideOverlay() { this.hidden++; this.overlayKind = null; },
    focus() { this.focused = true; },
    askAI(text, opts) { this.asked.push([text, opts]); },
  };
  w.tabs = {
    tabs,
    activeId: tabs[0]?.id,
    get active() { return tabs.find((t) => t.id === this.activeId) || null; },
    get: (tid) => tabs.find((t) => t.id === tid) || null,
    activate(tid) { this.activeId = tid; },
    displayUrl: (t) => t.url,
    indexOf: (t) => tabs.indexOf(t),
  };
  for (const t of tabs) t.owner = w.tabs;
  return w;
}
const emitted = (w, channel) => w.emitted.filter(([c]) => c === channel).map(([, p]) => p);

// ---------------------------------------------------------------- Share
function shareSetup({ devices = [], syncReady = true, incognito = false, focused = true } = {}) {
  const tab = makeTab(1, 'https://news.example/story', { title: 'A story', favicon: 'https://news.example/favicon.png' });
  const other = makeTab(2, 'https://other.example/');
  const w = makeWindow([tab, other], { incognito, focused });
  const sent = [];
  const sync = {
    keys: syncReady ? {} : null,
    status: syncReady ? 'ready' : 'off',
    deviceId: 'me',
    calls: 0,
    async api(p) { this.calls++; assert.equal(p, '/api/sync'); return { devices }; },
  };
  const opened = [];
  const saved = [];
  const shots = [];
  const prompts = [];
  const share = new ShareTools({
    sync,
    companion: { sendTab: async (target, t) => { sent.push({ target, ...t }); } },
    savePage: (_w, t) => saved.push(t.id),
    openUrl: (u) => opened.push(u),
    screenshots: { start: (x) => shots.push(x) },
    apps: { prompt: (_w, t, o) => prompts.push([t.id, o]) },
    tabOfWc: (wc) => (wc === tab.view.webContents ? { w, tab } : wc === other.view.webContents ? { w, tab: other } : null),
    windowOf: () => w,
    openWait: 40,
  });
  return { share, w, tab, other, sync, sent, opened, saved, shots, prompts };
}
// What the page's preload sends for navigator.share().
const fromPage = (tab, { frame } = {}) => ({ sender: tab.view.webContents, senderFrame: frame || tab.view.webContents.mainFrame });

test('what a website asks to share is checked again: text, and only http(s) links', () => {
  assert.deepEqual(cleanShareData({ title: 'Hi', url: '/a?b=1' }, 'https://site.example/x/'), { title: 'Hi', text: '', url: 'https://site.example/a?b=1' });
  assert.equal(cleanShareData({ url: 'javascript:alert(1)' }, 'https://site.example/'), null);
  assert.equal(cleanShareData({ url: 'file:///etc/passwd' }, 'https://site.example/'), null);
  assert.equal(cleanShareData({}, 'https://site.example/'), null);
  assert.equal(cleanShareData(null, 'https://site.example/'), null);
  assert.equal(cleanShareData({ text: 'x'.repeat(5000) }, 'https://s.example/').text.length, 2000);
  assert.equal(cleanShareData({ title: 5, text: { a: 1 } }, 'https://s.example/'), null, 'only strings');
});

test('the Share popover: the page, its tools, your other computers (not this one or phones)', async () => {
  const devices = [
    { id: 'me', name: 'This Mac', kind: 'computer', lastSeen: 5 },
    { id: 'pc', name: 'Office PC', kind: 'computer', platform: 'windows', lastSeen: 10 },
    { id: 'phone', name: 'iPhone', kind: 'phone', lastSeen: 20 },
    { id: 'air', name: 'MacBook Air', kind: 'computer', platform: 'mac', lastSeen: 30 },
  ];
  const s = shareSetup({ devices });
  const p = await s.share.info(s.w, { tabId: 1, anchor: { x: 10.4, y: 20.6 } });
  assert.equal(p.kind, 'share');
  assert.equal(p.url, 'https://news.example/story');
  assert.equal(p.title, 'A story');
  assert.equal(p.host, 'news.example');
  assert.equal(p.favicon, 'https://news.example/favicon.png');
  assert.equal(p.web, null);
  assert.deepEqual(p.devices.map((d) => d.id), ['air', 'pc'], 'computers only, newest first');
  assert.deepEqual(p.page, { screenshot: true, save: true, apps: true });
  assert.equal(p.native, MAC);
  // The device list is kept for a moment.
  await s.share.info(s.w, { tabId: 1 });
  assert.equal(s.sync.calls, 1);
  // A QR code for a link on the page: that link, without the page's tools.
  const link = await s.share.info(s.w, { tabId: 1, view: 'qr', url: 'https://elsewhere.example/a', title: 'Elsewhere' });
  assert.equal(link.view, 'qr');
  assert.equal(link.url, 'https://elsewhere.example/a');
  assert.equal(link.page, null);
  assert.equal(link.favicon, null);
  // Not a web page: no QR-able link to send.
  assert.equal((await s.share.info(s.w, { tabId: 1, view: 'nope' })).view, 'main');
});

test('Send to your devices is hidden without Lumio Sync, and in incognito', async () => {
  assert.equal((await shareSetup({ syncReady: false }).share.info(shareSetup({ syncReady: false }).w, {})).devices, null);
  const s = shareSetup({ incognito: true, devices: [{ id: 'pc', kind: 'computer' }] });
  const p = await s.share.info(s.w, {});
  assert.equal(p.devices, null);
  assert.equal(p.page.apps, false, 'no installing apps from incognito');
});

test('Copy link, Send, and the page tools from the popover', async () => {
  const s = shareSetup({ devices: [{ id: 'pc', name: 'Office PC', kind: 'computer' }] });
  await s.share.act(s.w, { action: 'copy', tabId: 1, url: 'https://news.example/story' });
  assert.equal(E.clipboard.text, 'https://news.example/story');
  assert.deepEqual(emitted(s.w, 'toast').at(-1), { text: 'Link copied' });
  assert.deepEqual(emitted(s.w, 'overlay-picked').at(-1), { kind: 'share' });
  // Only a device the popover listed.
  await s.share.act(s.w, { action: 'send', tabId: 1, url: 'https://news.example/story', deviceId: 'pc' });
  assert.deepEqual(s.sent, [], 'the list was never loaded');
  await s.share.info(s.w, {});
  await s.share.act(s.w, { action: 'send', tabId: 1, url: 'https://news.example/story', title: 'A story', deviceId: 'pc' });
  assert.deepEqual(s.sent, [{ target: 'pc', url: 'https://news.example/story', title: 'A story' }]);
  assert.deepEqual(emitted(s.w, 'toast').at(-1), { text: 'Sent to Office PC' });
  await s.share.act(s.w, { action: 'screenshot', tabId: 1 });
  await s.share.act(s.w, { action: 'save', tabId: 1 });
  await s.share.act(s.w, { action: 'install', tabId: 1 });
  await s.share.act(s.w, { action: 'shortcut', tabId: 1 });
  assert.equal(s.shots.length, 1);
  assert.deepEqual(s.saved, [1]);
  assert.deepEqual(s.prompts, [[1, { shortcut: false }], [1, { shortcut: true }]]);
  // A QR code's picture goes to the clipboard as an image.
  await s.share.act(s.w, { action: 'qr-copy', tabId: 1, png: new Uint8Array(png(300, 300)) });
  assert.deepEqual(E.clipboard.image.getSize(), { width: 300, height: 300 });
  assert.deepEqual(emitted(s.w, 'toast').at(-1), { text: 'QR code copied' });
  // From the menus.
  s.share.command(s.w, 'qr', { url: 'https://elsewhere.example/', title: 'X' });
  assert.deepEqual(emitted(s.w, 'share-open').at(-1), { tabId: 1, view: 'qr', url: 'https://elsewhere.example/', title: 'X' });
  s.share.command(s.w, 'send');
  assert.deepEqual(emitted(s.w, 'share-open').at(-1), { tabId: 1, view: 'devices' });
  s.share.command(s.w, 'qr', { url: 'javascript:alert(1)' });
  assert.deepEqual(emitted(s.w, 'share-open').at(-1), { tabId: 1, view: 'qr' }, 'never a script link');
});

test('a website’s Share button: the front tab’s page only; shared or canceled is all it learns', async () => {
  const s = shareSetup();
  // Not the tab in front, a frame inside the page, or a window in the back.
  assert.equal((await s.share.webShare(fromPage(s.other), { url: 'https://other.example/' })).error, 'NotAllowedError');
  assert.equal((await s.share.webShare(fromPage(s.tab, { frame: { parent: s.tab.view.webContents.mainFrame } }), { url: '/' })).error, 'NotAllowedError');
  const back = shareSetup({ focused: false });
  assert.equal((await back.share.webShare(fromPage(back.tab), { url: '/' })).error, 'NotAllowedError');
  assert.deepEqual(emitted(back.w, 'share-open'), []);
  assert.equal((await s.share.webShare(fromPage(s.tab), { url: 'data:text/html,hi' })).error, 'DataError');

  // Shared: the popover shows what the site asked, Copy answers the page.
  let answer = s.share.webShare(fromPage(s.tab), { title: 'Read this', text: 'So good', url: '/next' });
  assert.deepEqual(emitted(s.w, 'share-open').at(-1), { tabId: 1, view: 'main' });
  s.w.overlayKind = 'share';
  const p = await s.share.info(s.w, { tabId: 1 });
  assert.equal(p.url, 'https://news.example/next');
  assert.equal(p.title, 'Read this');
  assert.deepEqual(p.web, { title: 'Read this', text: 'So good', url: 'https://news.example/next', host: 'news.example' });
  assert.equal(p.page, null, 'no page tools for what a site asked to share');
  await s.share.act(s.w, { action: 'copy', tabId: 1 });
  assert.deepEqual(await answer, { ok: true });
  assert.equal(E.clipboard.text, 'https://news.example/next');

  // Text only: Copy copies the text.
  answer = s.share.webShare(fromPage(s.tab), { title: 'Quote', text: 'To be or not' });
  s.w.overlayKind = 'share';
  await s.share.act(s.w, { action: 'copy', tabId: 1 });
  assert.deepEqual(await answer, { ok: true });
  assert.equal(E.clipboard.text, 'Quote\nTo be or not');

  // Closing the popover (or another tab coming up) cancels it.
  answer = s.share.webShare(fromPage(s.tab), { url: '/x' });
  s.w.overlayKind = 'share';
  s.share.overlayClosed(s.w, 'share');
  assert.equal((await answer).error, 'AbortError');
  answer = s.share.webShare(fromPage(s.tab), { url: '/x' });
  s.share.tabChanged(s.w, s.other);
  assert.equal((await answer).error, 'AbortError');
  // A popover that never came up doesn't leave the page waiting.
  s.w.overlayKind = null;
  answer = s.share.webShare(fromPage(s.tab), { url: '/x' });
  assert.equal((await answer).error, 'AbortError');
});

test('a Share button in an installed app’s window: the Mac’s share sheet, from the window in front', async () => {
  const s = shareSetup();
  const page = makeTab(9, 'https://mail.example/inbox');
  let focused = true;
  const aw = { win: { isFocused: () => focused }, view: page.view };
  s.share.apps.windowFor = (wc) => (wc === page.view.webContents ? aw : null);
  const before = E.shared.length;
  const res = await s.share.webShare(fromPage(page), { title: 'A mail', url: '/m/1' });
  if (!MAC) { assert.equal(res.error, 'NotAllowedError'); return; }
  assert.deepEqual(res, { ok: true }, 'closing the sheet counts as shared');
  const { item, opts } = E.shared.at(-1);
  assert.deepEqual(item, { urls: ['https://mail.example/m/1'], texts: ['A mail'] });
  assert.equal(opts.window, aw.win);
  // Not in front, a frame, or something that isn't shareable.
  focused = false;
  assert.equal((await s.share.webShare(fromPage(page), { url: '/' })).error, 'NotAllowedError');
  focused = true;
  assert.equal((await s.share.webShare(fromPage(page, { frame: {} }), { url: '/' })).error, 'NotAllowedError');
  assert.equal((await s.share.webShare(fromPage(page), { url: 'file:///etc/hosts' })).error, 'DataError');
  assert.equal(E.shared.length, before + 1);
  assert.deepEqual(emitted(s.w, 'share-open'), [], 'browser windows never show it');
});

test('a tab from another computer shows as a notification that opens it', () => {
  const s = shareSetup();
  s.share.receiveTab({ url: 'https://recipes.example/pie', title: 'Apple pie', from: 'Office PC' });
  const n = E.notifications.at(-1);
  assert.equal(n.opts.title, 'Tab from Office PC');
  assert.match(n.opts.body, /Apple pie\nrecipes\.example/);
  assert.ok(n.shown);
  n.handlers.click();
  assert.deepEqual(s.opened, ['https://recipes.example/pie']);
});

test('Send to your devices goes through the relay to that computer only, end-to-end encrypted', async () => {
  const keys = await C.deriveKeys(new Uint8Array(32).fill(7));
  const posted = [];
  const sync = { status: 'ready', keys, deviceId: 'me-device', deviceName: 'My Mac', file: { data: {}, save() {} }, api: async (p, o) => { posted.push([p, o]); return {}; } };
  const bridge = new CompanionBridge({ sync, windows: () => [], pickWindow: () => null, openChat: () => {} });
  await bridge.sendTab('pc-device', { url: 'https://a.example/', title: 'A' });
  const [p, { method, body }] = posted[0];
  assert.equal(p, '/api/companion/messages');
  assert.equal(method, 'POST');
  assert.equal(body.kind, 'command');
  assert.equal(body.target, 'pc-device');
  assert.ok(!body.data.includes('a.example'), 'the relay can’t read it');
  const cmd = await C.open(keys, 'companion', 'msg', body.data);
  assert.deepEqual({ ...cmd, at: 0 }, { type: 'tab', url: 'https://a.example/', title: 'A', from: 'My Mac', at: 0 });

  // On the other computer: tabs open, but only web links.
  const got = [];
  const there = new CompanionBridge({ sync, windows: () => [], pickWindow: () => null, openChat: () => {}, onTab: (t) => got.push(t) });
  await there.handle(cmd);
  await there.handle({ type: 'tab', url: 'javascript:alert(1)', from: 'x' });
  assert.deepEqual(got, [{ url: 'https://a.example/', title: 'A', from: 'My Mac' }]);
  // Turned off: it says how to turn it on.
  await assert.rejects(new CompanionBridge({ sync: { status: 'off' } }).sendTab('pc', { url: 'https://a.example/' }), /Turn on Lumio Sync/);
});

// ---------------------------------------------------------------- media controls
function mediaSetup(probe = {}) {
  const ran = [];
  const tab = makeTab(1, 'https://music.example/album', {
    title: 'Album · Music',
    favicon: 'https://music.example/f.png',
    wc: {
      async executeJavaScriptInIsolatedWorld(_world, [{ code }], gesture) {
        ran.push({ code, gesture });
        if (code.startsWith('(function probeMedia')) return probe.top ?? null;
        return true;
      },
    },
  });
  const quiet = makeTab(2, 'https://quiet.example/');
  const w = makeWindow([tab, quiet]);
  const incog = makeWindow([makeTab(3, 'https://secret.example/')], { incognito: true, id: 2 });
  const hub = new MediaHub({ windows: () => [w, incog] });
  for (const t of [tab, quiet, ...incog.tabs.tabs]) hub.wire(t);
  return { hub, w, incog, tab, quiet, ran };
}

test('the media button shows once a tab has made sound, in windows of the same kind', async () => {
  const s = mediaSetup();
  s.tab.fire('media-started-playing');
  await tick(150);
  assert.deepEqual(s.hub.state(s.w), { count: 0, playing: false }, 'a muted autoplay video doesn’t count');
  s.tab.fire('audio-state-changed', { audible: true });
  await tick(150);
  assert.deepEqual(s.hub.state(s.w), { count: 1, playing: true });
  assert.deepEqual(emitted(s.w, 'media').at(-1), { count: 1, playing: true });
  assert.deepEqual(s.hub.state(s.incog), { count: 0, playing: false }, 'incognito sees only incognito tabs');
  s.tab.fire('media-paused');
  await tick(150);
  assert.deepEqual(emitted(s.w, 'media').at(-1), { count: 1, playing: false }, 'paused tabs stay in the list');
  s.tab.fire('did-navigate');
  await tick(150);
  assert.deepEqual(emitted(s.w, 'media').at(-1), { count: 0, playing: false }, 'gone with the page');
});

test('the popover’s rows: what’s playing, its artwork, length and controls', async () => {
  const s = mediaSetup({
    top: {
      title: 'Song', artist: 'Band', state: 'playing',
      artwork: [{ src: 'https://cdn.example/s.jpg', sizes: '96x96' }, { src: 'https://cdn.example/l.jpg', sizes: '512x512' }, { src: 'http://insecure.example/x.jpg', sizes: '1024x1024' }],
      el: { paused: false, duration: 245.2, time: 61.5, video: false, pip: false, canPip: false },
    },
  });
  s.tab.fire('audio-state-changed', { audible: true });
  s.tab.mediaActions = ['previoustrack', 'nexttrack'];
  const [row] = await s.hub.list(s.w);
  assert.deepEqual(row, {
    tabId: 1, windowId: 1, title: 'Song', artist: 'Band', host: 'music.example', favicon: 'https://music.example/f.png',
    artwork: 'https://cdn.example/l.jpg', playing: true, canPrev: true, canNext: true, duration: 245.2, time: 61.5,
    canSeek: true, pip: false, canPip: false, current: true,
  });
  assert.equal(bestArtwork('nope'), null);
});

test('an embedded player’s answer is kept to plain numbers and yes/no', async () => {
  const frame = { parent: {}, executeJavaScript: async () => ({ paused: 'no', duration: '1e9" onload="x', time: { evil: 1 }, pip: 'yes', canPip: 1 }) };
  const s = mediaSetup({ top: { title: '', artwork: [], el: null } });
  s.tab.view.webContents.mainFrame.framesInSubtree.push(frame);
  s.tab.fire('audio-state-changed', { audible: true });
  const [row] = await s.hub.list(s.w);
  assert.equal(row.title, 'Album · Music', 'the tab’s title');
  assert.deepEqual([row.duration, row.time, row.pip, row.canPip, row.canSeek], [null, null, false, false, false]);
});

test('media buttons use the site’s own handlers when it has them, or the player itself', async () => {
  const s = mediaSetup({ top: { el: { paused: false } } });
  s.tab.fire('audio-state-changed', { audible: true });
  s.tab.mediaActions = ['nexttrack', 'pause'];
  assert.equal(await s.hub.act(s.w, { tabId: 1, action: 'next' }), true);
  assert.deepEqual(s.tab.view.webContents.sent.at(-1), ['media:session', { action: 'nexttrack', details: {} }]);
  assert.equal(s.ran.at(-1).gesture, true, 'as if the page was clicked');
  // No handler for previous: nothing to do.
  assert.equal(await s.hub.act(s.w, { tabId: 1, action: 'prev' }), false);
  // Play, seek and Picture in picture without the site's help.
  assert.equal(await s.hub.act(s.w, { tabId: 1, action: 'play' }), true);
  assert.match(s.ran.at(-1).code, /^\(function controlMedia[\s\S]*\)\("play", null\)$/);
  await s.hub.act(s.w, { tabId: 1, action: 'pip' });
  assert.match(s.ran.at(-1).code, /\("pip", null\)$/);
  assert.equal(s.ran.at(-1).gesture, true);
  await s.hub.act(s.w, { tabId: 1, action: 'seek', value: 42 });
  assert.match(s.ran.at(-1).code, /\("seek", 42\)$/);
  // Go to tab.
  s.w.tabs.activeId = 2;
  await s.hub.act(s.w, { tabId: 1, action: 'goto' });
  assert.equal(s.w.tabs.activeId, 1);
  assert.deepEqual(emitted(s.w, 'overlay-picked').at(-1), { kind: 'media' });
  // A tab that isn't listed can't be controlled.
  assert.equal(await s.hub.act(s.w, { tabId: 2, action: 'pause' }), false);
  assert.equal(await s.hub.act(s.incog, { tabId: 1, action: 'pause' }), false);
});

// ---------------------------------------------------------------- the right-click menu
function menuSetup(url = 'https://site.example/page') {
  const runs = [];
  const created = [];
  const tab = makeTab(1, url, { title: 'Site page', wc: { executeJavaScriptInIsolatedWorld: async (_w, [{ code }], gesture) => { runs.push({ code, gesture }); return runs.answer ?? true; }, showDefinitionForSelection() { this.lookedUp = true; } } });
  const w = makeWindow([tab]);
  tab.owner.create = (u, o) => created.push([u, o]);
  tab.owner.session = { fetch: async () => new Response(png(64, 64), { headers: { 'content-type': 'image/png' } }) };
  const qr = [];
  const toasts = [];
  const menu = new PageMenu({ share: { command: (x, what, o) => qr.push([what, o]) }, toast: (_w, t) => toasts.push(t) });
  const base = { linkURL: '', linkText: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, mediaFlags: {}, frame: null, frameURL: '', x: 10, y: 20 };
  const items = (section, params) => menu.items(w, section, tab, { ...base, ...params });
  return { menu, w, tab, items, runs, qr, toasts, created };
}
const labels = (list) => list.map((i) => i.label || (i.role ? `[${i.role}]` : '—'));

test('right-click on a link: Copy link text and a QR code', () => {
  const s = menuSetup();
  const list = s.items('link', { linkURL: 'https://a.example/x', linkText: '  Read more  ' });
  assert.deepEqual(labels(list), ['Copy Link Text', 'Create QR Code for This Link']);
  list[0].click();
  assert.equal(E.clipboard.text, 'Read more');
  list[1].click();
  assert.deepEqual(s.qr.at(-1), ['qr', { url: 'https://a.example/x', title: 'Read more' }]);
  assert.deepEqual(labels(s.items('link', { linkURL: 'mailto:a@b.example' })), [], 'nothing to add for a mail link without text');
});

test('right-click on a picture: Ask Lumio about it (attached to the panel) and a QR code', async () => {
  const s = menuSetup();
  const list = s.items('image', { srcURL: 'https://img.example/cat.png', altText: 'A cat' });
  assert.deepEqual(labels(list), ['Ask Lumio About This Image', 'Create QR Code for This Image']);
  await s.menu.askAboutImage(s.w, s.tab, 'https://img.example/cat.png');
  const [att] = emitted(s.w, 'ai-attach');
  assert.equal(att.name, 'image.png');
  assert.equal(att.type, 'image/png');
  assert.ok(att.data instanceof Uint8Array && att.data.length > 8);
  assert.deepEqual(s.w.asked.at(-1), ['What’s in this image?', { draft: true }]);
  // A page's own inline picture works too; a non-picture doesn't.
  await s.menu.askAboutImage(s.w, s.tab, `data:image/png;base64,${png(4, 4).toString('base64')}`);
  assert.equal(emitted(s.w, 'ai-attach').length, 2);
  s.tab.owner.session.fetch = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  await s.menu.askAboutImage(s.w, s.tab, 'https://img.example/not-a-picture');
  assert.deepEqual(s.toasts, ['Couldn’t get this image']);
});

test('right-click on a video: Play, Mute, Loop, Show controls, Picture in picture, Copy address', () => {
  const s = menuSetup();
  const flags = { isPaused: true, isMuted: false, hasAudio: true, isLooping: true, canLoop: true, isControlsVisible: false, canToggleControls: true, canShowPictureInPicture: true, isShowingPictureInPicture: false };
  const list = s.items('media', { mediaType: 'video', srcURL: 'https://v.example/clip.mp4', mediaFlags: flags });
  assert.deepEqual(labels(list), ['Play', 'Mute', 'Loop', 'Show Controls', 'Picture in Picture', 'Copy Video Address']);
  assert.equal(list[2].checked, true);
  assert.equal(list[3].checked, false);
  list[4].click(); // Picture in picture, at the spot that was clicked, as a click on the page
  assert.match(s.runs.at(-1).code, /^\(function mediaAction[\s\S]*\)\("pip", 10, 20, "https:\/\/v\.example\/clip\.mp4"\)$/);
  assert.equal(s.runs.at(-1).gesture, true);
  // Audio has no Picture in picture; a blob: video has no address to copy.
  assert.deepEqual(labels(s.items('media', { mediaType: 'audio', srcURL: 'https://a.example/a.mp3', mediaFlags: { isPaused: false } })), ['Pause', 'Mute', 'Loop', 'Show Controls', 'Copy Audio Address']);
  assert.ok(!labels(s.items('media', { mediaType: 'video', srcURL: 'blob:https://v.example/1', mediaFlags: {} })).includes('Copy Video Address'));
  // In a frame: run in that frame's page.
  const frame = { parent: {}, ran: [], executeJavaScript(code, gesture) { this.ran.push([code, gesture]); return Promise.resolve(true); } };
  s.items('media', { mediaType: 'video', srcURL: 'https://v.example/clip.mp4', mediaFlags: flags, frame })[2].click();
  assert.match(frame.ran[0][0], /\("loop", null, null, "https:\/\/v\.example\/clip\.mp4"\)$/);
  assert.equal(frame.ran[0][1], true);
});

test('right-click in text: Emoji & Symbols, Copy link to highlight, and on the Mac Look Up and Speech', async () => {
  const s = menuSetup();
  const editable = s.items('editable', { isEditable: true, selectionText: 'hello' });
  assert.equal(editable[0].label, MAC ? 'Emoji & Symbols' : 'Emoji');
  editable[0].click();
  assert.equal(E.emoji, 1);
  const sel = s.items('selection', { selectionText: 'the quiet history of lighthouses' });
  assert.deepEqual(labels(sel), MAC ? ['Copy Link to Highlight', 'Look Up “the quiet history of lightho…”', 'Speech'] : ['Copy Link to Highlight']);
  if (MAC) {
    sel[1].click();
    assert.ok(s.tab.view.webContents.lookedUp);
    assert.deepEqual(sel[2].submenu, [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]);
  }
  s.runs.answer = 'https://site.example/page#:~:text=the%20quiet';
  await s.menu.copyHighlight(s.w, s.tab.view.webContents);
  assert.equal(E.clipboard.text, 'https://site.example/page#:~:text=the%20quiet');
  assert.deepEqual(s.toasts.at(-1), 'Link to highlight copied');
  s.runs.answer = 'javascript:alert(1)';
  await s.menu.copyHighlight(s.w, s.tab.view.webContents);
  assert.equal(s.toasts.at(-1), 'Couldn’t make a link to this text');
  // Not on Lumio's own pages, or inside a frame.
  assert.ok(!labels(menuSetup('lumio://settings/').items('selection', { selectionText: 'x' })).includes('Copy Link to Highlight'));
  assert.ok(!labels(s.items('selection', { selectionText: 'x', frame: { parent: {} } })).includes('Copy Link to Highlight'));
});

test('right-click on the page: its QR code, and a frame’s source and reload', () => {
  const s = menuSetup();
  assert.deepEqual(labels(s.items('page', {})), ['Create QR Code for This Page']);
  let reloaded = 0;
  const frame = { parent: {}, reload: () => { reloaded++; } };
  const list = s.items('page', { frame, frameURL: 'https://embed.example/player' });
  assert.deepEqual(labels(list), ['Create QR Code for This Page', 'View Frame Source', 'Reload Frame']);
  list[1].click();
  assert.deepEqual(s.created.at(-1), ['view-source:https://embed.example/player', { index: 1 }]);
  list[2].click();
  assert.equal(reloaded, 1);
  assert.equal(s.items('page', { frame, frameURL: 'about:srcdoc' })[1].enabled, false, 'no source for a srcdoc frame');
  assert.deepEqual(labels(menuSetup('lumio://newtab/').items('page', {})), [], 'no QR code for Lumio’s own pages');
});

test('the page’s right-click menu (main/tabs.js) puts the page tools’ items in each part', () => {
  const { TabManager } = require('../main/tabs.js');
  const s = menuSetup();
  const built = [];
  const original = electron.Menu.buildFromTemplate;
  electron.Menu.buildFromTemplate = (t) => { built.push(t); return { popup() {} }; };
  try {
    const tm = Object.assign(Object.create(TabManager.prototype), {
      tabs: [s.tab],
      store: { settings: {} },
      incognito: false,
      hooks: { askAI() {}, pageMenu: (section, tab, params) => s.menu.items(s.w, section, tab, params) },
    });
    const base = { linkURL: '', linkText: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, mediaFlags: {}, frame: null, frameURL: '', x: 10, y: 20, editFlags: {} };
    const menu = (params) => { tm.contextMenu(s.tab, { ...base, ...params }); return labels(built.at(-1)); };
    const link = menu({ linkURL: 'https://a.example/x', linkText: 'Read more' });
    assert.ok(link.indexOf('Copy Link Text') === link.indexOf('Copy Link Address') + 1, 'next to Copy Link Address');
    assert.ok(link.includes('Create QR Code for This Link'));
    const video = menu({ mediaType: 'video', srcURL: 'https://a.example/v.mp4', mediaFlags: { isPaused: true } });
    assert.deepEqual(video.slice(0, 2), ['Open Video in New Tab', 'Save Video As…']);
    assert.ok(['Loop', 'Show Controls', 'Picture in Picture', 'Copy Video Address'].every((l) => video.includes(l)));
    const blob = menu({ mediaType: 'video', srcURL: 'blob:https://a.example/1' });
    assert.ok(blob.includes('Picture in Picture') && !blob.includes('Open Video in New Tab'), 'a streamed video still gets its controls');
    assert.ok(menu({ mediaType: 'image', srcURL: 'https://a.example/i.png' }).includes('Ask Lumio About This Image'));
    assert.ok(menu({ selectionText: 'some words' }).includes('Copy Link to Highlight'));
    assert.ok(menu({ isEditable: true }).includes(MAC ? 'Emoji & Symbols' : 'Emoji'));
    assert.ok(menu({}).includes('Create QR Code for This Page'));
  } finally {
    electron.Menu.buildFromTemplate = original;
  }
});

test('File › Save and Share and the ⋮ menu’s Save and share open each page tool', () => {
  const { buildMenu, buildBrowserMenu } = require('../main/menu.js');
  const asked = [];
  const cmd = new Proxy({ share: (what) => asked.push(what), savePage: () => asked.push('savePage'), apps: () => asked.push('apps') }, { get: (o, k) => o[k] || (() => {}) });
  const find = (items, label) => items.find((i) => i.label === label);
  const file = find(buildMenu(cmd), 'File').submenu;
  const bar = find(file, 'Save and Share').submenu;
  const dots = find(buildBrowserMenu(cmd), 'Save and share').submenu;
  const want = ['Share…', 'Copy Link', 'Send to Your Devices…', 'Create QR Code…', 'Take Screenshot…', ...(MAC ? ['More Share Options…'] : []), undefined, 'Save Page As…', 'Install Page as App…', 'Create Shortcut…', 'Installed Apps'];
  assert.deepEqual(bar.map((i) => i.label), want, 'Title Case in the menu bar');
  assert.deepEqual(dots.map((i) => i.label), ['Share…', 'Copy link', 'Send to your devices…', 'Create QR code…', 'Screenshot…', ...(MAC ? ['More share options…'] : []), undefined, 'Save page as…', 'Install page as app…', 'Create shortcut…', 'Installed apps'], 'sentence case in ⋮');
  bar.filter((i) => i.click).forEach((i) => i.click());
  assert.deepEqual(asked, ['open', 'copy', 'send', 'qr', 'screenshot', ...(MAC ? ['native'] : []), 'savePage', 'install', 'shortcut', 'apps']);
});

// ---------------------------------------------------------------- screenshots
test('a whole-page screenshot: sharp on Retina when it fits, cut at Chromium’s limit when it doesn’t', () => {
  assert.deepEqual(fullPageSize({ width: 1200, height: 3000 }, 1200, 2), { width: 1200, height: 3000, scale: 2, clipped: false });
  assert.deepEqual(fullPageSize({ width: 1400, height: 3000 }, 1200, 2), { width: 1200, height: 3000, scale: 2, clipped: false }, 'no sideways scrolling area');
  const tall = fullPageSize({ width: 1000, height: 12000 }, 1000, 2);
  assert.equal(tall.scale, 1, 'gives up sharpness before cutting');
  assert.equal(tall.clipped, false);
  const huge = fullPageSize({ width: 1000, height: 50000 }, 1000, 2);
  assert.deepEqual(huge, { width: 1000, height: 16384, scale: 1, clipped: true });
  assert.ok(fullPageSize({ width: 4000, height: 16000 }, 4000, 1).height * 4000 <= 60_000_000, 'never more than 60 megapixels');
});

test('the whole page comes from the DevTools protocol, which is let go afterwards', async () => {
  const calls = [];
  const dbg = {
    attached: false,
    isAttached() { return this.attached; },
    attach(v) { calls.push(['attach', v]); this.attached = true; },
    detach() { calls.push(['detach']); this.attached = false; },
    async sendCommand(name, params) {
      calls.push([name, params]);
      if (name === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1000, height: 2500 }, cssLayoutViewport: { clientWidth: 1000 } };
      return { data: png(2000, 5000).toString('base64') };
    },
  };
  const tab = makeTab(1, 'https://long.example/', { wc: { debugger: dbg } });
  const w = makeWindow([tab]);
  w.win.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
  const shots = new Screenshots();
  const res = await shots.fullPage(w, tab);
  assert.deepEqual([res.width, res.height, res.scale, res.clipped], [2000, 5000, 2, false]);
  assert.deepEqual(calls.find(([n]) => n === 'Page.captureScreenshot')[1], { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width: 1000, height: 2500, scale: 2 } });
  assert.deepEqual(calls.at(-1), ['detach']);
  // Developer Tools already attached: it fails kindly and leaves them alone.
  dbg.attached = true;
  dbg.sendCommand = async () => { throw new Error('busy'); };
  calls.length = 0;
  assert.match((await shots.fullPage(w, tab)).error, /Close Developer Tools/);
  assert.ok(!calls.some(([n]) => n === 'detach'));
});

// ---------------------------------------------------------------- installed apps
test('an app’s details come from its manifest, on the site’s own origin', () => {
  const page = { name: '', title: 'Inbox (3) – Mail', icons: [{ src: 'https://mail.example/fav.ico', sizes: '' }, { src: 'https://mail.example/touch.png', sizes: '180x180', touch: true }] };
  const manifest = {
    name: 'Example Mail', short_name: 'Mail', start_url: '/inbox?source=pwa', scope: '/',
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/mask.png', sizes: '1024x1024', purpose: 'maskable' },
      { src: '/icons/logo.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  const d = appDetails('https://mail.example/inbox/42', page, manifest, 'https://mail.example/manifest.json');
  assert.equal(d.name, 'Example Mail');
  assert.equal(d.startUrl, 'https://mail.example/inbox?source=pwa');
  assert.equal(d.scope, 'https://mail.example/');
  assert.deepEqual(d.icons.map((i) => i.src), ['https://mail.example/icons/512.png', 'https://mail.example/icons/192.png', 'https://mail.example/touch.png', 'https://mail.example/apple-touch-icon.png']);
  // A start page on another site is ignored; without a manifest it's the page's title and icons.
  const evil = appDetails('https://mail.example/', page, { start_url: 'https://evil.example/', scope: 'https://evil.example/' }, 'https://mail.example/m.json');
  assert.equal(evil.startUrl, 'https://mail.example/');
  assert.equal(evil.scope, 'https://mail.example/');
  const plain = appDetails('https://news.example/today', { title: 'Today’s news', icons: [] });
  assert.equal(plain.name, 'Today’s news');
  assert.equal(plain.startUrl, 'https://news.example/today');
});

test('Mac launchers: a tiny app that asks Lumio to open the web app', () => {
  assert.equal(launchers.appIdFromArgv(['/Applications/Lumio Browser.app', '--lumio-app=0123456789abcdef']), '0123456789abcdef');
  assert.equal(launchers.appIdFromArgv(['--lumio-app=../../etc']), null);
  assert.equal(launchers.appIdFromArgv([]), null);
  assert.equal(launchers.safeName('a/b:c*?"<>| .'), 'a b c');
  assert.equal(launchers.safeName('...'), 'Web app');
  const icns = launchers.icns({ 128: png(128, 128), 256: png(256, 256), 512: png(512, 512) });
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.deepEqual([icns.toString('ascii', 8, 12), icns.toString('ascii', 8 + 41, 8 + 45)], ['ic07', 'ic08']);
  // Names with quotes can't break out of the script or the plist.
  const files = launchers.macBundleFiles({ id: '0123456789abcdef', name: `Bob's "App" & <Co>`, lumio: { bundleId: 'online.lumio-usa.browser' }, icon: Buffer.alloc(1) });
  assert.match(files['Contents/MacOS/launch'], /^#!\/bin\/sh\n/);
  assert.match(files['Contents/MacOS/launch'], /exec \/usr\/bin\/open -n -b 'online\.lumio-usa\.browser' --args '--lumio-app=0123456789abcdef'\n$/);
  assert.match(files['Contents/Info.plist'], /<string>Bob&apos;s &quot;App&quot; &amp; &lt;Co&gt;<\/string>/);
  assert.match(files['Contents/Info.plist'], /<key>LSUIElement<\/key>\n {2}<true\/>/);
  const dev = launchers.macBundleFiles({ id: '0123456789abcdef', name: 'X', lumio: { appBundle: '/dev/Electron.app', appPath: "/src/it's" }, icon: Buffer.alloc(1) });
  assert.match(dev['Contents/MacOS/launch'], /open -n -a '\/dev\/Electron\.app' --args '\/src\/it'\\''s' '--lumio-app=0123456789abcdef'/);
  // Two apps with the same name: the second launcher never replaces the first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-launchers-'));
  const a = launchers.writeMacBundle(dir, { id: '0123456789abcdef', name: 'Mail', lumio: { bundleId: 'x' }, icon: Buffer.alloc(1) });
  const b = launchers.writeMacBundle(dir, { id: 'fedcba9876543210', name: 'Mail', lumio: { bundleId: 'x' }, icon: Buffer.alloc(1) });
  assert.deepEqual([path.basename(a), path.basename(b)], ['Mail.app', 'Mail 2.app']);
  assert.match(fs.readFileSync(path.join(a, 'Contents/MacOS/launch'), 'utf8'), /--lumio-app=0123456789abcdef/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installing an app: its record, icon and launcher; removing it takes them away', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-apps-'));
  const launcherDir = path.join(dir, 'Lumio Apps');
  const opened = [];
  const toasts = [];
  const fetched = [];
  const icons = { 'https://mail.example/icons/512.png': png(512, 512), 'https://mail.example/manifest.json': Buffer.from(JSON.stringify({ name: 'Mail', start_url: '/', icons: [{ src: '/icons/512.png', sizes: '512x512' }] })) };
  const apps = new Apps({
    dir,
    launcherDir,
    session: () => ({ fetch: async (u) => { fetched.push(u); return icons[u] ? new Response(icons[u]) : new Response('', { status: 404 }); } }),
    permissions: () => null,
    openUrl: (u) => opened.push(u),
    toast: (_w, t) => toasts.push(t),
  });
  const tab = makeTab(1, 'https://mail.example/inbox', { wc: { executeJavaScriptInIsolatedWorld: async () => ({ manifest: 'https://mail.example/manifest.json', icons: [], name: '', title: 'Inbox' }) } });
  const w = makeWindow([tab]);
  w.showOverlay = (rect, payload) => { w.overlayKind = payload.kind; w.shown = payload; };
  // Create shortcut, opening in a tab: the page you're on.
  await apps.prompt(w, tab, { shortcut: true });
  assert.equal(w.shown.kind, 'install');
  assert.equal(w.shown.shortcut, true);
  assert.equal(w.shown.name, 'Inbox');
  assert.match(w.shown.icon, /^data:image\/png;base64,/);
  await apps.install(w, { token: 'wrong', name: 'X' });
  assert.equal(apps.list().length, 0, 'only the dialog Lumio showed');
  await apps.install(w, { token: w.shown.token, name: '  My\u0007 Mail  ', window: false });
  const [rec] = apps.list();
  assert.equal(rec.name, 'My  Mail');
  assert.equal(rec.url, 'https://mail.example/inbox');
  assert.equal(rec.window, false);
  assert.deepEqual(opened, [], 'you’re on that page already');
  assert.deepEqual(toasts, ['Shortcut “My  Mail” created']);
  assert.ok(fs.existsSync(path.join(dir, 'apps', rec.id, 'icon.png')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'apps.json'), 'utf8')).apps.map((a) => a.id), [rec.id]);
  if (MAC) {
    assert.deepEqual(rec.launchers, [path.join(launcherDir, 'My Mail.app')]);
    const exe = path.join(rec.launchers[0], 'Contents', 'MacOS', 'launch');
    assert.ok(fs.statSync(exe).mode & 0o100, 'the launcher can run');
    assert.match(fs.readFileSync(exe, 'utf8'), new RegExp(`--lumio-app=${rec.id}'`));
  } else {
    assert.deepEqual(rec.launchers, []);
  }
  // Its launcher opens it again; Remove takes away its files and launcher.
  assert.equal(apps.launch(['x', `--lumio-app=${rec.id}`]), true);
  assert.deepEqual(opened, ['https://mail.example/inbox'], 'in a tab');
  assert.equal(apps.launch(['x', '--lumio-app=ffffffffffffffff']), false);
  assert.equal(apps.uninstall(rec.id), true);
  assert.equal(apps.list().length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'apps', rec.id)));
  if (MAC) assert.ok(!fs.existsSync(path.join(launcherDir, 'My Mail.app')));
  // Not from incognito, and only web pages.
  const inc = makeWindow([tab], { incognito: true });
  await apps.prompt(inc, tab);
  assert.equal(toasts.at(-1), 'Apps can’t be installed from an incognito window');
  await apps.prompt(w, makeTab(2, 'lumio://settings/'));
  assert.equal(toasts.at(-1), 'Only web pages can be installed as apps');
  fs.rmSync(dir, { recursive: true, force: true });
});
