// Power-user features: Name window (main/window-name.js and the overlay's
// box, renderer/ui/name-window.js), caret browsing (main/caret-browsing.js),
// force dark mode for web contents (main/force-dark.js), protocol handlers
// (main/protocol-handlers.js and the page shim in preload/internal.js), how
// main/power-user.js wires them up, and their rows in Settings
// (renderer/pages/settings-power.js). Keyboard shortcuts have their own file
// (tests/shortcuts.test.mjs). The parts that need a browser run in headless
// Chrome and are skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);

// Electron stand-ins: what main/power-user.js and main/menu.js use of it.
const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
const electron = require.cache[electronPath].exports;
const appEvents = {};
const ipcListeners = {};
const relaunches = [];
let dialogAnswer = 0;
const dialogs = [];
electron.Menu ??= { buildFromTemplate: (items) => items };
electron.app = {
  on: (ev, fn) => { (appEvents[ev] ||= []).push(fn); },
  relaunch: (opts) => relaunches.push(['relaunch', opts]),
  quit: () => relaunches.push(['quit']),
};
electron.ipcMain = { on: (channel, fn) => { (ipcListeners[channel] ||= []).push(fn); } };
electron.dialog = { showMessageBox: async (_win, opts) => { dialogs.push(opts); return { response: dialogAnswer }; } };

const windowName = require('../main/window-name.js');
const caret = require('../main/caret-browsing.js');
const forceDark = require('../main/force-dark.js');
const ph = require('../main/protocol-handlers.js');
const powerUser = require('../main/power-user.js');
const { menuTemplate } = require('../main/menu.js');
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const MAC = process.platform === 'darwin';
const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => {}) }); // main.js's commands
const storeStandIn = (settings = {}) => ({ settings, setSetting(k, v) { this.settings[k] = v; } });
const find = (items, label) => {
  for (const it of items) {
    if (it.label === label) return it;
    const sub = Array.isArray(it.submenu) && find(it.submenu, label);
    if (sub) return sub;
  }
  return null;
};

// A tab's page: the parts of webContents these features use.
let nextWcId = 1;
function wcStandIn(url = 'https://example.com/') {
  const wc = {
    id: nextWcId++, url, caret: false, loads: [], listeners: {}, focused: 0, destroyed: false,
    isDestroyed: () => wc.destroyed,
    isCaretBrowsingEnabled: () => wc.caret,
    setCaretBrowsingEnabled: (on) => { wc.caret = on; },
    on: (ev, fn) => { (wc.listeners[ev] ||= []).push(fn); },
    once: (ev, fn) => { (wc.listeners[ev] ||= []).push(fn); },
    fire: (ev, ...args) => (wc.listeners[ev] || []).forEach((fn) => fn(...args)),
    loadURL: async (u) => { wc.loads.push(u); },
    focus: () => { wc.focused++; },
  };
  wc.mainFrame = { url };
  return wc;
}

// A window: the parts of BrowserWin these features use.
function winStandIn({ incognito = false, pageTitle = 'Mail — Lumio Browser' } = {}) {
  const titleListeners = [];
  const w = {
    incognito, closed: false, overlayKind: null, shown: [], hidden: 0, saved: 0, sent: [], created: [],
    win: {
      title: 'Lumio Browser',
      on: (ev, fn) => { if (ev === 'page-title-updated') titleListeners.push(fn); },
      setTitle(t) { this.title = t; },
      getContentSize: () => [1200, 800],
      webContents: { getTitle: () => pageTitle },
    },
    app: { onSessionChanged: () => { w.saved++; } },
    overlay: { webContents: { focus: () => { w.overlayFocused = true; } } },
    showOverlay(rect, payload) { w.overlayKind = payload.kind; w.shown.push({ rect, payload }); },
    hideOverlay() { w.overlayKind = null; w.hidden++; },
    emit: (channel, payload) => w.sent.push([channel, payload]),
    ai: { isRunning: () => false },
  };
  w.tabs = {
    slot: { x: 300, y: 90, width: 900, height: 700 },
    tabs: [],
    page: wcStandIn(),
    wc: () => w.tabs.page,
    create: (url, opts) => { const tab = { id: 100 + w.created.length, view: { webContents: wcStandIn(url) } }; w.created.push({ url, ...opts }); return tab; },
  };
  // What the window does when its UI page's <title> changes.
  w.titleChanged = (t) => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    titleListeners.forEach((fn) => fn(e, t));
    if (!e.prevented) w.win.title = t;
  };
  return w;
}
// Adds a tab with this page to window w; returns the tab.
function addTab(w, wc = wcStandIn()) {
  const tab = { id: w.tabs.tabs.length + 1, view: { webContents: wc } };
  w.tabs.tabs.push(tab);
  return tab;
}
const tabFinder = (windows) => (wc) => {
  for (const w of windows) {
    const tab = w.tabs.tabs.find((t) => t.view.webContents === wc);
    if (tab) return { w, tab };
  }
  return null;
};

// ---------------------------------------------------------------- name window
test('Name window: the name is one clean line, becomes the window’s title, and is saved with the session', () => {
  assert.equal(windowName.clean('  Trip \n planning\u0007 '), 'Trip planning');
  assert.equal(windowName.clean('x'.repeat(200)).length, windowName.MAX);
  assert.equal(windowName.clean(null), '');

  const w = winStandIn();
  windowName.init(w, null);
  w.titleChanged('Mail — Lumio Browser');
  assert.equal(w.win.title, 'Mail — Lumio Browser', 'unnamed: the title follows the tab');
  assert.deepEqual(windowName.sessionField(w), {});

  assert.equal(windowName.set(w, '  Work '), true);
  assert.equal(w.win.title, 'Work');
  assert.equal(w.saved, 1, 'the session is saved');
  assert.deepEqual(windowName.sessionField(w), { name: 'Work' });
  w.titleChanged('Calendar — Lumio Browser');
  assert.equal(w.win.title, 'Work', 'a named window keeps its name when tabs change');
  assert.equal(windowName.set(w, 'Work'), false, 'same name: nothing to do');

  // An empty name goes back to the usual title.
  assert.equal(windowName.set(w, '   '), true);
  assert.equal(w.win.title, 'Mail — Lumio Browser');
  assert.deepEqual(windowName.sessionField(w), {});

  // A restored window comes back with its name.
  const restored = winStandIn();
  windowName.init(restored, 'Trip');
  assert.equal(restored.win.title, 'Trip');
  assert.equal(restored.name, 'Trip');
});

test('Name window: the box opens over the top of the page, and its answer saves, cancels or keeps the click', () => {
  const w = winStandIn();
  windowName.init(w, 'Work');
  windowName.ask(w);
  const { rect, payload } = w.shown[0];
  assert.deepEqual(payload, { kind: 'namewindow', name: 'Work', mac: MAC });
  assert.equal(rect.x, 300 + (900 - rect.width) / 2, 'centered over the page');
  assert.equal(rect.y, 96, 'just under the toolbar');
  assert.ok(w.overlayFocused, 'the box gets the keyboard');

  windowName.answer(w, { name: 'Taxes' });
  assert.equal(w.name, 'Taxes');
  assert.equal(w.hidden, 1);
  assert.equal(w.tabs.page.focused, 1, 'the keyboard goes back to the page');

  // Cancel keeps the name; Esc and Cancel give the page the keyboard back.
  windowName.ask(w);
  windowName.answer(w, { cancel: true, name: 'ignored' });
  assert.equal(w.name, 'Taxes');
  assert.equal(w.tabs.page.focused, 2);
  // Clicking somewhere else (the address bar) leaves the keyboard there.
  windowName.ask(w);
  windowName.answer(w, { cancel: true, blur: true });
  assert.equal(w.tabs.page.focused, 2);
  assert.equal(w.overlayKind, null);
  // A late answer from a box that's gone (another popup took its place) does nothing.
  w.overlayKind = 'downloads';
  windowName.answer(w, { name: 'Late' });
  assert.equal(w.name, 'Taxes');
  assert.equal(w.overlayKind, 'downloads');
});

// ---------------------------------------------------------------- caret browsing
test('Caret browsing: one setting for every tab, pages loading later follow it', () => {
  const store = storeStandIn();
  const a = wcStandIn();
  const b = wcStandIn();
  const notTab = wcStandIn();
  let menus = 0;
  for (const wc of [a, b, notTab]) caret.watch(wc, { store, isTab: (x) => x !== notTab });
  caret.set(true, { store, tabs: () => [a, b], changed: () => menus++ });
  assert.equal(store.settings.caretBrowsing, true);
  assert.deepEqual([a.caret, b.caret], [true, true]);
  assert.equal(menus, 1, 'the View menu’s checkmark follows');
  // A new page in a tab follows the setting; Lumio's own views don't.
  const c = wcStandIn();
  caret.watch(c, { store, isTab: () => true });
  c.fire('dom-ready');
  notTab.fire('dom-ready');
  assert.equal(c.caret, true);
  assert.equal(notTab.caret, false);
  caret.set(false, { store, tabs: () => [a, b, c], changed: () => menus++ });
  assert.deepEqual([a.caret, b.caret, c.caret], [false, false, false]);
});

test('Caret browsing: F7 asks the first time, and after a yes it just toggles', async () => {
  const store = storeStandIn();
  const w = winStandIn();
  const page = wcStandIn();
  let menus = 0;
  const opts = { store, tabs: () => [page], changed: () => menus++, dialog: electron.dialog, key: 'F7' };
  dialogs.length = 0;

  dialogAnswer = 1; // Cancel
  assert.equal(await caret.toggle(w, opts), false);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].message, 'Turn on caret browsing?');
  assert.match(dialogs[0].detail, /Press F7 again to turn it off/);
  assert.equal(page.caret, false);
  assert.equal(menus, 1, 'the menu’s checkmark goes back');
  assert.equal(store.settings.caretBrowsingAsked, undefined, 'asks again next time');

  // Pressing F7 again while it asks doesn't stack a second question.
  dialogAnswer = 0;
  const first = caret.toggle(w, opts);
  assert.equal(await caret.toggle(w, opts), false);
  assert.equal(await first, true);
  assert.equal(dialogs.length, 2);
  assert.equal(page.caret, true);
  assert.equal(store.settings.caretBrowsingAsked, true);
  assert.deepEqual(w.sent.at(-1), ['toast', { text: 'Caret browsing is on. Press F7 to turn it off.' }]);

  assert.equal(await caret.toggle(w, opts), false, 'off without asking');
  assert.equal(await caret.toggle(w, opts), true, 'and on again without asking');
  assert.equal(dialogs.length, 2);
  assert.equal(page.caret, true);
});

// ---------------------------------------------------------------- force dark
function commandLineStandIn(switches = {}) {
  return {
    switches,
    hasSwitch: (n) => n in switches,
    getSwitchValue: (n) => switches[n] ?? '',
    appendSwitch: (n, v) => { switches[n] = v; },
  };
}

test('Force dark: read from settings at startup, added to the switches Chromium already has, and a relaunch reopens the windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fd-'));
  const app = { getPath: () => dir, commandLine: commandLineStandIn() };
  assert.equal(forceDark.applyAtStartup(app), false, 'no settings file yet');
  assert.deepEqual(app.commandLine.switches, {});

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forceDarkPages: true }));
  app.commandLine = commandLineStandIn({ 'blink-settings': 'hideScrollbars=true' });
  assert.equal(forceDark.applyAtStartup(app), true);
  assert.equal(app.commandLine.switches['blink-settings'], 'hideScrollbars=true,forceDarkModeEnabled=true', 'kept what was there');
  assert.equal(app.commandLine.switches['enable-features'], 'WebContentsForceDark', 'Chrome’s feature too');
  // Settings shows Relaunch only while the setting and this run differ.
  assert.deepEqual(forceDark.state(storeStandIn({ forceDarkPages: true })), { on: true, active: true });
  assert.deepEqual(forceDark.state(storeStandIn({})), { on: false, active: true });

  const calls = [];
  forceDark.relaunch({ relaunch: (o) => calls.push(o), quit: () => calls.push('quit') }, ['/Apps/Lumio', '--flag', forceDark.RESTORE]);
  assert.deepEqual(calls, [{ args: ['--flag', forceDark.RESTORE] }, 'quit'], 'asks once to reopen the windows');
  assert.equal(forceDark.relaunched(['/Apps/Lumio', forceDark.RESTORE]), true);
  assert.equal(forceDark.relaunched(['/Apps/Lumio']), false);

  fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken');
  app.commandLine = commandLineStandIn();
  assert.equal(forceDark.applyAtStartup(app), false, 'a broken file means off');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Force dark: while it’s in effect Lumio is dark, whatever Theme says, and the menu’s Appearance waits', () => {
  const theme = require('../main/theme.js');
  const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false, on() {} };
  const store = { settings: { appearance: 'light' }, settingsFile: { onSave() {} } };
  theme.init({ nativeTheme, store });
  assert.equal(nativeTheme.themeSource, 'light');
  assert.equal(find(menuTemplate(cmd, powerUser.menuState(store)), 'Light').enabled, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fd-'));
  const setting = (on) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forceDarkPages: on }));
  setting(true);
  forceDark.applyAtStartup({ getPath: () => dir, commandLine: commandLineStandIn() });
  theme.init({ nativeTheme, store });
  assert.equal(nativeTheme.themeSource, 'dark', 'pages, the window and native menus are dark');
  assert.deepEqual(find(menuTemplate(cmd, powerUser.menuState(store)), 'Appearance').submenu.map((i) => i.enabled), [false, false, false]);

  setting(false); // back to how the other tests expect it
  forceDark.applyAtStartup({ getPath: () => dir, commandLine: commandLineStandIn() });
  theme.init({ nativeTheme, store });
  assert.equal(nativeTheme.themeSource, 'light');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- protocol handlers
test('Protocol handlers: the checks the HTML standard asks for, done again in Lumio', () => {
  const gmail = 'https://mail.google.com/mail/u/0/';
  assert.deepEqual(ph.normalize('MAILTO', '?extsrc=mailto&url=%s', gmail),
    { scheme: 'mailto', url: 'https://mail.google.com/mail/u/0/?extsrc=mailto&url=%s', origin: 'https://mail.google.com', host: 'mail.google.com' });
  assert.equal(ph.normalize('web+notes', '/n?u=%s', 'https://notes.example/').scheme, 'web+notes');
  assert.equal(ph.normalize('mailto', '/c?to=%s', 'http://localhost:8080/').origin, 'http://localhost:8080', 'http on this computer counts as secure');
  assert.equal(ph.normalize('mailto', '/c?to=%s', 'http://mail.example/').error, 'SecurityError', 'not https');
  assert.equal(ph.normalize('http', '/c?to=%s', gmail).error, 'SecurityError', 'not a scheme sites may handle');
  assert.equal(ph.normalize('web+', '/c?to=%s', gmail).error, 'SecurityError');
  assert.equal(ph.normalize('mailto', '/compose', gmail).error, 'SyntaxError', 'no %s');
  assert.equal(ph.normalize('mailto', 'https://evil.example/?u=%s', gmail).error, 'SecurityError', 'another site');
  assert.equal(ph.normalize('mailto', 'javascript:alert(1)//%s', gmail).error, 'SecurityError');
  assert.equal(ph.normalize('mailto', '/c?to=%s', 'lumio://settings/').error, 'SecurityError');
  assert.equal(ph.fill('https://m.example/c?to=%s&x=%s', 'mailto:a@b.co?subject=Hi there'), 'https://m.example/c?to=mailto%3Aa%40b.co%3Fsubject%3DHi%20there&x=%s');
  assert.equal(ph.schemeOf('MailTo:x@y'), 'mailto');
  assert.equal(ph.linksOf('mailto'), 'email links');
  assert.equal(ph.linksOf('web+notes'), 'web+notes: links');
});

test('Protocol handlers: a site asks in the permission bar; Allow routes its links, Block stops the asking', () => {
  const store = storeStandIn();
  const w = winStandIn();
  const tab = addTab(w, wcStandIn('https://mail.example/inbox'));
  const wc = tab.view.webContents;
  const handlers = new ph.ProtocolHandlers({ store, tabOf: tabFinder([w]) });

  const asked = handlers.register(wc, 'https://mail.example/inbox', 'mailto', 'https://mail.example/compose?to=%s');
  assert.ok(asked.asked);
  const [channel, bar] = w.sent.at(-1);
  assert.equal(channel, 'permission');
  assert.deepEqual(bar, { id: asked.asked, origin: 'https://mail.example', host: 'mail.example', permission: 'protocol-handler', label: 'open all email links', wcId: wc.id });
  // Asking again while the bar is up doesn't add a second bar.
  handlers.register(wc, 'https://mail.example/inbox', 'mailto', 'https://mail.example/compose?to=%s');
  assert.equal(w.sent.filter(([c]) => c === 'permission').length, 1);
  assert.equal(handlers.target('mailto:sam@example.com'), null, 'nothing routed before Allow');

  assert.equal(handlers.respond('7', true), false, 'a Permissions id isn’t ours');
  assert.equal(handlers.respond(asked.asked, true), true);
  assert.equal(handlers.target('mailto:sam@example.com'), 'https://mail.example/compose?to=mailto%3Asam%40example.com');
  assert.deepEqual(handlers.list().map((h) => [h.host, h.scheme, h.allowed, h.what]), [['mail.example', 'mailto', true, 'email links']]);
  assert.deepEqual(handlers.register(wc, 'https://mail.example/inbox', 'mailto', 'https://mail.example/compose?to=%s'), { ok: true }, 'already the handler: no question');

  // Another site asks to take over: the bar says what it replaces; Allow replaces it.
  const other = addTab(w, wcStandIn('https://post.example/'));
  const second = handlers.register(other.view.webContents, 'https://post.example/', 'mailto', '/new?to=%s');
  assert.equal(w.sent.at(-1)[1].label, 'open all email links instead of mail.example');
  handlers.respond(second.asked, true);
  assert.equal(handlers.target('mailto:x@y.z'), 'https://post.example/new?to=mailto%3Ax%40y.z');
  assert.equal(handlers.list().filter((h) => h.allowed).length, 1, 'one handler per scheme');

  // Block: remembered, and that site isn't asked again.
  const cal = addTab(w, wcStandIn('https://cal.example/'));
  const third = handlers.register(cal.view.webContents, 'https://cal.example/', 'webcal', '/add?u=%s');
  handlers.respond(third.asked, false);
  const n = w.sent.length;
  assert.equal(handlers.register(cal.view.webContents, 'https://cal.example/', 'webcal', '/add?u=%s').ok, false);
  assert.equal(w.sent.length, n);
  assert.equal(handlers.target('webcal://cal.example/feed'), null);
  assert.deepEqual(handlers.list().find((h) => h.scheme === 'webcal'), { scheme: 'webcal', url: 'https://cal.example/add?u=%s', origin: 'https://cal.example', host: 'cal.example', allowed: false, what: 'calendar links' });

  // Remove (Settings) forgets either kind.
  handlers.remove('webcal', 'https://cal.example');
  assert.equal(handlers.list().some((h) => h.scheme === 'webcal'), false);

  // A site can take back only its own handler.
  assert.equal(handlers.unregister(wc, 'https://mail.example/', 'mailto', 'https://mail.example/compose?to=%s'), false, 'not mail.example’s any more');
  assert.equal(handlers.unregister(other.view.webContents, 'https://post.example/', 'mailto', '/new?to=%s'), true);
  assert.equal(handlers.target('mailto:x@y.z'), null);
});

test('Protocol handlers: incognito can’t add one, bad calls are refused, and a page that leaves takes its question with it', () => {
  const store = storeStandIn();
  const normal = winStandIn();
  const incognito = winStandIn({ incognito: true });
  const handlers = new ph.ProtocolHandlers({ store, tabOf: tabFinder([normal, incognito]) });
  const inc = addTab(incognito, wcStandIn('https://mail.example/'));
  assert.deepEqual(handlers.register(inc.view.webContents, 'https://mail.example/', 'mailto', '/c?to=%s'), { ok: false });
  assert.equal(handlers.register(wcStandIn(), 'https://mail.example/', 'mailto', '/c?to=%s').ok, false, 'not a tab');
  const helped = addTab(normal, wcStandIn('https://mail.example/'));
  helped.agent = { name: 'Helper 1' };
  assert.deepEqual(handlers.register(helped.view.webContents, 'https://mail.example/', 'mailto', '/c?to=%s'), { ok: false }, 'not from a page a helper AI is on');
  const tab = addTab(normal, wcStandIn('https://mail.example/'));
  assert.deepEqual(handlers.register(tab.view.webContents, 'https://mail.example/', 'mailto', 'https://evil.example/?%s'), { ok: false, error: 'SecurityError' });
  // At most three questions per page at a time.
  for (const s of ['mailto', 'webcal', 'tel', 'sms']) handlers.register(tab.view.webContents, 'https://mail.example/', s, `/h?${s}=%s`);
  assert.equal(normal.sent.filter(([c]) => c === 'permission').length, 3);
  handlers.cancelFor(tab.view.webContents.id);
  assert.deepEqual(normal.sent.slice(-3).map(([c]) => c), ['permission-cancel', 'permission-cancel', 'permission-cancel']);
  assert.equal(handlers.pending.size, 0);
});

test('Protocol handlers: links open the site’s page beside the tab, one tab a second; links Lumio loads itself go there too', async () => {
  const store = storeStandIn({ protocolHandlers: [{ scheme: 'mailto', url: 'https://mail.example/c?to=%s', origin: 'https://mail.example', host: 'mail.example', allowed: true }] });
  const w = winStandIn();
  addTab(w);
  const tab = addTab(w, wcStandIn('https://blog.example/'));
  const wc = tab.view.webContents;
  const handlers = new ph.ProtocolHandlers({ store, tabOf: tabFinder([w]) });
  handlers.watch(wc);
  const navigate = (url) => { const e = { url, isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } }; wc.fire('will-frame-navigate', e); return e; };
  const click = () => wc.fire('input-event', {}, { type: 'mouseDown' });

  assert.equal(navigate('https://blog.example/next').prevented, false, 'other links are left alone');
  assert.equal(navigate('tel:+15551234').prevented, false, 'no handler for that scheme');
  // A script (or an ad's frame) going to a mailto: link by itself opens nothing.
  wc.fire('input-event', {}, { type: 'mouseMove' });
  assert.equal(navigate('mailto:nobody@example.com').prevented, true);
  assert.equal(w.created.length, 0, 'no tab without a click or key press');
  click();
  const e = navigate('mailto:sam@example.com');
  assert.equal(e.prevented, true);
  assert.deepEqual(w.created, [{ url: 'https://mail.example/c?to=mailto%3Asam%40example.com', index: 2 }], 'a new tab right after this one');
  // One click opens one tab, and a script clicking mailto: links over and over doesn't flood the window.
  assert.equal(navigate('mailto:again@example.com').prevented, true);
  click();
  assert.equal(navigate('mailto:again@example.com').prevented, true);
  assert.equal(w.created.length, 1);

  // A link Lumio loads itself (a target=_blank link's new tab, a bookmark): the tab goes to the site.
  const fresh = addTab(w, wcStandIn('about:blank'));
  handlers.watch(fresh.view.webContents);
  fresh.view.webContents.fire('did-start-navigation', { url: 'mailto:kim@example.com', isMainFrame: true, isSameDocument: false, initiator: null });
  // A page's own navigation is will-frame-navigate's business.
  fresh.view.webContents.fire('did-start-navigation', { url: 'mailto:x@example.com', isMainFrame: true, isSameDocument: false, initiator: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fresh.view.webContents.loads, ['https://mail.example/c?to=mailto%3Akim%40example.com']);

  // Views that aren't tabs (the window's own UI) are never redirected.
  const ui = wcStandIn('lumio://shell/');
  handlers.watch(ui);
  const ev = { url: 'mailto:a@b.c', isMainFrame: true, preventDefault() { this.prevented = true; } };
  ui.fire('will-frame-navigate', ev);
  assert.equal(ev.prevented, undefined);
});

// ---------------------------------------------------------------- wiring (main/power-user.js)
const world = { windows: [], menus: 0, internal: {}, on: {}, shell: {} };
const powerStore = storeStandIn({});
powerUser.setup({
  store: powerStore,
  on: (channel, fn) => { (world.on[channel] ||= []).push(fn); },
  handle: (channel, fn) => { world.shell[channel] = fn; },
  internalHandle: (channel, hosts, fn) => { assert.deepEqual(hosts, ['settings']); world.internal[channel] = fn; },
  windows: () => world.windows,
  tabOf: (wc) => tabFinder(world.windows)(wc),
  menuChanged: () => { world.menus++; },
  menuTemplate: () => menuTemplate(cmd, powerUser.menuState(powerStore)),
});
const W = winStandIn();
world.windows.push(W);
const ask = (channel, ...args) => world.internal[channel]({ w: W }, ...args);
const fromShell = (channel, payload) => world.on[channel].forEach((fn) => fn(W, payload));

test('power-user.js: new pages are watched, and Settings reads and changes the features', () => {
  const page = addTab(W, wcStandIn('https://mail.example/inbox')).view.webContents;
  appEvents['web-contents-created'].forEach((fn) => fn({}, page));
  assert.ok(page.listeners['dom-ready'] && page.listeners['will-frame-navigate'], 'caret browsing and handler links are watched');

  assert.deepEqual(ask('page:power-state'), { caretBrowsing: false, caretKey: 'F7', forceDark: { on: false, active: forceDark.state(powerStore).active }, protocolHandlers: [], verticalTabs: false });
  powerStore.settings.verticalTabs = true; // turned on from a tab's menu while Settings is open
  assert.equal(ask('page:power-state').verticalTabs, true, 'Settings shows it when it gets the focus back');
  delete powerStore.settings.verticalTabs;
  const menus = world.menus;
  assert.equal(ask('page:power-set', 'caretBrowsing', true).caretBrowsing, true);
  assert.equal(page.caret, true, 'open tabs follow');
  assert.equal(world.menus, menus + 1, 'the menu’s checkmark follows');
  assert.equal(find(menuTemplate(cmd, powerUser.menuState(powerStore)), 'Caret Browsing').checked, true);
  ask('page:power-set', 'caretBrowsing', false);
  assert.equal(page.caret, false);

  assert.equal(ask('page:power-set', 'forceDarkPages', true).forceDark.on, true);
  assert.equal(powerStore.settings.forceDarkPages, true);
  ask('page:power-set', 'forceDarkPages', false);

  // A shortcut picked for caret browsing shows in Settings' note.
  powerStore.settings.shortcuts = { 'caret-browsing': 'F8' };
  assert.equal(ask('page:power-state').caretKey, 'F8');
  delete powerStore.settings.shortcuts;
});

test('power-user.js: a page registers a handler, the bar answers, Settings lists and removes it', () => {
  const page = addTab(W, wcStandIn('https://mail.example/inbox')).view.webContents;
  const register = (frame, payload) => ipcListeners['ph:register'].forEach((fn) => fn({ sender: page, senderFrame: frame }, payload));
  register({ url: 'https://mail.example/inbox' }, { scheme: 'mailto', url: 'https://mail.example/c?to=%s' });
  assert.equal(W.sent.filter(([c]) => c === 'permission').length, 0, 'only the top frame can register');
  register(page.mainFrame, { scheme: 'mailto', url: 'https://mail.example/c?to=%s' });
  const [, bar] = W.sent.filter(([c]) => c === 'permission').at(-1);
  assert.equal(bar.label, 'open all email links');
  fromShell('permission:respond', { id: bar.id, allow: true, remember: true });
  assert.deepEqual(ask('page:power-state').protocolHandlers.map((h) => [h.host, h.allowed]), [['mail.example', true]]);
  assert.deepEqual(ask('page:protocol-handler-remove', 'mailto', 'https://mail.example').protocolHandlers, []);
});

test('power-user.js: a new shortcut rebuilds the menu and reaches every window’s tooltips', () => {
  const menus = world.menus;
  const before = W.sent.length;
  assert.deepEqual(world.shell['shell:shortcut-hints'](W), [], 'Lumio’s own keys: nothing to change');
  const key = MAC ? 'Shift+Cmd+Y' : 'Ctrl+Shift+Y';
  assert.equal(ask('page:shortcut-set', 'new-tab', key, false).ok, true);
  assert.equal(world.menus, menus + 1);
  const sent = W.sent.slice(before).filter(([c]) => c === 'shortcut-hints');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], [{ from: MAC ? '⌘T' : 'Ctrl+T', to: MAC ? '⇧⌘Y' : 'Ctrl+Shift+Y' }]);
  assert.deepEqual(world.shell['shell:shortcut-hints'](W), sent[0][1], 'a window opened now asks and gets the same');
  ask('page:shortcut-reset', null);
  assert.deepEqual(W.sent.at(-1), ['shortcut-hints', []]);
  assert.deepEqual(powerStore.settings.shortcuts, {});
});

test('power-user.js: Name window answers, and Relaunch asks first only while Lumio AI works', async () => {
  powerUser.nameWindow(W);
  assert.equal(W.overlayKind, 'namewindow');
  fromShell('window:name', { name: 'Research' });
  assert.equal(W.name, 'Research');

  // Every Relaunch button is main/system.js's page:relaunch, which asks this first.
  dialogs.length = 0;
  assert.equal(await powerUser.confirmRelaunch(W), true);
  assert.equal(dialogs.length, 0);
  W.ai.isRunning = () => true;
  dialogAnswer = 1;
  assert.equal(await powerUser.confirmRelaunch(W), false);
  assert.equal(dialogs.at(-1).message, 'Relaunch Lumio Browser?');
  W.ai.isRunning = () => false;
});

test('the menus: View › Caret Browsing (F7) and Window › Name Window…', () => {
  const t = menuTemplate(cmd, { caretBrowsing: true });
  const caretItem = find(t, 'Caret Browsing');
  assert.equal(caretItem.type, 'checkbox');
  assert.equal(caretItem.checked, true);
  assert.equal(caretItem.accelerator, 'F7');
  assert.equal(find(t, 'View').submenu.includes(caretItem), true);
  const windowMenu = find(t, 'Window');
  assert.ok(windowMenu.submenu.some((i) => i.label === 'Name Window…'));
  // On the Mac it's the system's Window menu, which lists the windows by name.
  assert.equal(windowMenu.role, MAC ? 'windowMenu' : undefined);
});

// ---------------------------------------------------------------- in headless Chrome
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const SHOTS = process.env.LUMIO_SHOTS;
const PRELOAD = fs.readFileSync(new URL('../preload/internal.js', import.meta.url), 'utf8');

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    // /site/… is a website (the preload's shim runs there); /overlay/… the
    // overlay's page; everything else Lumio's pages (lumio://settings/…).
    if (req.url.startsWith('/site/')) {
      // /site/themed has a dark theme of its own; other /site/ pages are plain white.
      const themed = req.url.startsWith('/site/themed') ? '<style>:root { color-scheme: light dark; background: light-dark(#fafafa, #203040); }</style>' : '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Site</title>${themed}<body style="margin:0"><h1>A site</h1><p>Some text.</p>`);
      return;
    }
    const overlay = req.url.startsWith('/overlay/');
    const url = new URL(overlay ? `lumio://overlay${req.url.slice(8)}` : `lumio://settings${req.url}`);
    const file = resolveFile(url, overlay ? new Set(['overlay']) : PAGE_HOSTS);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

const watchErrors = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
};

// The overlay's page with a stand-in main process (window.__sent records what it sends).
async function openOverlay({ colorScheme = 'dark', reducedMotion } = {}) {
  const page = await browser.newPage({ viewport: { width: 404, height: 240 }, colorScheme, reducedMotion });
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window.lumio = {
      invoke: async () => null,
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  });
  await page.goto(`${base}/overlay/`);
  return { page, errors };
}
const sentOn = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
// The overlay's steps (main/window.js): shown, then it comes in; again while open, new content.
const showBox = (page, name = 'Work') => page.evaluate((n) => {
  const p = { kind: 'namewindow', name: n, mac: true };
  if (window.__shownKind === p.kind) { window.__emit('overlay-data', p); return; }
  window.__shownKind = p.kind;
  window.__seq = (window.__seq || 0) + 1;
  window.__emit('overlay-data', { ...p, op: 'show', seq: window.__seq });
  window.__emit('overlay-data', { op: 'in', seq: window.__seq });
}, name);

test('Name window box: shows the name selected, Enter saves, Esc and Cancel close, clicking away keeps that click', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openOverlay();
  await showBox(page);
  await page.waitForSelector('#nw-name');
  assert.equal(await page.getAttribute('form.nw', 'role'), 'dialog');
  assert.equal(await page.textContent('#nw-title'), 'Name this window');
  assert.match(await page.textContent('#nw-hint'), /Window menu, Mission Control and the Dock/);
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['nw-name', 0, 4], 'focused, all selected');
  assert.equal(await page.getAttribute('#nw-name', 'maxlength'), '80');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:size'));
  const { height } = (await sentOn(page, 'overlay:size')).at(-1);
  assert.ok(height > 120 && height < 240, `fits what's in it (${height}px)`);

  await page.keyboard.type('Trip planning');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sentOn(page, 'window:name'), [{ name: 'Trip planning' }]);
  // Only one answer per box.
  await page.keyboard.press('Enter');
  assert.equal((await sentOn(page, 'window:name')).length, 1);

  await showBox(page, 'Trip planning');
  await page.keyboard.press('Escape');
  await showBox(page);
  await page.click('[data-nw=cancel]');
  await showBox(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.deepEqual((await sentOn(page, 'window:name')).slice(1), [{ cancel: true }, { cancel: true }, { cancel: true, blur: true }]);
  // Names are text, never markup.
  await showBox(page, '<img src=x onerror=alert(1)>"');
  assert.equal(await page.inputValue('#nw-name'), '<img src=x onerror=alert(1)>"');
  assert.equal(await page.$('#card img'), null);

  // Another popup takes the card: the box is gone and doesn't answer.
  await page.evaluate(() => { window.__shownKind = 'downloads'; window.__emit('overlay-data', { kind: 'downloads', items: [], op: 'show', seq: ++window.__seq }); });
  assert.equal(await page.$('#nw-name'), null);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await sentOn(page, 'window:name')).length, 4);
  await page.close();
  assert.deepEqual(errors, []);
});

for (const scheme of ['light', 'dark']) {
  test(`Name window box in ${scheme}: theme colors, readable text, and no motion when reduced`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    const { page, errors } = await openOverlay({ colorScheme: scheme, reducedMotion: 'reduce' });
    await showBox(page);
    await page.waitForSelector('#nw-name');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `name-window-${scheme}.png`) });
    const c = await readColors(page, { tokens: ['--text', '--dim'], parts: ['#card', '#nw-name'] });
    assert.ok(scheme === 'light' ? luminance(c.parts['#card']) > 0.7 : luminance(c.parts['#card']) < 0.06, `the box is ${scheme}`);
    assert.ok(contrast(c.tokens['--text'], c.parts['#nw-name']) >= 4.5, 'the name is readable');
    assert.ok(contrast(c.tokens['--dim'], c.parts['#card']) >= 4.5, 'the hint is readable');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('card')).animationName), 'none');
    await page.close();
    assert.deepEqual(errors, []);
  });
}

// The tab preload (preload/internal.js) in a website, with a stand-in for
// Electron: executeInMainWorld runs the function in the page, and what the
// preload sends to Lumio lands in window.__ipc.
async function openSite() {
  const page = await browser.newPage();
  const errors = watchErrors(page);
  await page.addInitScript({
    // (The preload also reads process.platform: batch 4's mouse buttons and swipes.)
    content: `(function (require, process) {\n${PRELOAD}\n})(() => ({
      contextBridge: { executeInMainWorld: ({ func, args }) => func(...args), exposeInMainWorld() {} },
      ipcRenderer: { send: (c, p) => (window.__ipc ||= []).push([c, p]), invoke: async () => null, on() {} },
    }), { platform: 'linux' });`,
  });
  await page.goto(`${base}/site/page`);
  return { page, errors };
}

test('the page shim: registerProtocolHandler checks what Chrome checks and hands the rest to Lumio', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openSite();
  const call = (fn, ...args) => page.evaluate(({ fn, args }) => {
    try { navigator[fn](...args); return 'ok'; } catch (e) { return `${e.name}: ${e.message}`; }
  }, { fn, args });
  assert.equal(await page.evaluate(() => navigator.registerProtocolHandler.length), 2);
  assert.equal(await call('registerProtocolHandler', 'MAILTO', '/compose?to=%s'), 'ok');
  assert.equal(await call('registerProtocolHandler', 'web+notes', `${base}/n?u=%s`), 'ok');
  assert.match(await call('registerProtocolHandler', 'http', '/x?%s'), /^SecurityError: .*allowlist/);
  assert.match(await call('registerProtocolHandler', 'mailto', '/compose'), /^SyntaxError: .*%s/);
  assert.match(await call('registerProtocolHandler', 'mailto', 'https://evil.example/?u=%s'), /^SecurityError: .*origin/);
  assert.match(await call('registerProtocolHandler', 'mailto'), /^TypeError: .*2 arguments required/);
  assert.equal(await call('unregisterProtocolHandler', 'mailto', '/compose?to=%s'), 'ok');
  assert.deepEqual(await page.evaluate(() => window.__ipc.filter(([c]) => c.startsWith('ph:'))), [
    ['ph:register', { scheme: 'mailto', url: `${base}/compose?to=%s` }],
    ['ph:register', { scheme: 'web+notes', url: `${base}/n?u=%s` }],
    ['ph:unregister', { scheme: 'mailto', url: `${base}/compose?to=%s` }],
  ]);
  await page.close();
  assert.deepEqual(errors, []);
});

// What Settings needs to load, besides the rows answered by power-user.js.
const SETTINGS = {
  'page:settings': {
    account: { signedIn: false }, profile: { name: 'Test', color: '#7ee2a8', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
    memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
    engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: false, appearance: 'system', verticalTabs: false,
    ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.4', update: null, isDefault: true, importSources: [], sitePermissions: [],
  },
  'page:account': { signedIn: false },
  'page:sync': { on: false, status: 'off', types: {}, requests: [] },
  'page:mac-permissions': { accessibility: true, screen: true },
  'page:schedules': { signedIn: false, tasks: [] },
  'page:workflows': { workflows: [] },
};

// Clicks a switch (its checkbox is drawn by the switch around it).
const flip = (page, sel) => page.$eval(sel, (el) => el.click());
const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

// Settings, answered by the real handlers power-user.js set up above.
async function openSettings({ colorScheme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme });
  const errors = watchErrors(page);
  const calls = [];
  await page.exposeFunction('__lumioInvoke', async (channel, args) => {
    calls.push([channel, ...args]);
    if (world.internal[channel]) return world.internal[channel]({ w: W }, ...args);
    return SETTINGS[channel] ?? null;
  });
  await page.addInitScript(() => { window.lumioPage = { invoke: (c, ...a) => window.__lumioInvoke(c, a), on: () => {} }; });
  await page.goto(`${base}/`);
  await page.waitForSelector('#handler-list .row');
  return { page, errors, calls };
}

test('Settings: caret browsing, force dark with Relaunch, and the protocol handlers list with Remove', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  powerStore.settings.protocolHandlers = [
    { scheme: 'mailto', url: 'https://mail.example/c?to=%s', origin: 'https://mail.example', host: 'mail.example', allowed: true },
    { scheme: 'webcal', url: 'https://cal.example/a?u=%s', origin: 'https://cal.example', host: 'cal.example', allowed: false },
    { scheme: 'web+notes', url: 'https://notes.example/n?u=%s', origin: 'https://notes.example', host: 'notes.example', allowed: true },
  ];
  const { page, errors, calls } = await openSettings();
  // Keyboard: the shortcuts page, and caret browsing with its key.
  assert.equal(await page.getAttribute('#keyboard a.btn', 'href'), '/shortcuts');
  assert.match(await page.textContent('#caret-key-note'), /Press F7 to turn it on or off/);
  assert.equal(await page.isChecked('#caret-browsing'), false);
  await flip(page, '#caret-browsing');
  assert.ok(await until(() => powerStore.settings.caretBrowsing === true));
  assert.deepEqual(calls.filter(([c]) => c === 'page:power-set').at(-1), ['page:power-set', 'caretBrowsing', true]);
  await flip(page, '#caret-browsing');
  assert.ok(await until(() => powerStore.settings.caretBrowsing === false));

  // Force dark: Relaunch shows while the setting and this run differ.
  assert.equal(await page.isVisible('#fd-relaunch'), false);
  assert.equal(await page.isVisible('#theme-forced'), false);
  assert.equal(await page.isDisabled('input[name=appearance][value=light]'), false);
  await flip(page, '#force-dark');
  await page.waitForSelector('#fd-relaunch', { state: 'visible' });
  await page.click('#fd-relaunch-btn');
  // (main/system.js answers page:relaunch for every Relaunch button: tests/settings-depth.test.mjs.)
  assert.ok(await until(() => calls.some(([c]) => c === 'page:relaunch')), 'asks to relaunch');
  await flip(page, '#force-dark');
  await page.waitForSelector('#fd-relaunch', { state: 'hidden' });

  // Protocol handlers: allowed first, then blocked; Remove keeps the keyboard in the list.
  const rows = () => page.$$eval('#handler-list .row', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(await rows(), [
    'mail.example Opens all email links Remove',
    'notes.example Opens all web+notes: links Remove',
    'cal.example Blocked from opening calendar links Remove',
  ]);
  assert.equal(await page.getAttribute('#handler-list .row [data-remove]', 'aria-label'), 'Remove mail.example for email links');
  await page.focus('#handler-list .row:nth-child(2) [data-remove]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#handler-list [data-remove]').length === 2);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove cal.example for calendar links', 'the next Remove has the keyboard');
  assert.deepEqual(powerStore.settings.protocolHandlers.map((h) => h.host), ['mail.example', 'cal.example']);
  await page.click('#handler-list [data-remove]');
  await page.click('#handler-list [data-remove]');
  await page.waitForFunction(() => /Gmail asks to open all email links/.test(document.getElementById('handler-list').textContent));
  await page.close();
  assert.deepEqual(errors, []);
});

test('Settings › Theme while force dark mode is in effect: the choice waits, and says why', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fd-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forceDarkPages: true }));
  forceDark.applyAtStartup({ getPath: () => dir, commandLine: commandLineStandIn() });
  powerStore.settings.forceDarkPages = false; // turned off since, not relaunched yet
  try {
    const { page, errors } = await openSettings();
    assert.equal(await page.isVisible('#theme-forced'), true);
    assert.deepEqual(await page.$$eval('input[name=appearance]', (rs) => rs.map((r) => r.disabled)), [true, true, true]);
    assert.equal(await page.isVisible('#fd-relaunch'), true, 'Relaunch puts the theme back');
    if (SHOTS) await (await page.$('#appearance')).screenshot({ path: path.join(SHOTS, 'settings-appearance-forced-dark.png') });
    await page.close();
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    forceDark.applyAtStartup({ getPath: () => dir, commandLine: commandLineStandIn() });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const scheme of ['light', 'dark']) {
  test(`Settings rows in ${scheme}: readable, including Blocked`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    powerStore.settings.protocolHandlers = [{ scheme: 'webcal', url: 'https://cal.example/a?u=%s', origin: 'https://cal.example', host: 'cal.example', allowed: false }];
    const { page, errors } = await openSettings({ colorScheme: scheme });
    const c = await readColors(page, { tokens: ['--danger-text'], parts: ['#handler-list'] });
    assert.ok(scheme === 'light' ? luminance(c.parts['#handler-list']) > 0.7 : luminance(c.parts['#handler-list']) < 0.06, `the list is ${scheme}`);
    assert.ok(contrast(c.tokens['--danger-text'], c.parts['#handler-list']) >= 4.5, 'Blocked is readable');
    if (SHOTS) {
      await page.$eval('#keyboard', (el) => el.scrollIntoView());
      await page.screenshot({ path: path.join(SHOTS, `settings-keyboard-${scheme}.png`) });
    }
    await page.close();
    assert.deepEqual(errors, []);
  });
}

// The color of one pixel of a screenshot (a 1×1 PNG: the first pixel needs
// no unfiltering, whatever the filter).
function pixel(png) {
  let at = 8;
  const idat = [];
  let type = 6;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    if (kind === 'IHDR') type = png[at + 8 + 9];
    if (kind === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.ok(type === 2 || type === 6, `an RGB(A) screenshot (${type})`);
  return [...raw.subarray(1, 4)];
}

test('force dark in Chromium: light websites are darkened, dark themes are kept, and a light Lumio would be darkened too', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  // The switches Lumio adds at startup when the setting is on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fd-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forceDarkPages: true }));
  const app = { getPath: () => dir, commandLine: commandLineStandIn() };
  forceDark.applyAtStartup(app);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  forceDark.applyAtStartup({ getPath: () => dir, commandLine: commandLineStandIn() }); // back to off for the other tests
  fs.rmSync(dir, { recursive: true, force: true });
  const { chromium } = require('playwright-core');
  const dark = await chromium.launch({ executablePath: CHROME, headless: true, args: Object.entries(app.commandLine.switches).map(([k, v]) => `--${k}=${v}`) });
  // The color in the page's bottom-right corner, as drawn.
  const corner = async (url, colorScheme, init) => {
    const page = await dark.newPage({ viewport: { width: 600, height: 400 }, colorScheme });
    if (init) await page.addInitScript(init);
    await page.goto(url);
    await page.waitForTimeout(100);
    const rgb = pixel(await page.screenshot({ clip: { x: 590, y: 390, width: 1, height: 1 } }));
    await page.close();
    return rgb;
  };
  const lumioPage = () => { window.lumioPage = { invoke: async () => null, on: () => {} }; };
  try {
    for (const scheme of ['light', 'dark']) {
      const site = await corner(`${base}/site/page`, scheme);
      assert.ok(luminance(site) < 0.1, `${scheme}: a white website is drawn dark (rgb ${site})`);
    }
    assert.deepEqual(await corner(`${base}/site/themed`, 'dark'), [32, 48, 64], 'a site’s own dark theme is used as it is');
    // Lumio is dark while it's on (main/theme.js): its pages show their own dark colors (--bg), untouched.
    assert.deepEqual(await corner(`${base}/shortcuts`, 'dark', lumioPage), [7, 7, 8]);
    // Why: had Lumio stayed light, Chromium would darken its pages and window as well.
    const light = await corner(`${base}/shortcuts`, 'light', lumioPage);
    assert.ok(luminance(light) < 0.1, `a light Lumio page gets darkened (rgb ${light})`);
  } finally {
    await dark.close();
  }
});
