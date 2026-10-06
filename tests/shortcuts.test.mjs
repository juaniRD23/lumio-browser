// Keyboard shortcut customization: the keymap logic (main/shortcuts.js)
// against the real application menu (main/menu.js), and Settings ›
// Keyboard shortcuts (renderer/pages/shortcuts.html) in headless Chrome,
// answered by the same logic. The page parts are skipped when Google Chrome
// isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);

// menu.js builds Electron menus; here a "menu" is just its template.
const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
require.cache[electronPath].exports.Menu ??= { buildFromTemplate: (items) => items };
const { buildMenu, buildBrowserMenu, menuTemplate } = require('../main/menu.js');
const sc = require('../main/shortcuts.js');
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const MAC = process.platform === 'darwin';
const cmd = new Proxy({}, { get: (_t, k) => (k === 'isDev' ? false : () => {}) });
const find = (items, label) => {
  for (const it of items) {
    if (it.label === label) return it;
    const sub = Array.isArray(it.submenu) && find(it.submenu, label);
    if (sub) return sub;
  }
  return null;
};

// ---------------------------------------------------------------- the keymap
test('keys are read, written once and shown the way each computer shows them', () => {
  assert.deepEqual(sc.parse('CmdOrCtrl+Shift+t', true), { mods: ['Shift', 'Cmd'], key: 'T' });
  assert.equal(sc.normalize('CmdOrCtrl+Shift+T', false), 'Ctrl+Shift+T');
  assert.equal(sc.normalize('Shift+CommandOrControl+Z', true), 'Shift+Cmd+Z', 'modifiers in one order');
  assert.equal(sc.normalize('Option+Command+I', true), 'Alt+Cmd+I');
  assert.equal(sc.normalize('CmdOrCtrl+Plus', true), 'Cmd+Plus');
  assert.equal(sc.normalize('Cmd++', true), 'Cmd+Plus');
  assert.equal(sc.normalize('Return', false), 'Enter');
  for (const bad of ['', 'Cmd+', 'Shift', 'Cmd+Shift', 'T+Cmd', 'Cmd+T+Y', 'Cmd+Hyper', 'Ctrl+F25', 42]) assert.equal(sc.parse(bad, true), null, String(bad));
  assert.equal(sc.display('Cmd+Alt+I', true), '⌥⌘I');
  assert.equal(sc.display('Shift+Cmd+[', true), '⇧⌘[');
  assert.equal(sc.display('Ctrl+Cmd+F', true), '⌃⌘F');
  assert.equal(sc.display('Alt+Left', true), '⌥←');
  assert.equal(sc.display('CmdOrCtrl+Plus', true), '⌘+');
  assert.equal(sc.display('Shift+Ctrl+PageDown', false), 'Ctrl+Shift+Page Down', 'Windows writes Ctrl first');
  assert.equal(sc.display('Alt+Escape', false), 'Alt+Esc');
  assert.equal(sc.display('F7', false), 'F7');
  assert.equal(sc.display('Ctrl+num5', false), 'Ctrl+Num 5');
});

test('a shortcut needs ⌘ or ⌃ on a Mac, Ctrl or Alt on Windows, and can’t be one the computer uses', () => {
  assert.deepEqual(sc.validate('Cmd+Shift+Y', true), { accel: 'Shift+Cmd+Y' });
  assert.deepEqual(sc.validate('Ctrl+Y', true), { accel: 'Ctrl+Y' });
  assert.deepEqual(sc.validate('F2', true), { accel: 'F2' }, 'function keys work alone');
  assert.deepEqual(sc.validate('Alt+K', false), { accel: 'Alt+K' });
  assert.match(sc.validate('Y', true).error, /Add ⌘ or ⌃/);
  assert.match(sc.validate('Shift+Y', false).error, /Add Ctrl or Alt/);
  assert.match(sc.validate('Alt+E', true).error, /Add ⌘ or ⌃/, '⌥ alone types accented letters on a Mac');
  assert.match(sc.validate('Enter', false).error, /Add Ctrl or Alt/);
  assert.match(sc.validate('Cmd+Space', true).error, /computer uses ⌘Space/);
  assert.match(sc.validate('Shift+Cmd+4', true).error, /computer uses/);
  assert.match(sc.validate('Alt+F4', false).error, /computer uses Alt\+F4/);
  assert.match(sc.validate('Super+E', false).error, /Windows key/);
  assert.match(sc.validate('Cmd+Nope', true).error, /can’t use that key/);
});

test('the real menu: every command has its own id, and Lumio’s own shortcuts don’t clash', () => {
  const template = menuTemplate(cmd, {});
  const list = sc.commands(template, MAC);
  const ids = list.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of ['new-tab', 'close-tab', 'reload-page', 'ask-lumio', 'caret-browsing', 'show-next-tab', 'bookmark-this-page']) assert.ok(ids.includes(id), id);
  for (const id of ['name-window', 'pin-unpin-tab', 'move-tab-to-new-window']) assert.ok(ids.includes(id), `${id}: an item with an id but no shortcut can get one`);
  assert.equal(list.find((c) => c.id === 'name-window').accel, null);
  assert.equal(list.find((c) => c.id === 'caret-browsing').accel, 'F7');
  assert.ok(!ids.some((id) => /^(cmdorctrl|ctrl|cmd|f\d)/.test(id)), 'hidden extra keys aren’t commands');
  for (const c of list.filter((x) => x.accel)) assert.equal(sc.owner(template, {}, c.accel, c.id, MAC), null, `${c.label} (${c.accel}) is nobody else’s`);
  const accels = list.filter((c) => c.accel).map((c) => c.accel);
  assert.equal(new Set(accels).size, accels.length);
});

// A small menu, written like main/menu.js, the same on every computer (Mac keys).
const next = () => {};
const back = () => {};
const TEMPLATE = [
  { label: 'File', submenu: [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => {} },
    { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => {} },
    { id: 'name-window', label: 'Name Window…', click: () => {} },
    { label: 'Pin/Unpin Tab', click: () => {} },
    { label: 'Ctrl+F4', accelerator: 'Ctrl+F4', visible: false, acceleratorWorksWhenHidden: true, click: () => {} },
  ] },
  { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => {} }] },
  { label: 'History', submenu: [
    { label: 'Back', accelerator: 'Cmd+[', click: back },
    { label: 'Cmd+Left', accelerator: 'Cmd+Left', visible: false, acceleratorWorksWhenHidden: true, click: back },
  ] },
  { label: 'Window', submenu: [
    { label: 'Show Next Tab', accelerator: 'Cmd+Shift+]', click: next },
    { label: 'Ctrl+Tab', accelerator: 'Ctrl+Tab', visible: false, acceleratorWorksWhenHidden: true, click: () => {} },
    { role: 'minimize' },
  ] },
];

test('picking keys: free ones save, another command’s ask first, menu roles never move', () => {
  const opts = { mac: true };
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'new-tab', 'Cmd+Shift+Y', opts), { ok: true, overrides: { 'new-tab': 'Shift+Cmd+Y' } });
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'name-window', 'Ctrl+Alt+N', opts), { ok: true, overrides: { 'name-window': 'Ctrl+Alt+N' } });
  assert.deepEqual(sc.choose(TEMPLATE, { 'new-tab': 'Shift+Cmd+Y' }, 'new-tab', 'Cmd+T', opts), { ok: true, overrides: {} }, 'its own keys again: the override goes');
  // Another command's keys.
  const clash = sc.choose(TEMPLATE, {}, 'new-window', 'Cmd+T', opts);
  assert.deepEqual(clash, { conflict: { kind: 'command', id: 'new-tab', label: 'New Tab', replaceable: true, display: '⌘T' } });
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'new-window', 'Cmd+T', { ...opts, replace: true }), { ok: true, overrides: { 'new-tab': null, 'new-window': 'Cmd+T' } });
  // A menu role (Copy, Minimize): never replaced.
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'find', 'Cmd+C', { ...opts, replace: true }).conflict, { kind: 'role', label: 'Edit › Copy', replaceable: false, display: '⌘C' });
  assert.equal(sc.choose(TEMPLATE, {}, 'find', 'Cmd+M', opts).conflict.label, 'Window › Minimize');
  // A hidden extra key: named after its command when it's the same action.
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'find', 'Cmd+Left', opts).conflict, { kind: 'alias', label: 'Back', replaceable: true, display: '⌘←' });
  assert.equal(sc.choose(TEMPLATE, {}, 'find', 'Ctrl+Tab', opts).conflict.label, null);
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'back', 'Cmd+Left', opts), { ok: true, overrides: { back: 'Cmd+Left' } }, 'a command can take its own extra key');
  // None, and the errors.
  assert.deepEqual(sc.choose(TEMPLATE, {}, 'find', null, opts), { ok: true, overrides: { find: null } });
  assert.deepEqual(sc.choose(TEMPLATE, { 'name-window': 'F2' }, 'name-window', null, opts), { ok: true, overrides: {} }, 'no shortcut is its own default');
  assert.match(sc.choose(TEMPLATE, {}, 'find', 'K', opts).error, /Add ⌘/);
  assert.match(sc.choose(TEMPLATE, {}, 'gone', 'Cmd+K', opts).error, /isn’t in Lumio/);
  assert.match(sc.choose(TEMPLATE, {}, 'pin-unpin-tab', 'Cmd+K', opts).error, /isn’t in Lumio/, 'items without a shortcut or id aren’t commands');
  assert.deepEqual(sc.reset({ a: 'F2', b: null }, 'a'), { b: null });
  assert.deepEqual(sc.reset({ a: 'F2' }), {});
});

test('picked shortcuts go into the menu; extra keys and older defaults step aside', () => {
  const overrides = { 'new-window': 'Cmd+T', 'name-window': 'Ctrl+F4', find: null, 'show-next-tab': 'Ctrl+Tab' };
  const t = sc.apply(TEMPLATE, overrides, true);
  assert.notEqual(t, TEMPLATE, 'a copy');
  assert.equal(find(TEMPLATE, 'New Window').accelerator, 'CmdOrCtrl+N', 'the original stays as it was');
  assert.equal(find(t, 'New Window').accelerator, 'Cmd+T');
  assert.equal(find(t, 'New Tab').accelerator, undefined, 'its own ⌘T went to New Window');
  assert.equal(find(t, 'Name Window…').accelerator, 'Ctrl+F4');
  assert.equal(find(t, 'Ctrl+F4'), null, 'the hidden Ctrl+F4 stepped aside');
  assert.equal(find(t, 'Ctrl+Tab'), null);
  assert.equal(find(t, 'Show Next Tab').accelerator, 'Ctrl+Tab');
  assert.equal(find(t, 'Find…').accelerator, undefined, 'none');
  assert.equal(find(t, 'Cmd+Left').accelerator, 'Cmd+Left', 'other extra keys stay');
  assert.equal(sc.apply(TEMPLATE, {}, true), TEMPLATE, 'nothing picked: the same template');
  // The list Settings shows.
  const rows = sc.list(TEMPLATE, overrides, true);
  assert.deepEqual(rows.find((r) => r.id === 'new-tab'), { id: 'new-tab', label: 'New Tab', group: 'File', accel: null, display: '', default: 'Cmd+T', defaultDisplay: '⌘T', custom: false });
  assert.deepEqual(rows.find((r) => r.id === 'new-window'), { id: 'new-window', label: 'New Window', group: 'File', accel: 'Cmd+T', display: '⌘T', default: 'Cmd+N', defaultDisplay: '⌘N', custom: true });
  assert.equal(rows.find((r) => r.id === 'name-window').label, 'Name Window', 'without the …');
  // Keys someone wrote into settings by hand that can't work count as none.
  assert.equal(sc.list(TEMPLATE, { find: 'Q' }, true).find((r) => r.id === 'find').accel, null);
});

test('the window’s tooltips are told which keys changed, as they’re shown', () => {
  assert.deepEqual(sc.hints(TEMPLATE, {}, true), [], 'nothing picked: nothing to change');
  assert.deepEqual(sc.hints(TEMPLATE, { 'new-window': 'Cmd+T', find: null, 'name-window': 'F2' }, true), [
    { from: '⌘T', to: '' }, // New Tab gave its keys to New Window
    { from: '⌘N', to: '⌘T' },
    { from: '⌘F', to: '' },
  ], 'a command without keys of its own has no tooltip keys to change');
});

test('the application menu and the ⋮ menu show the shortcuts people picked', () => {
  const key = MAC ? 'Shift+Cmd+Y' : 'Ctrl+Shift+Y';
  const state = { shortcuts: { 'new-tab': key, 'caret-browsing': null } };
  const app = buildMenu(cmd, state);
  assert.equal(find(app, 'New Tab').accelerator, key);
  assert.equal(find(app, 'Caret Browsing').accelerator, undefined);
  assert.equal(find(app, 'Caret Browsing').checked, false);
  assert.equal(find(buildMenu(cmd, { caretBrowsing: true }), 'Caret Browsing').checked, true);
  // (Batch 3's ⋮ menu: entries for the overlay, with accel.)
  const dots = buildBrowserMenu(cmd, state);
  assert.equal(find(dots, 'New tab').accel, key, 'the ⋮ menu follows');
  assert.equal(find(dots, 'New window').accel, 'CmdOrCtrl+N', 'untouched items keep theirs');
  assert.equal(find(buildMenu(cmd, {}), 'Name Window…').id, 'name-window');
  if (MAC) assert.equal(buildMenu(cmd, {}).find((m) => m.label === 'Window').role, 'window', 'macOS lists the windows (and their names) there');
});

test('Settings asks for the list, saves a pick, resets, and the menu is rebuilt each time', () => {
  const handlers = {};
  const store = { settings: {}, setSetting(k, v) { this.settings[k] = v; } };
  let rebuilt = 0;
  sc.registerIpc({ internalHandle: (channel, hosts, fn) => { assert.deepEqual(hosts, ['settings']); handlers[channel] = fn; }, store, template: () => TEMPLATE, changed: () => rebuilt++, mac: true });
  const first = handlers['page:shortcuts']({});
  assert.equal(first.mac, true);
  assert.equal(first.commands.length, 6);
  const res = handlers['page:shortcut-set']({}, 'new-window', 'Cmd+T', false);
  assert.equal(res.conflict.label, 'New Tab');
  assert.equal(rebuilt, 0, 'nothing saved yet');
  const saved = handlers['page:shortcut-set']({}, 'new-window', 'Cmd+T', true);
  assert.equal(saved.ok, true);
  assert.deepEqual(store.settings.shortcuts, { 'new-tab': null, 'new-window': 'Cmd+T' });
  assert.equal(rebuilt, 1);
  handlers['page:shortcut-reset']({}, 'new-tab');
  assert.deepEqual(store.settings.shortcuts, { 'new-window': 'Cmd+T' });
  assert.equal(handlers['page:shortcut-reset']({}, null).commands.every((c) => !c.custom), true);
  assert.deepEqual(store.settings.shortcuts, {});
  assert.equal(rebuilt, 3);
});

// ---------------------------------------------------------------- the page
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    // The window's tooltips module (renderer/ui), on a page of buttons.
    if (req.url === '/tooltips') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TOOLTIPS_PAGE);
      return;
    }
    if (req.url === '/ui/shortcut-hints.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(fs.readFileSync(new URL('../renderer/ui/shortcut-hints.js', import.meta.url)));
      return;
    }
    const file = resolveFile(new URL(`lumio://settings${req.url}`), PAGE_HOSTS);
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

// The page, answered by main/shortcuts.js over TEMPLATE (Mac keys).
async function openPage({ colorScheme = 'dark' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const store = { settings: {}, setSetting(k, v) { this.settings[k] = v; } };
  const handlers = {};
  sc.registerIpc({ internalHandle: (channel, _hosts, fn) => { handlers[channel] = fn; }, store, template: () => TEMPLATE, changed: () => {}, mac: true });
  const calls = [];
  await page.exposeFunction('__lumioInvoke', (channel, args) => { calls.push([channel, ...args]); return handlers[channel]?.({}, ...args) ?? null; });
  await page.addInitScript(() => { window.lumioPage = { invoke: (c, ...a) => window.__lumioInvoke(c, a), on: () => {} }; });
  await page.goto(`${base}/shortcuts`);
  await page.waitForSelector('.sc-item');
  return { page, errors, store, calls };
}
const keyOf = (page, label) => page.$eval(`.sc-item:has(.title:text-is("${label}")) .kbd`, (b) => b.textContent);
const item = (label) => `.sc-item:has(.title:text-is("${label}"))`;

test('Keyboard shortcuts page: lists the commands by menu, records keys, and asks before taking another command’s', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors, store } = await openPage();
  assert.deepEqual(await page.$$eval('#sc-list h2', (hs) => hs.map((h) => h.textContent)), ['File', 'Edit', 'History', 'Window']);
  assert.equal(await keyOf(page, 'New Tab'), '⌘T');
  assert.equal(await keyOf(page, 'Name Window'), 'Add shortcut');
  assert.equal(await page.isVisible('#sc-reset-all'), false);

  // Click the shortcut and press new keys.
  await page.click(`${item('New Tab')} .kbd`);
  assert.equal(await keyOf(page, 'New Tab'), 'Press keys…');
  assert.equal(await page.getAttribute(`${item('New Tab')} .kbd`, 'aria-pressed'), 'true');
  await page.keyboard.press('Meta+Shift+KeyY');
  await page.waitForFunction(() => document.querySelector('.sc-item[data-id="new-tab"] .kbd').textContent === '⇧⌘Y');
  assert.deepEqual(store.settings.shortcuts, { 'new-tab': 'Shift+Cmd+Y' });
  assert.match(await page.textContent(`${item('New Tab')} .desc`), /Lumio’s own: ⌘T/);
  assert.equal(await page.evaluate(() => document.activeElement.closest('.sc-item')?.dataset.id), 'new-tab', 'the keyboard stays on it');
  await page.waitForFunction(() => /New Tab is now ⇧⌘Y/.test(document.getElementById('sc-status').textContent));
  assert.equal(await page.isVisible('#sc-reset-all'), true);

  // Keys that need a modifier: an error, and it keeps listening.
  await page.keyboard.press('Enter'); // the focused shortcut: record again
  await page.keyboard.press('KeyK');
  assert.match(await page.textContent(`${item('New Tab')} .sc-note`), /Add ⌘ or ⌃/);
  assert.equal(await keyOf(page, 'New Tab'), 'Press keys…');
  // A menu role's keys: can't move.
  await page.keyboard.press('Meta+KeyC');
  assert.match(await page.textContent(`${item('New Tab')} .sc-note`), /used by Edit › Copy, which can’t change/);
  await page.keyboard.press('Escape');
  assert.equal(await keyOf(page, 'New Tab'), '⇧⌘Y', 'Esc leaves it as it was');

  // Another command's keys: Replace (keyboard only).
  await page.click(`${item('New Window')} .kbd`);
  await page.keyboard.press('Meta+Shift+KeyY');
  await page.waitForSelector(`${item('New Window')} [data-act=replace]`);
  assert.match(await page.textContent(`${item('New Window')} .sc-note`), /⇧⌘Y is used by New Tab\./);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'replace', 'the choice has the keyboard');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.sc-item[data-id="new-window"] .kbd').textContent === '⇧⌘Y');
  assert.equal(await keyOf(page, 'New Tab'), 'Add shortcut', 'New Tab gave it up');
  assert.deepEqual(store.settings.shortcuts, { 'new-tab': null, 'new-window': 'Shift+Cmd+Y' });

  // Backspace removes; Reset brings Lumio's back.
  await page.click(`${item('Find')} .kbd`);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelector('.sc-item[data-id="find"] .kbd').textContent === 'Add shortcut');
  await page.click(`${item('Find')} [data-act=reset]`);
  await page.waitForFunction(() => document.querySelector('.sc-item[data-id="find"] .kbd').textContent === '⌘F');

  // Search, then Reset all.
  await page.fill('#sc-q', 'window');
  assert.deepEqual(await page.$$eval('.sc-item .title', (els) => els.map((e) => e.textContent)), ['New Window', 'Name Window']);
  await page.fill('#sc-q', 'zzz');
  assert.match(await page.textContent('#sc-list'), /No commands match/);
  await page.fill('#sc-q', '');
  await page.click('#sc-reset-all');
  await page.waitForFunction(() => document.querySelector('.sc-item[data-id="new-tab"] .kbd').textContent === '⌘T');
  assert.deepEqual(store.settings.shortcuts, {});
  await page.close();
  assert.deepEqual(errors, []);
});

for (const scheme of ['light', 'dark']) {
  test(`Keyboard shortcuts page in ${scheme}: its colors and readable keys`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    const { page, errors } = await openPage({ colorScheme: scheme });
    await page.click(`${item('New Tab')} .kbd`);
    await page.keyboard.press('KeyK'); // an error note
    const KBD = '.sc-item:not(.rec) .kbd';
    const c = await readColors(page, { tokens: ['--text', '--danger-text'], parts: ['body', '.card', KBD] });
    const kbdText = await page.evaluate((sel) => { const ctx = document.createElement('canvas').getContext('2d'); ctx.fillStyle = getComputedStyle(document.querySelector(sel)).color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; }, KBD);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `shortcuts-${scheme}.png`), fullPage: true });
    await page.close();
    assert.deepEqual(errors, []);
    for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.6 : luminance(rgb) < 0.06, `${part} is ${scheme} (rgb ${rgb})`);
    assert.ok(contrast(c.tokens['--text'], c.parts.body) >= 4.5);
    assert.ok(contrast(kbdText, c.parts[KBD]) >= 4.5, 'keys are readable');
    assert.ok(contrast(c.tokens['--danger-text'], c.parts['.card']) >= 4.5, 'the error note is readable');
  });
}

// ---------------------------------------------------------------- the window's tooltips
const TOOLTIPS_PAGE = `<!doctype html><meta charset="utf-8"><body>
  <button id="nt" title="New Tab (⌘T)"></button><button id="sb" title="Show sidebar (⌘⇧S)"></button>
  <button id="rl" title="Reload (⌘R)"></button><button id="tab" title="Inbox (2)&#10;https://mail.example/"></button>
  <script type="module" src="/ui/shortcut-hints.js"></script></body>`;

test('the window’s tooltips show the keys people picked, follow the UI’s own changes, and go back on reset', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Main's answer at start (renderer/ui/shortcut-hints.js asks 'shell:shortcut-hints'), from the real keymap.
  const first = sc.hints(menuTemplate(cmd, {}), { 'new-tab': 'Shift+Cmd+Y', 'show-hide-sidebar': null }, true);
  await page.addInitScript((hints) => {
    window.__push = null;
    window.lumio = {
      invoke: async (channel) => (channel === 'shell:shortcut-hints' ? hints : null),
      on: (channel, fn) => { if (channel === 'shortcut-hints') window.__push = fn; },
    };
  }, first);
  await page.goto(`${base}/tooltips`);
  const titles = () => page.$$eval('[title]', (els) => Object.fromEntries(els.map((e) => [e.id, e.title])));
  await page.waitForFunction(() => document.getElementById('nt').title.endsWith('Y)'));
  assert.deepEqual(await titles(), {
    nt: 'New Tab (⇧⌘Y)',
    sb: 'Show sidebar', // ⌘⇧S and ⇧⌘S are the same keys; it has none now
    rl: 'Reload (⌘R)',
    tab: 'Inbox (2)\nhttps://mail.example/',
  });
  // The UI sets a tooltip again, or adds one later (the sidebar draws its own).
  await page.evaluate(() => {
    document.getElementById('nt').title = 'New tab (⌘T)';
    document.body.insertAdjacentHTML('beforeend', '<div><button id="late" title="Hide sidebar (⌘⇧S)"></button></div>');
  });
  await page.waitForFunction(() => document.getElementById('late').title === 'Hide sidebar' && document.getElementById('nt').title === 'New tab (⇧⌘Y)');
  // Reset all: main sends no changes, and every tooltip is the UI's own again.
  await page.evaluate(() => window.__push([]));
  assert.deepEqual(await titles(), {
    nt: 'New tab (⌘T)',
    sb: 'Show sidebar (⌘⇧S)',
    rl: 'Reload (⌘R)',
    tab: 'Inbox (2)\nhttps://mail.example/',
    late: 'Hide sidebar (⌘⇧S)',
  });
  // Windows spells keys out; the order of the modifiers doesn't matter there either.
  assert.deepEqual(await page.evaluate(async () => {
    const { canon, retitle } = await import('/ui/shortcut-hints.js');
    return [canon('Shift+Ctrl+G') === canon('Ctrl+Shift+G'), canon('Ctrl++'), retitle('Previous (Shift+Ctrl+G)', new Map([[canon('Ctrl+Shift+G'), 'Ctrl+K']]))];
  }), [true, 'Ctrl++', 'Previous (Ctrl+K)']);
  await page.close();
  assert.deepEqual(errors, []);
});
