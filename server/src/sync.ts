// Lumio Sync and the phone companion's relay.
//
// Sync: devices store end-to-end encrypted records here (bookmarks, passwords,
// history, chats, workflows, settings, open tabs). The server only ever sees
// ciphertext, opaque ids and the collection names; the key stays on the
// devices (see main/sync/crypto.js). Each change gets a new sequence number,
// and devices pull what changed since the last one they saw.
//
// Pairing: a new device posts its public key; a device that has the key
// approves (after the person checks that the codes match) and posts the key
// wrapped for it.
//
// Companion: the phone sends encrypted commands to a computer ("do this",
// "approve that", "stop"), computers post their encrypted status (what Lumio
// is doing, what needs an OK) and notices ("task finished"), and a notice
// wakes the phone with a Web Push (no payload; the phone fetches and
// decrypts it).
import type { Plan } from './agent.ts';
import { AgentError, type Env, fail, json, randomHex } from './util.ts';

type User = { id: string; plan: Plan };

const COLLECTIONS = new Set(['bookmarks', 'passwords', 'history', 'chats', 'workflows', 'projects', 'settings', 'tabs']);
const MAX_ITEM = 600_000; // base64 ciphertext per record
const MAX_TOTAL = 60 * 1024 * 1024; // per account
const MAX_PUSH = 200; // records per request
const MAX_DEVICES = 12;
const PAIR_TTL = 10 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE = /^[A-Za-z0-9-]{8,64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const now = () => Date.now();
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

async function body<T>(request: Request): Promise<T> {
  const b = await request.json<T>().catch(() => null);
  if (!b || typeof b !== 'object') throw new AgentError('Invalid request.', 400, 'invalid_request');
  return b;
}

// ---------------------------------------------------------------- status and setup
export async function syncStatus(env: Env, user: User) {
  const meta = await env.DB.prepare('SELECT key_check, created_at FROM sync_meta WHERE owner = ?1').bind(user.id).first<{ key_check: string; created_at: number }>();
  const devices = await env.DB.prepare('SELECT id, name, kind, platform, last_seen FROM sync_devices WHERE owner = ?1 ORDER BY last_seen DESC').bind(user.id).all<{ id: string; name: string; kind: string; platform: string | null; last_seen: number }>();
  const usage = await env.DB.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(size), 0) AS bytes FROM sync_items WHERE owner = ?1 AND deleted = 0').bind(user.id).first<{ items: number; bytes: number }>();
  return json({
    keyCheck: meta?.key_check || null,
    since: meta?.created_at || null,
    devices: (devices.results || []).map((d) => ({ id: d.id, name: d.name, kind: d.kind, platform: d.platform, lastSeen: d.last_seen })),
    usage: { items: usage?.items || 0, bytes: usage?.bytes || 0, limit: MAX_TOTAL },
  });
}

// The first device sets the account's key check. A different one is refused
// (that device must get the existing key instead).
export async function syncInit(request: Request, env: Env, user: User) {
  const b = await body<{ keyCheck?: unknown }>(request);
  const check = str(b.keyCheck, 64);
  if (!/^[a-f0-9]{32}$/.test(check)) return fail('Invalid key check.', 400, 'invalid_request');
  await env.DB.prepare('INSERT OR IGNORE INTO sync_meta (owner, key_check, created_at) VALUES (?1, ?2, ?3)').bind(user.id, check, now()).run();
  const meta = await env.DB.prepare('SELECT key_check FROM sync_meta WHERE owner = ?1').bind(user.id).first<{ key_check: string }>();
  if (meta?.key_check !== check) return fail('This account already syncs with a different key. Approve this device from another one, or use the recovery key.', 409, 'key_mismatch');
  return json({ ok: true });
}

// Turning sync off for the account: deletes everything synced.
export async function syncDeleteAll(env: Env, user: User) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_items WHERE owner = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM sync_meta WHERE owner = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM sync_pairings WHERE owner = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM sync_devices WHERE owner = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM companion_messages WHERE owner = ?1').bind(user.id),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE owner = ?1').bind(user.id),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- devices
export async function syncDevice(request: Request, env: Env, user: User) {
  const b = await body<{ id?: unknown; name?: unknown; kind?: unknown; platform?: unknown }>(request);
  const id = str(b.id, 64);
  if (!DEVICE.test(id)) return fail('Invalid device.', 400, 'invalid_request');
  const kind = b.kind === 'phone' ? 'phone' : 'computer';
  const known = await env.DB.prepare('SELECT 1 FROM sync_devices WHERE owner = ?1 AND id = ?2').bind(user.id, id).first();
  if (!known) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_devices WHERE owner = ?1').bind(user.id).first<{ n: number }>();
    if ((n?.n || 0) >= MAX_DEVICES) return fail(`You can sync up to ${MAX_DEVICES} devices. Remove one in Settings › Sync first.`, 409, 'too_many_devices');
  }
  await env.DB.prepare(`INSERT INTO sync_devices (owner, id, name, kind, platform, last_seen, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
    ON CONFLICT(owner, id) DO UPDATE SET name = ?3, kind = ?4, platform = ?5, last_seen = ?6`)
    .bind(user.id, id, str(b.name, 60) || (kind === 'phone' ? 'Phone' : 'Computer'), kind, str(b.platform, 20) || null, now()).run();
  return json({ ok: true });
}

export async function syncRemoveDevice(env: Env, user: User, id: string) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_devices WHERE owner = ?1 AND id = ?2').bind(user.id, id),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE owner = ?1 AND device = ?2').bind(user.id, id),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- records
export async function syncChanges(request: Request, env: Env, user: User) {
  const url = new URL(request.url);
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const device = str(url.searchParams.get('device'), 64);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
  const only = (url.searchParams.get('collections') || '').split(',').filter((c) => COLLECTIONS.has(c));
  const filter = only.length ? `AND collection IN (${only.map((_, i) => `?${i + 4}`).join(',')})` : '';
  const rows = await env.DB.prepare(`SELECT seq, id, collection, data, deleted, device, updated_at FROM sync_items
    WHERE owner = ?1 AND seq > ?2 ${filter} ORDER BY seq LIMIT ?3`).bind(user.id, since, limit + 1, ...only)
    .all<{ seq: number; id: string; collection: string; data: string | null; deleted: number; device: string | null; updated_at: number }>();
  const list = rows.results || [];
  const more = list.length > limit;
  const page = list.slice(0, limit);
  const cursor = page.length ? page[page.length - 1].seq : since;
  return json({
    // A device's own changes come back only as the cursor moving past them.
    items: page.filter((r) => !device || r.device !== device).map((r) => ({ id: r.id, collection: r.collection, data: r.data, deleted: !!r.deleted, updatedAt: r.updated_at, device: r.device })),
    cursor,
    more,
  });
}

export async function syncPush(request: Request, env: Env, user: User) {
  const b = await body<{ device?: unknown; items?: unknown }>(request);
  const device = str(b.device, 64);
  if (!DEVICE.test(device)) return fail('Invalid device.', 400, 'invalid_request');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > MAX_PUSH) return fail(`Send 1 to ${MAX_PUSH} records.`, 400, 'invalid_request');
  if (!(await env.DB.prepare('SELECT 1 FROM sync_meta WHERE owner = ?1').bind(user.id).first())) return fail('Set up sync first.', 409, 'sync_not_set_up');
  const items = b.items.map((raw) => {
    const it = raw as { id?: unknown; collection?: unknown; data?: unknown; deleted?: unknown; updatedAt?: unknown };
    const id = str(it?.id, 64);
    const collection = str(it?.collection, 20);
    const deleted = it?.deleted === true;
    const data = deleted ? null : typeof it?.data === 'string' ? it.data : '';
    if (!ID.test(id) || !COLLECTIONS.has(collection)) throw new AgentError('Invalid record.', 400, 'invalid_request');
    if (!deleted && (!data || data.length > MAX_ITEM || !B64.test(data))) throw new AgentError('A record is missing or too big.', 413, 'record_too_big');
    return { id, collection, data, deleted, size: data ? data.length : 0, updatedAt: Math.min(now(), Number(it?.updatedAt) || now()) };
  });
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM sync_items WHERE owner = ?1').bind(user.id).first<{ bytes: number }>();
  const adding = items.reduce((a, it) => a + it.size, 0);
  if ((used?.bytes || 0) + adding > MAX_TOTAL) return fail('Your synced data is full. Turn off syncing history or chats in Settings › Sync.', 413, 'sync_full');
  // Replacing a row gives it a new sequence number, so other devices pull it.
  await env.DB.batch(items.map((it) => env.DB.prepare(`INSERT OR REPLACE INTO sync_items (owner, id, collection, data, deleted, size, device, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(user.id, it.id, it.collection, it.data, it.deleted ? 1 : 0, it.size, device, it.updatedAt)));
  const top = await env.DB.prepare('SELECT MAX(seq) AS seq FROM sync_items WHERE owner = ?1').bind(user.id).first<{ seq: number }>();
  return json({ ok: true, cursor: top?.seq || 0 });
}

// ---------------------------------------------------------------- pairing
export async function pairRequest(request: Request, env: Env, user: User) {
  const b = await body<{ device?: unknown; name?: unknown; kind?: unknown; pubkey?: unknown }>(request);
  const device = str(b.device, 64);
  const pubkey = str(b.pubkey, 200);
  if (!DEVICE.test(device) || !B64.test(pubkey) || pubkey.length < 80) return fail('Invalid pairing request.', 400, 'invalid_request');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_pairings WHERE owner = ?1 AND created_at > ?2').bind(user.id, now() - PAIR_TTL).first<{ n: number }>();
  if ((recent?.n || 0) >= 10) return fail('Too many requests. Try again in a few minutes.', 429, 'rate_limited');
  const id = `p_${randomHex(12)}`;
  await env.DB.prepare(`INSERT INTO sync_pairings (id, owner, device, name, kind, pubkey, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`)
    .bind(id, user.id, device, str(b.name, 60) || 'New device', b.kind === 'phone' ? 'phone' : 'computer', pubkey, now()).run();
  return json({ id });
}

// What a device with the key sees: requests waiting for an OK.
export async function pairPending(request: Request, env: Env, user: User) {
  const device = str(new URL(request.url).searchParams.get('device'), 64);
  const rows = await env.DB.prepare(`SELECT id, device, name, kind, pubkey, created_at FROM sync_pairings
    WHERE owner = ?1 AND status = 'pending' AND created_at > ?2 AND device != ?3 ORDER BY created_at DESC LIMIT 5`)
    .bind(user.id, now() - PAIR_TTL, device).all<{ id: string; device: string; name: string; kind: string; pubkey: string; created_at: number }>();
  return json({ requests: (rows.results || []).map((r) => ({ id: r.id, device: r.device, name: r.name, kind: r.kind, pubkey: r.pubkey, createdAt: r.created_at })) });
}

// The requester checks whether it was approved (and collects the wrapped key).
export async function pairCheck(env: Env, user: User, id: string) {
  const r = await env.DB.prepare('SELECT status, approver_pub, wrapped, created_at FROM sync_pairings WHERE owner = ?1 AND id = ?2').bind(user.id, id)
    .first<{ status: string; approver_pub: string | null; wrapped: string | null; created_at: number }>();
  if (!r) return fail('No such request.', 404, 'not_found');
  if (r.status === 'pending' && r.created_at < now() - PAIR_TTL) return json({ status: 'expired' });
  if (r.status === 'approved') {
    // Collected once.
    await env.DB.prepare("UPDATE sync_pairings SET status = 'done', wrapped = NULL WHERE owner = ?1 AND id = ?2").bind(user.id, id).run();
    return json({ status: 'approved', approverPub: r.approver_pub, wrapped: r.wrapped });
  }
  return json({ status: r.status });
}

export async function pairAnswer(request: Request, env: Env, user: User, id: string) {
  const b = await body<{ approve?: unknown; approverPub?: unknown; wrapped?: unknown }>(request);
  if (b.approve !== true) {
    await env.DB.prepare("UPDATE sync_pairings SET status = 'denied' WHERE owner = ?1 AND id = ?2 AND status = 'pending'").bind(user.id, id).run();
    return json({ ok: true });
  }
  const approverPub = str(b.approverPub, 200);
  const wrapped = str(b.wrapped, 200);
  if (!B64.test(approverPub) || !B64.test(wrapped)) return fail('Invalid answer.', 400, 'invalid_request');
  const res = await env.DB.prepare(`UPDATE sync_pairings SET status = 'approved', approver_pub = ?3, wrapped = ?4
    WHERE owner = ?1 AND id = ?2 AND status = 'pending' AND created_at > ?5`).bind(user.id, id, approverPub, wrapped, now() - PAIR_TTL).run();
  if (!res.meta.changes) return fail('That request expired. Ask again from the new device.', 410, 'expired');
  return json({ ok: true });
}

// ---------------------------------------------------------------- companion relay
const KINDS = new Set(['command', 'notice']);
export async function companionPost(request: Request, env: Env, user: User, ctx: ExecutionContext) {
  const b = await body<{ kind?: unknown; device?: unknown; target?: unknown; data?: unknown; hint?: unknown }>(request);
  const kind = str(b.kind, 10);
  const device = str(b.device, 64);
  const target = str(b.target, 64) || null;
  const data = typeof b.data === 'string' ? b.data : '';
  if (!KINDS.has(kind) || !DEVICE.test(device) || (target && !DEVICE.test(target)) || !data || data.length > 200_000 || !B64.test(data)) return fail('Invalid message.', 400, 'invalid_request');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM companion_messages WHERE owner = ?1 AND created_at > ?2').bind(user.id, now() - 60_000).first<{ n: number }>();
  if ((recent?.n || 0) >= 120) return fail('Slow down a little.', 429, 'rate_limited');
  const row = await env.DB.prepare('INSERT INTO companion_messages (owner, kind, sender, target, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING seq')
    .bind(user.id, kind, device, target, data, now()).first<{ seq: number }>();
  if (kind === 'notice') ctx.waitUntil(pushAll(env, user.id, device, HINTS[String(b.hint)] || HINTS.info));
  return json({ ok: true, seq: row?.seq || 0 });
}

// Messages for this device since a sequence number: commands addressed to it
// (or to any computer), or every notice.
export async function companionList(request: Request, env: Env, user: User) {
  const url = new URL(request.url);
  const kind = str(url.searchParams.get('kind'), 10);
  const device = str(url.searchParams.get('device'), 64);
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  if (!KINDS.has(kind) || !DEVICE.test(device)) return fail('Invalid request.', 400, 'invalid_request');
  const rows = await env.DB.prepare(`SELECT seq, sender, target, data, created_at FROM companion_messages
    WHERE owner = ?1 AND kind = ?2 AND seq > ?3 AND created_at > ?4 AND sender != ?5 ${kind === 'command' ? 'AND (target IS NULL OR target = ?5)' : ''}
    ORDER BY seq LIMIT 100`).bind(user.id, kind, since, now() - 24 * 3600_000, device)
    .all<{ seq: number; sender: string; target: string | null; data: string; created_at: number }>();
  const list = rows.results || [];
  const top = await env.DB.prepare('SELECT MAX(seq) AS seq FROM companion_messages WHERE owner = ?1').bind(user.id).first<{ seq: number }>();
  // Someone looking at the phone app makes computers check more often.
  const watching = kind === 'command' ? await env.DB.prepare("SELECT 1 FROM sync_devices WHERE owner = ?1 AND kind = 'phone' AND last_seen > ?2").bind(user.id, now() - 30_000).first() : null;
  return json({ messages: list.map((r) => ({ seq: r.seq, sender: r.sender, target: r.target, data: r.data, at: r.created_at })), cursor: Math.max(since, top?.seq || 0), watching: !!watching });
}

// A computer's live status (encrypted): what Lumio is doing, what needs an OK.
export async function companionStatusPut(request: Request, env: Env, user: User) {
  const b = await body<{ device?: unknown; data?: unknown }>(request);
  const device = str(b.device, 64);
  const data = typeof b.data === 'string' ? b.data : '';
  if (!DEVICE.test(device) || !data || data.length > 100_000 || !B64.test(data)) return fail('Invalid status.', 400, 'invalid_request');
  const res = await env.DB.prepare('UPDATE sync_devices SET status = ?3, status_at = ?4, last_seen = ?4 WHERE owner = ?1 AND id = ?2').bind(user.id, device, data, now()).run();
  if (!res.meta.changes) return fail('Register this device first.', 409, 'unknown_device');
  return json({ ok: true });
}

export async function companionStatusGet(env: Env, user: User) {
  const rows = await env.DB.prepare("SELECT id, name, platform, status, status_at, last_seen FROM sync_devices WHERE owner = ?1 AND kind = 'computer' ORDER BY last_seen DESC")
    .bind(user.id).all<{ id: string; name: string; platform: string | null; status: string | null; status_at: number | null; last_seen: number }>();
  return json({ computers: (rows.results || []).map((r) => ({ id: r.id, name: r.name, platform: r.platform, status: r.status, statusAt: r.status_at, lastSeen: r.last_seen, online: r.last_seen > now() - 90_000 })) });
}

// ---------------------------------------------------------------- web push
export async function pushSubscribe(request: Request, env: Env, user: User) {
  const b = await body<{ device?: unknown; endpoint?: unknown }>(request);
  const device = str(b.device, 64);
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint.slice(0, 1000) : '';
  let host = '';
  try { host = new URL(endpoint).hostname; } catch { /* invalid */ }
  // Only the browsers' own push services.
  // The browsers' own push services, or the Lumio app's Expo push token.
  const expo = /^expo:ExponentPushToken\[[A-Za-z0-9_-]{10,100}\]$/.test(endpoint);
  if (!DEVICE.test(device) || (!expo && (!/^https:/.test(endpoint) || !/(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(host)))) return fail('Invalid subscription.', 400, 'invalid_request');
  await env.DB.prepare(`INSERT INTO push_subscriptions (owner, device, endpoint, created_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(owner, device) DO UPDATE SET endpoint = ?3, created_at = ?4`).bind(user.id, device, endpoint, now()).run();
  return json({ ok: true });
}

export function vapidKey(env: Env) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// What the Lumio app's notification says (the details are encrypted; the app
// shows them when opened). Only this kind of event is visible to the server.
const HINTS: Record<string, string> = {
  done: 'Lumio finished a task.',
  approval: 'Lumio needs your OK.',
  scheduled: 'A scheduled task finished.',
  info: 'Lumio has an update.',
};

// Web Push: VAPID-signed with no payload; it only wakes the phone, which then
// fetches the (encrypted) notice itself. The Lumio app: Expo's push service.
async function pushAll(env: Env, owner: string, sender: string, text = HINTS.info) {
  const subs = await env.DB.prepare('SELECT device, endpoint FROM push_subscriptions WHERE owner = ?1 AND device != ?2').bind(owner, sender).all<{ device: string; endpoint: string }>();
  const all = subs.results || [];
  const expo = all.filter((s) => s.endpoint.startsWith('expo:'));
  if (expo.length) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(expo.map((s) => ({ to: s.endpoint.slice(5), title: 'Lumio', body: text, sound: 'default', data: { notice: true } }))),
      });
      const out = await res.json<{ data?: { status?: string; details?: { error?: string } }[] }>().catch(() => null);
      for (const [i, r] of (out?.data || []).entries()) {
        if (r?.details?.error === 'DeviceNotRegistered') await env.DB.prepare('DELETE FROM push_subscriptions WHERE owner = ?1 AND device = ?2').bind(owner, expo[i].device).run();
      }
    } catch { /* try again next time */ }
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  for (const s of all.filter((x) => !x.endpoint.startsWith('expo:'))) {
    try {
      const res = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', 'Content-Length': '0', Authorization: await vapidAuth(env, s.endpoint) } });
      if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subscriptions WHERE owner = ?1 AND device = ?2').bind(owner, s.device).run();
    } catch { /* try again next time */ }
  }
}

async function vapidAuth(env: Env, endpoint: string) {
  const te = new TextEncoder();
  const header = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: 'mailto:support@lumio-usa.online' })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_KEY as string), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Old tombstones, pairings and relay messages (the 5-minute cron).
export async function syncCleanup(env: Env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_items WHERE deleted = 1 AND updated_at < ?1').bind(t - 90 * 24 * 3600_000),
    env.DB.prepare('DELETE FROM sync_pairings WHERE created_at < ?1').bind(t - 24 * 3600_000),
    env.DB.prepare('DELETE FROM companion_messages WHERE created_at < ?1').bind(t - 2 * 24 * 3600_000),
  ]);
}
