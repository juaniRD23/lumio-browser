// Small helpers shared by the Lumio server's routes.
import { AgentError } from './agent.ts';

export interface Env {
  DB: D1Database;
  FILES?: R2Bucket; // attachments and made images
  ASSETS?: Fetcher; // the website (website/public)
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE?: string; // tests point this at a stand-in
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_AUTH_URL?: string; // tests
  GOOGLE_TOKEN_URL?: string; // tests
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string; // for Stripe's payment form inside Lumio's /checkout page
  VAPID_PUBLIC_KEY?: string; // Web Push for the phone companion (base64url P-256 public key)
  VAPID_PRIVATE_KEY?: string; // and its private key, as a JWK (JSON)
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API?: string; // tests
  FREE_DAILY_CAP_USD?: string; // total Free-plan AI spend per day, across everyone
  // Connections (Google Drive/Gmail/Calendar, Microsoft Outlook/OneDrive)
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  CONNECTIONS_KEY?: string; // base64 of 32 random bytes: encrypts connection tokens
  SYNC_MASTER_KEY?: string; // base64 of 32 random bytes: wraps each managed account's sync key (sync-keys.ts). Never replace it.
  MICROSOFT_AUTH_URL?: string; // tests
  MICROSOFT_TOKEN_URL?: string; // tests
  GOOGLE_API?: string; // tests
  GRAPH_API?: string; // tests
  // Sign in with Apple (Lumio for iPhone and iPad). APPLE_AUDIENCES: the app's
  // bundle id (comma-separated if more). The key lets Lumio revoke Apple's
  // token when an account is deleted: the team id, the key's id and the key
  // (.p8, PEM) of a "Sign in with Apple" key from the Apple developer account.
  APPLE_AUDIENCES?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  APPLE_KEYS_URL?: string; // tests
  APPLE_TOKEN_URL?: string; // tests
  APPLE_REVOKE_URL?: string; // tests
  // Notifications for Lumio for iPhone and iPad (APNs, apns.ts): a key with
  // Apple Push Notifications enabled. Each falls back to its APPLE_* twin
  // above (one Apple key can do both). APNS_TOPIC: the app's bundle id.
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APNS_URL?: string; // tests
  APNS_SANDBOX_URL?: string; // tests
  // Email + password sign-in (email-auth.ts): its codes go out through Resend.
  // Without the key, email sign-up and password resets aren't available yet.
  RESEND_API_KEY?: string;
  CODE_KEY?: string; // base64 of 32 random bytes: keys the email code hashes (HMAC); without it, email sign-in isn't available either
  EMAIL_FROM?: string; // default 'Lumio <no-reply@lumio-co.online>'
  RESEND_API_URL?: string; // tests
}

export { AgentError };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
export const fail = (message: string, status: number, code: string, headers: Record<string, string> = {}) => json({ error: message, code }, status, headers);

export function redirect(location: string, headers: Record<string, string> = {}) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });
}

export async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compares secrets without leaking where they differ: Workers have
// crypto.subtle.timingSafeEqual; Node (where the tests run) doesn't.
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function base64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Browser forms and fetches from our own pages only (cookie-authenticated POSTs).
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

export function cookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Only paths on this site, so a sign-in can't bounce people elsewhere.
export function safeNext(next: string | null, fallback = '/account') {
  return next && /^\/(?!\/)[\w\-./?=&#%]*$/.test(next) ? next : fallback;
}
