// Lumio accounts: sign in with Google, then a session cookie (and, for Lumio
// Browser, the same session sent as a bearer token). Sessions are stored by a
// hash of the token, never the token itself.
import { type Env, base64url, cookies, json, randomHex, redirect, safeNext, sha256 } from './util.ts';
import type { Plan } from './agent.ts';

export const SESSION_DAYS = 30;
const STATE_MINUTES = 15;

export type User = {
  id: string; email: string; name: string | null; picture: string | null;
  plan: Plan; plan_status: string | null; plan_renews_at: number | null;
  stripe_customer_id: string | null; subscription_id: string | null; created_at: number;
  role?: string | null; // 'owner' sees the Spend page
};

export function cookieName(url: URL) { return url.protocol === 'https:' ? '__Host-lumio_session' : 'lumio_session'; }

function sessionCookie(url: URL, token: string, maxAge: number) {
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
  return row || null;
}

// The shape lumio-usa.online's /api/account has always had (Lumio Browser reads it).
export function accountJson(user: User | null) {
  if (!user) return { signedIn: false, ownerId: null, authMethod: 'guest', email: null, profile: null, username: null, publicUsername: null };
  return {
    signedIn: true, ownerId: user.id, authMethod: 'google', email: user.email, profile: { name: user.name, picture: user.picture }, username: null, publicUsername: null,
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
  if (user) {
    await env.DB.prepare('UPDATE users SET email = ?2, name = ?3, picture = ?4 WHERE id = ?1').bind(user.id, email, name, picture).run();
  } else {
    user = { id: 'u_' + randomHex(12) };
    await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, plan, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'free', ?6)").bind(user.id, sub, email, name, picture, now).run();
  }
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256(token), user.id, now, now + SESSION_DAYS * 86400_000).run();
  return redirect(saved.next, { 'set-cookie': sessionCookie(url, token, SESSION_DAYS * 86400) });
}

export async function logout(request: Request, env: Env) {
  const token = readToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(new URL(request.url), '', 0) });
}
