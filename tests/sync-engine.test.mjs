// Lumio Sync end to end: two (then three) "computers", each with its own
// profile folder, syncing through the real server code (an in-memory D1).
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
const { Workflows } = require('../main/workflows.js');
const { PasswordStore } = require('../main/passwords.js');
const { ChatStore } = require('../main/ai/chats.js');
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

const TOKEN = 'tok_' + 'a'.repeat(40);
let sql;
let env;
before(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u1', 'g1', 'sam@example.com', 'Sam', 'free', 0)").run();
  const hash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(hash, 'u1', Date.now() + 864e5);
  env = { DB: d1(sql) };
});

const account = {
  base: 'https://lumio.test',
  token: () => TOKEN,
  state: () => ({ signedIn: true, email: 'sam@example.com' }),
  fetch: (url, opts = {}) => worker.fetch(new Request(url, { method: opts.method, headers: opts.headers, body: opts.body }), env, { waitUntil() {} }),
};
// A stand-in for the keychain.
const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`k:${s}`), decryptString: (b) => b.toString().slice(2) };

function computer(name, tabs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lumio-sync-${name}-`));
  const store = new Store(dir, safe);
  const workflows = new Workflows(dir);
  const vault = new PasswordStore(dir, safe);
  const chats = new ChatStore(store.chatsFile);
  const sync = new SyncEngine({ dir, store, account });
  sync.addAdapters([
    adapters.bookmarks(store), adapters.history(store), adapters.passwords(vault), adapters.chats(chats),
    adapters.workflows(workflows), adapters.settings(store),
    adapters.tabs({ deviceId: sync.deviceId, deviceName: name, platform: 'mac', windows: () => [{ tabs }], remote: sync.remoteTabs }),
  ]);
  sync.deviceName = name;
  return { store, workflows, vault, chats, sync };
}

test('two computers sync bookmarks, passwords, history, chats, workflows, settings and tabs, encrypted', async () => {
  const a = computer('MacBook', [{ url: 'https://news.example/', title: 'News' }]);
  a.store.toggleBookmark('https://bank.example/', 'My bank');
  a.store.addVisit('https://shop.example/item', 'An item');
  a.vault.save({ origin: 'https://bank.example', username: 'sam', password: 'hunter2-secret' });
  a.workflows.add({ title: 'Morning news', instructions: 'Read the top 3 stories on {site}.' });
  a.chats.add({ id: 'chat-1', title: 'Trip ideas', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'Plan a trip' }], display: [{ kind: 'user', text: 'Plan a trip' }] });
  a.chats.save();
  a.store.setSetting('searchEngine', 'duckduckgo');
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);
  assert.ok(a.sync.recoveryKey());

  // The second computer needs the key: it asks, the first approves.
  const b = computer('iMac', [{ url: 'https://docs.example/', title: 'Docs' }]);
  b.store.toggleBookmark('https://recipes.example/', 'Recipes');
  await b.sync.tick();
  assert.equal(b.sync.status, 'needs-key');
  const code = b.sync.state().pairCode;
  assert.match(code, /^\d{6}$/);
  await a.sync.tick();
  const [req] = a.sync.state().requests;
  assert.deepEqual([req.name, req.code], ['iMac', code], 'both screens show the same code');
  assert.deepEqual(await a.sync.answer(req.id, true), { ok: true });
  await b.sync.tick(); // gets the key
  await b.sync.tick(); // syncs
  assert.equal(b.sync.status, 'ready', b.sync.error);
  await a.sync.tick();

  for (const c of [a, b]) assert.deepEqual(c.store.bookmarks().map((x) => x.url).sort(), ['https://bank.example/', 'https://recipes.example/']);
  assert.equal(b.vault.secret(b.vault.entries[0].id), 'hunter2-secret');
  assert.equal(b.vault.entries[0].username, 'sam');
  assert.deepEqual(b.store.history().map((h) => h.url), ['https://shop.example/item']);
  assert.equal(b.workflows.list()[0].title, 'Morning news');
  assert.equal(b.chats.get('chat-1').title, 'Trip ideas');
  assert.equal(b.store.settings.searchEngine, 'duckduckgo');
  assert.deepEqual(Object.values(a.sync.remoteTabs).map((t) => [t.name, t.windows[0].tabs[0].url]), [['iMac', 'https://docs.example/']]);
  assert.deepEqual(Object.values(b.sync.remoteTabs).map((t) => t.name), ['MacBook']);

  // Nothing readable on the server.
  const stored = sql.prepare("SELECT id, data FROM sync_items WHERE data IS NOT NULL").all().map((r) => `${r.id} ${Buffer.from(r.data, 'base64').toString('latin1')}`).join('\n');
  for (const secret of ['bank', 'hunter2', 'recipes', 'Morning news', 'Trip ideas', 'duckduckgo', 'shop.example']) assert.ok(!stored.includes(secret), `${secret} is encrypted`);

  // A synced device doesn't send things back and forth.
  const seq = () => sql.prepare('SELECT MAX(seq) AS s FROM sync_items').get().s;
  const before = seq();
  await a.sync.tick();
  await b.sync.tick();
  assert.equal(seq(), before, 'no echo');

  // Deleting on one deletes on the other; editing too.
  b.store.removeBookmark('https://bank.example/');
  b.workflows.update(b.workflows.list()[0].id, { title: 'Morning headlines' });
  await b.sync.tick();
  await a.sync.tick();
  assert.deepEqual(a.store.bookmarks().map((x) => x.url), ['https://recipes.example/']);
  assert.equal(a.workflows.list()[0].title, 'Morning headlines');

  // A third computer joins with the recovery key instead.
  const c = computer('Studio', []);
  await c.sync.tick();
  assert.equal(c.sync.status, 'needs-key');
  assert.equal((await c.sync.useRecoveryKey('AAAA-BBBB')).ok, false);
  assert.deepEqual(await c.sync.useRecoveryKey(a.sync.recoveryKey().toLowerCase()), { ok: true });
  await c.sync.tick();
  assert.equal(c.sync.status, 'ready', c.sync.error);
  assert.deepEqual(c.store.bookmarks().map((x) => x.url), ['https://recipes.example/']);
  assert.equal(c.workflows.list()[0].title, 'Morning headlines');

  // Turning off a type stops syncing it; the same login saved on two devices ends up once.
  c.sync.setPrefs({ types: { history: false } });
  c.store.addVisit('https://private.example/', 'Private');
  c.vault.save({ origin: 'https://bank.example', username: 'sam', password: 'newer-password' });
  await c.sync.tick();
  await a.sync.tick();
  assert.ok(!a.store.history().some((h) => h.url.includes('private')));
  assert.equal(a.vault.entries.length, 1, 'one login, not two');
  assert.equal(a.vault.secret(a.vault.entries[0].id), 'newer-password');
});
