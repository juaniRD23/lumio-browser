// The page side of autofill (preload/autofill.js) in headless Chrome, with a
// stand-in for the browser: which fields it recognizes, the keys that drive
// Lumio's dropdown, what it fills (never hidden fields, never over what the
// person typed), and what it reports after a form is sent (never a card's
// security code). Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload', 'autofill.js'), 'utf8');

let browser;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); });

// Opens a fixture as https://shop.example/<name> with the preload running and
// a stand-in for Lumio: __ipc records what it sends and asks, __emit plays a
// message from Lumio, and af:query answers `count` suggestions.
async function open(name, { count = 2 } = {}) {
  // Tall enough that clicks don't scroll the page (scrolling closes the dropdown, like Chrome's).
  const page = await browser.newPage({ viewport: { width: 900, height: 1800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://shop.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', path.basename(new URL(r.request().url()).pathname))) }));
  await page.addInitScript(({ code, count }) => {
    const listeners = {};
    window.__ipc = { sent: [], asked: [] };
    window.__emit = (channel, payload) => (listeners[channel] || []).forEach((fn) => fn({}, payload));
    const ipcRenderer = {
      send: (channel, payload) => window.__ipc.sent.push([channel, JSON.parse(JSON.stringify(payload ?? null))]),
      invoke: async (channel, payload) => { window.__ipc.asked.push([channel, JSON.parse(JSON.stringify(payload ?? null))]); return channel === 'af:query' ? { count } : { count: count - 1 }; },
      on: (channel, fn) => { (listeners[channel] ||= []).push(fn); },
    };
    new Function('require', code)(() => ({ ipcRenderer }));
  }, { code: PRELOAD, count });
  await page.goto(`https://shop.example/${name}`);
  return { page, errors };
}
const lastQuery = (page) => page.evaluate(() => window.__ipc.asked.filter(([c]) => c === 'af:query').at(-1)?.[1] || null);
const sent = (page, channel) => page.evaluate((c) => window.__ipc.sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const values = (page, ids) => page.evaluate((list) => Object.fromEntries(list.map((id) => [id, document.getElementById(id).value])), ids);

const HOME = { name: 'Sam Q Tester', organization: 'Lumio', street: '123 Ocean Drive\nApt 4', city: 'Miami Beach', state: 'FL', zip: '33139', country: 'United States', phone: '+1 305 555 0100', email: 'sam@example.com' };

test('recognizes address, card and plain fields from autocomplete, names, placeholders and labels (English and Spanish)', { skip }, async () => {
  const { page, errors } = await open('address.html');
  const what = async (sel) => { await page.click(sel); const q = await lastQuery(page); return q && [q.mode, q.field || q.key]; };
  assert.deepEqual(await what('#fn'), ['address', 'given']);
  assert.deepEqual(await what('#ln'), ['address', 'family']);
  assert.deepEqual(await what('#a1'), ['address', 'line1']);
  assert.deepEqual(await what('#a2'), ['address', 'line2']);
  assert.deepEqual(await what('#city'), ['address', 'city']);
  assert.deepEqual(await what('#zip'), ['address', 'zip']);
  assert.deepEqual(await what('#phone'), ['address', 'phone']);
  assert.deepEqual(await what('#email'), ['address', 'email']);
  assert.deepEqual(await what('#note'), ['history', 'gift_note'], 'not an address field: earlier entries');
  // Spanish labels; "Nombre" without "Apellido" is the whole name.
  assert.deepEqual(await what('#nombre'), ['address', 'name']);
  assert.deepEqual(await what('#dir'), ['address', 'line1']);
  assert.deepEqual(await what('#ciudad'), ['address', 'city']);
  assert.deepEqual(await what('#cp'), ['address', 'zip']);
  assert.deepEqual(await what('#telefono'), ['address', 'phone']);
  // Never for one-time codes, autocomplete=off, search boxes, fields with their own
  // suggestions, or sign-in forms (those are the password dropdown's).
  const before = (await page.evaluate(() => window.__ipc.asked.length));
  for (const sel of ['#otp', '#promo', '#topic', '#q', '#user']) await page.click(sel);
  assert.equal(await page.evaluate(() => window.__ipc.asked.length), before, 'no dropdown there');
  assert.deepEqual(await what('#nick'), ['history', 'nickname']);
  await page.close();
  assert.deepEqual(errors, []);
});

test('the field keeps the keyboard: arrows move the highlight, Enter picks instead of sending, Esc closes, Shift+Delete removes', { skip }, async () => {
  const { page } = await open('address.html', { count: 3 });
  await page.click('#nick');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp'); // wraps to the last one
  assert.deepEqual((await sent(page, 'af:select')).map((x) => x.index), [0, 1, 0, 2]);
  await page.keyboard.press('Shift+Delete');
  assert.deepEqual(await page.evaluate(() => window.__ipc.asked.filter(([c]) => c === 'af:remove').map(([, p]) => p.index)), [2]);
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page, 'af:pick'), [{ index: 1 }], 'after removing the last one, the highlight moved up');
  assert.equal(await page.evaluate(() => window.sent || 0), 0, 'Enter picked the suggestion; the form wasn’t sent');
  // ArrowDown opens it again; Esc closes it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  assert.ok((await sent(page, 'af:hide')).length >= 1);
  await page.close();
});

test('fills a picked address into visible fields only, keeps what the person typed, and matches select options', { skip }, async () => {
  const { page, errors } = await open('address.html');
  await page.click('#company');
  await page.keyboard.type('Acme');
  await page.click('#a1');
  await page.evaluate((v) => window.__emit('af:fill', { mode: 'address', values: v }), HOME);
  assert.deepEqual(await values(page, ['fn', 'ln', 'company', 'a1', 'a2', 'city', 'state', 'zip', 'country', 'phone', 'email', 'trap', 'note']), {
    fn: 'Sam Q', ln: 'Tester', company: 'Acme', a1: '123 Ocean Drive', a2: 'Apt 4', city: 'Miami Beach', state: 'FL', zip: '33139', country: 'US',
    phone: '+1 305 555 0100', email: 'sam@example.com', trap: '', note: '',
  });
  // Pages built with frameworks hear about it.
  assert.equal(await page.evaluate(() => { let n = 0; const el = document.getElementById('city'); el.addEventListener('input', () => n++); window.__emit('af:fill', { mode: 'history', value: 'Miami' }); return n; }), 0, 'history fills the field the dropdown is under');
  // A country code and a state name also find their options.
  await page.evaluate(() => { document.getElementById('state').value = ''; document.getElementById('country').value = 'CA'; });
  await page.click('#dir');
  await page.click('#a1');
  await page.evaluate(() => window.__emit('af:fill', { mode: 'address', values: { state: 'New York', country: 'mx' } }));
  assert.deepEqual(await values(page, ['state', 'country']), { state: 'NY', country: 'MX' });
  await page.close();
  assert.deepEqual(errors, []);
});

test('cards: fills number, expiry and name (never the CVC, where the cursor goes), on secure pages only', { skip }, async () => {
  const { page, errors } = await open('checkout.html');
  await page.click('#cardnumber');
  assert.deepEqual(await lastQuery(page).then((q) => [q.mode, q.field, q.prefix]), ['card', 'cc-number', '']);
  await page.click('#ccname');
  assert.deepEqual(await lastQuery(page).then((q) => [q.mode, q.field]), ['card', 'cc-name']);
  const n = (await page.evaluate(() => window.__ipc.asked.length));
  await page.click('#cvc');
  assert.equal(await page.evaluate(() => window.__ipc.asked.length), n, 'no dropdown on the security code');
  await page.click('#cardnumber');
  await page.evaluate(() => window.__emit('af:fill', { mode: 'card', values: { number: '4242424242424242', name: 'Sam Tester', expMonth: 4, expYear: 2031 } }));
  assert.deepEqual(await values(page, ['ccname', 'cardnumber', 'mm', 'yy', 'cvc']), { ccname: 'Sam Tester', cardnumber: '4242424242424242', mm: '4', yy: '2031', cvc: '' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cvc');
  // A single expiry field follows its placeholder.
  await page.click('#n2');
  await page.evaluate(() => window.__emit('af:fill', { mode: 'card', values: { number: '5555555555554444', expMonth: 11, expYear: 2030 } }));
  assert.deepEqual(await values(page, ['n2', 'e2', 'c2']), { n2: '5555555555554444', e2: '11 / 30', c2: '' });
  await page.close();
  assert.deepEqual(errors, []);
  // Not on an insecure page.
  const plain = await browser.newPage();
  await plain.route('http://shop.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'checkout.html')) }));
  await plain.addInitScript((code) => {
    window.__asked = [];
    new Function('require', code)(() => ({ ipcRenderer: { send() {}, on() {}, invoke: async (c, p) => { window.__asked.push(p); return { count: 1 }; } } }));
  }, PRELOAD);
  await plain.goto('http://shop.test/checkout.html');
  await plain.click('#cardnumber');
  assert.deepEqual(await plain.evaluate(() => window.__asked), []);
  await plain.close();
});

test('after a form is sent: the address, the card without its security code, and plain entries the person typed', { skip }, async () => {
  const { page } = await open('address.html');
  const type = async (sel, text) => { await page.click(sel); await page.keyboard.type(text); };
  await type('#fn', 'Ana');
  await type('#ln', 'García');
  await type('#a1', '9 Calle Ocho');
  await type('#city', 'Miami');
  await page.selectOption('#state', 'FL');
  await type('#zip', '33135');
  await type('#note', 'Happy birthday!');
  await page.click('#go');
  const [ship] = await sent(page, 'af:captured');
  assert.deepEqual(ship.address, { name: 'Ana García', organization: '', street: '9 Calle Ocho', city: 'Miami', state: 'Florida', zip: '33135', country: 'Canada', phone: '', email: '' });
  assert.equal(ship.card, null);
  assert.deepEqual(ship.history, [{ key: 'gift_note', value: 'Happy birthday!' }], 'address fields are saved as the address, not as entries');
  // Plain entries: not one-time codes or autocomplete=off fields; nothing from sign-in forms.
  await type('#nick', 'Sammy');
  await type('#otp', '123456');
  await type('#promo', 'SAVE10');
  await page.click('#join');
  await type('#user', 'sam');
  await type('#pass', 'secret-pass');
  await page.keyboard.press('Enter');
  const captured = await sent(page, 'af:captured');
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[1], { address: null, card: null, history: [{ key: 'nickname', value: 'Sammy' }] });
  await page.close();

  const pay = (await open('checkout.html')).page;
  await pay.click('#ccname'); await pay.keyboard.type('Sam Tester');
  await pay.click('#cardnumber'); await pay.keyboard.type('4242 4242 4242 4242');
  await pay.selectOption('#mm', '4');
  await pay.selectOption('#yy', '2031');
  await pay.click('#cvc'); await pay.keyboard.type('737');
  await pay.click('#pay-go');
  const [paid] = await sent(pay, 'af:captured');
  assert.deepEqual(paid.card, { number: '4242424242424242', name: 'Sam Tester', expMonth: 4, expYear: 2031 });
  assert.ok(!JSON.stringify(await pay.evaluate(() => window.__ipc)).includes('737'), 'the security code never leaves the page');
  // A combined expiry field, and a number that isn't a card: nothing.
  await pay.click('#n2'); await pay.keyboard.type('4242424242424241');
  await pay.click('#e2'); await pay.keyboard.type('04/31');
  await pay.keyboard.press('Enter');
  assert.equal((await sent(pay, 'af:captured')).length, 1);
  await pay.close();
});
