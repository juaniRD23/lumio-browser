// Menus and popovers: how main/window.js shows and hides the overlay view
// (in steps, so nothing old flashes and every opening animates), the ⋮
// menu's entries (main/menu.js), and that the window's UI is allowed the
// channels it uses (preload/shell.js). The overlay page and the window's UI
// themselves are tested in headless Chrome in tests/popovers-ui.test.mjs.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BrowserWin } = require('../main/window.js');
const { buildBrowserMenu, menuModel, accelLabel } = require('../main/menu.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A window with just what the overlay code uses: the views on it, what's
// sent to the overlay and to the window's UI, and who has the keyboard.
function fakeWindow({ focused = 'shell' } = {}) {
  const views = [];
  const toOverlay = [];
  const toShell = [];
  const has = { focus: focused };
  const wc = (name, sent) => ({ send: (channel, payload) => sent?.push([channel, payload]), focus: () => { has.focus = name; }, isFocused: () => has.focus === name });
  const overlay = { webContents: wc('overlay', toOverlay), bounds: null, setBounds(b) { this.bounds = { ...b }; }, getBounds() { return { ...this.bounds }; } };
  const page = wc('page');
  const w = Object.assign(Object.create(BrowserWin.prototype), {
    app: {},
    overlay,
    overlaySeq: 0,
    overlayIn: -1,
    tabs: { wc: () => page },
    win: {
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
      webContents: wc('shell', toShell),
      contentView: {
        children: views,
        addChildView(v) { if (views.includes(v)) views.splice(views.indexOf(v), 1); views.push(v); },
        removeChildView(v) { views.splice(views.indexOf(v), 1); },
      },
    },
  });
  const last = (op) => toOverlay.filter(([, p]) => (op === undefined ? !p.op : p.op === op)).at(-1)?.[1];
  return { w, views, toOverlay, toShell, overlay, has, last, attached: () => views.includes(overlay) };
}

test('a dropdown is drawn unseen first, then put on screen, then comes in from its button', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, overlay, last, attached, toOverlay } = fakeWindow();
  w.showOverlay({ x: 850, y: 80, width: 344, height: 420 }, { kind: 'account', anchor: { x: 1150, y: 60 } });
  assert.equal(w.overlayKind, 'account');
  assert.equal(attached(), false, 'not on screen until it has drawn itself');
  const shown = last('show');
  assert.equal(shown.seq, 1);
  assert.equal(shown.wait, false, 'nothing on screen to clear first');
  assert.deepEqual(shown.origin, { x: 300, y: -20 }, 'its button, in the view’s coordinates');
  assert.deepEqual([shown.width, shown.height], [344, 420]);
  w.overlayReady({ seq: 0, height: 300 }); // an old answer
  assert.equal(attached(), false);
  w.overlayReady({ seq: 1, height: 312 });
  assert.equal(attached(), true);
  assert.equal(overlay.bounds.height, 312, 'as tall as what’s in it');
  assert.deepEqual(last('in'), { op: 'in', seq: 1 });
  // The same dropdown again only updates, and keeps the height it measured.
  w.showOverlay({ x: 850, y: 80, width: 344, height: 420 }, { kind: 'account', anchor: { x: 1150, y: 60 } });
  assert.equal(last('show').seq, 1, 'no new opening');
  assert.equal(last().kind, 'account');
  assert.equal(overlay.bounds.height, 312);
  t.mock.timers.tick(1000);
  assert.equal(toOverlay.filter(([, p]) => p.op === 'in').length, 1, 'it came in once');
});

test('a dropdown used from the keyboard gets it once it’s on screen', () => {
  const { w, has } = fakeWindow({ focused: 'shell' });
  w.showOverlay({ x: 10, y: 80, width: 300, height: 200 }, { kind: 'downloads', focus: true });
  assert.equal(has.focus, 'shell', 'not while it’s drawn unseen');
  w.overlayReady({ seq: w.overlaySeq });
  assert.equal(has.focus, 'overlay');
  // The ⋮ menu opened from the keyboard takes it, and gives it back after;
  // opened with the pointer, the window keeps it (and sends it the keys).
  const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => {}) });
  for (const keyboard of [true, false]) {
    const m = fakeWindow({ focused: 'shell' });
    m.w.showMenu({ at: { right: 1190, top: 78 }, keyboard, from: 'shell' }, buildBrowserMenu(cmd, { open() {}, edit() {} }));
    m.w.overlayReady({ seq: m.w.overlaySeq, height: null });
    assert.equal(m.has.focus, keyboard ? 'overlay' : 'shell');
    m.w.menuPicked({ close: true });
    assert.equal(m.has.focus, 'shell');
  }
});

test('a dropdown that something else went over comes back on top when it changes', () => {
  const { w, views, overlay } = fakeWindow();
  w.showOverlay({ x: 10, y: 80, width: 600, height: 200 }, { kind: 'suggest', items: [] });
  w.overlayReady({ seq: w.overlaySeq });
  const bar = {};
  views.push(bar); // the AI's working bar
  w.showOverlay({ x: 10, y: 80, width: 600, height: 240 }, { kind: 'suggest', items: [] });
  assert.equal(views.at(-1), overlay);
});

test('closing plays the exit and takes the view off once the overlay has drawn it empty', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, last, attached, toShell } = fakeWindow();
  w.showOverlay({ x: 10, y: 80, width: 300, height: 200 }, { kind: 'downloads' });
  w.overlayReady({ seq: 1, height: null });
  w.hideOverlay();
  assert.equal(w.overlayKind, null);
  assert.deepEqual(last('out'), { op: 'out', seq: 2, now: false });
  assert.equal(attached(), true, 'still there while its exit plays');
  assert.deepEqual(toShell.at(-1), ['overlay-state', { kind: 'downloads', closed: true }], 'the window hears it closed');
  w.overlayGone({ seq: 1 });
  assert.equal(attached(), true, 'an old answer');
  w.overlayGone({ seq: 2 });
  assert.equal(attached(), false);

  // If the overlay never answers, the view still goes.
  w.showOverlay({ x: 10, y: 80, width: 300, height: 200 }, { kind: 'downloads' });
  w.overlayReady({ seq: 3 });
  const before = toShell.length;
  w.hideOverlay({ quiet: true });
  assert.equal(toShell.length, before, 'quiet: the window asked, so it knows');
  t.mock.timers.tick(399);
  assert.equal(attached(), true);
  t.mock.timers.tick(1);
  assert.equal(attached(), false);

  // now: no exit at all (the pointer is on it).
  w.showOverlay({ x: 10, y: 80, width: 300, height: 200 }, { kind: 'hovercard' });
  w.overlayReady({ seq: 5, height: 180 });
  w.hideOverlay({ now: true });
  assert.equal(attached(), false);
  assert.equal(last('out').now, true);
});

test('opening another one while the last is leaving: no flash, and it comes in', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, last, attached } = fakeWindow();
  w.showOverlay({ x: 900, y: 80, width: 344, height: 420 }, { kind: 'account' });
  w.overlayReady({ seq: 1, height: 300 });
  w.hideOverlay({ quiet: true });
  w.showOverlay({ x: 700, y: 80, width: 384, height: 300 }, { kind: 'downloads' });
  const shown = last('show');
  assert.equal(shown.wait, true, 'the overlay clears what’s on screen before it’s ready');
  w.overlayGone({ seq: 2 }); // the old exit finishing late changes nothing
  assert.equal(attached(), true);
  w.overlayReady({ seq: shown.seq, height: null });
  assert.equal(w.overlay.bounds.width, 384);
  assert.equal(last('in').seq, shown.seq);
  t.mock.timers.tick(1000);
  assert.equal(attached(), true, 'the old exit’s timer was called off');
  // A dropdown that can't draw (its window hidden) still opens.
  w.hideOverlay({ now: true });
  w.showOverlay({ x: 10, y: 80, width: 300, height: 200 }, { kind: 'siteinfo' });
  t.mock.timers.tick(150);
  assert.equal(attached(), true);
  assert.equal(last('in').seq, w.overlaySeq);
  w.overlayReady({ seq: w.overlaySeq, height: 250 }); // it drew late: only the height changes
  assert.equal(w.overlay.bounds.height, 250);
  assert.equal(last('in').seq, w.overlaySeq);
});

test('the ⋮ menu covers the window, runs what you pick, and hands the keyboard back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, last, attached, has, toOverlay } = fakeWindow({ focused: 'shell' });
  const ran = [];
  const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => ran.push(k)) });
  w.showMenu({ anchor: { x: 1180, y: 60 }, at: { right: 1194, top: 78 }, from: 'page' }, buildBrowserMenu(cmd, { zoom: 100, open() {}, edit() {} }));
  const shown = last('show');
  assert.equal(shown.kind, 'menu');
  assert.deepEqual([w.overlayBounds.x, w.overlayBounds.y, w.overlayBounds.width, w.overlayBounds.height], [0, 0, 1200, 800]);
  assert.equal(shown.items[0].label, 'New tab');
  w.overlayReady({ seq: shown.seq, height: null });
  assert.equal(attached(), true);
  // Zoom's + leaves it open, and its row hears the new level.
  const zoom = shown.items.find((i) => i.type === 'zoom');
  w.menuPicked({ id: zoom.in });
  assert.deepEqual(ran, ['zoom']);
  assert.equal(w.overlayKind, 'menu');
  w.emit('zoom', { level: 110 });
  assert.deepEqual(last('zoom'), { op: 'zoom', level: 110 });
  // An item closes it first, then runs, and the page gets the keyboard back
  // (the click on ⋮ had taken it).
  w.menuPicked({ id: shown.items[0].id });
  assert.deepEqual(ran, ['zoom', 'newTab']);
  assert.equal(w.overlayKind, null);
  assert.equal(has.focus, 'page');
  w.menuPicked({ id: shown.items[0].id }); // closed: nothing more runs
  assert.equal(ran.length, 2);
  assert.ok(toOverlay.some(([, p]) => p.op === 'out'));
});

test('one taking the place of another closes it: its prompt is answered, the ⋮ menu gives the keyboard back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, toShell, has, overlay } = fakeWindow({ focused: 'shell' });
  const closed = [];
  w.app = { onPasskeyPromptClosed: () => closed.push('passkey') };
  const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => {}) });
  w.showMenu({ at: { right: 1190, top: 78 }, from: 'page' }, buildBrowserMenu(cmd, { open() {}, edit() {} }));
  w.overlayReady({ seq: w.overlaySeq, height: null });
  overlay.webContents.focus(); // a click in the menu
  // A site asks for a passkey while the menu is open.
  w.showOverlay({ x: 700, y: 90, width: 404, height: 300 }, { kind: 'passkey', prompt: {} });
  assert.equal(w.overlayKind, 'passkey');
  assert.equal(w.menuActions, null);
  assert.equal(has.focus, 'page', 'the keyboard goes back where it was');
  assert.deepEqual(toShell.at(-1), ['overlay-state', { kind: 'menu', closed: true }], 'the window stops sending it keys');
  // Then the account menu takes the passkey prompt's place: the site hears no.
  w.showOverlay({ x: 850, y: 80, width: 344, height: 420 }, { kind: 'account' });
  assert.deepEqual(closed, ['passkey']);
});

test('the ⋮ menu’s entries: Chrome’s sections, real shortcuts, and only commands that exist', () => {
  const cmd = { isDev: false };
  for (const k of ['newTab', 'newWindow', 'newIncognito', 'passwords', 'history', 'reopenClosed', 'downloads', 'bookmark', 'toggleBookmarksBar', 'bookmarksManager', 'extensions', 'webStore', 'zoom', 'fullscreen', 'print', 'find', 'savePage', 'clearBrowsingData', 'devtools', 'settings', 'about', 'quit']) cmd[k] = () => k;
  const opened = [];
  const edits = [];
  const entries = buildBrowserMenu(cmd, {
    zoom: 125,
    bookmarksBar: true,
    recentlyClosed: [{ label: 'News', index: 4, favicon: 'https://news.example/favicon.ico' }, { label: '2 Tabs (Docs)', index: 3, window: true }],
    bookmarks: [{ url: 'https://a.example/', title: 'A', favicon: null }],
    open: (u) => opened.push(u),
    edit: (op) => edits.push(op),
  });
  const { items, actions } = menuModel(entries, { mac: true });
  const names = items.map((i) => i.label || i.type);
  assert.deepEqual(names, [
    'New tab', 'New window', 'New Incognito window', 'separator',
    'Passwords and autofill', 'History', 'Downloads', 'Bookmarks and lists', 'Extensions', 'separator',
    'Zoom', 'separator', 'Print…', 'Find…', 'Save page as…', 'More tools', 'separator',
    'Edit', 'separator', 'Settings', 'Help', names.at(-1),
  ]);
  assert.match(names.at(-1), /^(Quit Lumio Browser|Exit)$/);
  assert.equal(items[0].accel, '⌘T');
  assert.equal(items[2].accel, '⇧⌘N');
  const history = items.find((i) => i.label === 'History').submenu;
  assert.deepEqual(history.map((i) => i.label || i.type), ['History', 'separator', 'Recently closed', 'News', '2 Tabs (Docs)']);
  assert.equal(history[3].accel, '⇧⌘T', 'the last closed tab shows Reopen’s shortcut');
  assert.equal(history[3].favicon, 'https://news.example/favicon.ico');
  assert.equal(history[4].icon, 'tabs');
  actions.get(history[3].id).run();
  const bookmarks = items.find((i) => i.label === 'Bookmarks and lists').submenu;
  assert.equal(bookmarks.find((i) => i.label === 'Show bookmarks bar').checked, true);
  actions.get(bookmarks.at(-1).id).run();
  assert.deepEqual(opened, ['https://a.example/']);
  // Help's What's new waits until the updater has found the release notes.
  assert.deepEqual(items.find((i) => i.label === 'Help').submenu.map((i) => i.label || i.type), ['About Lumio Browser']);
  let notes = 0;
  const later = menuModel(buildBrowserMenu(cmd, { open() {}, edit() {}, whatsNew: () => notes++ }), { mac: true });
  const help = later.items.find((i) => i.label === 'Help').submenu;
  assert.deepEqual(help.map((i) => i.label || i.type), ['About Lumio Browser', 'What’s new']);
  later.actions.get(help[1].id).run();
  assert.equal(notes, 1);
  // No Browser UI developer tools outside development builds.
  assert.deepEqual(items.find((i) => i.label === 'More tools').submenu.map((i) => i.label || i.type), ['Clear browsing data…', 'separator', 'Developer tools']);
  const zoom = items.find((i) => i.type === 'zoom');
  assert.equal(zoom.level, 125);
  assert.equal(actions.get(zoom.in).keepOpen, true);
  assert.equal(actions.get(zoom.fullscreen).keepOpen, false);
  assert.deepEqual(zoom.keys, { out: '⌘-', in: '⌘+', fullscreen: '⌃⌘F' });
  const edit = items.find((i) => i.type === 'edit');
  actions.get(edit.paste).run();
  assert.deepEqual(edits, ['paste']);
  assert.equal(edit.keys.copy, '⌘C');
  // Nothing that can't be sent to the overlay.
  assert.doesNotThrow(() => structuredClone(items));
  // Windows writes shortcuts out.
  assert.equal(accelLabel('CmdOrCtrl+Shift+N', false), 'Ctrl+Shift+N');
  assert.equal(accelLabel('Cmd+Alt+I', true), '⌥⌘I');
  assert.equal(accelLabel('', true), '');
  // A command this build doesn't have is left out; a submenu left empty goes
  // too, and so do separators at the ends or twice in a row.
  const tidy = menuModel([{ type: 'separator' }, { label: 'A', run: () => {} }, { type: 'separator' }, { type: 'separator' }, { label: 'Gone', submenu: [{ label: 'X', run: undefined }] }, { type: 'separator' }], { mac: true });
  assert.deepEqual(tidy.items.map((i) => i.label || i.type), ['A']);
});

test('the window’s UI only uses channels its preload lets through', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload/shell.js'), 'utf8');
  const events = new Set([...preload.match(/const EVENTS = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const send = new RegExp(preload.match(/const SEND = \/(.*)\/;/)[1]);
  const ui = ['shell.js', 'overlay.js'].map((f) => fs.readFileSync(path.join(ROOT, 'renderer/ui', f), 'utf8')).join('\n');
  const listened = [...ui.matchAll(/api\.on\('([^']+)'/g)].map((m) => m[1]);
  const sent = [...ui.matchAll(/api\.send\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(listened.includes('overlay-state') && sent.includes('overlay:menu') && sent.includes('overlay:key'));
  for (const c of listened) assert.ok(events.has(c), `${c} reaches the page`);
  for (const c of sent) assert.ok(send.test(c), `${c} reaches main`);
  // What main/window.js listens for from the overlay and the window.
  const win = fs.readFileSync(path.join(ROOT, 'main/window.js'), 'utf8');
  for (const [, c] of win.matchAll(/\.ipc\.on\('([^']+)'/g)) assert.ok(send.test(c) && sent.includes(c), `${c} is sent and let through`);
});
