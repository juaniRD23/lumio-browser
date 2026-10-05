// The dialog a page raises in its tab (renderer/ui/dialog.html), the warning
// page for bad certificates (renderer/pages/cert.html) and the alert/confirm/
// prompt that the tab preload gives web pages, in headless Chrome with a
// stand-in for the browser: what they show, the keyboard (Enter, Esc, Tab
// stays inside), what they send back, and light and dark. Skipped when Google
// Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    // /ui/... is the browser UI (the dialog view), /pages/... Lumio's pages;
    // /assets/... (colors, fonts) is shared, as on every lumio:// host.
    const [, area, rest] = req.url.match(/^\/(ui|pages)(\/.*)$/) || [null, 'ui', req.url];
    const url = new URL(`lumio://${area === 'ui' ? 'dialog' : 'error'}${rest}`);
    const file = resolveFile(url, area === 'ui' ? new Set(['dialog']) : PAGE_HOSTS);
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

// The dialog view with a stand-in main process: window.__emit(spec) shows a
// dialog, window.__sent records what it sends back.
async function openDialog({ colorScheme = 'light', query = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (payload) => (handlers['dialog-data'] || []).forEach((fn) => fn(payload));
    window.lumio = { send: (channel, payload) => window.__sent.push([channel, payload]), on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; }, invoke: async () => null };
  });
  await page.goto(`${base}/ui/${query}`);
  await page.waitForFunction(() => typeof window.__emit === 'function' && document.readyState === 'complete');
  await page.waitForTimeout(50); // the module has run
  return { page, errors };
}
const sent = (page) => page.evaluate(() => window.__sent.at(-1));
const show = (page, spec) => page.evaluate((s) => window.__emit(s), spec);

const CONFIRM = { id: 4, kind: 'js', title: 'shop.example says', message: 'Delete the <b>cart</b>?\nThis can’t be undone.', buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }], cancel: 'cancel' };

test('a confirm(): the site in the title, the message as plain text, OK on the right; Enter is OK, Esc is Cancel', { skip }, async () => {
  const { page, errors } = await openDialog();
  await show(page, CONFIRM);
  assert.equal(await page.isVisible('#card'), true);
  assert.equal(await page.getAttribute('#card', 'role'), 'dialog');
  assert.equal(await page.getAttribute('#card', 'aria-labelledby'), 'd-title');
  assert.equal(await page.getAttribute('#card', 'aria-modal'), 'true');
  assert.equal(await page.textContent('#d-title'), 'shop.example says');
  assert.equal(await page.textContent('#d-message'), 'Delete the <b>cart</b>?\nThis can’t be undone.', 'never HTML');
  assert.equal(await page.$$eval('#d-message b', (els) => els.length), 0);
  assert.deepEqual(await page.$$eval('#d-buttons button', (els) => els.map((b) => [b.textContent, b.className])), [['Cancel', ''], ['OK', 'primary']]);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'OK', 'the main button has focus');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), ['dialog:answer', { id: 4, button: 'ok', values: {}, checked: false }]);
  await show(page, { ...CONFIRM, id: 5 });
  await page.keyboard.press('Escape');
  assert.deepEqual(await sent(page), ['dialog:answer', { id: 5, button: 'cancel', values: {}, checked: false }]);
  // One answer per dialog.
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__sent.length), 2);
  await show(page, null);
  assert.equal(await page.isVisible('#card'), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a prompt(): the text field starts with the default, selected; Enter sends what was typed', { skip }, async () => {
  const { page, errors } = await openDialog();
  await show(page, { id: 9, kind: 'js', title: 'example.com says', message: 'Your name?', fields: [{ name: 'value', type: 'text', label: '', value: 'Guest' }], buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }], cancel: 'cancel' });
  assert.equal(await page.evaluate(() => document.activeElement.name), 'value');
  assert.equal(await page.evaluate(() => { const i = document.activeElement; return i.value.slice(i.selectionStart, i.selectionEnd); }), 'Guest');
  assert.equal(await page.getAttribute('#d-fields input', 'aria-labelledby'), 'd-message', 'the question labels the field');
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), ['dialog:answer', { id: 9, button: 'ok', values: { value: 'Ada' }, checked: false }]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('sign in: labeled fields, a hidden password, the warning, Tab stays in the dialog, a click outside keeps focus', { skip }, async () => {
  const { page, errors } = await openDialog();
  await show(page, {
    id: 12, kind: 'auth', title: 'Sign in to access this site', message: 'Authorization required by http://intranet.example', note: 'Your connection to this site is not private',
    fields: [{ name: 'username', type: 'text', label: 'Username', value: '', autocomplete: 'username' }, { name: 'password', type: 'password', label: 'Password', value: '', autocomplete: 'current-password' }],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'signin', label: 'Sign in', primary: true }], cancel: 'cancel',
  });
  assert.match(await page.textContent('#d-note'), /Your connection to this site is not private/);
  assert.equal(await page.isVisible('#d-note svg'), true);
  assert.deepEqual(await page.$$eval('.field', (els) => els.map((l) => [l.querySelector('span').textContent, l.querySelector('input').type])), [['Username', 'text'], ['Password', 'password']]);
  await page.keyboard.type('ada');
  await page.keyboard.press('Tab');
  await page.keyboard.type('s3cret');
  // Tab around: Cancel, Sign in, then back to Username, never out to the page.
  const order = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.name || document.activeElement.textContent)); }
  assert.deepEqual(order, ['Cancel', 'Sign in', 'username', 'password']);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.name), 'username');
  await page.mouse.click(20, 500); // on the page around the card
  assert.equal(await page.evaluate(() => document.activeElement.name), 'username', 'focus stays');
  assert.equal(await page.evaluate(() => document.getElementById('card').classList.contains('nudge')), true);
  await page.click('#d-buttons .primary');
  assert.deepEqual(await sent(page), ['dialog:answer', { id: 12, button: 'signin', values: { username: 'ada', password: 's3cret' }, checked: false }]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('"Don’t allow … to show more dialogs" is a checkbox sent with the answer', { skip }, async () => {
  const { page } = await openDialog();
  await show(page, { id: 20, kind: 'js', title: 'spam.example says', message: 'again', checkbox: { label: "Don't allow spam.example to show more dialogs" }, buttons: [{ id: 'ok', label: 'OK', primary: true }], cancel: 'ok' });
  assert.equal(await page.textContent('#d-check span'), "Don't allow spam.example to show more dialogs");
  await page.click('#d-check');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), ['dialog:answer', { id: 20, button: 'ok', values: {}, checked: true }]);
  // The next dialog starts unchecked.
  await show(page, { id: 21, kind: 'js', title: 'x says', message: 'hi', buttons: [{ id: 'ok', label: 'OK', primary: true }], cancel: 'ok' });
  assert.equal(await page.isVisible('#d-check'), false);
  await page.close();
});

for (const scheme of ['light', 'dark']) {
  test(`the dialog card in ${scheme}: ${scheme} colors, readable text and buttons`, { skip }, async () => {
    const { page, errors } = await openDialog({ colorScheme: scheme });
    await show(page, { ...CONFIRM, note: 'A warning line' });
    const c = await readColors(page, { tokens: ['--text', '--text-soft', '--warn-text', '--primary-bg', '--primary-fg'], parts: ['#card'] });
    const card = c.parts['#card'];
    assert.ok(scheme === 'light' ? luminance(card) > 0.8 : luminance(card) < 0.05, `card is ${scheme} (rgb ${card})`);
    for (const t of ['--text', '--text-soft', '--warn-text']) assert.ok(contrast(c.tokens[t], card) >= 4.5, `${t} on the card: ${contrast(c.tokens[t], card).toFixed(2)}:1`);
    assert.ok(contrast(c.tokens['--primary-fg'], c.tokens['--primary-bg']) >= 4.5, 'the main button');
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `dialog-${scheme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('an incognito window’s dialog is dark on a light computer', { skip }, async () => {
  const { page } = await openDialog({ colorScheme: 'light', query: '?appearance=dark' });
  await show(page, CONFIRM);
  const c = await readColors(page, { parts: ['#card'] });
  assert.ok(luminance(c.parts['#card']) < 0.05);
  await page.close();
});

// The function preload/internal.js runs in a web page's own world.
const installDialogs = fs.readFileSync(path.join(ROOT, 'preload', 'internal.js'), 'utf8').match(/^function installDialogs\(ask\) \{[\s\S]*?^\}/m)[0];

test('web pages’ alert, confirm and prompt ask Lumio and return its answer, and look built in', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/pages/error.html`);
  const result = await page.evaluate(`(() => {
    const calls = [];
    const answers = { alert: null, confirm: true, prompt: 'Ada' };
    (${installDialogs})((kind, message, value) => { calls.push([kind, message, value]); return answers[kind]; });
    const out = {
      alert: alert('Saved'), bare: alert(), confirm: confirm('Sure?'), prompt: prompt('Name?', 'Guest'), promptNoDefault: prompt('Name?'),
      looks: String(window.alert), name: window.confirm.name,
    };
    answers.prompt = null; answers.confirm = 'yes';
    out.promptCancelled = prompt('Name?');
    out.confirmOdd = confirm('Sure?');
    // Not while the page is unloading, like Chrome.
    addEventListener('beforeunload', () => { out.inUnload = confirm('Stay?'); });
    dispatchEvent(new Event('beforeunload'));
    return { out, calls };
  })()`);
  assert.deepEqual(result.out, {
    alert: undefined, bare: undefined, confirm: true, prompt: 'Ada', promptNoDefault: 'Ada',
    looks: 'function alert() { [native code] }', name: 'confirm', promptCancelled: null, confirmOdd: false, inUnload: false,
  });
  assert.deepEqual(result.calls, [['alert', 'Saved', undefined], ['alert', '', undefined], ['confirm', 'Sure?', undefined], ['prompt', 'Name?', 'Guest'], ['prompt', 'Name?', ''], ['prompt', 'Name?', ''], ['confirm', 'Sure?', undefined]]);
  await page.close();
});

// The certificate warning page, with a stand-in browser.
async function openCert(info, { colorScheme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((answer) => {
    window.__calls = [];
    window.lumioPage = { invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return channel === 'page:cert-info' ? answer : true; }, on() {} };
  }, info);
  const q = new URLSearchParams({ code: '-201', desc: 'ERR_CERT_DATE_INVALID', url: 'https://expired.example/login' });
  await page.goto(`${base}/pages/cert.html?${q}`);
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:cert-info'));
  await page.waitForTimeout(50);
  return { page, errors };
}
const INFO = {
  host: 'expired.example', code: 'NET::ERR_CERT_DATE_INVALID', reason: "Its security certificate has expired or isn't valid yet.", hsts: false, canProceed: true,
  cert: { subject: 'expired.example', issuer: 'Example CA', validFrom: '2020-01-02', validTo: '2021-01-02', fingerprint: 'sha256/AbC123=' },
};

test('"Your connection is not private": the error code, Back to safety, and Advanced with the certificate and Proceed', { skip }, async () => {
  const { page, errors } = await openCert(INFO);
  assert.equal(await page.title(), 'Privacy error');
  assert.equal(await page.textContent('h1'), 'Your connection is not private');
  assert.equal(await page.textContent('#host'), 'expired.example');
  assert.equal(await page.textContent('#code'), 'NET::ERR_CERT_DATE_INVALID');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'back', 'Back to safety is ready');
  assert.equal(await page.isVisible('#details'), false);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter'); // Advanced, from the keyboard
  assert.equal(await page.isVisible('#details'), true);
  assert.equal(await page.getAttribute('#advanced', 'aria-expanded'), 'true');
  assert.match(await page.textContent('#reason'), /couldn't prove that it's expired\.example\. Its security certificate has expired/);
  assert.deepEqual(await page.$$eval('#cert dd', (els) => els.map((e) => e.textContent)), ['expired.example', 'Example CA', '2020-01-02', '2021-01-02', 'sha256/AbC123=']);
  assert.equal(await page.textContent('#proceed'), 'Proceed to expired.example (unsafe)');
  // A script can't press Proceed for you.
  await page.evaluate(() => document.getElementById('proceed').click());
  assert.equal(await page.evaluate(() => window.__calls.some(([c]) => c === 'page:cert-proceed')), false);
  await page.click('#proceed');
  assert.equal(await page.evaluate(() => window.__calls.filter(([c]) => c === 'page:cert-proceed').length), 1);
  await page.click('#back');
  assert.equal(await page.evaluate(() => window.__calls.at(-1)[0]), 'page:cert-back');
  assert.deepEqual(errors, []);
  await page.close();
});

test('no Proceed for a site that uses HSTS, or for an error that can’t be skipped', { skip }, async () => {
  let { page } = await openCert({ ...INFO, hsts: true, canProceed: false });
  await page.click('#advanced');
  assert.equal(await page.isVisible('#proceed'), false);
  assert.match(await page.textContent('#hsts'), /You can't visit expired\.example right now because the website uses HSTS/);
  await page.close();
  ({ page } = await openCert({ ...INFO, code: 'NET::ERR_CERT_REVOKED', canProceed: false }));
  await page.click('#advanced');
  assert.equal(await page.isVisible('#proceed'), false);
  assert.equal(await page.isVisible('#fatal'), true);
  await page.close();
  // Lumio has no record of it (an old page from history): Try again, no Proceed.
  ({ page } = await openCert(null));
  await page.click('#advanced');
  assert.equal(await page.isVisible('#proceed'), false);
  await page.click('#retry');
  assert.deepEqual(await page.evaluate(() => window.__calls.at(-1)), ['page:navigate', 'https://expired.example/login']);
  await page.close();
});

for (const scheme of ['light', 'dark']) {
  test(`the certificate warning in ${scheme}: ${scheme} colors and readable text`, { skip }, async () => {
    const { page, errors } = await openCert(INFO, { colorScheme: scheme });
    await page.click('#advanced');
    const c = await readColors(page, { tokens: ['--text', '--dim', '--danger-text', '--label'], parts: ['body', 'dl'] });
    assert.ok(scheme === 'light' ? luminance(c.parts.body) > 0.7 : luminance(c.parts.body) < 0.05, `page is ${scheme}`);
    for (const t of ['--text', '--dim', '--danger-text']) assert.ok(contrast(c.tokens[t], c.parts.body) >= 4.5, `${t}: ${contrast(c.tokens[t], c.parts.body).toFixed(2)}:1`);
    assert.ok(contrast(c.tokens['--label'], c.parts.dl) >= 4.5, 'certificate labels');
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `cert-${scheme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  });
}
