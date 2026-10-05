// The new extension and help UI in headless Chrome with a stand-in browser:
//  - the puzzle-piece menu, the "Change back to Lumio's new tab page?"
//    question and "Report an issue…" (renderer/ui/overlay-*.js)
//  - the toolbar's pinned extension buttons (renderer/ui/extensions-bar.js)
//  - lumio://extensions details and shortcuts, lumio://version and
//    lumio://flags-lite
// Each by keyboard and mouse, in light and dark. Skipped when Google Chrome
// isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const SHOTS = process.env.LUMIO_SHOTS;

// One server per lumio:// host, so renderer/ui and renderer/pages files don't mix.
function serve(host, hosts) {
  const server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://${host}${req.url}`), hosts);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

let browser, overlay, shell, pages;
before(async () => {
  if (!CHROME) return;
  overlay = await serve('overlay', new Set(['overlay']));
  shell = await serve('shell', new Set(['shell']));
  pages = await serve('extensions', PAGE_HOSTS);
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); overlay?.close(); shell?.close(); pages?.close(); });
const base = (server) => `http://127.0.0.1:${server.address().port}`;

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
const sentTo = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return [el.dataset.act || el.dataset.ntp || el.dataset.fb || el.id || el.tagName.toLowerCase(), el.closest('[data-id]')?.dataset.id || ''];
});

// The overlay with a stand-in window.lumio: __show(payload) plays the browser
// opening it; invoke answers come from window.__answers.
async function openOverlay(colorScheme = 'light', viewport = { width: 384, height: 520 }) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = watch(page);
  await page.addInitScript(() => {
    const handlers = {};
    window.__sent = [];
    window.__invoked = [];
    window.__answers = {};
    window.__show = (payload) => (handlers['overlay-data'] || []).forEach((fn) => fn(payload));
    window.lumio = {
      send: (c, p) => window.__sent.push([c, p]),
      invoke: async (c, p) => { window.__invoked.push([c, p]); return window.__answers[c] ?? null; },
      on: (c, fn) => { (handlers[c] ||= []).push(fn); return () => {}; },
    };
  });
  await page.goto(`${base(overlay)}/overlay.html`);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  return { page, errors };
}

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const MENU = {
  kind: 'extensions', fresh: true, mac: true,
  items: [
    { id: A, key: A, name: 'Dark Reader', icon: null, hasAction: true, pinned: true, here: 'granted', access: 'all', host: 'news.com', siteListed: false, changeable: true, choice: 'all' },
    { id: B, key: '/Users/me/dev/tool', name: 'Dev Tool', icon: null, hasAction: false, pinned: false, here: 'withheld', access: 'click', host: 'news.com', siteListed: false, changeable: false, choice: 'click' },
  ],
};

for (const scheme of ['light', 'dark']) {
  test(`the puzzle-piece menu in ${scheme}: run, pin and site access, by keyboard and mouse`, { skip }, async () => {
    const { page, errors } = await openOverlay(scheme);
    await page.evaluate((p) => window.__show(p), MENU);
    assert.equal(await page.$eval('.xm', (e) => e.getAttribute('role')), 'menu');
    assert.match(await page.innerText('#card'), /Extensions\s+Dark Reader\s+Can read and change this site[\s\S]*Dev Tool\s+Not allowed on this site[\s\S]*Manage extensions/i);
    assert.deepEqual(await focused(page), ['activate', A], 'the first extension has the focus');
    assert.equal(await page.$eval(`[data-id="${A}"] .xm-pin`, (e) => e.getAttribute('aria-checked')), 'true');
    assert.equal(await page.$$eval(`[data-id="${B}"] .xm-pin`, (els) => els.length), 0, 'nothing to pin without a toolbar button');

    const c = await readColors(page, { tokens: ['--text', '--dim'], parts: ['#card', '.xm-row:focus-within'] });
    assert.ok(scheme === 'light' ? luminance(c.parts['#card']) > 0.8 : luminance(c.parts['#card']) < 0.05, `the menu is ${scheme}`);
    assert.ok(contrast(c.tokens['--text'], c.parts['.xm-row:focus-within']) >= 4.5, 'names readable on the focused row');
    assert.ok(contrast(c.tokens['--dim'], c.parts['.xm-row:focus-within']) >= 4.5, 'status readable on the focused row');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `extensions-menu-${scheme}.png`) });

    // Down goes row to row; right goes along the row (run, pin, more).
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(page), ['activate', B]);
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(page), ['manage', '']);
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await focused(page), ['activate', A], 'it wraps around');
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await focused(page), ['unpin', A]);
    await page.keyboard.press('Enter');
    assert.deepEqual(await sentTo(page, 'extensions:menu-act'), [{ act: 'unpin', id: A, key: A }]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    // ⋮ opened its panel: who may read and change sites.
    assert.match(await page.innerText('.xm-panel'), /This can read and change site data\s+When you click the extension\s+On news\.com\s+On all sites\s+Manage extension/);
    assert.equal(await page.$eval(`[data-id="${A}"] .xm-more`, (e) => e.getAttribute('aria-expanded')), 'true');
    assert.equal(await page.$eval('.xm-choice[aria-checked="true"]', (e) => e.dataset.choice), 'all');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.choice), 'click', 'into the choices');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sentTo(page, 'extensions:menu-act')).at(-1), { act: 'access', id: A, key: A, choice: 'site' });
    // Esc folds the panel first, then closes the menu.
    await page.keyboard.press('Escape');
    assert.deepEqual(await focused(page), ['more', A]);
    assert.equal(await page.$$eval('.xm-panel', (els) => els.length), 0);
    await page.keyboard.press('Escape');
    assert.deepEqual(await sentTo(page, 'extensions:menu-close'), [{ refocus: true }]);

    // The mouse: run it, open an unpacked one's panel (can't be limited), manage.
    await page.click(`[data-id="${A}"] .xm-main`);
    await page.click(`[data-id="${B}"] .xm-main`, { force: true });
    await page.click(`[data-id="${B}"] .xm-more`);
    assert.equal(await page.$$eval(`.xm-panel[data-id="${B}"] .xm-choice[data-act=access]:disabled`, (els) => els.length), 3);
    assert.match(await page.innerText('.xm-panel'), /keep the access their manifest asks for/);
    await page.click('.xm-panel [data-act=details]');
    await page.click('.xm-manage');
    assert.deepEqual((await sentTo(page, 'extensions:menu-act')).slice(-3), [
      { act: 'activate', id: A, key: A },
      { act: 'details', id: B, key: '/Users/me/dev/tool' },
      { act: 'manage', id: undefined, key: undefined },
    ], 'an extension without a toolbar button doesn’t run');
    // It sizes itself, and closes when it loses focus (like a menu).
    const sizes = await sentTo(page, 'overlay:size');
    assert.ok(sizes.length && sizes.every((s) => s.height > 150 && s.height < 420), JSON.stringify(sizes));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.deepEqual((await sentTo(page, 'extensions:menu-close')).at(-1), {});
    // No extensions on: a hint and the way to manage them.
    await page.evaluate(() => window.__show({ kind: 'extensions', fresh: true, items: [] }));
    assert.match(await page.innerText('#card'), /No extensions are on/);
    assert.deepEqual(await focused(page), ['manage', '']);
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('“Change back to Lumio’s new tab page?”: Change it back has the focus; Keep it and Esc work', { skip }, async () => {
  const { page, errors } = await openOverlay('dark');
  await page.evaluate(() => window.__show({ kind: 'ntp-override', name: 'Momentum' }));
  assert.equal(await page.$eval('.xn', (e) => e.getAttribute('role')), 'alertdialog');
  assert.match(await page.innerText('#card'), /Change back to Lumio’s new tab page\?\s+“Momentum” changed what you see when you open a new tab\.\s+Keep it\s+Change it back/);
  assert.deepEqual(await focused(page), ['revert', '']);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'extensions-ntp-prompt.png') });
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.click('[data-ntp=revert]');
  assert.deepEqual(await sentTo(page, 'extensions:ntp'), [{ decision: 'keep' }, { decision: 'later' }, { decision: 'revert' }]);
  await page.close();
  assert.deepEqual(errors, []);
});

const SHOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPj/n4GBgYHhPwMDAwAt8gP9tA3e2wAAAABJRU5ErkJggg==';
const FEEDBACK = { kind: 'feedback', url: 'https://news.com/story?id=1', thumb: SHOT, email: 'me@example.com', signedIn: true, system: { lumio: '0.6.7', chromium: '146.0', electron: '43.7.7', os: 'macOS 15.1', arch: 'arm64', language: 'en-US' } };

for (const scheme of ['light', 'dark']) {
  test(`Report an issue in ${scheme}: the page goes only if ticked, keyboard, and errors`, { skip }, async () => {
    const { page, errors } = await openOverlay(scheme, { width: 484, height: 760 });
    await page.evaluate((p) => window.__show(p), FEEDBACK);
    assert.equal(await page.$eval('#fb', (e) => e.getAttribute('role')), 'dialog');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'fb-text', 'ready to type');
    assert.deepEqual(await page.$$eval('.fb-check input', (els) => els.map((e) => [e.id, e.checked])), [['fb-url', false], ['fb-shot', false], ['fb-system', true]], 'nothing about the page unless ticked');
    assert.match(await page.innerText('#card'), /news\.com\/story/);
    assert.equal(await page.$eval('#fb-email', (e) => e.value), 'me@example.com');
    assert.match(await page.innerText('.fb-note'), /sent with your Lumio account/, 'says the account goes with it');
    assert.equal(await page.$eval('#fb-send', (e) => e.disabled), true, 'nothing to send yet');
    await page.click('.fb-sys summary');
    assert.match(await page.innerText('.fb-sys'), /Lumio Browser\s+0\.6\.7[\s\S]*System\s+macOS 15\.1/);
    const c = await readColors(page, { tokens: ['--text', '--muted', '--label'], parts: ['#card', '.fb-check', '.fb-field textarea'] });
    assert.ok(scheme === 'light' ? luminance(c.parts['#card']) > 0.8 : luminance(c.parts['#card']) < 0.05, `the dialog is ${scheme}`);
    for (const part of ['#card', '.fb-check', '.fb-field textarea']) assert.ok(contrast(c.tokens['--text'], c.parts[part]) >= 4.5, `text readable on ${part}`);
    assert.ok(contrast(c.tokens['--muted'], c.parts['.fb-check']) >= 4.5, 'notes readable on the boxes');

    await page.focus('#fb-text');
    await page.keyboard.type('The video froze after an ad.');
    assert.equal(await page.$eval('#fb-send', (e) => e.disabled), false);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `report-issue-${scheme}.png`) });
    // ⌘/Ctrl+Enter sends; the server is unreachable this time.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.waitForSelector('#fb-error:not([hidden])');
    assert.match(await page.innerText('#fb-error'), /didn’t send/);
    assert.deepEqual(await page.evaluate(() => window.__invoked.filter(([c]) => c === 'help:send').map(([, p]) => p)), [
      { description: 'The video froze after an ad.', email: 'me@example.com', includeUrl: false, includeShot: false, includeSystem: true },
    ]);
    // Ticked this time, and it goes through.
    await page.check('#fb-url');
    await page.check('#fb-shot');
    await page.evaluate(() => { window.__answers['help:send'] = { ok: true }; });
    await page.click('#fb-send');
    await page.waitForSelector('.fb-done');
    assert.match(await page.innerText('#card'), /Thanks!/);
    const last = await page.evaluate(() => window.__invoked.at(-1)[1]);
    assert.deepEqual([last.includeUrl, last.includeShot], [true, true]);
    await page.waitForFunction(() => window.__sent.some(([c]) => c === 'help:close'), null, { timeout: 4000 });

    // Tab stays inside the dialog; Esc cancels.
    await page.evaluate((p) => window.__show(p), { ...FEEDBACK, url: '', thumb: null, signedIn: false });
    assert.doesNotMatch(await page.innerText('.fb-note'), /account/, 'signed out: no account');
    assert.equal(await page.$$eval('#fb-url, #fb-shot', (els) => els.length), 0, 'nothing to offer on Lumio’s own pages');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.fb), 'cancel', 'from the first field back to the last button');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'fb-text');
    await page.keyboard.press('Escape');
    assert.equal((await sentTo(page, 'help:close')).length, 2);
    await page.close();
    assert.deepEqual(errors, []);
  });
}

// ---------------------------------------------------------------- the toolbar
const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false, vision: true, macAvailable: true };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, wcId: 12, title: 'News', url: 'https://news.com/', favicon: null, loading: false, canGoBack: false, canGoForward: false, pinned: false, pdf: false }] },
  downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: false }, profile: {}, incognito: false, extensions: true, platform: 'darwin', version: '0.6.7', update: null,
};

test('the toolbar shows only pinned extensions; the puzzle opens the menu; right-click and shortcuts', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  const errors = watch(page);
  await page.addInitScript(({ init, ai, a, b }) => {
    const handlers = {};
    window.__sent = [];
    window.__activated = [];
    window.__pinned = [a];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] }, 'ai:projects': [], 'ai:schedules': [] };
    window.lumio = {
      invoke: async (c) => (c === 'extensions:toolbar' ? { available: true, pinned: window.__pinned } : answers[c] ?? null),
      send: (c, p) => window.__sent.push([c, p]),
      on: (c, fn) => { (handlers[c] ||= []).push(fn); return () => {}; },
    };
    // electron-chrome-extensions' window.browserAction (preload/shell.js).
    const listeners = [];
    window.browserAction = {
      addEventListener: (name, fn) => listeners.push(fn),
      addObserver() {},
      getState: async () => { const state = { actions: [{ id: a }, { id: b }] }; setTimeout(() => listeners.forEach((fn) => fn(state))); return state; },
      activate: (partition, details) => window.__activated.push([partition, details]),
    };
  }, { init: INIT, ai: AI, a: A, b: B });
  await page.goto(`${base(shell)}/`);
  await page.waitForFunction((a) => document.querySelector(`#ext-actions [id="${a}"]`), A);
  assert.equal(await page.isVisible('#ext-area'), true);
  assert.deepEqual(await page.$$eval('#ext-actions > *', (els) => els.map((e) => [e.id, e.tagName, e.className])), [[A, 'BUTTON', 'ext-action']], 'pinned ones only');
  assert.equal(await page.$eval('#ext-actions', (e) => e.getAttribute('aria-label')), 'Pinned extensions');

  await page.click('#ext-btn');
  const [menu] = await sentTo(page, 'extensions:menu');
  const r = await page.$eval('#ext-btn', (e) => e.getBoundingClientRect().toJSON());
  assert.deepEqual(menu.rect, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  assert.equal(await page.$eval('#ext-btn', (e) => e.getAttribute('aria-haspopup')), 'menu');

  // The menu or a keyboard shortcut runs one: its popup opens under its button.
  await page.evaluate((a) => window.__emit('ext-activate', { id: a }), A);
  await page.evaluate((b) => window.__emit('ext-activate', { id: b }), B);
  const runs = await page.evaluate(() => window.__activated);
  const pin = await page.$eval(`[id="${A}"]`, (e) => e.getBoundingClientRect().toJSON());
  assert.deepEqual(runs[0], ['persist:lumio', { eventType: 'click', extensionId: A, tabId: 12, alignment: 'bottom left', anchorRect: { x: pin.x, y: pin.y, width: pin.width, height: pin.height } }]);
  assert.deepEqual(runs[1][1].anchorRect, { x: r.x, y: r.y, width: r.width, height: r.height }, 'an unpinned one opens under the puzzle piece');

  await page.click(`[id="${A}"]`, { button: 'right' });
  const [ctx] = await sentTo(page, 'extensions:context');
  assert.equal(ctx.id, A);
  // Esc closed the menu: the puzzle piece gets the focus back.
  await page.evaluate(() => window.__emit('ext-menu-closed', { refocus: true }));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ext-btn');
  // Another tab: the buttons show its state.
  await page.evaluate(() => window.__emit('tabs', { activeId: 2, tabs: [{ id: 2, wcId: 15, title: 'Other', url: 'https://other.com/' }] }));
  await page.waitForFunction((a) => document.querySelector(`[id="${a}"]`).tab === 15, A);
  // Unpinned elsewhere: gone.
  await page.evaluate(() => { window.__pinned = []; window.__emit('extensions-changed'); });
  await page.waitForFunction(() => !document.querySelector('#ext-actions > *'));
  await page.close();
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------- pages
async function openPage(file, { colorScheme = 'light', answers = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme });
  const errors = watch(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript((answers) => {
    window.__calls = [];
    window.__answers = answers;
    window.lumioPage = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return structuredClone(window.__answers[channel] ?? null); },
      on: () => {},
    };
  }, answers);
  await page.goto(`${base(pages)}/${file}`);
  return { page, errors };
}
const calls = (page, channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map(([, ...a]) => a), channel);

const DETAILS = {
  id: A, key: A, name: 'Dark Reader', description: 'Dark mode for every website.', version: '4.9.1', type: 'store', path: '/x', enabled: true, icon: null, options: 'options.html', error: null, hasAction: true, pinned: true, siteAccess: 'sites',
  permissions: ['Read and change all your data on all websites', 'Read your browsing history'],
  limitations: ['Blocking content with rule lists may not work.'],
  access: { mode: 'sites', sites: ['news.com'], applies: true, changeable: true },
  fileAccess: false, size: 2_400_000,
  commands: [{ name: '_execute_action', description: 'Activate the extension', shortcut: 'Alt+Shift+D', action: true, suggested: 'Alt+Shift+D' }],
  homepage: `https://chromewebstore.google.com/detail/${A}`, incognito: { available: false },
};
const LIST = { available: true, developerMode: true, items: [{ ...DETAILS }] };
const IS_MAC = process.platform === 'darwin';
const SHORTCUTS = {
  available: true, mac: IS_MAC,
  extensions: [{ id: A, name: 'Dark Reader', icon: null, commands: [
    { name: '_execute_action', description: 'Activate the extension', shortcut: 'Alt+Shift+D', suggested: 'Alt+Shift+D', label: IS_MAC ? '⌥⇧D' : 'Alt+Shift+D' },
    { name: 'toggle', description: 'Toggle for this site', shortcut: '', suggested: 'Alt+Shift+T', label: '' },
  ] }],
};

for (const scheme of ['light', 'dark']) {
  test(`lumio://extensions in ${scheme}: details, site access, file access, and developer mode`, { skip }, async () => {
    const { page, errors } = await openPage('extensions.html', { colorScheme: scheme, answers: { 'page:extensions': LIST, 'page:extension-details': DETAILS, 'page:extension-pack': { ok: true, crx: '/dev/ext.crx', pem: '/dev/ext.pem' } } });
    await page.waitForSelector('.ext');
    assert.deepEqual(await page.$$eval('#devbar button', (els) => els.map((e) => e.textContent)), ['Load unpacked…', 'Pack extension…', 'Update']);
    await page.click('#pack');
    await page.waitForSelector('#msg:not([hidden])');
    assert.match(await page.innerText('#msg'), /Packed\. Extension: \/dev\/ext\.crx · Key \(keep it safe/);
    await page.click('#update');
    assert.ok((await calls(page, 'page:extension-update')).length === 1);

    // Details: description, version, size, permissions, what may not work, site access.
    await page.click('.ext [data-act=details]');
    await page.waitForSelector('.d-head h1');
    assert.equal(new URL(page.url()).search, `?id=${A}`);
    const text = await page.innerText('#view-details');
    assert.match(text, /Dark Reader[\s\S]*Dark mode for every website\.[\s\S]*4\.9\.1[\s\S]*2\.4 MB/);
    assert.match(text, /Permissions\s+Read and change all your data on all websites\s+Read your browsing history/i);
    assert.match(text, /May not work fully in Lumio\s+Blocking content with rule lists may not work\./i);
    assert.match(text, /Site access\s+When you click the extension[\s\S]*On specific sites[\s\S]*On all sites/i);
    assert.match(text, /Allow in Incognito[\s\S]*Allow access to file URLs[\s\S]*Keyboard shortcuts\s+1 set/);
    assert.equal(await page.$eval('#d-incognito', (e) => e.disabled), true, 'not possible in Lumio yet, and it says so');
    assert.equal(await page.$eval('input[name=access]:checked', (e) => e.value), 'sites');
    const c = await readColors(page, { tokens: ['--text', '--dim'], parts: ['body', '.card', '.site'] });
    assert.ok(scheme === 'light' ? luminance(c.parts.body) > 0.7 : luminance(c.parts.body) < 0.05, `the page is ${scheme}`);
    for (const part of ['body', '.card', '.site']) assert.ok(contrast(c.tokens['--text'], c.parts[part]) >= 4.5, `text readable on ${part}`);
    assert.ok(contrast(c.tokens['--dim'], c.parts['.card']) >= 4.5, 'descriptions readable');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `extension-details-${scheme}.png`), fullPage: true });

    // Sites: add one with Enter, remove one; switch the mode with the keyboard.
    await page.fill('#site-input', 'blog.org');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:extension-set-access'));
    await page.click('[data-site="news.com"]');
    await page.focus('input[name=access][value=sites]');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__calls.filter(([c]) => c === 'page:extension-set-access').length === 3);
    assert.deepEqual(await calls(page, 'page:extension-set-access'), [
      [A, { mode: 'sites', sites: ['news.com', 'blog.org'] }],
      [A, { mode: 'sites', sites: [] }],
      [A, { mode: 'all', sites: ['news.com'] }],
    ]);
    await page.click('label:has(#d-files)');
    await page.click('label:has(#d-pin)');
    await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:extension-pin'));
    assert.deepEqual(await calls(page, 'page:extension-file-access'), [[A, true]]);
    assert.deepEqual(await calls(page, 'page:extension-pin'), [[A, false]]);
    await page.click('#d-home');
    assert.deepEqual(await calls(page, 'page:open'), [[DETAILS.homepage, 'tab']]);
    await page.click('#d-remove');
    assert.deepEqual(await calls(page, 'page:extension-remove'), [[A, 'Dark Reader']]);
    // Back to the list.
    await page.click('.back');
    await page.waitForSelector('#view-list:not([hidden])');
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('lumio://extensions/shortcuts: type a shortcut, clear one, Esc cancels', { skip }, async () => {
  const { page, errors } = await openPage('shortcuts', { colorScheme: 'dark', answers: { 'page:extension-shortcuts': SHORTCUTS, 'page:extension-set-shortcut': { ok: true } } });
  await page.waitForSelector('.sc-box');
  assert.equal(await page.title(), 'Keyboard shortcuts');
  assert.match(await page.innerText('#sc-list'), /Dark Reader\s+Activate the extension[\s\S]*Toggle for this site\s+Its suggested shortcut is turned off or changed\.\s+Not set/);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'extension-shortcuts.png') });
  const box = '.sc-box[data-name="toggle"]';
  await page.click(box);
  assert.equal(await page.$eval(box, (e) => e.textContent), 'Type a shortcut');
  assert.deepEqual(await calls(page, 'page:extension-recording'), [[true]], 'Lumio’s own shortcuts pause meanwhile');
  await page.keyboard.press('Shift');
  await page.keyboard.press(IS_MAC ? 'Meta+Shift+KeyY' : 'Control+Shift+KeyY');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:extension-set-shortcut'));
  assert.deepEqual(await calls(page, 'page:extension-set-shortcut'), [[A, 'toggle', IS_MAC ? 'Command+Shift+Y' : 'Ctrl+Shift+Y']]);
  assert.deepEqual((await calls(page, 'page:extension-recording')).at(-1), [false]);
  // Backspace clears; the ✕ too.
  await page.focus('.sc-box[data-name="_execute_action"]');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await page.click('[data-clear][data-name="_execute_action"]');
  await page.waitForFunction(() => window.__calls.filter(([c]) => c === 'page:extension-set-shortcut').length === 3);
  assert.deepEqual((await calls(page, 'page:extension-set-shortcut')).slice(1), [[A, '_execute_action', ''], [A, '_execute_action', '']]);
  // A refused shortcut says why; Esc leaves it as it was.
  await page.evaluate(() => { window.__answers['page:extension-set-shortcut'] = { ok: false, error: 'Lumio already uses that shortcut.' }; });
  await page.click(box);
  await page.keyboard.press(IS_MAC ? 'Meta+KeyT' : 'Control+KeyT');
  await page.waitForSelector('#sc-msg:not([hidden])');
  assert.equal(await page.innerText('#sc-msg'), 'Lumio already uses that shortcut.');
  assert.equal(await page.$eval(box, (e) => e.classList.contains('recording')), true, 'still waiting for a shortcut');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval(box, (e) => e.textContent), 'Not set');
  await page.close();
  assert.deepEqual(errors, []);
});

const VERSION = { name: 'Lumio Browser', version: '0.6.7', beta: false, chromium: '146.0.7680.80', electron: '43.7.7', v8: '14.6.1', node: '24.15.0', os: 'macOS 15.1 (arm64)', userAgent: 'Mozilla/5.0', executable: '/Applications/Lumio Browser.app/Contents/MacOS/Lumio Browser', profile: '/Users/me/Library/Application Support/Lumio Browser', commandLine: '/Applications/Lumio Browser.app/Contents/MacOS/Lumio Browser --flag', notesUrl: 'https://github.com/x/releases/tag/v0.6.7' };
const FLAGS = { restart: false, flags: [
  { id: 'smoothScrolling', name: 'Smooth scrolling', description: 'Animate scrolling.', value: true, default: true },
  { id: 'forceDark', name: 'Dark mode for all websites', description: 'Dark colors everywhere.', value: false, default: false },
] };

for (const scheme of ['light', 'dark']) {
  test(`lumio://version and lumio://flags-lite in ${scheme}`, { skip }, async () => {
    const v = await openPage('version.html', { colorScheme: scheme, answers: { 'page:version-info': VERSION } });
    await v.page.waitForSelector('.kv');
    const rows = await v.page.$$eval('.kv', (els) => els.map((e) => e.querySelector('span').textContent));
    assert.deepEqual(rows, ['Lumio Browser', 'Chromium', 'Electron', 'V8', 'Node.js', 'System', 'User agent', 'Executable path', 'Profile path', 'Command line']);
    assert.match(await v.page.innerText('#info'), /Lumio Browser\s+0\.6\.7[\s\S]*Electron\s+43\.7\.7[\s\S]*Profile path\s+\/Users\/me/);
    const c = await readColors(v.page, { tokens: ['--text', '--dim'], parts: ['body', '.card'] });
    assert.ok(scheme === 'light' ? luminance(c.parts.body) > 0.7 : luminance(c.parts.body) < 0.05);
    assert.ok(contrast(c.tokens['--dim'], c.parts['.card']) >= 4.5, 'labels readable');
    if (SHOTS) await v.page.screenshot({ path: path.join(SHOTS, `version-${scheme}.png`) });
    await v.page.click('#notes');
    assert.deepEqual(await calls(v.page, 'page:open'), [[VERSION.notesUrl, 'tab']]);
    await v.page.close();
    assert.deepEqual(v.errors, []);

    const f = await openPage('flags-lite.html', { colorScheme: scheme, answers: { 'page:flags': FLAGS, 'page:set-flag': { ...FLAGS, restart: true, flags: [FLAGS.flags[0], { ...FLAGS.flags[1], value: true }] }, 'page:flags-reset': FLAGS } });
    await f.page.waitForSelector('[data-flag]', { state: 'attached' });
    assert.equal(await f.page.isVisible('#restart'), false);
    assert.equal(await f.page.$eval('[data-flag=forceDark]', (e) => e.getAttribute('aria-labelledby')), 't-forceDark');
    await f.page.focus('[data-flag=forceDark]');
    await f.page.keyboard.press('Space');
    await f.page.waitForSelector('#restart:not([hidden])');
    assert.deepEqual(await calls(f.page, 'page:set-flag'), [['forceDark', true]]);
    assert.match(await f.page.innerText('#flags'), /Dark mode for all websites Changed/);
    assert.equal(await f.page.evaluate(() => document.activeElement.dataset.flag), 'forceDark', 'focus stays on the switch');
    if (SHOTS) await f.page.screenshot({ path: path.join(SHOTS, `flags-${scheme}.png`) });
    await f.page.click('#relaunch');
    await f.page.click('#reset');
    await f.page.waitForSelector('#restart', { state: 'hidden' });
    assert.equal((await calls(f.page, 'page:relaunch')).length, 1);
    await f.page.close();
    assert.deepEqual(f.errors, []);
  });
}
