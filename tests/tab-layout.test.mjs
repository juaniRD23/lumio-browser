// Tabs to the side and split view in the window's UI: the per-window choice
// (main/tab-layout.js), the tabs column (renderer/ui/vertical-tabs.js), its
// flyout over the page (tab-flyout.js), and the split view's panes, divider
// and drag-to-edge (split-view.js). The UI runs in headless Chrome with a
// stand-in for the main process, like tests/shell.test.mjs. Those parts are
// skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');
const tabLayout = require('../main/tab-layout.js');

// ---------------------------------------------------------------- the per-window choice
function windowStandIn(layout = { vertical: false, collapsed: false }) {
  const w = { tabLayout: layout, sent: [], overlayKind: null, closed: false, saved: 0, hidden: 0 };
  w.emit = (c, p) => w.sent.push([c, p]);
  w.hideOverlay = () => { w.hidden++; w.overlayKind = null; };
  w.app = { onSessionChanged: () => { w.saved++; } };
  w.win = { setTitleBarOverlay: (o) => { w.caption = o.height; } };
  return w;
}
const storeStandIn = (settings = {}) => ({ settings, setSetting(k, v) { this.settings[k] = v; } });

test('each window keeps its own tab layout; turning tabs to the side on or off becomes the default', () => {
  const store = storeStandIn({ verticalTabs: false });
  assert.deepEqual(tabLayout.initial(store, null), { vertical: false, collapsed: false });
  assert.deepEqual(tabLayout.initial(store, { vertical: true, collapsed: true }), { vertical: true, collapsed: true }, 'a restored window keeps what it had');
  const w = windowStandIn();
  tabLayout.set(w, { vertical: true }, store);
  assert.deepEqual(w.tabLayout, { vertical: true, collapsed: false });
  assert.equal(store.settings.verticalTabs, true, 'new windows follow');
  assert.deepEqual(w.sent.at(-1), ['tab-layout', { vertical: true, collapsed: false }]);
  assert.equal(w.saved, 1, 'saved with the session');
  if (process.platform !== 'darwin') assert.equal(w.caption, 46, 'Windows caption buttons line up with the toolbar');
  // Collapsing is the window's own business.
  tabLayout.set(w, { collapsed: true }, store);
  assert.equal(w.tabLayout.collapsed, true);
  assert.deepEqual(tabLayout.initial(store, null), { vertical: true, collapsed: false });
  // Nothing changed: nothing sent.
  const n = w.sent.length;
  tabLayout.set(w, { collapsed: true }, store);
  assert.equal(w.sent.length, n);
  // Expanding closes the flyout (it only belongs to the collapsed column).
  w.overlayKind = 'vtabs';
  tabLayout.set(w, { collapsed: false }, store);
  assert.equal(w.hidden, 1);
});

test('the tab and strip menus: Show Tabs to the Side, and collapse or expand', () => {
  const store = storeStandIn();
  const w = windowStandIn();
  let items = tabLayout.menuItems(w, store);
  assert.deepEqual(items.map((i) => [i.label, i.checked]), [['Show Tabs to the Side', false]]);
  items[0].click();
  assert.equal(w.tabLayout.vertical, true);
  items = tabLayout.menuItems(w, store);
  assert.deepEqual(items.map((i) => [i.label, i.checked]), [['Show Tabs to the Side', true], ['Collapse Tabs', undefined]]);
  items[1].click();
  assert.equal(tabLayout.menuItems(w, store)[1].label, 'Expand Tabs');
});

test('the flyout stays open while the pointer is over it (not its shadow)', () => {
  const b = { x: 8, y: 120, width: 276, height: 500 };
  assert.equal(tabLayout.insideFlyout({ x: 20, y: 300 }, b), true);
  assert.equal(tabLayout.insideFlyout({ x: 8 + 276 - 5, y: 300 }, b), false, 'the transparent edge on the right');
  assert.equal(tabLayout.insideFlyout({ x: 400, y: 300 }, b), false);
  assert.equal(tabLayout.insideFlyout({ x: 20, y: 100 }, b), false);
});

// ---------------------------------------------------------------- the window UI in headless Chrome
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const SHOTS = process.env.LUMIO_SHOTS;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const TABS = [
  { id: 1, title: 'Mail', url: 'https://mail.example/', pinned: true, favicon: PNG },
  { id: 2, title: 'Calendar', url: 'https://cal.example/', pinned: true },
  { id: 3, title: 'How bikes work', url: 'https://video.example/watch', audible: true },
  { id: 4, title: 'Best Buy', url: 'https://www.bestbuy.com/', agent: { color: '#b58cff', name: 'Helper 2', title: 'Best Buy price' } },
  { id: 5, title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { id: 6, title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
];
const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const INIT = {
  tabs: { activeId: 3, split: null, tabs: TABS },
  downloads: [], panel: { open: true, width: 360 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'Test Person', email: 't@lumio.test' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', update: null,
  sidebar: { open: false }, tabLayout: { vertical: true, collapsed: false },
};

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    // /overlay/… is the overlay's page; everything else the window's.
    const overlay = req.url.startsWith('/overlay/');
    const url = new URL(`lumio://${overlay ? 'overlay' : 'shell'}${overlay ? req.url.slice(8) : req.url}`);
    const file = resolveFile(url, new Set(['shell', 'overlay']));
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

// Opens the window UI (or the overlay with page: 'overlay/') with a stand-in main process.
async function open({ init = INIT, colorScheme = 'dark', page: at = '', reducedMotion } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme, reducedMotion });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ init, ai }) => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] } };
    window.lumio = {
      invoke: async (channel) => answers[channel] ?? null,
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { init, ai: AI });
  await page.goto(`${base}/${at}`);
  if (!at) await page.waitForSelector('#vtabs .vt-tab', { state: 'attached' });
  return { page, errors };
}
const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const lastSent = async (page, channel) => (await sent(page, channel)).at(-1);
const box = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);

test('tabs to the side: the column lists every tab, the toolbar is the top row, and the page moves over', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await open();
  assert.equal(await page.isVisible('#tabstrip'), false, 'no strip across the top');
  assert.equal(await page.isVisible('#vtabs'), true);
  const [toolbar, col, slot] = [await box(page, '#toolbar'), await box(page, '#vtabs'), await box(page, '#slot')];
  assert.equal(toolbar.top, 0, 'the toolbar is the top row');
  assert.ok(col.top >= toolbar.bottom && col.right <= slot.left, 'the column sits beside the page, under the toolbar');
  const reported = await lastSent(page, 'layout:slot');
  assert.equal(Math.round(reported.x), Math.round(slot.left), 'main hears where the page goes');
  // The Mac's window buttons get room at the toolbar's start; the sidebar's show button moved there.
  assert.ok((await box(page, '.vt-traffic')).width >= 70);
  assert.equal(await page.evaluate(() => document.getElementById('sb-open').parentElement.className), 'vt-lead');
  // Pinned tabs first (as tiles), then the others, each with its indicators.
  const rows = await page.$$eval('#vtabs .vt-tab', (els) => els.map((e) => ({ id: +e.dataset.id, pinned: e.classList.contains('pinned'), active: e.classList.contains('active'), selected: e.getAttribute('aria-selected'), label: e.getAttribute('aria-label') })));
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.filter((r) => r.pinned).map((r) => r.id), [1, 2]);
  assert.deepEqual(rows.filter((r) => r.active).map((r) => r.id), [3]);
  assert.equal(rows[2].selected, 'true');
  assert.match(rows[2].label, /How bikes work \(playing audio\)/);
  assert.match(rows[3].label, /Helper 2 is working here/);
  assert.equal(await page.isVisible('#vtabs .vt-tab[data-id="3"] .audio'), true);
  assert.equal(await page.isVisible('#vtabs .vt-tab[data-id="4"] .agent-dot'), true);
  const pin = await box(page, '#vtabs .vt-tab[data-id="1"]');
  const row = await box(page, '#vtabs .vt-tab[data-id="3"]');
  assert.ok(pin.width < 60 && row.width > 180, 'tiles for pinned tabs, full rows for the rest');

  // Click, middle-click, close button, right-click, new tab.
  await page.click('#vtabs .vt-tab[data-id="5"] .title');
  assert.equal(await lastSent(page, 'tab:activate'), 5);
  await page.click('#vtabs .vt-tab[data-id="6"]', { button: 'middle' });
  assert.equal(await lastSent(page, 'tab:close'), 6);
  await page.hover('#vtabs .vt-tab[data-id="4"]');
  await page.click('#vtabs .vt-tab[data-id="4"] .x');
  assert.equal(await lastSent(page, 'tab:close'), 4);
  await page.click('#vtabs .vt-tab[data-id="3"] .audio');
  assert.equal(await lastSent(page, 'tab:mute'), 3);
  await page.click('#vtabs .vt-tab[data-id="5"]', { button: 'right' });
  assert.equal(await lastSent(page, 'tab:context'), 5);
  await page.click('#vtabs .vt-new');
  assert.equal((await sent(page, 'tab:new')).length, 1);
  // Right-click on the column away from a tab: the strip's menu (Show Tabs to the Side…).
  const scroll = await box(page, '#vtabs .vt-scroll');
  await page.mouse.click(scroll.left + 40, scroll.bottom - 20, { button: 'right' });
  assert.equal((await sent(page, 'tab:strip-context')).length, 1);
  // New state from main: the list follows.
  await page.evaluate(() => window.__emit('tabs', { activeId: 5, split: null, tabs: [{ id: 5, title: 'Wikipedia', url: 'https://en.wikipedia.org/' }, { id: 7, title: 'Lumio', url: '', internal: true }] }));
  assert.deepEqual(await page.$$eval('#vtabs .vt-tab', (els) => els.map((e) => e.dataset.id)), ['5', '7']);
  assert.deepEqual(errors, []);
});

test('tabs to the side: drag to reorder, and the keyboard', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await open();
  // Drag “How bikes work” below “Wikipedia”.
  const from = await box(page, '#vtabs .vt-tab[data-id="3"]');
  const to = await box(page, '#vtabs .vt-tab[data-id="5"]');
  await page.mouse.move(from.left + 60, from.top + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.left + 60, from.top + 20, { steps: 3 });
  await page.mouse.move(from.left + 62, to.top + to.height / 2 + 6, { steps: 8 });
  assert.equal(await page.evaluate(() => document.querySelector('.vt-tab[data-id="3"]').classList.contains('dragging')), true);
  await page.mouse.up();
  assert.deepEqual(await lastSent(page, 'tab:move'), { id: 3, index: 4 });
  assert.equal(await lastSent(page, 'tab:activate'), 3, 'pressing a tab opens it, like in the strip');
  assert.equal(await page.$$eval('.vt-tab.dragging, .vt-tab.shifting', (els) => els.length), 0, 'nothing left mid-drag');

  // Keyboard: the open tab takes focus first; arrows move, Enter opens, Delete closes,
  // Alt+Shift+arrows move the tab, the menu key opens its menu, Esc goes back to the page.
  assert.deepEqual(await page.$$eval('#vtabs .vt-tab', (els) => els.filter((e) => e.tabIndex === 0).map((e) => e.dataset.id)), ['3']);
  await page.focus('#vtabs .vt-tab[data-id="3"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), '4');
  await page.keyboard.press('Enter');
  assert.equal(await lastSent(page, 'tab:activate'), 4);
  await page.keyboard.press('Alt+Shift+ArrowDown');
  assert.deepEqual(await lastSent(page, 'tab:move'), { id: 4, index: 4 });
  await page.keyboard.press('Shift+F10');
  assert.equal(await lastSent(page, 'tab:context'), 4);
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), '1');
  await page.keyboard.press('Alt+Shift+ArrowDown');
  assert.deepEqual(await lastSent(page, 'tab:move'), { id: 1, index: 1 }, 'pinned tabs move among pinned tabs');
  await page.keyboard.press('End');
  await page.keyboard.press('Delete');
  assert.equal(await lastSent(page, 'tab:close'), 6);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), '5', 'focus stays in the list');
  await page.keyboard.press('Escape');
  assert.equal((await sent(page, 'tab:focus-page')).length, 1);
  assert.deepEqual(errors, []);
});

test('collapsed: icons only, the page gets the room, and hovering opens the flyout', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await open({ reducedMotion: 'reduce' });
  const wide = await box(page, '#slot');
  await page.click('#vtabs .vt-toggle');
  assert.deepEqual(await lastSent(page, 'layout:tabs'), { collapsed: true });
  assert.equal(await page.getAttribute('#vtabs .vt-toggle', 'aria-expanded'), 'true');
  await page.evaluate(() => window.__emit('tab-layout', { vertical: true, collapsed: true }));
  assert.equal(await page.getAttribute('#vtabs .vt-toggle', 'aria-expanded'), 'false');
  assert.equal(await page.getAttribute('#vtabs .vt-toggle', 'aria-label'), 'Expand tabs');
  const col = await box(page, '#vtabs');
  assert.ok(col.width <= 48, `narrow column (${col.width}px)`);
  assert.equal(await page.isVisible('#vtabs .vt-tab[data-id="5"] .title'), false);
  const narrow = await box(page, '#slot');
  assert.ok(narrow.width > wide.width + 150, 'the page gets the room');
  await page.waitForFunction((x) => window.__sent.filter(([c]) => c === 'layout:slot').at(-1)?.[1].x < x, wide.left);
  // Hovering the collapsed column shows every tab over the page (once the
  // pointer comes back to it: not right after collapsing it).
  await page.waitForTimeout(500);
  assert.equal((await sent(page, 'overlay:show')).length, 0);
  await page.mouse.move(600, 400);
  await page.hover('#vtabs .vt-tab[data-id="5"]');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:show' && p.payload.kind === 'vtabs'));
  const flyout = await lastSent(page, 'overlay:show');
  assert.equal(Math.round(flyout.rect.x), Math.round(col.left));
  assert.ok(flyout.rect.width > 200 && flyout.rect.height === col.height);
  assert.deepEqual(flyout.payload.tabs.map((t) => t.id), [1, 2, 3, 4, 5, 6]);
  // While it's open, new tab state refreshes it; main closing it stops that.
  const shows = (await sent(page, 'overlay:show')).length;
  await page.evaluate(() => window.__emit('tabs', { activeId: 5, split: null, tabs: [{ id: 5, title: 'Wikipedia', url: 'https://en.wikipedia.org/' }] }));
  assert.equal((await sent(page, 'overlay:show')).length, shows + 1);
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'vtabs' }));
  await page.evaluate(() => window.__emit('tabs', { activeId: 5, split: null, tabs: [{ id: 5, title: 'Wiki', url: 'https://en.wikipedia.org/' }] }));
  assert.equal((await sent(page, 'overlay:show')).length, shows + 1);
  // Expanded again: no flyout.
  await page.evaluate(() => window.__emit('tab-layout', { vertical: true, collapsed: false }));
  assert.ok((await box(page, '#vtabs')).width > 200);
  // Back to the top: the strip and its buttons return where they were.
  await page.evaluate(() => window.__emit('tab-layout', { vertical: false, collapsed: false }));
  // (Reduced motion still runs transitions for a millisecond: batch 3.)
  await page.waitForFunction(() => document.querySelector('#tabstrip').getBoundingClientRect().height > 0);
  assert.equal(await page.isVisible('#tabstrip'), true);
  assert.equal(await page.isVisible('#vtabs'), false);
  assert.deepEqual(await page.evaluate(() => [document.getElementById('sb-open').nextElementSibling.id, document.getElementById('incognito-badge').parentElement.id]), ['tabs', 'tabstrip']);
  assert.deepEqual(errors, []);
});

test('the flyout lists the tabs over the page: click opens, × closes, and it can reorder', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await open({ page: 'overlay/' });
  await page.evaluate((tabs) => window.__emit('overlay-data', { kind: 'vtabs', tabs, activeId: 3, shownId: null }), TABS);
  await page.waitForSelector('.vtf .vt-tab[data-id="6"]');
  assert.equal(await page.evaluate(() => document.body.classList.contains('vtabs-flyout')), true);
  assert.equal(await page.isVisible('.vtf .vt-tab[data-id="5"] .audio'), false, 'hidden indicators stay hidden');
  await page.click('.vtf .vt-tab[data-id="5"] .title');
  assert.equal(await lastSent(page, 'tab:activate'), 5);
  await page.hover('.vtf .vt-tab[data-id="6"]');
  await page.click('.vtf .vt-tab[data-id="6"] .x');
  assert.equal(await lastSent(page, 'tab:close'), 6);
  assert.equal((await sent(page, 'tab:activate')).length, 1, 'closing doesn’t open it');
  await page.click('.vtf .vt-tab[data-id="4"]', { button: 'right' });
  assert.equal(await lastSent(page, 'tab:context'), 4);
  // Dragging a row moves the tab, and doesn't count as a click.
  const a = await box(page, '.vtf .vt-tab[data-id="3"]');
  const b = await box(page, '.vtf .vt-tab[data-id="5"]');
  await page.mouse.move(a.left + 50, a.top + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.left + 50, b.top + b.height / 2 + 6, { steps: 8 });
  await page.mouse.up();
  assert.deepEqual(await lastSent(page, 'tab:move'), { id: 3, index: 4 });
  assert.equal((await sent(page, 'tab:activate')).length, 1);
  await page.click('.vtf .vt-new');
  assert.equal((await sent(page, 'tab:new')).length, 1);
  // Another dropdown takes the card back.
  // (The overlay's steps: another kind is shown, then comes in.)
  await page.evaluate(() => { window.__emit('overlay-data', { kind: 'downloads', items: [], op: 'show', seq: 90 }); window.__emit('overlay-data', { op: 'in', seq: 90 }); });
  assert.equal(await page.evaluate(() => document.body.classList.contains('vtabs-flyout')), false);
  assert.match(await page.textContent('#card'), /Downloads/);
  await page.evaluate((tabs) => window.__emit('overlay-data', { kind: 'vtabs', tabs, activeId: 3, shownId: null, op: 'show', seq: 91 }), TABS);
  assert.equal(await page.$$eval('.vtf .vt-tab', (els) => els.length), 6, 'and gives it back');
  assert.deepEqual(errors, []);
});

const SPLIT_TABS = TABS.map((t) => (t.id === 5 ? { ...t, split: 'left' } : t.id === 6 ? { ...t, split: 'right' } : t));
const SPLIT = { ...INIT, tabs: { activeId: 5, split: { left: 5, right: 6, ratio: 0.5 }, tabs: SPLIT_TABS }, tabLayout: { vertical: false, collapsed: false } };

test('split view: two panes, the focused one ringed, their page areas reported, and the strip marks both tabs', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await open({ init: SPLIT });
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'layout:split'));
  assert.equal(await page.isVisible('#split'), true);
  const report = await lastSent(page, 'layout:split');
  const [left, right] = [await box(page, '.pane[data-side="left"] .pane-body'), await box(page, '.pane[data-side="right"] .pane-body')];
  assert.deepEqual([report.left, report.right], [5, 6]);
  assert.deepEqual(report.a, { x: left.left, y: left.top, width: left.width, height: left.height });
  assert.deepEqual(report.b, { x: right.left, y: right.top, width: right.width, height: right.height });
  assert.ok(left.right < right.left, 'a gap for the divider');
  assert.ok(Math.abs(left.width - right.width) < 2, 'even halves');
  const slot = await box(page, '#slot');
  assert.ok(left.top > slot.top + 20, 'room for the bars above the pages');
  assert.deepEqual(await page.$$eval('.pane', (els) => els.map((e) => [e.dataset.id, e.classList.contains('focused')])), [['5', true], ['6', false]]);
  assert.match(await page.textContent('.pane[data-side="right"] .pane-title'), /MDN Web Docs/);
  // Both tabs in the strip carry the split icon; the other side on screen is lit too.
  assert.deepEqual(await page.$$eval('#tabs .tab', (els) => els.filter((e) => !e.querySelector('.split-ic').hidden).length), 2);
  assert.deepEqual(await page.$$eval('#tabs .tab.shown', (els) => els.length), 1);
  // Bars: focus a side, swap, separate, close one side; right-click gives the tab's menu.
  await page.click('.pane[data-side="right"] .pane-site');
  assert.equal(await lastSent(page, 'tab:activate'), 6);
  assert.equal((await sent(page, 'tab:focus-page')).length, 1);
  await page.click('.pane[data-side="left"] [data-act="swap"]');
  assert.equal(await lastSent(page, 'tab:split-swap'), 5);
  await page.click('.pane[data-side="left"] [data-act="separate"]');
  assert.equal(await lastSent(page, 'tab:split-separate'), 5);
  await page.hover('.pane[data-side="right"] .pane-bar');
  await page.click('.pane[data-side="right"] [data-act="close"]');
  assert.equal(await lastSent(page, 'tab:close'), 6);
  await page.click('.pane[data-side="right"] .pane-title', { button: 'right' });
  assert.equal(await lastSent(page, 'tab:context'), 6);
  // A permission asked by one side: its bar says so until it's answered in
  // the address bar's permission chip (batch 6, renderer/ui/permission-chip.js).
  await page.evaluate(() => window.__emit('permission', { id: 9, host: 'developer.mozilla.org', label: 'know your location', wcId: 66 }));
  await page.evaluate((tabs) => window.__emit('tabs', { activeId: 5, split: { left: 5, right: 6, ratio: 0.5 }, tabs: tabs.map((t) => ({ ...t, wcId: t.id * 11 })) }), SPLIT_TABS);
  assert.equal(await page.textContent('.pane[data-side="right"] .pane-ask'), 'Asks to know your location');
  assert.equal(await page.isVisible('.pane[data-side="left"] .pane-ask'), false);
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'permission', id: 9 }));
  assert.equal(await page.isVisible('.pane[data-side="right"] .pane-ask'), false);
  // The focused side moves when main says so; titles and loading don't resend the layout.
  const reports = (await sent(page, 'layout:split')).length;
  await page.evaluate((tabs) => window.__emit('tabs', { activeId: 6, split: { left: 5, right: 6, ratio: 0.5 }, tabs }), SPLIT_TABS);
  assert.deepEqual(await page.$$eval('.pane.focused', (els) => els.map((e) => e.dataset.id)), ['6']);
  await page.waitForTimeout(80);
  assert.equal((await sent(page, 'layout:split')).length, reports);
  // Separated: the panes go.
  await page.evaluate((tabs) => window.__emit('tabs', { activeId: 6, split: null, tabs }), TABS);
  assert.equal(await page.isVisible('#split'), false);
  assert.equal(await page.evaluate(() => document.getElementById('slot').classList.contains('split')), false);
  assert.deepEqual(errors, []);
});

test('split view: drag the divider or use the keyboard to resize', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await open({ init: SPLIT });
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'layout:split'));
  const d = await box(page, '.split-divider');
  const slot = await box(page, '#slot');
  await page.mouse.move(d.left + d.width / 2, d.top + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(slot.left + slot.width * 0.3, d.top + d.height / 2, { steps: 6 });
  await page.waitForFunction(() => { const r = window.__sent.filter(([c]) => c === 'layout:split').at(-1)[1]; return r.a.width < r.b.width * 0.6; });
  await page.mouse.up();
  const ratio = await lastSent(page, 'tab:split-ratio');
  assert.equal(ratio.id, 5);
  assert.ok(ratio.ratio > 0.25 && ratio.ratio < 0.35, `ratio ${ratio.ratio}`);
  // Never narrower than a side's minimum.
  await page.mouse.move(d.left + 2, d.top + 20);
  await page.mouse.down();
  await page.mouse.move(slot.left + 5, d.top + 20, { steps: 4 });
  await page.mouse.up();
  const r = await lastSent(page, 'layout:split');
  assert.ok(r.a.width >= 255, `left side ${r.a.width}px`);
  // Keyboard: arrows, Enter evens it out.
  await page.focus('.split-divider');
  await page.keyboard.press('Enter');
  assert.equal((await lastSent(page, 'tab:split-ratio')).ratio, 0.5);
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(Math.round((await lastSent(page, 'tab:split-ratio')).ratio * 100), 60);
  assert.equal(await page.getAttribute('.split-divider', 'aria-valuenow'), '60');
  await page.dblclick('.split-divider');
  assert.equal((await lastSent(page, 'tab:split-ratio')).ratio, 0.5);
  assert.deepEqual(errors, []);
});

test('split view: a tab dragged onto the page’s edge previews the split and makes it', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const init = { ...INIT, tabLayout: { vertical: false, collapsed: false } };
  const { page, errors } = await open({ init });
  await page.waitForSelector('#tabs .tab');
  // Pressing “Best Buy” makes it the active tab (main answers with new tab state).
  await page.evaluate(() => {
    const send = window.lumio.send;
    window.lumio.send = (c, p) => {
      send(c, p);
      if (c === 'tab:activate') window.__emit('tabs', { activeId: p, split: null, tabs: window.__tabs });
    };
  });
  await page.evaluate((tabs) => { window.__tabs = tabs; }, TABS);
  const tabEl = (await page.$$('#tabs .tab'))[3];
  const t = await tabEl.boundingBox();
  const slot = await box(page, '#slot');
  await page.mouse.move(t.x + 30, t.y + t.height / 2);
  await page.mouse.down();
  // Along the strip, then down at the page's right edge (the middle of the
  // page tears the tab off into a window: batch 4).
  await page.mouse.move(slot.right - 30, t.y + t.height / 2, { steps: 6 });
  assert.equal(await page.isVisible('#split'), false, 'the strip isn’t a drop zone');
  await page.mouse.move(slot.right - 30, slot.top + 220, { steps: 6 });
  await page.waitForFunction(() => document.getElementById('split').classList.contains('preview'));
  const preview = await lastSent(page, 'layout:split-preview');
  const right = await box(page, '.pane[data-side="right"] .pane-body');
  assert.equal(Math.round(preview.x), Math.round(right.left), 'the dragged page takes the right half');
  assert.match(await page.textContent('.pane[data-side="left"]'), /How bikes work.*Let go to show these side by side/s);
  assert.match(await page.textContent('.pane[data-side="right"] .pane-title'), /Best Buy/);
  await page.mouse.up();
  assert.deepEqual(await lastSent(page, 'tab:split'), { id: 4, base: 3, side: 'right' });
  assert.equal((await sent(page, 'tab:move')).length, 0, 'the strip didn’t reorder');
  // Dragging back out of the zone puts the page back.
  await page.evaluate((tabs) => window.__emit('tabs', { activeId: 4, split: null, tabs }), TABS);
  await page.mouse.move(t.x + 30, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(slot.left + 20, t.y + t.height / 2, { steps: 6 });
  await page.mouse.move(slot.left + 20, slot.top + 200, { steps: 6 });
  await page.waitForFunction(() => document.getElementById('split').classList.contains('preview'));
  // (Into the middle of the page: no split; the tab comes out into a window of its own, batch 4.)
  await page.mouse.move(slot.left + slot.width / 2, slot.top + 200, { steps: 4 });
  await page.waitForFunction(() => document.getElementById('split').hidden);
  assert.equal(await lastSent(page, 'layout:split-preview'), null);
  await page.mouse.up();
  assert.equal((await sent(page, 'tab:split')).length, 1);
  assert.deepEqual(errors, []);
});

test('light and dark: the tabs column, the panes and the flyout use the theme', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  for (const scheme of ['light', 'dark']) {
    const init = { ...SPLIT, tabLayout: { vertical: true, collapsed: false } };
    const { page, errors } = await open({ init, colorScheme: scheme });
    await page.waitForFunction(() => window.__sent.some(([c]) => c === 'layout:split'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `tab-layout-${scheme}.png`) });
    const c = await readColors(page, { tokens: ['--bg', '--tab-active', '--text', '--dim'], parts: ['#vtabs .vt-tab.active', '.pane-body'] });
    for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.7 : luminance(rgb) < 0.05, `${part} is ${scheme} (rgb ${rgb})`);
    for (const text of ['--text', '--dim']) assert.ok(contrast(c.tokens[text], c.tokens['--tab-active']) >= 4.5, `${scheme}: ${text} on the active tab`);
    assert.deepEqual(errors, []);
    await page.close();
    const fly = await open({ page: 'overlay/', colorScheme: scheme });
    await fly.page.evaluate((tabs) => window.__emit('overlay-data', { kind: 'vtabs', tabs, activeId: 3 }), TABS);
    const card = await readColors(fly.page, { tokens: [], parts: ['#card'] });
    assert.ok(scheme === 'light' ? luminance(card.parts['#card']) > 0.7 : luminance(card.parts['#card']) < 0.05, `flyout is ${scheme}`);
    if (SHOTS) await fly.page.screenshot({ path: path.join(SHOTS, `tab-flyout-${scheme}.png`) });
    assert.deepEqual(fly.errors, []);
    await fly.page.close();
  }
});
