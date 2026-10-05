// The browser side of autofill (main/autofill.js) with a stand-in window,
// tab and page: what the dropdown offers where, that it never covers another
// question, the keyboard highlight, filling only the same site, cards only
// after confirming it's the person (and never while Lumio AI works), and the
// "Save card?" / "Save address?" questions after a form is sent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Electron, as far as main/autofill.js uses it.
const ipc = { handle: {}, on: {} };
let dialogAnswer = 1;
require.cache[require.resolve('electron')] = {
  id: 'electron', loaded: true,
  exports: {
    ipcMain: { handle: (c, fn) => { ipc.handle[c] = fn; }, on: (c, fn) => { ipc.on[c] = fn; } },
    dialog: { showMessageBox: async () => ({ response: dialogAnswer }) },
    systemPreferences: { canPromptTouchID: () => false },
  },
};
const { AutofillManager } = require('../main/autofill.js');

const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('hex')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString(),
};
const HOME = { name: 'Sam Tester', street: '123 Ocean Drive', city: 'Miami Beach', state: 'FL', zip: '33139', email: 'sam@example.com' };
const RECT = { x: 100, top: 200, bottom: 230, width: 320 };

let m, w, wc, page, fills, toasts, aiRunning, pages, closed;
function setup({ url = 'https://shop.example/checkout', incognito = false } = {}) {
  fills = [];
  closed = 0;
  toasts = [];
  aiRunning = false;
  wc = { id: 11, mainFrame: { url, send: (c, p) => { if (c === 'af:fill') fills.push([c, p]); else closed++; } }, getZoomFactor: () => 1, isDestroyed: () => false, once() {}, focus() {} };
  const tab = { id: 1, view: { getBounds: () => ({ x: 0, y: 80, width: 1200, height: 720 }), webContents: wc } };
  w = {
    incognito, closed: false, overlayKind: null, shown: [],
    win: { getContentSize: () => [1200, 800], isFocused: () => true },
    overlay: { webContents: { sent: [], send(c, p) { this.sent.push([c, p]); }, focus() {} } },
    showOverlay(rect, payload) { this.overlayKind = payload.kind; this.shown.push({ rect, payload }); },
    hideOverlay() { this.overlayKind = null; },
    tabs: { activeId: 1, tabs: [tab], active: tab },
    ai: { isRunning: () => aiRunning },
  };
  const settings = { settings: {}, setSetting(k, v) { this.settings[k] = v; } };
  m = new AutofillManager({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-afm-')), safeStorage: safe, settings, helper: null, findTab: (s) => (s === wc ? { w, tab } : null), toast: (_w, t) => toasts.push(t), openPage: () => {} });
  pages = {};
  m.register({ on: (c, fn) => { ipc.on[c] = (e, ...a) => fn(w, ...a); }, internalHandle: (c, _hosts, fn) => { pages[c] = (...a) => fn({ w }, ...a); } });
  page = { sender: wc, senderFrame: wc.mainFrame };
}
const query = (q) => ipc.handle['af:query'](page, q);
const shown = () => w.shown.at(-1)?.payload;

beforeEach(() => {
  process.env.LUMIO_TEST = '1';
  process.env.LUMIO_TEST_AUTH = 'allow';
  setup();
});

test('addresses under a field: filtered by what is typed, placed under it, never over another question', () => {
  m.store.saveAddress(HOME);
  m.store.saveAddress({ ...HOME, name: 'Ana García', street: '9 Calle Ocho', zip: '33135', email: 'ana@example.com' });
  assert.deepEqual(query({ mode: 'address', field: 'given', prefix: 'an', rect: RECT }), { count: 1 });
  assert.deepEqual(shown().items.map((i) => [i.label, i.sub]), [['Ana', 'Ana García']]);
  assert.equal(shown().footer, 'Manage addresses…');
  const { rect } = w.shown.at(-1);
  assert.deepEqual([rect.x, rect.y, rect.width], [88, 80 + 230 + 2, 344]);
  assert.equal(rect.height, 48 + 37 + 38, 'one two-line row, the footer, and the padding');
  // Nothing matches: the dropdown closes.
  assert.deepEqual(query({ mode: 'address', field: 'zip', prefix: '9', rect: RECT }), { count: 0 });
  assert.equal(w.overlayKind, null);
  // Near the bottom of the window it opens above the field.
  query({ mode: 'address', field: 'city', prefix: '', rect: { ...RECT, top: 640, bottom: 670 } });
  assert.ok(w.shown.at(-1).rect.y < 80 + 640, 'above');
  // A passkey question stays where it is.
  w.overlayKind = 'passkey';
  assert.deepEqual(query({ mode: 'address', field: 'city', prefix: '', rect: RECT }), { count: 0 });
  assert.equal(w.overlayKind, 'passkey');
  // Turned off: nothing.
  w.overlayKind = null;
  m.settings.setSetting('autofillAddresses', false);
  assert.deepEqual(query({ mode: 'address', field: 'city', prefix: '', rect: RECT }), { count: 0 });
});

test('earlier entries: the fallback for an address field, removable, and never in incognito', () => {
  m.store.recordEntries([{ key: 'city', value: 'Miami' }, { key: 'city', value: 'Madrid' }]);
  assert.deepEqual(query({ mode: 'address', field: 'city', key: 'city', prefix: 'm', rect: RECT }), { count: 2 });
  assert.equal(shown().mode, 'history');
  assert.equal(shown().footer, '');
  assert.equal(w.shown.at(-1).rect.height, 38 * 2 + 38, 'one-line rows, no footer');
  ipc.on['af:select'](page, { index: 1 });
  assert.equal(w.overlay.webContents.sent.at(-1)[1].selected, 1, 'the highlight follows the arrow keys');
  assert.deepEqual(ipc.handle['af:remove'](page, { index: 0 }), { count: 1 });
  assert.deepEqual(m.store.suggestEntries('city', '').map((x) => x.value), ['Madrid']);
  // Hidden meanwhile (another tab, another popup): Enter in the field picks nothing.
  w.overlayKind = 'downloads';
  ipc.on['af:pick'](page, { index: 0 });
  assert.deepEqual(fills, []);
  query({ mode: 'history', key: 'city', prefix: '', rect: RECT });
  ipc.on['af:pick'](page, { index: 0 });
  assert.deepEqual(fills, [['af:fill', { mode: 'history', value: 'Madrid' }]]);
  setup({ incognito: true });
  m.store.recordEntries([{ key: 'city', value: 'Miami' }]);
  assert.deepEqual(query({ mode: 'history', key: 'city', prefix: '', rect: RECT }), { count: 0 });
});

test('cards: secure pages only, never while Lumio AI works, filled only after confirming it’s the person and only on the same site', async () => {
  m.store.saveCard({ number: '4242424242424242', name: 'Sam Tester', expMonth: 4, expYear: 2031 });
  m.store.saveCard({ number: '5555555555554444', expMonth: 1, expYear: 2020 }); // expired: not offered
  aiRunning = true;
  assert.deepEqual(query({ mode: 'card', field: 'cc-number', rect: RECT }), { count: 0 });
  aiRunning = false;
  assert.deepEqual(query({ mode: 'card', field: 'cc-number', rect: RECT }), { count: 1 });
  assert.deepEqual(shown().items.map((i) => [i.label, i.sub]), [['Visa •••• 4242', 'Sam Tester · Expires 04/31']]);
  assert.ok(!JSON.stringify(w.shown).includes('4242424242424242'), 'the dropdown never has the number');
  // Not confirmed: nothing filled, and the page hears the dropdown closed.
  process.env.LUMIO_TEST_AUTH = 'deny';
  const shut = closed;
  ipc.on['autofill:pick'](null, { index: 0 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fills, []);
  assert.equal(closed, shut + 1);
  // Confirmed: number, name and expiry (never a security code).
  process.env.LUMIO_TEST_AUTH = 'allow';
  query({ mode: 'card', field: 'cc-number', rect: RECT });
  ipc.on['autofill:pick'](null, { index: 0 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fills, [['af:fill', { mode: 'card', values: { number: '4242424242424242', name: 'Sam Tester', expMonth: 4, expYear: 2031 } }]]);
  // The page moved to another site meanwhile: nothing.
  query({ mode: 'card', field: 'cc-number', rect: RECT });
  wc.mainFrame.url = 'https://evil.example/';
  ipc.on['autofill:pick'](null, { index: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(fills.length, 1);
  // Plain http: no cards.
  setup({ url: 'http://shop.example/checkout' });
  m.store.saveCard({ number: '4242424242424242' });
  assert.deepEqual(query({ mode: 'card', field: 'cc-number', rect: RECT }), { count: 0 });
});

test('after a checkout: "Save card?", then "Save address?"; answers stick; incognito saves nothing', () => {
  const sent = { address: HOME, card: { number: '4242424242424242', name: 'Sam Tester', expMonth: 4, expYear: 2031, cvc: '737' }, history: [{ key: 'gift_note', value: 'Happy birthday' }] };
  ipc.on['af:captured'](page, sent);
  assert.deepEqual(m.store.suggestEntries('gift_note', '').map((x) => x.value), ['Happy birthday']);
  const ask = shown();
  assert.equal(ask.kind, 'formsave');
  assert.deepEqual([ask.prompt.what, ask.prompt.action, ask.prompt.host], ['card', 'save', 'shop.example']);
  assert.deepEqual(ask.prompt.lines, ['Visa •••• 4242', 'Sam Tester', 'Expires 04/31']);
  assert.ok(!JSON.stringify(w.shown).includes('4242424242424242'), 'the bubble never has the number');
  ipc.on['autofill:decide'](null, { id: ask.prompt.id, decision: 'save' });
  assert.deepEqual(m.store.cards().map((c) => c.last4), ['4242']);
  assert.ok(!JSON.stringify(m.store.file.data).includes('737'));
  // Then the address from the same checkout.
  const next = shown();
  assert.deepEqual([next.kind, next.prompt.what, next.prompt.lines[0]], ['formsave', 'address', 'Sam Tester']);
  ipc.on['autofill:decide'](null, { id: next.prompt.id, decision: 'never' });
  assert.equal(m.store.isNever('address', 'https://shop.example'), true);
  assert.deepEqual(toasts, ['Card saved']);
  // Sent again: already saved, and never for addresses here: no question.
  const before = w.shown.length;
  ipc.on['af:captured'](page, sent);
  assert.equal(w.shown.length, before);
  // Incognito: nothing remembered.
  setup({ incognito: true });
  ipc.on['af:captured'](page, sent);
  assert.equal(w.shown.length, 0);
  assert.equal(m.store.entries.length, 0);
});

test('Settings: only its switches can change, and a card number shows only after confirming', async () => {
  const id = m.store.saveCard({ number: '4242424242424242' });
  assert.equal(pages['page:autofill-set']('approvalMode', 'bypass').autofillCards, true);
  assert.equal(m.settings.settings.approvalMode, undefined);
  assert.equal(pages['page:autofill-set']('autofillCards', false).autofillCards, false);
  process.env.LUMIO_TEST_AUTH = 'deny';
  assert.deepEqual(await pages['page:card-reveal'](id), { ok: false });
  process.env.LUMIO_TEST_AUTH = 'allow';
  assert.deepEqual(await pages['page:card-reveal'](id), { ok: true, number: '4242424242424242' });
  assert.deepEqual(pages['page:card-save']({ number: '1234' }), { ok: false, error: 'That card number isn’t valid. Check it and try again.' });
  assert.ok(!JSON.stringify(pages['page:autofill']()).includes('4242424242424242'));
});
