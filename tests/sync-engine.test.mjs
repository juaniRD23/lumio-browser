// Lumio Sync end to end: two (then three) "computers", each with its own
// profile folder, syncing through the real server code (an in-memory D1).
// Without SYNC_MASTER_KEY the server doesn't hand out keys, so the first
// tests pair devices as before; the last ones give it a master key, so
// signing in is enough (docs/sync-managed.md).
import { test, before, after, describe } from 'node:test';
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
const C = require('../main/sync/crypto.js');

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
// olderLumio: a Lumio from before managed sync (Lumio Browser 0.6.7), which
// doesn't know the account's mode and always pairs.
function makeAccount(token, email, { oldServer = () => false, olderLumio = false } = {}) {
  return {
    base: 'https://lumio.test',
    token: () => token,
    state: () => ({ signedIn: true, email }),
    fetch: async (url, opts = {}) => {
      if (oldServer() && opts.body && /bookmarkTree/.test(opts.body)) return new Response(JSON.stringify({ error: 'Invalid record.' }), { status: 400 });
      const res = await worker.fetch(new Request(url, { method: opts.method, headers: opts.headers, body: opts.body }), env, { waitUntil() {} });
      const unknown = [...(oldServer() ? ['collections'] : []), ...(olderLumio ? ['mode', 'managedKey', 'managedAvailable'] : [])];
      if (!unknown.length || new URL(url).pathname !== '/api/sync' || (opts.method || 'GET') !== 'GET') return res;
      const data = await res.json();
      for (const k of unknown) delete data[k];
      return new Response(JSON.stringify(data), { status: res.status, headers: { 'content-type': 'application/json' } });
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

test('the reading list and saved tab groups sync between computers, encrypted', async () => {
  const { ReadingList } = require('../main/reading-list.js');
  const { SavedGroups } = require('../main/saved-groups.js');
  const { JsonFile } = require('../main/store.js');
  const token = 'tok_' + 'd'.repeat(40);
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u4', 'g-u4', 'ana@example.com', 'Ana', 'free', 0)").run();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), 'u4', Date.now() + 864e5);
  const acct = makeAccount(token, 'ana@example.com');
  const make = (name) => {
    const c = computer(name, [], { acct });
    const dir = path.dirname(c.store.settingsFile.file);
    c.reading = new ReadingList(new JsonFile(dir, 'reading-list.json', { items: [] }));
    c.saved = new SavedGroups(new JsonFile(dir, 'saved-groups.json', { groups: [] }));
    c.sync.addAdapters([adapters.readingList(c.reading), adapters.savedGroups(c.saved)]);
    return c;
  };
  const a = make('MacBook');
  const post = a.reading.add('https://essays.example/long-read', 'A long read');
  const groupId = a.saved.save({ title: 'Kitchen remodel', color: 'orange', tabs: [{ url: 'https://tiles.example/', title: 'Tiles' }] });
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);
  const b = make('Studio');
  await b.sync.tick();
  await b.sync.useRecoveryKey(a.sync.recoveryKey());
  await b.sync.tick();
  assert.equal(b.sync.status, 'ready', b.sync.error);
  assert.deepEqual(b.reading.list().map((x) => [x.url, x.read]), [['https://essays.example/long-read', false]]);
  assert.deepEqual(b.saved.list().map((g) => [g.id, g.title, g.color, g.tabs[0].url]), [[groupId, 'Kitchen remodel', 'orange', 'https://tiles.example/']]);
  // Read on one, it's read on the other; a group deleted on one goes on the other.
  b.reading.setRead(post.id, true);
  b.saved.remove(groupId);
  await b.sync.tick();
  await a.sync.tick();
  assert.equal(a.reading.get(post.id).read, true);
  assert.deepEqual(a.saved.list(), []);
  const kinds = sql.prepare("SELECT DISTINCT collection FROM sync_items WHERE owner = 'u4'").all().map((r) => r.collection);
  assert.ok(kinds.includes('readingList') && kinds.includes('savedGroups'));
  const stored = sql.prepare("SELECT data FROM sync_items WHERE owner = 'u4' AND data IS NOT NULL").all().map((r) => Buffer.from(r.data, 'base64').toString('latin1')).join('\n');
  for (const secret of ['essays', 'Kitchen', 'tiles']) assert.ok(!stored.includes(secret), `${secret} is encrypted`);
});

// ---------------------------------------------------------------- Lumio keeps the key
// The server has a master key: each account's sync key is kept there, wrapped,
// and handed to the account's signed-in devices (docs/sync-managed.md).
describe('when Lumio keeps the sync key', () => {
  const MASTER = crypto.randomBytes(32).toString('base64');
  before(() => { env.SYNC_MASTER_KEY = MASTER; });
  after(() => { delete env.SYNC_MASTER_KEY; }); // env is the whole file's

  let n = 0;
  // A fresh account and a session for it.
  function signUp() {
    const id = `m${++n}`;
    const email = `${id}@example.com`;
    const token = crypto.randomBytes(32).toString('hex'); // like the website's (its cookie takes only these)
    sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES (?, ?, ?, 'Max', 'free', 0)").run(id, `g-${id}`, email);
    sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 864e5);
    return { id, email, token, acct: makeAccount(token, email) };
  }
  const keyRow = (owner) => sql.prepare('SELECT mode, wrapped, key_check FROM sync_keys WHERE owner = ?').get(owner) || null;
  const items = (owner) => sql.prepare('SELECT id, collection, data FROM sync_items WHERE owner = ? AND data IS NOT NULL ORDER BY id').all(owner);
  const urls = (c) => c.store.bookmarks().map((x) => x.url).sort();

  test('signing in is enough: a second computer syncs with no approval, code or recovery key', async () => {
    const { id, acct } = signUp();
    const a = computer('MacBook', [], { acct });
    a.store.marks.add('bar', null, { url: 'https://bank.example/', title: 'My bank' });
    a.vault.save({ origin: 'https://bank.example', username: 'sam', password: 'hunter2-secret' });
    await a.sync.tick();
    assert.equal(a.sync.status, 'ready', a.sync.error);
    assert.deepEqual([a.sync.state().flow, a.sync.state().mode, a.sync.state().managedAvailable], ['managed', 'managed', true]);
    assert.ok(keyRow(id).wrapped, 'Lumio keeps the key, wrapped');
    assert.equal(sql.prepare('SELECT key_check FROM sync_meta WHERE owner = ?').get(id).key_check, keyRow(id).key_check);

    const b = computer('iMac', [{ url: 'https://docs.example/', title: 'Docs' }], { acct });
    b.store.marks.add('bar', null, { url: 'https://recipes.example/', title: 'Recipes' });
    await b.sync.tick();
    assert.equal(b.sync.status, 'ready', b.sync.error);
    assert.equal(b.sync.state().pairCode, null, 'no code to compare');
    assert.equal(b.sync.recoveryKey(), a.sync.recoveryKey(), 'the account’s key');
    await a.sync.tick();
    for (const c of [a, b]) assert.deepEqual(urls(c), ['https://bank.example/', 'https://recipes.example/']);
    assert.equal(b.vault.secret(b.vault.entries[0].id), 'hunter2-secret');
    assert.deepEqual(Object.values(a.sync.remoteTabs).map((t) => t.name), ['iMac']);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sync_pairings WHERE owner = ?').get(id).n, 0, 'nobody asked to be approved');
    for (const c of [a, b]) assert.deepEqual(c.sync.state().requests, []);
    // Still encrypted on the devices: nothing readable on the server.
    const stored = items(id).map((r) => Buffer.from(r.data, 'base64').toString('latin1')).join('\n');
    for (const secret of ['bank', 'hunter2', 'recipes', 'docs.example']) assert.ok(!stored.includes(secret), `${secret} is encrypted`);
    // Kept in the keychain, as before.
    assert.equal(b.store.getSecret(`syncKey:${acct.state().email}`), Buffer.from(b.sync.raw).toString('base64'));
  });

  test('an account from before: the first updated computer offers Lumio its key, nothing is encrypted again, and new computers join', async () => {
    const { id, acct } = signUp();
    delete env.SYNC_MASTER_KEY; // a server from before managed sync
    const a = computer('MacBook', [], { acct });
    a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    a.workflows.add({ title: 'Morning news', instructions: 'Read the top 3 stories.' });
    await a.sync.tick();
    assert.equal(a.sync.state().flow, 'e2ee');
    const b = computer('iMac', [], { acct });
    await b.sync.tick();
    assert.equal(b.sync.status, 'needs-key');
    await a.sync.tick();
    const [req] = a.sync.state().requests;
    assert.equal(req.code, b.sync.state().pairCode);
    assert.deepEqual(await a.sync.answer(req.id, true), { ok: true });
    await b.sync.tick();
    await b.sync.tick();
    assert.equal(b.sync.status, 'ready', b.sync.error);
    await a.sync.tick();
    const synced = items(id);
    assert.equal(keyRow(id), null);

    // The server is updated (D1 migration, then SYNC_MASTER_KEY).
    env.SYNC_MASTER_KEY = MASTER;
    await a.sync.tick();
    assert.equal(a.sync.status, 'ready', a.sync.error);
    assert.equal(a.sync.state().flow, 'managed');
    assert.ok(keyRow(id)?.wrapped, 'A offered its key');
    assert.equal(keyRow(id).key_check, sql.prepare('SELECT key_check FROM sync_meta WHERE owner = ?').get(id).key_check);
    assert.deepEqual(items(id), synced, 'every record as it was: nothing encrypted again');
    await b.sync.tick();
    assert.equal(b.sync.status, 'ready', b.sync.error);
    assert.deepEqual(items(id), synced, 'B already had the key');

    // A new computer joins on its own and reads what A synced before.
    const c = computer('Studio', [], { acct });
    await c.sync.tick();
    assert.equal(c.sync.status, 'ready', c.sync.error);
    assert.equal(c.sync.state().pairCode, null);
    assert.deepEqual(urls(c), ['https://news.example/']);
    assert.equal(c.workflows.list()[0].title, 'Morning news');
    const before = new Map(synced.map((r) => [r.id, r.data]));
    for (const r of items(id).filter((x) => x.collection === 'bookmarks' || x.collection === 'workflows')) assert.equal(r.data, before.get(r.id), `${r.collection} record unchanged`);
  });

  test('Lumio Beta on the same Mac waits while only the computer from before has the key, and joins on its own once it offers it', async () => {
    const { id, acct } = signUp();
    delete env.SYNC_MASTER_KEY;
    const stable = computer('MacBook', [], { acct });
    stable.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await stable.sync.tick();
    assert.equal(stable.sync.status, 'ready', stable.sync.error);
    env.SYNC_MASTER_KEY = MASTER;

    // The Beta (its own profile folder, same account) signs in before stable runs again.
    const beta = computer('MacBook (Lumio Beta)', [], { acct });
    await beta.sync.tick();
    assert.equal(beta.sync.status, 'needs-key');
    const st = beta.sync.state();
    assert.equal(st.flow, 'managed', 'shown as finishing setup');
    assert.match(st.pairCode, /^\d{6}$/, 'a Lumio from before can still approve it');
    await beta.sync.tick();
    assert.equal(beta.sync.status, 'needs-key', 'still waiting: nobody has offered the key');

    await stable.sync.tick(); // the updated stable offers the key; no approval needed
    assert.deepEqual(stable.sync.state().requests, [], 'never asked to approve');
    assert.ok(keyRow(id).wrapped);
    await beta.sync.tick(); // gets the key from Lumio and syncs
    assert.equal(beta.sync.status, 'ready', beta.sync.error);
    assert.equal(beta.sync.state().pairCode, null);
    assert.deepEqual(urls(beta), ['https://news.example/']);
  });

  test('a computer waiting for the key takes the recovery key, and gives Lumio the key', async () => {
    const { id, acct } = signUp();
    delete env.SYNC_MASTER_KEY;
    const a = computer('MacBook', [], { acct });
    a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await a.sync.tick();
    env.SYNC_MASTER_KEY = MASTER;

    const beta = computer('MacBook (Lumio Beta)', [], { acct });
    await beta.sync.tick();
    assert.equal(beta.sync.status, 'needs-key');
    assert.equal(beta.sync.state().flow, 'managed');
    assert.deepEqual(await beta.sync.useRecoveryKey(a.sync.recoveryKey()), { ok: true });
    await beta.sync.tick();
    assert.equal(beta.sync.status, 'ready', beta.sync.error);
    assert.ok(keyRow(id)?.wrapped, 'the Beta offered the key');
    assert.deepEqual(urls(beta), ['https://news.example/']);
    const c = computer('Studio', [], { acct });
    await c.sync.tick();
    assert.equal(c.sync.status, 'ready', c.sync.error);
    assert.deepEqual(urls(c), ['https://news.example/']);
  });

  test('when only Lumio Browser 0.6.7 has the key, it approves the Beta as before, and the Beta gives Lumio the key', async () => {
    const { id, email, token, acct } = signUp();
    const old = computer('MacBook', [], { acct: makeAccount(token, email, { olderLumio: true }) });
    old.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await old.sync.tick();
    assert.equal(old.sync.status, 'ready', old.sync.error);
    assert.equal(old.sync.state().flow, 'e2ee');
    assert.equal(keyRow(id), null, 'an older Lumio sets up the account without Lumio keeping the key');

    const beta = computer('MacBook (Lumio Beta)', [], { acct });
    await beta.sync.tick();
    assert.equal(beta.sync.status, 'needs-key');
    await old.sync.tick();
    const [req] = old.sync.state().requests;
    assert.deepEqual([req.name, req.code], ['MacBook (Lumio Beta)', beta.sync.state().pairCode], 'the older Lumio sees the request, with the code');
    await old.sync.answer(req.id, true);
    await beta.sync.tick(); // gets the key
    await beta.sync.tick(); // syncs, and offers Lumio the key
    assert.equal(beta.sync.status, 'ready', beta.sync.error);
    assert.ok(keyRow(id)?.wrapped, 'migrated');
    assert.deepEqual(urls(beta), ['https://news.example/']);

    // Another older Lumio is now let in by Lumio itself, at its next check.
    const old2 = computer('iMac', [], { acct: makeAccount(token, email, { olderLumio: true }) });
    await old2.sync.tick();
    assert.equal(old2.sync.status, 'needs-key');
    await old.sync.tick();
    assert.deepEqual(old.sync.state().requests, [], 'nothing left for people to approve');
    await old2.sync.tick(); // approved by the server
    await old2.sync.tick();
    assert.equal(old2.sync.status, 'ready', old2.sync.error);
    assert.deepEqual(urls(old2), ['https://news.example/']);
  });

  test('signing out removes a key Lumio keeps from the computer; a run that doesn’t know the account yet never does', async () => {
    const { email, token } = signUp();
    let signedIn = true;
    const acct = { ...makeAccount(token, email), state: () => ({ signedIn, email }) };
    const a = computer('MacBook', [], { acct });
    a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await a.sync.tick();
    assert.equal(a.sync.status, 'ready', a.sync.error);
    const key = a.sync.recoveryKey();
    const saved = () => a.store.getSecret(`syncKey:${email}`);
    assert.ok(saved());

    // Starting up, or offline: the account isn't known yet.
    signedIn = false;
    await a.sync.tick();
    assert.equal(a.sync.status, 'signed-out');
    assert.ok(saved(), 'kept');
    assert.equal(a.sync.recoveryKey(), key);

    a.sync.signedOut();
    assert.equal(saved(), '', 'removed from the keychain');
    assert.equal(a.sync.recoveryKey(), null);
    assert.equal(a.sync.keys, null);
    assert.equal(a.sync.status, 'signed-out');
    assert.deepEqual(a.sync.file.data.records, {});

    // Signing in again gets the key back: no approval, and what's here merges.
    a.store.marks.add('bar', null, { url: 'https://later.example/', title: 'Later' });
    signedIn = true;
    await a.sync.tick();
    assert.equal(a.sync.status, 'ready', a.sync.error);
    assert.equal(a.sync.recoveryKey(), key);
    assert.deepEqual(urls(a), ['https://later.example/', 'https://news.example/']);
  });

  test('signing out while a run is getting the key doesn’t leave the key behind', async () => {
    const { email, token } = signUp();
    let current = token;
    const real = makeAccount(token, email);
    let a;
    const acct = { ...real, token: () => current, state: () => ({ signedIn: !!current, email }), fetch: async (url, opts = {}) => {
      const res = await real.fetch(url, opts);
      if (new URL(url).pathname === '/api/sync/key' && opts.method === 'POST') { current = ''; a.sync.signedOut(); } // as main/account.js does
      return res;
    } };
    a = computer('MacBook', [], { acct });
    await a.sync.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(a.store.getSecret(`syncKey:${email}`), '', 'not in the keychain');
    assert.equal(a.sync.keys, null);
    assert.equal(a.sync.status, 'signed-out');
  });

  test('Lumio account: signing out, or the session ending, tells sync; being offline doesn’t', async () => {
    const { LumioAccount } = require('../main/account.js');
    const { email, token } = signUp();
    let offline = false;
    let ended = 0;
    let c;
    const account = new LumioAccount({
      store: new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-account-')), safe),
      onSignedOut: () => { ended++; c.sync.signedOut(); },
      fetchImpl: async (url, opts = {}) => {
        if (offline) throw new TypeError('fetch failed');
        if (new URL(url).pathname.startsWith('/v1/')) return new Response('{}', { status: 404 });
        return worker.fetch(new Request(url, { method: opts.method, headers: opts.headers, body: opts.body }), env, { waitUntil() {} });
      },
    });
    account.store.setSecret('lumio-session', token);
    await account.refresh();
    assert.equal(account.state().email, email);
    c = computer('MacBook', [], { acct: account }); // as in main.js: the profile's account
    await c.sync.tick();
    assert.equal(c.sync.status, 'ready', c.sync.error);
    const saved = () => c.store.getSecret(`syncKey:${email}`);
    assert.ok(saved());

    offline = true;
    await account.refresh();
    assert.equal(ended, 0, 'offline isn’t signed out');
    assert.ok(saved());
    offline = false;

    // The session ends on the server (signed out on the website, password changed).
    sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'));
    await account.refresh();
    assert.equal(account.state().signedIn, false);
    assert.equal(ended, 1);
    assert.equal(saved(), '', 'the key left with the session');
    await account.refresh();
    assert.equal(ended, 1, 'no session, nothing more to end');

    // An explicit sign-out does the same.
    const token2 = crypto.randomBytes(32).toString('hex');
    const owner = sql.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(token2).digest('hex'), owner, Date.now() + 864e5);
    account.store.setSecret('lumio-session', token2);
    await account.refresh();
    await c.sync.tick();
    assert.equal(c.sync.status, 'ready', c.sync.error);
    assert.ok(saved());
    await account.signOut();
    assert.equal(ended, 2);
    assert.equal(saved(), '');
    assert.equal(c.sync.status, 'signed-out');
  });

  test('Encrypt with my own passphrase: a new key only devices have, approvals as before; turned off, new computers join on their own again', async () => {
    const { id, email, acct } = signUp();
    const a = computer('MacBook', [], { acct });
    a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await a.sync.tick();
    const b = computer('iMac', [], { acct });
    b.store.marks.add('bar', null, { url: 'https://recipes.example/', title: 'Recipes' });
    await b.sync.tick();
    await a.sync.tick();
    const oldKey = a.sync.recoveryKey();
    const oldItems = new Set(items(id).map((r) => r.id));

    await assert.rejects(computer('Studio', [], { acct }).sync.setMode('passphrase'), /Wait for sync to finish turning on first/);
    assert.deepEqual(await a.sync.setMode('passphrase'), { mode: 'passphrase' });
    assert.notEqual(a.sync.recoveryKey(), oldKey, 'a new key');
    assert.deepEqual([a.sync.state().flow, a.sync.state().mode], ['e2ee', 'passphrase']);
    assert.deepEqual({ ...keyRow(id) }, { mode: 'passphrase', wrapped: null, key_check: null }, 'Lumio no longer has a key');
    await a.sync.tick(); // uploads everything again, with the new key
    assert.equal(a.sync.status, 'ready', a.sync.error);
    assert.ok(items(id).length && items(id).every((r) => !oldItems.has(r.id)), 'what Lumio could read is gone');

    // The other computer needs to be approved, as before.
    await b.sync.tick();
    assert.equal(b.sync.status, 'needs-key');
    assert.equal(b.sync.state().flow, 'e2ee');
    await a.sync.tick();
    const [req] = a.sync.state().requests;
    assert.deepEqual([req.name, req.code], ['iMac', b.sync.state().pairCode]);
    await a.sync.answer(req.id, true);
    await b.sync.tick();
    await b.sync.tick();
    assert.equal(b.sync.status, 'ready', b.sync.error);
    assert.equal(b.sync.recoveryKey(), a.sync.recoveryKey());
    await a.sync.tick();
    for (const c of [a, b]) assert.deepEqual(urls(c), ['https://news.example/', 'https://recipes.example/']);

    // With the account's own passphrase, signing out keeps the key.
    b.sync.signedOut();
    assert.ok(b.store.getSecret(`syncKey:${email}`));
    await b.sync.tick();
    assert.equal(b.sync.status, 'ready', b.sync.error);

    // Turned off: Lumio keeps A's key, and a new computer joins on its own.
    assert.deepEqual(await a.sync.setMode('managed'), { mode: 'managed' });
    assert.deepEqual([a.sync.state().flow, keyRow(id).mode], ['managed', 'managed']);
    assert.ok(keyRow(id).wrapped);
    const c = computer('Studio', [], { acct });
    await c.sync.tick();
    assert.equal(c.sync.status, 'ready', c.sync.error);
    assert.equal(c.sync.recoveryKey(), a.sync.recoveryKey());
    assert.deepEqual(urls(c), ['https://news.example/', 'https://recipes.example/']);
    // Already managed: no error, nothing changes.
    assert.deepEqual(await a.sync.setMode('managed'), { mode: 'managed' });
  });

  test('a computer that missed the switch to the account’s own passphrase asks to be approved instead', async () => {
    const { email, token, acct } = signUp();
    const a = computer('MacBook', [], { acct });
    await a.sync.tick();
    await a.sync.setMode('passphrase');
    // B's status reply is from just before the switch (the switch lands in between).
    let stale = true;
    const real = makeAccount(token, email);
    const b = computer('iMac', [], { acct: { ...real, fetch: async (url, opts = {}) => {
      const res = await real.fetch(url, opts);
      if (!stale || new URL(url).pathname !== '/api/sync' || (opts.method || 'GET') !== 'GET') return res;
      stale = false;
      return new Response(JSON.stringify({ ...(await res.json()), mode: 'managed', managedKey: true }), { status: res.status, headers: { 'content-type': 'application/json' } });
    } } });
    await b.sync.tick();
    assert.equal(b.sync.state().mode, 'passphrase', 'Lumio said so when asked for the key');
    assert.equal(b.sync.state().flow, 'e2ee');
    await b.sync.tick();
    assert.equal(b.sync.status, 'needs-key');
    assert.match(b.sync.state().pairCode, /^\d{6}$/);
  });

  // Every request a computer makes, as "METHOD /path".
  function logged(acct) {
    const calls = [];
    return { calls, acct: { ...acct, fetch: async (url, opts = {}) => { calls.push(`${opts.method || 'GET'} ${new URL(url).pathname}`); return acct.fetch(url, opts); } } };
  }
  // Another holder of the account's session (a stolen token, say), straight to the server.
  const asAttacker = (token) => async (path, method = 'GET', body) => {
    const res = await worker.fetch(new Request(`https://lumio.test${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };

  test('the account’s own passphrase isn’t turned off by the server’s word alone: the key never goes to Lumio, and no other key comes back', async () => {
    const { id, email, token, acct: real } = signUp();
    const { calls, acct } = logged(real);
    const a = computer('MacBook', [], { acct });
    a.vault.save({ origin: 'https://bank.example', username: 'sam', password: 'hunter2-secret' });
    await a.sync.tick();
    await a.sync.setMode('passphrase');
    await a.sync.tick();
    assert.equal(a.sync.status, 'ready', a.sync.error);
    const K = a.store.getSecret(`syncKey:${email}`);

    // Someone with the session deletes the synced data and makes the account managed with a key of theirs.
    const evil = asAttacker(token);
    const X = C.newKey();
    const checkX = (await C.deriveKeys(X)).check;
    assert.equal((await evil('/api/sync', 'DELETE')).status, 200);
    const refused = await evil('/api/sync/mode', 'PUT', { mode: 'managed', key: C.toB64(X) });
    assert.deepEqual([refused.status, refused.code], [409, 'sync_not_set_up'], 'not with nothing synced');
    assert.equal((await evil('/api/sync/init', 'POST', { keyCheck: checkX })).status, 200);
    assert.equal((await evil('/api/sync/mode', 'PUT', { mode: 'managed', key: C.toB64(X) })).status, 200);

    calls.length = 0;
    for (let i = 0; i < 2; i++) await a.sync.tick();
    const st = a.sync.state();
    assert.deepEqual([st.mode, st.flow, st.modeChanged, st.status], ['passphrase', 'e2ee', true, 'error']);
    assert.match(st.error, /Paused to keep your sync key private/);
    assert.equal(a.store.getSecret(`syncKey:${email}`), K, 'its own key, kept');
    assert.ok(!calls.includes('PUT /api/sync/key'), 'never handed to Lumio');
    assert.ok(!calls.includes('POST /api/sync/key'), 'Lumio’s key never asked for (it isn’t this computer’s)');
    assert.ok(!calls.includes('POST /api/sync/pair'), 'nobody asked to approve it (Lumio would answer with its key)');
    assert.ok(!calls.includes('POST /api/sync/push'), 'nothing sealed with another key');
    assert.equal(keyRow(id).key_check, checkX);
    assert.equal(a.sync.recoveryKey(), null, 'not the account’s key now');

    // The server keeps the account's check but forgets its mode (or a changed database says managed):
    // the computer keeps syncing with its own key, and still never hands it over.
    const own = signUp();
    const c = computer('Studio', [], { acct: own.acct });
    await c.sync.tick();
    await c.sync.setMode('passphrase');
    await c.sync.tick();
    const Kc = c.store.getSecret(`syncKey:${own.email}`);
    sql.prepare('DELETE FROM sync_keys WHERE owner = ?').run(own.id);
    const cCalls = logged(own.acct);
    c.sync.account = cCalls.acct;
    await c.sync.tick();
    assert.deepEqual([c.sync.status, c.sync.state().mode, c.sync.state().modeChanged], ['ready', 'passphrase', true], c.sync.error);
    // A wrapped key that isn't really there (a changed database) doesn't count as Lumio having this computer's key.
    sql.prepare("INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at) VALUES (?, 'managed', ?, ?, 0, 0)").run(own.id, `v1.${'A'.repeat(16)}.${'B'.repeat(64)}`, (await C.deriveKeys(C.fromB64(Kc))).check);
    await c.sync.tick();
    await c.sync.tick();
    assert.deepEqual([c.sync.status, c.sync.state().mode], ['ready', 'passphrase'], c.sync.error);
    assert.ok(!cCalls.calls.includes('PUT /api/sync/key'), 'never uploaded');
    assert.equal(keyRow(own.id).wrapped, null, 'Lumio still has no key');
    assert.equal(c.store.getSecret(`syncKey:${own.email}`), Kc);

    // The person turns it off here: their choice, so this computer follows Lumio's key.
    assert.deepEqual(await a.sync.setMode('managed'), { mode: 'managed' });
    await a.sync.tick();
    assert.deepEqual([a.sync.status, a.sync.state().flow, a.sync.state().modeChanged], ['ready', 'managed', false], a.sync.error);
    assert.equal(a.sync.state().error, null);
  });

  test('turned off on another Mac that has the key: this computer checks Lumio has that same key, then just follows', async () => {
    const { id, email, acct } = signUp();
    const a = computer('MacBook', [], { acct });
    await a.sync.tick();
    await a.sync.setMode('passphrase');
    const b = computer('iMac', [], { acct });
    await b.sync.tick();
    assert.equal(b.sync.status, 'needs-key');
    assert.deepEqual(await b.sync.useRecoveryKey(a.sync.recoveryKey()), { ok: true });
    await b.sync.tick();
    assert.deepEqual([b.sync.status, b.sync.state().mode], ['ready', 'passphrase'], b.sync.error);
    await a.sync.setMode('managed');
    await b.sync.tick();
    assert.deepEqual([b.sync.status, b.sync.state().mode, b.sync.state().flow, b.sync.state().modeChanged], ['ready', 'managed', 'managed', false], b.sync.error);
    assert.equal(b.store.getSecret(`syncKey:${email}`), a.store.getSecret(`syncKey:${email}`));
    assert.equal(keyRow(id).mode, 'managed');
    // Signed out now, the key leaves (Lumio keeps it).
    b.sync.signedOut();
    assert.equal(b.store.getSecret(`syncKey:${email}`), '');
  });

  test('switching to the account’s own passphrase when the answer is lost: the next run, or trying again, ends on the new key, with its recovery key', async () => {
    for (const how of ['next run', 'try again']) {
      const { email, token, acct: real } = signUp();
      let lose = false;
      const acct = { ...real, fetch: async (url, opts = {}) => {
        const res = await real.fetch(url, opts);
        if (lose && new URL(url).pathname === '/api/sync/mode') { lose = false; throw new TypeError('fetch failed'); } // the server took it; the answer never came
        return res;
      } };
      const a = computer('MacBook', [], { acct });
      a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
      await a.sync.tick();
      const b = computer('iMac', [], { acct: real });
      await b.sync.tick();
      assert.equal(b.sync.status, 'ready', b.sync.error);
      lose = true;
      await assert.rejects(a.sync.setMode('passphrase'), /fetch failed/);
      const { keyCheck } = await asAttacker(token)('/api/sync');
      assert.notEqual(a.sync.keys.check, keyCheck, 'the server switched; this computer still has the old key');
      if (how === 'next run') {
        await a.sync.tick();
        assert.equal(a.sync.status, 'ready', a.sync.error);
      } else {
        assert.deepEqual(await a.sync.setMode('passphrase'), { mode: 'passphrase' }, 'already_passphrase, with this computer’s key');
      }
      assert.equal(a.sync.keys.check, keyCheck, how);
      assert.equal(a.sync.state().mode, 'passphrase');
      assert.equal(a.store.getSecret(`syncKey:${email}:pending`), '', 'the pending key is done');
      const raw = C.fromRecovery(a.sync.recoveryKey());
      assert.equal((await C.deriveKeys(raw)).check, keyCheck, 'the recovery key shown unlocks the account');
      await a.sync.tick();
      assert.equal(a.sync.status, 'ready', a.sync.error);
      // The other computer, still holding the old key, waits: no recovery key from it meanwhile; the one shown on A works.
      await b.sync.tick();
      assert.equal(b.sync.status, 'needs-key');
      assert.ok(b.sync.raw, 'it still has the old key');
      assert.equal(b.sync.recoveryKey(), null, 'which isn’t shown as a recovery key');
      assert.deepEqual(await b.sync.useRecoveryKey(a.sync.recoveryKey()), { ok: true });
      await b.sync.tick();
      assert.equal(b.sync.status, 'ready', b.sync.error);
      assert.deepEqual(urls(b), ['https://news.example/']);
    }
  });

  test('with a server that doesn’t keep keys, signing out keeps the key, as before', async () => {
    const { email, acct } = signUp();
    delete env.SYNC_MASTER_KEY;
    try {
      const a = computer('MacBook', [], { acct });
      await a.sync.tick();
      assert.deepEqual([a.sync.status, a.sync.state().flow, a.sync.state().mode], ['ready', 'e2ee', 'managed'], a.sync.error);
      a.sync.signedOut();
      assert.ok(a.store.getSecret(`syncKey:${email}`), 'kept: no other copy may exist');
      await a.sync.tick();
      assert.equal(a.sync.status, 'ready', a.sync.error);
    } finally {
      env.SYNC_MASTER_KEY = MASTER;
    }
  });

  test('“too many requests” from Lumio’s key route: no asking again for ten minutes', async () => {
    const { acct: real } = signUp();
    let refuse = true;
    const { calls, acct } = logged({ ...real, fetch: async (url, opts = {}) => {
      if (refuse && new URL(url).pathname === '/api/sync/key' && opts.method === 'POST') return new Response(JSON.stringify({ error: 'Too many requests. Try again in a few minutes.', code: 'rate_limited' }), { status: 429, headers: { 'retry-after': '600' } });
      return real.fetch(url, opts);
    } });
    const a = computer('MacBook', [], { acct });
    await a.sync.tick();
    assert.equal(a.sync.status, 'error');
    for (let i = 0; i < 3; i++) await a.sync.tick();
    assert.equal(calls.filter((c) => c === 'POST /api/sync/key').length, 1, 'once, not every run');
    assert.match(a.sync.error, /Too many requests/);
    refuse = false;
    a.sync.keyRetryAt = Date.now() - 1; // ten minutes on
    await a.sync.tick();
    assert.equal(a.sync.status, 'ready', a.sync.error);
  });

  test('a computer mid-run while another resets uploads nothing sealed with the old key, then joins with the new one', async () => {
    const { id, acct: real } = signUp();
    const a = computer('MacBook', [], { acct: real });
    a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await a.sync.tick();
    let resetFirst = false;
    let b;
    const acct = { ...real, fetch: async (url, opts = {}) => {
      if (resetFirst && new URL(url).pathname === '/api/sync/push') { resetFirst = false; await a.sync.resetSync(); }
      return real.fetch(url, opts);
    } };
    b = computer('iMac', [], { acct });
    await b.sync.tick();
    b.store.marks.add('bar', null, { url: 'https://recipes.example/', title: 'Recipes' });
    resetFirst = true;
    await b.sync.tick(); // its status check saw the old key; the reset lands before its push
    const newKeys = await C.deriveKeys(a.sync.raw);
    for (const r of items(id)) await C.open(newKeys, r.collection, r.id, r.data); // every record opens with the new key
    await new Promise((r) => setTimeout(r, 1100)); // the run it asked for
    for (const c of [b, a, b, a]) await c.sync.tick();
    assert.equal(b.sync.status, 'ready', b.sync.error);
    assert.equal(b.sync.keys.check, newKeys.check);
    for (const c of [a, b]) assert.deepEqual(urls(c), ['https://news.example/', 'https://recipes.example/']);
    for (const r of items(id)) await C.open(newKeys, r.collection, r.id, r.data);
  });

  test('Reset sync: a new key, the old records gone, and every computer uploads what it has again', async () => {
    const { id, acct } = signUp();
    const a = computer('MacBook', [], { acct });
    a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
    await a.sync.tick();
    const b = computer('iMac', [], { acct });
    b.store.marks.add('bar', null, { url: 'https://recipes.example/', title: 'Recipes' });
    await b.sync.tick();
    await a.sync.tick();
    const oldKey = a.sync.recoveryKey();
    const oldCheck = keyRow(id).key_check;
    const oldItems = new Set(items(id).map((r) => r.id));

    assert.deepEqual(await a.sync.resetSync(), {});
    assert.notEqual(keyRow(id).key_check, oldCheck);
    assert.notEqual(a.sync.recoveryKey(), oldKey);
    assert.equal(a.sync.status, 'ready');
    assert.deepEqual(items(id), [], 'everything synced was deleted');
    assert.ok(a.sync.prefs.on, 'sync stays on');
    await a.sync.tick();
    await b.sync.tick(); // sees the new key, gets it from Lumio, and uploads what it has
    assert.equal(b.sync.status, 'ready', b.sync.error);
    assert.equal(b.sync.recoveryKey(), a.sync.recoveryKey());
    await a.sync.tick();
    for (const c of [a, b]) assert.deepEqual(urls(c), ['https://news.example/', 'https://recipes.example/']);
    assert.ok(items(id).every((r) => !oldItems.has(r.id)), 'only records made with the new key');

    // In passphrase mode, reset isn't offered: those accounts delete their synced data instead.
    await a.sync.setMode('passphrase');
    await assert.rejects(a.sync.resetSync(), /Reset is for accounts where Lumio keeps the sync key/);
  });
});
