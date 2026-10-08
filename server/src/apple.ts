// Sign in with Apple, for Lumio for iPhone and iPad (App Store guideline 4.8:
// offered next to Google).
//
// POST /api/auth/apple { identityToken, nonce, name?, authorizationCode? }
// The app gets an identity token (a JWT signed by Apple) from the system's
// Sign in with Apple sheet. Lumio checks its signature against Apple's
// published keys, that it was made for this app (the audience), that it's
// fresh, and that it carries the SHA-256 of the one-time `nonce` the app made
// (so a token can't be replayed). Then it finds the account (by Apple's id,
// or by the same verified email as an existing account) or makes one, and
// answers with a session token, which the app keeps in the Keychain. An
// account made from an email Apple hasn't verified is marked
// (email_unverified), so no other sign-in finds it by that email.
//
// When the Apple key is configured (APPLE_TEAM_ID, APPLE_KEY_ID,
// APPLE_PRIVATE_KEY), the authorization code is traded for a refresh token,
// kept encrypted, so deleting the account can revoke it (Apple requires that).
import { accountJson, newSession, type User } from './auth.ts';
import { AgentError, type Env, base64url, fail, json, randomHex, sha256 } from './util.ts';

const ISSUER = 'https://appleid.apple.com';
const DEFAULT_AUDIENCE = 'online.lumio-usa.lumio';
const KEYS_TTL = 60 * 60 * 1000;

type Jwk = { kty: string; kid: string; alg?: string; n: string; e: string; use?: string };
let keysCache: { at: number; url: string; keys: Jwk[] } | null = null;

const audiences = (env: Env) => (env.APPLE_AUDIENCES || DEFAULT_AUDIENCE).split(',').map((s) => s.trim()).filter(Boolean);

function fromB64url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const jsonPart = (s: string) => { try { return JSON.parse(new TextDecoder().decode(fromB64url(s))) as Record<string, unknown>; } catch { return null; } };

// Apple's signing keys (https://appleid.apple.com/auth/keys), cached an hour;
// looked up again when a token names a key we don't have (Apple rotates them).
async function appleKeys(env: Env, fresh = false): Promise<Jwk[]> {
  const url = env.APPLE_KEYS_URL || `${ISSUER}/auth/keys`;
  if (!fresh && keysCache && keysCache.url === url && Date.now() - keysCache.at < KEYS_TTL) return keysCache.keys;
  const res = await fetch(url);
  const data = res.ok ? await res.json<{ keys?: Jwk[] }>().catch(() => null) : null;
  if (!Array.isArray(data?.keys)) throw new AgentError('Couldn’t reach Apple to check the sign-in. Try again.', 502, 'apple_unavailable');
  keysCache = { at: Date.now(), url, keys: data.keys };
  return data.keys;
}

// The token's claims when it's a valid Apple sign-in for this app, else null.
export async function verifyAppleToken(env: Env, token: string, rawNonce: string, now = Date.now()) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = jsonPart(parts[0]);
  const claims = jsonPart(parts[1]);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  let jwk = (await appleKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await appleKeys(env, true)).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA') return null;
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), signed))) return null;
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  const ok = claims.iss === ISSUER && audiences(env).includes(aud)
    && Number(claims.exp) * 1000 > now && Number(claims.iat || 0) * 1000 < now + 5 * 60_000
    && typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 255
    && typeof claims.nonce === 'string' && claims.nonce === await sha256(rawNonce);
  return ok ? claims : null;
}

// The ES256 client secret Apple's token and revoke calls want.
async function clientSecret(env: Env, clientId: string) {
  const pem = String(env.APPLE_PRIVATE_KEY || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const te = new TextEncoder();
  const iat = Math.floor(Date.now() / 1000);
  const head = base64url(te.encode(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID })));
  const body = base64url(te.encode(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat, exp: iat + 300, aud: ISSUER, sub: clientId })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64url(sig)}`;
}
const canRevoke = (env: Env) => !!(env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY && env.CONNECTIONS_KEY);

// Apple's refresh token is kept encrypted with CONNECTIONS_KEY (AES-GCM).
async function aes(env: Env) {
  return crypto.subtle.importKey('raw', Uint8Array.from(atob(env.CONNECTIONS_KEY || ''), (c) => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealRefresh(env: Env, value: { token: string; clientId: string }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(env), new TextEncoder().encode(JSON.stringify(value))));
  return `${base64url(iv)}.${base64url(ct)}`;
}
async function openRefresh(env: Env, sealed: string): Promise<{ token: string; clientId: string } | null> {
  try {
    const [iv, ct] = sealed.split('.').map(fromB64url);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aes(env), ct)));
  } catch { return null; }
}

// Trades the authorization code for Apple's refresh token and keeps it.
async function keepRefreshToken(env: Env, userId: string, clientId: string, code: string) {
  const res = await fetch(env.APPLE_TOKEN_URL || `${ISSUER}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: await clientSecret(env, clientId), code, grant_type: 'authorization_code' }),
  });
  const data = res.ok ? await res.json<{ refresh_token?: string }>().catch(() => null) : null;
  if (!data?.refresh_token) return;
  await env.DB.prepare('UPDATE users SET apple_refresh = ?2 WHERE id = ?1').bind(userId, await sealRefresh(env, { token: data.refresh_token, clientId })).run();
}

// Deleting the account: tells Apple to end Lumio's access. Best effort.
export async function revokeApple(env: Env, user: User) {
  if (!user.apple_refresh || !canRevoke(env)) return;
  const t = await openRefresh(env, user.apple_refresh);
  if (!t) return;
  await fetch(env.APPLE_REVOKE_URL || `${ISSUER}/auth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: t.clientId, client_secret: await clientSecret(env, t.clientId), token: t.token, token_type_hint: 'refresh_token' }),
  }).catch(() => {});
}

// The name the app passes along the first time (Apple sends it only then).
function cleanName(name: unknown) {
  const text = typeof name === 'string' ? name : name && typeof name === 'object'
    ? [(name as Record<string, unknown>).givenName, (name as Record<string, unknown>).familyName].filter((p) => typeof p === 'string').join(' ')
    : '';
  const clean = text.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || null;
}

// POST /api/auth/apple
export async function appleSignIn(request: Request, env: Env, ctx: ExecutionContext) {
  const b = await request.json<{ identityToken?: unknown; nonce?: unknown; name?: unknown; authorizationCode?: unknown }>().catch(() => null);
  const token = typeof b?.identityToken === 'string' && b.identityToken.length < 8192 ? b.identityToken : '';
  const nonce = typeof b?.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(b.nonce) ? b.nonce : '';
  if (!token || !nonce) return fail('Sign in with Apple didn’t finish. Try again.', 400, 'invalid_request');
  const claims = await verifyAppleToken(env, token, nonce);
  if (!claims) return fail('Sign in with Apple didn’t work. Try again.', 401, 'apple_invalid');

  const sub = claims.sub as string;
  const email = typeof claims.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(claims.email) ? claims.email.toLowerCase().slice(0, 254) : null;
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  const name = cleanName(b?.name);
  const now = Date.now();
  let user = await env.DB.prepare('SELECT * FROM users WHERE apple_sub = ?1').bind(sub).first<User>();
  if (!user && email && verified) {
    // The same person's Lumio account from Google or email + password (same verified email): link it.
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1 AND apple_sub IS NULL ORDER BY (password_hash IS NOT NULL) DESC, created_at LIMIT 1').bind(email).first<User>();
    if (user) await env.DB.prepare('UPDATE users SET apple_sub = ?2 WHERE id = ?1').bind(user.id, sub).run();
  }
  // 1 when Apple hasn't verified the email (NULL: it has).
  const unverified = verified ? null : 1;
  if (!user) {
    if (!email) return fail('Lumio needs an email address for your account. Sign in again and choose Share My Email or Hide My Email.', 400, 'email_required');
    const id = 'u_' + randomHex(12);
    // google_sub is required (and unique): accounts made with Apple hold 'apple:<sub>' until they also sign in with Google.
    await env.DB.prepare("INSERT INTO users (id, google_sub, apple_sub, email, name, picture, plan, created_at, email_unverified) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'free', ?6, ?7)")
      .bind(id, `apple:${sub}`, sub, email, name, now, unverified).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<User>();
  } else {
    // Accounts made with Apple follow Apple's email (it can change), and whether
    // Apple verified it, unless they have a password (they sign in with that
    // email); a name the app sends fills an empty one.
    const appleOnly = user.google_sub.startsWith('apple:') && !user.password_hash;
    const follow = !!(appleOnly && email && (email !== user.email || !!user.email_unverified !== !verified));
    if (follow || (name && !user.name)) {
      const changed = { email: follow ? email! : user.email, email_unverified: follow ? unverified : user.email_unverified ?? null, name: user.name || name };
      await env.DB.prepare('UPDATE users SET email = ?2, name = ?3, email_unverified = ?4 WHERE id = ?1').bind(user.id, changed.email, changed.name, changed.email_unverified).run();
      user = { ...user, ...changed };
    }
  }
  if (!user) return fail('Lumio hit a problem. Try again.', 500, 'server_error');
  const code = typeof b?.authorizationCode === 'string' && /^[A-Za-z0-9._-]{8,512}$/.test(b.authorizationCode) ? b.authorizationCode : null;
  if (code && canRevoke(env)) ctx.waitUntil(keepRefreshToken(env, user.id, claims.aud as string, code).catch((err) => console.error('lumio apple token', err)));
  const session = await newSession(env, user.id);
  return json({ token: session, account: accountJson(user) });
}
