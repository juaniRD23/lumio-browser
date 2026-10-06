// End-to-end tests for what a site gets in an installed app's window
// (main/apps.js) that it gets in a tab: saved passwords and "Save
// password?", Lumio passkeys after Touch ID (LUMIO_TEST_AUTH=allow stands in
// for it), addresses, and prompt()/confirm() as Lumio's card over the page.
// Also the permission chip in a pop-up window's bar for quiet requests.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from '../../scripts/launch.mjs';

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

// Pages of the test site: the fixtures, a sign-in's landing page, and a page
// that opens a pop-up which asks to show notifications.
const PAGES = {
  '/opener': '<!doctype html><title>Opener</title><button id="open" onclick="window.open(\'/notify\', \'n\', \'width=480,height=420\')">Open</button>',
  '/notify': '<!doctype html><title>Notify me</title><p>Pop-up</p>',
};

before(async () => {
  site = http.createServer((q, r) => {
    const p = new URL(q.url, 'http://x').pathname;
    if (PAGES[p]) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(PAGES[p]); return; }
    const file = path.join(FIX, p === '/welcome' ? 'welcome.html' : p.slice(1));
    if (!file.startsWith(FIX) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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

// ---------------------------------------------------------------- an app's window
// Installs an app for the front window's profile and opens its window (the
// Install dialog itself is tested in share-media.e2e.mjs). Returns its id.
const installApp = (url) => L.main((_e, u) => {
  const apps = global.lumio.pageTools.apps;
  const id = `e2e${Date.now().toString(16)}`;
  apps.file.data.apps = [...apps.list(), { id, name: 'E2E App', url: u, scope: `${new URL(u).origin}/`, window: true, profile: global.lumio.current.profile.base.id, created: Date.now(), launchers: [] }];
  apps.file.save(true);
  apps.open(id);
  return id;
}, url);
const removeApps = () => L.main(() => {
  const apps = global.lumio.pageTools.apps;
  for (const a of apps.list().filter((x) => x.id.startsWith('e2e'))) apps.uninstall(a.id);
  return true;
});
const appMain = (fn, ...args) => L.main((_e, x) => (0, eval)(`(${x.src})`)([...global.lumio.pageTools.apps.windows][0], ...x.args), { src: fn.toString(), args });
const inApp = (code) => L.main((_e, c) => [...global.lumio.pageTools.apps.windows][0].view.webContents.executeJavaScript(c, true), code);
const appTitle = () => appMain((w) => w?.view.webContents.getTitle() || null);
const appBar = (code) => L.main((_e, c) => [...global.lumio.pageTools.apps.windows][0].win.webContents.executeJavaScript(c), code);
const appOverlay = (code) => L.main((_e, c) => [...global.lumio.pageTools.apps.windows][0].overlay.webContents.executeJavaScript(c), code);
const appOverlayKind = () => appMain((w) => (!w?.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'));
// The dropdowns answer mousedown (the page keeps the focus).
const appOverlayPress = (sel) => appOverlay(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); true`);
// A real click and typing in the app's page, like a person.
const clickInApp = (sel) => L.main(async (_e, s) => {
  const wc = [...global.lumio.pageTools.apps.windows][0].view.webContents;
  const r = await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(s)}); el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
}, sel);
const typeInApp = (t) => L.main((_e, text) => { [...global.lumio.pageTools.apps.windows][0].view.webContents.insertText(text); return true; }, t);
const openApp = async (url, expect) => {
  const id = await installApp(url);
  assert.ok(await until(async () => (await appTitle()) === expect), `the app window shows ${expect}`);
  await until(() => inApp(`document.readyState === 'complete'`));
  return id;
};

test('passwords in an app window: Lumio’s dropdown fills a saved one, and "Save password?" shows in its title bar', async () => {
  await L.main((_e, o) => global.lumio.passwords.store.save({ origin: o, username: 'app@example.com', password: 'app-pass-1' }), base);
  try {
    await openApp(`${base}/login.html`, 'Test Login');
    await clickInApp('#user');
    assert.ok(await until(async () => (await appOverlayKind()) === 'autofill'), 'the passwords dropdown over the app’s page');
    assert.match(await appOverlay('document.body.innerText'), /app@example\.com/);
    assert.ok(!(await appOverlay('document.body.innerText')).includes('app-pass-1'), 'never the password itself');
    await shot('app-01-password-dropdown');
    await appOverlayPress('[data-fill]');
    assert.ok(await until(() => inApp(`document.getElementById('user').value === 'app@example.com' && document.getElementById('pass').value === 'app-pass-1'`)), 'filled after the pick');

    // A new sign-in typed here: "Save password?" in the app window's title bar.
    await inApp(`document.getElementById('user').value = ''; document.getElementById('pass').value = ''; true`);
    await clickInApp('#user'); await typeInApp('second@example.com');
    await clickInApp('#pass'); await typeInApp('second-pass-2');
    await clickInApp('#go');
    assert.ok(await until(() => appBar(`!document.getElementById('pw-key').hidden`)), 'the key in the title bar');
    assert.ok(await until(async () => (await appOverlayKind()) === 'pwsave'), 'the Save password bubble');
    await shot('app-02-save-password');
    await appOverlayPress('[data-decide=save]');
    assert.ok(await until(() => L.main(() => global.lumio.passwords.store.list().some((e) => e.username === 'second@example.com'))), 'saved in the app’s profile');
    assert.ok(await until(() => appBar(`document.getElementById('pw-key').hidden`)));
  } finally {
    await L.main((_e, o) => { const s = global.lumio.passwords.store; for (const e of s.list().filter((x) => x.origin === o)) s.remove(e.id); return true; }, base).catch(() => {});
    await removeApps().catch(() => {});
  }
});

test('passkeys in an app window: Lumio’s prompt, then a platform passkey for the site', async () => {
  const url = `http://localhost:${site.address().port}/passkey.html`;
  try {
    await openApp(url, 'Passkey Test Site');
    assert.equal(await inApp(`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`), true);
    await inApp(`register(); true`);
    assert.ok(await until(async () => (await appOverlayKind()) === 'passkey'), 'Lumio’s passkey prompt over the app’s page');
    assert.ok(await until(async () => /Save a passkey for localhost\?/.test(await appOverlay('document.body.innerText'))));
    await shot('app-03-passkey');
    await appOverlayPress('[data-pk="ok"]');
    assert.ok(await until(() => inApp(`!!(window.state.reg || window.state.regError)`)));
    const reg = await inApp(`window.state.reg || window.state.regError`);
    assert.equal(typeof reg, 'object', String(reg));
    assert.equal(reg.attachment, 'platform', 'a Lumio passkey, not the browser’s own');
    assert.deepEqual((await L.main(() => global.lumio.passwords.passkeys.list())).map((k) => k.rpId), ['localhost']);
    // Signing in with it.
    await inApp(`login(); true`);
    assert.ok(await until(async () => (await appOverlayKind()) === 'passkey'));
    await until(async () => /Sign in to localhost/.test(await appOverlay('document.body.innerText')));
    await appOverlayPress('[data-pk="ok"]');
    assert.ok(await until(() => inApp(`!!(window.state.auth || window.state.authError)`)));
    assert.equal(await inApp(`window.state.auth?.userHandle || window.state.authError`), 'user-42');
  } finally {
    await L.main(() => { const s = global.lumio.passwords.passkeys; for (const k of s.list().filter((x) => x.rpId === 'localhost')) s.remove(k.id); return true; }).catch(() => {});
    await removeApps().catch(() => {});
  }
});

test('addresses in an app window: the dropdown under the field, read to screen readers, and filled on a pick', async () => {
  const id = await L.main(() => global.lumio.autofill.store.saveAddress({ name: 'Sam Tester', street: '123 Ocean Drive', city: 'Miami Beach', state: 'FL', zip: '33139', country: 'US', email: 'sam@example.com' }));
  try {
    await openApp(`${base}/address.html`, 'Shipping — Test Shop');
    await clickInApp('#a1');
    assert.ok(await until(async () => (await appOverlayKind()) === 'formfill'), 'the dropdown over the app’s page');
    assert.match(await appOverlay('document.body.innerText'), /123 Ocean Drive/);
    assert.equal(await appOverlay(`document.querySelector('[role=listbox]').getAttribute('aria-label')`), 'Saved addresses');
    assert.match(await appOverlay(`document.getElementById('ff-live').textContent`), /^Saved addresses, 1\. Use the arrow keys/);
    await shot('app-04-address-dropdown');
    await appOverlayPress('.ff-row[data-i="0"]');
    assert.ok(await until(() => inApp(`document.getElementById('fn').value === 'Sam' && document.getElementById('city').value === 'Miami Beach'`)));
  } finally {
    await L.main((_e, i) => global.lumio.autofill.store.removeAddress(i), id).catch(() => {});
    await removeApps().catch(() => {});
  }
});

test('prompt() and confirm() in an app window: Lumio’s card over the page, with what was typed', async () => {
  try {
    await openApp(`${base}/login.html`, 'Test Login');
    const dialogShown = () => appMain((w) => w.tab.dialogs?.[0]?.spec.kind === 'js' && w.win.contentView.children.includes(w.dialogs.view) && !!w.dialogs.ready);
    const inDialog = (code) => L.main((_e, c) => [...global.lumio.pageTools.apps.windows][0].dialogs.view.webContents.executeJavaScript(c), code);
    await inApp(`setTimeout(() => { window.r = prompt('Name this folder', 'Work'); }, 0); true`);
    assert.ok(await until(dialogShown), 'the card over the app’s page');
    assert.ok(await until(async () => (await inDialog(`document.querySelector('#d-fields input')?.value`)) === 'Work'), 'with the page’s default text');
    assert.match(await inDialog('document.body.innerText'), /127\.0\.0\.1:\d+ says[\s\S]*Name this folder/);
    await shot('app-05-prompt');
    await inDialog(`const i = document.querySelector('#d-fields input'); i.value = 'Receipts'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#d-buttons [data-id="ok"]').click(); true`);
    assert.equal(await until(() => inApp('window.r')), 'Receipts');
    // confirm() too, and Cancel says no.
    await inApp(`window.c = 'waiting'; setTimeout(() => { window.c = confirm('Delete it?'); }, 0); true`);
    assert.ok(await until(dialogShown));
    await inDialog(`document.querySelector('#d-buttons [data-id="cancel"]').click(); true`);
    assert.equal(await until(async () => ((await inApp('window.c')) === false ? 'no' : null)), 'no');
  } finally {
    await removeApps().catch(() => {});
  }
});

// ---------------------------------------------------------------- a pop-up's permission chip
test('a quiet request in a pop-up window shows the chip in its bar; its bubble allows it for the site', async () => {
  const settings = () => L.main(() => global.lumio.profiles.normal.permissions.settings.defaultOf('notifications'));
  assert.equal(await settings(), 'quiet', 'notifications are quiet by default');
  const inPopup = (code) => L.main((_e, c) => global.lumio.popups[0].tabs.wc().mainFrame.executeJavaScript(c), code);
  const inBar = (code) => L.main((_e, c) => global.lumio.popups[0].win.webContents.executeJavaScript(c), code);
  const popupOverlay = (code) => L.main((_e, c) => global.lumio.popups[0].overlay.webContents.executeJavaScript(c), code);
  const popupOverlayKind = () => L.main(() => ((w) => (!w?.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.popups[0]));
  try {
    await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/opener`);
    assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === 'Opener'));
    await L.main(async () => {
      const wc = global.lumio.tabs.wc();
      const r = await wc.executeJavaScript(`(() => { const b = document.getElementById('open').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`);
      wc.focus();
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return true;
    });
    assert.ok(await until(async () => (await L.main(() => global.lumio.popups.length)) === 1 && (await inPopup('document.title')) === 'Notify me'), 'the pop-up opened');
    await inPopup(`window.__answer = null; Notification.requestPermission().then((p) => { window.__answer = p; }); true`);
    assert.ok(await until(() => inBar(`!document.getElementById('perm-chip').hidden && document.getElementById('perm-chip').classList.contains('quiet')`)), 'the quiet chip in the pop-up’s bar');
    assert.equal(await inBar(`document.getElementById('permbar').hidden`), true, 'not the bar over the page');
    assert.equal(await inBar(`document.querySelector('#perm-chip .pc-t').textContent`), 'Notifications blocked');
    await shot('popup-01-quiet-chip');
    await inBar(`document.getElementById('perm-chip').click(); true`);
    assert.ok(await until(async () => (await popupOverlayKind()) === 'permission'), 'its bubble, drawn by the pop-up’s overlay');
    assert.ok(await until(() => popupOverlay(`!!document.querySelector('.pb [data-d=allow]')`)));
    await shot('popup-02-quiet-bubble');
    await popupOverlay(`document.querySelector('.pb [data-d=allow]').click(); true`);
    assert.equal(await until(() => inPopup('window.__answer')), 'granted');
    assert.equal(await L.main((_e, o) => global.lumio.profiles.normal.permissions.settings.exception(o, 'notifications'), base), 'allow', 'remembered for the site');
    assert.ok(await until(() => inBar(`document.getElementById('perm-chip').hidden`)));
    assert.ok(await until(async () => (await popupOverlayKind()) === null), 'the bubble closed');
  } finally {
    await L.main((_e, o) => { global.lumio.profiles.normal.permissions.set(o, 'notifications', undefined); return true; }, base).catch(() => {});
    await L.main(() => { for (const p of global.lumio.popups) for (const t of p.tabs.tabs) t.touched = false; global.lumio.popups.forEach((p) => p.close()); return true; }).catch(() => {});
  }
});
