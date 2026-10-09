// Lumio Sync's keys (docs/sync-managed.md): how a device gets the account's
// sync key. Records are encrypted on the devices with it either way (sync.ts,
// main/sync/crypto.js); only the way the key reaches a new device changes.
//
// Managed mode (the default, like Chrome's): the server keeps the key wrapped
// (AES-256-GCM) with SYNC_MASTER_KEY, a Worker secret only the server has, and
// bound to the account's id, and hands it to the account's signed-in devices,
// so signing in is all a new device needs. Passphrase mode ("Encrypt with my
// own passphrase" in Lumio Browser): the server never has the key, and new
// devices are approved from one that has it, or use the recovery key.
//
//   POST /api/sync/key    {}: the account's key { status: 'ready', key, keyCheck, created },
//                         made here for an account that has none, or { status: 'waiting',
//                         keyCheck } while an account's devices haven't uploaded theirs
//   PUT  /api/sync/key    { key }: a device that has the key uploads it (an account that
//                         synced before managed mode, or after SYNC_MASTER_KEY changed)
//   PUT  /api/sync/mode   { mode: 'passphrase', keyCheck } (a new key, made on the device)
//                         | { mode: 'managed', key } (the account's current key, from a device
//                         that has it, for the server to keep; never for an account with nothing synced)
//   POST /api/sync/reset  { confirm: true }: deletes what's synced and makes a new key
// Older Lumio builds that ask to be approved (GET /api/sync/pair/:id) are
// approved by the server itself in managed mode (autoApproval).
//
// The key only ever travels in request and response bodies: never in a URL, a
// log line or an error. The apps send their session as a bearer token; the
// website's cookie only counts from our own pages (keyGuard). Reads and changes
// are limited per account and per network address (sync_key_events, an hour).
import { readToken } from './auth.ts';
import { ipKey } from './crashes.ts';
import { AgentError, type Env, fail, json, sha256, timingSafeEqual } from './util.ts';

type User = { id: string };
type Kind = 'read' | 'write';

const HOUR = 3600_000;
// Per account and per network address, an hour. Reads: keys handed out
// (including auto-approved pairings). Writes: uploads, mode changes, resets.
const LIMITS: Record<Kind, { owner: number; ip: number }> = { read: { owner: 30, ip: 120 }, write: { owner: 10, ip: 30 } };
const KEY = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64
const CHECK = /^[a-f0-9]{32}$/;
const WRAPPED = /^v1\.([A-Za-z0-9+/]{16})\.([A-Za-z0-9+/]{64})$/; // 12-byte IV, 32-byte key + 16-byte tag

const te = new TextEncoder();
const now = () => Date.now();
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const same = (a: string, b: string) => timingSafeEqual(te.encode(a), te.encode(b));

const UNAVAILABLE = 'Lumio Sync can’t hand out keys right now. Try again later.';
const unavailable = () => fail(UNAVAILABLE, 503, 'sync_keys_unavailable');
// WebCrypto failures become this fixed error (never logged, never with key material).
const cryptoFailed = () => new AgentError(UNAVAILABLE, 503, 'sync_keys_unavailable');
const passphraseMode = () => fail('This account encrypts sync with its own passphrase. Approve this device from another one, or use the recovery key.', 409, 'passphrase_mode');
const mismatch = () => fail('That key isn’t this account’s sync key.', 409, 'key_mismatch');
const invalid = (message = 'Invalid request.') => fail(message, 400, 'invalid_request');
const tooMany = () => fail('Too many requests. Try again in a few minutes.', 429, 'rate_limited', { 'retry-after': '600' });

async function body(request: Request): Promise<Record<string, unknown>> {
  const b = await request.json<Record<string, unknown>>().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new AgentError('Invalid request.', 400, 'invalid_request');
  return b;
}

// A sync key as a device sends it: standard base64 of exactly 32 bytes.
function keyFrom(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || !KEY.test(v)) return null;
  try {
    const raw = fromB64(v);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- wrapping
// SYNC_MASTER_KEY: base64 of exactly 32 bytes. Anything else (or none) means
// managed sync isn't available, and devices keep today's end-to-end flow.
function master(env: Env): Uint8Array | null {
  try {
    const bytes = fromB64(env.SYNC_MASTER_KEY || '');
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function managedAvailable(env: Env): boolean {
  return master(env) !== null;
}

async function masterKey(env: Env) {
  const bytes = master(env);
  if (!bytes) throw cryptoFailed();
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// The wrapped key is bound to its account: copied into another account's row,
// it doesn't unwrap. v1 is SYNC_MASTER_KEY's id (a later SYNC_MASTER_KEY_V2
// would write v2 and re-wrap v1 keys as they're read).
const aad = (owner: string) => te.encode(`lumio-sync-key|v1|${owner}`);

// The key's check value, as crypto.js deriveKeys() makes it: HKDF-SHA256 (salt
// 'lumio-sync-v1', info 'ids') gives an HMAC-SHA256 key; the check is the first
// 32 hex characters of its HMAC of 'lumio-sync-check'.
export async function keyCheckOf(raw: Uint8Array): Promise<string> {
  try {
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const hmac = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('lumio-sync-v1'), info: te.encode('ids') }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, te.encode('lumio-sync-check')));
    return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch {
    throw cryptoFailed();
  }
}

// 'v1.' + base64(IV) + '.' + base64(ciphertext and tag): AES-256-GCM with
// SYNC_MASTER_KEY, a random 12-byte IV, and the account bound in. (iv: tests.)
export async function wrapKey(env: Env, owner: string, raw: Uint8Array, iv = crypto.getRandomValues(new Uint8Array(12))): Promise<string> {
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner) }, await masterKey(env), raw));
    return `v1.${toB64(iv)}.${toB64(ct)}`;
  } catch {
    throw cryptoFailed();
  }
}

// The raw key, or null for anything that isn't a v1 key wrapped for this account.
export async function unwrapKey(env: Env, owner: string, wrapped: string): Promise<Uint8Array | null> {
  try {
    const m = WRAPPED.exec(wrapped);
    if (!m) return null;
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(m[1]), additionalData: aad(owner) }, await masterKey(env), fromB64(m[2])));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the account's state
// Its mode (no sync_keys row: managed), the key check devices sync with
// (sync_meta), and the wrapped key with its check. managedKey: the wrapped key
// is for the account's current key (from the database; nothing is unwrapped).
export async function keyState(env: Env, owner: string) {
  const r = await env.DB.prepare(`SELECT m.key_check AS meta_check, k.mode, k.wrapped, k.key_check FROM (SELECT ?1 AS owner) o
    LEFT JOIN sync_meta m ON m.owner = o.owner LEFT JOIN sync_keys k ON k.owner = o.owner`).bind(owner)
    .first<{ meta_check: string | null; mode: string | null; wrapped: string | null; key_check: string | null }>();
  const metaCheck = r?.meta_check || null;
  const wrapped = r?.wrapped || null;
  const keyCheck = r?.key_check || null;
  return {
    mode: r?.mode === 'passphrase' ? 'passphrase' as const : 'managed' as const,
    metaCheck,
    wrapped,
    keyCheck,
    managedKey: !!(wrapped && metaCheck && keyCheck === metaCheck),
  };
}
type KeyState = Awaited<ReturnType<typeof keyState>>;

// The key the server keeps for a managed account, when it unwraps and matches
// the account's check. One that doesn't (SYNC_MASTER_KEY was replaced, or the
// row came from another account) is dropped, so a device that still has the
// key uploads it again; the others wait for it.
async function storedKey(env: Env, owner: string, s: KeyState): Promise<Uint8Array | null> {
  if (!managedAvailable(env) || s.mode !== 'managed' || !s.metaCheck || !s.wrapped || !s.keyCheck || !same(s.keyCheck, s.metaCheck)) return null;
  const raw = await unwrapKey(env, owner, s.wrapped);
  if (raw && same(await keyCheckOf(raw), s.metaCheck)) return raw;
  await env.DB.prepare('UPDATE sync_keys SET wrapped = NULL, key_check = NULL, updated_at = ?2 WHERE owner = ?1 AND wrapped = ?3').bind(owner, now(), s.wrapped).run();
  console.error('lumio sync key: unwrap failed');
  return null;
}

// ---------------------------------------------------------------- guard and limits
// Before anything else on the key routes. The apps send their session as a
// bearer token, which another site's page can't make a browser send. The
// website's cookie only counts from our own pages: the same Origin, the
// X-Lumio-Sync: 1 header (a custom header, so another site's fetch would need
// a preflight, which nothing here answers), and Sec-Fetch-Site: same-origin
// when the browser sends it. No CORS headers, ever.
export function keyGuard(request: Request): Response | null {
  const auth = request.headers.get('authorization') || '';
  if (/^Bearer /.test(auth) && readToken(request) === auth.slice(7)) return null;
  const site = request.headers.get('sec-fetch-site');
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-lumio-sync') !== '1' || (site && site !== 'same-origin')) {
    return fail('Not allowed.', 403, 'forbidden');
  }
  return null;
}

// Records a read or change (or both, for a reset), then counts the account's
// and the network address's in the last hour with it included (recorded
// first, so parallel requests see each other). A request over the limit
// isn't kept: a device that keeps asking while it's refused (or an older
// device checking back on its pairing) can't keep the limit from ending, an
// hour after the last request that was served. A reset or DELETE /api/sync
// leaves these rows, so it can't reset the limits.
async function allowed(request: Request, env: Env, owner: string, ...kinds: Kind[]) {
  const t = now();
  const ipHash = (await sha256(`lumio-sync|${ipKey(request.headers.get('cf-connecting-ip'))}`)).slice(0, 32);
  const ids: number[] = [];
  let ok = true;
  for (const kind of kinds) {
    const row = await env.DB.prepare('INSERT INTO sync_key_events (owner, kind, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING rowid AS id')
      .bind(owner, kind, ipHash, t).first<{ id: number }>();
    if (row) ids.push(row.id);
  }
  for (const kind of kinds) {
    const n = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM sync_key_events WHERE owner = ?1 AND kind = ?2 AND created_at > ?4) AS owner,
        (SELECT COUNT(*) FROM sync_key_events WHERE ip_hash = ?3 AND kind = ?2 AND created_at > ?4) AS ip`)
      .bind(owner, kind, ipHash, t - HOUR).first<{ owner: number; ip: number }>();
    if ((n?.owner ?? 0) > LIMITS[kind].owner || (n?.ip ?? 0) > LIMITS[kind].ip) ok = false;
  }
  if (!ok) for (const id of ids) await env.DB.prepare('DELETE FROM sync_key_events WHERE rowid = ?1').bind(id).run();
  return ok;
}

// ---------------------------------------------------------------- routes
// The stored key; "waiting" for an account that syncs with a key its devices
// haven't uploaded yet; or, for an account with none (new, reset or deleted),
// a new key. Losing the race to make the first key (to an older device's
// /api/sync/init, another read or a mode switch) looks again, once.
async function handOut(env: Env, owner: string, again = true): Promise<Response> {
  const s = await keyState(env, owner);
  if (s.mode === 'passphrase') return passphraseMode();
  const stored = await storedKey(env, owner, s);
  if (stored) return json({ status: 'ready', key: toB64(stored), keyCheck: s.metaCheck, created: false });
  if (s.metaCheck || !again) return json({ status: 'waiting', keyCheck: s.metaCheck });
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const check = await keyCheckOf(raw);
  const wrapped = await wrapKey(env, owner, raw);
  const t = now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO sync_meta (owner, key_check, created_at) VALUES (?1, ?2, ?3)').bind(owner, check, t),
    env.DB.prepare(`INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at)
      SELECT ?1, 'managed', ?4, ?2, ?3, ?3 WHERE (SELECT key_check FROM sync_meta WHERE owner = ?1) = ?2
      ON CONFLICT(owner) DO UPDATE SET wrapped = excluded.wrapped, key_check = excluded.key_check, updated_at = excluded.updated_at
      WHERE sync_keys.mode = 'managed'`).bind(owner, check, t, wrapped),
  ]);
  const after = await keyState(env, owner);
  if (after.metaCheck && after.keyCheck && same(after.metaCheck, check) && same(after.keyCheck, check)) {
    return json({ status: 'ready', key: toB64(raw), keyCheck: check, created: true });
  }
  return handOut(env, owner, false);
}

// POST /api/sync/key: the account's key, for a signed-in device.
export async function syncKeyRead(request: Request, env: Env, user: User) {
  const refused = keyGuard(request);
  if (refused) return refused;
  if (!(await allowed(request, env, user.id, 'read'))) return tooMany();
  if (!managedAvailable(env)) return unavailable();
  return handOut(env, user.id);
}

// PUT /api/sync/key: a device that has the account's key hands it over, for an
// account that synced before managed mode (nothing is re-encrypted), or to
// repair one whose wrapped key no longer unwraps. Never in passphrase mode.
export async function syncKeyUpload(request: Request, env: Env, user: User) {
  const refused = keyGuard(request);
  if (refused) return refused;
  if (!(await allowed(request, env, user.id, 'write'))) return tooMany();
  if (!managedAvailable(env)) return unavailable();
  const raw = keyFrom((await body(request)).key);
  if (!raw) return invalid('Invalid key.');
  const s = await keyState(env, user.id);
  if (s.mode === 'passphrase') return passphraseMode();
  if (!s.metaCheck) return fail('Set up sync first.', 409, 'sync_not_set_up');
  const check = await keyCheckOf(raw);
  if (!same(check, s.metaCheck)) return mismatch();
  if (await storedKey(env, user.id, s)) return json({ ok: true, keyCheck: check });
  const wrapped = await wrapKey(env, user.id, raw);
  // Kept only while it's still the account's key and the account is still managed.
  const res = await env.DB.prepare(`INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at)
      SELECT ?1, 'managed', ?2, ?3, ?4, ?4 WHERE (SELECT key_check FROM sync_meta WHERE owner = ?1) = ?3
      ON CONFLICT(owner) DO UPDATE SET wrapped = excluded.wrapped, key_check = excluded.key_check, updated_at = excluded.updated_at
      WHERE sync_keys.mode = 'managed'`).bind(user.id, wrapped, check, now()).run();
  if (!res.meta.changes) return mismatch();
  return json({ ok: true, keyCheck: check });
}

// PUT /api/sync/mode (Lumio Browser's Settings › Sync › Advanced).
// To passphrase: the server forgets its copy of the key and everything it
// could decrypt; the device that switched uploads again with its new key, and
// the account's other devices are approved again (or use the recovery key).
// Back to managed: the account's current key (sync_meta's check), from a
// device that has it, for the server to keep.
export async function syncMode(request: Request, env: Env, user: User) {
  const refused = keyGuard(request);
  if (refused) return refused;
  if (!(await allowed(request, env, user.id, 'write'))) return tooMany();
  const b = await body(request);
  const id = user.id;
  if (b.mode === 'passphrase') {
    const check = typeof b.keyCheck === 'string' && CHECK.test(b.keyCheck) ? b.keyCheck : null;
    if (!check) return invalid('Invalid key check.');
    if ((await keyState(env, id)).mode === 'passphrase') return fail('This account already encrypts sync with its own passphrase.', 409, 'already_passphrase');
    const t = now();
    // Devices and push subscriptions stay; the computers' companion status
    // (sealed with the old key) goes with the rest.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sync_items WHERE owner = ?1').bind(id),
      env.DB.prepare('DELETE FROM sync_meta WHERE owner = ?1').bind(id),
      env.DB.prepare('DELETE FROM sync_pairings WHERE owner = ?1').bind(id),
      env.DB.prepare('DELETE FROM companion_messages WHERE owner = ?1').bind(id),
      env.DB.prepare('UPDATE sync_devices SET status = NULL, status_at = NULL WHERE owner = ?1').bind(id),
      env.DB.prepare('INSERT INTO sync_meta (owner, key_check, created_at) VALUES (?1, ?2, ?3)').bind(id, check, t),
      env.DB.prepare(`INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at) VALUES (?1, 'passphrase', NULL, NULL, ?2, ?2)
        ON CONFLICT(owner) DO UPDATE SET mode = 'passphrase', wrapped = NULL, key_check = NULL, updated_at = excluded.updated_at`).bind(id, t),
    ]);
    return json({ ok: true, mode: 'passphrase', keyCheck: check });
  }
  if (b.mode !== 'managed') return invalid();
  if (!managedAvailable(env)) return unavailable();
  const s = await keyState(env, id);
  if (s.mode === 'managed') return fail('Lumio already keeps this account’s sync key.', 409, 'already_managed');
  const raw = keyFrom(b.key);
  if (!raw) return invalid('Invalid key.');
  // Only with the key the account syncs with now: a session alone (after
  // deleting the synced data, say) can't make a key of its own the account's
  // and hand it to Lumio. With nothing synced, the device sets sync up first
  // (/api/sync/init), then switches.
  if (!s.metaCheck) return fail('Set up sync first.', 409, 'sync_not_set_up');
  const check = await keyCheckOf(raw);
  if (!same(check, s.metaCheck)) return mismatch();
  const wrapped = await wrapKey(env, id, raw);
  // Kept only while it's still the account's key.
  const res = await env.DB.prepare(`INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at)
    SELECT ?1, 'managed', ?2, ?3, ?4, ?4 WHERE (SELECT key_check FROM sync_meta WHERE owner = ?1) = ?3
    ON CONFLICT(owner) DO UPDATE SET mode = 'managed', wrapped = excluded.wrapped, key_check = excluded.key_check, updated_at = excluded.updated_at`)
    .bind(id, wrapped, check, now()).run();
  if (!res.meta.changes) return mismatch();
  return json({ ok: true, mode: 'managed', keyCheck: check });
}

// POST /api/sync/reset (managed accounts; passphrase ones use DELETE
// /api/sync): deletes what's synced and the server's key, keeps the devices,
// push subscriptions and the mode, and answers with a new key, which the
// account's other devices then fetch and upload what they have with.
export async function syncReset(request: Request, env: Env, user: User) {
  const refused = keyGuard(request);
  if (refused) return refused;
  const b = await request.json<{ confirm?: unknown }>().catch(() => null);
  if (b?.confirm !== true) return fail('Confirm that you want to reset sync.', 400, 'confirm_required');
  // A change, and the new key it hands out: both counted before anything is
  // deleted (and neither, when either is over the limit).
  if (!(await allowed(request, env, user.id, 'write', 'read'))) return tooMany();
  if (!managedAvailable(env)) return unavailable();
  const id = user.id;
  if ((await keyState(env, id)).mode === 'passphrase') return passphraseMode();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_items WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_meta WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM sync_pairings WHERE owner = ?1').bind(id),
    env.DB.prepare('DELETE FROM companion_messages WHERE owner = ?1').bind(id),
    env.DB.prepare('UPDATE sync_devices SET status = NULL, status_at = NULL WHERE owner = ?1').bind(id),
    env.DB.prepare('UPDATE sync_keys SET wrapped = NULL, key_check = NULL, updated_at = ?2 WHERE owner = ?1').bind(id, now()),
  ]);
  return handOut(env, id);
}

// ---------------------------------------------------------------- older devices
// An older Lumio (v0.6.7 on the Mac, the App Store iPhone app) asks to be
// approved and checks back (GET /api/sync/pair/:id). In managed mode, with a
// key here, the server answers for the account's devices: the key wrapped for
// the request's public key exactly as crypto.js wrapForDevice() does. null:
// the request stays pending (no usable key, over the read limit, or a public
// key that isn't one).
export async function autoApproval(request: Request, env: Env, owner: string, pubkey: string) {
  try {
    if (!managedAvailable(env)) return null;
    const raw = await storedKey(env, owner, await keyState(env, owner));
    if (!raw) return null;
    const answer = await wrapForDevice(raw, pubkey);
    if (!(await allowed(request, env, owner, 'read'))) return null;
    return answer;
  } catch {
    return null;
  }
}

// An ephemeral ECDH P-256 key pair, the shared secret with the device's raw
// public key, HKDF-SHA256 (salt 'lumio-pair-v1', info 'wrap') to an AES-256-GCM
// key, and the raw key encrypted with a random 12-byte IV: base64(IV || ciphertext).
async function wrapForDevice(raw: Uint8Array, pubkey: string) {
  const theirs = await crypto.subtle.importKey('raw', fromB64(pubkey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  // workers-types spell ECDH's `public` as `$public`; the runtime takes `public`.
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs } as unknown as SubtleCryptoDeriveKeyAlgorithm, mine.privateKey, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('lumio-pair-v1'), info: te.encode('wrap') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  const approverPub = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey) as ArrayBuffer);
  return { approverPub: toB64(approverPub), wrapped: toB64(out) };
}
