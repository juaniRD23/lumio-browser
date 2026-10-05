// The view that draws a page's dialogs over its tab (main/dialog-view.js),
// with the real TabManager and stand-ins for Electron's views: it covers the
// page area above the page and below the Stop bar and dropdowns, shows only
// the tab you're on, takes the keyboard and gives it back, accepts an answer
// only for the dialog on screen, and goes with a tab moved to another window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Just enough of Electron's WebContentsView for the dialog view.
class FakeView {
  constructor(opts) {
    this.opts = opts;
    this.bounds = null;
    const wc = new EventEmitter();
    Object.assign(wc, {
      sent: [], url: '', destroyed: false, focused: false,
      isDestroyed: () => wc.destroyed,
      isFocused: () => wc.focused,
      focus: () => { wc.focused = true; },
      send: (channel, payload) => wc.sent.push([channel, payload]),
      loadURL: (url) => { wc.url = url; setImmediate(() => wc.emit('did-finish-load')); },
      close: () => { wc.destroyed = true; },
    });
    this.webContents = wc;
  }
  setBackgroundColor() {}
  setBorderRadius() {}
  setBounds(b) { this.bounds = b; }
}
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { WebContentsView: FakeView, app: {}, Menu: {}, clipboard: {} } };
const { DialogView } = require('../main/dialog-view.js');
const { TabManager } = require('../main/tabs.js');

const tick = () => new Promise((r) => setImmediate(r));
const SLOT = { x: 0, y: 84, width: 1200, height: 700 };
let nextTab = 100; // tab ids are unique across windows, as in the app

// A tab's page: where the keyboard is, and where it's drawn.
function pageView(url) {
  const wc = new EventEmitter();
  Object.assign(wc, { url, focused: false, getURL: () => url, isDestroyed: () => false, focus: () => { wc.focused = true; } });
  return { webContents: wc, bounds: null, setVisible() {}, setBounds(b) { this.bounds = b; }, getBounds() { return this.bounds; }, setBorderRadius() {}, setBackgroundColor() {} };
}

// A browser window as main/window.js wires it: its tabs redraw the dialog
// view when you switch tabs, when a tab's queue changes, and on layout.
function makeWindow({ incognito = false, urls = ['https://a.example/'] } = {}) {
  const children = [];
  const contentView = {
    children,
    addChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); children.push(v); },
    removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
  };
  const w = { win: { contentView, getContentSize: () => [1200, 800], setFullScreen() {} }, incognito, closed: false, overlayKind: null };
  w.indicator = { bar: { name: 'stop bar' } };
  w.overlay = { name: 'dropdown' };
  w.dialogs = new DialogView(w);
  w.tabs = new TabManager({
    win: w.win, session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, incognito,
    hooks: { onActivated: () => w.dialogs.sync(), onDialogs: () => w.dialogs.sync(), onLayout: () => w.dialogs.place() },
  });
  w.tabs.slot = { ...SLOT };
  // Each page opens in a new tab you're on (the last one stays in front).
  w.pages = urls.map((url) => {
    const tab = { id: nextTab++, owner: w.tabs, view: pageView(url), url, title: url, pinned: false };
    w.tabs.tabs.push(tab);
    children.push(tab.view);
    w.tabs.activate(tab.id);
    return tab;
  });
  return w;
}

const CONFIRM = { kind: 'js', title: 'a.example says', message: 'Sure?', buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }], cancel: 'cancel' };
const shown = (w) => w.win.contentView.children.includes(w.dialogs.view);
const lastSent = (w) => w.dialogs.view.webContents.sent.at(-1);

test('the dialog covers its page, above it and below the Stop bar and an open dropdown, and gets the keyboard', async () => {
  const w = makeWindow();
  const [a] = w.pages;
  // The Stop bar (Lumio AI working) and a dropdown are open over the page.
  w.win.contentView.addChildView(w.indicator.bar);
  w.win.contentView.addChildView(w.overlay);
  w.overlayKind = 'menu';
  const answered = w.tabs.ask(a, CONFIRM);
  const view = w.dialogs.view;
  assert.ok(view, 'made when there is something to show');
  assert.equal(view.webContents.url, 'lumio://dialog/');
  assert.equal(view.opts.webPreferences.sandbox, true);
  assert.equal(view.opts.webPreferences.contextIsolation, true);
  assert.deepEqual(w.win.contentView.children.slice(-4), [a.view, view, w.indicator.bar, w.overlay]);
  assert.deepEqual(view.bounds, SLOT, 'the whole page area, so the page can’t be used meanwhile');
  assert.equal(view.webContents.focused, true);
  // It sends the dialog once its page has loaded.
  assert.equal(view.webContents.sent.length, 0);
  await tick();
  const [channel, data] = lastSent(w);
  assert.equal(channel, 'dialog-data');
  assert.deepEqual({ ...data, id: undefined }, { ...CONFIRM, id: undefined });
  assert.equal(typeof data.id, 'number');
  // The window resizes: the dialog follows the page.
  w.tabs.setSlot({ x: 0, y: 120, width: 900, height: 500 });
  assert.deepEqual(view.bounds, { x: 0, y: 120, width: 900, height: 500 });
  w.dialogs.answer({ id: data.id, button: 'ok' });
  assert.equal((await answered).button, 'ok');
  assert.equal(shown(w), false, 'gone once answered');
  assert.deepEqual(lastSent(w), ['dialog-data', null], 'cleared, so it never flashes old text');
});

test('a dialog belongs to its tab: another tab hides it and gets the keyboard back; coming back shows it again', async () => {
  const w = makeWindow({ urls: ['https://a.example/', 'https://b.example/'] });
  const [a, b] = w.pages;
  w.tabs.activate(a.id);
  w.tabs.ask(a, CONFIRM);
  await tick();
  const first = lastSent(w)[1].id;
  w.tabs.activate(b.id);
  assert.equal(shown(w), false);
  assert.equal(b.view.webContents.focused, true, 'the keyboard goes to the page, not nowhere');
  // A dialog from a tab in the background waits until you open it.
  const fromA = w.tabs.ask(a, { ...CONFIRM, message: 'And this?' });
  assert.equal(shown(w), false);
  w.tabs.activate(a.id);
  assert.equal(shown(w), true);
  assert.equal(lastSent(w)[1].id, first, 'the first one in its queue');
  w.dialogs.answer({ id: first, button: 'cancel' });
  assert.equal(lastSent(w)[1].message, 'And this?', 'then the next');
  w.dialogs.answer({ id: lastSent(w)[1].id, button: 'ok' });
  assert.equal((await fromA).button, 'ok');
  assert.equal(shown(w), false);
});

test('only an answer to the dialog on screen counts', async () => {
  const w = makeWindow({ urls: ['https://a.example/', 'https://b.example/'] });
  const [a, b] = w.pages;
  let settled = false;
  w.tabs.ask(b, CONFIRM).then(() => { settled = true; });
  await tick();
  const onScreen = lastSent(w)[1].id;
  const hidden = w.tabs.ask(a, CONFIRM); // a's, not shown
  w.dialogs.answer({ id: onScreen + 1, button: 'ok' }); // a's id: not the one on screen
  w.dialogs.answer({ id: 'x', button: 'ok' });
  w.dialogs.answer();
  await tick();
  assert.equal(settled, false);
  assert.deepEqual([a.dialogs.length, b.dialogs.length], [1, 1]);
  w.dialogs.answer({ id: onScreen, button: 'delete-everything' }); // not one of its buttons
  await tick();
  assert.equal(settled, false);
  w.dialogs.answer({ id: onScreen, button: 'ok' });
  await tick();
  assert.equal(settled, true);
  w.tabs.dismiss(a);
  assert.equal((await hidden).dismissed, true);
});

test('a full-size Lumio chat over the page hides its dialog too; incognito’s is dark', async () => {
  const w = makeWindow();
  w.tabs.ask(w.pages[0], CONFIRM);
  assert.equal(shown(w), true);
  w.tabs.setCovered(true);
  assert.equal(shown(w), false);
  w.tabs.setCovered(false);
  assert.equal(shown(w), true);
  const inc = makeWindow({ incognito: true });
  inc.tabs.ask(inc.pages[0], CONFIRM);
  assert.equal(inc.dialogs.view.webContents.url, 'lumio://dialog/?appearance=dark');
});

test('a crashed dialog view is replaced for the dialog still waiting; closing the window closes it', async () => {
  const w = makeWindow();
  w.tabs.ask(w.pages[0], CONFIRM);
  await tick();
  const old = w.dialogs.view;
  old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(w.win.contentView.children.includes(old), false);
  await tick();
  assert.notEqual(w.dialogs.view, old, 'a new view');
  assert.equal(shown(w), true, 'showing the same dialog');
  await tick();
  assert.equal(lastSent(w)[1].message, 'Sure?');
  const view = w.dialogs.view;
  w.dialogs.destroy();
  assert.equal(view.webContents.destroyed, true);
  assert.equal(w.dialogs.view, null);
});

test('a tab moved to another window takes its dialog along, and it’s answered there', async () => {
  const one = makeWindow({ urls: ['https://form.example/', 'https://other.example/'] });
  const two = makeWindow({ urls: ['https://two.example/'] });
  const [form] = one.pages;
  one.tabs.activate(form.id);
  const answered = one.tabs.ask(form, CONFIRM);
  await tick();
  const id = lastSent(one)[1].id;
  const moved = one.tabs.detach(form.id);
  assert.equal(shown(one), false, 'the first window shows its other tab, without the dialog');
  two.tabs.adopt(moved);
  assert.equal(shown(two), true, 'the new window shows it over the tab');
  await tick();
  assert.equal(lastSent(two)[1].id, id);
  one.dialogs.answer({ id, button: 'ok' }); // the old window has nothing on screen
  two.dialogs.answer({ id, button: 'ok' });
  assert.equal((await answered).button, 'ok');
});
