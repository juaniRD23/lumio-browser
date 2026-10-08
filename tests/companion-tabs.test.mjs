// Tabs between Lumio on the computer and Lumio for iPhone and iPad, through
// the companion relay: the real sync engine and companion bridge on the
// computer, the real server code (in-memory D1) between them, and the phone's
// side done here with the same crypto the iPhone app uses (main/sync/crypto.js,
// ported byte for byte in ios/Lumio/Sync/Core/SyncCrypto.swift).
// No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import worker from '../server/src/index.ts';
const require = createRequire(import.meta.url);
const C = require('../main/sync/crypto.js');
const { Store } = require('../main/store.js');
const { SyncEngine } = require('../main/sync/engine.js');
const { CompanionBridge } = require('../main/sync/companion.js');

const BASE = 'https://lumio.test';
const TOKEN = crypto.randomBytes(32).toString('hex');
const PHONE = 'ios-5f0b8f4e-1a2b-4c3d-8e9f-001122334455';

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

async function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u1', 'g1', 'sam@example.com', 'Sam', 'free', 0)").run();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(TOKEN).digest('hex'), 'u1', Date.now() + 864e5);
  const env = { DB: d1(sql) };
  const fetchApi = (url, opts = {}) => worker.fetch(new Request(url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body }), env, { waitUntil() {} });
  // The computer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-companion-tabs-'));
  const store = new Store(dir, { isEncryptionAvailable: () => false });
  const sync = new SyncEngine({ dir, store, account: { base: BASE, token: () => TOKEN, state: () => ({ signedIn: true, email: 'sam@example.com' }), fetch: fetchApi } });
  sync.deviceName = 'MacBook';
  await sync.tick();
  assert.equal(sync.status, 'ready', sync.error);
  const opened = [];
  const bridge = new CompanionBridge({ sync, windows: () => [], pickWindow: () => null, openChat: () => {}, openTab: (t) => opened.push(t) });
  // The phone: same account, registered, with the sync key (as after pairing).
  const phoneApi = async (p, { method = 'GET', body } = {}) => {
    const res = await fetchApi(`${BASE}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  await phoneApi('/api/sync/devices', { method: 'POST', body: { id: PHONE, name: 'Sam’s iPhone', kind: 'phone', platform: 'ios' } });
  const keys = await C.deriveKeys(sync.raw);
  await bridge.poll(); // the computer starts listening (older commands are skipped)
  // What the iPhone app sends (CompanionCommand.open in ios/Lumio/Companion).
  const command = async (cmd) => {
    const data = await C.seal(keys, 'companion', 'msg', { ...cmd, at: cmd.at ?? Date.now(), from: PHONE });
    return phoneApi('/api/companion/messages', { method: 'POST', body: { kind: 'command', device: PHONE, target: sync.deviceId, data } });
  };
  return { sql, sync, bridge, opened, keys, phoneApi, command };
}

test('a tab from the phone opens on the computer ("Tab from Sam’s iPhone"); only web pages, only fresh commands', async () => {
  const { bridge, opened, command, sql } = await setup();
  assert.equal((await command({ type: 'open', url: 'https://news.example/story?id=7', title: 'A story', fromName: 'Sam’s iPhone' })).status, 200);
  await command({ type: 'open', url: 'javascript:alert(1)', title: 'Nope', fromName: 'Sam’s iPhone' });
  await command({ type: 'open', url: 'file:///etc/passwd', title: 'Nope', fromName: 'Sam’s iPhone' });
  await command({ type: 'open', url: 'https://old.example/', title: 'Too old', fromName: 'Sam’s iPhone', at: Date.now() - 10 * 60_000 });
  await command({ type: 'open', url: 'https://plain.example/' });
  await bridge.poll();
  assert.deepEqual(opened, [
    { url: 'https://news.example/story?id=7', title: 'A story', from: 'Sam’s iPhone' },
    { url: 'https://plain.example/', title: '', from: 'your phone' },
  ]);
  // The server only relays ciphertext.
  const rows = sql.prepare('SELECT data FROM companion_messages').all();
  assert.ok(rows.every((r) => !Buffer.from(r.data, 'base64').toString('latin1').includes('news.example')));
});

test('a tab from the computer reaches the phone as "Tab from MacBook", with its page', async () => {
  const { bridge, keys, phoneApi } = await setup();
  const first = await phoneApi(`/api/companion/messages?kind=notice&device=${PHONE}&since=0`);
  assert.equal(first.status, 200);
  assert.equal(await bridge.sendTab({ url: 'https://recipes.example/pie', title: 'Apple pie' }), true);
  assert.equal(await bridge.sendTab({ url: 'lumio://settings', title: 'Settings' }), false, 'web pages only');
  const got = await phoneApi(`/api/companion/messages?kind=notice&device=${PHONE}&since=${first.data.cursor}`);
  assert.equal(got.data.messages.length, 1);
  const notice = await C.open(keys, 'companion', 'msg', got.data.messages[0].data);
  assert.deepEqual({ ...notice, at: 0 }, { at: 0, type: 'tab', title: 'Tab from MacBook', body: 'Apple pie', url: 'https://recipes.example/pie', chatId: null, computer: 'MacBook' });
});
