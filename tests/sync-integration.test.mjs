// Lumio Sync after the v0.6.8 merges: the synced settings are the union of
// every batch's preferences (and only the ones that should follow the
// person), the newer collections (reading list, saved tab groups, passkeys,
// addresses, cards) sync together in one engine through the real server code
// (an in-memory D1), and a server that doesn't keep the newer collections
// still syncs the rest without refusing anything.
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
const { Store, JsonFile } = require('../main/store.js');
const { AutofillStore } = require('../main/autofill-store.js');
const { PasskeyStore } = require('../main/passkeys.js');
const { ReadingList } = require('../main/reading-list.js');
const { SavedGroups } = require('../main/saved-groups.js');
const { SyncEngine } = require('../main/sync/engine.js');
const adapters = require('../main/sync/adapters.js');

const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`k:${s}`), decryptString: (b) => b.toString().slice(2) };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lumio-sync-int-${name}-`));
const b64 = (b) => Buffer.from(b).toString('base64url');

// ---------------------------------------------------------------- settings
// Preferences each batch added that follow the person between computers.
const SYNCED = ['startupPages', 'showHome', 'homePage', 'searchEngines', 'searchSuggest', 'languages', 'spellcheck', 'spellcheckLanguages',
  'autofillAddresses', 'autofillCards', 'formHistory', 'askDownload', 'verticalTabs', 'translate', 'reader', 'ntpShortcuts', 'contentDefaults', 'newTab'];
// This computer's own: they never leave it.
const LOCAL = ['downloadDir', 'hardwareAcceleration', 'devtoolsDock', 'panelOpen', 'panelWidth', 'sidebarOpen', 'defaultZoom', 'zoomLevels', 'shortcuts',
  'printSettings', 'security', 'searchEnginesFound', 'sitePermissions', 'crashReports', 'caretBrowsing', 'accessibility', 'uiLanguage', 'sync', 'syncDeviceId', 'energySaver', 'preloadPages'];

test('the synced settings are the union of every batch’s preferences, without device-specific ones', () => {
  for (const k of SYNCED) assert.ok(adapters.SETTINGS.includes(k), `${k} syncs`);
  for (const k of LOCAL) assert.ok(!adapters.SETTINGS.includes(k), `${k} stays on this computer`);
  assert.equal(new Set(adapters.SETTINGS).size, adapters.SETTINGS.length, 'no key twice');
});

test('every synced setting goes from one computer to another, and comes back unchanged', () => {
  const a = new Store(tmp('set-a'), safe);
  const b = new Store(tmp('set-b'), safe);
  // A value of the right kind for each, different from the defaults.
  const sample = {
    searchEngine: 'duckduckgo', approvalMode: 'auto', reasoning: 'high', showBookmarksBar: false, memorySaver: false, memorySaverMinutes: 30,
    memorySaverMode: 'maximum', startup: 'pages', offerPasswords: false, autofillPasswords: false, profile: { name: 'Sam', color: '#ff8800', photo: null, theme: 'green' },
    appearance: 'dark', newTab: { background: 'plain' }, startupPages: [{ url: 'https://news.example/', title: 'News' }], showHome: true, homePage: 'https://home.example/',
    searchEngines: [{ id: 'c1', name: 'Docs', keyword: 'd', url: 'https://docs.example/?q=%s' }],
    searchSuggest: false, languages: ['es', 'en-US'], spellcheck: false, spellcheckLanguages: ['es'], autofillAddresses: false, autofillCards: false, formHistory: false,
    askDownload: true, verticalTabs: true, translate: { always: ['fr'], never: ['de'], sites: ['blog.example'], target: 'es', declined: {} },
    reader: { font: 'serif', size: 20, spacing: 'loose', theme: 'sepia', speed: 1.25 }, ntpShortcuts: { mode: 'custom', custom: [{ url: 'https://mail.example/', title: 'Mail' }], blocked: [], hidden: false },
    contentDefaults: { notifications: 'block', location: 'ask' },
  };
  assert.deepEqual(Object.keys(sample).sort(), [...adapters.SETTINGS].sort(), 'the sample covers every synced key');
  for (const [k, v] of Object.entries(sample)) a.setSetting(k, v);
  for (const k of ['downloadDir', 'defaultZoom', 'security', 'hardwareAcceleration']) a.setSetting(k, k === 'defaultZoom' ? 150 : { device: 'a' });
  const before = { downloadDir: b.settings.downloadDir, defaultZoom: b.settings.defaultZoom };

  const sa = adapters.settings(a);
  const [entry] = sa.entries();
  assert.equal(entry.key, 'prefs');
  const record = JSON.parse(JSON.stringify(entry.get())); // as it comes out of the encrypted record
  for (const k of ['downloadDir', 'defaultZoom', 'security', 'hardwareAcceleration']) assert.ok(!(k in record), `${k} isn’t sent`);

  let applied = 0;
  adapters.settings(b, { onApplied: () => applied++ }).apply([{ key: 'prefs', record }]);
  assert.equal(applied, 1);
  for (const [k, v] of Object.entries(sample)) assert.deepEqual(b.settings[k], v, `${k} arrived`);
  assert.deepEqual({ downloadDir: b.settings.downloadDir, defaultZoom: b.settings.defaultZoom }, before, 'device settings untouched');
  assert.equal(b.settings.security, undefined);
  // The same record on both: B has nothing new to send back.
  assert.equal(adapters.settings(b).entries()[0].hash, entry.hash, 'no echo');

  // A record from an older Lumio (fewer keys) leaves the newer keys alone.
  const older = Object.fromEntries(Object.entries(record).filter(([k]) => !['verticalTabs', 'translate', 'reader', 'ntpShortcuts', 'contentDefaults'].includes(k)));
  adapters.settings(b).apply([{ key: 'prefs', record: { ...older, searchEngine: 'bing' } }]);
  assert.equal(b.settings.searchEngine, 'bing');
  assert.deepEqual(b.settings.reader, sample.reader);
  assert.equal(b.settings.verticalTabs, true);
});

// ---------------------------------------------------------------- the server
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

let sql;
let env;
before(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  env = { DB: d1(sql) };
});

function user(id) {
  const token = `tok_${crypto.randomBytes(20).toString('hex')}`;
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES (?, ?, ?, 'Sam', 'free', 0)").run(id, `g-${id}`, `${id}@example.com`);
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), id, Date.now() + 864e5);
  return token;
}

// keeps: null for today's server; otherwise the collections an older server
// keeps (it lists them, and refuses records of any other).
function makeAccount(token, { keeps = () => null, pushes = [] } = {}) {
  return {
    base: 'https://lumio.test',
    token: () => token,
    state: () => ({ signedIn: true, email: 'sam@example.com' }),
    fetch: async (url, opts = {}) => {
      const p = new URL(url).pathname;
      const kept = keeps();
      if (p === '/api/sync/push') {
        const kinds = [...new Set(JSON.parse(opts.body).items.map((it) => it.collection))];
        pushes.push(kinds);
        if (kept && kinds.some((k) => !kept.includes(k))) return new Response(JSON.stringify({ error: 'Invalid record.', code: 'invalid_request' }), { status: 400 });
      }
      const res = await worker.fetch(new Request(url, { method: opts.method, headers: opts.headers, body: opts.body }), env, { waitUntil() {} });
      if (!kept || p !== '/api/sync' || (opts.method || 'GET') !== 'GET') return res;
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, collections: kept }), { status: res.status, headers: { 'content-type': 'application/json' } });
    },
  };
}

function computer(name, acct) {
  const dir = tmp(name);
  const store = new Store(dir, safe);
  const reading = new ReadingList(new JsonFile(dir, 'reading-list.json', { items: [] }));
  const saved = new SavedGroups(new JsonFile(dir, 'saved-groups.json', { groups: [] }));
  const autofill = new AutofillStore(dir, safe);
  const passkeys = new PasskeyStore(dir, safe);
  const sync = new SyncEngine({ dir, store, account: acct });
  sync.addAdapters([
    adapters.bookmarks(store), adapters.bookmarkTree(store), adapters.readingList(reading), adapters.savedGroups(saved),
    adapters.passkeys(passkeys), adapters.addresses(autofill), adapters.cards(autofill), adapters.history(store), adapters.settings(store),
  ]);
  sync.deviceName = name;
  return { store, reading, saved, autofill, passkeys, sync };
}

function newPasskey(c) {
  return c.passkeys.create({
    challenge: b64(crypto.randomBytes(32)), rp: { id: 'example.com' }, user: { id: b64(Buffer.from('sam-1')), name: 'sam@example.com', displayName: 'Sam' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  }, 'https://example.com', { verified: true });
}

async function join(c, from) {
  await c.sync.tick();
  assert.deepEqual(await c.sync.useRecoveryKey(from.sync.recoveryKey()), { ok: true });
  await c.sync.tick();
  assert.equal(c.sync.status, 'ready', c.sync.error);
}

test('reading list, saved groups, passkeys, addresses, cards and settings sync together in one engine', async () => {
  const pushes = [];
  const acct = makeAccount(user('u-all'), { pushes });
  const a = computer('MacBook', acct);
  const post = a.reading.add('https://essays.example/long-read', 'A long read');
  const groupId = a.saved.save({ title: 'Kitchen remodel', color: 'orange', tabs: [{ url: 'https://tiles.example/', title: 'Tiles' }] });
  const key = newPasskey(a);
  a.autofill.saveAddress({ name: 'Sam Lee', street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' });
  a.autofill.saveCard({ number: '4111 1111 1111 1111', name: 'Sam Lee', expMonth: 1, expYear: 2031 });
  a.store.setSetting('reader', { font: 'serif', size: 19, spacing: 'normal', theme: 'sepia', speed: 1 });
  a.store.setSetting('verticalTabs', true);
  a.sync.setPrefs({ types: { cards: true } });
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);

  const b = computer('Studio', acct);
  b.sync.setPrefs({ types: { cards: true } });
  await join(b, a);

  assert.deepEqual(b.reading.list().map((x) => x.url), ['https://essays.example/long-read']);
  assert.deepEqual(b.saved.list().map((g) => [g.id, g.title]), [[groupId, 'Kitchen remodel']]);
  assert.deepEqual(b.passkeys.list().map((k) => [k.id, k.rpId]), [[key.id, 'example.com']]);
  assert.deepEqual(b.autofill.addresses().map((x) => [x.name, x.zip]), [['Sam Lee', '78701']]);
  assert.deepEqual(b.autofill.cards().map((c) => c.last4), ['1111']);
  assert.equal(b.store.settings.reader.theme, 'sepia');
  assert.equal(b.store.settings.verticalTabs, true);
  const kinds = sql.prepare("SELECT DISTINCT collection FROM sync_items WHERE owner = 'u-all'").all().map((r) => r.collection).sort();
  assert.deepEqual(kinds, ['addresses', 'cards', 'passkeys', 'readingList', 'savedGroups', 'settings']);
  assert.ok(!pushes.some((k) => k.length > 1 && k.some((x) => ['passkeys', 'addresses', 'cards'].includes(x))), 'newer collections go in batches of their own');

  // Changes on B come back to A; nothing echoes after.
  b.reading.setRead(post.id, true);
  b.saved.remove(groupId);
  b.store.setSetting('translate', { always: [], never: ['de'], sites: [], target: 'en', declined: {} });
  await b.sync.tick();
  await a.sync.tick();
  assert.equal(a.reading.get(post.id).read, true);
  assert.deepEqual(a.saved.list(), []);
  assert.deepEqual(a.store.settings.translate.never, ['de']);
  const seq = () => sql.prepare('SELECT MAX(seq) AS s FROM sync_items').get().s;
  const last = seq();
  await a.sync.tick();
  await b.sync.tick();
  assert.equal(seq(), last, 'no echo');
  const stored = sql.prepare("SELECT data FROM sync_items WHERE owner = 'u-all' AND data IS NOT NULL").all().map((r) => Buffer.from(r.data, 'base64').toString('latin1')).join('\n');
  for (const secret of ['essays', 'Kitchen', 'Main St', '4111111111111111', 'sepia', 'example.com']) assert.ok(!stored.includes(secret), `${secret} is encrypted`);
});

test('a server that doesn’t keep the newer collections: the rest syncs, nothing is refused, and they follow once it does', async () => {
  const ORIGINAL = ['bookmarks', 'passwords', 'history', 'chats', 'workflows', 'projects', 'settings', 'tabs'];
  let kept = ORIGINAL;
  const pushes = [];
  const acct = makeAccount(user('u-old'), { keeps: () => kept, pushes });
  const a = computer('MacBook', acct);
  a.store.marks.add('bar', null, { url: 'https://news.example/', title: 'News' });
  a.store.addVisit('https://shop.example/item', 'An item');
  a.store.setSetting('searchEngine', 'duckduckgo');
  a.reading.add('https://essays.example/long-read', 'A long read');
  a.saved.save({ title: 'Trip', color: 'blue', tabs: [{ url: 'https://maps.example/', title: 'Maps' }] });
  newPasskey(a);
  a.autofill.saveAddress({ name: 'Sam Lee', street: '1 Main St', city: 'Austin', zip: '78701' });
  await a.sync.tick();
  assert.equal(a.sync.status, 'ready', a.sync.error);
  for (const k of pushes.flat()) assert.ok(ORIGINAL.includes(k), `${k} isn’t sent to a server that doesn’t keep it`);
  const kinds = () => sql.prepare("SELECT DISTINCT collection FROM sync_items WHERE owner = 'u-old'").all().map((r) => r.collection).sort();
  assert.deepEqual(kinds(), ['bookmarks', 'history', 'settings']);
  for (const c of ['readingList', 'savedGroups', 'passkeys', 'addresses', 'bookmarkTree']) assert.ok(!Object.values(a.sync.file.data.records).some((r) => r.c === c), `${c} waits`);

  const b = computer('Studio', acct);
  await join(b, a);
  assert.deepEqual(b.store.bookmarks().map((x) => x.url), ['https://news.example/']);
  assert.deepEqual(b.store.history().map((h) => h.url), ['https://shop.example/item']);
  assert.equal(b.store.settings.searchEngine, 'duckduckgo');
  assert.deepEqual(b.reading.list(), []);

  // The server is updated: the newer collections follow.
  kept = null;
  await a.sync.tick();
  await b.sync.tick();
  assert.deepEqual(b.reading.list().map((x) => x.url), ['https://essays.example/long-read']);
  assert.deepEqual(b.saved.list().map((g) => g.title), ['Trip']);
  assert.equal(b.passkeys.list().length, 1);
  assert.deepEqual(b.autofill.addresses().map((x) => x.name), ['Sam Lee']);
  assert.ok(kinds().includes('bookmarkTree') && kinds().includes('passkeys'));
});
