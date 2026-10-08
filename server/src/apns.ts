// Notifications for Lumio for iPhone and iPad, through Apple's push service
// (APNs). Like the companion's other pushes, they say only what kind of thing
// happened ("Lumio needs your OK."): the details are end-to-end encrypted, and
// the app fetches and opens them itself.
//
// The app subscribes with POST /api/companion/push { device, endpoint:
// "apns:<device token>" } ("apns-sandbox:<token>" for builds signed for
// development, which Apple's sandbox serves).
//
// Setup (secrets): an Apple key with "Apple Push Notifications service"
// enabled. APNS_KEY_ID and APNS_PRIVATE_KEY (the .p8, PEM) name it; without
// them the Sign in with Apple key is used (APPLE_KEY_ID, APPLE_PRIVATE_KEY),
// which works when APNs is enabled on that same key. The team is APNS_TEAM_ID,
// else APPLE_TEAM_ID. The topic is APNS_TOPIC, else the app's bundle id.
// Without a key, APNs subscriptions are kept but nothing is sent: the app
// still checks for news while it's open.
import type { Env } from './util.ts';
import { base64url } from './util.ts';

const PRODUCTION = 'https://api.push.apple.com';
const SANDBOX = 'https://api.sandbox.push.apple.com';
const DEFAULT_TOPIC = 'online.lumio-usa.lumio';
// Apple wants the same provider token reused for 20 to 60 minutes.
const TOKEN_TTL = 40 * 60 * 1000;

export const APNS_ENDPOINT = /^apns(-sandbox)?:([a-f0-9]{64,200})$/;

const keyId = (env: Env) => env.APNS_KEY_ID || env.APPLE_KEY_ID || '';
const privateKey = (env: Env) => env.APNS_PRIVATE_KEY || env.APPLE_PRIVATE_KEY || '';
const teamId = (env: Env) => env.APNS_TEAM_ID || env.APPLE_TEAM_ID || '';

export const apnsConfigured = (env: Env) => !!(keyId(env) && privateKey(env) && teamId(env));

let cached: { at: number; kid: string; team: string; key: string; jwt: string } | null = null;

// The ES256 provider token APNs wants (cached).
export async function providerToken(env: Env, now = Date.now()) {
  const kid = keyId(env);
  const team = teamId(env);
  if (cached && cached.kid === kid && cached.team === team && cached.key === privateKey(env) && now - cached.at < TOKEN_TTL) return cached.jwt;
  const pem = privateKey(env).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const te = new TextEncoder();
  const head = base64url(te.encode(JSON.stringify({ alg: 'ES256', kid })));
  const body = base64url(te.encode(JSON.stringify({ iss: team, iat: Math.floor(now / 1000) })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${head}.${body}`)));
  const jwt = `${head}.${body}.${base64url(sig)}`;
  cached = { at: now, kid, team, key: privateKey(env), jwt };
  return jwt;
}

export function forgetProviderToken() {
  cached = null;
}

// Sends one notification. Returns 'gone' when Apple says the token is no
// longer valid (the subscription should be removed), else 'sent' or 'failed'.
export async function sendApns(env: Env, endpoint: string, { body, hint }: { body: string; hint: string }): Promise<'sent' | 'gone' | 'failed'> {
  const m = APNS_ENDPOINT.exec(endpoint);
  if (!m || !apnsConfigured(env)) return 'failed';
  const base = m[1] ? env.APNS_SANDBOX_URL || SANDBOX : env.APNS_URL || PRODUCTION;
  const topic = env.APNS_TOPIC || (env.APPLE_AUDIENCES || DEFAULT_TOPIC).split(',')[0].trim() || DEFAULT_TOPIC;
  let res: Response;
  try {
    res = await fetch(`${base}/3/device/${m[2]}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${await providerToken(env)}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        aps: { alert: { title: 'Lumio', body }, sound: 'default', 'thread-id': 'lumio-companion' },
        lumio: { notice: true, hint },
      }),
    });
  } catch {
    return 'failed';
  }
  if (res.ok) return 'sent';
  const reason = (await res.json<{ reason?: string }>().catch(() => null))?.reason || '';
  if (res.status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic' || reason === 'Unregistered') return 'gone';
  // A provider token Apple no longer accepts: make a new one next time.
  if (res.status === 403 && /ProviderToken/.test(reason)) forgetProviderToken();
  return 'failed';
}
