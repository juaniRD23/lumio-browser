// The sign-in page's email steps (website/public/signin.*) in headless Chrome:
// create an account and confirm it with the code, sign in, a sign-up that
// still needs its code, and a forgotten password. The server is a stand-in
// that answers /api/auth/email/* the way docs/email-accounts.md says, so this
// checks the page alone. Skipped without Google Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const PUBLIC = fileURLToPath(new URL('../website/public/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// The stand-in server. Every email it "sends" has this code.
const CODE = '123456';
const ERRORS = {
  invalid_code: [400, 'That code didn’t work. Check the latest email from Lumio, or send a new code.'],
  invalid_credentials: [401, 'Email or password is incorrect.'],
};
const safeNext = (next) => (next && /^\/(?!\/)[\w\-./?=&#%]*$/.test(next) ? next : '/account');
let users;     // email -> password
let pending;   // email -> password of a sign-up waiting for its code
let calls;     // what the page sent: { action, body, origin, type }
let visits;    // pages a sign-in went on to: { path, cookie }
let gate = null; // a promise the email routes wait for, to catch the page mid-request

function api(action, b) {
  const fail = (code) => ({ status: ERRORS[code][0], body: { error: ERRORS[code][1], code } });
  const signedIn = () => ({ status: 200, body: { ok: true, next: safeNext(b.next), account: { signedIn: true, authMethod: 'email', email: b.email } }, cookie: true });
  switch (action) {
    case 'signup': pending.set(b.email, b.password); return { status: 200, body: { ok: true } };
    case 'resend': case 'forgot': return { status: 200, body: { ok: true } };
    case 'confirm':
      if (b.code !== CODE || pending.get(b.email) !== b.password) return fail('invalid_code');
      pending.delete(b.email);
      users.set(b.email, b.password);
      return signedIn();
    case 'signin':
      if (users.get(b.email) === b.password) return signedIn();
      if (pending.get(b.email) === b.password) return { status: 200, body: { needsCode: true } };
      return fail('invalid_credentials');
    case 'reset':
      if (b.code !== CODE || !users.has(b.email)) return fail('invalid_code');
      users.set(b.email, b.password);
      return signedIn();
    default: return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
  }
}

let server, base, browser;
before(async () => {
  if (!CHROME) return;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const route = /^\/api\/auth\/email\/(\w+)$/.exec(url.pathname);
    if (route && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      calls.push({ action: route[1], body: JSON.parse(raw), origin: req.headers.origin, type: req.headers['content-type'] });
      await gate;
      const r = api(route[1], calls.at(-1).body);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.cookie ? { 'set-cookie': 'lumio_session=t0k3n; Path=/; HttpOnly; SameSite=Lax' } : {}) });
      res.end(JSON.stringify(r.body));
      return;
    }
    if (url.pathname === '/api/account') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ signedIn: /lumio_session=/.test(req.headers.cookie || '') }));
      return;
    }
    if (url.pathname === '/signin' || path.extname(url.pathname)) {
      const file = path.join(PUBLIC, url.pathname === '/signin' ? 'signin.html' : url.pathname.slice(1));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
      return;
    }
    // Anywhere a sign-in goes on to (/account, /api/auth/app/finish…): a stand-in page.
    visits.push({ path: url.pathname + url.search, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Next</title><p>Next</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// A fresh browser and stand-in server state; nothing leaves this machine (fonts included).
async function open(pathAndQuery, { viewport = { width: 1100, height: 900 }, signedIn = false } = {}) {
  users = new Map();
  pending = new Map();
  calls = [];
  visits = [];
  const ctx = await browser.newContext({ viewport });
  await ctx.route((u) => !u.href.startsWith(base), (r) => r.abort());
  if (signedIn) await ctx.addCookies([{ name: 'lumio_session', value: 'old', url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + pathAndQuery);
  return { ctx, page, errors };
}
const shown = (page) => page.$$eval('.signin-step', (steps) => steps.filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.dataset.step));
const onStep = (page, name) => page.waitForSelector(`.signin-step[data-step="${name}"]:not([hidden])`);
const said = (page, id, text) => page.waitForFunction(([id, text]) => { const n = document.getElementById(id); return !n.hidden && n.textContent === text; }, [id, text], { timeout: 5000 });
const submit = (page, step) => page.click(`.signin-step[data-step="${step}"] button[type=submit]`);

test('creating an account: the code from the email confirms it, signs in and goes on to next', { skip, timeout: 30_000 }, async () => {
  const next = '/api/auth/app/finish?challenge=' + 'A'.repeat(43);
  const { ctx, page, errors } = await open(`/signin?mode=create&next=${encodeURIComponent(next)}`);
  assert.deepEqual(await shown(page), ['create']);
  assert.equal(await page.textContent('.signin-step[data-step="create"] h1'), 'Create your account');
  assert.deepEqual(await page.$$eval('.google-btn', (as) => as.map((a) => a.getAttribute('href'))), Array(2).fill(`/api/auth/google/start?next=${encodeURIComponent(next)}`));

  // The server's rules, before anything is sent.
  await page.fill('#create-email', 'sam@example');
  await page.fill('#create-password', 'correct horse 1');
  await submit(page, 'create');
  await said(page, 'error', 'Enter a valid email address.');
  await page.fill('#create-email', '  Sam@Example.COM ');
  await page.fill('#create-password', 'short');
  await submit(page, 'create');
  await said(page, 'error', 'Use a password with 8 to 128 characters.');
  assert.deepEqual(calls, []);

  await page.fill('#create-password', 'correct horse 1');
  await submit(page, 'create');
  await onStep(page, 'code');
  assert.deepEqual(calls.map((c) => [c.action, c.body, c.origin, c.type]), [['signup', { email: 'sam@example.com', password: 'correct horse 1', client: 'web', next }, base, 'application/json']]);
  assert.equal(await page.textContent('.signin-step[data-step="code"] .lead'), 'Enter the 6-digit code we sent to sam@example.com. It works for 15 minutes.');
  assert.equal(await page.isHidden('#error'), true, 'a new step clears the notices');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'code-code');
  assert.deepEqual(await page.$eval('#code-code', (i) => [i.autocomplete, i.inputMode, i.maxLength]), ['one-time-code', 'numeric', 7]);

  await page.click('.signin-step[data-step="code"] [data-again]');
  await said(page, 'notice', 'We sent a new code to sam@example.com.');
  assert.deepEqual(calls.at(-1).body, { email: 'sam@example.com', client: 'web', next });

  await page.fill('#code-code', '12345');
  await submit(page, 'code');
  await said(page, 'error', 'Enter the 6-digit code from the email.');
  assert.equal(await page.isHidden('#notice'), true, 'one message at a time');
  await page.fill('#code-code', '000000');
  await submit(page, 'code');
  await said(page, 'error', ERRORS.invalid_code[1]);

  // Spaces and hyphens are fine; the password from Create account goes with the code.
  await page.fill('#code-code', '123 456');
  await submit(page, 'code');
  await page.waitForURL(base + next);
  assert.deepEqual(calls.at(-1), { action: 'confirm', body: { email: 'sam@example.com', code: CODE, password: 'correct horse 1', client: 'web', next }, origin: base, type: 'application/json' });
  assert.deepEqual(visits, [{ path: next, cookie: 'lumio_session=t0k3n' }], 'a real navigation, with the new session cookie (the apps’ hand-off)');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('signing in: a wrong password says so, the right one goes to the account; an unconfirmed sign-up gets a new code', { skip, timeout: 30_000 }, async () => {
  let { ctx, page, errors } = await open('/signin');
  users.set('ada@example.com', 'right password');
  assert.deepEqual(await shown(page), ['signin']);
  assert.equal(await page.getAttribute('.google-btn', 'href'), '/api/auth/google/start');
  assert.deepEqual(await page.$$eval('.signin-step[data-step="signin"] input', (is) => is.map((i) => [i.type, i.autocomplete])), [['email', 'email'], ['password', 'current-password']]);

  await page.fill('#signin-email', 'ada@example.com');
  await page.fill('#signin-password', 'wrong password');
  await submit(page, 'signin');
  await said(page, 'error', 'Email or password is incorrect.');
  assert.deepEqual(calls.map((c) => c.body), [{ email: 'ada@example.com', password: 'wrong password', client: 'web' }], 'no next when the page has none');

  // Over to Create an account and back: the email comes along, the message doesn't.
  await page.click('.signin-step[data-step="signin"] [data-go="create"]');
  await onStep(page, 'create');
  assert.equal(await page.inputValue('#create-email'), 'ada@example.com');
  assert.equal(await page.isHidden('#error'), true);
  await page.click('.signin-step[data-step="create"] [data-go="signin"]');
  await onStep(page, 'signin');
  assert.equal(await page.inputValue('#signin-email'), 'ada@example.com');
  await page.fill('#signin-password', 'right password');
  await submit(page, 'signin');
  await page.waitForURL(base + '/account');
  assert.deepEqual(errors, []);
  await ctx.close();

  // Signed up but never confirmed: the code step, and confirming uses the password just typed.
  ({ ctx, page, errors } = await open('/signin'));
  pending.set('bo@example.com', 'bo password 1');
  await page.fill('#signin-email', 'bo@example.com');
  await page.fill('#signin-password', 'bo password 1');
  await submit(page, 'signin');
  await onStep(page, 'code');
  await said(page, 'notice', 'Confirm your email to finish signing up. We sent you a new code.');
  await page.fill('#code-code', CODE);
  await submit(page, 'code');
  await page.waitForURL(base + '/account');
  assert.deepEqual(calls.at(-1).body, { email: 'bo@example.com', code: CODE, password: 'bo password 1', client: 'web' });
  assert.equal(users.get('bo@example.com'), 'bo password 1');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a forgotten password: a code, then a new password signs in', { skip, timeout: 30_000 }, async () => {
  const { ctx, page, errors } = await open('/signin');
  users.set('cy@example.com', 'old password');
  await page.fill('#signin-email', 'Cy@Example.com');
  await page.click('.signin-step[data-step="signin"] [data-go="forgot"]');
  await onStep(page, 'forgot');
  assert.equal(await page.inputValue('#forgot-email'), 'Cy@Example.com', 'as typed');
  await submit(page, 'forgot');
  await onStep(page, 'reset');
  assert.deepEqual(calls.map((c) => [c.action, c.body]), [['forgot', { email: 'cy@example.com', client: 'web' }]]);
  assert.equal(await page.textContent('.signin-step[data-step="reset"] .lead'), 'If cy@example.com has a Lumio account, we sent it a 6-digit code. Enter it with a new password. You’ll be signed out everywhere else.');
  // Password managers learn whose password this is.
  assert.deepEqual(await page.$eval('.pm-user', (i) => [i.value, i.autocomplete]), ['cy@example.com', 'username']);

  await page.click('.signin-step[data-step="reset"] [data-again]');
  await said(page, 'notice', 'If cy@example.com has a Lumio account, we sent a new code.');
  assert.equal(calls.at(-1).action, 'forgot');

  await page.fill('#reset-code', '123-456');
  await page.fill('#reset-password', 'short');
  await submit(page, 'reset');
  await said(page, 'error', 'Use a password with 8 to 128 characters.');
  assert.equal(calls.length, 2);

  // The button is off while the request runs.
  let release;
  gate = new Promise((r) => { release = r; });
  await page.fill('#reset-password', 'new password 1');
  await submit(page, 'reset');
  await page.waitForFunction(() => document.querySelector('.signin-step[data-step="reset"] button[type=submit]').disabled);
  release();
  gate = null;
  await page.waitForURL(base + '/account');
  assert.deepEqual(calls.at(-1), { action: 'reset', body: { email: 'cy@example.com', code: CODE, password: 'new password 1', client: 'web' }, origin: base, type: 'application/json' });
  assert.equal(users.get('cy@example.com'), 'new password 1');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the page: ?mode=forgot, only paths on this site for next, Google’s errors, signed in already, offline, and a phone', { skip, timeout: 30_000 }, async () => {
  let { ctx, page, errors } = await open('/signin?mode=forgot');
  assert.deepEqual(await shown(page), ['forgot']);
  await ctx.close();

  // Not to another site, whatever the next says.
  for (const next of ['//evil.example/', '/\\evil.example', 'https://evil.example/']) {
    ({ ctx, page } = await open(`/signin?next=${encodeURIComponent(next)}`));
    assert.equal(await page.getAttribute('.google-btn', 'href'), '/api/auth/google/start', next);
    await ctx.close();
  }
  ({ ctx, page } = await open('/signin?next=%2F%2Fevil.example%2F', { signedIn: true }));
  await page.waitForURL(base + '/account');
  await ctx.close();
  ({ ctx, page } = await open('/signin?next=%2Fchat', { signedIn: true }));
  await page.waitForURL(base + '/chat');
  await ctx.close();
  // Signed in, but a step was asked for: stay.
  ({ ctx, page } = await open('/signin?mode=create', { signedIn: true }));
  await page.waitForTimeout(300);
  assert.equal(new URL(page.url()).pathname, '/signin');
  assert.deepEqual(await shown(page), ['create']);
  await ctx.close();

  ({ ctx, page } = await open('/signin?error=cancelled'));
  await said(page, 'error', 'Sign-in was cancelled.');
  await ctx.close();

  ({ ctx, page, errors } = await open('/signin'));
  await page.route('**/api/auth/email/signin', (r) => r.abort());
  await page.fill('#signin-email', 'ada@example.com');
  await page.fill('#signin-password', 'anything at all');
  await page.press('#signin-password', 'Enter');
  await said(page, 'error', 'Lumio couldn’t be reached. Check your connection and try again.');
  assert.deepEqual(errors, []);
  await ctx.close();

  // A phone: no sideways scrolling, and 16px fields so iOS doesn't zoom in.
  ({ ctx, page, errors } = await open('/signin', { viewport: { width: 375, height: 740 } }));
  const fits = async (step) => {
    await onStep(page, step);
    assert.deepEqual(await shown(page), [step]);
    assert.ok(await page.$eval('.signin-card', (c) => c.getBoundingClientRect().right <= 375 && c.scrollWidth <= c.clientWidth && document.documentElement.scrollWidth <= 375), step);
    assert.deepEqual(await page.$$eval(`.signin-step[data-step="${step}"] .field input`, (is) => [...new Set(is.map((i) => getComputedStyle(i).fontSize))]), ['16px'], step);
  };
  await fits('signin');
  await page.click('.signin-step[data-step="signin"] [data-go="create"]');
  await fits('create');
  await page.click('.signin-step[data-step="create"] [data-go="signin"]');
  await page.click('.signin-step[data-step="signin"] [data-go="forgot"]');
  await page.fill('#forgot-email', 'cy@example.com');
  await submit(page, 'forgot');
  await fits('reset');
  assert.deepEqual(errors, []);
  await ctx.close();
});
