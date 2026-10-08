// Email + password accounts, next to Google and Sign in with Apple
// (docs/email-accounts.md). All POST, JSON, no session needed:
//   /api/auth/email/signup   { email, password }: emails a 6-digit code
//   /api/auth/email/confirm  { email, code, password }: confirms the email and signs in
//   /api/auth/email/resend   { email }: a new code for a sign-up
//   /api/auth/email/signin   { email, password }: signs in, or { needsCode: true }
//                            (and a new code) for a sign-up that isn't confirmed yet
//   /api/auth/email/forgot   { email }: emails a code to choose a new password
//   /api/auth/email/reset    { email, code, password }: saves it, ends the
//                            account's other sessions (and its apps' pending
//                            sign-in hand-off codes) and signs in
// The website gets the session cookie and a `next` to go to (its sign-in
// hand-off to the apps is unchanged); Lumio for iPhone and iPad sends
// "client": "app" and gets { token, account }, like POST /api/auth/apple.
//
// A sign-up isn't an account until its code is confirmed: until then it
// waits in email_codes (a day at most), with the password's hash. Confirming
// an email that already has an account (made with Google or Apple) adds the
// password to that account, since the code proves the address is theirs.
// Codes are stored only as an HMAC keyed with the CODE_KEY secret (so a copy
// of the database can't be used to work them out), and work for 15 minutes
// and 5 tries. Sign-up, resend and forgot answer the same, and as fast,
// whether or not the email has an account, and sign-in says only "Email or
// password is incorrect", so nobody can find out who has a Lumio account.
// Sends, sign-ins and codes are limited per email and per network address
// (auth_attempts, as hashes, kept an hour; the codes sent to each email, a
// day): an email gets at most 10 codes a day (50 guesses), and all of Lumio
// sends at most 300 an hour. After 10 failed sign-ins in 15 minutes, an email
// gets that same answer without its password being checked, until it's had
// fewer for a while or the password is reset.
// Accounts made with Sign in with Apple from an email Apple hadn't verified
// (email_unverified) are never found by their email here.
import { type User, SESSION_DAYS, VERIFIED_EMAIL, accountJson, newSession, sessionCookie } from './auth.ts';
import { ipKey } from './crashes.ts';
import { codeEmail, sendEmail } from './email.ts';
import { DUMMY_HASH, hashPassword, needsUpgrade, verifyPassword } from './password.ts';
import { type Env, fail, json, randomHex, safeNext, sameOrigin, sha256, timingSafeEqual } from './util.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CODE_MS = 15 * MINUTE;
const SIGNUP_MS = DAY; // an unconfirmed sign-up is forgotten after this
const MAX_TRIES = 5;
const MAX_BODY = 16 * 1024;
// Attempts in each window, counted per email and per network address. Over
// them, sends and codes get 429; sign-ins get the wrong-password answer.
const LIMITS = {
  send: { window: HOUR, email: 5, ip: 20 }, // emails: sign-up, resend, forgot, a sign-in that sends a code
  signin: { window: 15 * MINUTE, email: 10, ip: 50 }, // failed sign-ins (one that works removes them)
  code: { window: HOUR, email: Infinity, ip: 30 }, // codes entered (confirm, reset); guesses per email are capped by MAILS
};
// Sends within those limits (recorded as 'mail' rows, kept a day): per email a
// day, since each code is 5 guesses; and from all of Lumio an hour, under
// Resend's quota, so someone with many network addresses can't use it up or
// get the domain blocked.
const MAILS = { perEmailPerDay: 10, allPerHour: 300 };

type Kind = keyof typeof LIMITS;
type Purpose = 'signup' | 'reset';
type Ask = { body: Record<string, unknown>; client: 'web' | 'app'; email: string; emailHash: string; ipHash: string };
type Handler = (request: Request, env: Env, ctx: ExecutionContext, now?: number) => Promise<Response>;

const invalidRequest = () => fail('That didn’t work. Try again.', 400, 'invalid_request');
const invalidEmail = () => fail('Enter a valid email address.', 400, 'invalid_email');
const invalidPassword = () => fail('Use a password with 8 to 128 characters.', 400, 'invalid_password');
// A wrong, expired or used-up code, no sign-up at all, or (confirming) the wrong password: all the same answer.
const invalidCode = () => fail('That code didn’t work. Check the latest email from Lumio, or send a new code.', 400, 'invalid_code');
const wrongPassword = () => fail('Email or password is incorrect.', 401, 'invalid_credentials');
const tooMany = () => fail('Too many tries. Wait a few minutes and try again.', 429, 'rate_limited', { 'retry-after': '900' });
const emailFailed = () => fail('Lumio couldn’t send the email. Try again in a minute.', 502, 'email_failed');
const unavailable = () => fail('Email sign-in isn’t available yet. Use another way to sign in for now.', 503, 'email_unavailable');
// Email sign-in needs Resend's key to send codes and CODE_KEY to keep them.
const emailReady = (env: Env) => !!(env.RESEND_API_KEY && env.CODE_KEY);

// Trimmed and lowercase, or null when it isn't an email address.
export function normalizeEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/\p{Cc}/u.test(email) ? email : null;
}
export const emailHash = (email: string) => sha256(`lumio-email|${email}`);
// New passwords: 8 to 128 characters (code points), anything else allowed.
function passwordOk(password: string) {
  const length = [...password].length;
  return length >= 8 && length <= 128;
}

// 6 random digits, every value equally likely.
export function newCode() {
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n); while (n[0] >= 4294000000);
  return String(n[0] % 1000000).padStart(6, '0');
}
// HMAC-SHA256 hex keyed with CODE_KEY (base64 of 32 bytes): with only 10^6
// codes, a plain hash would give the code away to anyone who can read the table.
async function codeHash(env: Env, purpose: Purpose, email: string, code: string) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(env.CODE_KEY || ''), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`lumio-code|${purpose}|${email}|${code}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// What was typed, without the spaces or hyphens people add, or null.
function typedCode(v: unknown) {
  const code = typeof v === 'string' ? v.replace(/[\s-]/g, '') : '';
  return /^\d{6}$/.test(code) ? code : null;
}

// What every route checks first, in this order: the Origin (the website's
// fetch sends its own; the app sends none), a JSON object, the email.
async function ask(request: Request): Promise<Ask | Response> {
  if (!sameOrigin(request)) return fail('Not allowed.', 403, 'forbidden');
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return invalidRequest();
  const raw = await request.text().catch(() => '');
  let body: unknown = null;
  try { body = raw.length <= MAX_BODY ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidRequest();
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? normalizeEmail(b.email) : null;
  if (!email) return invalidEmail();
  return {
    body: b, client: b.client === 'app' ? 'app' : 'web', email, emailHash: await emailHash(email),
    ipHash: (await sha256(`lumio-auth|${ipKey(request.headers.get('cf-connecting-ip'))}`)).slice(0, 32),
  };
}

// Records an attempt, then counts the ones in its window with it included
// (recorded first, so parallel requests see each other). Its id lets an
// attempt that worked remove its own row. A send within its limits then
// also has to fit MAILS.
async function attempt(env: Env, kind: Kind, a: Ask, now: number) {
  const id = randomHex(12);
  const limit = LIMITS[kind];
  await env.DB.prepare('INSERT INTO auth_attempts (id, kind, email_hash, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, kind, a.emailHash, a.ipHash, now).run();
  const n = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM auth_attempts WHERE kind = ?1 AND email_hash = ?2 AND created_at > ?4) AS email,
      (SELECT COUNT(*) FROM auth_attempts WHERE kind = ?1 AND ip_hash = ?3 AND created_at > ?4) AS ip`)
    .bind(kind, a.emailHash, a.ipHash, now - limit.window).first<{ email: number; ip: number }>();
  const over = (n?.email ?? 0) > limit.email || (n?.ip ?? 0) > limit.ip;
  return { id, over: over || (kind === 'send' && !(await mailAllowed(env, a, now))) };
}

// A send within its hourly limits: recorded as a 'mail' row (the email's hash
// only, no network address), then counted against MAILS. One that doesn't fit
// is removed again, so the 'mail' rows count only the sends that went ahead,
// and one network address going over its own limit can't use up everyone's.
async function mailAllowed(env: Env, a: Ask, now: number) {
  const id = randomHex(12);
  await env.DB.prepare("INSERT INTO auth_attempts (id, kind, email_hash, ip_hash, created_at) VALUES (?1, 'mail', ?2, '', ?3)").bind(id, a.emailHash, now).run();
  const n = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM auth_attempts WHERE kind = 'mail' AND email_hash = ?1 AND created_at > ?2) AS day,
      (SELECT COUNT(*) FROM auth_attempts WHERE kind = 'mail' AND created_at > ?3) AS hour`)
    .bind(a.emailHash, now - DAY, now - HOUR).first<{ day: number; hour: number }>();
  const day = n?.day ?? 0;
  const hour = n?.hour ?? 0;
  if (day <= MAILS.perEmailPerDay && hour <= MAILS.allPerHour) return true;
  if (hour > MAILS.allPerHour) console.error('lumio email global send cap reached', hour);
  await env.DB.prepare('DELETE FROM auth_attempts WHERE id = ?1').bind(id).run();
  return false;
}

// A new code for a pending sign-up (resend, or a sign-in before confirming):
// true when there is one.
async function renewSignupCode(env: Env, email: string, code: string, now: number) {
  const res = await env.DB.prepare("UPDATE email_codes SET code_hash = ?2, tries = 0, expires_at = ?3 WHERE email = ?1 AND purpose = 'signup' AND created_at > ?4")
    .bind(email, await codeHash(env, 'signup', email, code), now + CODE_MS, now - SIGNUP_MS).run();
  return res.meta.changes === 1;
}

// One try of a code: counted first, atomically (so guesses sent in parallel
// still get 5 tries in all), and read in the same statement (so a code that
// exists takes no extra query), then compared. The row when the code is
// right, else null.
async function useCode(env: Env, purpose: Purpose, email: string, code: string, now: number) {
  const hash = await codeHash(env, purpose, email, code);
  const row = await env.DB.prepare('UPDATE email_codes SET tries = tries + 1 WHERE email = ?1 AND purpose = ?2 AND tries < ?3 AND expires_at > ?4 AND created_at > ?5 RETURNING code_hash, password_hash')
    .bind(email, purpose, MAX_TRIES, now, purpose === 'signup' ? now - SIGNUP_MS : 0).first<{ code_hash: string; password_hash: string | null }>();
  const te = new TextEncoder();
  return row && timingSafeEqual(te.encode(hash), te.encode(row.code_hash)) ? row : null;
}

// The account an email signs in to: the one with a password if any, else the
// oldest (never one whose email Apple hadn't verified).
const target = (env: Env, email: string) =>
  env.DB.prepare(`SELECT * FROM users WHERE email = ?1 AND ${VERIFIED_EMAIL} ORDER BY (password_hash IS NOT NULL) DESC, created_at LIMIT 1`).bind(email).first<User>();

// A new password ends the account's sessions and its apps' pending sign-in
// hand-off codes (each could still be traded for a session); the new session
// is made after.
const newPassword = (env: Env, userId: string, passwordHash: string) => [
  env.DB.prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1').bind(userId, passwordHash),
  env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
  env.DB.prepare('DELETE FROM app_codes WHERE user_id = ?1').bind(userId),
];

// A confirmed sign-up: the password goes on the email's account (a Google or
// Apple one gets it added, nothing else changes; one that had a password gets
// the new one and its sessions and pending hand-off codes end, like a reset),
// or a new account is made.
async function linkPassword(env: Env, email: string, passwordHash: string, now: number) {
  const user = await target(env, email);
  if (user?.password_hash) {
    await env.DB.batch(newPassword(env, user.id, passwordHash));
    return user.id;
  }
  if (user) {
    await env.DB.prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1').bind(user.id, passwordHash).run();
    return user.id;
  }
  // google_sub is required (and unique): accounts made with email + password hold 'email:<id>'.
  const id = 'u_' + randomHex(12);
  await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, plan, created_at, password_hash) VALUES (?1, ?2, ?3, NULL, NULL, 'free', ?4, ?5)")
    .bind(id, `email:${id}`, email, now, passwordHash).run();
  return id;
}

// Signed in: a new session (like Google's and Apple's), as the website's
// cookie or the app's token.
async function signedIn(request: Request, env: Env, a: Ask, userId: string) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(userId).first<User>();
  if (!user) return fail('Lumio hit a problem. Try again.', 500, 'server_error');
  const token = await newSession(env, user.id);
  if (a.client === 'app') return json({ token, account: accountJson(user) });
  const next = safeNext(typeof a.body.next === 'string' ? a.body.next : null);
  return json({ ok: true, next, account: accountJson(user) }, 200, { 'set-cookie': sessionCookie(new URL(request.url), token, SESSION_DAYS * 86400) });
}

// After a confirm or reset that worked: the codes, the failed sign-ins (which
// ends a lockout) and this code attempt go.
const finished = (env: Env, a: Ask, attemptId: string) => [
  env.DB.prepare('DELETE FROM email_codes WHERE email = ?1').bind(a.email),
  env.DB.prepare("DELETE FROM auth_attempts WHERE kind = 'signin' AND email_hash = ?1").bind(a.emailHash),
  env.DB.prepare('DELETE FROM auth_attempts WHERE id = ?1').bind(attemptId),
];


// POST /api/auth/email/signup
export async function emailSignup(request: Request, env: Env, _ctx: ExecutionContext, now = Date.now()) {
  const a = await ask(request);
  if (a instanceof Response) return a;
  const password = typeof a.body.password === 'string' ? a.body.password.normalize('NFC') : '';
  if (!passwordOk(password)) return invalidPassword();
  if (!emailReady(env)) return unavailable();
  if ((await attempt(env, 'send', a, now)).over) return tooMany();
  const code = newCode();
  const hash = await codeHash(env, 'signup', a.email, code);
  const passwordHash = await hashPassword(password);
  // Awaited, so a failure can be told; the code is kept only once it's sent
  // (a sign-up already waiting stays as it was).
  try { await sendEmail(env, a.email, codeEmail('signup', code)); } catch (err) { console.error('lumio email signup', err); return emailFailed(); }
  await env.DB.prepare("INSERT OR REPLACE INTO email_codes (email, purpose, code_hash, expires_at, tries, password_hash, created_at) VALUES (?1, 'signup', ?2, ?3, 0, ?4, ?5)")
    .bind(a.email, hash, now + CODE_MS, passwordHash, now).run();
  return json({ ok: true });
}

// POST /api/auth/email/confirm
export async function emailConfirm(request: Request, env: Env, _ctx: ExecutionContext, now = Date.now()) {
  const a = await ask(request);
  if (a instanceof Response) return a;
  if (typeof a.body.password !== 'string') return invalidRequest();
  const code = typedCode(a.body.code);
  if (!code) return invalidCode();
  if (!env.CODE_KEY) return unavailable();
  const tried = await attempt(env, 'code', a, now);
  if (tried.over) return tooMany();
  const row = await useCode(env, 'signup', a.email, code, now);
  if (!row?.password_hash || !(await verifyPassword(a.body.password, row.password_hash))) return invalidCode();
  let userId: string;
  try {
    userId = await linkPassword(env, a.email, row.password_hash, now);
  } catch {
    // Two confirms at once both made an account: only one row can hold a
    // password for an email (users_password_email), so this one joins it.
    userId = await linkPassword(env, a.email, row.password_hash, now);
  }
  await env.DB.batch(finished(env, a, tried.id));
  return signedIn(request, env, a, userId);
}

// POST /api/auth/email/resend (sign-up codes): the same answer either way.
export async function emailResend(request: Request, env: Env, ctx: ExecutionContext, now = Date.now()) {
  const a = await ask(request);
  if (a instanceof Response) return a;
  if (!emailReady(env)) return unavailable();
  if ((await attempt(env, 'send', a, now)).over) return tooMany();
  const code = newCode();
  if (await renewSignupCode(env, a.email, code, now)) {
    ctx.waitUntil(sendEmail(env, a.email, codeEmail('signup', code)).catch((err) => console.error('lumio email signup', err)));
  }
  return json({ ok: true });
}

// POST /api/auth/email/signin
export async function emailSignin(request: Request, env: Env, _ctx: ExecutionContext, now = Date.now()) {
  const a = await ask(request);
  if (a instanceof Response) return a;
  if (typeof a.body.password !== 'string') return invalidRequest();
  const password = a.body.password;
  const tried = await attempt(env, 'signin', a, now);
  // Locked: the same answer as a wrong password, without checking it.
  if (tried.over) return wrongPassword();
  const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?1 AND password_hash IS NOT NULL AND ${VERIFIED_EMAIL}`).bind(a.email).first<User>();
  if ((await verifyPassword(password, user?.password_hash || DUMMY_HASH)) && user?.password_hash) {
    const done = [env.DB.prepare("DELETE FROM auth_attempts WHERE kind = 'signin' AND email_hash = ?1").bind(a.emailHash)];
    // A hash with an older iteration count is made again (unless the password just changed).
    if (needsUpgrade(user.password_hash)) done.push(env.DB.prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1 AND password_hash = ?3').bind(user.id, await hashPassword(password), user.password_hash));
    await env.DB.batch(done);
    return signedIn(request, env, a, user.id);
  }
  // A sign-up with this password that isn't confirmed yet: a new code.
  const pending = await env.DB.prepare("SELECT password_hash FROM email_codes WHERE email = ?1 AND purpose = 'signup' AND created_at > ?2")
    .bind(a.email, now - SIGNUP_MS).first<{ password_hash: string | null }>();
  if (pending?.password_hash && (await verifyPassword(password, pending.password_hash))) {
    if (!emailReady(env)) return unavailable();
    if ((await attempt(env, 'send', a, now)).over) return tooMany();
    // The new code is kept only once it's sent.
    const code = newCode();
    try { await sendEmail(env, a.email, codeEmail('signup', code)); } catch (err) { console.error('lumio email signin', err); return emailFailed(); }
    if (!(await renewSignupCode(env, a.email, code, now))) return wrongPassword();
    await env.DB.prepare('DELETE FROM auth_attempts WHERE id = ?1').bind(tried.id).run();
    return json({ needsCode: true });
  }
  return wrongPassword();
}

// POST /api/auth/email/forgot: the same answer, just as fast, either way:
// whether the email has an account is only looked at after answering. Works
// for an account made with Google or Apple too (and gives it a password).
export async function emailForgot(request: Request, env: Env, ctx: ExecutionContext, now = Date.now()) {
  const a = await ask(request);
  if (a instanceof Response) return a;
  if (!emailReady(env)) return unavailable();
  if ((await attempt(env, 'send', a, now)).over) return tooMany();
  const code = newCode();
  ctx.waitUntil((async () => {
    // One statement, only for an email that has an account; the code is kept
    // before the email goes (so it works when it arrives), and removed if it can't go.
    const hash = await codeHash(env, 'reset', a.email, code);
    const res = await env.DB.prepare(`INSERT OR REPLACE INTO email_codes (email, purpose, code_hash, expires_at, tries, password_hash, created_at)
        SELECT ?1, 'reset', ?2, ?3, 0, NULL, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE email = ?1 AND ${VERIFIED_EMAIL})`)
      .bind(a.email, hash, now + CODE_MS, now).run();
    if (res.meta.changes !== 1) return;
    try {
      await sendEmail(env, a.email, codeEmail('reset', code));
    } catch (err) {
      await env.DB.prepare("DELETE FROM email_codes WHERE email = ?1 AND purpose = 'reset' AND code_hash = ?2").bind(a.email, hash).run();
      throw err;
    }
  })().catch((err) => console.error('lumio email reset', err)));
  return json({ ok: true });
}

// POST /api/auth/email/reset
export async function emailReset(request: Request, env: Env, _ctx: ExecutionContext, now = Date.now()) {
  const a = await ask(request);
  if (a instanceof Response) return a;
  const code = typedCode(a.body.code);
  if (!code) return invalidCode();
  const password = typeof a.body.password === 'string' ? a.body.password.normalize('NFC') : '';
  if (!passwordOk(password)) return invalidPassword();
  if (!env.CODE_KEY) return unavailable();
  const tried = await attempt(env, 'code', a, now);
  if (tried.over) return tooMany();
  if (!(await useCode(env, 'reset', a.email, code, now))) return invalidCode();
  const user = await target(env, a.email);
  if (!user) return invalidCode();
  // The new password, every other session and pending hand-off code ended; then this session is made.
  await env.DB.batch([...newPassword(env, user.id, await hashPassword(password)), ...finished(env, a, tried.id)]);
  return signedIn(request, env, a, user.id);
}

export const EMAIL_ROUTES: Record<string, Handler> = {
  signup: emailSignup, confirm: emailConfirm, resend: emailResend, signin: emailSignin, forgot: emailForgot, reset: emailReset,
};

// Every few minutes (cron): attempts go after an hour (the codes sent to each
// email, 'mail', after a day), unconfirmed sign-ups after a day, reset codes
// once they expire.
export async function emailCleanup(env: Env, now = Date.now()) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE created_at < ?1 AND (kind != 'mail' OR created_at < ?2)").bind(now - HOUR, now - DAY).run();
  await env.DB.prepare("DELETE FROM email_codes WHERE purpose = 'signup' AND created_at < ?1").bind(now - SIGNUP_MS).run();
  await env.DB.prepare("DELETE FROM email_codes WHERE purpose = 'reset' AND expires_at < ?1").bind(now).run();
}
