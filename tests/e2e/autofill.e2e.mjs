// End-to-end tests for address and card autofill, form entries and security
// keys, against local test shops. Card autofill needs a secure page, which
// 127.0.0.1 and localhost are. LUMIO_TEST_AUTH=allow stands in for Touch ID.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from '../../scripts/launch.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scripts = require('../../main/ai/tools/page-scripts.js');

const FIX = path.join(root, 'tests', 'fixtures');
const SHOTS = process.env.LUMIO_SHOTS;
let L;
let site;
let base;

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(150);
  }
};
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const go = async (url, expect) => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), url);
  assert.ok(await until(async () => (await title()) === expect), `loaded ${expect}`);
  await until(() => L.page(`document.readyState === 'complete'`));
};
// Real (trusted) mouse and keyboard input, like a person.
const clickOnce = (sel) => L.main(async (_e, s) => {
  const wc = global.lumio.tabs.wc();
  const r = await wc.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
}, sel);
const clickEl = async (sel) => {
  await clickOnce(sel);
  const field = JSON.stringify(sel);
  if (!(await L.page(`/^(INPUT|SELECT)$/.test(document.querySelector(${field})?.tagName)`))) return true;
  for (let i = 0; i < 8 && !(await L.page(`document.activeElement === document.querySelector(${field})`)); i++) {
    await L.wait(200);
    await clickOnce(sel);
  }
  return true;
};
const typeText = (t) => L.main((_e, text) => { global.lumio.tabs.wc().insertText(text); return true; }, t);
const key = (keyCode, modifiers = []) => L.main((_e, k) => {
  const wc = global.lumio.tabs.wc();
  wc.sendInputEvent({ type: 'keyDown', keyCode: k.keyCode, modifiers: k.modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode: k.keyCode, modifiers: k.modifiers });
  return true;
}, { keyCode, modifiers });
const overlayKind = () => L.main(() => global.lumio.current.overlayKind);
const overlayText = () => L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText'));
// The dropdown answers mousedown (the page keeps the focus); the bubble's buttons answer clicks.
const overlayPress = (sel) => L.main((_e, s) => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(s)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); true`), sel);
const overlayClick = (sel) => L.main((_e, s) => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(s)}).click(); true`), sel);
const store = (fn) => L.main((_e, src) => (0, eval)(`(${src})`)(global.lumio.autofill.store), fn.toString());

before(async () => {
  site = http.createServer((q, r) => {
    const file = path.join(FIX, new URL(q.url, 'http://x').pathname.slice(1));
    if (!file.startsWith(FIX) || !fs.existsSync(file)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(fs.readFileSync(file));
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  L = await launch({ env: { LUMIO_TEST_AUTH: 'allow' } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(500);
});

after(async () => {
  await L?.close();
  site?.close();
});

test('an address typed in a form is offered for saving, stored encrypted, and filled from Lumio’s dropdown', async () => {
  await go(`${base}/address.html`, 'Shipping — Test Shop');
  for (const [sel, text] of [['#fn', 'Sam'], ['#ln', 'Tester'], ['#a1', '123 Ocean Drive'], ['#city', 'Miami Beach'], ['#zip', '33139'], ['#email', 'sam@example.com']]) {
    await clickEl(sel);
    await typeText(text);
  }
  await L.page(`document.getElementById('state').value = 'FL'; document.getElementById('country').value = 'US'; true`);
  await clickEl('#go');
  assert.ok(await until(async () => (await overlayKind()) === 'formsave'), 'Save address?');
  assert.match(await overlayText(), /Save address\?[\s\S]*Sam Tester[\s\S]*123 Ocean Drive[\s\S]*Miami Beach, Florida 33139/);
  await L.wait(300);
  await shot('70-save-address');
  await overlayClick('[data-fs=save]');
  const saved = await until(async () => { const l = await store((s) => s.addresses()); return l.length === 1 && l; });
  assert.deepEqual([saved[0].name, saved[0].street, saved[0].city, saved[0].zip], ['Sam Tester', '123 Ocean Drive', 'Miami Beach', '33139']);
  await store((s) => s.file.flush());
  assert.ok(!fs.readFileSync(path.join(L.userData, 'autofill.json'), 'utf8').includes('Ocean'), 'encrypted on disk');

  // A fresh form: the dropdown under the street field, then a click fills the form.
  await go(`${base}/address.html?again`, 'Shipping — Test Shop');
  await clickEl('#a1');
  assert.ok(await until(async () => (await overlayKind()) === 'formfill'), 'dropdown');
  assert.match(await overlayText(), /123 Ocean Drive\s+Sam Tester[\s\S]*Manage addresses/);
  await L.wait(300);
  await shot('71-address-dropdown');
  assert.equal(await L.page(`document.getElementById('fn').value`), '', 'nothing filled before a choice');
  await overlayPress('.ff-row[data-i="0"]');
  assert.ok(await until(() => L.page(`document.getElementById('fn').value === 'Sam' && document.getElementById('city').value === 'Miami Beach' && document.getElementById('state').value === 'FL'`)));
  assert.equal(await L.page(`document.getElementById('trap').value`), '', 'never into a hidden field');

  // By keyboard: arrow down, Enter.
  await go(`${base}/address.html?keys`, 'Shipping — Test Shop');
  await clickEl('#city');
  assert.ok(await until(async () => (await overlayKind()) === 'formfill'));
  await key('Down');
  await until(async () => (await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`!!document.querySelector('.ff-row.sel')`))));
  await key('Return');
  assert.ok(await until(() => L.page(`document.getElementById('a1').value === '123 Ocean Drive'`)));
  assert.equal(await L.page('window.sent || 0'), 0, 'Enter picked; it didn’t send the form');
});

test('a card is saved without its security code, filled only after confirming, and kept out of Lumio AI’s view', async () => {
  await go(`${base}/checkout.html`, 'Checkout — Test Shop');
  await clickEl('#ccname'); await typeText('Sam Tester');
  await clickEl('#cardnumber'); await typeText('4242 4242 4242 4242');
  await L.page(`document.getElementById('mm').value = '4'; document.getElementById('yy').value = '2031'; true`);
  await clickEl('#cvc'); await typeText('737');
  await clickEl('#pay-go');
  assert.ok(await until(async () => (await overlayKind()) === 'formsave'), 'Save card?');
  assert.match(await overlayText(), /Save card\?[\s\S]*Visa •••• 4242[\s\S]*Expires 04\/31[\s\S]*security code is never saved/);
  await shot('72-save-card');
  await overlayClick('[data-fs=save]');
  assert.ok(await until(async () => (await store((s) => s.cards().length)) === 1));
  await store((s) => s.file.flush());
  const disk = fs.readFileSync(path.join(L.userData, 'autofill.json'), 'utf8');
  assert.ok(!disk.includes('4242424242424242') && !disk.includes('737'), 'no number in plain text, no security code at all');

  await go(`${base}/checkout.html?again`, 'Checkout — Test Shop');
  await clickEl('#cardnumber');
  assert.ok(await until(async () => (await overlayKind()) === 'formfill'));
  assert.match(await overlayText(), /Visa •••• 4242\s+Sam Tester · Expires 04\/31[\s\S]*Manage payment methods/);
  await shot('73-card-dropdown');
  await overlayPress('.ff-row[data-i="0"]');
  assert.ok(await until(() => L.page(`document.getElementById('cardnumber').value === '4242424242424242' && document.getElementById('mm').value === '4' && document.getElementById('yy').value === '2031'`)));
  assert.equal(await L.page(`[document.getElementById('cvc').value, document.activeElement.id].join()`), ',cvc', 'the cursor waits in the empty security code');
  // What Lumio AI reads of the page has no card number.
  const snap = JSON.stringify(await L.page(`(${scripts.snapshot.toString()})({})`));
  assert.ok(!snap.includes('4242'), 'not in the AI’s snapshot');
  assert.match(snap, /Card number\\" \(filled\)/);
  // Turned off in Settings: no card suggestions.
  await L.main(() => global.lumio.store.setSetting('autofillCards', false));
  await go(`${base}/checkout.html?off`, 'Checkout — Test Shop');
  await clickEl('#cardnumber');
  await L.wait(800);
  assert.notEqual(await overlayKind(), 'formfill');
  await L.main(() => global.lumio.store.setSetting('autofillCards', true));
});

test('form entries: suggested next time, removed with Shift+Delete, never in incognito', async () => {
  await go(`${base}/address.html?news`, 'Shipping — Test Shop');
  await clickEl('#nick'); await typeText('Sammy');
  await clickEl('#join');
  assert.ok(await until(async () => (await store((s) => s.suggestEntries('nickname', '').length)) === 1));
  await go(`${base}/address.html?news2`, 'Shipping — Test Shop');
  await clickEl('#nick');
  assert.ok(await until(async () => (await overlayKind()) === 'formfill'));
  assert.match(await overlayText(), /Sammy/);
  await key('Down');
  await key('Delete', ['shift']);
  assert.ok(await until(async () => (await store((s) => s.suggestEntries('nickname', '').length)) === 0), 'removed');
  // Incognito never remembers.
  await L.main((_e, u) => { global.lumio.createWindow({ incognito: true, urls: [u] }); return true; }, `${base}/address.html?incognito`);
  assert.ok(await until(async () => (await title()) === 'Shipping — Test Shop' && (await L.main(() => global.lumio.current.incognito))));
  await until(() => L.page(`document.readyState === 'complete'`));
  await clickEl('#nick'); await typeText('Secret Sam');
  await clickEl('#join');
  await L.wait(800);
  assert.equal(await store((s) => s.entries.length), 0);
  await L.main(() => { global.lumio.current.close(); return true; });
});

test('security keys: a site that asks for one gets the browser’s own WebAuthn (a virtual USB key here), not a Lumio passkey', async () => {
  const url = `http://localhost:${site.address().port}/security-key.html`;
  await go(url, 'Security Key Test Site');
  // Chromium's virtual authenticator stands in for a USB security key.
  const auth = await L.main(async () => {
    const wc = global.lumio.tabs.wc();
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('WebAuthn.enable', { enableUI: false });
    const r = await wc.debugger.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    return r.authenticatorId;
  });
  assert.ok(auth);
  const before = await L.main(() => global.lumio.passwords.passkeys.list().length);
  await L.page(`registerKey(); true`);
  const reg = await until(() => L.page(`window.state.reg || window.state.regError`), 20_000);
  assert.equal(typeof reg, 'object', String(reg));
  assert.equal(reg.attachment, 'cross-platform');
  assert.equal(await L.main(() => global.lumio.passwords.passkeys.list().length), before, 'Lumio didn’t make a passkey');
  // Signing in with that key: Lumio has no passkey with its id, so the key answers.
  await L.page(`signInKey(); true`);
  const signed = await until(() => L.page(`window.state.auth || window.state.authError`), 20_000);
  assert.equal(typeof signed, 'object', String(signed));
  assert.equal(signed.id, reg.id);
  assert.ok(await until(async () => (await overlayKind()) !== 'passkey'), 'Lumio’s “touch your key” note is gone');
  // Cancelling Lumio's note (no Windows dialog to cancel on a Mac) stops the request.
  if (process.platform !== 'win32') {
    await L.main(async (_e, id) => global.lumio.tabs.wc().debugger.sendCommand('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: id, enabled: false }), auth);
    await L.page(`window.state.auth = null; window.state.authError = null; signInKey(); true`);
    assert.ok(await until(async () => (await overlayKind()) === 'passkey'));
    assert.match(await overlayText(), /Use your security key/);
    await shot('74-security-key');
    await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector('[data-pk=cancel]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`));
    assert.match(await until(() => L.page(`window.state.authError`)), /NotAllowedError/);
  }
  await L.main(() => { const wc = global.lumio.tabs.wc(); if (wc.debugger.isAttached()) wc.debugger.detach(); });
});
