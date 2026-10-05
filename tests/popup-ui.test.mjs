// The UI for pop-ups and links to other apps, in headless Chrome with a
// stand-in for the browser: a pop-up window's bar (renderer/ui/popup.html),
// the "Pop-ups blocked" dropdown and the site information's pop-ups choice
// (renderer/ui/overlay.html), and the "Open <App>?" prompt in the tab
// (renderer/ui/dialog.html). What they show, the keyboard, what they send
// back, and light and dark. Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contrast, readColors, luminance } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');
const x = require('../main/external-protocols.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  // /<host>/… is lumio://<host>/… for the browser UI's hosts; /assets/…
  // (colors, fonts) is shared, as on every lumio:// host.
  server = http.createServer((req, res) => {
    const [, host, rest] = req.url.match(/^\/(popup|overlay|dialog)(\/.*)$/) || [null, 'popup', req.url];
    const url = new URL(`lumio://${host}${rest}`);
    const file = resolveFile(url, new Set([host]));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html') && url.searchParams.get('appearance') === 'dark') body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// A UI page with a stand-in main process: window.__emit(channel, payload)
// sends it an event, window.__sent records what it sends, invoke answers
// from `answers`.
async function open(host, { answers = {}, colorScheme = 'light', query = '', viewport = { width: 600, height: 500 } } = {}) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((a) => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window.lumio = {
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
      invoke: async (channel) => { window.__sent.push(['invoke', channel]); return a[channel] ?? null; },
    };
  }, answers);
  await page.goto(`${base}/${host}/${query}`);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.waitForTimeout(80); // the module has run
  return { page, errors };
}
const sent = (page) => page.evaluate(() => window.__sent);
const emit = (page, channel, payload) => page.evaluate(([c, p]) => window.__emit(c, p), [channel, payload]);

const TAB = { id: 1, title: 'Sign in', url: 'https://accounts.example/o/oauth2?client=7', notSecure: false, popupsBlocked: 0 };
const state = (patch = {}) => ({ activeId: 1, tabs: [{ ...TAB, ...patch }] });

test('a pop-up’s bar: the lock and the read-only address, Open in tab, and the page under the bar', { skip }, async () => {
  const { page, errors } = await open('popup', { answers: { 'popup:init': { tabs: state(), incognito: false } } });
  await page.waitForFunction(() => document.getElementById('address').value !== '');
  assert.equal(await page.inputValue('#address'), 'accounts.example/o/oauth2?client=7', 'the whole address, without https://');
  assert.equal(await page.getAttribute('#address', 'readonly'), '', 'the page can’t change it, and neither can you');
  assert.equal(await page.$eval('#site-icon', (el) => [el.textContent, el.classList.contains('clickable'), el.title].join('|')), '|true|Connection is secure · View site information');
  // The page goes right under the 40px bar (main/popup-window.js counts on it).
  const slot = (await sent(page)).filter(([c]) => c === 'layout:slot').at(-1)[1];
  assert.deepEqual([slot.x, slot.y, slot.width, slot.height], [0, 40, 600, 460]);
  // Plain http says "Not secure" in words; past a certificate warning, in red.
  await emit(page, 'tabs', state({ url: 'http://intranet.example/login' }));
  assert.equal(await page.$eval('#site-icon', (el) => [el.textContent, el.className].join('|')), 'Not secure|insecure clickable');
  assert.equal(await page.inputValue('#address'), 'http://intranet.example/login', 'http:// stays');
  await emit(page, 'tabs', state({ notSecure: true }));
  assert.equal(await page.$eval('#site-icon', (el) => [el.textContent, el.className].join('|')), 'Not secure|danger clickable');
  // The address is selected when it gets focus, but only while it has it: a
  // quick Tab past it isn't pulled back.
  await page.evaluate(() => { document.getElementById('address').focus(); document.getElementById('open-tab').focus(); });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'open-tab');
  // The keyboard: the lock, the address, Open in tab.
  await page.focus('#site-icon');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'open-tab');
  await page.keyboard.press('Enter');
  assert.ok((await sent(page)).some(([c]) => c === 'popup:open-in-tab'), 'Enter on Open in tab');
  // The lock opens the site information.
  await page.click('#site-icon');
  await page.waitForFunction(() => window.__sent.some(([c, ch]) => c === 'invoke' && ch === 'site:info'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('a pop-up’s bar: blocked pop-ups, the permission bar, and saving a password', { skip }, async () => {
  const info = { host: 'accounts.example', allowed: false, items: [{ id: 3, url: 'https://ads.example/' }] };
  const { page, errors } = await open('popup', { answers: { 'popup:init': { tabs: state() }, 'site:popups': info } });
  await page.waitForFunction(() => document.getElementById('address').value !== '');
  assert.equal(await page.isVisible('#popups-btn'), false);
  await emit(page, 'tabs', state({ popupsBlocked: 1 }));
  assert.equal(await page.isVisible('#popups-btn'), true);
  assert.equal(await page.isVisible('#popups-btn .label'), true, '"Pop-up blocked" in words for a moment');
  await page.click('#popups-btn');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:show'));
  const shown = (await sent(page)).find(([c]) => c === 'overlay:show')[1];
  assert.equal(shown.payload.kind, 'popups');
  assert.equal(shown.payload.focus, true, 'the list takes the keyboard');
  assert.deepEqual(shown.payload.items, info.items);
  // A site asking for a permission: a bar over the page, which moves down.
  await emit(page, 'permission', { id: 8, host: 'maps.example', cats: [{ id: 'camera', prompt: 'Use your camera' }] });
  assert.equal(await page.textContent('#permbar .infobar-text'), 'maps.example wants to use your camera');
  await page.waitForFunction(() => window.__sent.filter(([c]) => c === 'layout:slot').at(-1)[1].y > 40);
  await page.click('#permbar [data-act=allow]');
  assert.deepEqual((await sent(page)).find(([c]) => c === 'permission:respond'), ['permission:respond', { id: 8, decision: 'allow' }]);
  assert.equal(await page.isVisible('#permbar'), false);
  // "Save password?" after signing in here: the key, and the prompt under it.
  await emit(page, 'passwords-prompt', { id: 4, tabId: 1, host: 'accounts.example', username: 'ada', action: 'save', length: 9 });
  assert.equal(await page.isVisible('#pw-key'), true);
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:show' && p.payload.kind === 'pwsave'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('a pop-up’s bar in light and dark: readable, and dark when incognito', { skip }, async () => {
  for (const [scheme, query] of [['light', ''], ['dark', ''], ['light', '?appearance=dark']]) {
    const { page, errors } = await open('popup', { colorScheme: scheme, query, answers: { 'popup:init': { tabs: state({ url: 'http://intranet.example/' }) } } });
    await page.waitForFunction(() => document.getElementById('address').value !== '');
    const dark = scheme === 'dark' || query;
    const c = await readColors(page, { tokens: ['--dim', '--text', '--text-soft', '--warn-text', '--danger-text'], parts: ['#bar', '#where', '.tab-btn'] });
    assert.ok(dark ? luminance(c.parts['#bar']) < 0.05 : luminance(c.parts['#bar']) > 0.7, `${scheme}${query}: the bar is ${dark ? 'dark' : 'light'}`);
    // The address and "Not secure" in their box, Open in tab on its button, text on the bar.
    const low = [];
    for (const [fg, part] of [['--dim', '#where'], ['--text', '#where'], ['--warn-text', '#where'], ['--danger-text', '#where'], ['--text-soft', '.tab-btn'], ['--text', '#bar']]) {
      const ratio = contrast(c.tokens[fg], c.parts[part]);
      if (ratio < 4.5) low.push(`${fg} on ${part}: ${ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(low, [], `${scheme}${query}: text below 4.5:1`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('blocked pop-ups: the list (as text), open one with the keyboard, always allow the site, Esc', { skip }, async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors } = await open('overlay', { colorScheme: scheme, viewport: { width: 364, height: 320 } });
    // main/window.js's steps: draw it ('show'), then bring it in ('in').
    let seq = 0;
    const show = async (p) => {
      seq += 1;
      await emit(page, 'overlay-data', { kind: 'popups', focus: true, host: 'news.example', allowed: false, ...p, op: 'show', seq });
      await emit(page, 'overlay-data', { op: 'in', seq });
    };
    const said = async () => (await sent(page)).filter(([c]) => !/^overlay:(size|ready|gone)$/.test(c)); // it also measures itself
    await show({ items: [{ id: 1, url: 'https://ads.example/<b>win</b>' }, { id: 2, url: 'about:blank' }] });
    assert.equal(await page.textContent('.pop-title'), 'Pop-ups blocked:');
    assert.deepEqual(await page.$$eval('.pop-item', (els) => els.map((e) => e.textContent)), ['ads.example/<b>win</b>', 'about:blank'], 'addresses as text, never HTML');
    assert.equal(await page.$$eval('.pop-item b', (els) => els.length), 0);
    assert.deepEqual(await page.$$eval('.pop-choice', (els) => els.map((e) => [e.textContent.trim(), e.querySelector('input').checked])), [['Always allow pop-ups and redirects from news.example', false], ['Continue blocking', true]]);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.pb), '1', 'the first one has focus');
    await page.keyboard.press('Enter');
    assert.deepEqual((await said()).slice(-2), [['site:popup-open', 1], ['overlay:pick', { kind: 'popups' }]]);
    // Always allow, then Done.
    await show({ items: [{ id: 2, url: 'about:blank' }] });
    await page.check('.pop-choice input[value=allow]');
    await page.click('[data-pb-act=done]');
    assert.deepEqual((await said()).slice(-2), [['site:popups-allow', true], ['overlay:pick', { kind: 'popups' }]]);
    await show({ items: [{ id: 2, url: 'about:blank' }] });
    await page.keyboard.press('Escape');
    assert.deepEqual((await said()).at(-1), ['overlay:pick', { kind: 'popups' }]);
    // A file on this computer can't be always allowed.
    await show({ host: null, items: [{ id: 5, url: 'https://x.example/' }] });
    assert.equal(await page.$$eval('.pop-choice, [data-pb-act=manage]', (els) => els.length), 0);
    // Readable: the addresses and choices on the dropdown.
    const c = await readColors(page, { tokens: ['--text', '--popover'] });
    assert.ok(contrast(c.tokens['--text'], c.tokens['--popover']) >= 4.5, `${scheme}: text on the dropdown`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('site information: pop-ups are blocked by default, and can be allowed', { skip }, async () => {
  const { page, errors } = await open('overlay', { viewport: { width: 380, height: 600 } });
  await emit(page, 'overlay-data', {
    op: 'show', seq: 1,
    kind: 'siteinfo',
    info: { host: 'news.example', origin: 'https://news.example', secure: true, permissions: [
      { permission: 'geolocation', label: 'Location', value: undefined, default: 'ask', options: ['allow', 'block'] },
      { permission: 'popups', label: 'Pop-ups and redirects', value: undefined, default: 'block', options: ['allow', 'block'] },
      { permission: 'windowManagement', label: 'Window management', value: 'block', default: 'ask', options: ['allow', 'block'] },
    ] },
  });
  await emit(page, 'overlay-data', { op: 'in', seq: 1 });
  const said = async () => (await sent(page)).filter(([c]) => !/^overlay:(size|ready|gone)$/.test(c)); // it also measures itself
  const options = (perm) => page.$$eval(`select[data-perm="${perm}"] option`, (els) => els.map((o) => `${o.textContent}${o.selected ? ' *' : ''}`));
  assert.deepEqual(await options('geolocation'), ['Ask (default) *', 'Allow', 'Block']);
  assert.deepEqual(await options('popups'), ['Block (default) *', 'Allow', 'Block']);
  assert.deepEqual(await options('windowManagement'), ['Ask (default)', 'Allow', 'Block *']);
  await page.selectOption('select[data-perm=popups]', 'allow');
  assert.deepEqual((await said()).at(-1), ['site:set-permission', { permission: 'popups', value: 'allow' }]);
  // Back to the default: the site's setting is cleared (blocked, like any site).
  await page.selectOption('select[data-perm=popups]', 'default');
  assert.deepEqual((await said()).at(-1), ['site:set-permission', { permission: 'popups', value: 'default' }]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('"Open <App>?" in the tab: Cancel is the main button, so Enter never opens an app', { skip }, async () => {
  const { page, errors } = await open('dialog', { viewport: { width: 900, height: 600 } });
  await emit(page, 'dialog-data', { id: 3, ...x.askSpec({ app: 'zoom.us', origin: 'https://zoom.us' }) });
  assert.equal(await page.textContent('#d-title'), 'Open zoom.us?');
  assert.equal(await page.textContent('#d-message'), 'https://zoom.us wants to open this application.');
  assert.equal(await page.textContent('#d-check span'), 'Always allow zoom.us to open links of this type in the associated app');
  assert.deepEqual(await page.$$eval('#d-buttons button', (els) => els.map((b) => [b.textContent, b.className])), [['Open zoom.us', ''], ['Cancel', 'primary']]);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
  await page.keyboard.press('Enter');
  assert.deepEqual((await sent(page)).at(-1), ['dialog:answer', { id: 3, button: 'cancel', values: {}, checked: false }]);
  // Open does nothing for a moment after the prompt appears (a double-click
  // the page set up can't land on it)…
  await emit(page, 'dialog-data', { id: 4, ...x.askSpec({ app: 'zoom.us', origin: 'https://zoom.us' }) });
  await page.$eval('#d-buttons [data-id=open]', (b) => b.click());
  assert.equal((await sent(page)).length, 1, 'too soon: ignored');
  assert.equal(await page.isDisabled('#d-buttons [data-id=open]'), false, 'and still there to press');
  // …then: tick "Always allow", and Open.
  await page.waitForTimeout(550);
  await page.check('#d-check input');
  await page.click('#d-buttons [data-id=open]');
  assert.deepEqual((await sent(page)).at(-1), ['dialog:answer', { id: 4, button: 'open', values: {}, checked: true }]);
  assert.deepEqual(errors, []);
  await page.close();
});
