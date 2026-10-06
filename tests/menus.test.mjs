// The menu bar laid out like Chrome's on the Mac (main/menu.js and
// main/menu-extras.js), the commands behind its new items
// (main/menu-commands.js), DevTools docking (main/devtools.js), Handoff and
// Look Up / Speech in the page's menu (main/mac-integration.js), and the new
// tab page an extension can replace (main/tabs.js). Electron is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require.cache[require.resolve('electron')] = {
  id: 'electron', loaded: true,
  exports: {
    Menu: { buildFromTemplate: (template) => ({ template }) },
    app: { getVersion: () => '0.6.7', getLocale: () => 'en-US', getPath: () => '/tmp', userAgentFallback: 'UA' },
    dialog: {},
  },
};

const { buildMenu, buildBrowserMenu } = require('../main/menu.js');
const extras = require('../main/menu-extras.js');
const { menuCommands } = require('../main/menu-commands.js');
const devtools = require('../main/devtools.js');
const { Handoff, contextMenuItems, BROWSING } = require('../main/mac-integration.js');
const { Help } = require('../main/help.js');
const { TabManager, NEWTAB } = require('../main/tabs.js');

const MAC = process.platform === 'darwin';

const settingsStore = (settings = {}) => ({ settings, setSetting(k, v) { this.settings[k] = v; } });

// ---------------------------------------------------------------- what the menus show
test('History lists recently visited pages; Bookmarks lists the bar; Profiles names you', () => {
  const history = [
    { url: 'https://old.example/', title: 'Old' },
    ...Array.from({ length: 14 }, (_, i) => ({ url: `https://site${i}.example/`, title: `Site ${i}` })),
    { url: 'lumio://settings/', title: 'Settings' },
    { url: 'https://site13.example/', title: 'Site 13 again' },
  ];
  const bookmarks = Array.from({ length: 45 }, (_, i) => ({ url: `https://b${i}.example/`, title: i === 0 ? '' : `B${i}` }));
  const store = { history: () => history, bookmarks: () => bookmarks, settings: { profile: { name: '' }, spellcheck: false } };
  const s = extras.state({ store, account: { state: () => ({ signedIn: true, name: 'Juan' }) }, devtoolsDock: 'bottom' });
  assert.equal(s.recentHistory.length, extras.RECENT);
  assert.equal(s.recentHistory[0].url, 'https://site13.example/', 'newest first');
  assert.equal(new Set(s.recentHistory.map((h) => h.url)).size, s.recentHistory.length, 'each page once');
  assert.ok(s.recentHistory.every((h) => h.url.startsWith('https:')), 'web pages only');
  assert.equal(s.bookmarkItems.length, extras.BOOKMARKS);
  assert.equal(s.bookmarkItems[0].title, 'https://b0.example/', 'untitled bookmarks show their address');
  assert.equal(s.profileName, 'Juan', 'the account name when the profile has none');
  assert.equal(s.spellcheck, false);
  assert.equal(s.devtoolsDock, 'bottom');

  const opened = [];
  const cmd = { openUrl: (url, e) => opened.push([url, e?.metaKey]) };
  const items = extras.historyItems(s, cmd);
  assert.equal(items[1].label, 'Recently Visited');
  items[2].click(null, null, { metaKey: true });
  assert.deepEqual(opened, [['https://site13.example/', true]]);
  assert.deepEqual(extras.historyItems({ recentHistory: [] }, cmd), []);
  const marks = extras.bookmarkItems({ bookmarkItems: [{ url: 'https://x.example/', title: 'x'.repeat(80) }] }, cmd);
  assert.equal(marks[1].label.length, 61, 'long titles are cut');
});

// Every command a menu item calls exists: main.js's cmd, plus the menu and
// Help commands it adds at startup.
function allCommands() {
  const src = fs.readFileSync(new URL('../main/main.js', import.meta.url), 'utf8');
  const block = /^const cmd = \{([\s\S]*?)^\};/m.exec(src)[1];
  const names = [...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  const fake = { tabs: null };
  const extra = menuCommands({ cur: () => null, store: settingsStore(), sessions: () => [], openUrl() {}, openInternal() {}, signedIn: () => false, signIn() {}, openAccountPage() {}, menuChanged() {} });
  const help = new Help({ account: { base: 'https://lumio.test', state: () => ({}) }, store: settingsStore(), current: () => fake, openUrl() {}, openInternal() {} }).commands();
  // main/navigation.js commands() (back/forward menus, Open File, Home…), added at startup too.
  const nav = fs.readFileSync(new URL('../main/navigation.js', import.meta.url), 'utf8');
  const navBlock = /^ {2}commands\(\) \{[\s\S]*?return \{([\s\S]*?)^ {4}\};/m.exec(nav)[1];
  const navNames = [...navBlock.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]);
  return new Set([...names, ...navNames, ...Object.keys(extra), ...Object.keys(help)]);
}

function walk(items, fn, trail = []) {
  for (const item of items || []) {
    fn(item, trail);
    if (Array.isArray(item.submenu)) walk(item.submenu, fn, [...trail, item.label || item.role]);
  }
}

test('the menu bar: every item does something, and the Mac gets Chrome’s menus', () => {
  const known = allCommands();
  const used = new Set();
  const cmd = new Proxy({}, { get: (_t, name) => { if (typeof name === 'string') used.add(name); return known.has(name) ? () => {} : undefined; } });
  const state = { recentHistory: [{ url: 'https://a.example/', title: 'A' }], bookmarkItems: [{ url: 'https://b.example/', title: 'B' }], devtoolsDock: 'right', spellcheck: true, extensionKeys: [{ id: 'ext-cmd:x:y', label: 'Command+Shift+Y', accelerator: 'Command+Shift+Y', visible: false, click() {} }] };
  const { template } = buildMenu(cmd, state);
  for (const name of used) assert.ok(known.has(name), `cmd.${name} exists`);
  walk(template, (item, trail) => {
    if (!item.role && item.type !== 'separator' && !item.submenu && item.enabled !== false && item.type !== 'radio' && item.type !== 'checkbox') {
      assert.equal(typeof item.click, 'function', `${[...trail, item.label].join(' › ')} does something`);
    }
  });
  const tops = template.map((m) => m.label || m.role);
  const find = (label) => template.find((m) => m.label === label);
  if (MAC) {
    assert.deepEqual(tops, ['Lumio Browser', 'File', 'Edit', 'View', 'History', 'Bookmarks', 'Profiles', 'Tab', 'Window', 'Help']);
    assert.equal(find('Window').role, 'window', 'the Mac lists the open windows');
    const edit = find('Edit').submenu.map((i) => i.label);
    assert.ok(['Spelling and Grammar', 'Substitutions', 'Speech'].every((l) => edit.includes(l)));
    const speech = find('Edit').submenu.find((i) => i.label === 'Speech').submenu.map((i) => i.role);
    assert.deepEqual(speech, ['startSpeaking', 'stopSpeaking']);
    assert.deepEqual(find('Tab').submenu.filter((i) => i.accelerator).map((i) => i.accelerator), ['Cmd+Alt+Right', 'Cmd+Alt+Left']);
  } else {
    assert.deepEqual(tops, ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Window', 'Help']);
  }
  const help = template.at(-1);
  assert.equal(help.role, 'help');
  assert.ok(help.submenu.some((i) => /Report an (I|i)ssue…/.test(i.label) && i.accelerator === 'Alt+Shift+I'));
  assert.ok(help.submenu.some((i) => i.label === 'Version Info'));
  const view = find('View').submenu;
  assert.ok(view.some((i) => i.label === 'Stop'));
  const dev = view.find((i) => i.label === 'Developer').submenu;
  assert.deepEqual(dev.filter((i) => i.type === 'radio').map((i) => [i.label, i.checked]), [['Dock to Right', true], ['Dock to Bottom', false], ['Undock into Separate Window', false]]);
  assert.ok(dev.some((i) => i.label === 'View Source' && i.accelerator === (MAC ? 'Cmd+Alt+U' : 'Ctrl+U')));
  assert.ok(find('History').submenu.some((i) => i.label === 'A'));
  assert.ok(find('Bookmarks').submenu.some((i) => i.label === 'B'));
  assert.ok(find('Window').submenu.some((i) => i.id === 'ext-cmd:x:y'), 'extension shortcuts are in the menu');

  // Accelerators are never used twice.
  const seen = new Map();
  walk(template, (item, trail) => {
    if (!item.accelerator) return;
    const k = item.accelerator.replace(/CmdOrCtrl|Cmd|Command/g, MAC ? 'Cmd' : 'Ctrl');
    assert.ok(!seen.has(k), `${k} is used by both ${seen.get(k)} and ${[...trail, item.label].join(' › ')}`);
    seen.set(k, [...trail, item.label].join(' › '));
  });

  // ⋮ › Help (batch 3's ⋮ menu: entries for the overlay, on every platform).
  const browser = buildBrowserMenu(cmd, {});
  const sub = browser.find((i) => i.label === 'Help').submenu.map((i) => i.label).filter(Boolean);
  assert.deepEqual(sub.slice(0, 1), ['About Lumio Browser']);
  assert.ok(sub.includes('Help center') && sub.includes('Report an issue…'));
});

test('Edit › Spelling and Grammar follows Lumio’s own setting', () => {
  const s = { spellcheck: false };
  const items = extras.editExtras(s, { toggleSpellcheck() {} });
  if (!MAC) { assert.deepEqual(items, []); return; }
  const spelling = items.find((i) => i.label === 'Spelling and Grammar').submenu[0];
  assert.equal(spelling.type, 'checkbox');
  assert.equal(spelling.checked, false);
});

// ---------------------------------------------------------------- the commands
function fakeWindow(urls) {
  const created = [];
  const closed = [];
  const tabs = urls.map((url, i) => ({ id: i + 1, url, pinned: i === 0 }));
  const w = {
    tabs: {
      tabs,
      active: tabs[1],
      wc: () => ({ getURL: () => tabs[1].url }),
      displayUrl: (t) => t.url,
      create: (url, opts) => created.push([url, opts]),
      close: (id) => closed.push(id),
      stop() { this.stopped = true; },
      toggleMute(id) { this.muted = id; },
    },
  };
  return { w, created, closed };
}

test('the new menu commands act on the window in front', () => {
  const { w, created, closed } = fakeWindow(['https://pinned.example/', 'https://site.example/page', 'https://other.example/', 'https://more.example/']);
  const store = settingsStore({});
  const sessions = [{ setSpellCheckerEnabled(on) { this.on = on; } }];
  const calls = [];
  const c = menuCommands({
    cur: () => w,
    store,
    sessions: () => sessions,
    openUrl: (...a) => calls.push(['openUrl', ...a]),
    openInternal: (u) => calls.push(['openInternal', u]),
    signedIn: () => false,
    signIn: (win) => calls.push(['signIn', win === w]),
    openAccountPage: (which) => calls.push(['account', which]),
    menuChanged: () => calls.push(['menuChanged']),
  });
  c.viewSource();
  c.newTabRight();
  c.duplicateTab();
  assert.deepEqual(created, [['view-source:https://site.example/page', { index: 2 }], [NEWTAB, { index: 2 }], ['https://site.example/page', { index: 2 }]]);
  c.stop();
  assert.equal(w.tabs.stopped, true);
  c.muteTab();
  assert.equal(w.tabs.muted, 2);
  c.closeOtherTabs();
  assert.deepEqual(closed, [3, 4], 'pinned tabs stay');
  c.toggleSpellcheck();
  assert.equal(store.settings.spellcheck, false);
  assert.equal(sessions[0].on, false);
  c.toggleSpellcheck();
  assert.equal(store.settings.spellcheck, true);
  c.openUrl('https://a.example/', { metaKey: true });
  c.openUrl('https://b.example/', {});
  c.customizeProfile();
  c.lumioAccount();
  assert.deepEqual(calls.filter(([k]) => k !== 'menuChanged'), [
    ['openUrl', 'https://a.example/', 'tab', w],
    ['openUrl', 'https://b.example/', 'current', w],
    ['openInternal', 'lumio://settings/#profile'],
    ['signIn', true],
  ]);
  assert.ok(calls.some(([k]) => k === 'menuChanged'), 'the checkmark updates');

  // Nothing to view the source of on Lumio's own pages.
  const { w: w2, created: c2 } = fakeWindow(['lumio://settings/', 'lumio://settings/']);
  menuCommands({ cur: () => w2, store, sessions: () => [], menuChanged() {} }).viewSource();
  assert.deepEqual(c2, []);
  menuCommands({ cur: () => null, store, sessions: () => [], menuChanged() {} }).viewSource();
});

// ---------------------------------------------------------------- DevTools
function fakeWc() {
  const wc = new EventEmitter();
  Object.assign(wc, {
    opened: false,
    modes: [],
    ran: [],
    isDestroyed: () => false,
    isDevToolsOpened: () => wc.opened,
    openDevTools({ mode }) { wc.opened = true; wc.modes.push(mode); wc.devToolsWebContents = { isLoading: () => false, executeJavaScript: async (js) => { wc.ran.push(js); } }; wc.emit('devtools-opened'); },
    closeDevTools() { wc.opened = false; },
  });
  return wc;
}

test('DevTools dock right by default, remember the last choice, and open on a panel', () => {
  const store = settingsStore({});
  const wc = fakeWc();
  devtools.open(wc, store);
  assert.deepEqual(wc.modes, ['right'], 'docked to the right, like Chrome');
  devtools.open(wc, store);
  assert.equal(wc.opened, false, 'the shortcut toggles them');

  devtools.setMode(store, wc, 'bottom');
  assert.equal(store.settings.devtoolsDock, 'bottom');
  assert.deepEqual(wc.modes, ['right'], 'closed DevTools just remember it');
  devtools.open(wc, store, 'console');
  assert.deepEqual(wc.modes, ['right', 'bottom']);
  assert.deepEqual(wc.ran, ['DevToolsAPI.showPanel("console")']);
  devtools.open(wc, store, 'inspect');
  assert.equal(wc.opened, true, 'a panel never closes them');
  assert.equal(wc.ran.at(-1), 'DevToolsAPI.enterInspectElementMode()');

  devtools.setMode(store, wc, 'undocked');
  assert.deepEqual(wc.modes, ['right', 'bottom', 'undocked'], 'open DevTools move now');
  devtools.setMode(store, wc, 'sideways');
  assert.equal(store.settings.devtoolsDock, 'undocked', 'unknown choices are ignored');
  assert.equal(devtools.mode(settingsStore({ devtoolsDock: 'nonsense' })), 'right');
  devtools.open(null, store);
});

// ---------------------------------------------------------------- macOS
function fakeApp() {
  const app = new EventEmitter();
  app.activities = [];
  app.setUserActivity = (type, info, url) => app.activities.push([type, url]);
  app.invalidateCurrentActivity = () => app.activities.push(['invalidated']);
  return app;
}
const win = (url, { incognito = false } = {}) => ({ closed: false, incognito, tabs: { active: { url }, displayUrl: (t) => t.url } });

test('Handoff offers the web page you are on, never incognito or Lumio’s pages', () => {
  const app = fakeApp();
  const h = new Handoff(app, { mac: true });
  h.update(win('https://example.com/a'));
  h.update(win('https://example.com/a'));
  h.update(win('https://example.com/b', { incognito: true }));
  h.update(win('https://example.com/c'));
  h.update(win('lumio://settings/'));
  h.update(null);
  assert.deepEqual(app.activities, [
    [BROWSING, 'https://example.com/a'],
    ['invalidated'],
    [BROWSING, 'https://example.com/c'],
    ['invalidated'],
  ]);

  const opened = [];
  h.listen((url) => opened.push(url));
  const ev = () => ({ preventDefault() { this.prevented = true; } });
  const e1 = ev();
  app.emit('continue-activity', e1, BROWSING, {}, { webpageURL: 'https://from-phone.example/' });
  const e2 = ev();
  app.emit('continue-activity', e2, BROWSING, {}, { webpageURL: 'javascript:alert(1)' });
  app.emit('continue-activity', ev(), 'com.other.activity', {}, { webpageURL: 'https://x.example/' });
  assert.deepEqual(opened, ['https://from-phone.example/']);
  assert.equal(e1.prevented, true);
  assert.equal(e2.prevented, undefined);

  const off = fakeApp();
  new Handoff(off, { mac: false }).update(win('https://example.com/'));
  assert.deepEqual(off.activities, [], 'Mac only');
});

test('Look Up and Speech in the page’s menu on the Mac, never twice', () => {
  let looked = false;
  const wc = { showDefinitionForSelection: () => { looked = true; } };
  const items = contextMenuItems(wc, { selectionText: '  a fairly long selection of words  ' }, [], { mac: true });
  assert.deepEqual(items.map((i) => i.label), ['Look Up “a fairly long selection…”', 'Speech']);
  items[0].click();
  assert.ok(looked);
  assert.deepEqual(items[1].submenu.map((i) => i.role), ['startSpeaking', 'stopSpeaking']);
  assert.deepEqual(contextMenuItems(wc, { selectionText: 'word' }, [{ label: 'Look Up “word”' }, { label: 'Speech', submenu: [] }], { mac: true }), [], 'the page tools added them already');
  assert.deepEqual(contextMenuItems(wc, { selectionText: '', isEditable: true }, [], { mac: true }).map((i) => i.label), ['Speech']);
  assert.deepEqual(contextMenuItems(wc, { selectionText: '' }, [], { mac: true }), []);
  assert.deepEqual(contextMenuItems(wc, { selectionText: 'word' }, [], { mac: false }), []);
});

// ---------------------------------------------------------------- an extension's new tab page
test('an extension’s new tab page: new tabs open it, the address bar stays empty, sessions keep Lumio’s', async () => {
  const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/tab.html';
  let override = EXT;
  const tm = new TabManager({
    win: null,
    session: null,
    store: { settings: {}, isBookmarked: () => false },
    emit() {},
    hooks: { newTabUrl: () => override, isNewTabUrl: (u) => u.split(/[?#]/)[0] === EXT },
  });
  tm.activeId = -1; // nothing to show; these tabs stay lazy
  const a = tm.create(NEWTAB, { lazy: true, active: false });
  const b = tm.create('https://example.com/', { lazy: true, active: false });
  override = null;
  const c = tm.create(NEWTAB, { lazy: true, active: false });
  assert.equal(a.url, EXT);
  assert.equal(a.title, 'New Tab');
  assert.equal(c.url, NEWTAB, 'without an override, Lumio’s own');
  assert.equal(tm.displayUrl(a), '');
  assert.equal(tm.displayUrl(b), 'https://example.com/');
  assert.deepEqual(tm.sessionTabs().map((t) => t.url), [NEWTAB, 'https://example.com/', NEWTAB]);
  await new Promise((r) => setImmediate(r));
});
