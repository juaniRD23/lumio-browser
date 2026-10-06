// Lumio Sync for addresses, cards and passkeys: two computers syncing through
// the real server code (an in-memory D1). Everything is end-to-end
// encrypted; cards only sync after the person turns them on; a synced
// passkey signs in from the other computer; passkeys made before syncing
// existed stay where they are.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import worker from '../server/src/index.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../main/store.js');
const { AutofillStore } = require('../main/autofill-store.js');
const { PasskeyStore } = require('../main/passkeys.js');
const { SyncEngine } = require('../main/sync/engine.js');
const adapters = require('../main/sync/adapters.js');

function d1(db) {
  return {
    prepare(query) {
      let values = [];
      const stmt = {
        bind(...args) { values = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async first() { return db.prepare(query).get(...values) ?? null; },
        async all() { return { results: db.prepare(query).all(...values) }; },
        async run() { const r = db.prepare(query).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; },
      };
      return stmt;
    },
    async batch(stmts) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}

const TOKEN = 'tok_' + 'b'.repeat(40);
let sql;
let env;
before(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u7', 'g7', 'ana@example.com', 'Ana', 'free', 0)").run();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(TOKEN).digest('hex'), 'u7', Date.now() + 864e5);
  env = { DB: d1(sql) };
});

const account = {
  base: 'https://lumio.test',
  token: () => TOKEN,
  state: () => ({ signedIn: true, email: 'ana@example.com' }),
  fetch: (url, opts = {}) => worker.fetch(new Request(url, { method: opts.method, headers: opts.headers, body: opts.body }), env, { waitUntil() {} }),
};
const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`k:${s}`), decryptString: (b) => b.toString().slice(2) };
const b64 = (b) => Buffer.from(b).toString('base64url');
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

function computer(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lumio-afsync-${name}-`));
  const store = new Store(dir, safe);
  const autofill = new AutofillStore(dir, safe);
  const passkeys = new PasskeyStore(dir, safe);
  const sync = new SyncEngine({ dir, store, account });
  sync.addAdapters([adapters.addresses(autofill), adapters.cards(autofill), adapters.passkeys(passkeys)]);
  sync.deviceName = name;
  return { store, autofill, passkeys, sync };
}

test('addresses and passkeys sync end to end; cards only once turned on; a synced passkey signs in elsewhere', async () => {
  const a = computer('MacBook');
  const home = a.autofill.saveAddress({ name: 'Ana García', street: '9 Calle Ocho', city: 'Miami', state: 'FL', zip: '33135', phone: '305 555 0142' });
  a.autofill.saveCard({ number: '5555 5555 5555 4444', name: 'Ana García', expMonth: 7, expYear: 2032 });
  const reg = a.passkeys.create({
    challenge: b64(crypto.randomBytes(32)), rp: { id: 'example.com' }, user: { id: b64(Buffer.from('ana-1')), name: 'ana@example.com', displayName: 'Ana' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  }, 'https://example.com', { verified: true });
  // A passkey from before syncing told its site it's device-bound.
  a.passkeys.create({ challenge: b64(crypto.randomBytes(32)), rp: { id: 'old.example' }, user: { id: b64(Buffer.from('old-1')), name: 'old@example.com' }, pubKeyCredParams: [] }, 'https://old.example', { verified: true });
  delete a.passkeys.keys.find((k) => k.rpId === 'old.example').be;
  assert.equal(a.sync.prefs.types.cards, false, 'cards are off until the person turns them on');
  assert.equal(a.sync.prefs.types.addresses && a.sync.prefs.types.passkeys, true);
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);

  const b = computer('iMac');
  await b.sync.tick();
  assert.deepEqual(await b.sync.useRecoveryKey(a.sync.recoveryKey()), { ok: true });
  await b.sync.tick();
  assert.equal(b.sync.status, 'ready', b.sync.error);
  assert.deepEqual(b.autofill.addresses().map((x) => [x.name, x.street, x.zip, x.phone]), [['Ana García', '9 Calle Ocho', '33135', '305 555 0142']]);
  assert.equal(b.autofill.cards().length, 0, 'no card yet');
  assert.deepEqual(b.passkeys.list().map((k) => [k.rpId, k.userName, k.syncable]), [['example.com', 'ana@example.com', true]], 'the device-bound one stayed');

  // The synced passkey signs in on the other computer, and the site accepts it.
  const challenge = b64(crypto.randomBytes(32));
  const sig = b.passkeys.assert({ challenge, rpId: 'example.com' }, 'https://example.com', reg.id, { verified: true });
  const authData = Buffer.from(sig.authenticatorData, 'base64url');
  assert.equal(authData[32] & 0x18, 0x08, 'backup eligible, not backed up while the computer says so');
  const key = crypto.createPublicKey({ key: Buffer.from(reg.publicKey, 'base64url'), format: 'der', type: 'spki' });
  assert.equal(crypto.verify('sha256', Buffer.concat([authData, sha256(Buffer.from(sig.clientDataJSON, 'base64url'))]), { key, dsaEncoding: 'der' }, Buffer.from(sig.signature, 'base64url')), true);
  b.passkeys.backedUp = () => true;
  assert.equal(Buffer.from(b.passkeys.assert({ challenge, rpId: 'example.com' }, 'https://example.com', reg.id, { verified: true }).authenticatorData, 'base64url')[32] & 0x18, 0x18, 'backed up');

  // Turning cards on (on both) brings them over.
  a.sync.setPrefs({ types: { cards: true } });
  b.sync.setPrefs({ types: { cards: true } });
  await a.sync.tick();
  await b.sync.tick();
  const [card] = b.autofill.cards();
  assert.deepEqual([card.brandName, card.last4, card.expMonth, card.expYear], ['Mastercard', '4444', 7, 2032]);
  assert.equal(b.autofill.cardNumber(card.id), '5555555555554444');

  // Nothing readable on the server.
  const stored = sql.prepare('SELECT data FROM sync_items WHERE data IS NOT NULL').all().map((r) => Buffer.from(r.data, 'base64').toString('latin1')).join('\n');
  const privateKey = a.passkeys.syncRecord(reg.id).key;
  for (const secret of ['Calle Ocho', '5555555555554444', '4444', 'ana@example.com', 'example.com', privateKey.slice(20, 60)]) assert.ok(!stored.includes(secret), `${secret.slice(0, 20)} is encrypted`);
  assert.deepEqual([...new Set(sql.prepare('SELECT collection FROM sync_items').all().map((r) => r.collection))].sort(), ['addresses', 'cards', 'passkeys']);

  // Edits and deletes travel; using an address doesn't (it isn't a change).
  b.autofill.saveAddress({ ...b.autofill.address(home), phone: '305 555 0199' }, home);
  b.autofill.markAddressUsed(home);
  b.autofill.removeCard(card.id);
  await b.sync.tick();
  await a.sync.tick();
  assert.equal(a.autofill.address(home).phone, '305 555 0199');
  assert.equal(a.autofill.cards().length, 0);
  const seq = () => sql.prepare('SELECT MAX(seq) AS s FROM sync_items').get().s;
  const last = seq();
  a.autofill.markAddressUsed(home);
  await a.sync.tick();
  await b.sync.tick();
  assert.equal(seq(), last, 'no echo, and filling a form isn’t a change');
});

test('a server from before addresses, cards and passkeys synced: everything else still syncs', async () => {
  const TOKEN2 = 'tok_' + 'c'.repeat(40);
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u8', 'g8', 'old@example.com', 'Old', 'free', 0)").run();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(TOKEN2).digest('hex'), 'u8', Date.now() + 864e5);
  const pushes = [];
  const oldServer = {
    ...account,
    token: () => TOKEN2,
    state: () => ({ signedIn: true, email: 'old@example.com' }),
    // The live server before this release: it refuses collections it doesn't know.
    fetch: async (url, opts = {}) => {
      if (String(url).endsWith('/api/sync/push')) {
        const kinds = [...new Set(JSON.parse(opts.body).items.map((it) => it.collection))];
        pushes.push(kinds);
        if (kinds.some((k) => ['addresses', 'cards', 'passkeys'].includes(k))) return new Response(JSON.stringify({ error: 'Invalid record.', code: 'invalid_request' }), { status: 400 });
      }
      return account.fetch(url, opts);
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-afsync-old-'));
  const store = new Store(dir, safe);
  const autofill = new AutofillStore(dir, safe);
  store.marks.add('bar', null, { url: 'https://example.com/', title: 'Example' });
  autofill.saveAddress({ name: 'Ana García', street: '9 Calle Ocho', city: 'Miami', zip: '33135' });
  const sync = new SyncEngine({ dir, store, account: oldServer });
  sync.addAdapters([adapters.bookmarks(store), adapters.addresses(autofill)]);
  await sync.tick();
  assert.equal(sync.status, 'ready', sync.error);
  assert.deepEqual(pushes, [['bookmarks'], ['addresses']], 'bookmarks first, addresses on their own');
  assert.deepEqual(sql.prepare("SELECT DISTINCT collection FROM sync_items WHERE owner = 'u8'").all().map((r) => r.collection), ['bookmarks']);
  await sync.tick();
  assert.equal(pushes.length, 2, 'not tried again right away');
  assert.ok(!Object.values(sync.file.data.records).some((r) => r.c === 'addresses'), 'the address is still waiting to sync');
});
