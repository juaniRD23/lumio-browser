// The tab strip's extras in the window's UI (renderer/ui/tabstrip.js,
// infobars.js), the tab search list (renderer/ui/overlay-tabsearch.js), the
// sad tab page (renderer/pages/error.*) and Settings' Muted sites and
// "Ask at startup", in headless Chrome with a stand-in for the browser.
// Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast } from './colors.mjs';

const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false, vision: true, macAvailable: true };
const tab = (id, extra = {}) => ({ id, title: `Tab ${id}`, url: `https://site${id}.example/`, favicon: null, loading: false, canGoBack: false, canGoForward: false, pinned: false, pdf: false, ...extra });
const INIT = {
  tabs: { activeId: 1, tabs: [1, 2, 3, 4].map((id) => tab(id)) },
  downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'Test Person', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};

// Serves one lumio:// host's files (renderer/ui or renderer/pages), with the app's CSP.
function serve(host, hosts) {
  const server = http.createServer((req, res) => {
    const url = new URL(`lumio://${host}${req.url}`);
    const file = resolveFile(url, hosts);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html') && url.searchParams.get('appearance') === 'dark') body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let ui, pages, browser;
before(async () => {
  if (!CHROME) return;
  ui = await serve('shell', new Set(['shell']));
  pages = await serve('newtab', PAGE_HOSTS);
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); ui?.server.close(); pages?.server.close(); });

// A page with a stand-in for the browser: window.lumio (the window's UI) or
// window.lumioPage (Lumio's pages). answers: what invoke() returns;
// window.__sent records send(), window.__calls invoke(), and
// window.__emit(channel, payload) plays a message from the browser.
async function open(url, { answers = {}, colorScheme = 'light', viewport = { width: 1280, height: 800 }, bridge = 'lumio' } = {}) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript(({ answers, bridge }) => {
    const handlers = {};
    window.__sent = [];
    window.__calls = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const invoke = async (channel, ...args) => { window.__calls.push([channel, ...args]); const a = answers[channel]; return a === undefined ? null : structuredClone(a); };
    const on = (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; };
    if (bridge === 'lumio') window.lumio = { invoke, on, send: (channel, payload) => window.__sent.push([channel, payload]) };
    else window.lumioPage = { invoke, on };
  }, { answers, bridge });
  await page.goto(url);
  const sent = (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
  return { page, errors, sent };
}
const openShell = (opts = {}) => open(`${ui.base}/${opts.query || ''}`, { ...opts, answers: { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] }, ...opts.answers } })
  .then(async (r) => { await r.page.waitForSelector('#tabs .tab'); return r; });
const emitTabs = (page, activeId, tabs) => page.evaluate(([a, t]) => window.__emit('tabs', { activeId: a, tabs: t }), [activeId, tabs]);
const box = (page, sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());

test('many tabs: the strip scrolls sideways, fades at its edges, keeps the tab you’re on in view, and + stays visible', { skip }, async () => {
  const { page, errors } = await openShell();
  const many = Array.from({ length: 45 }, (_, i) => tab(i + 1));
  await emitTabs(page, 45, many);
  await page.waitForFunction(() => document.getElementById('tabs').classList.contains('scrolls'));
  const tabs = await box(page, '#tabs');
  const plus = await box(page, '#newtab');
  assert.ok(plus.left >= tabs.right - 1 && plus.right <= 1280, 'the new tab button is still there');
  assert.ok((await box(page, '#tab-search-btn')).right <= 1280);
  await page.waitForFunction(() => {
    const t = document.getElementById('tabs').getBoundingClientRect();
    const a = document.querySelector('#tabs .tab.active').getBoundingClientRect();
    return a.right <= t.right + 1 && a.left >= t.left - 1;
  }, null, { timeout: 5000 });
  assert.deepEqual(await page.$eval('#tabs', (el) => [el.classList.contains('fade-start'), el.classList.contains('fade-end')]), [true, false]);
  // A mouse wheel scrolls it.
  const left = await page.$eval('#tabs', (el) => el.scrollLeft);
  await page.mouse.move(tabs.left + 100, tabs.top + 20);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction((x) => document.getElementById('tabs').scrollLeft < x, left);
  await page.waitForFunction(() => document.getElementById('tabs').classList.contains('fade-end'));
  // Switching to a tab out of view brings it into view.
  await emitTabs(page, 45, many);
  await emitTabs(page, 1, many);
  await page.waitForFunction(() => document.getElementById('tabs').scrollLeft < 2, null, { timeout: 5000 });
  // Few tabs: no scrolling.
  await emitTabs(page, 1, many.slice(0, 3));
  await page.waitForFunction(() => !document.getElementById('tabs').classList.contains('scrolls'));
  assert.deepEqual(errors, []);
});

test('several tabs at once: Shift-click a range, ⌘/Ctrl-click to add or remove; switching another way leaves one', { skip }, async () => {
  const { page, errors, sent } = await openShell();
  const t = (n) => `#tabs .tab:nth-child(${n})`;
  await page.click(t(2), { modifiers: ['Shift'] });
  assert.deepEqual((await sent('tab:selection')).at(-1), [1, 2]);
  assert.deepEqual((await sent('tab:activate')).at(-1), 2);
  await emitTabs(page, 2, INIT.tabs.tabs);
  await page.click(t(4), { modifiers: [MOD] });
  assert.deepEqual((await sent('tab:selection')).at(-1), [1, 2, 4]);
  await emitTabs(page, 4, INIT.tabs.tabs);
  assert.deepEqual(await page.$$eval('#tabs .tab', (els) => els.map((el) => el.classList.contains('selected'))), [true, true, false, true]);
  // ⌘/Ctrl-click a selected tab: it leaves.
  await page.click(t(1), { modifiers: [MOD] });
  assert.deepEqual((await sent('tab:selection')).at(-1), [2, 4]);
  // Shift-click from the last ⌘-clicked tab.
  await page.click(t(3), { modifiers: ['Shift'] });
  assert.deepEqual((await sent('tab:selection')).at(-1), [1, 2, 3]);
  await emitTabs(page, 3, INIT.tabs.tabs);
  // A plain click on a selected tab, without dragging: just it.
  await page.click(t(2));
  assert.deepEqual((await sent('tab:selection')).at(-1), [2]);
  await emitTabs(page, 2, INIT.tabs.tabs);
  // Another tab shows some other way (the keyboard): just it.
  await page.click(t(4), { modifiers: ['Shift'] });
  await emitTabs(page, 4, INIT.tabs.tabs);
  await emitTabs(page, 1, INIT.tabs.tabs);
  assert.deepEqual((await sent('tab:selection')).at(-1), [1]);
  await page.waitForFunction(() => !document.querySelector('#tabs .tab.selected'));
  assert.deepEqual(errors, []);
});

test('dragging several selected tabs moves them as a block, with an arrow where they’ll land', { skip }, async () => {
  const { page, errors, sent } = await openShell();
  await page.click('#tabs .tab:nth-child(2)', { modifiers: ['Shift'] });
  await emitTabs(page, 2, INIT.tabs.tabs);
  const one = await box(page, '#tabs .tab:nth-child(1)');
  const four = await box(page, '#tabs .tab:nth-child(4)');
  await page.mouse.move(one.left + 20, one.top + 15);
  await page.mouse.down();
  await page.mouse.move(four.right - 10, one.top + 15, { steps: 8 });
  assert.equal(await page.isVisible('.strip-marker'), true);
  await page.mouse.up();
  assert.deepEqual(await sent('tab:move-many'), [{ ids: [1, 2], before: 2 }]);
  assert.equal(await page.isVisible('.strip-marker'), false);
  assert.deepEqual(await sent('tab:move'), [], 'not also a one-tab move');
  assert.deepEqual(errors, []);
});

test('pulling a tab out of the strip hands it to a new window and follows the pointer; another window’s tabs show where they’d land', { skip }, async () => {
  const { page, errors, sent } = await openShell();
  const two = await box(page, '#tabs .tab:nth-child(2)');
  await page.mouse.move(two.left + 30, two.top + 12);
  await page.mouse.down();
  await page.mouse.move(two.left + 34, two.top + 140, { steps: 6 });
  const [tear] = await sent('tab:tear');
  assert.deepEqual(tear.ids, [2]);
  const tabs = await box(page, '#tabs');
  assert.ok(Math.abs(tear.grabX - (tabs.left + 30)) <= 1 && Math.abs(tear.grabY - (two.top + 12)) <= 1, `grabbed where it was held: ${JSON.stringify(tear)}`);
  await page.mouse.move(two.left + 200, two.top + 300, { steps: 3 });
  assert.ok((await sent('tab:drag-move')).length >= 3);
  await page.mouse.up();
  assert.equal((await sent('tab:drag-end')).length, 1);
  assert.deepEqual(await sent('tab:move'), []);
  // The strip says where it is, for drops from other windows.
  const rect = (await sent('tab:strip-rect')).at(-1);
  assert.equal(rect.height, 40);
  // Another window's tab over this strip.
  const three = await box(page, '#tabs .tab:nth-child(3)');
  await page.evaluate((x) => window.__emit('tab-drag-hint', { x, count: 1 }), three.left + 5);
  assert.equal(await page.isVisible('.strip-marker'), true);
  assert.deepEqual((await sent('tab:drag-index')).at(-1), 2);
  await page.evaluate(() => window.__emit('tab-drag-hint', null));
  assert.equal(await page.isVisible('.strip-marker'), false);
  assert.deepEqual(errors, []);
});

test('links, text and files dropped on the strip: on a tab or between tabs, with an arrow; the empty strip has its own menu', { skip }, async () => {
  const { page, errors, sent } = await openShell();
  const drag = (type, x, data) => page.evaluate(([t, px, d]) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(d)) dt.setData(k, v);
    const el = document.elementFromPoint(px, 20);
    el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, clientX: px, clientY: 20, bubbles: true, cancelable: true }));
  }, [type, x, data]);
  const two = await box(page, '#tabs .tab:nth-child(2)');
  await drag('dragover', two.left + two.width / 2, { 'text/uri-list': 'https://dropped.example/' });
  assert.equal(await page.isVisible('.strip-marker.on-tab'), true);
  assert.equal(await page.$eval('#tabs .tab:nth-child(2)', (el) => el.classList.contains('drop-on')), true);
  await drag('drop', two.left + two.width / 2, { 'text/uri-list': 'https://dropped.example/\r\n', 'text/plain': 'https://dropped.example/' });
  assert.deepEqual((await sent('tab:drop')).at(-1), { on: 2, index: 1, url: 'https://dropped.example/', text: 'https://dropped.example/' });
  assert.equal(await page.isVisible('.strip-marker'), false);
  // Near a tab's edge: a new tab between.
  await drag('drop', two.left + 3, { 'text/plain': 'pizza near me' });
  assert.deepEqual((await sent('tab:drop')).at(-1), { on: null, index: 1, url: '', text: 'pizza near me' });
  // Past the last tab.
  const plus = await box(page, '#newtab');
  await drag('drop', plus.left + 5, { 'text/plain': 'example.org' });
  assert.equal((await sent('tab:drop')).at(-1).index, 4);

  // Right-click: the strip's menu, or the tab's.
  const strip = await box(page, '.strip-drag');
  await page.mouse.click(strip.left + 10, 20, { button: 'right' });
  assert.equal((await sent('tab:strip-context')).length, 1);
  await page.click('#tabs .tab:nth-child(3)', { button: 'right' });
  assert.deepEqual((await sent('tab:context')).at(-1), 3);
  assert.equal((await sent('tab:strip-context')).length, 1);
  assert.deepEqual(errors, []);
});

test('Search tabs: the ⌄ button and ⌘⇧A open the list under it, and close it again; a crashed tab shows a sad face', { skip }, async () => {
  const data = { tabs: [{ windowId: 1, tabId: 1, title: 'Tab 1', host: 'site1.example' }], closed: [], incognito: false };
  const { page, errors, sent } = await openShell({ answers: { 'shell:tab-search': data } });
  assert.equal(await page.getAttribute('#tab-search-btn', 'aria-label'), 'Search tabs');
  await page.click('#tab-search-btn');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:show'));
  const [shown] = await sent('overlay:show');
  const btn = await box(page, '#tab-search-btn');
  assert.equal(shown.payload.kind, 'tabsearch');
  assert.deepEqual(shown.payload.tabs, data.tabs);
  assert.equal(shown.payload.returnFocus, 'page');
  assert.ok(shown.rect.y >= btn.bottom && Math.abs(shown.rect.x + shown.rect.width - 12 - btn.right) <= 1, `under the button, lined up with it: ${JSON.stringify(shown.rect)}`);
  await page.click('#tab-search-btn');
  assert.deepEqual(await sent('overlay:hide'), ['tabsearch'], 'a second press closes it');
  // ⌘⇧A (main says so) toggles it too.
  await page.evaluate(() => window.__emit('tab-search'));
  await page.waitForFunction(() => window.__sent.filter(([c]) => c === 'overlay:show').length === 2);
  await page.evaluate(() => window.__emit('tab-search'));
  assert.equal((await sent('overlay:hide')).length, 2);
  // Closed by main (it lost the keyboard): the next press opens it again.
  await page.evaluate(() => window.__emit('tab-search'));
  await page.waitForFunction(() => window.__sent.filter(([c]) => c === 'overlay:show').length === 3);
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'tabsearch' }));
  await page.evaluate(() => window.__emit('tab-search'));
  await page.waitForFunction(() => window.__sent.filter(([c]) => c === 'overlay:show').length === 4);

  // A crashed tab.
  await emitTabs(page, 1, [tab(1, { crashed: true, title: 'Broken page' }), tab(2)]);
  await page.waitForFunction(() => document.querySelector('#tabs .tab').getAttribute('aria-label') === 'Crashed: Broken page');
  assert.match(await page.$eval('#tabs .tab .fav', (el) => el.innerHTML), /M8\.6 16\.3/, 'the sad face');
  assert.match(await page.getAttribute('#tabs .tab', 'title'), /^This tab crashed: Broken page/);
  assert.equal(await page.textContent('#tabs .tab .title'), 'Broken page');
  assert.deepEqual(errors, []);
});

for (const scheme of ['light', 'dark']) {
  test(`bars over the page (${scheme}): Restore pages? and the default browser, with buttons, a close button and Esc`, { skip }, async () => {
    const bars = [
      { id: 'restore', title: 'Restore pages?', text: 'Lumio didn’t shut down correctly.', actions: [{ id: 'restore', label: 'Restore', primary: true }] },
      { id: 'default-browser', title: '', text: 'Lumio isn’t your default browser', actions: [{ id: 'set', label: 'Set as default', primary: true }] },
    ];
    const { page, errors, sent } = await openShell({ colorScheme: scheme, answers: { 'shell:infobars': bars } });
    await page.waitForSelector('.lumio-bar');
    assert.deepEqual(await page.$$eval('.lumio-bar .infobar-text', (els) => els.map((el) => el.textContent)), ['Restore pages? Lumio didn’t shut down correctly.', 'Lumio isn’t your default browser']);
    const slot = await box(page, '#slot');
    const last = await box(page, '.lumio-bar:last-child');
    assert.ok(slot.top >= last.bottom, 'the page moves down under the bars');
    const c = await page.$eval('.lumio-bar', (el) => [getComputedStyle(el.querySelector('.infobar-text')).color, getComputedStyle(el).backgroundColor]);
    const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    assert.ok(scheme === 'light' ? luminance(rgb(c[1])) > 0.7 : luminance(rgb(c[1])) < 0.05, `bar is ${scheme}: ${c[1]}`);
    assert.ok(contrast(rgb(c[0]), rgb(c[1])) >= 4.5, 'readable');
    await page.click('[data-bar="restore"] [data-action="restore"]');
    assert.deepEqual((await sent('window:infobar')).at(-1), { id: 'restore', action: 'restore' });
    await page.click('[data-bar="default-browser"] [data-close]');
    assert.deepEqual((await sent('window:infobar')).at(-1), { id: 'default-browser', action: null });
    await page.focus('[data-bar="default-browser"] [data-action="set"]');
    await page.keyboard.press('Escape');
    assert.deepEqual((await sent('window:infobar')).at(-1), { id: 'default-browser', action: null });
    assert.equal(await page.getAttribute('[data-bar="restore"] [data-close]', 'aria-label'), 'Close');
    // Main takes them away.
    await page.evaluate(() => window.__emit('infobars', []));
    assert.equal(await page.$('.lumio-bar'), null);
    assert.ok((await box(page, '#slot')).top < slot.top, 'the page moves back up');
    assert.deepEqual(errors, []);
  });
}

const DATA = {
  kind: 'tabsearch',
  returnFocus: 'page',
  tabs: [
    { windowId: 1, tabId: 11, title: 'Inbox — Gmail', host: 'mail.google.com', current: true, audible: true },
    { windowId: 1, tabId: 12, title: 'Pull requests', host: 'github.com', crashed: true },
    { windowId: 2, tabId: 21, title: 'Lumio Settings', host: '', internal: true },
  ],
  closed: [
    { index: 4, kind: 'tab', title: 'Weather <today>', host: 'weather.example' },
    { index: 3, kind: 'window', title: '2 tabs', host: 'one.example, two.example' },
  ],
};

for (const scheme of ['light', 'dark']) {
  test(`the tab search list (${scheme}): type to narrow it, arrows and Enter switch or reopen, × closes, Esc goes back`, { skip }, async () => {
    const { page, errors, sent } = await open(`${ui.base}/overlay.html`, { colorScheme: scheme, viewport: { width: 404, height: 560 } });
    await page.evaluate((d) => window.__emit('overlay-data', d), DATA);
    await page.waitForSelector('#ts-input');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ts-input', 'typing goes to the box');
    assert.deepEqual(await page.$$eval('.ts-head', (els) => els.map((el) => el.textContent.trim())), ['Open tabs 3', 'Recently closed']);
    assert.equal(await page.$$eval('.ts-row', (els) => els.length), 5);
    assert.match(await page.textContent('#ts-row-0 .ts-title'), /Inbox/);
    assert.equal(await page.textContent('#ts-row-3 .ts-title'), 'Weather <today>', 'shown as text');
    const sized = await sent('overlay:size');
    assert.ok(sized.length && sized.at(-1).height > 200 && sized.at(-1).height <= 520 + 24, JSON.stringify(sized.at(-1)));
    // Contrast: titles and sites on the list.
    const colors = await page.evaluate(() => {
      const c = (el, p) => getComputedStyle(el)[p];
      return { title: c(document.querySelector('.ts-title'), 'color'), host: c(document.querySelector('.ts-host'), 'color'), bg: c(document.getElementById('card'), 'backgroundColor') };
    });
    const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    assert.ok(scheme === 'light' ? luminance(rgb(colors.bg)) > 0.7 : luminance(rgb(colors.bg)) < 0.05, `the list is ${scheme}`);
    assert.ok(contrast(rgb(colors.title), rgb(colors.bg)) >= 4.5 && contrast(rgb(colors.host), rgb(colors.bg)) >= 4.5, 'readable');

    await page.keyboard.type('gh');
    await page.waitForFunction(() => document.querySelectorAll('.ts-row').length === 1);
    assert.equal(await page.innerHTML('.ts-row .ts-host'), '<mark>g</mark>it<mark>h</mark>ub.com');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'tabsearch', action: 'open', windowId: 1, tabId: 12 });

    await page.fill('#ts-input', '');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getAttribute('#ts-input', 'aria-activedescendant'), 'ts-row-3');
    assert.equal(await page.getAttribute('#ts-row-3', 'aria-selected'), 'true');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'tabsearch', action: 'reopen', index: 4 });
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // wraps to the last
    assert.equal(await page.getAttribute('#ts-input', 'aria-activedescendant'), 'ts-row-4');

    // × closes a tab (and the list stays); Tab reaches the selected row's ×.
    await page.hover('#ts-row-0');
    await page.click('#ts-row-0 .ts-x');
    assert.deepEqual((await sent('tab:search-close')).at(-1), { windowId: 1, tabId: 11 });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.ts-row')?.id), 'ts-row-0');
    await page.keyboard.press('Enter');
    assert.equal((await sent('tab:search-close')).length, 2);
    // The list after a close keeps what you typed.
    await page.fill('#ts-input', 'lumio');
    await page.evaluate((d) => window.__emit('overlay-data', { ...d, tabs: d.tabs.slice(1), update: true }), DATA);
    assert.equal(await page.inputValue('#ts-input'), 'lumio');
    assert.equal(await page.$$eval('.ts-row', (els) => els.length), 1);
    await page.fill('#ts-input', 'zzzz');
    assert.equal(await page.textContent('.ts-empty'), 'No tabs found');
    // Clicking a row switches to it.
    await page.fill('#ts-input', '');
    await page.click('#ts-row-1 .ts-title');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'tabsearch', action: 'open', windowId: 2, tabId: 21 });
    await page.keyboard.press('Escape');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'tabsearch', refocus: 'page' });
    assert.deepEqual(errors, []);
  });
}

test('the sad tab: a sad face, what happened, and Reload', { skip }, async () => {
  const q = new URLSearchParams({ code: 'crashed', desc: 'crashed', url: 'https://crashy.example/' });
  const { page, errors } = await open(`${pages.base}/error.html?${q}`, { bridge: 'page', answers: { 'page:reload-crashed': true } });
  assert.equal(await page.textContent('#title'), 'This tab crashed');
  assert.equal(await page.isVisible('#sad'), true);
  assert.equal(await page.isVisible('#plain'), false);
  assert.equal(await page.textContent('#why'), 'Something went wrong while showing this page.');
  assert.equal(await page.textContent('#retry'), 'Reload');
  await page.click('#retry');
  await page.waitForFunction(() => window.__calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__calls), [['page:reload-crashed']]);
  // Another error: "Try again" loads the address.
  const other = await open(`${pages.base}/error.html?${new URLSearchParams({ code: '-105', desc: 'X', url: 'https://down.example/' })}`, { bridge: 'page' });
  assert.equal(await other.page.textContent('#retry'), 'Try again');
  assert.equal(await other.page.isVisible('#why'), false);
  await other.page.click('#retry');
  await other.page.waitForFunction(() => window.__calls.length === 1);
  assert.deepEqual(await other.page.evaluate(() => window.__calls), [['page:navigate', 'https://down.example/']]);
  assert.deepEqual([...errors, ...other.errors], []);
});

test('Settings: Muted sites lists the sites you muted, with Unmute; Ask at startup turns the default-browser bar on and off', { skip }, async () => {
  const settings = {
    account: { signedIn: false }, profile: { name: 'Test', color: '#7ee2a8', theme: 'blue' }, startup: 'restore', downloadDir: '/tmp/Downloads', askDownload: false,
    memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
    engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: true, appearance: 'system',
    ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.7', update: null, isDefault: false, importSources: [], sitePermissions: [],
  };
  const answers = {
    'page:settings': settings,
    'page:schedules': { signedIn: false, tasks: [] },
    'page:sync': { on: false, status: 'off', types: {}, requests: [] },
    'page:sync-devices': { ok: true, devices: [] },
    'page:workflows': { workflows: [] },
    'page:site-tips': { sites: [] },
    'page:mac-permissions': { accessibility: true, screen: true },
    'page:muted-sites': ['https://music.example', 'https://ads.example:8443'],
    'page:unmute-site': ['https://ads.example:8443'],
    'page:default-prompt': { prompt: false },
    'page:set-default-prompt': { prompt: true },
  };
  const { page, errors } = await open(`${pages.base}/settings.html`, { bridge: 'page', answers });
  await page.waitForSelector('#muted-list [data-unmute]');
  assert.deepEqual(await page.$$eval('#muted-list .title', (els) => els.map((el) => el.textContent)), ['music.example', 'ads.example:8443']);
  await page.click('[data-unmute="https://music.example"]');
  await page.waitForFunction(() => document.querySelectorAll('#muted-list [data-unmute]').length === 1);
  assert.deepEqual(await page.evaluate(() => window.__calls.find(([c]) => c === 'page:unmute-site')), ['page:unmute-site', 'https://music.example']);
  assert.equal(await page.isChecked('#default-prompt'), false);
  await page.click('label:has(#default-prompt)');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:set-default-prompt'));
  assert.deepEqual(await page.evaluate(() => window.__calls.find(([c]) => c === 'page:set-default-prompt')), ['page:set-default-prompt', true]);
  assert.equal(await page.isChecked('#default-prompt'), true);
  assert.deepEqual(errors, []);
});
