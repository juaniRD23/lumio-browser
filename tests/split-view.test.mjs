// Split view (main/split-view.js) and how the window's tabs use it
// (main/tabs.js): pairs, the focused side, where each page goes, closing and
// separating, the strip order, menus and the session. TabManager runs here
// against stand-ins for Electron's views, so this needs no app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- stand-ins for Electron
let nextWc = 1;
class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextWc++;
    this.url = '';
    this.zoom = 0;
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => 0, restore: async () => {} };
  }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  getURL() { return this.url; }
  getTitle() { return ''; }
  setWindowOpenHandler() {}
  setAudioMuted() {}
  getZoomLevel() { return this.zoom; }
  setZoomLevel(z) { this.zoom = z; }
  isDestroyed() { return false; }
  close() {}
  focus() { this.emit('focus'); } // what a click into the page does
}
class FakeView {
  constructor() { this.webContents = new FakeWebContents(); this.visible = true; this.bounds = null; }
  setVisible(v) { this.visible = v; }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
  setBorderRadius() {}
}
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { WebContentsView: FakeView, Menu: { buildFromTemplate: (items) => ({ items, popup() {} }) }, clipboard: {}, shell: {}, app: { getLocale: () => 'en' } },
};
const { TabManager } = require('../main/tabs.js');
// Lumio's own pages pick their background from light or dark.
require('../main/theme.js').init({ nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'system' }), store: { settings: {}, settingsFile: { onSave() {} } } });
const { clampRatio, fallbackRects, MIN_PANE } = require('../main/split-view.js');

function windowStandIn() {
  const children = [];
  return {
    contentView: {
      children,
      addChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); children.push(v); },
      removeChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
    },
    getContentSize: () => [1400, 900],
    setFullScreen() {},
  };
}

// A window's tab manager with `n` open tabs (the first active).
function manager(n = 3) {
  const events = [];
  const hooks = { onActivated: () => events.push('activated'), focusOmnibox: () => events.push('omnibox') };
  const m = new TabManager({ win: windowStandIn(), session: {}, store: { settings: {}, isBookmarked: () => false }, emit: (c, p) => events.push([c, p]), hooks });
  for (let i = 0; i < n; i++) m.create(`https://site${i + 1}.example/`, { active: i === 0 });
  m.setSlot({ x: 100, y: 80, width: 1000, height: 700 });
  return { m, events, ids: m.tabs.map((t) => t.id) };
}
const shown = (m) => m.tabs.filter((t) => t.view?.visible).map((t) => t.id);
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- pairs
test('a pair shows both pages side by side, with the shell’s measured panes', () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.create(a, c, 'right');
  m.activate(c);
  assert.deepEqual(m.tabs.map((t) => t.id), [a, c, b], 'the pair sits together in the strip, left first');
  assert.deepEqual(shown(m), [a, c]);
  assert.deepEqual(m.state().split, { left: a, right: c, ratio: 0.5 });
  assert.deepEqual(m.state().tabs.map((t) => t.split), ['left', 'right', null]);
  // Before the shell measures: the slot's halves, under room for the bars, with a gap.
  const [l, r] = [m.get(a).view.bounds, m.get(c).view.bounds];
  assert.ok(l.x === 100 && l.x + l.width < r.x && r.x + r.width === 1100, `halves ${JSON.stringify([l, r])}`);
  assert.ok(l.y > 80 && l.y + l.height === 780);
  // The shell's report wins, for the pair it measured.
  m.split.setRects({ left: a, right: c, a: { x: 100, y: 110, width: 400, height: 670 }, b: { x: 510, y: 110, width: 590, height: 670 } });
  assert.deepEqual(m.get(a).view.bounds, { x: 100, y: 110, width: 400, height: 670 });
  assert.deepEqual(m.get(c).view.bounds, { x: 510, y: 110, width: 590, height: 670 });
  m.split.setRects({ left: c, right: a, a: { x: 1, y: 1, width: 5, height: 5 }, b: { x: 1, y: 1, width: 5, height: 5 } });
  assert.equal(m.get(a).view.bounds.x, 100, 'a report for another pair is ignored');
  // Another tab: only it shows.
  m.activate(b);
  assert.deepEqual(shown(m), [b]);
  assert.deepEqual(m.get(b).view.bounds, { x: 100, y: 80, width: 1000, height: 700 });
  assert.equal(m.state().split, null);
});

test('clicking into the other side’s page makes it the focused side, without reordering the views', () => {
  const { m, events, ids: [a, b] } = manager(2);
  m.split.create(a, b);
  m.activate(a);
  const order = [...m.win.contentView.children];
  events.length = 0;
  m.get(b).view.webContents.focus();
  assert.equal(m.activeId, b, 'the toolbar, find bar, zoom and Lumio follow the focused side');
  assert.deepEqual(shown(m), [a, b]);
  assert.deepEqual(m.win.contentView.children, order, 'no view re-added under the click');
  assert.ok(events.includes('activated'));
  // A page in a tab that isn't on screen taking focus changes nothing.
  m.create('https://other.example/', { active: false });
  const other = m.tabs.at(-1);
  m.ensureView(other);
  other.view.webContents.focus();
  assert.equal(m.activeId, b);
});

test('pinned tabs and the same tab twice don’t pair; joining a new pair ends the old one', () => {
  const { m, ids: [a, b, c] } = manager(3);
  assert.equal(m.split.create(a, a), null);
  m.setPinned(c, true);
  assert.equal(m.split.create(a, c), null);
  m.setPinned(c, false);
  m.split.create(a, b);
  m.split.create(b, c, 'left');
  assert.equal(m.split.partnerOf(a), null);
  assert.equal(m.split.partnerOf(b), c);
  assert.equal(m.split.sideOf(c), 'left');
  const order = m.tabs.map((t) => t.id);
  assert.equal(order.indexOf(c) + 1, order.indexOf(b), 'left side first in the strip');
});

test('closing one side leaves the other on screen, alone', () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.create(b, c);
  m.activate(c);
  m.close(c);
  assert.equal(m.activeId, b, 'the other side, not the neighbor');
  assert.deepEqual(shown(m), [b]);
  assert.deepEqual(m.get(b).view.bounds, { x: 100, y: 80, width: 1000, height: 700 });
  // Closing the side that isn't focused: the focused one gets the whole page area.
  m.split.create(a, b);
  m.activate(a);
  m.close(b);
  assert.equal(m.activeId, a);
  assert.deepEqual(m.get(a).view.bounds, { x: 100, y: 80, width: 1000, height: 700 });
  assert.equal(m.split.pairs.length, 0);
});

test('moving a tab to another window or pinning it ends its pair', () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.create(a, b);
  m.activate(b);
  const moved = m.detach(b);
  assert.equal(moved.id, b);
  assert.equal(m.activeId, a, 'the other side stays');
  assert.equal(m.split.pairs.length, 0);
  m.split.create(a, c);
  m.activate(a);
  m.setPinned(c, true);
  assert.equal(m.split.pairs.length, 0);
  assert.deepEqual(shown(m), [a]);
});

test('swap, separate and the divider', () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.create(a, b);
  m.activate(a);
  m.split.setRatio(a, 0.3);
  m.split.swap(a);
  assert.deepEqual(m.state().split, { left: b, right: a, ratio: 0.7 }, 'each page keeps its width');
  assert.deepEqual(m.tabs.map((t) => t.id).slice(0, 2), [b, a], 'the strip follows');
  m.split.setRatio(a, 0.01);
  assert.equal(m.split.pairOf(a).ratio, MIN_PANE / 1000, 'a side never gets narrower than its minimum');
  m.split.setRatio(a, 'wide');
  assert.equal(m.split.pairOf(a).ratio, MIN_PANE / 1000, 'nonsense is ignored');
  // Separating a pair that isn't on screen doesn't switch tabs.
  m.activate(c);
  m.split.separate(a);
  assert.equal(m.activeId, c);
  // Separating the one on screen keeps the focused side.
  m.split.create(a, b);
  m.activate(b);
  m.split.separate(a);
  assert.equal(m.activeId, b);
  assert.deepEqual(shown(m), [b]);
});

test('new tabs and moves keep a pair together in the strip', () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.create(a, b);
  // A link opened next to the left side lands after the pair.
  const fresh = m.create('https://link.example/', { active: false, index: 1 });
  assert.deepEqual(m.tabs.map((t) => t.id), [a, b, fresh.id, c]);
  // Dragging the right side to the end brings the left side along.
  m.move(b, 3);
  assert.deepEqual(m.tabs.map((t) => t.id), [fresh.id, c, a, b]);
  m.move(a, 0);
  assert.deepEqual(m.tabs.map((t) => t.id), [a, b, fresh.id, c]);
});

test('a page in full screen covers the window; the other side hides meanwhile', () => {
  const { m, ids: [a, b] } = manager(2);
  m.split.create(a, b);
  m.activate(a);
  m.fullscreenTab = b;
  m.layout();
  assert.deepEqual(m.get(b).view.bounds, { x: 0, y: 0, width: 1400, height: 900 });
  assert.equal(m.get(a).view.visible, false);
  m.fullscreenTab = null;
  m.layout();
  assert.deepEqual(shown(m), [a, b]);
  // The full-size chat hides both.
  m.setCovered(true);
  assert.deepEqual(shown(m), []);
  m.setCovered(false);
  assert.deepEqual(shown(m), [a, b]);
});

test('a tab dragged to the page’s edge previews where the page goes', () => {
  const { m, ids: [a] } = manager(2);
  m.split.setPreview({ x: 610, y: 110, width: 490, height: 670 });
  assert.deepEqual(m.get(a).view.bounds, { x: 610, y: 110, width: 490, height: 670 });
  m.split.setPreview(null);
  assert.deepEqual(m.get(a).view.bounds, { x: 100, y: 80, width: 1000, height: 700 });
  m.split.setPreview({ x: 'left' });
  assert.equal(m.split.preview, null, 'a bad rect is ignored');
});

test('a tab dropped on an edge pairs with the tab you were on, or the one used last', () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.setPreview({ x: 610, y: 110, width: 490, height: 670 });
  m.split.dropOnEdge(c, { base: b, side: 'left' });
  assert.deepEqual(m.split.state(), { left: c, right: b, ratio: 0.5 });
  assert.equal(m.activeId, c, 'the dropped tab is the focused side');
  assert.equal(m.split.preview, null);
  m.split.separate(c);
  // No usable base (itself, or pinned): the tab used last.
  m.get(a).lastActive = Date.now() + 1000;
  m.setPinned(b, true);
  m.split.dropOnEdge(c, { base: b, side: 'right' });
  assert.deepEqual(m.split.state(), { left: a, right: c, ratio: 0.5 });
  m.split.separate(c);
  // Nothing to pair with: the preview just goes.
  const lone = manager(1);
  lone.m.split.setPreview({ x: 610, y: 110, width: 490, height: 670 });
  lone.m.split.dropOnEdge(lone.ids[0], { side: 'right' });
  assert.equal(lone.m.split.pairs.length, 0);
  assert.equal(lone.m.split.preview, null);
});

test('Memory Saver never puts the other side on screen to sleep', () => {
  const { m, ids: [a, b] } = manager(2);
  m.split.create(a, b);
  m.activate(a);
  m.get(b).view.webContents.url = 'https://site2.example/';
  assert.equal(m.discard(b), false);
});

test('the zoom badge shows the focused side’s zoom only', () => {
  const { m, events, ids: [a, b] } = manager(2);
  m.split.create(a, b);
  m.activate(a);
  events.length = 0;
  m.zoom(1, b);
  assert.equal(events.filter((e) => e[0] === 'zoom').length, 0);
  m.zoom(1, a);
  assert.deepEqual(events.filter((e) => e[0] === 'zoom'), [['zoom', { level: 110 }]]);
});

test('the session keeps pairs and their divider, and brings them back', async () => {
  const { m, ids: [a, b, c] } = manager(3);
  m.split.create(b, c);
  m.split.setRatio(b, 0.4);
  const saved = m.sessionTabs();
  assert.deepEqual(saved.map((t) => t.split || null), [null, { pair: 0, side: 'left', ratio: 0.4 }, { pair: 0, side: 'right', ratio: 0.4 }]);
  const again = new TabManager({ win: windowStandIn(), session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: {} });
  again.restore(saved, 2);
  await flush();
  const [x, y, z] = again.tabs.map((t) => t.id);
  assert.deepEqual(again.split.state(), { left: y, right: z, ratio: 0.4 });
  assert.equal(again.activeId, z);
  assert.ok(again.get(y).view && again.get(y).view.visible, 'the other side loads too');
  assert.equal(again.get(x).view?.visible, false);
  // A pair with one side missing from the file isn't restored.
  const lone = saved.filter((t) => t.split?.side !== 'right');
  const third = new TabManager({ win: windowStandIn(), session: {}, store: { settings: {}, isBookmarked: () => false }, emit: () => {}, hooks: {} });
  third.restore(lone, 0);
  assert.equal(third.split.pairs.length, 0);
  assert.equal(third.tabs.length, 2);
  assert.equal(m.tabs[0].id, a);
});

// ---------------------------------------------------------------- menus
test('the tab menu offers a new split view, or swap and separate', () => {
  const { m, events, ids: [a, b, c] } = manager(3);
  const labels = (t) => m.split.menuItems(m.get(t)).map((i) => i.label);
  assert.deepEqual(labels(b), ['Add Tab to New Split View']);
  // On another tab: it joins the tab you're on, and becomes the focused side.
  m.split.menuItems(m.get(b)).find((i) => i.label === 'Add Tab to New Split View').click();
  assert.deepEqual(m.split.state(), { left: a, right: b, ratio: 0.5 });
  assert.equal(m.activeId, b);
  assert.deepEqual(labels(a), ['Swap Sides', 'Separate Tabs']);
  m.split.menuItems(m.get(a)).find((i) => i.label === 'Separate Tabs').click();
  assert.equal(m.split.pairs.length, 0);
  // On the tab you're on: a new tab page joins it, ready to type an address.
  m.activate(c);
  m.split.menuItems(m.get(c)).find((i) => i.label === 'Add Tab to New Split View').click();
  const fresh = m.tabs.find((t) => t.url === 'lumio://newtab/');
  assert.deepEqual(m.split.state(), { left: c, right: fresh.id, ratio: 0.5 });
  assert.equal(m.activeId, fresh.id);
  assert.ok(events.includes('omnibox'));
  m.setPinned(a, true);
  assert.equal(m.split.menuItems(m.get(a))[0].enabled, false, 'pinned tabs can’t split');
});

test('a link opened in split view: beside its tab, or in the other side', () => {
  const { m, ids: [a, b] } = manager(2);
  m.split.openBeside(a, 'https://link.example/');
  const link = m.tabs.find((t) => t.url === 'https://link.example/');
  assert.deepEqual(m.split.state(), { left: a, right: link.id, ratio: 0.5 });
  m.split.openBeside(link.id, 'https://next.example/');
  assert.equal(m.get(a).url, 'https://next.example/', 'already split: it loads in the other side');
  assert.equal(m.activeId, a);
  assert.equal(m.tabs.length, 3);
  assert.ok(b);
});

// ---------------------------------------------------------------- geometry
test('fallback halves and the minimum side', () => {
  const r = fallbackRects({ x: 0, y: 50, width: 1000, height: 600 }, 0.5);
  assert.equal(r.left.x, 0);
  assert.ok(r.left.x + r.left.width < r.right.x, 'a gap for the divider');
  assert.equal(r.right.x + r.right.width, 1000);
  assert.equal(r.left.y, r.right.y);
  assert.ok(r.left.y > 50 && r.left.y + r.left.height === 650);
  assert.equal(clampRatio(0.05, 1000), MIN_PANE / 1000);
  assert.equal(clampRatio(0.99, 1000), 1 - MIN_PANE / 1000);
  assert.equal(clampRatio(0.2, 400), 0.5, 'too narrow for two: halves');
  assert.equal(clampRatio(undefined), 0.5);
  // The divider in the window stops at the same width.
  const ui = fs.readFileSync(new URL('../renderer/ui/split-view.js', import.meta.url), 'utf8');
  assert.equal(Number(/const MIN_PANE = (\d+)/.exec(ui)?.[1]), MIN_PANE);
});
