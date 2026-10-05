// The tab strip's work in the main process: the tab menu and the strip's own
// menu, several tabs at once, moving tabs between windows (main/tab-strip.js),
// pulling tabs out into a window and onto another (main/tab-drag.js), tab
// search (main/tab-search.js), Mute site (main/site-mute.js), drops, and the
// Dock (main/os-integration.js); plus the shell's arithmetic
// (renderer/ui/strip-math.mjs) and tab search's fuzzy matching
// (renderer/ui/fuzzy.mjs). Real TabManagers on a stand-in Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeStore, makeWindow, browse, settle, popups, dock, app, FakeWebContents } from './fake-tabs.mjs';
import { dropTarget, insertIndex, markerX, rangeIds, toggleId, pulledOut, DETACH } from '../renderer/ui/strip-math.mjs';
import { fuzzyMatch, fuzzySearch, highlight } from '../renderer/ui/fuzzy.mjs';

const require = createRequire(import.meta.url);
const { TabStrip, tabMenuTemplate, windowLabel, droppable } = require('../main/tab-strip.js');
const { TabDrag } = require('../main/tab-drag.js');
const { TabSearch, iconOf } = require('../main/tab-search.js');
const { SiteMute, originOf } = require('../main/site-mute.js');
const { OsIntegration, overallProgress, badgeText } = require('../main/os-integration.js');

// One test's browser: windows, Recently Closed, and the strip's helpers.
function browser() {
  const world = { store: makeStore(), windows: [], closed: [] };
  const recentlyClosed = [];
  world.onTabClosed = (w, entry) => (w.incognito ? w.closedTabs : recentlyClosed).push({ kind: 'tab', ...entry });
  const siteMute = new SiteMute(world.store);
  const calls = { reopen: 0, bookmarkAll: 0, removed: [] };
  const strip = new TabStrip({
    alive: () => world.windows.filter((w) => !w.closed),
    recentlyClosed,
    createWindow: (opts) => makeWindow(world, opts),
    reopenClosed: () => calls.reopen++,
    bookmarkAllTabs: () => calls.bookmarkAll++,
    removeExtensionTab: (wc) => calls.removed.push(wc.id),
    siteMute,
  });
  world.onViewCreated = (w, tab) => strip.onViewCreated(w, tab);
  const open = (urls, opts = {}) => makeWindow(world, { urls, ...opts });
  return { world, strip, siteMute, recentlyClosed, calls, open };
}
const urlsOf = (w) => w.tabs.tabs.map((t) => w.tabs.displayUrl(t));
const lastMenu = () => popups.at(-1).items;
const item = (items, label) => items.find((i) => i.label === label);

test('the tab menu has Chrome’s items, and says Tabs and Sites when several are selected', () => {
  const ctx = { many: false, pinned: false, siteMuted: false, canNewWindow: true, windows: [], othersClosable: true, rightClosable: false, closedCount: 0 };
  const labels = (c) => tabMenuTemplate(c, () => {}).map((i) => i.label || '—');
  assert.deepEqual(labels(ctx), ['New Tab to the Right', 'Move Tab to New Window', '—', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Site', '—', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', '—', 'Reopen Closed Tab', 'Bookmark All Tabs']);
  const many = tabMenuTemplate({ ...ctx, many: true, pinned: true, siteMuted: true, windows: [{ id: 7, label: 'News and 2 more tabs' }] }, () => {});
  assert.deepEqual(many.map((i) => i.label).filter(Boolean).slice(0, 7), ['New Tab to the Right', 'Move Tabs to Another Window', 'Reload', 'Duplicate', 'Unpin Tabs', 'Unmute Sites', 'Close Tabs']);
  assert.deepEqual(many[1].submenu.map((i) => i.label || '—'), ['New Window', '—', 'News and 2 more tabs']);
  const off = tabMenuTemplate(ctx, () => {});
  assert.equal(item(off, 'Close Tabs to the Right').enabled, false);
  assert.equal(item(off, 'Reopen Closed Tab').enabled, false);
  assert.equal(item(off, 'Close Tab').registerAccelerator, false, 'shows ⌘W without taking it');
});

test('the menu acts on the right-clicked tab, or on every selected tab when it’s one of them', async () => {
  const { strip, open, calls } = browser();
  const w = open(['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/']);
  const [a, b, c, d] = w.tabs.tabs;
  strip.setSelection(w, [b.id, c.id, 999]);
  assert.deepEqual(w.tabSelection, [b.id, c.id], 'tabs that aren’t there are dropped');
  assert.deepEqual(strip.targets(w, c.id), [b.id, c.id]);
  assert.deepEqual(strip.targets(w, d.id), [d.id], 'not one of them: just it');

  strip.tabMenu(w, { id: c.id });
  item(lastMenu(), 'Pin Tabs').click();
  assert.deepEqual(w.tabs.tabs.map((t) => [t.id, !!t.pinned]), [[b.id, true], [c.id, true], [a.id, false], [d.id, false]], 'pinned in order, at the front');
  strip.tabMenu(w, { id: b.id });
  item(lastMenu(), 'Unpin Tabs').click();
  assert.deepEqual(w.tabs.tabs.map((t) => t.id), [b.id, c.id, a.id, d.id]);
  assert.equal(w.tabs.tabs.some((t) => t.pinned), false);

  // Close other tabs / to the right leave pinned tabs alone, like Chrome.
  w.tabs.setPinned(d.id, true);
  strip.setSelection(w, [a.id]);
  strip.tabMenu(w, { id: b.id });
  assert.equal(item(lastMenu(), 'Close Tabs to the Right').enabled, true);
  item(lastMenu(), 'Close Other Tabs').click();
  assert.deepEqual(w.tabs.tabs.map((t) => t.id), [d.id, b.id]);

  strip.tabMenu(w, { id: b.id });
  item(lastMenu(), 'New Tab to the Right').click();
  assert.equal(w.tabs.tabs[2].url, 'lumio://newtab/');
  item(lastMenu(), 'Bookmark All Tabs').click();
  item(lastMenu(), 'Reopen Closed Tab').click();
  assert.deepEqual([calls.bookmarkAll, calls.reopen], [1, 1]);
  strip.tabMenu(w, { id: b.id });
  item(lastMenu(), 'Reload').click();
  assert.equal(b.view.webContents.reloads, 1);

  // ⌘W closes the selected tabs.
  w.tabs.activate(b.id);
  const e = w.tabs.create('https://e.example/', { active: false });
  strip.setSelection(w, [b.id, e.id]);
  strip.closeSelected(w);
  assert.deepEqual(urlsOf(w), ['https://d.example/', '']);
  await settle();

  // The strip's own menu.
  strip.stripMenu(w);
  assert.deepEqual(lastMenu().map((i) => i.label), ['New Tab', 'Reopen Closed Tab', 'Bookmark All Tabs']);
  item(lastMenu(), 'New Tab').click();
  assert.equal(w.tabs.tabs.length, 3);
});

test('Move tab to another window lists the windows; pages move without reloading, and an emptied window closes', () => {
  const { strip, open, world, calls } = browser();
  const one = open(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  const two = open(['https://news.example/']);
  two.tabs.tabs[0].title = 'News & weather';
  makeWindow(world, { incognito: true, urls: ['https://secret.example/'] });
  const [a, b, c] = one.tabs.tabs;
  const page = b.view.webContents;
  strip.setSelection(one, [b.id, c.id]);
  strip.tabMenu(one, { id: b.id });
  const move = item(lastMenu(), 'Move Tabs to Another Window');
  assert.deepEqual(move.submenu.map((i) => i.label || '—'), ['New Window', '—', process.platform === 'darwin' ? 'News & weather' : 'News && weather'], 'not the incognito window');
  move.submenu[2].click();
  assert.deepEqual(urlsOf(two), ['https://news.example/', 'https://b.example/', 'https://c.example/']);
  assert.equal(two.tabs.activeId, c.id, 'the last one moved is shown');
  assert.equal(b.view.webContents, page, 'the same page');
  assert.equal(b.owner, two.tabs);
  assert.deepEqual(calls.removed, [page.id, c.view.webContents.id]);
  assert.ok(two.focused > 0);
  two.tabs.activate(two.tabs.tabs[0].id); // the label is the tab you're on there
  assert.equal(windowLabel(two), process.platform === 'darwin' ? 'News & weather and 2 more tabs' : 'News && weather and 2 more tabs');

  // Into a new window of their own: never a window's every tab.
  assert.equal(strip.moveToNewWindow(one, [a.id]), null);
  const fresh = strip.moveToNewWindow(two, [b.id, c.id]);
  assert.deepEqual(urlsOf(fresh), ['https://b.example/', 'https://c.example/']);
  assert.equal(fresh.tabs.activeId, b.id, 'the first one moved (the tab you were on stayed)');
  // A window left without tabs closes.
  strip.moveTabs(one, [a.id], fresh, { index: 0 });
  assert.equal(one.closed, true);
  assert.deepEqual(urlsOf(fresh), ['https://a.example/', 'https://b.example/', 'https://c.example/']);
  assert.equal(strip.moveTabs(fresh, [a.id], world.windows.find((w) => w.incognito)), null, 'never between normal and incognito');
});

test('several selected tabs dragged together land as a block', () => {
  const { strip, open } = browser();
  const w = open(['https://1.example/', 'https://2.example/', 'https://3.example/', 'https://4.example/', 'https://5.example/']);
  const handlers = {};
  strip.register({ on: (c, fn) => { handlers[c] = fn; }, internalHandle: () => {} });
  const [one, two, , four] = w.tabs.tabs;
  handlers['tab:move-many'](w, { ids: [one.id, four.id], before: 2 }); // after 2 and 3
  assert.deepEqual(urlsOf(w).map((u) => u[8]), ['2', '3', '1', '4', '5']);
  handlers['tab:move-many'](w, { ids: [two.id], before: -1 }); // nonsense: ignored
  assert.deepEqual(urlsOf(w).map((u) => u[8]), ['2', '3', '1', '4', '5']);
});

test('Mute site mutes every tab of that site, now and later, in every window, and Settings can unmute it', () => {
  const { strip, open, siteMute, world } = browser();
  const w = open(['https://music.example/a', 'https://music.example/b', 'https://other.example/']);
  const w2 = open(['https://music.example/c']);
  const [a, b, other] = w.tabs.tabs;
  strip.tabMenu(w, { id: a.id });
  assert.equal(item(lastMenu(), 'Mute Site').label, 'Mute Site');
  item(lastMenu(), 'Mute Site').click();
  assert.deepEqual([a, b, other, w2.tabs.tabs[0]].map((t) => t.view.webContents.audioMuted), [true, true, false, true]);
  assert.deepEqual(world.store.settings.mutedSites, ['https://music.example']);
  // A new tab of that site starts muted; leaving the site unmutes it.
  const later = w.tabs.create('https://music.example/d');
  assert.equal(later.view.webContents.audioMuted, true);
  later.view.webContents.loadURL('https://quiet.example/');
  assert.equal(later.view.webContents.audioMuted, false);
  // The speaker on a tab still mutes just that tab, and the site leaves it alone.
  w.tabs.toggleMute(other.id);
  strip.tabMenu(w, { id: b.id });
  item(lastMenu(), 'Unmute Site').click();
  assert.deepEqual([a, b, other].map((t) => t.view.webContents.audioMuted), [false, false, true]);
  // Settings › Muted sites.
  const pages = {};
  strip.register({ on: () => {}, internalHandle: (c, hosts, fn) => { pages[c] = { hosts, fn }; } });
  strip.muteSites(w, [a.id]);
  assert.deepEqual(pages['page:muted-sites'].fn(), ['https://music.example']);
  assert.deepEqual(pages['page:unmute-site'].hosts, ['settings']);
  assert.deepEqual(pages['page:unmute-site'].fn({}, 'https://music.example'), []);
  assert.equal(a.view.webContents.audioMuted, false);
  // Incognito keeps its own changes and never writes them down.
  const inc = makeWindow(world, { incognito: true, urls: ['https://loud.example/'] });
  strip.muteSites(inc, [inc.tabs.tabs[0].id]);
  assert.equal(inc.tabs.tabs[0].view.webContents.audioMuted, true);
  assert.deepEqual(siteMute.list(), []);
  siteMute.forgetIncognito();
  assert.equal(siteMute.isMuted('https://loud.example', true), false);
  assert.equal(originOf('lumio://settings/'), null);
  assert.equal(originOf('https://a.example:8080/x'), 'https://a.example:8080');
});

test('drops on the strip: on a tab it opens there, between tabs a new tab; text searches; files open; nothing unsafe', () => {
  const { strip, open } = browser();
  const w = open(['https://a.example/', 'https://b.example/']);
  const [a] = w.tabs.tabs;
  strip.drop(w, { url: 'https://dropped.example/', on: a.id, index: 0 });
  assert.deepEqual(urlsOf(w), ['https://dropped.example/', 'https://b.example/']);
  strip.drop(w, { url: '', text: 'best pizza near me', on: null, index: 1 });
  assert.equal(urlsOf(w)[1], 'https://www.google.com/search?q=best%20pizza%20near%20me');
  assert.equal(w.tabs.active.id, w.tabs.tabs[1].id, 'the new tab shows');
  strip.drop(w, { text: 'example.org', index: 99 });
  assert.equal(urlsOf(w).at(-1), 'https://example.org/');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-drop-'));
  const file = path.join(dir, 'notes page.html');
  fs.writeFileSync(file, '<p>hi');
  const before = w.tabs.tabs.length;
  strip.drop(w, { files: [file, dir, 'relative.html', path.join(dir, 'missing.html')], index: 0 });
  assert.equal(w.tabs.tabs.length, before + 1, 'only the real file');
  assert.equal(urlsOf(w)[0], pathToFileURL(file).href);
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'lumio://settings/', 'chrome://settings', 'mailto:a@b.example']) {
    const n = w.tabs.tabs.length;
    const got = strip.drop(w, { url: bad, index: 0 });
    assert.ok(got.every((u) => /^https:\/\/www\.google\.com\/search/.test(u)), `${bad}: ${got}`);
    assert.ok(w.tabs.tabs.length <= n + 1);
  }
  assert.equal(droppable('lumio://history/'), false);
  assert.equal(droppable('view-source:https://a.example/'), true);
});

test('pulling tabs out makes a window under the pointer; over another strip they join it there; Esc puts them back', () => {
  const { strip, open, world } = browser();
  const src = open(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  const other = open(['https://x.example/', 'https://y.example/'], { bounds: { x: 1300, y: 100, width: 900, height: 600 } });
  other.stripRect = { x: 0, y: 0, width: 900, height: 40 };
  const drag = new TabDrag({ alive: () => world.windows.filter((w) => !w.closed), cur: () => src, strip });
  const [, b] = src.tabs.tabs;
  const page = b.view.webContents;
  // Out of the strip at (500, 300) on screen, held 30 px into the tab and 20 down.
  const win = drag.start(src, { ids: [b.id], screenX: 500, screenY: 300, grabX: 110, grabY: 20 });
  assert.notEqual(win, src);
  assert.deepEqual(urlsOf(win), ['https://b.example/']);
  assert.equal(win.tabs.tabs[0].view.webContents, page, 'the page keeps running');
  assert.deepEqual([win.win.bounds.x, win.win.bounds.y], [390, 280], 'under the pointer');
  drag.move({ screenX: 600, screenY: 350 });
  assert.deepEqual([win.win.bounds.x, win.win.bounds.y], [490, 330]);
  // Over the other window's strip: it shows where, and says which spot.
  drag.move({ screenX: 1300 + 450, screenY: 100 + 20 });
  assert.deepEqual(other.emitted.at(-1), ['tab-drag-hint', { x: 450, count: 1 }]);
  assert.equal(win.win.opacity, 0.6);
  drag.setIndex(other, 1);
  drag.end({ screenX: 1300 + 450, screenY: 100 + 20 });
  assert.deepEqual(urlsOf(other), ['https://x.example/', 'https://b.example/', 'https://y.example/']);
  assert.equal(other.tabs.active.view.webContents, page);
  assert.equal(win.closed, true, 'the dragged window went away');
  assert.deepEqual(other.emitted.at(-1), ['tab-drag-hint', null]);

  // Let go anywhere else: it stays a window, shown and focused.
  const c = src.tabs.tabs.find((t) => t.url === 'https://c.example/');
  const alone = drag.start(src, { ids: [c.id], screenX: 200, screenY: 600, grabX: 100, grabY: 20 });
  drag.end({ screenX: 220, screenY: 640 });
  assert.equal(alone.win.shown, true);
  assert.ok(alone.focused > 0);
  assert.deepEqual(urlsOf(alone), ['https://c.example/']);

  // Esc: back where it came from.
  const x = other.tabs.tabs[0];
  const back = drag.start(other, { ids: [x.id], screenX: 100, screenY: 100, grabX: 10, grabY: 10 });
  drag.cancel();
  assert.equal(back.closed, true);
  assert.deepEqual(urlsOf(other), ['https://x.example/', 'https://b.example/', 'https://y.example/']);

  // A window's only tab drags the window itself.
  const before = world.windows.length;
  assert.equal(drag.start(alone, { ids: [alone.tabs.tabs[0].id], screenX: 300, screenY: 300, grabX: 50, grabY: 15 }), alone);
  assert.equal(world.windows.length, before);
  drag.move({ screenX: 400, screenY: 320 });
  assert.deepEqual([alone.win.bounds.x, alone.win.bounds.y], [350, 305]);
  drag.end({});
  // Bad messages are ignored.
  assert.equal(drag.start(src, { ids: 'all', screenX: 1, screenY: 1, grabX: 1, grabY: 1 }), null);
  assert.equal(drag.start(src, { ids: [12345], screenX: 1, screenY: 1, grabX: 1, grabY: 1 }), null);
  assert.equal(drag.start(src, { ids: [src.tabs.tabs[0].id], screenX: NaN, screenY: 1, grabX: 1, grabY: 1 }), null);
  // A drag that never got its end (its window's UI reloaded) doesn't block the next one.
  const stuck = drag.start(other, { ids: [other.tabs.tabs[1].id], screenX: 500, screenY: 500, grabX: 10, grabY: 10 });
  const next = drag.start(other, { ids: [other.tabs.tabs[0].id], screenX: 700, screenY: 500, grabX: 10, grabY: 10 });
  assert.ok(next && next !== other, 'a new drag starts');
  assert.equal(stuck.win.shown, true, 'the stuck one ended where it was');
  drag.end({});
});

test('tab search lists every window’s tabs (the one you’re on first) and Recently Closed, switches, closes and reopens', () => {
  const { open, world, recentlyClosed } = browser();
  const w = open(['https://a.example/', 'https://b.example/']);
  const other = open(['https://news.example/']);
  const inc = makeWindow(world, { incognito: true, urls: ['https://private.example/'] });
  w.tabs.tabs[1].favicon = 'https://b.example/favicon.ico';
  inc.tabs.tabs[0].favicon = 'https://private.example/favicon.ico';
  other.tabs.tabs[0].lastActive = Date.now() + 1000;
  let reopened = null;
  const search = new TabSearch({ alive: () => world.windows.filter((x) => !x.closed), recentlyClosed, reopenClosed: (i) => { reopened = i; } });
  w.tabs.close(w.tabs.tabs[1].id);
  w.tabs.create('https://b.example/');
  recentlyClosed.push({ kind: 'window', tabs: [{ url: 'https://one.example/' }, { url: 'https://two.example/' }], title: 'One', time: 5 });

  const data = search.data(w);
  assert.equal(data.tabs[0].current, true, 'the tab you’re on first');
  assert.deepEqual(data.tabs.map((t) => t.host), ['b.example', 'news.example', 'a.example']);
  assert.deepEqual(data.closed.map((c) => [c.kind, c.title, c.host]), [['window', '2 tabs', 'one.example, two.example'], ['tab', 'Title of https://b.example/', 'b.example']].map(([k, t, h]) => [k, k === 'tab' ? data.closed[1].title : t, h]));
  assert.equal(data.closed[0].index, 1, 'its place in Recently Closed');
  // Incognito sees only incognito, and fetches no icons.
  const priv = search.data(inc);
  assert.deepEqual(priv.tabs.map((t) => t.host), ['private.example']);
  assert.equal(priv.tabs[0].favicon, null);
  assert.equal(iconOf('data:image/png;base64,AA', true), 'data:image/png;base64,AA');
  assert.equal(iconOf('javascript:x', false), null);

  // Enter: that tab, in its window.
  assert.equal(search.open(w, { windowId: other.id, tabId: other.tabs.tabs[0].id }), true);
  assert.ok(other.focused > 0);
  assert.equal(search.open(w, { windowId: inc.id, tabId: inc.tabs.tabs[0].id }), false, 'not across normal and incognito');
  search.reopen(w, 1);
  assert.equal(reopened, 1);

  // Closing from the list keeps it open, updated, even for the tab you're on.
  w.showOverlay({ x: 1, y: 2, width: 300, height: 400 }, { kind: 'tabsearch' });
  search.close(w, { windowId: w.id, tabId: w.tabs.activeId });
  assert.equal(w.overlayKind, 'tabsearch');
  assert.equal(w.overlayData.update, true);
  assert.deepEqual(w.overlayData.tabs.map((t) => t.host), ['a.example', 'news.example']);
  assert.equal(w.overlay.webContents.focused, true, 'it keeps the keyboard');
  // Incognito's own closed tabs.
  inc.tabs.create('https://p2.example/');
  inc.tabs.close(inc.tabs.tabs[0].id);
  assert.deepEqual(search.data(inc).closed.map((c) => c.host), ['private.example']);
  search.reopen(inc, 0);
  assert.equal(urlsOf(inc).includes('https://private.example/'), true);
});

test('tab search closes when it loses the keyboard', async () => {
  const { open, world, recentlyClosed } = browser();
  const w = open(['https://a.example/']);
  const search = new TabSearch({ alive: () => world.windows, recentlyClosed, reopenClosed: () => {} });
  const handlers = {};
  search.register({ handle: (c, fn) => { handlers[`h:${c}`] = fn; }, on: (c, fn) => { handlers[c] = fn; } });
  w.showOverlay({ x: 0, y: 0, width: 10, height: 10 }, { kind: 'tabsearch' });
  handlers['overlay:show'](w, { payload: { kind: 'tabsearch' } });
  assert.equal(w.overlay.webContents.focused, true, 'typing searches');
  w.overlay.webContents.focused = false;
  w.overlay.webContents.emit('blur');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.overlayKind, null);
  assert.ok(w.emitted.some(([c, p]) => c === 'overlay-picked' && p.kind === 'tabsearch'), 'the shell hears it closed');
  // Esc goes back to where you were.
  handlers['overlay:pick'](w, { kind: 'tabsearch', refocus: 'page' });
  assert.equal(w.tabs.active.view.webContents.focused, true);
  handlers['overlay:pick'](w, { kind: 'tabsearch', refocus: 'shell' });
  assert.equal(w.win.webContents.focused, true);
});

test('the Dock: New Window and New Incognito Window, download progress, and a count of finished downloads until you look', () => {
  assert.deepEqual(overallProgress([]), { progress: -1, mode: 'none' });
  assert.deepEqual(overallProgress([{ state: 'progressing', total: 100, received: 25 }, { state: 'progressing', total: 300, received: 75 }]), { progress: 0.25, mode: 'normal' });
  assert.deepEqual(overallProgress([{ state: 'progressing', total: 0, received: 5 }]), { progress: 2, mode: 'indeterminate' });
  assert.deepEqual(overallProgress([{ state: 'progressing', total: 10, received: 50, paused: true }]), { progress: 1, mode: 'paused' });
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(3), '3');

  const { open, world } = browser();
  const w = open(['https://a.example/']);
  const opened = [];
  const handlers = {};
  const osi = new OsIntegration({ cmd: { newWindow: () => opened.push('window'), newIncognito: () => opened.push('incognito') }, alive: () => world.windows });
  osi.register({ on: (c, fn) => { handlers[c] = fn; } });
  osi.start();
  if (process.platform === 'darwin') {
    assert.deepEqual(dock.menu.items.map((i) => i.label), ['New Window', 'New Incognito Window']);
    dock.menu.items.forEach((i) => i.click());
    assert.deepEqual(opened, ['window', 'incognito']);
  }
  // A download in any profile.
  const ses = new FakeWebContents();
  app.emit('session-created', ses);
  const item = Object.assign(new FakeWebContents(), { total: 200, got: 50, getTotalBytes() { return this.total; }, getReceivedBytes() { return this.got; }, isPaused: () => false });
  ses.emit('will-download', {}, item);
  assert.deepEqual(w.win.progress.at(-1), [0.25, 'normal']);
  item.emit('done', {}, 'completed');
  assert.deepEqual(w.win.progress.at(-1), [-1, null]);
  const second = Object.assign(new FakeWebContents(), { getTotalBytes: () => 1, getReceivedBytes: () => 1, isPaused: () => false });
  ses.emit('will-download', {}, second);
  second.emit('done', {}, 'cancelled');
  if (process.platform === 'darwin') assert.equal(dock.badge, '1', 'only finished ones count');
  // Opening the downloads list (or the Downloads page) counts as looking.
  handlers['overlay:show'](w, { payload: { kind: 'downloads' } });
  if (process.platform === 'darwin') assert.equal(dock.badge, '');
  assert.equal(osi.finished, 0);
  const page = new FakeWebContents();
  app.emit('web-contents-created', {}, page);
  osi.finished = 2;
  page.emit('did-navigate', {}, 'lumio://downloads/');
  assert.equal(osi.finished, 0);
});

test('the strip’s arithmetic: where drops land, ranges, toggles, pulling out', () => {
  const rects = [{ left: 0, right: 100 }, { left: 102, right: 202 }, { left: 204, right: 304 }];
  assert.deepEqual(dropTarget(rects, 10), { index: 0, on: null }, 'the edge of a tab: before it');
  assert.deepEqual(dropTarget(rects, 50), { index: 0, on: 0 }, 'its middle: onto it');
  assert.deepEqual(dropTarget(rects, 190), { index: 2, on: null });
  assert.deepEqual(dropTarget(rects, 400), { index: 3, on: null });
  assert.equal(insertIndex(rects, 160), 2);
  assert.equal(insertIndex(rects, -5), 0);
  assert.equal(markerX(rects, { index: 1, on: null }), 101);
  assert.equal(markerX(rects, { index: 0, on: 0 }), 50);
  assert.equal(markerX(rects, { index: 3, on: null }), 304);
  assert.equal(markerX([], { index: 0, on: null }), null);
  assert.deepEqual(rangeIds([1, 2, 3, 4, 5], 4, 2), [2, 3, 4]);
  assert.deepEqual(rangeIds([1, 2, 3], 9, 2), [2], 'no anchor: just it');
  assert.deepEqual(toggleId([1, 2, 3, 4], [2], 4, 2), { selected: [2, 4], active: 4 });
  assert.deepEqual(toggleId([1, 2, 3, 4], [2, 3, 4], 3, 2), { selected: [2, 4], active: 2 });
  assert.deepEqual(toggleId([1, 2, 3, 4], [1, 3, 4], 3, 3), { selected: [1, 4], active: 4 }, 'the one you were on: the nearest shows');
  assert.deepEqual(toggleId([1, 2], [2], 2, 2), { selected: [2], active: 2 }, 'never the last one');
  const strip = { top: 0, bottom: 40 };
  assert.equal(pulledOut({ x: 50, y: 40 + DETACH }, strip, { width: 800 }), false);
  assert.equal(pulledOut({ x: 50, y: 41 + DETACH }, strip, { width: 800 }), true);
  assert.equal(pulledOut({ x: 800 + DETACH + 1, y: 20 }, strip, { width: 800 }), true);
});

test('tab search’s fuzzy matching: runs and word starts first, matches marked safely', () => {
  assert.deepEqual(fuzzyMatch('tube', 'YouTube').marks, [3, 4, 5, 6]);
  assert.deepEqual(fuzzyMatch('ytb', 'YouTube').marks, [0, 3, 5]);
  assert.equal(fuzzyMatch('xyz', 'YouTube'), null);
  assert.deepEqual(fuzzyMatch('', 'x'), { score: 0, marks: [] });
  const items = [{ title: 'Pull requests · lumio', host: 'github.com' }, { title: 'Gmail', host: 'mail.google.com' }, { title: 'Maps', host: 'maps.google.com' }];
  assert.deepEqual(fuzzySearch(items, 'gm', [['title', 1], ['host', 0.9]]).map((r) => r.item.title)[0], 'Gmail', 'a run beats scattered letters');
  assert.deepEqual(fuzzySearch(items, 'pull', [['title', 1], ['host', 0.9]]).map((r) => r.item.title), ['Pull requests · lumio']);
  assert.deepEqual(fuzzySearch(items, 'maps', [['title', 1], ['host', 0.9]])[0].marks, { title: [0, 1, 2, 3], host: [0, 1, 2, 3] });
  assert.deepEqual(fuzzySearch(items, ' ', [['title', 1]]).length, 3, 'nothing typed: everything, in order');
  assert.equal(highlight('<a>&😀b', [1, 6]), '&lt;<mark>a</mark>&gt;&amp;😀<mark>b</mark>', 'an emoji counts as two');
});
