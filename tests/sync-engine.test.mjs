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
const { SyncEngine, hash } = require('../main/sync/engine.js');
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
const TOKEN2 = 'tok_' + 'b'.repeat(40);
let sql;
let env;
before(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  for (const [id, email, token] of [['u1', 'sam@example.com', TOKEN], ['u2', 'kim@example.com', TOKEN2]]) {
    sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES (?, ?, ?, 'Sam', 'free', 0)").run(id, `g-${id}`, email);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(hash, id, Date.now() + 864e5);
  }
  env = { DB: d1(sql) };
});

// oldServer: answer like a server from before bookmark folders (it doesn't
// list what it keeps, and refuses records of collections it doesn't know).
function makeAccount(token, email, { oldServer = () => false } = {}) {
  return {
    base: 'https://lumio.test',
    token: () => token,
    state: () => ({ signedIn: true, email }),
    fetch: async (url, opts = {}) => {
      if (oldServer() && opts.body && /bookmarkTree/.test(opts.body)) return new Response(JSON.stringify({ error: 'Invalid record.' }), { status: 400 });
      const res = await worker.fetch(new Request(url, { method: opts.method, headers: opts.headers, body: opts.body }), env, { waitUntil() {} });
      if (!oldServer() || new URL(url).pathname !== '/api/sync' || (opts.method || 'GET') !== 'GET') return res;
      const { collections, ...rest } = await res.json();
      return new Response(JSON.stringify(rest), { status: res.status, headers: { 'content-type': 'application/json' } });
    },
  };
}
const account = makeAccount(TOKEN, 'sam@example.com');
// A stand-in for the keychain.
const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`k:${s}`), decryptString: (b) => b.toString().slice(2) };

function computer(name, tabs, { acct = account, bookmarks = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lumio-sync-${name}-`));
  const store = new Store(dir, safe);
  const workflows = new Workflows(dir);
  const vault = new PasswordStore(dir, safe);
  const chats = new ChatStore(store.chatsFile);
  const sync = new SyncEngine({ dir, store, account: acct });
  sync.addAdapters([
    ...(bookmarks ? [bookmarks] : [adapters.bookmarks(store), adapters.bookmarkTree(store)]), adapters.history(store), adapters.passwords(vault), adapters.chats(chats),
    adapters.workflows(workflows), adapters.settings(store),
    adapters.tabs({ deviceId: sync.deviceId, deviceName: name, platform: 'mac', windows: () => [{ tabs }], remote: sync.remoteTabs }),
  ]);
  sync.deviceName = name;
  return { store, workflows, vault, chats, sync };
}

test('two computers sync bookmarks, passwords, history, chats, workflows, settings and tabs, encrypted', async () => {
  const a = computer('MacBook', [{ url: 'https://news.example/', title: 'News' }]);
  a.store.marks.add('bar', null, { url: 'https://bank.example/', title: 'My bank' });
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
  b.store.marks.add('bar', null, { url: 'https://recipes.example/', title: 'Recipes' });
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
  b.store.marks.removeUrl('https://bank.example/');
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

// Lumio before bookmark folders: a flat list, synced and applied exactly as
// that version did (main/store.js applySyncedBookmarks, main/sync/adapters.js).
function olderLumioBookmarks(list) {
  return {
    name: 'bookmarks',
    hashOf: (r) => hash(r),
    entries: () => list.map((b, i) => { const r = { url: b.url, title: b.title, time: b.time, pos: i }; return { key: b.url, hash: hash(r), get: () => r }; }),
    apply(changes) {
      const keys = new Set(changes.map((c) => c.key));
      const kept = list.filter((b) => !keys.has(b.url));
      for (const c of changes.filter((x) => x.record && /^(https?|file):/i.test(x.record.url)).sort((a, b) => a.record.pos - b.record.pos)) {
        kept.splice(Math.max(0, Math.min(Number(c.record.pos) || 0, kept.length)), 0, { url: c.record.url, title: c.record.title || c.record.url, time: Number(c.record.time) || Date.now() });
      }
      list.splice(0, list.length, ...kept);
    },
  };
}
const shape = (folder) => folder.children.map((n) => (n.children ? [n.title, shape(n)] : n.title));
const treeRecords = (store) => JSON.stringify(store.marks.syncedTree().sort());

test('bookmark folders sync between newer computers, and an older Lumio keeps working beside them', async () => {
  const acct = makeAccount(TOKEN2, 'kim@example.com');
  const a = computer('MacBook', [], { acct });
  const work = a.store.marks.addFolder('bar', null, 'Work');
  a.store.marks.add(work.id, null, { url: 'https://jira.example/', title: 'Jira', time: 1 });
  a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News', time: 2 });
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);
  const key = a.sync.recoveryKey();

  // An older Lumio joins: it sees every bookmark once, in order, without folders.
  const flat = [];
  const old = computer('Old iMac', [], { acct, bookmarks: olderLumioBookmarks(flat) });
  await old.sync.tick();
  await old.sync.useRecoveryKey(key);
  await old.sync.tick();
  assert.deepEqual(flat.map((b) => b.title), ['Jira', 'News']);
  // It renames News and adds Recipes.
  flat[1].title = 'Top news';
  flat.push({ url: 'https://recipes.example/', title: 'Recipes', time: 3 });
  await old.sync.tick();
  await a.sync.tick();
  assert.deepEqual(shape(a.store.marks.root('bar')), [['Work', ['Jira']], 'Top news', 'Recipes']);

  // A second newer computer gets the same tree, folders and all.
  const b = computer('Studio', [], { acct });
  await b.sync.tick();
  await b.sync.useRecoveryKey(key);
  await b.sync.tick();
  assert.deepEqual(shape(b.store.marks.root('bar')), shape(a.store.marks.root('bar')));
  assert.equal(treeRecords(b.store), treeRecords(a.store));

  // B files Recipes under Work and makes a folder in Other bookmarks; A follows.
  const recipes = b.store.marks.byUrl('https://recipes.example/')[0];
  b.store.marks.move([recipes.id], b.store.marks.root('bar').children[0].id, 0);
  const later = b.store.marks.addFolder('other', null, 'Later');
  b.store.marks.add(later.id, null, { url: 'https://later.example/', title: 'Read later', time: 4 });
  await b.sync.tick();
  await a.sync.tick();
  assert.deepEqual(shape(a.store.marks.root('bar')), [['Work', ['Recipes', 'Jira']], 'Top news']);
  assert.deepEqual(shape(a.store.marks.root('other')), [['Later', ['Read later']]]);
  // The older one sees the moves as a new order, and the new bookmark.
  await old.sync.tick();
  assert.deepEqual(flat.map((b) => b.title), ['Recipes', 'Jira', 'Top news', 'Read later']);

  // The older one deletes Jira: gone everywhere.
  flat.splice(1, 1);
  await old.sync.tick();
  await a.sync.tick();
  await b.sync.tick();
  for (const c of [a, b]) assert.deepEqual(shape(c.store.marks.root('bar')), [['Work', ['Recipes']], 'Top news']);

  // Everyone in step: nothing goes back and forth.
  for (let i = 0; i < 2; i++) for (const c of [a, b, old]) await c.sync.tick();
  const seq = () => sql.prepare('SELECT MAX(seq) AS s FROM sync_items').get().s;
  const before = seq();
  for (const c of [a, b, old]) await c.sync.tick();
  assert.equal(seq(), before, 'no echo');
  assert.equal(treeRecords(b.store), treeRecords(a.store));
  // Folders stay encrypted too.
  const stored = sql.prepare("SELECT data FROM sync_items WHERE data IS NOT NULL").all().map((r) => Buffer.from(r.data, 'base64').toString('latin1')).join('\n');
  for (const secret of ['Work', 'Later', 'jira.example']) assert.ok(!stored.includes(secret), `${secret} is encrypted`);
});

test('with a server from before folders, bookmarks still sync as a list; folders follow once it keeps them', async () => {
  // A fresh account for this test.
  const token = 'tok_' + 'c'.repeat(40);
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u3', 'g-u3', 'lee@example.com', 'Lee', 'free', 0)").run();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), 'u3', Date.now() + 864e5);
  let old = true;
  const acct = makeAccount(token, 'lee@example.com', { oldServer: () => old });
  const a = computer('MacBook', [], { acct });
  const f = a.store.marks.addFolder('bar', null, 'Work');
  a.store.marks.add(f.id, null, { url: 'https://jira.example/', title: 'Jira' });
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);
  const kinds = () => sql.prepare("SELECT DISTINCT collection FROM sync_items WHERE owner = 'u3' AND deleted = 0").all().map((r) => r.collection).sort();
  assert.ok(kinds().includes('bookmarks') && !kinds().includes('bookmarkTree'), 'only the list');
  const b = computer('Studio', [], { acct });
  await b.sync.tick();
  await b.sync.useRecoveryKey(a.sync.recoveryKey());
  await b.sync.tick();
  assert.equal(b.sync.status, 'ready', b.sync.error);
  assert.deepEqual(shape(b.store.marks.root('bar')), ['Jira']);
  // The server is updated: A sends its folders, and B takes them before sending its own.
  old = false;
  await a.sync.tick();
  assert.ok(kinds().includes('bookmarkTree'));
  await b.sync.tick();
  await a.sync.tick();
  assert.deepEqual(shape(b.store.marks.root('bar')), [['Work', ['Jira']]]);
  assert.deepEqual(shape(a.store.marks.root('bar')), [['Work', ['Jira']]]);
  assert.equal(treeRecords(b.store), treeRecords(a.store));
});
