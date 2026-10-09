// Managed Lumio Sync (docs/sync-managed.md): the server keeps each account's
// sync key wrapped with SYNC_MASTER_KEY and hands it to the account's
// signed-in devices; passphrase accounts work as before. D1 is simulated on
// node:sqlite, and the devices' side is Lumio Browser's own main/sync/crypto.js.
// Run: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { keyCheckOf, managedAvailable, unwrapKey, wrapKey } from '../src/sync-keys.ts';
import { syncCleanup } from '../src/sync.ts';

const C = createRequire(import.meta.url)('../../main/sync/crypto.js');
const SITE = 'https://lumio.test';
const DEV_A = 'mac-aaaaaaaa-1111';
const DEV_B = 'mac-bbbbbbbb-2222';
const PHONE = 'ios-cccccccc-3333';
const ctx = { waitUntil: () => {} };

let sql, env, logged, secrets;

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

// Everything logged during a test, and every key it handed out (base64 and hex),
// so afterEach can check that no key and no master key was ever logged.
const consoles = { error: console.error, log: console.log, warn: console.warn };
const remember = (b64) => { secrets.add(b64); secrets.add(Buffer.from(b64, 'base64').toString('hex')); };
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: d1(sql), SYNC_MASTER_KEY: crypto.randomBytes(32).toString('base64') };
  logged = [];
  secrets = new Set();
  remember(env.SYNC_MASTER_KEY);
  for (const k of Object.keys(consoles)) console[k] = (...args) => logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
});
afterEach(() => {
  Object.assign(console, consoles);
  for (const line of logged) for (const s of secrets) assert.ok(!line.includes(s), `a key was logged: ${line.slice(0, 80)}`);
});

const KEY_ROUTES = /^\/api\/sync(\/key|\/mode|\/reset)?$/;
async function call(path, { token, cookie, method = 'GET', body, headers = {}, ip } = {}) {
  const res = await worker.fetch(new Request(SITE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie: `__Host-lumio_session=${cookie}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  // Key answers are never cached, and no other site may read them.
  if (KEY_ROUTES.test(path)) {
    assert.equal(res.headers.get('cache-control'), 'no-store', `${method} ${path}`);
    assert.equal(res.headers.get('access-control-allow-origin'), null, `${method} ${path}`);
  }
  for (const m of (await res.clone().text()).matchAll(/"key":"([^"]+)"/g)) remember(m[1]);
  return res;
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
function session(id) {
  const token = crypto.randomBytes(32).toString('hex');
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), id, Date.now(), Date.now() + 86400_000);
  return token;
}
function user(name) {
  const id = `u_${name}`;
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES (?, ?, ?, ?, 'free', 0)").run(id, `g-${name}`, `${name}@example.com`, name);
  return { id, token: session(id) };
}

const b64 = (raw) => Buffer.from(raw).toString('base64');
const read = (token, opts = {}) => call('/api/sync/key', { token, method: 'POST', body: {}, ...opts });
const upload = (token, key, opts = {}) => call('/api/sync/key', { token, method: 'PUT', body: { key }, ...opts });
const setMode = (token, body, opts = {}) => call('/api/sync/mode', { token, method: 'PUT', body, ...opts });
const reset = (token, body = { confirm: true }, opts = {}) => call('/api/sync/reset', { token, method: 'POST', body, ...opts });
const status = async (token) => (await call('/api/sync', { token })).json();
const init = (token, check) => call('/api/sync/init', { token, method: 'POST', body: { keyCheck: check } });
const device = (token, id, name = 'MacBook') => call('/api/sync/devices', { token, method: 'POST', body: { id, name, kind: id.startsWith('ios') ? 'phone' : 'computer' } });
const keysRow = (owner) => sql.prepare('SELECT mode, wrapped, key_check, updated_at FROM sync_keys WHERE owner = ?').get(owner) ?? null;
const count = (table, owner) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner = ?`).get(owner).n;
const events = (owner, kind) => sql.prepare('SELECT COUNT(*) AS n FROM sync_key_events WHERE owner = ? AND kind = ?').get(owner, kind).n;
async function err(res, status, code) {
  assert.equal(res.status, status);
  assert.equal((await res.json()).code, code);
}

// A device's records, sealed and opened with crypto.js.
async function pushRecords(token, raw, dev, records) {
  const keys = await C.deriveKeys(raw);
  const items = [];
  for (const [collection, key, value] of records) {
    const id = await C.recordId(keys, collection, key);
    items.push({ id, collection, data: await C.seal(keys, collection, id, value) });
  }
  return call('/api/sync/push', { token, method: 'POST', body: { device: dev, items } });
}
async function pullRecords(token, raw, dev) {
  const keys = await C.deriveKeys(raw);
  const { items } = await (await call(`/api/sync/changes?since=0&device=${dev}`, { token })).json();
  return Promise.all(items.filter((i) => !i.deleted).map((i) => C.open(keys, i.collection, i.id, i.data)));
}
// An older Lumio asking to be approved (ECDH, as crypto.js does it).
async function askToPair(token, dev = PHONE) {
  const pair = await C.pairKeyPair();
  const res = await call('/api/sync/pair', { token, method: 'POST', body: { device: dev, name: 'iPhone', kind: 'phone', pubkey: pair.publicKey } });
  assert.equal(res.status, 200);
  return { ...pair, id: (await res.json()).id };
}
const checkPair = async (token, id) => (await call(`/api/sync/pair/${id}`, { token })).json();
// A computer's companion status (sealed on the computer; any base64 here).
const putStatus = (token, dev, body = {}) => call('/api/companion/status', { token, method: 'PUT', body: { device: dev, data: Buffer.from('sealed status').toString('base64'), ...body } });
const statusOf = (dev) => ({ ...sql.prepare('SELECT status, status_at FROM sync_devices WHERE id = ?').get(dev) });

// ---------------------------------------------------------------- wrapping
test('wrapping: the known-answer vectors, the same check as crypto.js, bound to the account', async () => {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(b64(raw), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=');
  assert.equal(await keyCheckOf(raw), '31421cbcf18c4ec0d1bce11b8b47c85d');
  assert.equal((await C.deriveKeys(raw)).check, '31421cbcf18c4ec0d1bce11b8b47c85d');
  const e = { SYNC_MASTER_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE=' };
  const W = 'v1.IiIiIiIiIiIiIiIi.F/YFSsTKmVjtNtQ3RKvn2g+C3/F+lLpcSlYQ8xX8exydM6BaDQftu9b2aEvGSP9E';
  assert.equal(await wrapKey(e, 'u_test', raw, new Uint8Array(12).fill(0x22)), W);
  assert.deepEqual(await unwrapKey(e, 'u_test', W), raw);
  assert.equal(await unwrapKey(e, 'u_other', W), null, 'another account’s key doesn’t unwrap');
  // Random keys: the same check as the devices make; a new IV each time.
  for (let i = 0; i < 3; i++) {
    const k = C.newKey();
    assert.equal(await keyCheckOf(k), (await C.deriveKeys(k)).check);
  }
  const a = await wrapKey(e, 'u_test', raw);
  const b = await wrapKey(e, 'u_test', raw);
  assert.notEqual(a, b);
  assert.match(a, /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{64}$/);
  assert.deepEqual(await unwrapKey(e, 'u_test', b), raw);
  // Anything else is null, never an exception.
  const flipped = W.slice(0, -3) + (W.at(-3) === 'A' ? 'B' : 'A') + W.slice(-2);
  for (const bad of [W.replace(/^v1\./, 'v2.'), flipped, 'v1..', '', 'v1.!!!.???']) assert.equal(await unwrapKey(e, 'u_test', bad), null, bad);
  assert.equal(await unwrapKey({ SYNC_MASTER_KEY: crypto.randomBytes(32).toString('base64') }, 'u_test', W), null, 'another master key');
  assert.equal(await unwrapKey({}, 'u_test', W), null, 'no master key');
  // Exactly 32 bytes of base64, or managed sync isn't available.
  for (const k of [undefined, '', 'short', crypto.randomBytes(31).toString('base64'), crypto.randomBytes(33).toString('base64'), 'not base64 at all!']) {
    assert.equal(managedAvailable({ SYNC_MASTER_KEY: k }), false, String(k));
  }
  assert.equal(managedAvailable(e), true);
});

// ---------------------------------------------------------------- managed
test('managed: signing in is enough; the first read makes the key, every session gets the same one, and sync works', async () => {
  const sam = user('sam');
  const before = await status(sam.token);
  assert.deepEqual([before.keyCheck, before.mode, before.managedKey, before.managedAvailable], [null, 'managed', false, true]);
  const res = await read(sam.token);
  assert.equal(res.status, 200);
  const k = await res.json();
  assert.deepEqual(Object.keys(k).sort(), ['created', 'key', 'keyCheck', 'status']);
  assert.equal(k.status, 'ready');
  assert.equal(k.created, true);
  assert.match(k.key, /^[A-Za-z0-9+/]{43}=$/);
  const raw = C.fromB64(k.key);
  assert.equal(raw.length, 32);
  assert.equal((await C.deriveKeys(raw)).check, k.keyCheck);
  const after = await status(sam.token);
  assert.deepEqual([after.keyCheck, after.mode, after.managedKey, after.managedAvailable], [k.keyCheck, 'managed', true, true]);
  // Stored wrapped, for this account only.
  const row = keysRow(sam.id);
  assert.equal(row.mode, 'managed');
  assert.equal(row.key_check, k.keyCheck);
  assert.ok(row.wrapped.startsWith('v1.') && !row.wrapped.includes(k.key));
  assert.deepEqual(await unwrapKey(env, sam.id, row.wrapped), raw);
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM sync_keys').all()).includes(k.key), 'never stored as is');
  // A computer syncs with it.
  await device(sam.token, DEV_A);
  assert.equal((await pushRecords(sam.token, raw, DEV_A, [['bookmarks', 'https://example.com/', { title: 'Example' }], ['passwords', 'example.com|sam', { password: 'hunter2' }]])).status, 200);
  // Another session of the same account (Lumio Beta, the iPhone): the same key, nothing to approve.
  const beta = session(sam.id);
  assert.deepEqual(await (await read(beta)).json(), { status: 'ready', key: k.key, keyCheck: k.keyCheck, created: false });
  assert.deepEqual((await pullRecords(beta, raw, DEV_B)).map((v) => v.title || v.password).sort(), ['Example', 'hunter2']);
  // Another account: its own key, never Sam's.
  const lee = user('lee');
  const kl = await (await read(lee.token)).json();
  assert.equal(kl.created, true);
  assert.notEqual(kl.key, k.key);
  assert.notEqual(kl.keyCheck, k.keyCheck);
  assert.deepEqual(await (await read(lee.token)).json(), { ...kl, created: false });
  // Signed out, or a session that ended: nothing.
  await err(await read(undefined), 401, 'sign_in_required');
  await err(await read(crypto.randomBytes(32).toString('hex')), 401, 'sign_in_required');
  sql.prepare('UPDATE sessions SET expires_at = 0 WHERE token_hash = ?').run(sha(beta));
  await err(await read(beta), 401, 'sign_in_required');
  // No GET, so a link or an image can't ask for it.
  await err(await call('/api/sync/key', { token: sam.token }), 404, 'not_found');
  await err(await call('/api/sync/mode', { token: sam.token }), 404, 'not_found');
  await err(await call('/api/sync/reset', { token: sam.token }), 404, 'not_found');
});

test('managed: two devices signing in at once get the same new key', async () => {
  const sam = user('sam');
  const [a, b] = await Promise.all([read(sam.token), read(session(sam.id))].map(async (p) => (await p).json()));
  assert.equal(a.status, 'ready');
  assert.equal(b.status, 'ready');
  assert.equal(a.key, b.key);
  assert.equal([a.created, b.created].filter(Boolean).length, 1, 'made once');
  assert.equal(sql.prepare('SELECT key_check FROM sync_meta WHERE owner = ?').get(sam.id).key_check, a.keyCheck);
});

test('managed: an older device’s /api/sync/init that wins the race leaves the account waiting for its key', async () => {
  const sam = user('sam');
  const K = C.newKey();
  const check = (await C.deriveKeys(K)).check;
  assert.equal((await init(sam.token, check)).status, 200);
  assert.deepEqual(await (await read(sam.token)).json(), { status: 'waiting', keyCheck: check });
  assert.equal(keysRow(sam.id), null, 'nothing made');
  // Init stays as it was.
  await err(await init(sam.token, 'b'.repeat(32)), 409, 'key_mismatch');
});

test('a wrapped key copied into another account doesn’t unwrap there: it waits, and the copy is dropped', async () => {
  const sam = user('sam');
  const lee = user('lee');
  const ks = await (await read(sam.token)).json();
  const row = keysRow(sam.id);
  // Lee's rows made to look like Sam's (someone with write access to the database).
  sql.prepare('INSERT INTO sync_meta (owner, key_check, created_at) VALUES (?, ?, 0)').run(lee.id, row.key_check);
  sql.prepare("INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at) VALUES (?, 'managed', ?, ?, 0, 0)").run(lee.id, row.wrapped, row.key_check);
  assert.equal((await status(lee.token)).managedKey, true, 'it looks usable from the database');
  // An older device of Lee's asking to be approved isn't.
  const old = await askToPair(lee.token);
  assert.deepEqual(await checkPair(lee.token, old.id), { status: 'pending' });
  assert.equal(keysRow(lee.id).wrapped, null, 'dropped');
  sql.prepare('UPDATE sync_keys SET wrapped = ?, key_check = ? WHERE owner = ?').run(row.wrapped, row.key_check, lee.id);
  const kl = await (await read(lee.token)).json();
  assert.deepEqual(kl, { status: 'waiting', keyCheck: row.key_check });
  assert.ok(!JSON.stringify(kl).includes(ks.key));
  assert.equal(keysRow(lee.id).wrapped, null);
  assert.equal((await status(lee.token)).managedKey, false);
  assert.deepEqual(logged.filter((l) => l.startsWith('lumio sync key')), ['lumio sync key: unwrap failed', 'lumio sync key: unwrap failed'], 'the one fixed line, nothing else');
  // Sam's is untouched.
  assert.deepEqual(await (await read(sam.token)).json(), { ...ks, created: false });
});

// ---------------------------------------------------------------- migration
test('migration: an account that synced end-to-end waits for a device with the key to upload it; nothing is re-encrypted', async () => {
  const sam = user('sam');
  await err(await upload(sam.token, b64(C.newKey())), 409, 'sync_not_set_up');
  // Before managed sync: the Mac made the key, and its records are on the server.
  const K = C.newKey();
  const check = (await C.deriveKeys(K)).check;
  assert.equal((await init(sam.token, check)).status, 200);
  await device(sam.token, DEV_A);
  assert.equal((await pushRecords(sam.token, K, DEV_A, [['bookmarks', 'https://lumio-co.online/', { title: 'Lumio' }], ['history', 'https://example.com/', { visits: 3 }]])).status, 200);
  const stored = () => sql.prepare('SELECT seq, id, data FROM sync_items WHERE owner = ? ORDER BY seq').all(sam.id).map((r) => ({ ...r }));
  const records = stored();
  // The server ships: the account reports managed, no key yet.
  const st = await status(sam.token);
  assert.deepEqual([st.keyCheck, st.mode, st.managedKey, st.managedAvailable], [check, 'managed', false, true]);
  // A new device (Lumio Beta) waits.
  const beta = session(sam.id);
  assert.deepEqual(await (await read(beta)).json(), { status: 'waiting', keyCheck: check });
  assert.equal(keysRow(sam.id), null);
  // Uploads: the key's shape, then the account's key only.
  for (const bad of ['abc', b64(C.newKey()).replace(/=$/, ''), b64(crypto.randomBytes(31)), b64(C.newKey()).replace(/\+|\//g, '-').replace(/^./, '_'), 42, null]) {
    await err(await upload(sam.token, bad), 400, 'invalid_request');
  }
  await err(await upload(sam.token, b64(C.newKey())), 409, 'key_mismatch');
  const up = await upload(sam.token, b64(K));
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { ok: true, keyCheck: check });
  assert.equal((await status(sam.token)).managedKey, true);
  // The Beta's next run gets it.
  assert.deepEqual(await (await read(beta)).json(), { status: 'ready', key: b64(K), keyCheck: check, created: false });
  assert.deepEqual((await pullRecords(beta, K, DEV_B)).map((v) => v.title || v.visits).sort(), [3, 'Lumio'].sort());
  // Uploading again changes nothing.
  const row = keysRow(sam.id);
  assert.deepEqual(await (await upload(sam.token, b64(K))).json(), { ok: true, keyCheck: check });
  assert.deepEqual(keysRow(sam.id), row);
  assert.deepEqual(stored(), records, 'not one record re-encrypted');
  assert.equal(sql.prepare('SELECT key_check FROM sync_meta WHERE owner = ?').get(sam.id).key_check, check);
});

test('repair: a new SYNC_MASTER_KEY makes the stored key unreadable; it is dropped, and a device that has the key uploads it again', async () => {
  const sam = user('sam');
  const k = await (await read(sam.token)).json();
  env.SYNC_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  remember(env.SYNC_MASTER_KEY);
  assert.deepEqual(await (await read(session(sam.id))).json(), { status: 'waiting', keyCheck: k.keyCheck });
  assert.equal(keysRow(sam.id).wrapped, null);
  assert.equal((await status(sam.token)).managedKey, false);
  assert.ok(logged.includes('lumio sync key: unwrap failed'));
  assert.equal((await upload(sam.token, k.key)).status, 200);
  assert.deepEqual(await (await read(session(sam.id))).json(), { ...k, created: false });
});

test('without SYNC_MASTER_KEY nothing changes: no keys handed out, and pairing works as before', async () => {
  const sam = user('sam');
  // A key kept earlier stays kept while the secret is missing.
  const k = await (await read(sam.token)).json();
  const row = keysRow(sam.id);
  for (const missing of [undefined, 'short']) {
    env.SYNC_MASTER_KEY = missing;
    const st = await status(sam.token);
    assert.deepEqual([st.managedAvailable, st.mode], [false, 'managed']);
    await err(await read(sam.token), 503, 'sync_keys_unavailable');
    await err(await upload(sam.token, k.key), 503, 'sync_keys_unavailable');
    await err(await reset(sam.token), 503, 'sync_keys_unavailable');
  }
  // Pairing as today: the request is shown to devices with the key, and nothing approves it by itself.
  const counted = sql.prepare('SELECT COUNT(*) AS n FROM sync_key_events').get().n;
  const phone = await askToPair(sam.token);
  assert.deepEqual(await checkPair(sam.token, phone.id), { status: 'pending' });
  const pending = await (await call(`/api/sync/pair?device=${DEV_A}`, { token: sam.token })).json();
  assert.deepEqual(pending.requests.map((r) => r.id), [phone.id]);
  const approval = await C.wrapForDevice(C.fromB64(k.key), phone.publicKey);
  assert.equal((await call(`/api/sync/pair/${phone.id}`, { token: sam.token, method: 'POST', body: { approve: true, ...approval } })).status, 200);
  assert.deepEqual(await checkPair(sam.token, phone.id), { status: 'approved', ...approval });
  assert.deepEqual(keysRow(sam.id), row, 'not dropped');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sync_key_events').get().n, counted, 'pairing counts nothing');
  // A fresh account without the secret: today's init.
  const lee = user('lee');
  assert.equal((await init(lee.token, 'c'.repeat(32))).status, 200);
  assert.equal((await status(lee.token)).managedAvailable, false);
  // Choosing passphrase mode needs no master key; going back to managed does.
  assert.equal((await setMode(lee.token, { mode: 'passphrase', keyCheck: 'd'.repeat(32) })).status, 200);
  await err(await setMode(lee.token, { mode: 'managed', key: b64(C.newKey()) }), 503, 'sync_keys_unavailable');
});

// ---------------------------------------------------------------- older devices
test('older Lumio builds asking to be approved are approved by the server in managed mode, once', async () => {
  const sam = user('sam');
  const k = await (await read(sam.token)).json();
  const phone = await askToPair(sam.token);
  // Devices with the key aren't asked: the server answers.
  assert.deepEqual(await (await call(`/api/sync/pair?device=${DEV_A}`, { token: sam.token })).json(), { requests: [] });
  const got = await checkPair(sam.token, phone.id);
  assert.deepEqual(Object.keys(got).sort(), ['approverPub', 'status', 'wrapped']);
  assert.equal(got.status, 'approved');
  assert.equal(C.fromB64(got.approverPub).length, 65);
  // Opened with crypto.js, as the device does it.
  const raw = await C.unwrapFromApprover(phone.privateKey, got.approverPub, got.wrapped);
  assert.equal(b64(raw), k.key);
  assert.deepEqual(await checkPair(sam.token, phone.id), { status: 'done' }, 'handed over once');
  assert.deepEqual({ ...sql.prepare('SELECT status, approver_pub, wrapped FROM sync_pairings WHERE id = ?').get(phone.id) }, { status: 'done', approver_pub: null, wrapped: null }, 'never stored');
  assert.equal(events(sam.id, 'read'), 2, 'the read and the approval');
  // Not a public key: it stays pending (and isn't counted).
  const junk = await (await call('/api/sync/pair', { token: sam.token, method: 'POST', body: { device: PHONE, name: 'iPhone', kind: 'phone', pubkey: Buffer.alloc(65, 4).toString('base64') } })).json();
  assert.deepEqual(await checkPair(sam.token, junk.id), { status: 'pending' });
  assert.equal(events(sam.id, 'read'), 2);
  // An expired request isn't approved.
  const late = await askToPair(sam.token);
  sql.prepare('UPDATE sync_pairings SET created_at = ? WHERE id = ?').run(Date.now() - 11 * 60_000, late.id);
  assert.deepEqual(await checkPair(sam.token, late.id), { status: 'expired' });
  // Another account's request isn't even found.
  const lee = user('lee');
  await err(await call(`/api/sync/pair/${phone.id}`, { token: lee.token }), 404, 'not_found');
});

test('a waiting account: older devices approve as before, and a pending request is approved once the key is uploaded', async () => {
  const sam = user('sam');
  const K = C.newKey();
  const check = (await C.deriveKeys(K)).check;
  await init(sam.token, check);
  const phone = await askToPair(sam.token);
  assert.deepEqual(await checkPair(sam.token, phone.id), { status: 'pending' });
  const pending = await (await call(`/api/sync/pair?device=${DEV_A}`, { token: sam.token })).json();
  assert.deepEqual(pending.requests.map((r) => r.id), [phone.id], 'the Mac that has the key can still approve it');
  assert.equal((await upload(sam.token, b64(K))).status, 200);
  const got = await checkPair(sam.token, phone.id);
  assert.equal(got.status, 'approved');
  assert.equal(b64(await C.unwrapFromApprover(phone.privateKey, got.approverPub, got.wrapped)), b64(K));
  assert.deepEqual(await (await call(`/api/sync/pair?device=${DEV_A}`, { token: sam.token })).json(), { requests: [] });
});

// ---------------------------------------------------------------- passphrase
test('passphrase mode: the server forgets its key and everything it could read; reads, uploads and resets are refused', async () => {
  const sam = user('sam');
  const k1 = await (await read(sam.token)).json();
  const K1 = C.fromB64(k1.key);
  await device(sam.token, DEV_A);
  await device(sam.token, PHONE, 'iPhone');
  await call('/api/companion/push', { token: sam.token, method: 'POST', body: { device: PHONE, endpoint: 'https://web.push.apple.com/QGx' } });
  await pushRecords(sam.token, K1, DEV_A, [['bookmarks', 'https://example.com/', { title: 'Example' }]]);
  assert.equal((await putStatus(sam.token, DEV_A)).status, 200);
  await call('/api/companion/messages', { token: sam.token, method: 'POST', body: { kind: 'command', device: PHONE, data: Buffer.from('sealed').toString('base64') } });
  sql.prepare("INSERT INTO sync_pairings (id, owner, device, name, kind, pubkey, status, created_at) VALUES ('p_000000000000000000000001', ?, 'x-device-1', 'Old', 'computer', 'AAAA', 'pending', ?)").run(sam.id, Date.now());
  // Only a well-formed request.
  await err(await setMode(sam.token, { mode: 'passphrase' }), 400, 'invalid_request');
  await err(await setMode(sam.token, { mode: 'passphrase', keyCheck: 'A'.repeat(32) }), 400, 'invalid_request');
  await err(await setMode(sam.token, { mode: 'paranoid', keyCheck: 'a'.repeat(32) }), 400, 'invalid_request');
  // The Mac makes a new key and switches.
  const K2 = C.newKey();
  const check2 = (await C.deriveKeys(K2)).check;
  const sw = await setMode(sam.token, { mode: 'passphrase', keyCheck: check2 });
  assert.equal(sw.status, 200);
  assert.deepEqual(await sw.json(), { ok: true, mode: 'passphrase', keyCheck: check2 });
  for (const table of ['sync_items', 'sync_pairings', 'companion_messages']) assert.equal(count(table, sam.id), 0, table);
  assert.equal(sql.prepare('SELECT key_check FROM sync_meta WHERE owner = ?').get(sam.id).key_check, check2);
  assert.deepEqual({ ...keysRow(sam.id), updated_at: 0 }, { mode: 'passphrase', wrapped: null, key_check: null, updated_at: 0 });
  assert.equal(count('sync_devices', sam.id), 2, 'devices stay');
  assert.equal(count('push_subscriptions', sam.id), 1, 'and notifications');
  assert.deepEqual(statusOf(DEV_A), { status: null, status_at: null }, 'the computer’s companion status, sealed with the old key, is gone too');
  // The server has no key to give, and takes none.
  await err(await read(session(sam.id)), 409, 'passphrase_mode');
  await err(await upload(sam.token, b64(K2)), 409, 'passphrase_mode');
  await err(await reset(sam.token), 409, 'passphrase_mode');
  const st = await status(sam.token);
  assert.deepEqual([st.keyCheck, st.mode, st.managedKey, st.managedAvailable], [check2, 'passphrase', false, true]);
  // Pairing as today: shown to the devices, never approved by the server.
  assert.equal((await pushRecords(sam.token, K2, DEV_A, [['bookmarks', 'https://example.com/', { title: 'Example' }]])).status, 200);
  const phone = await askToPair(sam.token);
  assert.deepEqual(await checkPair(sam.token, phone.id), { status: 'pending' });
  assert.deepEqual((await (await call(`/api/sync/pair?device=${DEV_A}`, { token: sam.token })).json()).requests.map((r) => r.id), [phone.id]);
  await err(await setMode(sam.token, { mode: 'passphrase', keyCheck: check2 }), 409, 'already_passphrase');
  // Deleting synced data keeps the mode.
  assert.equal((await call('/api/sync', { token: sam.token, method: 'DELETE' })).status, 200);
  const cleared = await status(sam.token);
  assert.deepEqual([cleared.keyCheck, cleared.mode, cleared.managedKey], [null, 'passphrase', false]);
  await err(await read(sam.token), 409, 'passphrase_mode');
  assert.equal((await init(sam.token, check2)).status, 200, 'the e2ee flow, as today');
});

test('back to managed: the Mac hands over its current key; then new devices just sign in', async () => {
  const sam = user('sam');
  await read(sam.token);
  const K2 = C.newKey();
  const check2 = (await C.deriveKeys(K2)).check;
  assert.equal((await setMode(sam.token, { mode: 'passphrase', keyCheck: check2 })).status, 200);
  await err(await setMode(sam.token, { mode: 'managed', key: b64(C.newKey()) }), 409, 'key_mismatch');
  await err(await setMode(sam.token, { mode: 'managed', key: 'nope' }), 400, 'invalid_request');
  const back = await setMode(sam.token, { mode: 'managed', key: b64(K2) });
  assert.equal(back.status, 200);
  assert.deepEqual(await back.json(), { ok: true, mode: 'managed', keyCheck: check2 });
  const st = await status(sam.token);
  assert.deepEqual([st.keyCheck, st.mode, st.managedKey], [check2, 'managed', true]);
  assert.deepEqual(await (await read(session(sam.id))).json(), { status: 'ready', key: b64(K2), keyCheck: check2, created: false });
  await err(await setMode(sam.token, { mode: 'managed', key: b64(K2) }), 409, 'already_managed');
  // From passphrase mode with nothing synced, a session alone can't make a
  // key of its own the account's and Lumio's (the devices that have the
  // passphrase key would follow it): sync is set up first, with that key.
  const K3 = C.newKey();
  assert.equal((await setMode(sam.token, { mode: 'passphrase', keyCheck: (await C.deriveKeys(K3)).check })).status, 200);
  await call('/api/sync', { token: sam.token, method: 'DELETE' });
  const K4 = C.newKey();
  await err(await setMode(sam.token, { mode: 'managed', key: b64(K4) }), 409, 'sync_not_set_up');
  assert.deepEqual([keysRow(sam.id).mode, keysRow(sam.id).wrapped], ['passphrase', null], 'still the account’s own passphrase');
  assert.equal(count('sync_meta', sam.id), 0, 'and nothing set up meanwhile');
  assert.equal((await init(sam.token, (await C.deriveKeys(K4)).check)).status, 200);
  assert.deepEqual(await (await setMode(sam.token, { mode: 'managed', key: b64(K4) })).json(), { ok: true, mode: 'managed', keyCheck: (await C.deriveKeys(K4)).check });
  assert.equal((await (await read(sam.token)).json()).key, b64(K4));
});

// ---------------------------------------------------------------- reset and delete
test('reset: a new key and an empty server; devices stay, and the account’s other devices fetch the new key', async () => {
  const sam = user('sam');
  const k1 = await (await read(sam.token)).json();
  await device(sam.token, DEV_A);
  await device(sam.token, DEV_B, 'iMac');
  await pushRecords(sam.token, C.fromB64(k1.key), DEV_A, [['bookmarks', 'https://example.com/', { title: 'Example' }]]);
  assert.equal((await putStatus(sam.token, DEV_B, { keyCheck: k1.keyCheck })).status, 200);
  await err(await reset(sam.token, {}), 400, 'confirm_required');
  await err(await reset(sam.token, { confirm: 'yes' }), 400, 'confirm_required');
  const res = await reset(sam.token);
  assert.equal(res.status, 200);
  const k2 = await res.json();
  assert.equal(k2.status, 'ready');
  assert.equal(k2.created, true);
  assert.notEqual(k2.key, k1.key);
  assert.notEqual(k2.keyCheck, k1.keyCheck);
  assert.equal((await C.deriveKeys(C.fromB64(k2.key))).check, k2.keyCheck);
  assert.equal(count('sync_items', sam.id), 0, 'the old records are gone');
  assert.equal(count('sync_devices', sam.id), 2, 'devices stay');
  assert.deepEqual(statusOf(DEV_B), { status: null, status_at: null }, 'and the companion status sealed with the old key');
  const st = await status(sam.token);
  assert.deepEqual([st.keyCheck, st.mode, st.managedKey], [k2.keyCheck, 'managed', true]);
  // The iMac sees a new keyCheck with managedKey, fetches it and uploads what it has.
  assert.deepEqual(await (await read(session(sam.id))).json(), { ...k2, created: false });
  await err(await upload(sam.token, k1.key), 409, 'key_mismatch');
  assert.equal(events(sam.id, 'write'), 2, 'the reset and the upload (unconfirmed resets aren’t counted)');
  assert.equal(events(sam.id, 'read'), 3, 'the first read, the key the reset handed out, the iMac’s read');
});

test('deleting synced data drops the server’s key but keeps the mode; the next read makes a new one', async () => {
  const sam = user('sam');
  const k1 = await (await read(sam.token)).json();
  assert.equal((await call('/api/sync', { token: sam.token, method: 'DELETE' })).status, 200);
  assert.deepEqual({ ...keysRow(sam.id), updated_at: 0 }, { mode: 'managed', wrapped: null, key_check: null, updated_at: 0 });
  const st = await status(sam.token);
  assert.deepEqual([st.keyCheck, st.mode, st.managedKey], [null, 'managed', false]);
  const k2 = await (await read(sam.token)).json();
  assert.equal(k2.created, true);
  assert.notEqual(k2.key, k1.key);
  assert.equal(events(sam.id, 'read'), 2, 'kept: deleting doesn’t reset the limits');
});

// ---------------------------------------------------------------- an old key mid-run
test('a device still on the old key (its run started before a reset or a switch) can’t leave records or status only that key opens', async () => {
  const sam = user('sam');
  const k1 = await (await read(sam.token)).json();
  const K1 = C.fromB64(k1.key);
  await device(sam.token, DEV_A);
  await device(sam.token, DEV_B, 'iMac');
  const sealed = async (raw, key) => {
    const keys = await C.deriveKeys(raw);
    const id = await C.recordId(keys, 'bookmarks', key);
    return { id, collection: 'bookmarks', data: await C.seal(keys, 'bookmarks', id, { title: key }) };
  };
  const push = async (raw, keyCheck, key, dev = DEV_B) => call('/api/sync/push', { token: sam.token, method: 'POST', body: { device: dev, ...(keyCheck === undefined ? {} : { keyCheck }), items: [await sealed(raw, key)] } });
  assert.equal((await push(K1, k1.keyCheck, 'https://one.example/')).status, 200, 'the right key');
  await err(await push(K1, 'A'.repeat(32), 'https://one.example/'), 400, 'invalid_request');

  // Mac A resets while the iMac is between its status check and its push.
  const k2 = await (await reset(sam.token)).json();
  await err(await push(K1, k1.keyCheck, 'https://two.example/'), 409, 'key_mismatch');
  await err(await putStatus(sam.token, DEV_B, { keyCheck: k1.keyCheck }), 409, 'key_mismatch');
  assert.equal(count('sync_items', sam.id), 0, 'nothing sealed with the old key');
  assert.deepEqual(statusOf(DEV_B), { status: null, status_at: null });
  await err(await putStatus(sam.token, 'mac-unknown-9999', { keyCheck: k2.keyCheck }), 409, 'unknown_device');
  // With the new key, both go through; an older device that doesn't say which key works as before.
  assert.equal((await push(C.fromB64(k2.key), k2.keyCheck, 'https://two.example/')).status, 200);
  assert.equal((await putStatus(sam.token, DEV_B, { keyCheck: k2.keyCheck })).status, 200);
  assert.equal((await push(C.fromB64(k2.key), undefined, 'https://three.example/', DEV_A)).status, 200);
  assert.equal((await putStatus(sam.token, DEV_A)).status, 200);
  assert.equal(count('sync_items', sam.id), 2);

  // The same for a switch to the account's own passphrase.
  const K3 = C.newKey();
  const check3 = (await C.deriveKeys(K3)).check;
  assert.equal((await setMode(sam.token, { mode: 'passphrase', keyCheck: check3 })).status, 200);
  await err(await push(C.fromB64(k2.key), k2.keyCheck, 'https://four.example/'), 409, 'key_mismatch');
  assert.equal(count('sync_items', sam.id), 0);
  assert.equal((await push(K3, check3, 'https://four.example/', DEV_A)).status, 200);
});

// ---------------------------------------------------------------- the website
test('the website: its cookie gets the key only from its own pages (Origin, X-Lumio-Sync: 1, same-origin), never another site', async () => {
  const sam = user('sam');
  const cookie = session(sam.id);
  const web = (headers, opts = {}) => call('/api/sync/key', { cookie, method: 'POST', body: {}, ...opts, headers });
  const ok = await web({ origin: SITE, 'x-lumio-sync': '1', 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  const k = await ok.json();
  assert.equal(k.status, 'ready');
  assert.equal((await web({ origin: SITE, 'x-lumio-sync': '1' })).status, 200, 'without Sec-Fetch-Site (older browsers)');
  for (const [why, headers] of [
    ['no X-Lumio-Sync', { origin: SITE }],
    ['X-Lumio-Sync not 1', { origin: SITE, 'x-lumio-sync': 'true' }],
    ['another site', { origin: 'https://evil.test', 'x-lumio-sync': '1' }],
    ['no Origin', { 'x-lumio-sync': '1' }],
    ['Origin null', { origin: 'null', 'x-lumio-sync': '1' }],
    ['cross-site', { origin: SITE, 'x-lumio-sync': '1', 'sec-fetch-site': 'cross-site' }],
    ['same-site', { origin: SITE, 'x-lumio-sync': '1', 'sec-fetch-site': 'same-site' }],
    ['a junk bearer next to the cookie', { 'x-lumio-sync': '1', authorization: 'Bearer x' }],
  ]) {
    const res = await web(headers);
    assert.equal(res.status, 403, why);
    assert.ok(!(await res.text()).includes(k.key), why);
  }
  // The other key routes too.
  for (const [path, method, body] of [['/api/sync/key', 'PUT', { key: k.key }], ['/api/sync/mode', 'PUT', { mode: 'passphrase', keyCheck: 'a'.repeat(32) }], ['/api/sync/reset', 'POST', { confirm: true }]]) {
    await err(await call(path, { cookie, method, body, headers: { origin: SITE } }), 403, 'forbidden');
    await err(await call(path, { cookie, method, body, headers: { origin: 'https://evil.test', 'x-lumio-sync': '1' } }), 403, 'forbidden');
  }
  assert.equal(keysRow(sam.id).mode, 'managed', 'nothing changed');
  assert.equal((await call('/api/sync/key', { cookie, method: 'PUT', body: { key: k.key }, headers: { origin: SITE, 'x-lumio-sync': '1' } })).status, 200);
  // A preflight gets nothing that would let another site read the answer.
  const pre = await call('/api/sync/key', { method: 'OPTIONS', headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-lumio-sync' } });
  assert.notEqual(pre.status, 200);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  // The apps: a bearer token, no Origin.
  assert.equal((await read(sam.token)).status, 200);
  // Refused requests aren't counted against the account.
  assert.equal(events(sam.id, 'read'), 3);
});

// ---------------------------------------------------------------- limits
test('rate limits: 30 key reads and 10 changes an hour per account, 120 and 30 per network address', async () => {
  const sam = user('sam');
  const IP = '198.51.100.7';
  let key;
  for (let i = 0; i < 30; i++) {
    const res = await read(sam.token, { ip: IP });
    assert.equal(res.status, 200, `read ${i + 1}`);
    key = (await res.json()).key;
  }
  const over = await read(sam.token, { ip: IP });
  await err(over.clone(), 429, 'rate_limited');
  assert.equal(over.headers.get('retry-after'), '600');
  assert.equal((await read(sam.token, { ip: '203.0.113.9' })).status, 429, 'per account, from anywhere');
  // An older device asking meanwhile stays pending, and checking back doesn't count.
  const phone = await askToPair(sam.token);
  const before = events(sam.id, 'read');
  for (let i = 0; i < 3; i++) assert.deepEqual(await checkPair(sam.token, phone.id), { status: 'pending' });
  assert.equal(events(sam.id, 'read'), before);
  // Changes.
  for (let i = 0; i < 10; i++) assert.equal((await upload(sam.token, key, { ip: IP })).status, 200, `upload ${i + 1}`);
  const tooMany = await upload(sam.token, key, { ip: IP });
  await err(tooMany.clone(), 429, 'rate_limited');
  assert.equal(tooMany.headers.get('retry-after'), '600');
  await err(await setMode(sam.token, { mode: 'passphrase', keyCheck: 'a'.repeat(32) }), 429, 'rate_limited');
  await err(await reset(sam.token), 429, 'rate_limited');
  assert.equal(keysRow(sam.id).mode, 'managed');
  // Deleting synced data doesn't reset them.
  await call('/api/sync', { token: sam.token, method: 'DELETE' });
  await err(await read(sam.token), 429, 'rate_limited');
  // Per network address: four accounts read 30 times each from one; a fifth is refused there, not elsewhere.
  const NET = '192.0.2.44';
  const others = ['ana', 'bo', 'cy', 'di', 'ed'].map(user);
  const keys = {};
  for (const u of others.slice(0, 4)) {
    for (let i = 0; i < 30; i++) {
      const res = await read(u.token, { ip: NET });
      assert.equal(res.status, 200);
      keys[u.id] = (await res.json()).key;
    }
  }
  await err(await read(others[4].token, { ip: NET }), 429, 'rate_limited');
  assert.equal((await read(others[4].token, { ip: '192.0.2.45' })).status, 200);
  // Changes: 30 per network address, and one IPv6 /64 counts as one address.
  for (const u of others.slice(0, 3)) for (let i = 1; i <= 10; i++) assert.equal((await upload(u.token, keys[u.id], { ip: `2001:db8:aa:bb::${i}` })).status, 200);
  await err(await upload(others[3].token, keys[others[3].id], { ip: '2001:db8:aa:bb:1:2:3:4' }), 429, 'rate_limited');
  assert.equal((await upload(others[3].token, keys[others[3].id], { ip: '2001:db8:aa:cc::1' })).status, 200);
  // The cron forgets them after an hour.
  sql.prepare('UPDATE sync_key_events SET created_at = created_at - 3700000').run();
  await syncCleanup(env);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sync_key_events').get().n, 0);
  assert.equal((await read(sam.token, { ip: IP })).status, 200);
});

test('a device that keeps asking while it’s over the limit doesn’t keep the limit going: refused requests aren’t counted', async () => {
  const sam = user('sam');
  const IP = '198.51.100.8';
  for (let i = 0; i < 30; i++) assert.equal((await read(sam.token, { ip: IP })).status, 200, `read ${i + 1}`);
  // Those were 50 minutes ago; then a device without the key asks every minute or so.
  sql.prepare('UPDATE sync_key_events SET created_at = created_at - 3000000').run();
  for (let i = 0; i < 40; i++) await err(await read(sam.token, { ip: IP }), 429, 'rate_limited');
  assert.equal(events(sam.id, 'read'), 30, 'only the reads that were served');
  // Eleven minutes on, the served reads are over an hour old: the next read works.
  sql.prepare('UPDATE sync_key_events SET created_at = created_at - 660000').run();
  assert.equal((await read(sam.token, { ip: IP })).status, 200);

  // A reset counts a change and a key handed out: neither is kept when either is over the limit.
  const kim = user('kim');
  for (let i = 0; i < 30; i++) assert.equal((await read(kim.token)).status, 200);
  await err(await reset(kim.token), 429, 'rate_limited');
  assert.deepEqual([events(kim.id, 'write'), events(kim.id, 'read')], [0, 30]);
});
