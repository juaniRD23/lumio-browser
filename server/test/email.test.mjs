// Email + password accounts (src/email-auth.ts, docs/email-accounts.md): a
// code by email to sign up, sign-in, forgotten passwords, the limits, and one
// account across Google, Apple and email. D1 is simulated on node:sqlite;
// Resend, Google and Apple are stand-ins.
// Run: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { emailCleanup, newCode, normalizeEmail } from '../src/email-auth.ts';
import { DUMMY_HASH, PBKDF2_ITERATIONS, hashPassword, verifyPassword } from '../src/password.ts';
import { timingSafeEqual } from '../src/util.ts';

const SITE = 'https://lumio.test';
const RESEND = 'https://resend.test/emails';
const GOOGLE_TOKEN = 'https://google.test/token';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const APPLE_KEYS = 'https://apple.test/auth/keys';
const APP_ID = 'online.lumio-usa.lumio';
const IP = '203.0.113.7';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HASH = /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const PW = 'correct horse';
// The Worker secret that keys the codes' hashes (a stand-in, made for this run).
const CODE_KEY = crypto.randomBytes(32).toString('base64');

const ERR = {
  request: { error: 'That didn’t work. Try again.', code: 'invalid_request' },
  email: { error: 'Enter a valid email address.', code: 'invalid_email' },
  password: { error: 'Use a password with 8 to 128 characters.', code: 'invalid_password' },
  code: { error: 'That code didn’t work. Check the latest email from Lumio, or send a new code.', code: 'invalid_code' },
  credentials: { error: 'Email or password is incorrect.', code: 'invalid_credentials' },
  forbidden: { error: 'Not allowed.', code: 'forbidden' },
  limited: { error: 'Too many tries. Wait a few minutes and try again.', code: 'rate_limited' },
  failed: { error: 'Lumio couldn’t send the email. Try again in a minute.', code: 'email_failed' },
  unavailable: { error: 'Email sign-in isn’t available yet. Use another way to sign in for now.', code: 'email_unavailable' },
};

let sql, env, calls, pending, google, resendDown;

function d1(db) {
  return {
    prepare(query) {
      let values = [];
      const stmt = {
        bind(...args) { values = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async first() { return db.prepare(query).get(...values) ?? null; },
        async all() { return { results: db.prepare(query).all(...values) }; },
        async run() { const r = db.prepare(query).run(...values); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
      return stmt;
    },
    // Like D1: the statements run together in one transaction.
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const hex256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const codeMac = (text) => crypto.createHmac('sha256', Buffer.from(CODE_KEY, 'base64')).update(text).digest('hex');

// Apple's signing key (a stand-in), made once.
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const appleJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k-email-test', alg: 'RS256', use: 'sig' };

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = {
    DB: d1(sql),
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'google-secret', GOOGLE_AUTH_URL: 'https://google.test/auth', GOOGLE_TOKEN_URL: GOOGLE_TOKEN,
    APPLE_KEYS_URL: APPLE_KEYS,
    RESEND_API_KEY: 're_test_key', RESEND_API_URL: RESEND, EMAIL_FROM: 'Lumio <no-reply@lumio-co.online>',
    CODE_KEY,
  };
  calls = { email: [], resendTries: 0 };
  pending = [];
  resendDown = false;
  // What Google says about each test person (by the code its sign-in page sends back).
  google = {
    sam: { sub: 'g-111', email: 'Sam@Example.com', name: 'Sam Tester' },
    lee: { sub: 'g-222', email: 'lee@example.com', name: 'Lee' },
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === RESEND) {
      calls.resendTries++;
      if (resendDown === 'network') throw new TypeError('fetch failed');
      if (resendDown) return Response.json({ statusCode: 500, message: 'Resend is down' }, { status: 500 });
      calls.email.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      return Response.json({ id: 'em_' + calls.email.length });
    }
    if (u === GOOGLE_TOKEN) {
      const who = google[new URLSearchParams(String(opts.body)).get('code')];
      if (!who) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...who }) });
    }
    if (u === APPLE_KEYS) return Response.json({ keys: [appleJwk] });
    return new Response('nope', { status: 404 });
  };
});

const ctx = { waitUntil: (p) => pending.push(p) };
const settled = async () => { await Promise.all(pending); pending = []; };
function call(path, { cookie, token, method = 'GET', body, origin = SITE, ip = IP } = {}) {
  return worker.fetch(new Request(SITE + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie: `__Host-lumio_session=${cookie}` } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(origin && method !== 'GET' ? { origin } : {}),
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env, ctx);
}
// The website's fetches (its own Origin), and the iPhone and iPad app's (no Origin, "client": "app").
const post = (action, body, opts = {}) => call(`/api/auth/email/${action}`, { method: 'POST', body, ...opts });
const app = (action, body, opts = {}) => post(action, { ...body, client: 'app' }, { origin: undefined, ...opts });
// The code in the latest email to `to`.
const codeFor = (to) => /\b(\d{6})\b/.exec(calls.email.filter((m) => m.body.to.includes(to)).at(-1).body.text)[1];
const cookieOf = (res) => /__Host-lumio_session=([a-f0-9]{64}); Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/.exec(res.headers.get('set-cookie') || '')?.[1];
const me = async (opts) => (await call('/api/account', opts)).json();
const count = (table, where = '1', ...args) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
const userRow = () => sql.prepare('SELECT * FROM users').get();
const emailHashOf = (email) => hex256(`lumio-email|${email}`);
const signinAttempts = (email) => count('auth_attempts', "kind = 'signin' AND email_hash = ?", emailHashOf(email));
const answer = async (res) => [res.status, await res.json()];

// Signs up and confirms (on the website); the cookie and the reply.
async function signUp(email, password = PW) {
  assert.deepEqual(await answer(await post('signup', { email, password })), [200, { ok: true }]);
  const res = await post('confirm', { email, code: codeFor(email), password });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return { cookie: cookieOf(res), reply: await res.json() };
}
// Signs in with Google (website); the session cookie.
async function googleSignIn(who) {
  const start = await call('/api/auth/google/start?next=/chat');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const back = await call(`/api/auth/google/callback?code=${who}&state=${state}`);
  assert.equal(back.headers.get('location'), '/chat');
  return cookieOf(back);
}
// Sign in with Apple, from the app.
let nonces = 0;
async function appleSignIn(claims) {
  const nonce = `nonce-${String(++nonces).padStart(4, '0')}-${'x'.repeat(24)}`;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: appleJwk.kid });
  const body = enc({ iss: 'https://appleid.apple.com', aud: APP_ID, exp: now + 600, iat: now, email_verified: 'true', nonce: hex256(nonce), ...claims });
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`))).toString('base64url');
  const res = await call('/api/auth/apple', { method: 'POST', body: { identityToken: `${head}.${body}.${sig}`, nonce }, origin: undefined });
  assert.equal(res.status, 200);
  return res.json();
}

// ---------------------------------------------------------------- sign-up
test('sign-up: a code by email; confirming it makes the account and signs in on the website', async () => {
  const res = await post('signup', { email: '  Mia@Example.COM ', password: PW });
  assert.deepEqual(await answer(res), [200, { ok: true }]);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(count('users'), 0, 'a sign-up isn’t an account until it’s confirmed');
  // The email, through Resend.
  assert.equal(calls.email.length, 1);
  const mail = calls.email[0];
  const code = codeFor('mia@example.com');
  assert.deepEqual(mail.headers, { authorization: 'Bearer re_test_key', 'content-type': 'application/json' });
  assert.deepEqual([mail.body.from, mail.body.to, mail.body.subject], ['Lumio <no-reply@lumio-co.online>', ['mia@example.com'], `${code} is your Lumio code`]);
  assert.equal(mail.body.reply_to, 'support@lumio-co.online', 'a reply reaches support, not no-reply');
  assert.equal(mail.body.text, `Your Lumio code is ${code}\n\nEnter it to confirm your email and finish signing in. It works for 15 minutes.\n\nIf you didn’t try to sign up for Lumio, you can ignore this email. Don’t share this code: anyone who has it can sign in to Lumio with your email address.\n\nLumio`);
  assert.equal(mail.body.text.match(/\d{6}/g).length, 1, 'the code once, and no other 6 digits');
  assert.ok(mail.body.html.includes(`<p style="margin:0 0 12px;font-size:16px;font-weight:600">Your Lumio code is</p>`));
  assert.ok(mail.body.html.includes(`letter-spacing:6px;font-weight:600">${code}</p>`));
  // Stored: the code only as a hash keyed with CODE_KEY (so the table alone can't give it away), the password only as PBKDF2.
  const row = sql.prepare('SELECT * FROM email_codes').get();
  assert.deepEqual([row.email, row.purpose, row.tries], ['mia@example.com', 'signup', 0]);
  assert.equal(row.code_hash, codeMac(`lumio-code|signup|mia@example.com|${code}`));
  assert.notEqual(row.code_hash, hex256(`lumio-code|signup|mia@example.com|${code}`));
  assert.match(row.password_hash, HASH);
  assert.ok(Math.abs(row.expires_at - (Date.now() + 15 * MINUTE)) < 5000, 'works 15 minutes');
  assert.ok(!JSON.stringify(row).includes(code) && !JSON.stringify(row).includes(PW));

  // Confirmed (the code typed with a space): signed in with the cookie, and sent on to `next`.
  const ok = await post('confirm', { email: 'mia@example.com', code: `${code.slice(0, 3)} ${code.slice(3)}`, password: PW, next: '/chat' });
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.ok(cookie, ok.headers.get('set-cookie'));
  const reply = await ok.json();
  assert.deepEqual(Object.keys(reply).sort(), ['account', 'next', 'ok']);
  assert.deepEqual([reply.ok, reply.next], [true, '/chat']);
  assert.ok(!JSON.stringify(reply).includes(cookie), 'the token is only in the cookie');
  const { account } = reply;
  assert.deepEqual([account.signedIn, account.authMethod, account.email, account.profile, account.plan.id], [true, 'email', 'mia@example.com', { name: null, picture: null }, 'free']);
  const user = userRow();
  assert.equal(user.id, account.ownerId);
  assert.equal(user.google_sub, `email:${user.id}`);
  assert.equal(user.email, 'mia@example.com');
  assert.match(user.password_hash, HASH);
  // PBKDF2-SHA256 of the password with its salt (checked with Node's own).
  const [, , salt, hash] = user.password_hash.split('$');
  assert.equal(crypto.pbkdf2Sync(PW, Buffer.from(salt, 'base64url'), 100000, 32, 'sha256').toString('base64url'), hash);
  assert.ok(!JSON.stringify(reply).includes(user.password_hash) && !JSON.stringify(reply).includes('password'), 'the hash is never sent');
  assert.equal(count('email_codes'), 0);
  const signedIn = await me({ cookie });
  assert.deepEqual([signedIn.ownerId, signedIn.authMethod], [user.id, 'email']);
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM sessions').all()).includes(cookie), 'only a hash of the session is stored');
  const session = sql.prepare('SELECT * FROM sessions').get();
  assert.ok(Math.abs(session.expires_at - session.created_at - 30 * DAY) < 1000, '30 days, like every session');
  // A code works once.
  assert.deepEqual(await answer(await post('confirm', { email: 'mia@example.com', code, password: PW })), [400, ERR.code]);
  // Without `next`, or with one that leaves the site: the account page.
  await post('signup', { email: 'mia2@example.com', password: PW });
  assert.equal((await (await post('confirm', { email: 'mia2@example.com', code: codeFor('mia2@example.com'), password: PW, next: '//evil.example/x' })).json()).next, '/account');
});

test('Lumio for iPhone and iPad: "client": "app" gets { token, account } and no cookie, for confirm, sign-in and reset', async () => {
  assert.deepEqual(await answer(await app('signup', { email: 'ana@example.com', password: PW })), [200, { ok: true }]);
  const tokenReply = async (res) => {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
    const reply = await res.json();
    assert.deepEqual(Object.keys(reply).sort(), ['account', 'token']);
    assert.match(reply.token, /^[a-f0-9]{64}$/);
    assert.equal((await me({ token: reply.token })).ownerId, reply.account.ownerId, 'the token works as a bearer token');
    return reply;
  };
  const made = await tokenReply(await app('confirm', { email: 'ana@example.com', code: codeFor('ana@example.com'), password: PW, next: '/chat' }));
  assert.deepEqual([made.account.authMethod, made.account.email], ['email', 'ana@example.com']);
  const signedIn = await tokenReply(await app('signin', { email: 'ana@example.com', password: PW }));
  assert.equal(signedIn.account.ownerId, made.account.ownerId);
  assert.deepEqual(await answer(await app('forgot', { email: 'ana@example.com' })), [200, { ok: true }]);
  await settled();
  const reset = await tokenReply(await app('reset', { email: 'ana@example.com', code: codeFor('ana@example.com'), password: 'new horse 2' }));
  assert.equal(reset.account.ownerId, made.account.ownerId);
  assert.equal((await me({ token: made.token })).signedIn, false, 'the reset ended the other sessions');
  // A wrong password from the app: the same answer as on the website, and the app's session stays.
  assert.deepEqual(await answer(await app('signin', { email: 'ana@example.com', password: PW })), [401, ERR.credentials]);
  assert.equal((await me({ token: reset.token })).signedIn, true);
});

test('codes: 5 tries, 15 minutes, a day for a sign-up; the wrong password at confirm is just a wrong code', async () => {
  await post('signup', { email: 'lee@example.com', password: PW });
  const code = codeFor('lee@example.com');
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  const confirm = (c, password = PW) => post('confirm', { email: 'lee@example.com', code: c, password });
  const tries = () => sql.prepare('SELECT tries FROM email_codes').get().tries;
  // Not a code at all: refused before a try is used.
  for (const c of ['12345', '1234567', 'abcdef', '12 34 5', 123456, null]) assert.deepEqual(await answer(await confirm(c)), [400, ERR.code], String(c));
  assert.deepEqual(await answer(await confirm(code, 12345678)), [400, ERR.request], 'the password must be a string');
  assert.equal(tries(), 0);
  // The right code with the wrong password: the same answer, and a try used.
  assert.deepEqual(await answer(await confirm(code, 'wrong horse')), [400, ERR.code]);
  assert.equal(tries(), 1);
  for (let i = 0; i < 4; i++) assert.deepEqual(await answer(await confirm(wrong)), [400, ERR.code]);
  assert.equal(tries(), 5);
  // Five tries used: even the right code is dead now.
  assert.deepEqual(await answer(await confirm(code)), [400, ERR.code]);
  assert.equal(tries(), 5);
  assert.equal(count('users'), 0);
  // A new code (resend) starts over.
  await post('resend', { email: 'lee@example.com' });
  await settled();
  const fresh = codeFor('lee@example.com');
  assert.equal(tries(), 0);
  // Expired.
  sql.prepare('UPDATE email_codes SET expires_at = ?').run(Date.now() - 1);
  assert.deepEqual(await answer(await confirm(fresh)), [400, ERR.code]);
  // A sign-up older than a day, even with a code that hasn't expired.
  sql.prepare('UPDATE email_codes SET expires_at = ?, created_at = ?, tries = 0').run(Date.now() + MINUTE, Date.now() - DAY - 1);
  assert.deepEqual(await answer(await confirm(fresh)), [400, ERR.code]);
  // No sign-up at all.
  assert.deepEqual(await answer(await post('confirm', { email: 'nobody@example.com', code: fresh, password: PW })), [400, ERR.code]);
  // Within the time and the tries, typed with a hyphen: it works.
  sql.prepare('UPDATE email_codes SET created_at = ?, tries = 0').run(Date.now());
  assert.equal((await confirm(`${fresh.slice(0, 3)}-${fresh.slice(3)}`)).status, 200);
  assert.equal(count('users'), 1);
});

test('resend: a new code for a sign-up waiting to be confirmed (the old one stops working); nothing for anyone else', async () => {
  await post('signup', { email: 'lee@example.com', password: PW });
  const first = codeFor('lee@example.com');
  assert.deepEqual(await answer(await post('resend', { email: ' LEE@example.com' })), [200, { ok: true }]);
  await settled();
  assert.equal(calls.email.length, 2);
  const second = codeFor('lee@example.com');
  assert.equal(calls.email[1].body.subject, `${second} is your Lumio code`);
  if (first !== second) assert.deepEqual(await answer(await post('confirm', { email: 'lee@example.com', code: first, password: PW })), [400, ERR.code]);
  // No sign-up for that email: the same answer, and no email.
  assert.deepEqual(await answer(await post('resend', { email: 'nobody@example.com' })), [200, { ok: true }]);
  await settled();
  assert.equal(calls.email.length, 2);
  assert.equal((await post('confirm', { email: 'lee@example.com', code: second, password: PW })).status, 200);
  // Confirmed: there's nothing to resend.
  assert.deepEqual(await answer(await post('resend', { email: 'lee@example.com' })), [200, { ok: true }]);
  await settled();
  assert.equal(calls.email.length, 2);
});

// ---------------------------------------------------------------- sign-in
test('sign-in: the right password signs in; a wrong one or an unknown email gets the same answer', async () => {
  const { reply } = await signUp('sam@example.com');
  const wrong = await post('signin', { email: 'sam@example.com', password: 'wrong horse' });
  const unknown = await post('signin', { email: 'nobody@example.com', password: PW });
  const short = await post('signin', { email: 'sam@example.com', password: 'x' });
  const padded = await post('signin', { email: 'sam@example.com', password: ` ${PW}` });
  for (const res of [wrong, unknown, short, padded]) {
    assert.deepEqual(await answer(res), [401, ERR.credentials]);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  assert.equal(signinAttempts('sam@example.com'), 3, 'failures are counted');
  // The email as typed (any case, spaces around it), the password exactly as made.
  const res = await post('signin', { email: ' Sam@Example.com', password: PW, next: '/chat' });
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  const body = await res.json();
  assert.deepEqual([body.ok, body.next, body.account.ownerId, body.account.authMethod], [true, '/chat', reply.account.ownerId, 'email']);
  assert.equal((await me({ cookie })).ownerId, reply.account.ownerId);
  assert.equal(signinAttempts('sam@example.com'), 0, 'a sign-in that works clears the failures');
  assert.equal(signinAttempts('nobody@example.com'), 1);
  assert.deepEqual(await answer(await post('signin', { email: 'sam@example.com', password: 12345678 })), [400, ERR.request]);
  assert.deepEqual(await answer(await post('signin', { email: 'sam@example.com' })), [400, ERR.request]);
});

test('sign-in before confirming the email: { needsCode: true } and a new code; confirming it signs in', async () => {
  await post('signup', { email: 'kim@example.com', password: PW });
  const res = await post('signin', { email: 'kim@example.com', password: PW });
  assert.deepEqual(await answer(res), [200, { needsCode: true }]);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(calls.email.length, 2, 'a new code was emailed');
  assert.equal(calls.email[1].body.subject, `${codeFor('kim@example.com')} is your Lumio code`);
  assert.deepEqual(await answer(await app('signin', { email: 'kim@example.com', password: PW })), [200, { needsCode: true }], 'the same for the app');
  assert.equal(count('users'), 0);
  // The wrong password for that sign-up: the usual answer, and no email.
  assert.deepEqual(await answer(await post('signin', { email: 'kim@example.com', password: 'wrong horse' })), [401, ERR.credentials]);
  assert.equal(calls.email.length, 3);
  assert.equal(signinAttempts('kim@example.com'), 1, 'only the failure counts');
  const ok = await post('confirm', { email: 'kim@example.com', code: codeFor('kim@example.com'), password: PW });
  assert.equal(ok.status, 200);
  assert.equal(signinAttempts('kim@example.com'), 0);
  assert.equal((await post('signin', { email: 'kim@example.com', password: PW })).status, 200);
});

test('lockout: after 10 failed sign-ins in 15 minutes even the right password is refused; time or a reset ends it', async () => {
  await signUp('sam@example.com');
  const signin = (password, opts) => post('signin', { email: 'sam@example.com', password }, opts);
  for (let i = 0; i < 10; i++) assert.equal((await signin('wrong horse')).status, 401);
  assert.deepEqual(await answer(await signin(PW)), [401, ERR.credentials], 'the 11th, with the right password');
  assert.equal((await signin(PW, { ip: '198.51.100.9' })).status, 401, 'from another network too');
  // 15 minutes later it works again.
  sql.prepare('UPDATE auth_attempts SET created_at = created_at - ?').run(15 * MINUTE);
  assert.equal((await signin(PW)).status, 200);
  // Locked again; a password reset ends it.
  for (let i = 0; i < 11; i++) await signin('wrong horse');
  assert.equal((await signin(PW)).status, 401);
  await post('forgot', { email: 'sam@example.com' });
  await settled();
  assert.equal((await post('reset', { email: 'sam@example.com', code: codeFor('sam@example.com'), password: 'new horse 2' })).status, 200);
  assert.equal(signinAttempts('sam@example.com'), 0);
  assert.equal((await signin('new horse 2')).status, 200);
});

test('lockout per network address: after 50 failed sign-ins in 15 minutes from one (an IPv6 /64 counts as one)', async () => {
  await signUp('sam@example.com');
  // 50 failures for other emails from one /64, recorded as Lumio records them.
  const ipHash = hex256('lumio-auth|2001:db8:1:2::/64').slice(0, 32);
  const add = sql.prepare("INSERT INTO auth_attempts (id, kind, email_hash, ip_hash, created_at) VALUES (?, 'signin', ?, ?, ?)");
  for (let i = 0; i < 50; i++) add.run(`a${i}`, emailHashOf(`guess${i}@example.com`), ipHash, Date.now() - MINUTE);
  assert.deepEqual(await answer(await post('signin', { email: 'sam@example.com', password: PW }, { ip: '2001:db8:1:2:aaaa::5' })), [401, ERR.credentials]);
  assert.equal(sql.prepare("SELECT ip_hash FROM auth_attempts WHERE kind = 'signin' AND email_hash = ?").get(emailHashOf('sam@example.com')).ip_hash, ipHash);
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW }, { ip: '2001:db8:1:3::5' })).status, 200, 'another /64 is fine');
});

test('the apps’ hand-off: an email sign-in on /signin goes on to /api/auth/app/finish, which hands over a code', async () => {
  await signUp('sam@example.com');
  const res = await post('signin', { email: 'sam@example.com', password: PW, next: '/api/auth/app/finish' });
  const { next } = await res.json();
  assert.equal(next, '/api/auth/app/finish');
  const fin = await call(next, { cookie: cookieOf(res) });
  assert.match(fin.headers.get('location'), /^lumio:\/\/auth\?code=[a-f0-9]{48}$/);
  // A `next` off the site isn't followed.
  for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', 42]) {
    assert.equal((await (await post('signin', { email: 'sam@example.com', password: PW, next: bad })).json()).next, '/account', String(bad));
  }
});

// ---------------------------------------------------------------- forgot password
test('forgot password: a code by email; the new password ends every other session and signs in', async () => {
  const { cookie: web } = await signUp('sam@example.com');
  const { token: phone } = await (await app('signin', { email: 'sam@example.com', password: PW })).json();
  assert.deepEqual(await answer(await post('forgot', { email: 'Sam@example.com' })), [200, { ok: true }]);
  await settled();
  const code = codeFor('sam@example.com');
  const mail = calls.email.at(-1).body;
  assert.equal(mail.subject, `${code} is your Lumio password reset code`);
  assert.equal(mail.text, `Your Lumio password reset code is ${code}\n\nEnter it in Lumio to choose a new password. It works for 15 minutes. Saving the new password signs you out of Lumio everywhere else.\n\nIf you didn’t ask to reset your password, you can ignore this email. Your password stays the same.\n\nLumio`);
  assert.ok(mail.html.includes('font-weight:600">Your Lumio password reset code is</p>'));
  const row = sql.prepare("SELECT * FROM email_codes WHERE purpose = 'reset'").get();
  assert.deepEqual([row.password_hash, row.tries, row.code_hash], [null, 0, codeMac(`lumio-code|reset|sam@example.com|${code}`)]);
  // A new password that's too short or too long, or a code that isn't one: refused before a try is used.
  for (const password of ['short', 'x'.repeat(129), 12345678]) assert.deepEqual(await answer(await post('reset', { email: 'sam@example.com', code, password })), [400, ERR.password]);
  assert.deepEqual(await answer(await post('reset', { email: 'sam@example.com', code: '12', password: 'new horse 2' })), [400, ERR.code]);
  assert.equal(sql.prepare('SELECT tries FROM email_codes').get().tries, 0);
  const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0');
  assert.deepEqual(await answer(await post('reset', { email: 'sam@example.com', code: wrong, password: 'new horse 2' })), [400, ERR.code]);
  assert.equal(sql.prepare('SELECT tries FROM email_codes').get().tries, 1);
  assert.equal((await me({ cookie: web })).signedIn, true, 'nothing changed yet');

  const ok = await post('reset', { email: 'sam@example.com', code, password: 'new horse 2', next: '/chat' });
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.equal((await ok.json()).next, '/chat');
  assert.equal((await me({ cookie: web })).signedIn, false, 'the website session ended');
  assert.equal((await me({ token: phone })).signedIn, false, 'and the app’s');
  assert.equal((await me({ cookie })).signedIn, true, 'the new one works');
  assert.equal(count('sessions'), 1);
  assert.equal(count('email_codes'), 0);
  assert.deepEqual(await answer(await post('signin', { email: 'sam@example.com', password: PW })), [401, ERR.credentials]);
  assert.equal((await post('signin', { email: 'sam@example.com', password: 'new horse 2' })).status, 200);
  assert.deepEqual(await answer(await post('reset', { email: 'sam@example.com', code, password: 'new horse 3' })), [400, ERR.code], 'a code works once');
  // A reset code is only for resets, and a sign-up code only for sign-ups.
  await post('forgot', { email: 'sam@example.com' });
  await settled();
  assert.deepEqual(await answer(await post('confirm', { email: 'sam@example.com', code: codeFor('sam@example.com'), password: PW })), [400, ERR.code]);
});

test('forgot password works for an account made with Google or Apple, and gives it a password', async () => {
  const cookie = await googleSignIn('sam');
  await post('forgot', { email: 'sam@example.com' });
  await settled();
  const res = await post('reset', { email: 'sam@example.com', code: codeFor('sam@example.com'), password: PW });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).account.authMethod, 'google');
  assert.equal((await me({ cookie })).signedIn, false, 'its other sessions ended');
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
  assert.equal(count('users'), 1);
  // Apple (a private relay address).
  const apple = await appleSignIn({ sub: '000777.ivy', email: 'ivy@privaterelay.appleid.com' });
  await post('forgot', { email: 'ivy@privaterelay.appleid.com' });
  await settled();
  const reset = await (await post('reset', { email: 'ivy@privaterelay.appleid.com', code: codeFor('ivy@privaterelay.appleid.com'), password: PW })).json();
  assert.deepEqual([reset.account.ownerId, reset.account.authMethod], [apple.account.ownerId, 'apple']);
});

test('a new password also ends the apps’ pending sign-in hand-off codes, so a stolen session can’t outlast a reset', async () => {
  // Hand-off codes made with a session: the web view's (no challenge) and the iPhone app's (PKCE).
  const handOffs = async (auth) => {
    const codeIn = async (path) => /^lumio:\/\/auth\?code=([a-f0-9]{48})$/.exec((await call(path, auth)).headers.get('location'))[1];
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { plain: await codeIn('/api/auth/app/finish'), pkce: await codeIn(`/api/auth/app/finish?challenge=${challenge}`), verifier };
  };
  const trade = async ({ plain, pkce, verifier }) => {
    const web = await worker.fetch(new Request(`${SITE}/api/auth/app/session`, { method: 'POST', body: new URLSearchParams({ code: plain }), redirect: 'manual' }), env, ctx);
    const phone = await call('/api/auth/app/token', { method: 'POST', body: { code: pkce, verifier }, origin: undefined });
    return { location: web.headers.get('location'), webSession: !!web.headers.get('set-cookie'), app: [phone.status, (await phone.json()).code ?? 'token'] };
  };
  const dead = { location: '/companion', webSession: false, app: [400, 'invalid_code'] };
  await signUp('sam@example.com');
  const { token } = await (await app('signin', { email: 'sam@example.com', password: PW })).json();
  // Without a new password, they work (so this checks something).
  const alive = { location: '/companion', webSession: true, app: [200, 'token'] };
  assert.deepEqual(await trade(await handOffs({ token })), alive);
  // A reset.
  const stolen = await handOffs({ token });
  await post('forgot', { email: 'sam@example.com' });
  await settled();
  assert.equal((await post('reset', { email: 'sam@example.com', code: codeFor('sam@example.com'), password: 'new horse 2' })).status, 200);
  assert.equal(count('app_codes'), 0);
  assert.deepEqual(await trade(stolen), dead);
  // Confirming a sign-up for the email of a password account, which replaces its password.
  const { token: again } = await (await app('signin', { email: 'sam@example.com', password: 'new horse 2' })).json();
  const stolenAgain = await handOffs({ token: again });
  await post('signup', { email: 'sam@example.com', password: 'new horse 3' });
  assert.equal((await post('confirm', { email: 'sam@example.com', code: codeFor('sam@example.com'), password: 'new horse 3' })).status, 200);
  assert.deepEqual(await trade(stolenAgain), dead);
  // Adding a password to a Google account ends nothing.
  const cookie = await googleSignIn('lee');
  const kept = await handOffs({ cookie });
  await signUp('lee@example.com');
  assert.deepEqual(await trade(kept), alive);
});

// ---------------------------------------------------------------- one account
test('one account: confirming the email of a Google account adds a password to it, and nothing else changes', async () => {
  const cookie = await googleSignIn('sam');
  const before = await me({ cookie });
  const { reply } = await signUp('sam@example.com');
  assert.equal(reply.account.ownerId, before.ownerId);
  assert.equal(reply.account.authMethod, 'google', 'still how the account was made');
  assert.deepEqual([reply.account.email, reply.account.profile.name], ['sam@example.com', 'Sam Tester']);
  assert.equal(count('users'), 1);
  assert.equal(userRow().google_sub, 'g-111');
  assert.match(userRow().password_hash, HASH);
  assert.equal((await me({ cookie })).signedIn, true, 'the Google session goes on');
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
  assert.equal((await me({ cookie: await googleSignIn('sam') })).ownerId, before.ownerId, 'and Google still reaches it');
});

test('one account: Google sign-in with the email of a password account reaches it, and never changes that email', async () => {
  const { reply } = await signUp('lee@example.com');
  const now = await me({ cookie: await googleSignIn('lee') });
  assert.equal(now.ownerId, reply.account.ownerId);
  assert.equal(count('users'), 1);
  assert.equal(userRow().google_sub, 'g-222');
  assert.deepEqual([now.authMethod, now.profile.name, now.email], ['google', 'Lee', 'lee@example.com']);
  // Google's email for that account changes: Lumio's stays (the password signs in with it).
  google.lee = { ...google.lee, email: 'lee.new@example.com', name: 'Lee N' };
  const again = await me({ cookie: await googleSignIn('lee') });
  assert.deepEqual([again.ownerId, again.email, again.profile.name], [reply.account.ownerId, 'lee@example.com', 'Lee N']);
  assert.equal((await post('signin', { email: 'lee@example.com', password: PW })).status, 200);
  // An account without a password still follows Google's email.
  await googleSignIn('sam');
  google.sam = { ...google.sam, email: 'sam.new@example.com' };
  assert.equal((await me({ cookie: await googleSignIn('sam') })).email, 'sam.new@example.com');
});

test('one account: Sign in with Apple reaches a password account, and can’t change its email', async () => {
  const { reply } = await signUp('ana@example.com');
  const apple = await appleSignIn({ sub: '001234.ana', email: 'ana@example.com' });
  assert.deepEqual([apple.account.ownerId, apple.account.authMethod], [reply.account.ownerId, 'email']);
  assert.equal(userRow().apple_sub, '001234.ana');
  const later = await appleSignIn({ sub: '001234.ana', email: 'ana.other@example.com' });
  assert.deepEqual([later.account.ownerId, later.account.email], [reply.account.ownerId, 'ana@example.com']);
  assert.equal(count('users'), 1);
  assert.equal((await post('signin', { email: 'ana@example.com', password: PW })).status, 200);
});

test('one account: an Apple account that adds a password keeps reporting Apple, and Apple no longer moves its email', async () => {
  const made = await appleSignIn({ sub: '000999.bo', email: 'bo@privaterelay.appleid.com' });
  assert.equal(made.account.authMethod, 'apple');
  // Without a password it follows Apple's email.
  assert.equal((await appleSignIn({ sub: '000999.bo', email: 'bo2@privaterelay.appleid.com' })).account.email, 'bo2@privaterelay.appleid.com');
  const { reply } = await signUp('bo2@privaterelay.appleid.com');
  assert.deepEqual([reply.account.ownerId, reply.account.authMethod], [made.account.ownerId, 'apple']);
  assert.equal((await appleSignIn({ sub: '000999.bo', email: 'bo3@privaterelay.appleid.com' })).account.email, 'bo2@privaterelay.appleid.com');
  assert.equal(count('users'), 1);
});

test('an account made with Sign in with Apple from an email Apple hadn’t verified is never found by that email', async () => {
  const stranger = await appleSignIn({ sub: '000666.x', email: 'victim@example.com', email_verified: 'false' });
  const marked = (id) => sql.prepare('SELECT email_unverified FROM users WHERE id = ?').get(id).email_unverified;
  assert.equal(marked(stranger.account.ownerId), 1);
  // Forgot: nothing kept, nothing sent; a reset finds nothing.
  assert.deepEqual(await answer(await post('forgot', { email: 'victim@example.com' })), [200, { ok: true }]);
  await settled();
  assert.deepEqual([calls.resendTries, count('email_codes')], [0, 0]);
  assert.deepEqual(await answer(await post('reset', { email: 'victim@example.com', code: '123456', password: 'new horse 2' })), [400, ERR.code]);
  // Confirming a sign-up with that email makes an account of its own; the Apple one gets no password.
  const { reply } = await signUp('victim@example.com');
  assert.notEqual(reply.account.ownerId, stranger.account.ownerId);
  assert.equal(reply.account.authMethod, 'email');
  assert.equal(sql.prepare('SELECT password_hash FROM users WHERE id = ?').get(stranger.account.ownerId).password_hash, null);
  // A reset reaches the new account, and so does a sign-in.
  await post('forgot', { email: 'victim@example.com' });
  await settled();
  const reset = await (await post('reset', { email: 'victim@example.com', code: codeFor('victim@example.com'), password: 'new horse 2' })).json();
  assert.equal(reset.account.ownerId, reply.account.ownerId);
  assert.equal((await (await post('signin', { email: 'victim@example.com', password: 'new horse 2' })).json()).account.ownerId, reply.account.ownerId);
  assert.equal(sql.prepare('SELECT password_hash FROM users WHERE id = ?').get(stranger.account.ownerId).password_hash, null);
  // Google with an email that only such an account has: an account of its own.
  const other = await appleSignIn({ sub: '000667.y', email: 'vic@example.com', email_verified: false });
  google.vic = { sub: 'g-333', email: 'vic@example.com', name: 'Vic' };
  const viaGoogle = await me({ cookie: await googleSignIn('vic') });
  assert.notEqual(viaGoogle.ownerId, other.account.ownerId);
  assert.equal(sql.prepare('SELECT google_sub FROM users WHERE id = ?').get(other.account.ownerId).google_sub, 'apple:000667.y');
  // Its email follows Apple's, and is marked as Apple says; once verified, it's like any other.
  assert.equal((await appleSignIn({ sub: '000667.y', email: 'vic2@example.com', email_verified: false })).account.email, 'vic2@example.com');
  assert.equal(marked(other.account.ownerId), 1);
  assert.equal((await appleSignIn({ sub: '000667.y', email: 'vic2@example.com' })).account.email, 'vic2@example.com');
  assert.equal(marked(other.account.ownerId), null);
  await post('forgot', { email: 'vic2@example.com' });
  await settled();
  const linked = await (await post('reset', { email: 'vic2@example.com', code: codeFor('vic2@example.com'), password: PW })).json();
  assert.deepEqual([linked.account.ownerId, linked.account.authMethod], [other.account.ownerId, 'apple']);
});

test('signing up again with the email of a password account: nothing changes until the code is entered, then it works like a reset', async () => {
  const { cookie } = await signUp('sam@example.com');
  // Someone else starts a sign-up with that email: the code goes to the owner, and nothing changes.
  await post('signup', { email: 'sam@example.com', password: 'stolen horse' });
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
  assert.equal((await me({ cookie })).signedIn, true);
  // The owner enters a code with a new password.
  await post('signup', { email: 'sam@example.com', password: 'new horse 2' });
  const res = await post('confirm', { email: 'sam@example.com', code: codeFor('sam@example.com'), password: 'new horse 2' });
  assert.equal(res.status, 200);
  assert.equal(count('users'), 1);
  assert.equal((await me({ cookie })).signedIn, false, 'its other sessions ended');
  assert.equal((await me({ cookie: cookieOf(res) })).signedIn, true);
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 401);
  assert.equal((await post('signin', { email: 'sam@example.com', password: 'new horse 2' })).status, 200);
});

test('two confirms at once for a new email make one account: the second joins the first', async () => {
  await post('signup', { email: 'sam@example.com', password: PW });
  const code = codeFor('sam@example.com');
  // The other confirm makes the account between this one's lookup and its insert.
  const prepare = env.DB.prepare;
  let raced = false;
  env.DB.prepare = (query) => {
    if (!raced && /^SELECT \* FROM users WHERE email = \?1 AND .* ORDER BY \(password_hash IS NOT NULL\) DESC/.test(query)) {
      raced = true;
      sql.prepare("INSERT INTO users (id, google_sub, email, plan, created_at, password_hash) VALUES ('u_first', 'email:u_first', 'sam@example.com', 'free', ?, ?)").run(Date.now(), DUMMY_HASH);
      return { bind: () => ({ first: async () => null }) };
    }
    return prepare(query);
  };
  const res = await post('confirm', { email: 'sam@example.com', code, password: PW });
  env.DB.prepare = prepare;
  assert.equal(res.status, 200);
  assert.ok(raced);
  assert.equal((await res.json()).account.ownerId, 'u_first');
  assert.equal(count('users'), 1);
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
});

// ---------------------------------------------------------------- no enumeration, limits
test('no account enumeration: sign-up, resend and forgot answer the same for any email; nothing is sent for unknown ones', async () => {
  await signUp('sam@example.com');
  const answers = async (email) => {
    const out = [];
    for (const [action, body] of [['signup', { email, password: 'another horse' }], ['resend', { email }], ['forgot', { email }]]) {
      const res = await post(action, body);
      out.push([action, res.status, await res.text(), res.headers.get('set-cookie'), res.headers.get('content-type')]);
    }
    return out;
  };
  assert.deepEqual(await answers('sam@example.com'), await answers('nobody@example.com'));
  await settled();
  // Resend and forgot for an email with no account and no sign-up: the same answer, nothing sent, nothing kept.
  const before = calls.resendTries;
  for (const action of ['resend', 'forgot']) assert.deepEqual(await answer(await post(action, { email: 'stranger@example.com' })), [200, { ok: true }]);
  await settled();
  assert.equal(calls.resendTries, before);
  assert.equal(count('email_codes', 'email = ?', 'stranger@example.com'), 0);
});

test('forgot answers before looking at accounts, so it’s as quick either way; a wrong reset code costs the same queries either way', { timeout: 10_000 }, async () => {
  await signUp('sam@example.com');
  // Anything that reads the users table waits until released.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const prepare = env.DB.prepare;
  const queries = [];
  env.DB.prepare = (query) => {
    queries.push(query);
    const stmt = prepare(query);
    if (!/\bFROM users\b/.test(query)) return stmt;
    const later = (fn) => async () => { await gate; return fn(); };
    return { bind: (...args) => { const b = stmt.bind(...args); return { run: later(b.run), first: later(b.first), all: later(b.all) }; } };
  };
  try {
    for (const email of ['sam@example.com', 'nobody@example.com']) assert.deepEqual(await answer(await post('forgot', { email })), [200, { ok: true }], email);
    assert.equal(calls.email.length, 1, 'only the sign-up’s email so far');
  } finally {
    env.DB.prepare = prepare;
    release();
  }
  await settled();
  assert.equal(calls.email.length, 2);
  assert.equal(calls.email[1].body.subject, `${codeFor('sam@example.com')} is your Lumio password reset code`);
  assert.equal(count('email_codes'), 1, 'a code only for the email with an account');
  // A wrong code: the same statements whether or not there's a reset code for that email.
  const statements = async (email) => {
    queries.length = 0;
    env.DB.prepare = (query) => { queries.push(query); return prepare(query); };
    try {
      assert.deepEqual(await answer(await post('reset', { email, code: '000000', password: 'new horse 2' })), [400, ERR.code]);
    } finally {
      env.DB.prepare = prepare;
    }
    return [...queries];
  };
  if (codeFor('sam@example.com') === '000000') return;
  assert.deepEqual(await statements('sam@example.com'), await statements('nobody@example.com'));
  assert.equal(sql.prepare('SELECT tries FROM email_codes').get().tries, 1);
});

test('limits: the 6th email to one address in an hour is refused (429, retry-after), from any network', async () => {
  const email = 'sam@example.com';
  assert.equal((await post('signup', { email, password: PW })).status, 200);
  assert.equal((await post('resend', { email })).status, 200);
  assert.equal((await post('resend', { email })).status, 200);
  assert.equal((await post('forgot', { email })).status, 200);
  assert.equal((await post('signup', { email, password: PW })).status, 200);
  await settled();
  const sent = calls.email.length;
  assert.equal(sent, 4, 'two sign-ups and two resends (forgot: no account yet)');
  for (const [action, body, opts] of [['signup', { email, password: PW }], ['resend', { email }], ['forgot', { email }], ['resend', { email }, { ip: '198.51.100.9' }]]) {
    const res = await post(action, body, opts);
    assert.deepEqual(await answer(res), [429, ERR.limited], action);
    assert.equal(res.headers.get('retry-after'), '900');
  }
  // A sign-in that would send a code counts too.
  assert.deepEqual(await answer(await post('signin', { email, password: PW })), [429, ERR.limited]);
  await settled();
  assert.equal(calls.email.length, sent, 'nothing more was sent');
  // An hour later.
  sql.prepare('UPDATE auth_attempts SET created_at = created_at - ?').run(HOUR);
  assert.equal((await post('resend', { email })).status, 200);
  await settled();
  assert.equal(calls.email.length, sent + 1);
});

test('limits: 20 emails an hour from one network address; 30 codes entered, past which no try is used', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await post('forgot', { email: `p${i}@example.com` })).status, 200);
  assert.deepEqual(await answer(await post('forgot', { email: 'p20@example.com' })), [429, ERR.limited]);
  assert.equal((await post('forgot', { email: 'p20@example.com' }, { ip: '198.51.100.9' })).status, 200, 'another address is fine');
  // Codes.
  await post('signup', { email: 'sam@example.com', password: PW }, { ip: '198.51.100.9' });
  const code = codeFor('sam@example.com');
  for (let i = 0; i < 30; i++) assert.deepEqual(await answer(await post('confirm', { email: `p${i}@example.com`, code: '000000', password: PW })), [400, ERR.code]);
  const res = await post('confirm', { email: 'sam@example.com', code, password: PW });
  assert.deepEqual(await answer(res), [429, ERR.limited]);
  assert.equal(res.headers.get('retry-after'), '900');
  assert.deepEqual(await answer(await post('reset', { email: 'sam@example.com', code, password: PW })), [429, ERR.limited]);
  assert.equal(sql.prepare("SELECT tries FROM email_codes WHERE email = 'sam@example.com'").get().tries, 0, 'no try was used');
  const ok = await post('confirm', { email: 'sam@example.com', code, password: PW }, { ip: '198.51.100.10' });
  assert.equal(ok.status, 200);
  assert.equal(count('auth_attempts', "kind = 'code' AND ip_hash = ?", hex256('lumio-auth|198.51.100.10').slice(0, 32)), 0, 'a code that worked removes its attempt');
});

test('limits: at most 10 codes a day to one address (50 guesses), counting only the sends that went ahead', async () => {
  const email = 'sam@example.com';
  const send = () => post('resend', { email });
  const hourLater = () => sql.prepare('UPDATE auth_attempts SET created_at = created_at - ?').run(HOUR);
  assert.equal((await post('signup', { email, password: PW })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await send()).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await send()).status, 429, 'over the hour’s 5');
  hourLater();
  for (let i = 0; i < 5; i++) assert.equal((await send()).status, 200, 'the refused ones didn’t count for the day');
  assert.equal(count('auth_attempts', "kind = 'mail' AND email_hash = ?", emailHashOf(email)), 10);
  hourLater();
  const res = await send();
  assert.deepEqual(await answer(res), [429, ERR.limited]);
  assert.equal(res.headers.get('retry-after'), '900');
  assert.deepEqual(await answer(await post('signup', { email, password: PW }, { ip: '198.51.100.9' })), [429, ERR.limited], 'from any network');
  assert.deepEqual(await answer(await post('forgot', { email })), [429, ERR.limited]);
  await settled();
  assert.equal(calls.email.length, 10);
  assert.equal(count('auth_attempts', "kind = 'mail' AND email_hash = ?", emailHashOf(email)), 10);
  // Another address is fine; a day later, this one is too.
  assert.equal((await post('signup', { email: 'lee@example.com', password: PW })).status, 200);
  sql.prepare('UPDATE auth_attempts SET created_at = created_at - ?').run(DAY);
  assert.equal((await send()).status, 200);
  await settled();
  assert.equal(calls.email.length, 12);
});

test('limits: at most 300 emails an hour from all of Lumio; one network address going over its own limit doesn’t use that up', async () => {
  for (let i = 0; i < 25; i++) await post('forgot', { email: `p${i}@example.com` });
  assert.equal(count('auth_attempts', "kind = 'mail'"), 20, 'the 5 refused sends aren’t counted');
  await post('signup', { email: 'kim@example.com', password: PW }, { ip: '198.51.100.30' }); // waiting to be confirmed
  await settled();
  assert.equal(calls.resendTries, 1);
  // 300 sends this hour, from anywhere: the next one is refused, and nothing is sent.
  const add = sql.prepare("INSERT INTO auth_attempts (id, kind, email_hash, ip_hash, created_at) VALUES (?, 'mail', ?, '', ?)");
  for (let i = 21; i < 300; i++) add.run(`m${i}`, emailHashOf(`q${i}@example.com`), Date.now() - MINUTE);
  const logs = [];
  const error = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    for (const [action, body] of [['signup', { email: 'new@example.com', password: PW }], ['forgot', { email: 'p0@example.com' }], ['resend', { email: 'kim@example.com' }], ['signin', { email: 'kim@example.com', password: PW }]]) {
      const res = await post(action, body, { ip: '198.51.100.20' });
      assert.deepEqual(await answer(res), [429, ERR.limited], action);
    }
  } finally {
    console.error = error;
  }
  await settled();
  assert.equal(calls.resendTries, 1, 'nothing more was sent');
  assert.ok(logs.length === 4 && logs.every((l) => l === 'lumio email global send cap reached 301'), logs.join('\n'));
  assert.equal(count('auth_attempts', "kind = 'mail'"), 300, 'a send refused by the cap isn’t counted');
  // An hour later.
  sql.prepare('UPDATE auth_attempts SET created_at = created_at - ?').run(HOUR);
  assert.equal((await post('signup', { email: 'new@example.com', password: PW }, { ip: '198.51.100.20' })).status, 200);
  assert.equal(calls.email.length, 2);
});

// ---------------------------------------------------------------- email
test('without a Resend key: sign-up, resend and forgot say email sign-in isn’t available yet; sign-in and Google still work', async () => {
  await signUp('sam@example.com');
  await post('signup', { email: 'kim@example.com', password: PW }); // waiting to be confirmed
  delete env.RESEND_API_KEY;
  for (const [action, body] of [['signup', { email: 'new@example.com', password: PW }], ['resend', { email: 'kim@example.com' }], ['forgot', { email: 'sam@example.com' }]]) {
    assert.deepEqual(await answer(await post(action, body)), [503, ERR.unavailable], action);
  }
  assert.deepEqual(await answer(await post('signin', { email: 'kim@example.com', password: PW })), [503, ERR.unavailable], 'it would need to send a code');
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
  assert.deepEqual(await answer(await post('signin', { email: 'nobody@example.com', password: PW })), [401, ERR.credentials]);
  assert.equal((await me({ cookie: await googleSignIn('lee') })).signedIn, true);
  await settled();
  assert.equal(calls.resendTries, 2);
});

test('without the code key: email sign-up, codes and resets aren’t available either (nothing is tried or sent); password sign-in still works', async () => {
  await signUp('sam@example.com');
  await post('signup', { email: 'kim@example.com', password: PW }); // waiting to be confirmed
  const code = codeFor('kim@example.com');
  const sent = calls.resendTries;
  delete env.CODE_KEY;
  for (const [action, body] of [['signup', { email: 'new@example.com', password: PW }], ['resend', { email: 'kim@example.com' }], ['forgot', { email: 'sam@example.com' }],
    ['confirm', { email: 'kim@example.com', code, password: PW }], ['reset', { email: 'sam@example.com', code: '123456', password: 'new horse 2' }],
    ['signin', { email: 'kim@example.com', password: PW }]]) {
    assert.deepEqual(await answer(await post(action, body)), [503, ERR.unavailable], action);
  }
  assert.equal(sql.prepare('SELECT tries FROM email_codes').get().tries, 0);
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
  await settled();
  assert.equal(calls.resendTries, sent);
  env.CODE_KEY = CODE_KEY;
  assert.equal((await post('confirm', { email: 'kim@example.com', code, password: PW })).status, 200);
});

test('when Resend fails: sign-up says the email couldn’t be sent and keeps no code that wasn’t sent; logs hold no address or code', async () => {
  const logs = [];
  const error = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    for (const down of [true, 'network']) {
      resendDown = down;
      assert.deepEqual(await answer(await post('signup', { email: 'kim@example.com', password: PW })), [502, ERR.failed]);
      assert.equal(count('email_codes'), 0, 'a code is kept only once it’s sent');
    }
    resendDown = false;
    await post('signup', { email: 'kim@example.com', password: PW });
    const code = codeFor('kim@example.com');
    // Signing up again when the email can't go: the sign-up already waiting stays as it was.
    resendDown = true;
    assert.deepEqual(await answer(await post('signup', { email: 'kim@example.com', password: 'other horse' })), [502, ERR.failed]);
    resendDown = false;
    assert.equal((await post('confirm', { email: 'kim@example.com', code, password: PW })).status, 200);
    // A reset code that can't be sent is only logged, and removed.
    resendDown = 'network';
    assert.deepEqual(await answer(await post('forgot', { email: 'kim@example.com' })), [200, { ok: true }]);
    await settled();
    assert.equal(count('email_codes'), 0, 'the reset code that couldn’t go was removed');
    // A resend that can't be sent is only logged.
    resendDown = false;
    await post('signup', { email: 'joy@example.com', password: PW });
    resendDown = true;
    assert.deepEqual(await answer(await post('resend', { email: 'joy@example.com' })), [200, { ok: true }]);
    await settled();
    // A sign-in that has to send a code says so too, and keeps the code it had.
    const before = sql.prepare("SELECT code_hash FROM email_codes WHERE email = 'joy@example.com'").get().code_hash;
    assert.deepEqual(await answer(await post('signin', { email: 'joy@example.com', password: PW })), [502, ERR.failed]);
    assert.equal(sql.prepare("SELECT code_hash FROM email_codes WHERE email = 'joy@example.com'").get().code_hash, before);
  } finally {
    console.error = error;
  }
  assert.equal(logs.length, 6, logs.join('\n'));
  assert.ok(logs.every((l) => !/kim@|joy@|\b\d{6}\b/.test(l)), logs.join('\n'));
});

// ---------------------------------------------------------------- requests
test('the email routes refuse other sites’ pages, and requests that aren’t right', async () => {
  for (const action of ['signup', 'confirm', 'resend', 'signin', 'forgot', 'reset']) {
    assert.deepEqual(await answer(await post(action, { email: 'sam@example.com', password: PW, code: '123456' }, { origin: 'https://evil.example' })), [403, ERR.forbidden], action);
    for (const body of ['not json', '[1,2]', 'null', '"sam@example.com"', JSON.stringify({ email: 'sam@example.com', pad: 'x'.repeat(20_000) })]) {
      assert.deepEqual(await answer(await post(action, body)), [400, ERR.request], `${action} ${body.slice(0, 20)}`);
    }
    for (const email of [undefined, 42, '', 'sam', 'sam@example', '@example.com', 'sam@.com', 'sa m@example.com', 'sam@exa\u0007mple.com', 'sam@exa\u0085mple.com', `${'a'.repeat(243)}@example.com`]) {
      assert.deepEqual(await answer(await post(action, { email, password: PW, code: '123456' })), [400, ERR.email], `${action} ${email}`);
    }
  }
  assert.equal(count('auth_attempts'), 0, 'none of that counted as an attempt');
  // The longest email allowed.
  assert.equal((await post('signup', { email: `${'a'.repeat(242)}@example.com`, password: PW })).status, 200);
  // Passwords: 8 to 128 characters, counted as code points; nothing else is required.
  for (const password of ['seven77', 'x'.repeat(129), '🙂'.repeat(7), '🙂'.repeat(129), 12345678, undefined]) {
    assert.deepEqual(await answer(await post('signup', { email: 'pw@example.com', password })), [400, ERR.password], String(password).slice(0, 12));
  }
  for (const [i, password] of ['eight888', 'x'.repeat(128), '🙂'.repeat(8), '🙂'.repeat(128), '        '].entries()) {
    assert.equal((await post('signup', { email: `pw${i}@example.com`, password })).status, 200, password.slice(0, 12));
  }
  // Unicode NFC: the same characters typed another way are the same password.
  await post('signup', { email: 'cafe@example.com', password: 'Café horse' });
  assert.equal((await post('confirm', { email: 'cafe@example.com', code: codeFor('cafe@example.com'), password: 'Café horse' })).status, 200);
  assert.equal((await post('signin', { email: 'cafe@example.com', password: 'Café horse' })).status, 200);
  assert.equal((await post('signin', { email: 'cafe@example.com', password: 'Café horse' })).status, 200);
  // Only POST.
  assert.equal((await call('/api/auth/email/signin')).status, 404);
});

// ---------------------------------------------------------------- the rest
test('passwords: PBKDF2-SHA256, 100,000 iterations, a new salt each time; odd hashes never match; older counts are made again at sign-in', async () => {
  assert.equal(PBKDF2_ITERATIONS, 100000);
  const a = await hashPassword(PW);
  const b = await hashPassword(PW);
  assert.match(a, HASH);
  assert.notEqual(a, b, 'a new salt each time');
  assert.equal(await verifyPassword(PW, a), true);
  assert.equal(await verifyPassword('correct horsE', a), false);
  assert.match(DUMMY_HASH, HASH);
  assert.equal(await verifyPassword('', DUMMY_HASH), false);
  for (const odd of ['', 'x', 'bcrypt$12$abc', a.replace('pbkdf2-sha256', 'pbkdf2-sha512'), a.replace('$100000$', '$0$'), a.replace('$100000$', '$100001$'),
    a.replace('$100000$', '$1e5$'), a.replace('$100000$', '$-1$'), `${a}$x`, a.replace(/\$[^$]+$/, '$!!!'), a.split('$').slice(0, 3).join('$')]) {
    assert.equal(await verifyPassword(PW, odd), false, odd);
  }
  // A hash with fewer iterations (made here with Node's own PBKDF2) still works, and is made again at sign-in.
  const salt = crypto.randomBytes(16);
  const old = `pbkdf2-sha256$1000$${salt.toString('base64url')}$${crypto.pbkdf2Sync(PW, salt, 1000, 32, 'sha256').toString('base64url')}`;
  assert.equal(await verifyPassword(PW, old), true);
  await signUp('sam@example.com');
  sql.prepare('UPDATE users SET password_hash = ?').run(old);
  assert.equal((await post('signin', { email: 'sam@example.com', password: PW })).status, 200);
  const upgraded = userRow().password_hash;
  assert.match(upgraded, HASH);
  assert.equal(await verifyPassword(PW, upgraded), true);
  // Constant-time comparison.
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  assert.equal(timingSafeEqual(new Uint8Array(), new Uint8Array()), true);
});

test('codes are 6 random digits; emails are trimmed, lowercase and checked', () => {
  const codes = Array.from({ length: 2000 }, newCode);
  for (const c of codes) assert.match(c, /^\d{6}$/);
  assert.ok(new Set(codes).size > 1980, 'random');
  assert.ok(codes.some((c) => c.startsWith('0')), 'leading zeros are kept');
  assert.equal(normalizeEmail('  Sam.Tester+lumio@Example.COM\n'), 'sam.tester+lumio@example.com');
  for (const bad of ['', 'a@b', 'sam@example', 'sam@@example.com', 'sam example@x.com', 'sam@x.com\u0000', `${'a'.repeat(243)}@example.com`]) assert.equal(normalizeEmail(bad), null, bad);
});

test('deleting the account removes its email codes and sign-in attempts (and only its own)', async () => {
  await signUp('sam@example.com');
  const { token } = await (await app('signin', { email: 'sam@example.com', password: PW })).json();
  await post('signin', { email: 'sam@example.com', password: 'wrong horse' });
  await post('forgot', { email: 'sam@example.com' });
  await post('signup', { email: 'other@example.com', password: PW });
  await settled();
  const mine = emailHashOf('sam@example.com');
  assert.ok(count('email_codes', 'email = ?', 'sam@example.com') > 0 && count('auth_attempts', 'email_hash = ?', mine) > 0);
  const del = await call('/api/account', { method: 'DELETE', token, body: { confirm: true }, origin: undefined });
  assert.equal(del.status, 200);
  await settled();
  assert.equal(count('users'), 0);
  assert.equal(count('email_codes', 'email = ?', 'sam@example.com'), 0);
  assert.equal(count('auth_attempts', 'email_hash = ?', mine), 0);
  assert.equal(count('email_codes', 'email = ?', 'other@example.com'), 1, 'someone else’s sign-up stays');
  assert.deepEqual(await answer(await post('signin', { email: 'sam@example.com', password: PW })), [401, ERR.credentials]);
  // The email can make a new account.
  const { reply } = await signUp('sam@example.com');
  assert.equal(reply.account.authMethod, 'email');
});

test('cron: attempts go after an hour (the codes sent to each email after a day), unconfirmed sign-ups after a day, reset codes once they expire', async () => {
  const t = Date.now();
  const attempt = sql.prepare("INSERT INTO auth_attempts (id, kind, email_hash, ip_hash, created_at) VALUES (?, ?, 'e', 'i', ?)");
  for (const kind of ['send', 'signin', 'code']) attempt.run(`old ${kind}`, kind, t - HOUR - 1);
  attempt.run('new', 'send', t - HOUR + 1000);
  attempt.run('mail', 'mail', t - DAY + 1000);
  attempt.run('old mail', 'mail', t - DAY - 1);
  const code = sql.prepare('INSERT INTO email_codes (email, purpose, code_hash, expires_at, tries, password_hash, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)');
  code.run('a@example.com', 'signup', 'h', t - DAY, t - DAY - 1);
  code.run('b@example.com', 'signup', 'h', t - MINUTE, t - DAY + 1000);
  code.run('a@example.com', 'reset', 'h', t - 1, t - 20 * MINUTE);
  code.run('b@example.com', 'reset', 'h', t + MINUTE, t - 14 * MINUTE);
  await emailCleanup(env, t);
  assert.deepEqual(sql.prepare('SELECT id FROM auth_attempts ORDER BY id').all().map((r) => r.id), ['mail', 'new']);
  assert.deepEqual(sql.prepare('SELECT email, purpose FROM email_codes ORDER BY purpose').all().map((r) => `${r.purpose} ${r.email}`), ['reset b@example.com', 'signup b@example.com']);
  // The Worker's cron runs it.
  attempt.run('older', 'signin', t - 2 * HOUR);
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(count('auth_attempts', 'id = ?', 'older'), 0);
});
