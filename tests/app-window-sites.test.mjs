// A site in an installed app's window (main/apps.js) gets what it gets in a
// tab of its profile: the saved passwords dropdown and filling, passkeys
// (still only after Touch ID, here LUMIO_TEST_AUTH), addresses, and its
// alert()/confirm()/prompt() as Lumio's card over the page. With the real
// PasswordManager, AutofillManager, page dialogs, dialog view and the
// browser window's overlay code; Electron is a stand-in (tests/fake-tabs.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeWebContents, makeStore } from './fake-tabs.mjs';
const require = createRequire(import.meta.url);

// What fake-tabs.mjs's Electron doesn't have, as far as app windows use it.
const electron = require('electron');
const ipc = { on: {}, handle: {} };
const live = new Map(); // webContents id -> webContents (webContents.fromId)
class FakeBrowserWindow extends EventEmitter {
  constructor() {
    super();
    const children = [];
    this.webContents = new FakeWebContents();
    this.contentView = {
      children,
      addChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); children.push(v); },
      removeChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
    };
    this.destroyed = false;
  }
  loadURL() { return Promise.resolve(); }
  getContentSize() { return [1000, 700]; }
  getBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; }
  isFullScreen() { return false; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  isFocused() { return false; }
  setTitle() {}
  setMenu() {}
  setMenuBarVisibility() {}
  setBackgroundColor() {}
  show() {}
  focus() {}
  close() { if (this.destroyed) return; this.emit('close'); this.destroyed = true; this.emit('closed'); }
}
Object.assign(electron, {
  BrowserWindow: Object.assign(FakeBrowserWindow, { getFocusedWindow: () => null }),
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }), getAllDisplays: () => [] },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  ipcMain: { on: (c, fn) => { ipc.on[c] = fn; }, handle: (c, fn) => { ipc.handle[c] = fn; } },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  webContents: { fromId: (id) => live.get(id) || null },
  systemPreferences: { canPromptTouchID: () => false },
});

const { Apps, UI_CHANNELS } = require('../main/apps.js');
const { PasswordManager } = require('../main/password-manager.js');
const { AutofillManager } = require('../main/autofill.js');
const pageDialogs = require('../main/page-dialogs.js');

const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('hex')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString(),
};
const b64 = (b) => Buffer.from(b).toString('base64url');
const SITE = 'https://mail.example';
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let dir, apps, profiles, toasts;
const env = {};
before(() => {
  for (const k of ['LUMIO_TEST', 'LUMIO_TEST_AUTH', 'LUMIO_HIDDEN']) env[k] = process.env[k];
  process.env.LUMIO_TEST = '1';
  process.env.LUMIO_HIDDEN = '1';
  makeStore(); // (theme colors)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-app-sites-'));
  toasts = [];
  // Two profiles, each with its own passwords and autofill, like main.js.
  // Their lookups find a site's page only through the app windows here.
  const pageOf = (wc) => apps.holderOf(wc);
  profiles = {};
  for (const id of ['first', 'work']) {
    const pdir = path.join(dir, id);
    fs.mkdirSync(pdir);
    const settings = { settings: {}, setSetting(k, v) { this.settings[k] = v; } };
    profiles[id] = {
      id,
      passwords: new PasswordManager({ dir: pdir, safeStorage: safe, settings, helper: null, findTab: pageOf, toast: (_w, t) => toasts.push(t) }),
      autofill: new AutofillManager({ dir: pdir, safeStorage: safe, settings, helper: null, findTab: pageOf, toast: (_w, t) => toasts.push(t), openPage: () => {} }),
      permissions: { dropFor() {} },
      session: {},
    };
  }
  // main.js's routing: a page's messages go to its own profile's managers.
  PasswordManager.register((wc) => pageOf(wc)?.w.profile.passwords || null);
  AutofillManager.registerPages((wc) => pageOf(wc)?.w.profile.autofill || null);
  apps = new Apps({
    dir,
    launcherDir: path.join(dir, 'Lumio Apps'),
    session: (id) => profiles[id || 'first'].session,
    permissions: (id) => profiles[id || 'first'].permissions,
    profile: (id) => profiles[id || 'first'],
    openUrl: () => {},
  });
  apps.file.data.apps = [
    { id: 'mailapp', name: 'Mail', url: `${SITE}/login`, scope: `${SITE}/`, window: true, profile: 'work', launchers: [] },
    { id: 'oldapp', name: 'Old', url: 'https://old.example/', scope: 'https://old.example/', window: true, launchers: [] }, // from before profiles
  ];
});
after(() => {
  for (const aw of [...(apps?.windows || [])]) aw.win.close();
  // Saves still waiting to be written go now, before the folder goes.
  for (const p of Object.values(profiles || {})) for (const f of [p.passwords.store.file, p.passwords.passkeys.file, p.autofill.store.file, p.autofill.store.historyFile]) f?.flush?.();
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(dir, { recursive: true, force: true });
});

// Opens an app's window; its page is "on" url (a fake top frame that records what Lumio sends it).
function openApp(id, url) {
  apps.open(id);
  const aw = [...apps.windows].find((x) => x.rec.id === id);
  const wc = aw.view.webContents;
  live.set(wc.id, wc);
  const toPage = [];
  wc.mainFrame = { url, send: (c, p) => toPage.push([c, p]) };
  const overlaySent = [];
  aw.overlay.webContents.send = (c, p) => overlaySent.push([c, p]);
  return { aw, wc, toPage, overlaySent, e: { sender: wc, senderFrame: wc.mainFrame } };
}

test('an app window is its own profile’s page; its UI may call only the dropdown and dialog channels', () => {
  const { aw, wc } = openApp('mailapp', `${SITE}/login`);
  assert.equal(aw.profile, profiles.work, 'the profile it was installed from');
  const found = apps.holderOf(wc);
  assert.equal(found.w, aw);
  assert.equal(found.tab, aw.tabs.active);
  assert.equal(found.tab.view, aw.view);
  assert.equal(apps.holderOf(new FakeWebContents()), null, 'anything else isn’t an app’s page');
  assert.equal(apps.holderOf(aw.overlay.webContents), null, 'its overlay isn’t a page');
  for (const c of ['passwords:fill', 'passwords:passkey', 'autofill:pick', 'overlay:pick']) assert.equal(apps.uiOwner(aw.overlay.webContents, c), aw, c);
  assert.equal(apps.uiOwner(aw.win.webContents, 'overlay:show'), aw, 'the title bar shows "Save password?"');
  for (const c of ['ai:send', 'tab:close', 'site:info', 'account:sign-out']) assert.equal(apps.uiOwner(aw.overlay.webContents, c), null, c);
  assert.equal(apps.uiOwner(wc, 'passwords:fill'), null, 'never the site itself');
  assert.ok(UI_CHANNELS.has('passwords:reveal-pending'));
  const { aw: old } = openApp('oldapp', 'https://old.example/');
  assert.equal(old.profile, profiles.first, 'an app from before profiles: the first profile');
  old.win.close();
});

test('saved passwords: the dropdown over the app’s page, filled from its own profile only', async () => {
  const work = profiles.work.passwords;
  const first = profiles.first.passwords;
  first.store.save({ origin: SITE, username: 'me@home.example', password: 'home-secret' });
  const id = work.store.save({ origin: SITE, username: 'me@work.example', password: 'work-secret' });
  const { aw, e, toPage, overlaySent } = openApp('mailapp', `${SITE}/login`);
  assert.deepEqual(await ipc.handle['pw:query'](e, {}), { accounts: 1, generate: false });
  ipc.on['pw:show'](e, { x: 40, y: 100, width: 300, height: 30 });
  assert.equal(aw.overlayKind, 'autofill');
  const data = overlaySent.find(([c, p]) => c === 'overlay-data' && p.op === 'show')[1];
  assert.deepEqual(data.accounts, [{ id, username: 'me@work.example' }], 'the work profile’s account, no password');
  assert.ok(!JSON.stringify(overlaySent).includes('secret'), 'no password reaches the overlay');
  await settle(170); // the overlay comes in (main/window.js: drawn, or after 150 ms)
  assert.ok(aw.win.contentView.children.includes(aw.overlay), 'over the page');
  assert.equal(aw.win.contentView.children.at(-1), aw.overlay);
  // A pick in the dropdown (main.js routes the overlay's call to this window).
  aw.profile.passwords.fill(aw, { id });
  assert.deepEqual(toPage.filter(([c]) => c === 'pw:fill'), [['pw:fill', { username: 'me@work.example', password: 'work-secret' }]]);
  // Another profile's id never fills here.
  const other = first.store.forOrigin(SITE)[0].id;
  await ipc.handle['pw:query'](e, {});
  aw.profile.passwords.fill(aw, { id: other });
  assert.equal(toPage.filter(([c]) => c === 'pw:fill').length, 1);
  aw.win.close();
});

test('"Save password?" goes to the app window’s title bar, and saving it uses the app’s profile', () => {
  const { aw, e } = openApp('mailapp', `${SITE}/login`);
  const sent = [];
  aw.win.webContents.send = (c, p) => sent.push([c, p]);
  ipc.on['pw:captured'](e, { username: 'boss@work.example', password: 'b0ss-pass' });
  const [, prompt] = sent.find(([c]) => c === 'passwords-prompt');
  assert.equal(prompt.host, 'mail.example');
  assert.equal(prompt.tabId, aw.tabs.activeId);
  assert.ok(!JSON.stringify(prompt).includes('b0ss-pass'), 'never the password itself');
  aw.profile.passwords.decide(aw, { id: prompt.id, decision: 'save' });
  assert.ok(profiles.work.passwords.store.forOrigin(SITE).some((a) => a.username === 'boss@work.example'));
  assert.ok(!profiles.first.passwords.store.forOrigin(SITE).some((a) => a.username === 'boss@work.example'), 'not in another profile');
  assert.equal(toasts.at(-1), 'Password saved');
  aw.win.close();
});

test('passkeys in an app window: Lumio’s prompt over the page, and only after confirming it’s you', async () => {
  const { aw, e, overlaySent } = openApp('mailapp', `${SITE}/login`);
  const publicKey = {
    challenge: b64(crypto.randomBytes(32)), rp: { id: 'mail.example', name: 'Mail' },
    user: { id: b64(Buffer.from('u-1')), name: 'sam@mail.example', displayName: 'Sam' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required' },
  };
  const promptOf = () => overlaySent.filter(([c, p]) => c === 'overlay-data' && p.kind === 'passkey').at(-1)[1].prompt;
  // Not confirmed: nothing is made.
  process.env.LUMIO_TEST_AUTH = 'deny';
  let answer = ipc.handle['pk:request'](e, { kind: 'create', publicKey });
  assert.equal(aw.overlayKind, 'passkey', 'Lumio’s own prompt, not the browser’s');
  await aw.profile.passwords.passkeyDecide(aw, { id: promptOf().id, decision: 'ok' });
  assert.deepEqual(await answer, { error: 'NotAllowedError', message: 'Lumio couldn’t confirm it’s you.' });
  assert.equal(profiles.work.passwords.passkeys.list().length, 0);
  // Confirmed: a passkey for the site, in the app's profile.
  process.env.LUMIO_TEST_AUTH = 'allow';
  answer = ipc.handle['pk:request'](e, { kind: 'create', publicKey });
  await aw.profile.passwords.passkeyDecide(aw, { id: promptOf().id, decision: 'ok' });
  const made = await answer;
  assert.ok(made.credential?.id, JSON.stringify(made));
  assert.deepEqual(profiles.work.passwords.passkeys.list().map((k) => k.rpId), ['mail.example']);
  assert.equal(profiles.first.passwords.passkeys.list().length, 0, 'not in another profile');
  // Closing the prompt (or the window) answers the page "no".
  answer = ipc.handle['pk:request'](e, { kind: 'get', publicKey: { challenge: b64(crypto.randomBytes(32)), rpId: 'mail.example' } });
  assert.equal(aw.overlayKind, 'passkey');
  aw.win.close();
  assert.equal((await answer).error, 'NotAllowedError');
});

test('addresses and earlier entries: the dropdown under the field in the app window', () => {
  const { aw, e, toPage, overlaySent } = openApp('mailapp', `${SITE}/settings`);
  profiles.work.autofill.store.saveAddress({ name: 'Sam Tester', street: '1 Work Way', city: 'Miami', state: 'FL', zip: '33101', email: 'sam@work.example' });
  assert.deepEqual(ipc.handle['af:query'](e, { mode: 'address', field: 'name', prefix: '', rect: { x: 20, top: 100, bottom: 130, width: 300 } }), { count: 1 });
  assert.equal(aw.overlayKind, 'formfill');
  const shown = overlaySent.filter(([c, p]) => c === 'overlay-data' && p.kind === 'formfill').at(-1)[1];
  assert.deepEqual(shown.items.map((i) => i.label), ['Sam Tester']);
  profiles.work.autofill.pick(aw.view.webContents, 0);
  const [, fill] = toPage.find(([c]) => c === 'af:fill');
  assert.equal(fill.mode, 'address');
  assert.equal(fill.values.street, '1 Work Way');
  aw.win.close();
});

test('alert(), confirm() and prompt() in an app window: Lumio’s card over the page', async () => {
  const { aw } = openApp('mailapp', `${SITE}/inbox`);
  const ask = (kind, message, value) => pageDialogs.jsDialog(aw.tab, { kind, message, value, url: `${SITE}/inbox` });
  const shown = () => aw.tab.dialogs[0];

  const named = ask('prompt', 'Name this folder', 'Work');
  assert.equal(shown().spec.title, 'mail.example says');
  assert.deepEqual(shown().spec.fields, [{ name: 'value', type: 'text', label: '', value: 'Work' }]);
  assert.ok(aw.win.contentView.children.includes(aw.dialogs.view), 'over the page');
  assert.deepEqual(aw.dialogs.view.getBounds?.() ?? aw.dialogs.view.bounds, aw.view.bounds, 'covering the whole page');
  aw.dialogs.answer({ id: shown().id, button: 'ok', values: { value: 'Receipts' } });
  assert.equal(await named, 'Receipts');
  assert.ok(!aw.win.contentView.children.includes(aw.dialogs.view), 'gone once answered');

  const cancelled = ask('prompt', 'Again?', '');
  aw.dialogs.answer({ id: shown().id, button: 'cancel' });
  assert.equal(await cancelled, null);
  const sure = ask('confirm', 'Delete it?');
  assert.equal(shown().spec.checkbox?.label, 'Don\'t allow mail.example to show more dialogs', 'from the second in a row');
  aw.dialogs.answer({ id: shown().id, button: 'ok' });
  assert.equal(await sure, true);
  // The page leaving takes its dialog with it; so does closing the window.
  const left = ask('prompt', 'Leaving?', 'x');
  aw.view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${SITE}/elsewhere` });
  assert.equal(await left, null);
  const closing = ask('alert', 'Bye');
  aw.win.close();
  assert.equal(await closing, null);
});
