// End-to-end tests for the Lumio account button and the password manager,
// against a stand-in Lumio site (tests/mock-lumio.mjs) and a local login page.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from '../../scripts/launch.mjs';
import { startMockLumio } from '../mock-lumio.mjs';

const FIX = path.join(root, 'tests', 'fixtures');
const SHOTS = process.env.LUMIO_SHOTS;
let L;
let site;
let base;
let lumio;

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
// A click right after a page loads can land before the page takes input, so
// clicks on text fields are repeated until the field really has focus.
const clickEl = async (sel) => {
  await clickOnce(sel);
  const field = JSON.stringify(sel);
  if (!(await L.page(`document.querySelector(${field})?.tagName === 'INPUT'`))) return true;
  for (let i = 0; i < 8 && !(await L.page(`document.activeElement === document.querySelector(${field})`)); i++) {
    await L.wait(200);
    await clickOnce(sel);
  }
  return true;
};
const typeText = (t) => L.main((_e, text) => { global.lumio.tabs.wc().insertText(text); return true; }, t);
const overlayKind = () => L.main(() => global.lumio.current.overlayKind);
const overlayClick = (sel) => L.main((_e, s) => global.lumio.current.overlay.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(s)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`), sel);
const saved = () => L.main(() => global.lumio.passwords.store.list());

async function signInOnce(user, pass) {
  await go(`${base}/login.html`, 'Test Login');
  await clickEl('#user'); await typeText(user);
  await clickEl('#pass'); await typeText(pass);
  await clickEl('#go');
}

before(async () => {
  site = http.createServer((q, r) => {
    const p = new URL(q.url, 'http://x').pathname;
    const file = path.join(FIX, p === '/welcome' ? 'welcome.html' : p.slice(1));
    if (!file.startsWith(FIX) || !fs.existsSync(file)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(fs.readFileSync(file));
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  lumio = await startMockLumio();
  L = await launch({ env: { LUMIO_ACCOUNT_BASE: lumio.base, LUMIO_AI_BASE: lumio.base, LUMIO_TEST_AUTH: 'allow' } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(500);
});

after(async () => {
  await L?.close();
  site?.close();
  lumio?.server.close();
});

// ------------------------------------------------------------ passkeys
test('passkeys: a site saves one after the person confirms, signs in with it, and the signature verifies', async () => {
  const { cborDecode } = require('../../main/passkeys.js');
  const sha = (d) => crypto.createHash('sha256').update(d).digest();
  const url = `http://localhost:${site.address().port}/passkey.html`;
  await go(url, 'Passkey Test Site');
  assert.equal(await L.page(`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`), true);
  assert.equal(await L.page(`String(navigator.credentials.create)`), 'function create() { [native code] }');

  // Create: Lumio asks first.
  await L.page(`register(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'passkey'));
  const ask = await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText'));
  assert.match(ask, /Save a passkey for localhost\?[\s\S]*Sam Tester[\s\S]*sam@example\.com/);
  await L.wait(300);
  await shot('30-passkey-save');
  await overlayClick('[data-pk="ok"]');
  assert.ok(await until(() => L.page(`!!(window.state.reg || window.state.regError)`)));
  const reg = await L.page(`window.state.reg || window.state.regError`);
  assert.equal(typeof reg, 'object', String(reg));
  assert.deepEqual([reg.isPKC, reg.isAtt, reg.type, reg.attachment, reg.alg, reg.id === reg.rawId], [true, true, 'public-key', 'platform', -7, true]);
  assert.deepEqual(reg.ext, { credProps: { rk: true } });
  assert.equal(reg.json.response.attestationObject, reg.attestationObject);
  // What the site's server would check.
  const client = JSON.parse(Buffer.from(reg.clientDataJSON, 'base64url'));
  assert.deepEqual(client, { type: 'webauthn.create', challenge: reg.challenge, origin: `http://localhost:${site.address().port}`, crossOrigin: false });
  const [att] = cborDecode(Buffer.from(reg.attestationObject, 'base64url'));
  const authData = att.get('authData');
  assert.deepEqual(authData.subarray(0, 32), sha('localhost'));
  assert.equal(authData[32], 0x45, 'user present and verified');
  assert.deepEqual((await L.main(() => global.lumio.passwords.passkeys.list())).map((k) => [k.rpId, k.userName]), [['localhost', 'sam@example.com']]);

  // Sign in: pick the account, confirm, and the site gets a valid signature.
  await L.page(`login(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'passkey'));
  assert.match(await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText')), /Sign in to localhost[\s\S]*Sam Tester/);
  await shot('31-passkey-signin');
  await overlayClick('[data-pk="ok"]');
  assert.ok(await until(() => L.page(`!!(window.state.auth || window.state.authError)`)));
  const auth = await L.page(`window.state.auth || window.state.authError`);
  assert.equal(typeof auth, 'object', String(auth));
  assert.equal(auth.isAssert, true);
  assert.equal(auth.id, reg.id);
  assert.equal(auth.userHandle, 'user-42');
  const key = crypto.createPublicKey({ key: Buffer.from(reg.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const signed = Buffer.concat([Buffer.from(auth.authenticatorData, 'base64url'), sha(Buffer.from(auth.clientDataJSON, 'base64url'))]);
  assert.equal(crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, Buffer.from(auth.signature, 'base64url')), true, 'the site can verify the signature');
  assert.equal(JSON.parse(Buffer.from(auth.clientDataJSON, 'base64url')).challenge, auth.challenge);

  // Cancel: the page gets NotAllowedError; an aborted request closes the prompt.
  await L.page(`window.state.authError = null; window.state.auth = null; login(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'passkey'));
  await overlayClick('[data-pk="cancel"]');
  assert.ok(await until(() => L.page(`window.state.authError`)));
  assert.match(await L.page(`window.state.authError`), /^NotAllowedError/);
  await L.page(`loginAbort(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'passkey'));
  assert.equal(await until(() => L.page(`window.state.aborted`)), 'AbortError');
  assert.ok(await until(async () => (await overlayKind()) !== 'passkey'), 'the prompt closed');
  // The site asks for an account it already has: refused.
  await L.page(`window.state.regError = null; register(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'passkey'));
  await overlayClick('[data-pk="ok"]');
  assert.ok(await until(() => L.page(`window.state.regError || (window.state.reg && window.state.reg.id !== ${JSON.stringify(reg.id)})`)));
});

// ------------------------------------------------------------ account
test('account button signs in on the Lumio website and shows the plan', async () => {
  assert.equal(await L.shell(`!!document.querySelector('#account-btn .avatar')`), true);
  await L.shell(`document.getElementById('account-btn').click(); true`);
  assert.ok(await until(async () => (await overlayKind()) === 'account'));
  assert.match(await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText')), /Not signed in[\s\S]*Sign in to Lumio/);
  const tabsBefore = await L.main(() => global.lumio.tabs.tabs.length);
  await overlayClick('[data-acc="sign-in"]');
  // The website's own sign-in page opens in a tab; log in there as usual.
  await until(async () => (await title()) === 'Sign in · Lumio');
  assert.equal(await L.main(() => global.lumio.account.state().connecting), true);
  await L.page(`document.getElementById('continue').click(); true`);
  const state = await until(() => L.main(() => global.lumio.account.state().signedIn && global.lumio.account.state()), 15_000);
  // Signed in: the sign-in tab closes by itself.
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === tabsBefore), 'sign-in tab closed');
  assert.equal(state.email, 'tester@lumio.test');
  assert.equal(state.planName, 'Plus');
  assert.equal(state.paid, true);
  // The session token is stored encrypted, never in plain text.
  const token = [...lumio.sessions.keys()][0];
  await L.main(() => global.lumio.store.secretsFile.flush());
  assert.ok(!fs.readFileSync(path.join(L.userData, 'secrets.json'), 'utf8').includes(token));
  await until(() => L.shell(`document.querySelector('#account-btn .avatar').textContent === 'T'`));
  await L.shell(`document.getElementById('account-btn').click(); true`);
  await until(async () => (await overlayKind()) === 'account');
  await L.wait(300);
  const menu = await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText'));
  assert.match(menu, /Test Person[\s\S]*tester@lumio\.test[\s\S]*Lumio Plus[\s\S]*62% left[\s\S]*Upgrade/);
  await shot('20-account-menu');
  await L.shell(`window.lumio.send('overlay:hide'); true`);
});

test('settings show the plan, and Upgrade opens Lumio billing', async () => {
  await go('lumio://settings/#plan', 'Settings');
  await until(() => L.page(`document.querySelector('.plan-name')?.textContent === 'Lumio Plus'`));
  assert.match(await L.page(`document.getElementById('plan-card').innerText`), /Weekly usage[\s\S]*62% left · fully refilled by/);
  await shot('21-settings-plan');
  const before = await L.main(() => global.lumio.tabs.tabs.length);
  await L.page(`document.querySelector('[data-open=upgrade]').click(); true`);
  await until(async () => (await L.main(() => global.lumio.tabs.tabs.length)) === before + 1);
  assert.equal(await L.main(() => global.lumio.tabs.active.url), `${lumio.base}/account#plans`);
  await L.main(() => global.lumio.cmd.closeTab());
});

test('customizing the profile changes the avatar and theme', async () => {
  await go('lumio://settings/#profile', 'Settings');
  await L.page(`(() => { const i = document.getElementById('p-name'); i.value = 'Jordan'; i.dispatchEvent(new Event('input')); return true })()`);
  await until(async () => (await L.main(() => global.lumio.store.settings.profile.name)) === 'Jordan');
  await L.page(`document.querySelector('[data-theme=green]').click(); true`);
  await until(async () => (await L.main(() => global.lumio.store.settings.profile.theme)) === 'green');
  assert.ok(await until(() => L.shell(`document.querySelector('#account-btn .avatar').textContent === 'J'`)));
  assert.equal(await L.shell(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`), '#7ee2a8');
  await L.page(`document.querySelector('[data-theme=blue]').click(); true`);
});

test('signing out ends the Lumio session', async () => {
  await go('lumio://settings/', 'Settings');
  await L.page(`document.getElementById('sign-out').click(); true`);
  assert.ok(await until(async () => !(await L.main(() => global.lumio.account.state().signedIn))));
  assert.equal(lumio.sessions.size, 0, 'the server session was removed');
  const siteCookies = () => L.main(async (_e, u) => (await global.lumio.profiles.normal.session.cookies.get({ url: u, name: 'lumio_session' })).length, lumio.base);
  assert.ok(await until(async () => (await siteCookies()) === 0), 'the website cookie is gone too');
});

// ------------------------------------------------------------ passwords
test('offers to save a typed sign-in and stores it encrypted', async () => {
  await signInOnce('sam@test.example', 'Sup3r-secret!pw');
  assert.ok(await until(async () => (await overlayKind()) === 'pwsave'), 'save prompt');
  assert.equal(await L.shell(`!document.getElementById('pw-key').hidden`), true);
  await L.wait(300);
  await shot('22-save-password');
  await overlayClick('[data-decide=save]');
  const list = await until(async () => { const l = await saved(); return l.length === 1 && l; });
  assert.equal(list[0].username, 'sam@test.example');
  await L.main(() => global.lumio.passwords.store.file.flush());
  assert.ok(!fs.readFileSync(path.join(L.userData, 'passwords.json'), 'utf8').includes('Sup3r-secret'));
  assert.equal(await L.shell(`document.getElementById('pw-key').hidden`), true);
});

test('suggests the saved account and fills only after a choice', async () => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/login.html`);
  assert.ok(await until(async () => (await title()) === 'Test Login'));
  await clickEl('#user');
  assert.ok(await until(async () => (await overlayKind()) === 'autofill'), 'dropdown');
  await L.wait(300);
  await shot('23-autofill');
  assert.equal(await L.page(`document.getElementById('pass').value`), '', 'nothing filled yet');
  await overlayClick('[data-fill]');
  assert.ok(await until(() => L.page(`document.getElementById('pass').value === 'Sup3r-secret!pw' && document.getElementById('user').value === 'sam@test.example'`)));
  assert.ok((await saved())[0].lastUsed > 0);
  await L.main(() => global.lumio.cmd.closeTab());
});

test('a changed password is offered as an update; "Never" stops asking', async () => {
  await signInOnce('sam@test.example', 'N3w-secret!pw');
  assert.ok(await until(async () => (await overlayKind()) === 'pwsave'));
  assert.match(await L.main(() => global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText')), /Update password\?/);
  await overlayClick('[data-decide=save]');
  await until(async () => (await L.main(() => global.lumio.passwords.store.secret(global.lumio.passwords.store.entries[0].id))) === 'N3w-secret!pw');
  assert.equal((await saved()).length, 1);
  // A different account on the same site: choose Never.
  await signInOnce('other@test.example', 'Other-pass-99');
  assert.ok(await until(async () => (await overlayKind()) === 'pwsave'));
  await overlayClick('[data-decide=never]');
  await until(async () => (await L.main(() => global.lumio.passwords.store.never().length)) === 1);
  await signInOnce('third@test.example', 'Third-pass-99');
  await L.wait(1200);
  assert.notEqual(await overlayKind(), 'pwsave', 'no prompt on a never-save site');
  await L.main((_e, o) => global.lumio.passwords.store.removeNever(o), base);
});

test('sign-up forms get a strong suggested password that saves itself', async () => {
  await go(`${base}/signup.html`, 'Test Signup');
  await clickEl('#user'); await typeText('new@test.example');
  await clickEl('#pass');
  assert.ok(await until(async () => (await overlayKind()) === 'autofill'));
  await overlayClick('[data-gen]');
  const pw = await until(() => L.page(`(() => { const a = document.getElementById('pass').value; return a && a === document.getElementById('pass2').value && a })()`));
  assert.ok(pw.length >= 16);
  await clickEl('#go');
  assert.ok(await until(async () => (await saved()).some((e) => e.username === 'new@test.example')));
  assert.equal(await L.main((_e, p) => global.lumio.passwords.store.entries.some((e) => global.lumio.passwords.store.secret(e.id) === p), pw), true);
});

test('password manager page lists, reveals after confirming, and deletes', async () => {
  await go('lumio://passwords/', 'Passwords');
  await until(() => L.page(`document.querySelectorAll('.pw-item').length === 2`));
  await L.page(`document.querySelector('.pw-item').click(); true`);
  await until(() => L.page(`!!document.querySelector('[data-act=reveal]')`));
  assert.ok(!(await L.page('document.body.innerText')).includes('N3w-secret'), 'hidden until revealed');
  await L.page(`document.querySelector('[data-act=reveal]').click(); true`);
  assert.ok(await until(async () => /N3w-secret!pw|[A-Za-z0-9_!@#%*?-]{18}/.test(await L.page(`document.querySelector('.kv .text.mono').textContent`))));
  await shot('24-password-manager');
  await L.page(`window.confirm = () => true; document.querySelector('[data-act=delete]').click(); true`);
  assert.ok(await until(async () => (await saved()).length === 1));
});

test('suggestions can be turned off', async () => {
  await L.main(() => global.lumio.store.setSetting('autofillPasswords', false));
  await go(`${base}/login.html`, 'Test Login');
  await clickEl('#user');
  await L.wait(800);
  assert.notEqual(await overlayKind(), 'autofill');
  await L.main(() => global.lumio.store.setSetting('autofillPasswords', true));
});

// ------------------------------------------------------------ AI on the Lumio plan
async function signInQuietly() {
  await L.main(() => global.lumio.signIn());
  await until(async () => (await title()) === 'Sign in · Lumio');
  await L.page(`document.getElementById('continue').click(); true`);
  assert.ok(await until(() => L.main(() => global.lumio.account.state().signedIn), 15_000));
}
const ask = async (text) => {
  await L.shell(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('send').click(); return true })()`);
  await until(() => L.main(() => global.lumio.ai.isRunning()), 3000);
  await until(async () => !(await L.main(() => global.lumio.ai.isRunning())), 20_000);
};

test('signed in on Plus, the AI runs on the Lumio plan', async () => {
  await L.main(() => global.lumio.tabs.create('lumio://newtab/'));
  await signInQuietly();
  const st = await until(() => L.main(() => global.lumio.ai.state().ready && global.lumio.ai.state()));
  assert.equal(st.lumio.planName, 'Plus');
  await L.shell(`document.getElementById('newchat-btn').click(); true`);
  await ask('hello');
  assert.match(await L.shell(`[...document.querySelectorAll('.msg.ai')].at(-1)?.innerText || ''`), /mock model/);
  const req = lumio.state.agentRequests.at(-1);
  assert.equal(req.model, 'mock/agent-1');
  assert.equal(req.reasoning, 'medium');
  assert.ok(req.tools.includes('read_page') && !req.tools.some((t) => t.startsWith('mac_')));
  assert.equal(req.context.platform, 'mac');
  assert.ok(!req.messages.some((m) => m.role === 'system'), 'the server owns the system prompt');
  await shot('25-lumio-plan-chat');
});

test('tool steps on the Lumio plan share one run and number their steps', async () => {
  lumio.state.agentScript = (body) => (body.stepId === 's1'
    ? [{ type: 'tool_call', tool_call: { id: 'call_a', type: 'function', function: { name: 'list_tabs', arguments: '{}' } } },
      { type: 'result', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'list_tabs', arguments: '{}' } }] }, finishReason: 'tool_calls', usage: null }]
    : [{ type: 'delta', content: 'You have tabs open.' }, { type: 'result', message: { role: 'assistant', content: 'You have tabs open.' }, finishReason: 'stop', usage: null }]);
  const before = lumio.state.agentRequests.length;
  await ask('what tabs are open?');
  const reqs = lumio.state.agentRequests.slice(before);
  assert.deepEqual(reqs.map((r) => r.stepId), ['s1', 's2']);
  assert.equal(reqs[0].runId, reqs[1].runId);
  assert.equal(reqs[0].taskId, reqs[1].taskId);
  assert.equal(reqs[1].messages.at(-1).role, 'tool');
  assert.match(reqs[1].messages.at(-1).content, /\[\d+\]/);
  assert.match(await L.shell(`[...document.querySelectorAll('.msg.ai')].at(-1)?.innerText || ''`), /You have tabs open/);
  lumio.state.agentScript = null;
});

test('the Free plan runs the AI too; signed out, the panel asks to sign in', async () => {
  lumio.state.plan = 'free';
  await L.main(() => global.lumio.account.refresh());
  assert.ok(await until(async () => (await L.main(() => global.lumio.account.state().planName)) === 'Free'));
  assert.equal(await L.main(() => global.lumio.ai.state().ready), true);
  await L.shell(`document.getElementById('newchat-btn').click(); true`);
  await ask('hello');
  assert.match(await L.shell(`[...document.querySelectorAll('.msg.ai')].at(-1)?.innerText || ''`), /mock model/);
  await L.main(() => global.lumio.account.signOut());
  await L.shell(`document.getElementById('newchat-btn').click(); true`);
  assert.ok(await until(() => L.shell(`document.querySelector('#messages .empty h2')?.textContent === 'Sign in to use Lumio AI'`)));
  await shot('26-signed-out-panel');
  lumio.state.plan = 'plus';
});
