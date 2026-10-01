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
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API?: string; // tests
  FREE_DAILY_CAP_USD?: string; // total Free-plan AI spend per day, across everyone
  // Connections (Google Drive/Gmail/Calendar, Microsoft Outlook/OneDrive)
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  CONNECTIONS_KEY?: string; // base64 of 32 random bytes: encrypts connection tokens
  MICROSOFT_AUTH_URL?: string; // tests
  MICROSOFT_TOKEN_URL?: string; // tests
  GOOGLE_API?: string; // tests
  GRAPH_API?: string; // tests
}

export { AgentError };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
export const fail = (message: string, status: number, code: string) => json({ error: message, code }, status);

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
