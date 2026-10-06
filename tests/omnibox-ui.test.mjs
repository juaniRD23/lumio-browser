// The address bar's UI in headless Chrome with a stand-in for the main
// process: inline autocomplete, chips, the keys, the empty bar's list, the
// dropdown's rows (overlay.html), Settings › Search engine and the welcome
// screen's search engine choice, in light and dark. Skipped when Google
// Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contrast } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' }] },
  downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'T', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
const KEYWORDS = [
  { keyword: '@tabs', scope: 'tabs', chip: 'Search tabs' },
  { keyword: '@history', scope: 'history', chip: 'Search history' },
  { keyword: 'google.com', id: 'google', chip: 'Search Google', tabOnly: true },
  { keyword: 'yt', id: 'youtube', chip: 'Search YouTube' },
];
const ENGINES = {
  default: 'google', suggest: true,
  engines: [['google', 'Google', 'google.com'], ['duckduckgo', 'DuckDuckGo', 'duckduckgo.com'], ['bing', 'Bing', 'bing.com'], ['brave', 'Brave', 'search.brave.com']]
    .map(([id, name, keyword]) => ({ id, name, keyword, url: `https://${keyword}/search?q=%s`, builtin: true })),
  custom: [{ id: 'youtube', name: 'YouTube', keyword: 'yt', url: 'https://www.youtube.com/results?search_query=%s' }],
  found: [{ id: 'found-recipes.example', name: 'Recipes', keyword: 'recipes.example', url: 'https://recipes.example/?q=%s' }],
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
  pages = serve('settings', PAGE_HOSTS);
  await Promise.all([ui, pages].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  uiBase = `http://127.0.0.1:${ui.address().port}`;
  pagesBase = `http://127.0.0.1:${pages.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); ui?.close(); pages?.close(); });

// A page with a stand-in main process. `answers` maps channels to values or
// to function bodies (run with the call's arguments); every call is in
// window.__calls and every message sent in window.__sent.
async function open(url, { answers = {}, colorScheme = 'dark', bridge = 'lumio', init } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript(({ answers, bridge, init }) => {
    const handlers = {};
    window.__calls = [];
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const fns = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('fn:') ? new Function('...args', v.slice(3)) : () => structuredClone(v)]));
    const api = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return fns[channel] ? fns[channel](...args) : null; },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
    window[bridge] = api;
    if (init) (0, eval)(init);
  }, { answers, bridge, init });
  await page.goto(url);
  return { page, errors };
}

const SHELL_ANSWERS = {
  'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] },
  'omnibox:keywords': KEYWORDS,
  'omnibox:suggest': 'fn:return window.__suggest(args[0])',
  'omnibox:zero': 'fn:return window.__zero()',
  'omnibox:remove': true,
};
// What the stand-in suggests: GitHub completes inline from "g"; Gist can be removed.
const SUGGEST = `
  window.__suggest = (req) => {
    const t = String(req.text || '').toLowerCase();
    if (req.keyword) return [{ type: 'search', title: req.text, url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(req.text), hint: 'Search ' + req.keyword }];
    const rows = [];
    if (req.inline !== false && t && 'github.com'.startsWith(t) && t !== 'github.com') rows.push({ type: 'history', title: 'GitHub', url: 'https://github.com/', inline: 'github.com'.slice(t.length) });
    rows.push({ type: 'search', title: req.text, url: 'https://www.google.com/search?q=' + encodeURIComponent(req.text) });
    rows.push({ type: 'history', title: 'Gist', url: 'https://gist.github.com/', removable: true });
    if (req.remote) rows.push({ type: 'search', title: req.text + ' tutorial', url: 'https://www.google.com/search?q=t', remote: true });
    return rows;
  };
  window.__zero = () => [{ type: 'clipboard', title: 'Link you copied', url: 'https://copied.example/' }, { type: 'history', title: 'Often', url: 'https://often.example/', removable: true }];`;

const openShell = (opts = {}) => open(`${uiBase}/`, { answers: SHELL_ANSWERS, init: SUGGEST, ...opts }).then(async (r) => {
  await r.page.waitForFunction(() => document.getElementById('mode-name')?.textContent === 'Ask', null, { timeout: 10_000 }).catch(() => {});
  return r;
});
const lastSent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).at(-1)?.[1] ?? null, channel);
const sentCount = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).length, channel);
const addr = (page) => page.evaluate(() => { const a = document.getElementById('address'); return { value: a.value, start: a.selectionStart, end: a.selectionEnd }; });
// A fresh start: out of the bar (which drops any chip), then into it, emptied.
async function focusBar(page) {
  await page.evaluate(() => document.getElementById('address').blur());
  await page.click('#address');
  // Focusing selects the address on the next frame (shell.js): let that happen first.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.press('Backspace');
}

test('inline autocomplete: shown selected after the caret, typed through, removed by Backspace', { skip }, async () => {
  const { page, errors } = await openShell();
  await focusBar(page);
  await page.keyboard.type('gi');
  await page.waitForFunction(() => document.getElementById('address').value === 'github.com');
  assert.deepEqual(await addr(page), { value: 'github.com', start: 2, end: 10 });
  const shown = await lastSent(page, 'overlay:show');
  assert.equal(shown.payload.kind, 'suggest');
  assert.equal(shown.payload.items[0].inline, 'thub.com');
  assert.equal(shown.payload.selected, 0);
  assert.equal(await page.getAttribute('#address', 'aria-expanded'), 'true');

  // Typing the next letter keeps the rest, right away.
  await page.keyboard.type('t');
  assert.deepEqual(await addr(page), { value: 'github.com', start: 3, end: 10 });

  // Backspace removes only the completion, and asks for none next time.
  await page.keyboard.press('Backspace');
  assert.deepEqual(await addr(page), { value: 'git', start: 3, end: 3 });
  await page.waitForFunction(() => window.__calls.filter(([c]) => c === 'omnibox:suggest').at(-1)?.[1].inline === false);
  await page.waitForTimeout(80);
  assert.equal((await addr(page)).value, 'git', 'not completed again');

  // The search engine's suggestions arrive once typing pauses.
  await page.waitForFunction(() => window.__calls.some(([c, r]) => c === 'omnibox:suggest' && r.remote && r.text === 'git'));
  await page.waitForFunction(() => window.__sent.at(-1)?.[1]?.payload?.items?.some((r) => r.remote));

  // Arrows choose another row: the completion hides while it isn't chosen.
  await page.keyboard.type('h');
  await page.waitForFunction(() => document.getElementById('address').value === 'github.com');
  await page.keyboard.press('ArrowDown');
  assert.equal((await addr(page)).value, 'gith');
  assert.equal((await lastSent(page, 'overlay:show')).payload.selected, 1);
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await addr(page), { value: 'github.com', start: 4, end: 10 });
  // Screen readers hear the chosen row.
  await page.waitForFunction(() => /^GitHub, github\.com, history, 1 of \d+$/.test(document.querySelector('.omni-live').textContent));

  await page.keyboard.press('Enter');
  assert.deepEqual(await lastSent(page, 'omnibox:open'), { url: 'https://github.com/', kind: 'history', disposition: 'current' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('keys: ⌥Enter new tab, ⇧Enter new window, Ctrl+Enter www.…com, ⇧Delete, paste and go, Esc twice', { skip }, async () => {
  const { page, errors } = await openShell();
  const typeAnd = async (text, key) => {
    await focusBar(page);
    await page.keyboard.type(text);
    await page.waitForFunction((t) => window.__calls.some(([c, r]) => c === 'omnibox:suggest' && r.text === t), text);
    await page.waitForTimeout(30);
    if (key) await page.keyboard.press(key);
  };
  await typeAnd('news', 'Alt+Enter');
  assert.deepEqual(await lastSent(page, 'omnibox:open'), { url: 'https://www.google.com/search?q=news', kind: 'search', disposition: 'tab' });
  await typeAnd('news', 'Shift+Enter');
  assert.equal((await lastSent(page, 'omnibox:open')).disposition, 'window');
  await typeAnd('lumio', 'Control+Enter');
  assert.deepEqual(await lastSent(page, 'omnibox:open'), { input: 'lumio', www: true, disposition: 'current' });

  // ⇧Delete on a page from history removes it.
  await typeAnd('zz');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+Delete');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'omnibox:remove'));
  assert.deepEqual(await page.evaluate(() => window.__calls.find(([c]) => c === 'omnibox:remove')[1]), { url: 'https://gist.github.com/', type: 'history', toast: false });

  // Esc: first closes the list, then puts the address back.
  await page.keyboard.press('Escape');
  assert.equal(await lastSent(page, 'overlay:hide'), 'suggest');
  assert.equal((await addr(page)).value, 'zz');
  await page.keyboard.press('Escape');
  assert.equal((await addr(page)).value, 'youtube.com/watch?v=abc');
  assert.ok(await sentCount(page, 'tab:focus-page'));

  // ⌘⇧V (Ctrl+Shift+V): paste and go.
  await focusBar(page);
  await page.keyboard.press(`${MOD}+Shift+V`);
  assert.ok(await sentCount(page, 'omnibox:paste-go'));
  // Right-click: the main process draws the menu.
  await page.click('#address', { button: 'right' });
  assert.ok(await lastSent(page, 'omnibox:context'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('chips: "yt " searches YouTube, Tab after a shortcut or @ta…, Backspace leaves it', { skip }, async () => {
  const { page, errors } = await openShell();
  await focusBar(page);
  await page.keyboard.type('yt ');
  assert.equal(await page.isVisible('#omni-chip'), true);
  assert.equal(await page.textContent('#omni-chip'), 'Search YouTube');
  assert.equal((await addr(page)).value, '');
  assert.match(await page.getAttribute('#address', 'aria-label'), /Search YouTube/);
  await page.keyboard.type('cats');
  await page.waitForFunction(() => window.__calls.some(([c, r]) => c === 'omnibox:suggest' && r.keyword === 'yt' && r.text === 'cats'));
  await page.waitForTimeout(30);
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  assert.equal(await page.isVisible('#omni-chip'), false);
  assert.equal((await addr(page)).value, 'yt cats');
  assert.equal(await page.getAttribute('#address', 'aria-label'), 'Address and search bar');

  // Back in, then Enter searches YouTube for what's typed.
  await focusBar(page);
  await page.keyboard.type('yt');
  await page.keyboard.press('Tab');
  assert.equal(await page.textContent('#omni-chip'), 'Search YouTube');
  await page.keyboard.type('dogs');
  await page.waitForFunction(() => window.__calls.some(([c, r]) => c === 'omnibox:suggest' && r.keyword === 'yt' && r.text === 'dogs'));
  await page.evaluate(() => { window.__suggest = () => []; });
  await page.keyboard.type('!');
  await page.waitForTimeout(60);
  await page.keyboard.press('Enter');
  assert.deepEqual(await lastSent(page, 'omnibox:open'), { input: 'dogs!', keyword: 'yt', disposition: 'current' });
  assert.equal(await page.isVisible('#omni-chip'), false, 'gone after going');

  // A built-in engine's domain needs Tab; a space just keeps typing.
  await page.evaluate(() => { window.__suggest = () => [{ type: 'search', title: 'x', url: 'x' }]; });
  await focusBar(page);
  await page.keyboard.type('google.com ');
  assert.equal(await page.isVisible('#omni-chip'), false);
  await focusBar(page);
  await page.keyboard.type('google.com');
  await page.keyboard.press('Tab');
  assert.equal(await page.textContent('#omni-chip'), 'Search Google');

  // "@ta" and Tab: search open tabs.
  await focusBar(page);
  await page.keyboard.type('@ta');
  await page.keyboard.press('Tab');
  assert.equal(await page.textContent('#omni-chip'), 'Search tabs');
  await page.waitForFunction(() => window.__calls.some(([c, r]) => c === 'omnibox:suggest' && r.keyword === '@tabs' && r.text === ''));

  // Clicking a shortcut row in the dropdown opens its chip too.
  await focusBar(page);
  await page.evaluate(() => { window.__suggest = () => [{ type: 'search', title: 'h', url: 'x' }, { type: 'keyword', title: 'Search history', keyword: '@history', scope: 'history' }]; });
  await page.keyboard.type('@h');
  await page.waitForFunction(() => window.__sent.at(-1)?.[1]?.payload?.items?.length === 2);
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'suggest', index: 1 }));
  assert.equal(await page.textContent('#omni-chip'), 'Search history');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the empty bar: clicking it shows a copied link and the pages you visit most', { skip }, async () => {
  const { page, errors } = await openShell();
  await page.evaluate(() => window.__emit('tabs', { activeId: 2, tabs: [{ id: 2, title: 'New Tab', url: '' }] }));
  await page.click('#address');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'omnibox:zero'));
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:show' && p.payload.items[0]?.type === 'clipboard'));
  assert.equal((await lastSent(page, 'overlay:show')).payload.selected, -1, 'nothing chosen yet');
  await page.keyboard.press('Enter');
  assert.equal(await lastSent(page, 'omnibox:open'), null, 'Enter on the empty bar does nothing');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await lastSent(page, 'omnibox:open'), { url: 'https://copied.example/', kind: 'clipboard', disposition: 'current' });
  // Focus alone (like a new tab) doesn't open the list.
  const zeros = await page.evaluate(() => window.__calls.filter(([c]) => c === 'omnibox:zero').length);
  await page.evaluate(() => document.getElementById('address').focus());
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__calls.filter(([c]) => c === 'omnibox:zero').length), zeros);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the chip is readable in light and dark', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await openShell({ colorScheme });
    await focusBar(page);
    await page.keyboard.type('yt ');
    await page.waitForTimeout(250); // its fade-in
    const [fg, bg] = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const paint = (...colors) => { ctx.clearRect(0, 0, 1, 1); for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); } return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
      const chip = document.getElementById('omni-chip');
      const layers = [];
      for (let el = chip; el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor);
      return [paint(...layers, getComputedStyle(chip).color), paint(...layers)];
    });
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `${colorScheme}: chip text is ${ratio.toFixed(2)}:1`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('the dropdown draws every kind of row, with labels for screen readers and a remove button', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open(`${uiBase}/overlay.html`, { colorScheme });
    const items = [
      { type: 'history', title: 'GitHub', url: 'https://github.com/', inline: 'hub.com' },
      { type: 'search', title: 'git', url: 'https://g/?q=git' },
      { type: 'keyword', title: 'Search YouTube', keyword: 'yt' },
      { type: 'answer', title: '= 144', answer: '144' },
      { type: 'action', title: 'Clear browsing data', action: 'clearData' },
      { type: 'tab', title: 'Docs', url: 'https://docs.example/', tabId: 4, windowId: 2 },
      { type: 'history', title: 'Gist', url: 'https://gist.github.com/', removable: true },
      { type: 'search', title: 'git tutorial', url: 'https://g/?q=t', remote: true },
      { type: 'clipboard', title: 'Link you copied', url: 'https://copied.example/' },
      { type: 'ai', title: 'git' },
    ];
    await page.waitForFunction(() => typeof window.__emit === 'function');
    await page.waitForTimeout(100);
    // main/window.js's steps: draw it ('show'), then bring it in ('in').
    await page.evaluate((items) => { window.__emit('overlay-data', { kind: 'suggest', items, selected: 5, op: 'show', seq: 1 }); window.__emit('overlay-data', { op: 'in', seq: 1 }); }, items);
    assert.equal(await page.getAttribute('#card', 'role'), 'listbox');
    const rows = await page.$$eval('.row', (els) => els.map((e) => [e.getAttribute('role'), e.getAttribute('aria-selected'), e.innerText.replace(/\s+/g, ' ').trim()]));
    assert.equal(rows.length, items.length);
    assert.ok(rows.every(([role]) => role === 'option'));
    assert.equal(rows[5][1], 'true');
    assert.match(rows[2][2], /Search YouTube Tab/);
    assert.match(rows[3][2], /= 144 Copy/);
    assert.match(rows[4][2], /Clear browsing data Action/);
    assert.match(rows[5][2], /Docs .*docs\.example Switch to this tab/);
    assert.doesNotMatch(rows[7][2], /Search$/, 'the engine’s suggestions have no “Search” label');
    assert.equal(await page.$$eval('.row .rm', (els) => els.length), 2, 'history and the copied link can be removed');
    // The switch label is readable on the chosen row.
    const [fg, bg] = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const paint = (...colors) => { ctx.clearRect(0, 0, 1, 1); for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); } return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
      const pill = document.querySelector('.row[aria-selected="true"] .hint.pill');
      const layers = [];
      for (let el = pill; el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor);
      return [paint(...layers, getComputedStyle(pill).color), paint(...layers)];
    });
    assert.ok(contrast(fg, bg) >= 4.5, `${colorScheme}: “Switch to this tab” is ${contrast(fg, bg).toFixed(2)}:1`);

    // Clicks: the × removes; ⌘/Ctrl-click opens a new tab; middle click a background tab; right-click nothing.
    // Measured once the dropdown has finished coming in (it scales up), or a
    // slow machine clicks where the × was a moment ago.
    await page.waitForFunction(() => !document.getElementById('card').getAnimations().length);
    const box = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const rm = await box('.row[data-i="6"] .rm');
    await page.mouse.move(rm.x, rm.y);
    await page.mouse.down();
    await page.mouse.up();
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'suggest', index: 6, action: 'remove' });
    const row = await box('.row[data-i="1"] .t');
    await page.keyboard.down(MOD);
    await page.mouse.click(row.x, row.y);
    await page.keyboard.up(MOD);
    assert.deepEqual(await lastSent(page, 'overlay:pick'), { kind: 'suggest', index: 1, disposition: 'tab' });
    await page.mouse.click(row.x, row.y, { button: 'middle' });
    assert.equal((await lastSent(page, 'overlay:pick')).disposition, 'background');
    const picks = await sentCount(page, 'overlay:pick');
    await page.mouse.click(row.x, row.y, { button: 'right' });
    assert.equal(await sentCount(page, 'overlay:pick'), picks);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// ---------------------------------------------------------------- pages
const SETTINGS = {
  account: { signedIn: false }, profile: { name: '', theme: 'blue' }, startup: 'restore', downloadDir: '/tmp', askDownload: false, memorySaver: true, memorySaverMinutes: 60,
  offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google', engines: [], approvalMode: 'ask', showBookmarksBar: true, appearance: 'system',
  ai: { reasoning: 'medium' }, version: '0.6.7', update: null, isDefault: false, importSources: [], sitePermissions: [],
};

test('Settings › Search engine: choose the default, add, edit, delete, turn on found ones, and the autocomplete switch', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open(`${pagesBase}/settings.html`, {
      bridge: 'lumioPage', colorScheme,
      init: `window.__state = ${JSON.stringify(ENGINES)};`,
      answers: {
        'page:settings': SETTINGS, 'page:sync': { on: false, types: {}, requests: [] }, 'page:schedules': { tasks: [] }, 'page:workflows': { workflows: [] }, 'page:site-tips': { sites: [] },
        'page:search-engines': 'fn:return structuredClone(window.__state)',
        'page:search-engine-default': 'fn:window.__state.default = args[0]; return structuredClone(window.__state)',
        'page:search-engine-delete': 'fn:window.__state.custom = window.__state.custom.filter((e) => e.id !== args[0]); return structuredClone(window.__state)',
        'page:search-engine-activate': 'fn:const f = window.__state.found.shift(); window.__state.custom.push({ ...f, id: "c2" }); return structuredClone(window.__state)',
        'page:search-suggest': 'fn:window.__state.suggest = args[0]; return structuredClone(window.__state)',
        'page:search-engine-save': 'fn:const e = args[0]; if (!e.name) return { ok: false, error: "Give it a name" }; window.__state.custom.push({ ...e, id: e.id || "c1" }); return { ok: true, state: structuredClone(window.__state) }',
      },
    });
    await page.waitForFunction(() => document.querySelectorAll('#engine option').length === 5);
    assert.deepEqual(await page.$$eval('#engine option', (o) => o.map((x) => x.textContent)), ['Google', 'DuckDuckGo', 'Bing', 'Brave', 'YouTube']);
    assert.equal(await page.inputValue('#engine'), 'google');
    await page.selectOption('#engine', 'bing');
    await page.waitForFunction(() => window.__calls.some(([c, id]) => c === 'page:search-engine-default' && id === 'bing'));

    assert.equal(await page.isVisible('#se-panel'), false);
    await page.click('#se-manage');
    assert.equal(await page.getAttribute('#se-manage', 'aria-expanded'), 'true');
    assert.equal(await page.isVisible('#se-panel'), true);
    assert.match(await page.textContent('.se-row[data-id="bing"]'), /Default/);
    assert.match(await page.textContent('#se-panel'), /Inactive shortcuts[\s\S]*Recipes/);

    // Add: a mistake is explained, then it's saved and listed.
    await page.click('#se-add');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'name');
    await page.fill('.se-form [name=keyword]', 'mdn');
    await page.fill('.se-form [name=url]', 'https://developer.mozilla.org/search?q=%s');
    await page.click('.se-form [type=submit]');
    await page.waitForFunction(() => document.querySelector('.se-form .err')?.textContent === 'Give it a name');
    await page.fill('.se-form [name=name]', 'MDN');
    await page.press('.se-form [name=url]', 'Enter');
    await page.waitForFunction(() => !!document.querySelector('.se-row[data-id="c1"]'));
    assert.match(await page.textContent('.se-row[data-id="c1"]'), /MDN[\s\S]*mdn/);

    // Edit opens the form under the row; Esc closes it.
    await page.click('.se-row[data-id="youtube"] [data-act=edit]');
    assert.equal(await page.inputValue('.se-form [name=keyword]'), 'yt');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.se-form'), null);

    // Delete asks first.
    page.once('dialog', (d) => d.accept());
    await page.click('.se-row[data-id="c1"] [data-act=delete]');
    await page.waitForFunction(() => !document.querySelector('.se-row[data-id="c1"]'));

    // Found on a site: turned on.
    await page.click('.se-row[data-kind="found"] [data-act=activate]');
    await page.waitForFunction(() => !!document.querySelector('.se-row[data-id="c2"]'));

    // Privacy › Autocomplete searches and URLs.
    assert.equal(await page.isChecked('#search-suggest'), true);
    await page.click('#privacy .switch i');
    await page.waitForFunction(() => window.__calls.some(([c, on]) => c === 'page:search-suggest' && on === false));
    assert.equal(await page.isChecked('#search-suggest'), false);
    assert.deepEqual(errors, [], colorScheme);
    await page.close();
  }
});

test('first run: choose a search engine, in a random order, nothing picked for you', { skip }, async () => {
  const { page, errors } = await open(`${pagesBase}/welcome.html`, {
    bridge: 'lumioPage', colorScheme: 'light',
    init: 'Math.random = () => 0;',
    answers: {
      'page:welcome-state': { platform: 'win32', sources: [], account: {} },
      'page:search-engines': ENGINES,
      'page:search-engine-default': 'fn:return { default: args[0] }',
    },
  });
  const step = () => page.evaluate(() => document.querySelector('.step:not([hidden])')?.dataset.step);
  await page.waitForFunction(() => !!document.querySelector('.step:not([hidden])'));
  await page.click('[data-step=hello] [data-next]');
  await page.click('#imp-skip');
  assert.equal(await step(), 'search');
  // Shuffled (the same order every time here, as Math.random is fixed).
  assert.deepEqual(await page.$$eval('.engine b', (b) => b.map((x) => x.textContent)), ['DuckDuckGo', 'Bing', 'Brave', 'Google']);
  assert.equal(await page.isDisabled('#se-go'), true);
  assert.equal(await page.$$eval('input[name=engine]:checked', (x) => x.length), 0);
  // The choices work with the keyboard.
  await page.focus('input[name=engine]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'bing');
  assert.equal(await page.isDisabled('#se-go'), false);
  await page.click('#se-go');
  await page.waitForFunction(() => document.querySelector('.step:not([hidden])')?.dataset.step === 'done');
  assert.deepEqual(await page.evaluate(() => window.__calls.find(([c]) => c === 'page:search-engine-default')), ['page:search-engine-default', 'bing']);
  assert.deepEqual(errors, []);
  await page.close();
});
