// First run: Welcome → Keychain → Import (a fake Chrome with a bookmark and a
// saved password) → Done. Run: node --test tests/e2e/welcome.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const SECRET = 'fake-chrome-key';
let L;
let tmp;
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await new Promise((r) => setTimeout(r, 500)); await L.shot(path.join(SHOTS, name + '.png')); } };
const visibleStep = () => L.page(`document.querySelector('.step:not([hidden])')?.dataset.step`);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-welcome-'));
  const profile = path.join(tmp, 'support', 'Google', 'Chrome', 'Default');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [
    { type: 'url', url: 'https://github.com/', name: 'GitHub' }, { type: 'url', url: 'https://news.ycombinator.com/', name: 'Hacker News' },
  ] } } }));
  const key = crypto.pbkdf2Sync(SECRET, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const db = new DatabaseSync(path.join(profile, 'Login Data'));
  db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)');
  db.prepare('INSERT INTO logins VALUES (?, ?, ?, 0)').run('https://github.com/login', 'sam', Buffer.concat([Buffer.from('v10'), c.update('hunter2'), c.final()]));
  db.close();
  L = await launch({ env: {
    LUMIO_TEST_WELCOME: '1', LUMIO_IMPORT_ROOT: path.join(tmp, 'support'), LUMIO_IMPORT_SECRET: SECRET,
    LUMIO_SAFARI_DIR: path.join(tmp, 'no-safari'),
  } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
});

after(async () => {
  await L?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('a first launch opens the welcome screens, with the AI panel out of the way', async () => {
  assert.equal(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://welcome/'), true);
  assert.equal(await until(() => L.shell(`document.body.classList.contains('panel-closed')`)), true);
  assert.equal(await until(visibleStep), 'hello');
  assert.match(await L.page(`document.body.innerText`), /Welcome to Lumio Browser/);
  await shot('50-welcome');
  await L.page(`document.querySelector('[data-step=hello] [data-next]').click(); true`);
});

test('the Keychain screen shows the macOS prompt and what to click, then asks macOS', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await until(async () => (await visibleStep()) === 'keychain'), true);
  const text = await L.page(`document.querySelector('[data-step=keychain]').innerText`);
  assert.match(text, /Lumio Browser Safe Storage[\s\S]*Always Allow[\s\S]*Click this one[\s\S]*Click Always Allow, not Allow/);
  await shot('51-keychain');
  await L.page(`document.getElementById('kc-go').click(); true`);
  assert.ok(await until(() => L.page(`document.getElementById('kc-msg').className.includes('ok')`)), 'the Keychain answered');
  assert.equal(await until(async () => (await visibleStep()) === 'import', 5000), true, 'moves on by itself');
});

test('import: Chrome bookmarks and passwords (macOS asks to read Chrome’s key)', async () => {
  assert.equal(await until(async () => (await visibleStep()) === 'import'), true);
  assert.deepEqual(await L.page(`[...document.querySelectorAll('.src b')].map((b) => b.textContent)`), ['Google Chrome']);
  if (process.platform === 'darwin') assert.match(await L.page(`document.getElementById('imp-note').textContent`), /macOS will ask to let Lumio read Google Chrome’s passwords/);
  await shot('52-import');
  await L.page(`document.getElementById('imp-go').click(); true`);
  assert.ok(await until(() => L.page(`!document.getElementById('result').hidden`)));
  const result = await L.page(`document.getElementById('result').innerText`);
  if (process.platform === 'darwin') assert.match(result, /Imported 2 bookmarks, 1 password/);
  else assert.match(result, /Imported 2 bookmarks[\s\S]*export them from Google Chrome as a CSV/);
  assert.deepEqual((await L.main(() => global.lumio.store.bookmarks().map((b) => b.url))).sort(), ['https://github.com/', 'https://news.ycombinator.com/']);
  if (process.platform === 'darwin') {
    assert.deepEqual(await L.main(() => global.lumio.passwords.store.list().map((e) => [e.site, e.username])), [['github.com', 'sam']]);
    const id = await L.main(() => global.lumio.passwords.store.list()[0].id);
    assert.equal(await L.main((_e, i) => global.lumio.passwords.store.secret(i), id), 'hunter2');
  }
  await shot('53-imported');
  await L.page(`document.getElementById('imp-go').click(); true`);
});

test('done: Start browsing opens a new tab and the AI panel, and the welcome won’t show again', async () => {
  assert.equal(await until(async () => (await visibleStep()) === 'done'), true);
  assert.match(await L.page(`document.querySelector('[data-step=done]').innerText`), /default browser[\s\S]*Sign in to Lumio AI/);
  await shot('54-done');
  await L.page(`document.getElementById('finish').click(); true`);
  assert.equal(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())) === 'lumio://newtab/'), true);
  assert.equal(await until(async () => !(await L.shell(`document.body.classList.contains('panel-closed')`))), true, 'panel opened');
  assert.equal(await L.main(() => global.lumio.store.settings.onboarded), true);
});
