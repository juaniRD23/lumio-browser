// Tab groups, saved groups and the side panel in the window, in headless
// Chrome with a stand-in for the main process: group chips in the tab strip
// (shell.html), the group editor (overlay.html), saved groups on the
// bookmarks bar, and the side panel's switcher with its Reading list,
// Bookmarks and History views, in light and dark. Skipped when Google Chrome
// isn't installed. LUMIO_SHOTS=<dir> saves screenshots to look at.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const SHOTS = process.env.LUMIO_SHOTS;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const tab = (id, title, extra = {}) => ({ id, title, url: `https://${title.toLowerCase()}.example/`, ...extra });
const GROUPS = [
  { id: 'gA', title: 'Trip', color: 'blue', collapsed: false, savedId: null, count: 2 },
  { id: 'gB', title: '', color: 'yellow', collapsed: true, savedId: 's1', count: 1 },
];
const TABS = {
  activeId: 1,
  tabs: [tab(1, 'Mail', { pinned: true }), tab(2, 'Flights', { groupId: 'gA' }), tab(3, 'Hotels', { groupId: 'gA' }), tab(4, 'News'), tab(5, 'Recipes', { groupId: 'gB' }), tab(6, 'Docs')],
  groups: GROUPS,
};
const SAVED = [{ id: 's1', title: 'Cooking', color: 'green', count: 3, open: true }, { id: 's2', title: '', color: 'purple', count: 2, open: false }];
const INIT = {
  tabs: TABS, downloads: [], panel: { open: true, width: 380 }, ai: AI,
  bookmarks: { show: true, items: [{ id: 'a1', title: 'Alpha', url: 'https://alpha.example/' }], other: { id: 'other', title: 'Other bookmarks', children: [] }, mobile: null, folders: [], recent: [] },
  savedGroups: SAVED, side: { view: 'ai', unread: 2 },
  account: { signedIn: true, name: 'T', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
const NOW = Date.now();
const READING = { items: [
  { id: 'r1', url: 'https://blog.example/post', title: 'A long read about tab groups', favicon: null, added: NOW - 5 * 60000, read: false },
  { id: 'r2', url: 'https://news.example/story', title: 'Morning news', favicon: null, added: NOW - 3 * 3600000, read: false },
  { id: 'r3', url: 'https://old.example/', title: 'Something I read', favicon: null, added: NOW - 3 * 86400000, read: true },
], unread: 2, canAdd: true };
const BOOKMARKS = { roots: [
  { id: 'bar', title: 'Bookmarks bar', children: [{ id: 'a1', title: 'Alpha', url: 'https://alpha.example/' }, { id: 'f1', title: 'Work', children: [{ id: 'j1', title: 'Jira', url: 'https://jira.example/' }] }] },
  { id: 'other', title: 'Other bookmarks', children: [{ id: 'o1', title: 'Elsewhere', url: 'https://elsewhere.example/' }] },
  { id: 'mobile', title: 'Mobile bookmarks', children: [] },
] };
const HISTORY = { items: [
  { url: 'https://today.example/', title: 'Today’s page', time: NOW - 60000, favicon: null },
  { url: 'https://older.example/', title: 'An older page', time: NOW - 5 * 86400000, favicon: null },
] };

function serve() {
  return http.createServer((req, res) => {
    const url = new URL(`lumio://shell${req.url}`);
    const file = resolveFile(url, new Set(['shell']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
}

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = serve();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

async function open(url, { answers = {}, colorScheme = 'light', viewport = { width: 1280, height: 800 } } = {}) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript((answers) => {
    const handlers = {};
    window.__calls = [];
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window.lumio = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); const a = answers[channel]; return a === undefined ? null : structuredClone(typeof a === 'object' && a?.__byArg ? a[args[0]] : a); },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, answers);
  await page.goto(url);
  return { page, errors };
}
const lastSent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).at(-1)?.[1] ?? null, channel);
const sentAll = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

const SIDE = { __byArg: true, reading: READING, bookmarks: BOOKMARKS, history: HISTORY };
async function openShell(opts = {}) {
  const r = await open(`${base}/`, { answers: { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] }, 'side:data': SIDE }, ...opts });
  await r.page.waitForFunction(() => document.getElementById('mode-name')?.textContent === 'Ask', null, { timeout: 10_000 }).catch(() => {});
  await r.page.waitForTimeout(150);
  return r;
}

// ---------------------------------------------------------------- tab groups
test('tab groups: chips before their tabs, a colored line, collapse, the editor and moving a group', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await openShell({ colorScheme });
    // Order: the pinned tab, Trip's chip, its two tabs, News, the unnamed group's dot, its (hidden) tab, Docs.
    const order = await page.$$eval('#tabs > *', (els) => els.map((e) => (e.classList.contains('tab-group-chip') ? `[${e.dataset.group}]` : e.querySelector('.title').textContent)));
    assert.deepEqual(order, ['Mail', '[gA]', 'Flights', 'Hotels', 'News', '[gB]', 'Recipes', 'Docs']);
    assert.equal(await page.textContent('[data-group="gA"]'), 'Trip');
    assert.equal(await page.getAttribute('[data-group="gA"]', 'aria-label'), 'Trip, 2 tabs, expanded');
    assert.equal(await page.getAttribute('[data-group="gB"]', 'aria-label'), 'Unnamed group, 1 tab, collapsed');
    assert.ok(await page.$eval('[data-group="gB"]', (el) => el.classList.contains('untitled')));
    // The collapsed group's tab folds away and can't be reached; the others show a line in the group's color.
    await page.waitForTimeout(250);
    assert.equal(await page.$eval('.tab[data-id="5"]', (el) => Math.round(el.getBoundingClientRect().width)), 0);
    assert.equal(await page.$eval('.tab[data-id="5"]', (el) => el.inert), true);
    const line = await page.$eval('.tab[data-id="2"]', (el) => getComputedStyle(el, '::after').backgroundColor);
    const chip = await page.$eval('[data-group="gA"]', (el) => getComputedStyle(el).backgroundColor);
    assert.equal(line, chip, 'the line is the chip’s color');
    // The chip's name is readable on its color.
    const c = await page.$eval('[data-group="gA"]', (el) => { const s = getComputedStyle(el); return [s.color, s.backgroundColor]; });
    const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
    assert.ok(contrast(rgb(c[0]), rgb(c[1])) >= 4.5, `chip text contrast in ${colorScheme}`);
    await shot(page, `groups-strip-${colorScheme}`);

    // Click: collapse (or expand); right-click: the editor under the chip.
    await page.click('[data-group="gA"]');
    assert.deepEqual(await lastSent(page, 'groups:update'), { id: 'gA', collapsed: true });
    await page.click('[data-group="gA"]', { button: 'right' });
    const shown = await lastSent(page, 'overlay:show');
    assert.equal(shown.payload.kind, 'tab-group');
    assert.deepEqual(shown.payload.group, { id: 'gA', title: 'Trip', color: 'blue', saved: false, count: 2 });
    assert.equal(shown.payload.canMove, true);
    const r = await page.$eval('[data-group="gA"]', (el) => el.getBoundingClientRect().toJSON());
    assert.ok(Math.abs(shown.payload.anchor.left - r.left) < 1 && shown.rect.y >= r.bottom);
    await page.evaluate(() => window.__emit('overlay-picked', { kind: 'tab-group', refocus: true }));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.group), 'gA', 'Esc gives the chip the focus back');
    // The keyboard: the context menu key opens the editor and gives it the keys.
    await page.keyboard.press('Shift+F10');
    assert.equal((await lastSent(page, 'overlay:show')).payload.kind, 'tab-group');
    assert.ok((await sentAll(page, 'groups:overlay-focus')).length >= 2);
    // A new group from the tab menu: main asks for its editor.
    await page.evaluate(() => window.__emit('overlay-picked', { kind: 'tab-group' }));
    await page.evaluate(() => window.__emit('tab-group-edit', { id: 'gA' }));
    assert.equal((await lastSent(page, 'overlay:show')).payload.group.id, 'gA');
    await page.evaluate(() => window.__emit('overlay-picked', { kind: 'tab-group' }));

    // Dragging the chip moves the whole group: dropped past News, it goes after it (before the next group).
    const at = await page.evaluate(() => {
      const mid = (el) => { const b = el.getBoundingClientRect(); return (b.left + b.right) / 2; };
      const block = (document.querySelector('[data-group="gA"]').getBoundingClientRect().left + document.querySelector('.tab[data-id="3"]').getBoundingClientRect().right) / 2;
      return (mid(document.querySelector('.tab[data-id="4"]')) + mid(document.querySelector('[data-group="gB"]'))) / 2 - block;
    });
    await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.left + r.width / 2 + 10, r.top + 5, { steps: 3 });
    await page.mouse.move(r.left + r.width / 2 + at, r.top + 5, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await lastSent(page, 'groups:move'), { id: 'gA', before: 5 });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('dragging a tab sends its new place in the strip, counting the tabs hidden in a collapsed group', { skip }, async () => {
  const { page, errors } = await openShell();
  const docs = await page.$eval('.tab[data-id="6"]', (el) => el.getBoundingClientRect().toJSON());
  const news = await page.$eval('.tab[data-id="4"]', (el) => el.getBoundingClientRect().toJSON());
  await page.mouse.move(docs.left + docs.width / 2, docs.top + 10);
  await page.mouse.down();
  await page.mouse.move(news.left + 10, news.top + 10, { steps: 8 });
  await page.mouse.up();
  // Docs (index 5) dropped on News (index 3): it goes to News's place.
  assert.deepEqual(await lastSent(page, 'tab:move'), { id: 6, index: 3 });
  assert.deepEqual(errors, []);
  await page.close();
});

test('the group editor: name, nine colors with arrow keys, and its actions; readable in light and dark', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open(`${base}/overlay.html`, { colorScheme });
    await page.waitForFunction(() => typeof window.__emit === 'function');
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__emit('overlay-data', { kind: 'tab-group', group: { id: 'gA', title: 'Trip', color: 'blue', saved: false, count: 2 }, canMove: true, canSave: true, anchor: { left: 120 } }));
    assert.equal(await page.isVisible('#card'), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tg-name');
    assert.equal(await page.inputValue('#tg-name'), 'Trip');
    assert.equal(await page.$$eval('.tg-color', (els) => els.length), 9);
    assert.equal(await page.getAttribute('.tg-color[aria-checked="true"]', 'data-color'), 'blue');
    assert.deepEqual(await page.$$eval('.tg-row', (els) => els.map((e) => e.textContent)), ['New tab in group', 'Save group', 'Ungroup', 'Delete group', 'Move group to new window']);
    await shot(page, `group-editor-${colorScheme}`);
    // Typing a name sends it a moment later.
    await page.fill('#tg-name', 'Summer trip');
    await page.waitForTimeout(400);
    assert.deepEqual(await lastSent(page, 'groups:update'), { id: 'gA', title: 'Summer trip' });
    // Colors: a click, then the arrow keys.
    await page.click('.tg-color[data-color="red"]');
    assert.deepEqual(await lastSent(page, 'groups:update'), { id: 'gA', color: 'red' });
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await lastSent(page, 'groups:update'), { id: 'gA', color: 'yellow' });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.color), 'yellow');
    // The rows' text is readable.
    const colors = await readColors(page, { tokens: ['--text', '--popover'] });
    assert.ok(contrast(colors.tokens['--text'], colors.tokens['--popover']) >= 4.5);
    // An action, then the editor closes.
    await page.click('.tg-row[data-act="new-tab"]');
    assert.deepEqual(await lastSent(page, 'groups:action'), { id: 'gA', action: 'new-tab' });
    assert.equal((await lastSent(page, 'overlay:pick')).kind, 'tab-group');
    // Esc closes it and the focus goes back to the chip.
    await page.evaluate(() => window.__emit('overlay-data', { kind: 'tab-group', group: { id: 'gA', title: 'Trip', color: 'blue', saved: true, count: 2 }, canMove: false, canSave: true, anchor: { left: 120 } }));
    assert.deepEqual(await page.$$eval('.tg-row', (els) => els.map((e) => e.textContent)), ['New tab in group', 'Unsave group', 'Ungroup', 'Close group']);
    await page.keyboard.press('Escape');
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'tab-group', refocus: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('saved groups sit at the bookmarks bar’s left end and open in one click', { skip }, async () => {
  const { page, errors } = await openShell();
  assert.deepEqual(await page.$$eval('.bm-groups .bm-sg span', (els) => els.map((e) => e.textContent)), ['Cooking', '2 tabs']);
  assert.equal(await page.getAttribute('[data-sg="s1"]', 'aria-label'), 'Cooking, saved tab group, open');
  await page.click('[data-sg="s2"]');
  assert.equal(await lastSent(page, 'groups:open-saved'), 's2');
  await page.click('[data-sg="s1"]', { button: 'right' });
  assert.equal(await lastSent(page, 'groups:saved-context'), 's1');
  assert.equal(await lastSent(page, 'bookmarks:context'), null, 'not the bookmarks menu');
  // A new list from the main process redraws them.
  await page.evaluate(() => window.__emit('saved-groups', []));
  assert.equal(await page.$$eval('.bm-sg', (els) => els.length), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------------------------------------------------------------- the side panel
test('side panel: the switcher shares the panel with Lumio AI; reading list, bookmarks and history views', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await openShell({ colorScheme });
    // The switcher: Lumio AI selected, the reading list shows its unread count; Reading mode comes with the page tools (batch 7b).
    assert.deepEqual(await page.$$eval('.ss-tab', (els) => els.map((e) => e.dataset.view)), ['ai', 'reading', 'bookmarks', 'history', 'reader']);
    assert.equal(await page.getAttribute('.ss-tab[data-view="ai"]', 'aria-selected'), 'true');
    assert.equal(await page.getAttribute('.ss-tab[data-view="reading"]', 'aria-label'), 'Reading list, 2 unread');
    assert.equal(await page.isVisible('#messages'), true);

    // Reading list: unread and read sections; the chat steps aside.
    await page.click('.ss-tab[data-view="reading"]');
    await page.waitForSelector('.sv-row[data-rid="r1"]');
    assert.equal(await page.getAttribute('.sv-row[data-rid="r1"]', 'tabindex'), '0', 'Tab reaches the list');
    assert.equal(await page.isVisible('#messages'), false);
    assert.equal(await page.isVisible('#composer'), false);
    assert.deepEqual(await lastSent(page, 'side:set'), { view: 'reading' });
    assert.deepEqual(await page.$$eval('.sv-sec', (els) => els.map((e) => e.textContent)), ['Unread', 'Read']);
    assert.match(await page.textContent('.sv-row[data-rid="r1"] .sv-s'), /blog\.example · 5 min ago/);
    await shot(page, `side-reading-${colorScheme}`);
    await page.click('.sv-row[data-rid="r2"] .sv-t');
    assert.deepEqual(await lastSent(page, 'side:open'), { url: 'https://news.example/story', disposition: 'current', readingId: 'r2' });
    await page.hover('.sv-row[data-rid="r1"]');
    await page.click('.sv-row[data-rid="r1"] [data-ract="read"]');
    assert.deepEqual(await lastSent(page, 'side:reading'), { action: 'read', id: 'r1' });
    await page.click('.sv-add');
    assert.deepEqual(await lastSent(page, 'side:reading'), { action: 'add-current' });
    // Keys: ↓ moves along the rows, Delete removes one and offers Undo.
    await page.focus('.sv-row[data-rid="r1"]');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.rid), 'r2');
    await page.keyboard.press('Delete');
    assert.deepEqual(await lastSent(page, 'side:reading'), { action: 'remove', id: 'r2' });
    await page.evaluate(() => window.__emit('side-changed', { view: 'reading', unread: 1 }));
    await page.waitForSelector('[data-undo]');
    await page.click('[data-undo]');
    const undo = await lastSent(page, 'side:reading');
    assert.equal(undo.action, 'restore');
    assert.deepEqual([undo.item.id, undo.item.url], ['r2', 'https://news.example/story']);

    // Bookmarks: a tree (the bar's folder open), search shows matches.
    await page.click('.ss-tab[data-view="bookmarks"]');
    await page.waitForSelector('.sv-folder');
    assert.deepEqual(await page.$$eval('.sv-tree > .sv-folder > summary .sv-t', (els) => els.map((e) => e.textContent)), ['Bookmarks bar', 'Other bookmarks']);
    await shot(page, `side-bookmarks-${colorScheme}`);
    await page.fill('.sv-search', 'jir');
    await page.waitForFunction(() => document.querySelectorAll('.sv-row[data-url]').length === 1);
    assert.equal(await page.textContent('.sv-row[data-url] .sv-t'), 'Jira');
    await page.click('.sv-row[data-url] .sv-t', { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    assert.deepEqual(await lastSent(page, 'side:open'), { url: 'https://jira.example/', disposition: 'background' });

    // History: grouped by day, with a search box.
    await page.click('.ss-tab[data-view="history"]');
    await page.waitForSelector('.sv-row[data-url="https://today.example/"]');
    assert.deepEqual((await page.$$eval('.sv-sec', (els) => els.map((e) => e.textContent)))[0], 'Today');
    await shot(page, `side-history-${colorScheme}`);
    const colors = await readColors(page, { tokens: ['--label', '--panel', '--text'] });
    assert.ok(contrast(colors.tokens['--label'], colors.tokens['--panel']) >= 4.5, 'times and sites are readable');

    // Lumio AI's button goes back to the chat without closing the panel; asking Lumio does too.
    await page.click('#ai-toggle');
    assert.equal(await page.getAttribute('.ss-tab[data-view="ai"]', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.body.classList.contains('panel-closed')), false);
    // The toolbar's side panel button opens the last view; again hides the panel.
    await page.click('#side-btn');
    assert.equal(await page.getAttribute('.ss-tab[data-view="history"]', 'aria-selected'), 'true');
    assert.equal(await page.getAttribute('#side-btn', 'aria-pressed'), 'true');
    await page.click('#side-btn');
    assert.equal(await page.evaluate(() => document.body.classList.contains('panel-closed')), true);
    // With the panel hidden, Lumio AI's button opens it on the chat, not the last view.
    await page.click('#ai-toggle');
    assert.equal(await page.evaluate(() => document.body.classList.contains('panel-closed')), false);
    assert.equal(await page.getAttribute('.ss-tab[data-view="ai"]', 'aria-selected'), 'true');
    // So does its shortcut (main sends panel-toggle).
    await page.click('#side-btn');
    await page.click('#side-btn');
    await page.evaluate(() => window.__emit('panel-toggle'));
    assert.equal(await page.evaluate(() => document.body.classList.contains('panel-closed')), false);
    assert.equal(await page.getAttribute('.ss-tab[data-view="ai"]', 'aria-selected'), 'true');
    // The bookmarks bar's "All bookmarks" (main says which view).
    await page.evaluate(() => window.__emit('side-panel', { view: 'bookmarks' }));
    assert.equal(await page.evaluate(() => document.body.classList.contains('panel-closed')), false);
    assert.equal(await page.getAttribute('.ss-tab[data-view="bookmarks"]', 'aria-selected'), 'true');
    await page.evaluate(() => window.__emit('ai-focus'));
    assert.equal(await page.getAttribute('.ss-tab[data-view="ai"]', 'aria-selected'), 'true');
    // Arrow keys move along the switcher.
    await page.focus('.ss-tab[data-view="ai"]');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('.ss-tab[data-view="reading"]', 'aria-selected'), 'true');
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('side panel: the last view comes back, and another module can add Reading mode', { skip }, async () => {
  const { page, errors } = await openShell({ answers: { 'shell:init': { ...INIT, side: { view: 'history', unread: 0 } }, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] }, 'side:data': SIDE } });
  assert.equal(await page.getAttribute('.ss-tab[data-view="history"]', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('.ss-tab[data-view="reading"]', 'aria-label'), 'Reading list');
  await page.evaluate(async () => {
    const { registerSideView } = await import('/side-panel.js');
    registerSideView('reader', { label: 'Reading mode', render: (el) => { el.innerHTML = '<p id="reader-here">Reader</p>'; } });
  });
  await page.click('.ss-tab[data-view="reader"]');
  assert.equal(await page.isVisible('#reader-here'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the star’s bubble offers Add to reading list (not when editing from the bar)', { skip }, async () => {
  const { page, errors } = await open(`${base}/overlay.html`);
  await page.waitForFunction(() => typeof window.__emit === 'function');
  const bubble = (reading) => ({ kind: 'bm-edit', node: { id: 'j1', title: 'Jira', url: 'https://jira.example/', folder: false }, parentId: 'bar', heading: 'Bookmark added', editUrl: false, folders: [{ id: 'bar', title: 'Bookmarks bar', depth: 0 }], recent: [], anchor: { left: 900, right: 930, align: 'right' }, reading });
  await page.evaluate((b) => window.__emit('overlay-data', b), bubble(false));
  assert.equal(await page.$('[data-act="reading"]'), null);
  await page.evaluate((b) => window.__emit('overlay-data', b), bubble(true));
  await page.click('[data-act="reading"]');
  assert.deepEqual(await lastSent(page, 'side:reading'), { action: 'add-current' });
  assert.equal((await lastSent(page, 'overlay:pick')).kind, 'bm-edit', 'and the bubble closes');
  assert.deepEqual(errors, []);
  await page.close();
});

// Seam: batch 7b's reading mode in batch 5's side panel switcher.
test('side panel: Reading mode shows the tab you’re on, in the panel, and leaves the toolbar’s own column closed', { skip }, async () => {
  const article = { ok: true, tabId: 1, url: 'https://mail.example/', prefs: { font: 'sans', size: 17, spacing: 'normal', theme: 'auto', speed: 1 }, article: { title: 'A calm article', byline: 'By Ana', siteName: 'Mail', lang: 'en', dir: 'ltr', length: 400, content: '<p>First paragraph of the article.</p><p>Second one.</p>' } };
  const { page, errors } = await openShell({ answers: { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] }, 'side:data': SIDE, 'reader:article': article } });
  await page.click('.ss-tab[data-view="reader"]');
  await page.waitForSelector('#side-view .rd-side .rd-article p');
  assert.match(await page.textContent('#side-view .rd-article'), /First paragraph of the article/);
  assert.deepEqual(await lastSent(page, 'side:set'), { view: 'reader' });
  assert.equal(await page.isVisible('#messages'), false, 'the chat steps aside');
  assert.equal(await page.$eval('#reader', (el) => el.classList.contains('closed')), true, 'the toolbar’s reading column stays closed');
  // Another tab: the view follows it.
  const calls = () => page.evaluate(() => window.__calls.filter(([c]) => c === 'reader:article').length);
  const before = await calls();
  await page.evaluate((t) => window.__emit('tabs', { ...t, activeId: 4 }), TABS);
  await page.waitForFunction((n) => window.__calls.filter(([c]) => c === 'reader:article').length > n, before);
  // Back to the reading list: the reading view goes.
  await page.click('.ss-tab[data-view="reading"]');
  await page.waitForSelector('.sv-row[data-rid="r1"]');
  assert.equal(await page.$('#side-view .rd-side'), null);
  await shot(page, 'side-panel-reader');
  await page.close();
  assert.deepEqual(errors, []);
});
