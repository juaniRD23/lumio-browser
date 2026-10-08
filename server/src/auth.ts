// Lumio accounts: sign in with Google, with an email and a password
// (email-auth.ts) or, in the iPhone and iPad app, with Apple (apple.ts), then
// a session cookie (and, for Lumio Browser and the apps, the same session sent
// as a bearer token). Sessions are stored by a hash of the token, never the
// token itself.
import { type Env, base64url, cookies, fail, json, randomHex, redirect, safeNext, sha256 } from './util.ts';
import type { Plan } from './agent.ts';
import { expireCodePlan } from './codes.ts';

export const SESSION_DAYS = 30;
const STATE_MINUTES = 15;

export type User = {
  id: string; email: string; name: string | null; picture: string | null;
  plan: Plan; plan_status: string | null; plan_renews_at: number | null;
  stripe_customer_id: string | null; subscription_id: string | null; created_at: number;
  role?: string | null; // 'owner' sees the Spend page
  google_sub: string; // Google's account id; 'apple:<sub>' for an account made with Apple; 'email:<users.id>' for one made with email + password
  apple_sub?: string | null; // Sign in with Apple (google_sub is 'apple:<sub>' for accounts made with Apple)
  apple_refresh?: string | null;
  password_hash?: string | null; // email + password sign-in (password.ts); never sent anywhere
  email_unverified?: number | null; // 1: made with Sign in with Apple from an email Apple hadn't verified
};

// SQL for an account that may be found by its email (to link a sign-in to,
// or for email + password): not one made with Sign in with Apple from an
// email Apple hadn't verified, which anyone could have typed.
export const VERIFIED_EMAIL = 'COALESCE(email_unverified, 0) = 0';

export function cookieName(url: URL) { return url.protocol === 'https:' ? '__Host-lumio_session' : 'lumio_session'; }

export function sessionCookie(url: URL, token: string, maxAge: number) {
  return `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
}

// The session token from the cookie (website) or Authorization header (Lumio Browser).
export function readToken(request: Request): string | null {
  const bearer = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (bearer) return bearer;
  const c = cookies(request)[cookieName(new URL(request.url))];
  return c && /^[a-f0-9]{64}$/.test(c) ? c : null;
}

export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = readToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2`).bind(await sha256(token), Date.now()).first<User>();
  return row ? expireCodePlan(env, row) : null;
}

// The shape lumio-usa.online's /api/account has always had (Lumio Browser reads it).
// authMethod: how the account was made (and linked), not how this session signed in.
export function accountJson(user: User | null) {
  if (!user) return { signedIn: false, ownerId: null, authMethod: 'guest', email: null, profile: null, username: null, publicUsername: null };
  const authMethod = user.google_sub?.startsWith('apple:') ? 'apple' : user.google_sub?.startsWith('email:') ? 'email' : 'google';
  return {
    signedIn: true, ownerId: user.id, authMethod, email: user.email, profile: { name: user.name, picture: user.picture }, username: null, publicUsername: null,
    plan: { id: user.plan, status: user.plan_status, renewsAt: user.plan_renews_at },
  };
}

// ---------------------------------------------------------------- Google
export async function googleStart(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return redirect('/signin?error=unavailable');
  const state = randomHex(24);
  const verifier = randomHex(32);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const next = safeNext(url.searchParams.get('next'));
  await env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(Date.now() - STATE_MINUTES * 60_000).run();
  await env.DB.prepare('INSERT INTO oauth_states (state, verifier, next, created_at) VALUES (?1, ?2, ?3, ?4)').bind(state, verifier, next, Date.now()).run();
  const auth = new URL(env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return redirect(auth.toString());
}

function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch { return null; }
}

export async function googleCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const saved = await env.DB.prepare('SELECT verifier, next, created_at FROM oauth_states WHERE state = ?1').bind(state).first<{ verifier: string; next: string; created_at: number }>();
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?1').bind(state).run();
  if (!saved || Date.now() - saved.created_at > STATE_MINUTES * 60_000) return redirect('/signin?error=expired');
  if (!code) return redirect('/signin?error=cancelled');
  // The ID token comes straight from Google's token endpoint over HTTPS with
  // our client secret, so its claims can be read without a signature check.
  const res = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID || '', client_secret: env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: `${url.origin}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: saved.verifier,
    }),
  });
  const data = res.ok ? await res.json<{ id_token?: string }>() : null;
  const claims = data?.id_token ? decodeJwt(data.id_token) : null;
  const ok = claims && claims.aud === env.GOOGLE_CLIENT_ID && ['https://accounts.google.com', 'accounts.google.com'].includes(String(claims.iss))
    && typeof claims.sub === 'string' && typeof claims.email === 'string' && claims.email_verified === true && Number(claims.exp) * 1000 > Date.now();
  if (!ok) return redirect('/signin?error=google');

  const sub = claims.sub as string;
  const email = (claims.email as string).toLowerCase();
  const name = typeof claims.name === 'string' ? claims.name.slice(0, 80) : null;
  const picture = typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture.slice(0, 500) : null;
  const now = Date.now();
  let user = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?1').bind(sub).first<{ id: string }>();
  // An account made with Sign in with Apple, or with email + password, and the
  // same email: Google joins it (the one with a password first; never one
  // whose email Apple hadn't verified).
  if (!user) {
    user = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1 AND (google_sub LIKE 'apple:%' OR google_sub LIKE 'email:%') AND ${VERIFIED_EMAIL}
        ORDER BY (password_hash IS NOT NULL) DESC, created_at LIMIT 1`).bind(email).first<{ id: string }>();
    if (user) await env.DB.prepare('UPDATE users SET google_sub = ?2 WHERE id = ?1').bind(user.id, sub).run();
  }
  if (user) {
    // The email follows Google's, except on an account with a password (it signs in with that email).
    await env.DB.prepare('UPDATE users SET email = CASE WHEN password_hash IS NULL THEN ?2 ELSE email END, name = ?3, picture = ?4 WHERE id = ?1').bind(user.id, email, name, picture).run();
  } else {
    user = { id: 'u_' + randomHex(12) };
    await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, plan, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'free', ?6)").bind(user.id, sub, email, name, picture, now).run();
  }
  const token = await newSession(env, user.id);
  return redirect(saved.next, { 'set-cookie': sessionCookie(url, token, SESSION_DAYS * 86400) });
}

// A new session for the user: the token (only its hash is stored).
export async function newSession(env: Env, userId: string) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 86400_000).run();
  return token;
}

export async function logout(request: Request, env: Env) {
  const token = readToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(new URL(request.url), '', 0) });
}

// ---------------------------------------------------------------- the phone app
// The Lumio app signs in in the phone's browser (Google doesn't allow its
// sign-in inside an app's web view), then this hands the app a one-time code
// for its own session: GET /api/auth/app/finish (signed in, in the browser)
// sends lumio://auth?code=…; the app's web view posts the code to
// /api/auth/app/session, which sets its session cookie. Codes last 2 minutes
// and work once.
//
// Lumio for iPhone and iPad signs in with Google the same way, in the
// system's sign-in sheet (ASWebAuthenticationSession), with PKCE: it opens
// /api/auth/google/start?next=/api/auth/app/finish?challenge=<S256 of a
// secret>&end=1, and trades the code plus the secret for a session token at
// POST /api/auth/app/token (JSON), so a code that leaks is useless. `end=1`
// also ends the sheet's own browser session, which nobody uses afterwards.
const APP_CODE_MS = 2 * 60 * 1000;

export async function appFinish(request: Request, env: Env) {
  const url = new URL(request.url);
  const user = await currentUser(request, env);
  if (!user) return redirect(`/signin?next=${url.search ? encodeURIComponent(url.pathname + url.search) : url.pathname}`);
  const challenge = url.searchParams.get('challenge');
  if (challenge !== null && !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return redirect('/signin?error=expired');
  const code = randomHex(24);
  await env.DB.prepare('INSERT INTO app_codes (code_hash, user_id, created_at, challenge) VALUES (?1, ?2, ?3, ?4)').bind(await sha256(code), user.id, Date.now(), challenge).run();
  if (url.searchParams.get('end') === '1') {
    const token = readToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
    return redirect(`lumio://auth?code=${code}`, { 'set-cookie': sessionCookie(url, '', 0) });
  }
  return redirect(`lumio://auth?code=${code}`);
}

// POST /api/auth/app/token { code, verifier } (Lumio for iPhone and iPad):
// the session token for a code made with a PKCE challenge, as JSON.
export async function appToken(request: Request, env: Env) {
  const b = await request.json<{ code?: unknown; verifier?: unknown }>().catch(() => null);
  const code = typeof b?.code === 'string' ? b.code : '';
  const verifier = typeof b?.verifier === 'string' ? b.verifier : '';
  const expired = () => fail('That sign-in didn’t finish in time. Try again.', 400, 'invalid_code');
  if (!/^[a-f0-9]{48}$/.test(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return expired();
  const hash = await sha256(code);
  const row = await env.DB.prepare('SELECT user_id, created_at, challenge FROM app_codes WHERE code_hash = ?1').bind(hash).first<{ user_id: string; created_at: number; challenge: string | null }>();
  await env.DB.prepare('DELETE FROM app_codes WHERE code_hash = ?1 OR created_at < ?2').bind(hash, Date.now() - APP_CODE_MS).run();
  if (!row || row.created_at < Date.now() - APP_CODE_MS || !row.challenge) return expired();
  const expected = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  if (expected !== row.challenge) return expired();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(row.user_id).first<User>();
  if (!user) return expired();
  return json({ token: await newSession(env, user.id), account: accountJson(user) });
}

export async function appSession(request: Request, env: Env) {
  const url = new URL(request.url);
  const form = await request.formData().catch(() => null);
  const code = String(form?.get('code') || '');
  if (!/^[a-f0-9]{48}$/.test(code)) return redirect('/companion');
  const hash = await sha256(code);
  const row = await env.DB.prepare('SELECT user_id, created_at, challenge FROM app_codes WHERE code_hash = ?1').bind(hash).first<{ user_id: string; created_at: number; challenge: string | null }>();
  await env.DB.prepare('DELETE FROM app_codes WHERE code_hash = ?1 OR created_at < ?2').bind(hash, Date.now() - APP_CODE_MS).run();
  // A code made with a PKCE challenge only works with its verifier (POST /api/auth/app/token).
  if (!row || row.created_at < Date.now() - APP_CODE_MS || row.challenge) return redirect('/companion');
  const token = await newSession(env, row.user_id);
  return new Response(null, { status: 303, headers: { location: '/companion', 'set-cookie': sessionCookie(url, token, SESSION_DAYS * 86400) } });
}
