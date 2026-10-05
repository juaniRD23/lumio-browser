// Bookmarks in the window and on Lumio's pages, in headless Chrome with a
// stand-in for the main process: the bookmarks bar's folders, » and keys
// (shell.html), the folder menus and the star's bubble (overlay.html), the
// bookmark manager (bookmarks.html) and the new tab page's shortcuts
// (newtab.html), in light and dark. Skipped when Google Chrome isn't
// installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contrast, readColors, luminance } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const OURS = 'application/x-lumio-bookmarks';

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' }] },
  downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'T', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
const mark = (id, title) => ({ id, title, url: `https://${id}.example/`, favicon: null });
// What the main process sends the window (main/bookmarks-service.js payload()).
const BAR = {
  show: true,
  items: [mark('a1', 'Alpha'), { id: 'f1', title: 'Work', children: [mark('j1', 'Jira'), { id: 'f2', title: 'Deep', children: [mark('d1', 'Deep page')] }] }, mark('c3', 'Gamma')],
  other: { id: 'other', title: 'Other bookmarks', children: [mark('o1', 'Elsewhere')] },
  mobile: { id: 'mobile', title: 'Mobile bookmarks', children: [] },
  folders: [{ id: 'bar', title: 'Bookmarks bar', depth: 0 }, { id: 'f1', title: 'Work', depth: 1 }, { id: 'f2', title: 'Deep', depth: 2 }, { id: 'other', title: 'Other bookmarks', depth: 0 }, { id: 'mobile', title: 'Mobile bookmarks', depth: 0 }],
  recent: ['f2'],
};

function serve(host, hosts) {
  return http.createServer((req, res) => {
    const url = new URL(`lumio://${host}${req.url}`);
    const file = resolveFile(url, hosts);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
}

let ui, pages, browser, uiBase, pagesBase;
before(async () => {
  if (!CHROME) return;
  ui = serve('shell', new Set(['shell']));
  pages = serve('bookmarks', PAGE_HOSTS);
  await Promise.all([ui, pages].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  uiBase = `http://127.0.0.1:${ui.address().port}`;
  pagesBase = `http://127.0.0.1:${pages.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); ui?.close(); pages?.close(); });

// A page with a stand-in main process. `answers` maps channels to values or
// to function bodies ("fn:…", run with the call's arguments); calls are in
// window.__calls, messages sent in window.__sent; `init` runs first.
async function open(url, { answers = {}, colorScheme = 'light', bridge = 'lumio', init, viewport = { width: 1280, height: 800 } } = {}) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript(({ answers, bridge, init }) => {
    const handlers = {};
    window.__calls = [];
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    if (init) (0, eval)(init);
    const fns = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('fn:') ? new Function('...args', v.slice(3)) : () => structuredClone(v)]));
    window[bridge] = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return fns[channel] ? structuredClone(fns[channel](...args) ?? null) : null; },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { answers, bridge, init });
  await page.goto(url);
  return { page, errors };
}
const lastSent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).at(-1)?.[1] ?? null, channel);
const sentCount = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).length, channel);
const calls = (page, channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map(([, ...args]) => args), channel);
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function openShell(opts = {}) {
  const r = await open(`${uiBase}/`, { answers: { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] } }, ...opts });
  await r.page.waitForFunction(() => document.getElementById('mode-name')?.textContent === 'Ask', null, { timeout: 10_000 }).catch(() => {});
  await r.page.evaluate((b) => window.__emit('bookmarks', b), BAR);
  return r;
}

// ---------------------------------------------------------------- the bar
test('bar: folders open their menu, Other and All bookmarks at the end, » lists what doesn’t fit, and the keys', { skip }, async () => {
  const { page, errors } = await openShell();
  assert.deepEqual(await page.$$eval('.bm-items .bm-item span', (els) => els.map((e) => e.textContent)), ['Alpha', 'Work', 'Gamma']);
  assert.deepEqual(await page.$$eval('.bm-end .bm-item', (els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim())), ['Other bookmarks', 'All bookmarks']);
  assert.equal(await page.getAttribute('[data-id="f1"]', 'aria-haspopup'), 'menu');

  // A folder opens its menu in the overlay, under it.
  await page.click('[data-id="f1"]');
  let shown = await lastSent(page, 'overlay:show');
  assert.equal(shown.payload.kind, 'bm-menu');
  assert.equal(shown.payload.folder.id, 'f1');
  assert.deepEqual(shown.payload.folder.children.map((c) => c.title), ['Jira', 'Deep']);
  const btn = await page.$eval('[data-id="f1"]', (el) => el.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(shown.payload.anchor.left - btn.left) < 1 && shown.rect.y >= btn.bottom, 'under the folder');
  assert.equal(await page.getAttribute('[data-id="f1"]', 'aria-expanded'), 'true');
  // Clicking it again closes it; moving along the bar with one open switches menus.
  await page.click('[data-id="f1"]');
  assert.equal(await lastSent(page, 'overlay:hide'), 'bm-menu');
  await page.click('[data-id="f1"]');
  await page.hover('[data-id="other"]');
  assert.equal((await lastSent(page, 'overlay:show')).payload.folder.id, 'other');
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'bm-menu' }));
  assert.equal(await page.$$eval('#bookmarks-bar [aria-expanded="true"]', (els) => els.length), 0);
  // All bookmarks: the side panel (or the manager).
  await page.click('#bm-all');
  assert.equal(await sentCount(page, 'bookmarks:all'), 1);

  // Keys: the bar is one Tab stop; arrows move along it, Enter or ↓ opens a folder's menu with the keyboard.
  await page.focus('[data-id="a1"]');
  assert.deepEqual(await page.$$eval('#bookmarks-bar [tabindex="0"]', (els) => els.map((e) => e.dataset.id)), ['a1']);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'f1');
  await page.keyboard.press('ArrowDown');
  shown = await lastSent(page, 'overlay:show');
  assert.deepEqual([shown.payload.folder.id, shown.payload.keyboard], ['f1', true]);
  assert.equal(await sentCount(page, 'bookmarks:overlay-focus'), 1, 'the menu takes the keys');
  // Closed with Esc: the folder gets the focus back; → from the menu opens the next folder.
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'bm-menu', refocus: 'shell' }));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'f1');
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'bm-menu', refocus: 'shell', move: 1 }));
  assert.equal((await lastSent(page, 'overlay:show')).payload.folder.id, 'other');
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'bm-menu' }));
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bm-all');

  // Drops: onto a folder's middle, it goes inside (at the end); a link dropped there is added inside.
  const into = await page.evaluate((OURS) => {
    const f = document.querySelector('[data-id="f1"]').getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData(OURS, JSON.stringify({ ids: ['c3'] }));
    const at = { dataTransfer: dt, clientX: f.left + f.width / 2, clientY: f.top + f.height / 2, bubbles: true, cancelable: true };
    const bar = document.getElementById('bookmarks-bar');
    bar.dispatchEvent(new DragEvent('dragover', at));
    const marked = document.querySelector('[data-id="f1"]').classList.contains('drop-into');
    bar.dispatchEvent(new DragEvent('drop', at));
    return marked;
  }, OURS);
  assert.equal(into, true);
  assert.deepEqual(await lastSent(page, 'bookmarks:move'), { ids: ['c3'], parentId: 'f1', index: null });
  await page.evaluate(() => {
    const o = document.querySelector('[data-id="other"]').getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://new.example/');
    document.getElementById('bookmarks-bar').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: o.left + 10, clientY: o.top + 5, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await lastSent(page, 'bookmarks:add'), { url: 'https://new.example/', title: '', parentId: 'other', index: null });

  // A narrow window: what doesn't fit goes under », which opens as a menu that drops onto the bar.
  await page.evaluate(() => window.__emit('bookmarks', { show: true, items: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, title: `Bookmark number ${i}`, url: `https://m${i}.example/` })), other: { id: 'other', title: 'Other bookmarks', children: [] }, mobile: null, folders: [], recent: [] }));
  await frames(page);
  const hidden = await page.$$eval('.bm-items .bm-item[hidden]', (els) => els.map((e) => e.dataset.id));
  assert.ok(hidden.length > 5 && hidden.at(-1) === 'm29');
  assert.equal(await page.isVisible('#bm-more'), true);
  await page.click('#bm-more');
  shown = await lastSent(page, 'overlay:show');
  assert.deepEqual(shown.payload.folder.children.map((c) => c.id), hidden);
  assert.deepEqual([shown.payload.folder.dropParent, shown.payload.folder.offset], ['bar', 30 - hidden.length]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the star: a new bookmark opens its bubble under the star, named and in a folder', { skip }, async () => {
  const { page, errors } = await openShell();
  await page.evaluate((b) => window.__emit('bookmarks', { ...b, bubble: { id: 'j1', heading: 'Bookmark added' } }), BAR);
  const shown = await lastSent(page, 'overlay:show');
  assert.equal(shown.payload.kind, 'bm-edit');
  assert.deepEqual(shown.payload.node, { id: 'j1', title: 'Jira', url: 'https://j1.example/', folder: false });
  assert.deepEqual([shown.payload.parentId, shown.payload.heading, shown.payload.editUrl], ['f1', 'Bookmark added', false]);
  const star = await page.$eval('#star', (el) => el.getBoundingClientRect().toJSON());
  assert.equal(shown.payload.anchor.align, 'right');
  assert.ok(Math.abs(shown.payload.anchor.right - star.right) < 1 && shown.rect.y >= star.bottom);
  assert.equal(await sentCount(page, 'bookmarks:overlay-focus'), 1);
  // Edit… on a folder on the bar: points at it, and a folder can't go inside itself.
  await page.evaluate((b) => window.__emit('bookmarks', { ...b, bubble: { id: 'f1', heading: 'Edit folder', anchor: 'f1' } }), BAR);
  const folder = (await lastSent(page, 'overlay:show')).payload;
  assert.equal(folder.anchor.align, 'left');
  assert.deepEqual(folder.folders.map((f) => f.id), ['bar', 'other', 'mobile']);
  assert.deepEqual(folder.recent, []);
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------------------------------------------------------------- the overlay
const MENU = {
  kind: 'bm-menu',
  folder: { id: 'f1', title: 'Work', children: [mark('j1', 'Jira'), { id: 'f2', title: 'Deep', children: [mark('d1', 'Deep page'), mark('d2', 'Docs')] }, { id: 'f3', title: 'Empty', children: [] }, mark('k1', 'Kanban')] },
  anchor: { left: 200, right: 280 },
  keyboard: true,
};
async function openOverlay(colorScheme) {
  const r = await open(`${uiBase}/overlay.html`, { colorScheme });
  await r.page.waitForFunction(() => typeof window.__emit === 'function');
  await r.page.waitForTimeout(100);
  return r;
}
const active = (page) => page.evaluate(() => [...document.querySelectorAll('.bm-menu')].map((m) => m.querySelector('.bm-row.active .t')?.textContent || null));

test('folder menus: submenus, keys, type to find, open, drag in and out; readable in light and dark', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await openOverlay(colorScheme);
    await page.evaluate((m) => window.__emit('overlay-data', m), MENU);
    assert.equal(await page.isVisible('#card'), false, 'the dropdown card makes way');
    assert.deepEqual(await page.$$eval('.bm-menu .bm-row .t', (els) => els.map((e) => e.textContent)), ['Jira', 'Deep', 'Empty', 'Kanban']);
    assert.equal(await page.getAttribute('.bm-menu', 'role'), 'menu');
    const box = await page.$eval('.bm-menu', (el) => el.getBoundingClientRect().toJSON());
    assert.ok(Math.abs(box.left - 196) < 2, 'lined up with the folder on the bar');
    // Opened with the keyboard: the first row has the focus.
    assert.deepEqual(await active(page), ['Jira']);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Jira');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await active(page), ['Deep', 'Deep page'], 'a submenu, its first row');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await active(page), ['Deep'], '← closes the submenu');
    await page.keyboard.press('k');
    assert.deepEqual(await active(page), ['Kanban'], 'typing jumps to a name');
    await page.keyboard.press('Enter');
    assert.deepEqual(await lastSent(page, 'bookmarks:open'), { id: 'k1', disposition: 'current' });
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'bm-menu' });

    // The pointer: a folder opens after a moment; an empty one says so; ⌘-click opens in a background tab.
    await page.evaluate((m) => window.__emit('overlay-data', { ...m, keyboard: false }), MENU);
    await page.hover('.bm-menu .bm-row[data-i="2"]');
    await page.waitForFunction(() => document.querySelectorAll('.bm-menu').length === 2);
    assert.equal(await page.textContent('.bm-menu + .bm-menu'), '(empty)');
    await page.hover('.bm-menu .bm-row[data-i="1"]');
    await page.waitForFunction(() => document.querySelector('.bm-menu + .bm-menu')?.textContent.includes('Docs'));
    const sub = await page.$eval('.bm-menu + .bm-menu', (el) => el.getBoundingClientRect().toJSON());
    assert.ok(sub.left > box.left + box.width - 10, 'beside its parent');
    await page.click('.bm-menu + .bm-menu .bm-row[data-i="1"]', { modifiers: [MOD] });
    assert.deepEqual(await lastSent(page, 'bookmarks:open'), { id: 'd2', disposition: 'background' });
    // Esc and → at the top level hand the keys back to the bar.
    await page.evaluate((m) => window.__emit('overlay-data', m), MENU);
    await page.keyboard.press('Escape');
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'bm-menu', refocus: 'shell' });
    await page.evaluate((m) => window.__emit('overlay-data', m), MENU);
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'bm-menu', refocus: 'shell', move: 1 });
    // Right-click: the bookmark's menu. A click beside the menu closes it.
    await page.evaluate((m) => window.__emit('overlay-data', { ...m, keyboard: false }), MENU);
    await page.click('.bm-menu .bm-row[data-i="0"]', { button: 'right' });
    assert.equal(await lastSent(page, 'bookmarks:context'), 'j1');
    await page.mouse.click(900, 500);
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'bm-menu', refocus: 'page' });

    // Drag and drop: onto a folder's middle goes inside; on a row's lower half, after it.
    await page.evaluate((m) => window.__emit('overlay-data', { ...m, keyboard: false }), MENU);
    const drop = (from, to, f) => page.evaluate(({ from, to, f, OURS }) => {
      const rows = document.querySelectorAll('.bm-menu .bm-row');
      const dt = new DataTransfer();
      rows[from].dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      const r = rows[to].getBoundingClientRect();
      const at = { dataTransfer: dt, clientX: r.left + 20, clientY: r.top + r.height * f, bubbles: true, cancelable: true };
      rows[to].dispatchEvent(new DragEvent('dragover', at));
      const mark = rows[to].className;
      rows[to].dispatchEvent(new DragEvent('drop', at));
      return [JSON.parse(dt.getData(OURS)).ids, mark];
    }, { from, to, f, OURS });
    const [ids, into] = await drop(0, 1, 0.5);
    assert.deepEqual(ids, ['j1']);
    assert.match(into, /drop-into/);
    assert.deepEqual(await lastSent(page, 'bookmarks:move'), { ids: ['j1'], parentId: 'f2', index: null });
    await page.evaluate((m) => window.__emit('overlay-data', { ...m, keyboard: false }), MENU);
    await drop(3, 0, 0.8);
    assert.deepEqual(await lastSent(page, 'bookmarks:move'), { ids: ['k1'], parentId: 'f1', index: 1 });
    // » holds the end of the bar: drops there land on the bar.
    await page.evaluate((m) => window.__emit('overlay-data', m), { ...MENU, keyboard: false, folder: { id: 'overflow', title: 'More bookmarks', children: [mark('x1', 'X'), mark('y1', 'Y')], dropParent: 'bar', offset: 7 } });
    await drop(1, 0, 0.2);
    assert.deepEqual(await lastSent(page, 'bookmarks:move'), { ids: ['y1'], parentId: 'bar', index: 7 });

    // Readable on the menu's own background, light on a light computer and dark on a dark one.
    await page.evaluate((m) => window.__emit('overlay-data', { ...m, keyboard: false }), MENU);
    const c = await readColors(page, { tokens: ['--text', '--muted'], parts: ['.bm-menu'] });
    assert.ok(colorScheme === 'light' ? luminance(c.parts['.bm-menu']) > 0.8 : luminance(c.parts['.bm-menu']) < 0.05, `${colorScheme} menu`);
    assert.ok(contrast(c.tokens['--text'], c.parts['.bm-menu']) >= 4.5);
    assert.ok(contrast(c.tokens['--muted'], c.parts['.bm-menu']) >= 4.5, 'even (empty)');
    assert.deepEqual(errors, []);
    await page.close();
  }
});

const BUBBLE = {
  kind: 'bm-edit',
  node: { id: 'b2', title: 'Beta', url: 'https://b.example/', folder: false },
  parentId: 'bar',
  heading: 'Bookmark added',
  editUrl: false,
  folders: BAR.folders,
  recent: ['f2'],
  anchor: { left: 1180, right: 1210, align: 'right' },
};

test('the bookmark bubble: name, folder, Choose another folder…, new folder, Remove and Done', { skip }, async () => {
  const { page, errors } = await openOverlay('dark');
  await page.evaluate((b) => window.__emit('overlay-data', b), BUBBLE);
  assert.equal(await page.textContent('#bmb-h'), 'Bookmark added');
  assert.equal(await page.getAttribute('.bm-bubble', 'role'), 'dialog');
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionEnd]), ['bmb-name', 4], 'the name is ready to type over');
  const box = await page.$eval('.bm-bubble', (el) => el.getBoundingClientRect().toJSON());
  assert.ok(box.right <= 1280 - 8 && box.right > 1150, 'under the star, inside the window');
  // The folder menu: the bar, Other bookmarks, folders used lately, then Choose another folder….
  assert.deepEqual(await page.$$eval('#bmb-folder option', (els) => els.map((o) => o.textContent)), ['Bookmarks bar', 'Other bookmarks', 'Deep', '──────────', 'Choose another folder…']);
  assert.equal(await page.$eval('#bmb-folder', (s) => s.value), 'bar');
  // Typing renames as you go.
  await page.keyboard.press('End');
  await page.keyboard.type(' two');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'bookmarks:edit' && p.title === 'Beta two'));
  // Another folder moves it.
  await page.selectOption('#bmb-folder', 'f2');
  assert.deepEqual(await lastSent(page, 'bookmarks:edit'), { id: 'b2', title: 'Beta two', parentId: 'f2' });
  // Choose another folder…: every folder as a tree; ↓ picks the next; Save moves it there.
  await page.selectOption('#bmb-folder', '__choose');
  assert.equal(await page.isVisible('.bmb-tree'), true);
  assert.equal(await page.textContent('#bmb-h'), 'Choose a folder');
  assert.deepEqual(await page.$$eval('.bmb-folder', (els) => els.map((e) => [e.textContent, e.getAttribute('aria-level')])), [['Bookmarks bar', '1'], ['Work', '2'], ['Deep', '3'], ['Other bookmarks', '1'], ['Mobile bookmarks', '1']]);
  assert.equal(await page.getAttribute('.bmb-folder.on', 'data-id'), 'f2');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getAttribute('.bmb-folder.on', 'data-id'), 'other');
  await page.click('[data-act=save]');
  assert.deepEqual(await lastSent(page, 'bookmarks:edit'), { id: 'b2', title: 'Beta two', parentId: 'other' });
  assert.equal(await page.$eval('#bmb-folder', (s) => s.value), 'other');
  // New folder: made inside the chosen one, and the bookmark goes in it.
  await page.selectOption('#bmb-folder', '__choose');
  await page.click('.bmb-folder[data-id="f1"]');
  await page.click('[data-act=new]');
  await page.keyboard.type('Recipes');
  await page.keyboard.press('Enter');
  assert.deepEqual(await lastSent(page, 'bookmarks:edit'), { id: 'b2', title: 'Beta two', newFolder: { parentId: 'f1', title: 'Recipes' } });
  // Esc closes it (what was typed is kept), Remove removes it.
  await page.focus('#bmb-name');
  await page.keyboard.press('Escape');
  assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'bm-edit', refocus: 'page' });
  await page.evaluate((b) => window.__emit('overlay-data', b), BUBBLE);
  await page.click('[data-act=remove]');
  assert.equal(await lastSent(page, 'bookmarks:remove'), 'b2');
  // Edit… from the bar shows the address too.
  await page.evaluate((b) => window.__emit('overlay-data', { ...b, editUrl: true, heading: 'Edit bookmark' }), BUBBLE);
  await page.fill('#bmb-url', 'https://beta.example/');
  await page.click('[data-act=done]');
  assert.deepEqual(await lastSent(page, 'bookmarks:edit'), { id: 'b2', title: 'Beta', url: 'https://beta.example/' });
  assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'bm-edit', refocus: 'page' });
  const c = await readColors(page, { tokens: ['--text', '--dim'], parts: ['.bm-bubble', '#bmb-name'] });
  assert.ok(luminance(c.parts['.bm-bubble']) < 0.05, 'dark');
  assert.ok(contrast(c.tokens['--dim'], c.parts['.bm-bubble']) >= 4.5, 'labels readable');
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------------------------------------------------------------- the manager
// A small tree the stand-in keeps, changed by the page's calls like the real one.
const MODEL = `
  const n = (id, title) => ({ id, title, url: 'https://' + id + '.example/', time: 1 });
  window.__roots = [
    { id: 'bar', title: 'Bookmarks bar', children: [n('a1', 'Alpha'), { id: 'f1', title: 'Work', children: [n('j1', 'Jira')] }, n('c3', 'Charlie'), n('b2', 'Bravo')] },
    { id: 'other', title: 'Other bookmarks', children: [n('o1', 'Other one')] },
    { id: 'mobile', title: 'Mobile bookmarks', children: [] },
  ];
  window.__find = (id, list = window.__roots, parent = null) => { for (const x of list) { if (x.id === id) return { node: x, parent }; if (x.children) { const f = window.__find(id, x.children, x); if (f) return f; } } return null; };
  let seq = 0;
  window.__model = {
    folder(parentId, index, title) { const id = 'nf' + (++seq); window.__find(parentId).node.children.splice(index ?? 1e9, 0, { id, title, children: [] }); return id; },
    update(id, patch) { Object.assign(window.__find(id).node, Object.fromEntries(Object.entries(patch).filter(([, v]) => v))); return true; },
    remove(ids) {
      const out = ids.map((id) => { const { node, parent } = window.__find(id); return { parentId: parent.id, index: parent.children.indexOf(node), node }; });
      for (const r of out) { const p = window.__find(r.parentId).node; p.children.splice(p.children.indexOf(r.node), 1); }
      return out;
    },
    restore(list) { for (const e of list.slice().sort((a, b) => a.index - b.index)) window.__find(e.parentId).node.children.splice(e.index, 0, e.node); return list.length; },
    move(ids, parentId, index) { const to = window.__find(parentId).node; const nodes = ids.map((id) => { const { node, parent } = window.__find(id); parent.children.splice(parent.children.indexOf(node), 1); return node; }); to.children.splice(index ?? to.children.length, 0, ...nodes); return true; },
    sort(id) { const f = window.__find(id).node; const before = f.children.map((x) => x.id); f.children.sort((a, b) => (!!b.children - !!a.children) || a.title.localeCompare(b.title)); return before; },
    reorder(id, ids) { const f = window.__find(id).node; f.children.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return true; },
  };`;
const MANAGER = {
  'page:bookmarks': 'fn:return { roots: window.__roots, showBar: true }',
  'page:bookmark-folder': 'fn:return window.__model.folder(...args)',
  'page:bookmark-update': 'fn:return window.__model.update(...args)',
  'page:bookmark-remove': 'fn:return window.__model.remove(...args)',
  'page:bookmark-restore': 'fn:return window.__model.restore(...args)',
  'page:bookmark-move': 'fn:return window.__model.move(...args)',
  'page:bookmark-sort': 'fn:return window.__model.sort(...args)',
  'page:bookmark-reorder': 'fn:return window.__model.reorder(...args)',
  'page:bookmark-open': 1,
};
const rowTitles = (page) => page.$$eval('#list .bm-row .t', (els) => els.map((e) => e.textContent));

test('bookmark manager: folder tree, search, select several, keys, new folder, rename, delete with undo, sort, drag to move', { skip }, async () => {
  const { page, errors } = await open(`${pagesBase}/bookmarks.html`, { bridge: 'lumioPage', answers: MANAGER, init: MODEL, colorScheme: 'dark' });
  await page.waitForSelector('#list .bm-row');
  assert.deepEqual(await page.$$eval('#tree .tf', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-level')])), [['Bookmarks bar', '1'], ['Work', '2'], ['Other bookmarks', '1']], 'an empty Mobile bookmarks is left out');
  assert.deepEqual(await rowTitles(page), ['Alpha', 'Work', 'Charlie', 'Bravo']);
  assert.match(await page.textContent('#list .bm-row.folder .u'), /1 bookmark/);

  // Select: click, ⌘/Ctrl-click, ⇧-click; the bar above shows how many.
  await page.click('#list [data-id="a1"] .t');
  await page.click('#list [data-id="c3"] .t', { modifiers: [MOD] });
  assert.equal(await page.textContent('#selcount'), '2 selected');
  await page.click('#list [data-id="b2"] .t', { modifiers: ['Shift'] });
  assert.deepEqual(await page.$$eval('#list .bm-row.sel', (els) => els.map((e) => e.dataset.id)), ['c3', 'b2']);
  // Keys: ↑/↓ move, Enter on a folder opens it, ← goes back up, Esc clears.
  await page.keyboard.press('Escape');
  assert.equal(await page.$$eval('#list .bm-row.sel', (els) => els.length), 0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'f1');
  await page.keyboard.press('Enter');
  assert.deepEqual(await rowTitles(page), ['Jira']);
  assert.match(await page.textContent('#crumbs'), /Bookmarks bar›Work/);
  assert.equal(await page.getAttribute('#tree .tf.on', 'data-id'), 'f1');
  await page.focus('#list .bm-row');
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await rowTitles(page), ['Alpha', 'Work', 'Charlie', 'Bravo']);
  // Enter on a bookmark opens it.
  await page.focus('#list [data-id="a1"]');
  await page.keyboard.press('Enter');
  assert.deepEqual((await calls(page, 'page:bookmark-open')).at(-1), [['a1'], 'tab']);

  // Search across every folder, with where each one is.
  await page.fill('#search', 'jira');
  assert.deepEqual(await rowTitles(page), ['Jira']);
  assert.equal(await page.textContent('#list .bm-row .p'), 'Bookmarks bar › Work');
  await page.fill('#search', '');

  // New folder: made in the open folder, its name ready to type.
  await page.click('#new-folder');
  await page.waitForSelector('#edit-title');
  await page.fill('#edit-title', 'Recipes');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#list .bm-row .t')].some((e) => e.textContent === 'Recipes'));
  assert.deepEqual((await calls(page, 'page:bookmark-update')).at(-1), ['nf1', { title: 'Recipes' }]);
  // Edit a bookmark's name and address (F2).
  await page.focus('#list [data-id="b2"]');
  await page.keyboard.press('F2');
  await page.fill('#edit-url', 'https://bravo.example/');
  await page.click('[data-act=save]');
  assert.deepEqual((await calls(page, 'page:bookmark-update')).at(-1), ['b2', { title: 'Bravo', url: 'https://bravo.example/' }]);

  // Delete two, then Undo.
  await page.click('#list [data-id="a1"] .t');
  await page.click('#list [data-id="c3"] .t', { modifiers: [MOD] });
  await page.keyboard.press('Delete');
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.textContent('#toast-text'), '2 items deleted');
  assert.deepEqual(await rowTitles(page), ['Work', 'Bravo', 'Recipes']);
  await page.click('#toast-undo');
  await page.waitForFunction(() => document.querySelectorAll('#list .bm-row').length === 5);
  assert.deepEqual(await rowTitles(page), ['Alpha', 'Work', 'Charlie', 'Bravo', 'Recipes']);

  // Sort by name (folders first) from the ⋮ menu, then undo it with ⌘Z.
  await page.click('#more');
  assert.equal(await page.getAttribute('#more', 'aria-expanded'), 'true');
  await page.click('#menu [data-cmd=sort]');
  await page.waitForFunction(() => document.querySelector('#list .bm-row .t').textContent === 'Recipes');
  assert.deepEqual(await rowTitles(page), ['Recipes', 'Work', 'Alpha', 'Bravo', 'Charlie']);
  assert.equal(await page.textContent('#toast-text'), 'Sorted by name');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction(() => document.querySelector('#list .bm-row .t').textContent === 'Alpha');

  // Drag two bookmarks onto a folder in the tree.
  await page.click('#list [data-id="a1"] .t');
  await page.click('#list [data-id="b2"] .t', { modifiers: [MOD] });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    document.querySelector('#list [data-id="a1"]').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const tf = document.querySelector('#tree [data-id="other"]');
    const r = tf.getBoundingClientRect();
    const at = { dataTransfer: dt, clientX: r.left + 30, clientY: r.top + 10, bubbles: true, cancelable: true };
    tf.dispatchEvent(new DragEvent('dragover', at));
    tf.dispatchEvent(new DragEvent('drop', at));
  });
  await page.waitForFunction(() => document.querySelectorAll('#list .bm-row').length === 3);
  assert.deepEqual((await calls(page, 'page:bookmark-move')).at(-1), [['a1', 'b2'], 'other', null]);
  // ⋮ on a row: its own menu, with the keyboard.
  await page.click('#list [data-id="f1"] [data-act=menu]');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'rename');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'open-tab');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#menu'), false);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'menu', 'the focus goes back');

  // Changes from elsewhere redraw it.
  await page.evaluate(() => { window.__roots[0].children.push({ id: 'z9', title: 'Zulu', url: 'https://z.example/' }); window.__emit('bookmarks-changed'); });
  await page.waitForFunction(() => [...document.querySelectorAll('#list .bm-row .t')].some((e) => e.textContent === 'Zulu'));
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------------------------------------------------------------- new tab page
const SHORTCUTS = `
  window.__sc = { mode: 'custom', hidden: false, items: [{ url: 'https://github.com/', title: 'GitHub' }, { url: 'https://news.example/', title: 'News' }] };
  window.__undo = null;
  window.__tiles = () => ({ ...window.__sc, custom: window.__sc.mode === 'custom', canAdd: window.__sc.mode === 'custom' && window.__sc.items.length < 10 });
  window.__change = (fn) => { window.__undo = structuredClone(window.__sc); fn(); return window.__tiles(); };`;
const NTP = {
  'page:newtab-data': { bookmarks: [], engine: 'Google', aiReady: false, incognito: false, name: 'Sam', chats: [] },
  'page:ntp-shortcuts': 'fn:return window.__tiles()',
  'page:ntp-shortcut-save': `fn:const [i, e] = args; if (!/\\./.test(e.url)) return { error: 'Type a web address, like example.com' };
    return window.__change(() => { const t = { url: 'https://' + e.url.replace(/^https?:\\/\\//, ''), title: e.title || e.url }; if (i == null) window.__sc.items.push(t); else window.__sc.items[i] = t; });`,
  'page:ntp-shortcut-remove': 'fn:return window.__change(() => { window.__sc.items = window.__sc.items.filter((t) => t.url !== args[0]); })',
  'page:ntp-shortcuts-undo': 'fn:if (window.__undo) window.__sc = window.__undo; return window.__tiles()',
  'page:ntp-shortcuts-reset': 'fn:return window.__change(() => { window.__sc.items = window.__sc.items.slice(0, 2); })',
  'page:ntp-shortcuts-set': 'fn:return window.__change(() => Object.assign(window.__sc, args[0]))',
};
const tiles = (page) => page.$$eval('#sites .site .name', (els) => els.map((e) => e.textContent));

test('new tab shortcuts: add, edit, remove with Undo, My shortcuts or Most visited, hide them', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open(`${pagesBase}/newtab.html`, { bridge: 'lumioPage', answers: NTP, init: SHORTCUTS, colorScheme });
    await page.waitForSelector('#sites .site');
    assert.deepEqual(await tiles(page), ['GitHub', 'News', 'Add shortcut']);
    assert.equal(await page.getAttribute('#sites', 'aria-label'), 'My shortcuts');

    // Add shortcut: a dialog; Done is off until there's an address; a bad one says why.
    await page.click('#sc-add');
    assert.equal(await page.isVisible('.sc-dialog[open]'), true);
    assert.equal(await page.textContent('#sc-title'), 'Add shortcut');
    assert.equal(await page.isDisabled('#sc-done'), true);
    await page.fill('#sc-name', 'Mail');
    await page.fill('#sc-url', 'nope');
    await page.click('#sc-done');
    assert.equal(await page.textContent('#sc-error'), 'Type a web address, like example.com');
    await page.fill('#sc-url', 'mail.example');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.sc-dialog[open]'));
    assert.deepEqual(await tiles(page), ['GitHub', 'News', 'Mail', 'Add shortcut']);
    assert.equal(await page.textContent('.sc-toast-text'), 'Shortcut added');
    await page.waitForFunction(() => document.activeElement?.id === 'sc-add'); // the focus is back where the dialog came from

    // ⋮ › Edit shortcut, with the keyboard.
    await page.focus('#sites .tile:nth-child(2) .site');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'More actions for News');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('.sc-menu'), true);
    await page.keyboard.press('Enter'); // Edit shortcut
    assert.equal(await page.textContent('#sc-title'), 'Edit shortcut');
    assert.equal(await page.inputValue('#sc-url'), 'https://news.example/');
    await page.fill('#sc-name', 'Headlines');
    await page.click('#sc-done');
    await page.waitForFunction(() => document.querySelector('#sites .tile:nth-child(2) .name').textContent === 'Headlines');
    assert.deepEqual((await calls(page, 'page:ntp-shortcut-save')).at(-1), [1, { title: 'Headlines', url: 'https://news.example/' }]);

    // ⋮ › Remove, then Undo from the toast; Restore default shortcuts is offered too.
    await page.click('#sites .tile:nth-child(1) .tile-act');
    await page.click('.sc-menu [data-item=remove]');
    await page.waitForFunction(() => document.querySelectorAll('#sites .tile').length === 3);
    assert.equal(await page.textContent('.sc-toast-text'), 'Shortcut removed');
    assert.equal(await page.isVisible('[data-toast=restore]'), true);
    await page.click('[data-toast=undo]');
    await page.waitForFunction(() => document.querySelector('#sites .name').textContent === 'GitHub');
    assert.equal(await page.isVisible('.sc-toast'), false);

    // Customize: Most visited sites (tiles get × instead of ⋮, no Add shortcut), then hide them.
    await page.click('.sc-customize');
    assert.equal(await page.isVisible('.sc-dialog[open] [name=sc-mode]'), true);
    await page.check('[name=sc-mode][value=mostVisited]');
    await page.waitForFunction(() => !document.getElementById('sc-add'));
    assert.equal(await page.getAttribute('#sites', 'aria-label'), 'Most visited sites');
    assert.match(await page.getAttribute('#sites .tile-act', 'aria-label'), /^Don’t show GitHub$/);
    await page.click('.sc-show');
    await page.waitForFunction(() => document.getElementById('sites').hidden);
    assert.equal(await page.isDisabled('[name=sc-mode][value=custom]'), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'sc-customize');
    assert.deepEqual((await calls(page, 'page:ntp-shortcuts-set')).map(([o]) => o), [{ mode: 'mostVisited' }, { hidden: true }]);

    // Readable dialogs and toast in this appearance.
    const c = await readColors(page, { tokens: ['--text', '--primary-fg', '--primary-bg'], parts: ['.sc-customize'] });
    assert.ok(contrast(c.tokens['--primary-fg'], c.tokens['--primary-bg']) >= 4.5, 'the toast');
    assert.ok(contrast(c.tokens['--text'], c.parts['.sc-customize']) >= 4.5);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('new tab shortcuts: none in incognito', { skip }, async () => {
  const { page, errors } = await open(`${pagesBase}/newtab.html?appearance=dark`, { bridge: 'lumioPage', answers: { ...NTP, 'page:newtab-data': { ...NTP['page:newtab-data'], incognito: true } }, init: SHORTCUTS });
  await page.waitForSelector('#incog:not([hidden])');
  await frames(page);
  assert.equal(await page.isVisible('#sites'), false);
  assert.equal(await page.$('.sc-customize'), null);
  assert.equal((await calls(page, 'page:ntp-shortcuts')).length, 0, 'not even asked');
  assert.deepEqual(errors, []);
  await page.close();
});
