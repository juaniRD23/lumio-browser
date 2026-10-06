// Autofill's own UI in headless Chrome with a stand-in for the browser: the
// dropdown under a field and the "Save card?" bubble (renderer/ui/overlay),
// the passkey prompt's security key choices, and Settings › Addresses and
// Payment methods. Each in light and dark, by keyboard and mouse. Skipped
// when Google Chrome isn't installed.
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

let browser, ui, pages;
before(async () => {
  if (!CHROME) return;
  ui = await serve('overlay', new Set(['overlay']));
  pages = await serve('settings', PAGE_HOSTS);
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); ui?.close(); pages?.close(); });
const base = (server) => `http://127.0.0.1:${server.address().port}`;

// The overlay with a stand-in window.lumio: __sent records what it sends,
// __show(payload) plays the browser opening it.
async function openOverlay(colorScheme = 'light') {
  const page = await browser.newPage({ viewport: { width: 440, height: 420 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    const handlers = {};
    window.__sent = [];
    // The overlay's steps (main/window.js): a new kind is shown, then comes in;
    // the same kind again is new content for it.
    const emit = (p) => (handlers['overlay-data'] || []).forEach((fn) => fn(p));
    let shownKind = null;
    let seq = 0;
    window.__show = (payload) => {
      if (shownKind === payload.kind) { emit(payload); return; }
      shownKind = payload.kind;
      seq += 1;
      emit({ ...payload, op: 'show', seq });
      emit({ op: 'in', seq });
      document.getAnimations().forEach((a) => a.finish()); // measured where it lands
    };
    window.lumio = { send: (c, p) => window.__sent.push([c, p]), invoke: async () => null, on: (c, fn) => { (handlers[c] ||= []).push(fn); return () => {}; } };
  });
  await page.goto(`${base(ui)}/overlay.html`);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  return { page, errors };
}
const sentTo = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const press = (page, sel) => page.$eval(sel, (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));

const CARDS = { kind: 'formfill', mode: 'card', selected: 1, footer: 'Manage payment methods…', items: [
  { type: 'card', label: 'Visa •••• 4242', sub: 'Sam Tester · Expires 04/31' },
  { type: 'card', label: 'Mastercard •••• 4444', sub: '' },
] };

for (const scheme of ['light', 'dark']) {
  test(`the dropdown under a field in ${scheme}: rows, highlight, mouse`, { skip }, async () => {
    const { page, errors } = await openOverlay(scheme);
    await page.evaluate((p) => window.__show(p), CARDS);
    const rows = await page.$$eval('.ff-row', (els) => els.map((e) => ({ h: Math.round(e.getBoundingClientRect().height), sel: e.getAttribute('aria-selected'), text: e.innerText.replace(/\s+/g, ' ').trim() })));
    // main/autofill.js sizes the dropdown from these heights (ROW, ROW_ONE, FOOT).
    assert.deepEqual(rows, [{ h: 46, sel: 'false', text: 'Visa •••• 4242 Sam Tester · Expires 04/31' }, { h: 36, sel: 'true', text: 'Mastercard •••• 4444' }]);
    assert.equal(await page.$eval('.ff-foot', (e) => Math.round(e.getBoundingClientRect().height) + 3), 37, 'footer: 34 + its margin and line');
    assert.equal(await page.$eval('[role=listbox]', (e) => e.getAttribute('aria-label')), 'Saved cards');
    const c = await readColors(page, { tokens: ['--text'], parts: ['#card', '.ff-row.sel'] });
    assert.ok(scheme === 'light' ? luminance(c.parts['#card']) > 0.8 : luminance(c.parts['#card']) < 0.05, `card is ${scheme}`);
    assert.ok(contrast(c.tokens['--text'], c.parts['.ff-row.sel']) >= 4.5, 'readable on the highlight');
    assert.notDeepEqual(c.parts['.ff-row.sel'], c.parts['#card'], 'the highlight shows');
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `autofill-dropdown-${scheme}.png`) });

    await press(page, '.ff-row[data-i="0"] .ff-label');
    await press(page, '.ff-foot');
    assert.deepEqual(await sentTo(page, 'autofill:pick'), [{ index: 0 }]);
    assert.deepEqual(await sentTo(page, 'autofill:manage'), ['cards']);
    // Earlier entries: one line each, with a remove button.
    await page.evaluate(() => window.__show({ kind: 'formfill', mode: 'history', selected: -1, footer: '', items: [{ type: 'history', label: 'Miami', removable: true }, { type: 'history', label: 'Madrid', removable: true }] }));
    assert.equal(await page.$$eval('.ff-foot', (els) => els.length), 0);
    await press(page, '.ff-row[data-i="1"] .ff-x');
    assert.deepEqual(await sentTo(page, 'autofill:remove'), [{ index: 1 }]);
    assert.deepEqual(await sentTo(page, 'autofill:pick'), [{ index: 0 }], 'removing isn’t picking');
    await page.close();
    assert.deepEqual(errors, []);
  });
}

// The field keeps the keyboard in the site's view and the list is in Lumio's
// overlay, so a screen reader hears the list through a polite live region
// (overlay-autofill.js explains why the field can't point at it).
test('the dropdown for screen readers: a listbox with its active option, read as it opens and as the arrows move', { skip }, async () => {
  const { page, errors } = await openOverlay('light');
  const liveText = () => page.$eval('#ff-live', (e) => e.textContent);
  await page.evaluate((p) => window.__show(p), { ...CARDS, selected: -1 });
  assert.equal(await page.$eval('#ff-live', (e) => [e.getAttribute('aria-live'), e.getAttribute('aria-atomic'), e.closest('#card') === null].join()), 'polite,true,true', 'outside the card, so it stays while the card is redrawn');
  assert.equal(await liveText(), 'Saved cards, 2. Use the arrow keys to choose and Enter to fill.');
  assert.equal(await page.$eval('[role=listbox]', (e) => e.hasAttribute('aria-activedescendant')), false, 'nothing highlighted yet');
  assert.deepEqual(await page.$$eval('[role=option]', (els) => els.map((e) => [e.id, e.getAttribute('aria-posinset'), e.getAttribute('aria-setsize')])), [['ff-opt-0', '1', '2'], ['ff-opt-1', '2', '2']]);
  const box = await page.$eval('#ff-live', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; });
  assert.ok(box[0] <= 1 && box[1] <= 1, 'read, never shown');
  // The field's arrow keys move the highlight (main/autofill.js sends the same list again).
  await page.evaluate((p) => window.__show(p), { ...CARDS, selected: 0 });
  assert.equal(await page.$eval('[role=listbox]', (e) => e.getAttribute('aria-activedescendant')), 'ff-opt-0');
  assert.equal(await page.$eval('#ff-opt-0', (e) => e.getAttribute('aria-selected')), 'true');
  assert.equal(await liveText(), 'Visa •••• 4242, Sam Tester · Expires 04/31, 1 of 2');
  assert.equal(await page.$eval('#ff-live [translate=no]', (e) => e.textContent), 'Visa •••• 4242, Sam Tester · Expires 04/31,', 'the saved card’s own words are never translated');
  await page.evaluate((p) => window.__show(p), { ...CARDS, selected: 1 });
  assert.equal(await liveText(), 'Mastercard •••• 4444, 2 of 2');
  const before = await liveText();
  await page.evaluate((p) => window.__show(p), { ...CARDS, selected: 1 });
  assert.equal(await liveText(), before, 'the same highlight isn’t read again');
  // Typing changed what it offers: read like a new list.
  await page.evaluate(() => window.__show({ kind: 'formfill', mode: 'history', selected: -1, footer: '', items: [{ type: 'history', label: 'Miami', removable: true }] }));
  assert.equal(await liveText(), 'Earlier entries, 1. Use the arrow keys to choose and Enter to fill.');
  // The mouse still works, and keeps the keyboard in the page's field.
  const prevented = await page.$eval('.ff-row[data-i="0"]', (el) => { const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; });
  assert.equal(prevented, true);
  assert.deepEqual(await sentTo(page, 'autofill:pick'), [{ index: 0 }]);
  await page.close();
  assert.deepEqual(errors, []);
});

test('"Save card?" and "Update address?": keyboard first, and sized to fit', { skip }, async () => {
  const { page, errors } = await openOverlay('dark');
  await page.evaluate(() => window.__show({ kind: 'formsave', prompt: { id: 7, what: 'card', action: 'save', host: 'shop.example', lines: ['Visa •••• 4242', 'Sam Tester', 'Expires 04/31'], note: 'Lumio keeps it encrypted on this computer and asks for Touch ID before filling it. The security code is never saved.' } }));
  assert.match(await page.innerText('#card'), /shop\.example\s+Save card\?\s+Visa •••• 4242\s+Sam Tester\s+Expires 04\/31[\s\S]*security code is never saved[\s\S]*Never for this site\s+Not now\s+Save/);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.fs), 'save', 'Save has the focus');
  assert.equal(await page.$eval('[role=dialog]', (e) => e.getAttribute('aria-labelledby')), 'fs-title');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sentTo(page, 'autofill:decide'), [{ id: 7, decision: 'save' }]);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  assert.deepEqual((await sentTo(page, 'autofill:decide'))[1], { id: 7, decision: 'dismiss' }, 'Tab reaches Not now');
  if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'autofill-save-card.png') });
  await page.evaluate(() => window.__show({ kind: 'formsave', prompt: { id: 8, what: 'address', action: 'update', host: 'shop.example', lines: ['Sam Tester', '123 Ocean Drive', 'Miami Beach, FL 33139'], note: 'Lumio keeps it encrypted on this computer.' } }));
  assert.match(await page.innerText('#card'), /Update address\?[\s\S]*Not now\s+Update/);
  assert.equal(await page.$$eval('[data-fs=never]', (els) => els.length), 0, 'no "Never" when updating');
  await page.keyboard.press('Escape');
  assert.deepEqual((await sentTo(page, 'autofill:decide')).at(-1), { id: 8, decision: 'dismiss' });
  const sizes = await sentTo(page, 'overlay:size');
  assert.ok(sizes.length && sizes.every((s) => s.height > 150 && s.height < 420), JSON.stringify(sizes));
  await page.close();
  assert.deepEqual(errors, []);
});

test('the passkey prompt offers a security key, and says to touch it while a site waits', { skip }, async () => {
  const { page, errors } = await openOverlay('light');
  const buttons = () => page.$$eval('.pws-actions button', (els) => els.map((e) => `${e.dataset.pk}:${e.textContent}`));
  await page.evaluate(() => window.__show({ kind: 'passkey', prompt: { id: 3, mode: 'none', rpId: 'example.com', host: 'example.com', accounts: [] } }));
  assert.deepEqual(await buttons(), ['cancel:Cancel', 'key:Use a security key']);
  await press(page, '[data-pk=key]');
  assert.deepEqual(await sentTo(page, 'passwords:passkey'), [{ id: 3, decision: 'key', account: null }]);
  await page.evaluate(() => window.__show({ kind: 'passkey', prompt: { id: 4, mode: 'create', rpId: 'example.com', host: 'example.com', userName: 'sam@example.com', displayName: 'Sam', accounts: [] } }));
  assert.deepEqual(await buttons(), ['key:Use a security key', 'cancel:Cancel', 'ok:Save passkey']);
  if (process.env.LUMIO_SHOTS) { await page.setViewportSize({ width: 404, height: 300 }); await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'passkey-create.png') }); }
  await page.evaluate(() => window.__show({ kind: 'passkey', prompt: { id: 5, mode: 'key', rpId: '', host: 'example.com', accounts: [] } }));
  assert.match(await page.innerText('#card'), /Security key · example\.com\s+Use your security key\s+Insert your security key and touch it/);
  assert.deepEqual(await buttons(), ['cancel:Cancel']);
  await page.close();
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------- Settings
const now = Date.now();
const SETTINGS = {
  account: { signedIn: false }, profile: { name: '', color: '#86b7ff', theme: 'blue' }, startup: 'restore', downloadDir: '/tmp', askDownload: false, memorySaver: true, memorySaverMinutes: 60,
  offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google', engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: true,
  appearance: 'system', ai: { reasoning: 'medium' }, version: '0.6.7', update: null, isDefault: true, importSources: [], sitePermissions: [],
};
const AUTOFILL = {
  available: true, entries: 3, never: { address: [], card: ['https://shop.example'] }, autofillAddresses: true, autofillCards: true, formHistory: true, platform: 'darwin',
  addresses: [{ id: 'a1', name: 'Sam Tester', organization: '', street: '123 Ocean Drive\nApt 4', city: 'Miami Beach', state: 'FL', zip: '33139', country: 'United States', phone: '305 555 0100', email: 'sam@example.com', summary: '123 Ocean Drive, Miami Beach, FL 33139', created: now, updated: now }],
  cards: [
    { id: 'c1', brand: 'visa', brandName: 'Visa', last4: '4242', name: 'Sam Tester', nickname: '', expMonth: 4, expYear: 2031, expired: false, created: now, updated: now },
    { id: 'c2', brand: 'amex', brandName: 'American Express', last4: '0005', name: 'Sam Tester', nickname: 'Travel', expMonth: 1, expYear: 2020, expired: true, created: now, updated: now },
  ],
};

async function openSettings(colorScheme, answers = {}, ready = '#addr-card .af-item') {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript((answers) => {
    window.__calls = [];
    window.lumioPage = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return structuredClone(answers[channel] ?? null); },
      on: () => {},
    };
  }, { 'page:settings': SETTINGS, 'page:autofill': AUTOFILL, 'page:sync': { on: true, status: 'ready', types: { bookmarks: true, passkeys: true, addresses: true, cards: false }, requests: [] }, 'page:sync-devices': { ok: true, devices: [] },
    'page:schedules': { signedIn: false, tasks: [] }, 'page:workflows': { workflows: [] }, 'page:site-tips': { sites: [] }, 'page:mac-permissions': { accessibility: true, screen: true }, ...answers });
  await page.goto(`${base(pages)}/settings.html#addresses`);
  await page.waitForSelector(ready);
  return { page, errors };
}
const calls = (page, channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map(([, ...a]) => a), channel);

for (const scheme of ['light', 'dark']) {
  test(`Settings › Addresses and Payment methods in ${scheme}`, { skip }, async () => {
    const { page, errors } = await openSettings(scheme, { 'page:address-save': { ok: true, id: 'a2' }, 'page:card-reveal': { ok: true, number: '4242424242424242' }, 'page:card-save': { ok: false, error: 'That card number isn’t valid. Check it and try again.' } });
    assert.deepEqual(await page.$$eval('.side a[href="#addresses"], .side a[href="#payments"]', (els) => els.map((e) => e.textContent)), ['Addresses', 'Payment methods']);
    assert.match(await page.innerText('#addr-card'), /Sam Tester\s+123 Ocean Drive, Miami Beach, FL 33139 · 305 555 0100 · sam@example\.com/);
    assert.match(await page.innerText('#pay-card'), /Visa •••• 4242\s+Sam Tester · Expires 04\/2031[\s\S]*Travel · American Express •••• 0005\s*Expired/);
    assert.ok(!(await page.innerText('body')).includes('4242424242424242'), 'no card number on the page');
    assert.match(await page.innerText('#form-history-count'), /3 saved entries/);
    // Lumio Sync lists the new kinds; cards are off until turned on.
    assert.deepEqual(await page.$$eval('#sync-types input', (els) => els.filter((e) => ['passkeys', 'addresses', 'cards'].includes(e.dataset.type)).map((e) => [e.dataset.type, e.checked])), [['passkeys', true], ['addresses', true], ['cards', false]]);

    // Add an address with the keyboard: the form opens on Name, Enter saves.
    await page.click('#addr-card [data-add]');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'name');
    await page.keyboard.type('Ana García');
    await page.fill('#addr-card [name=street]', '9 Calle Ocho');
    await page.fill('#addr-card [name=city]', 'Miami');
    await page.focus('#addr-card [name=zip]');
    await page.keyboard.type('33135');
    const c = await readColors(page, { tokens: ['--text', '--dim'], parts: ['.af-form'] });
    assert.ok(contrast(c.tokens['--dim'], c.parts['.af-form']) >= 4.5, `labels readable in ${scheme}`);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `settings-addresses-${scheme}.png`), fullPage: false });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#addr-card .af-form'));
    const [[fields, id]] = await calls(page, 'page:address-save');
    assert.deepEqual([fields.name, fields.street, fields.city, fields.zip, id], ['Ana García', '9 Calle Ocho', 'Miami', '33135', null]);

    // Edit a card: its number shows only after confirming (Show), Esc closes the form.
    await page.click('#pay-card [data-edit="c1"]');
    assert.equal(await page.$eval('#pay-card [name=number]', (e) => [e.value, e.placeholder].join('|')), '|•••• •••• •••• 4242');
    assert.deepEqual(await page.$eval('#pay-card [name=expMonth]', (e) => e.value), '4');
    await page.click('#pay-card [data-reveal]');
    await page.waitForFunction(() => document.querySelector('#pay-card [name=number]')?.value === '4242424242424242');
    assert.deepEqual(await calls(page, 'page:card-reveal'), [['c1']]);
    if (process.env.LUMIO_SHOTS) await page.locator('#payments').screenshot({ path: path.join(process.env.LUMIO_SHOTS, `settings-payments-${scheme}.png`), animations: 'disabled' });
    await page.click('#pay-card button[type=submit]');
    await page.waitForFunction(() => /isn’t valid/.test(document.querySelector('#pay-card .af-form .err')?.textContent || ''));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#pay-card .af-form'));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.edit), 'c1', 'focus goes back to Edit');

    // "Never for this site" can be undone.
    assert.match(await page.innerText('#pay-card'), /Never offered on\s+shop\.example/);
    await page.click('#pay-card [data-never]');
    assert.deepEqual(await calls(page, 'page:autofill-never-remove'), [['card', 'https://shop.example']]);
    // Delete (after confirming), the switches, and clearing form entries.
    page.on('dialog', (d) => d.accept());
    await page.click('#addr-card [data-delete="a1"]');
    await page.click('#pay-card .switch i');
    await page.click('#form-history-clear');
    await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:form-history-clear'));
    assert.deepEqual(await calls(page, 'page:address-delete'), [['a1']]);
    assert.deepEqual(await calls(page, 'page:autofill-set'), [['autofillCards', false]]);
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('Settings still works when the browser has no autofill answer', { skip }, async () => {
  const { page, errors } = await openSettings('light', { 'page:autofill': null }, '#addr-card [data-add]');
  assert.match(await page.innerText('#addr-card'), /No saved addresses yet/);
  assert.match(await page.innerText('#pay-card'), /No saved cards yet/);
  await page.close();
  assert.deepEqual(errors, []);
});
