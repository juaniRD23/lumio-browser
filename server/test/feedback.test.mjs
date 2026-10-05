// "Report an issue" on the Lumio server (src/feedback.ts): anyone can send a
// report, only with what they chose to include; senders are limited per hour;
// only the owner can read, view screenshots of and delete reports; old ones
// are cleaned up. D1 is simulated with node:sqlite.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { feedbackCleanup, FEEDBACK_DAYS } from '../src/feedback.ts';

const SITE = 'https://lumio.test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let sql;
let env;

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
  };
}

// A signed-in account (a session row, as the Google sign-in would make).
function account(id, { owner = false } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  sql.prepare('INSERT INTO users (id, google_sub, email, created_at, role) VALUES (?, ?, ?, ?, ?)').run(id, `g-${id}`, `${id}@example.com`, Date.now(), owner ? 'owner' : null);
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), id, Date.now(), Date.now() + 86400e3);
  return token;
}

const call = async (path, { method = 'GET', body, token, ip = '203.0.113.7', origin } = {}) => {
  const headers = { 'cf-connecting-ip': ip };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(SITE + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env, { waitUntil() {} });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
};

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: d1(sql) };
});

test('anyone can send a report; it keeps only what they included', async () => {
  const r = await call('/api/feedback', { method: 'POST', body: { description: 'The video froze on example.com', includeUrl: true } });
  assert.equal(r.status, 200);
  assert.match(r.data.id, /^fb_[a-f0-9]{24}$/);
  const row = sql.prepare('SELECT * FROM feedback').get();
  assert.equal(row.description, 'The video froze on example.com');
  assert.equal(row.user_id, null);
  assert.equal(row.url, null, 'no address unless the browser sent one');
  assert.equal(row.screenshot, null);
  assert.equal(row.system, null);
  assert.match(row.sender, /^ip:[a-f0-9]{64}$/, 'the network address is stored hashed');
  assert.ok(!row.sender.includes('203.0.113.7'));

  const token = account('u1');
  const full = await call('/api/feedback', {
    method: 'POST', token,
    body: { description: 'Tabs crash', email: 'me@example.com', url: 'https://example.com/a', screenshot: `data:image/png;base64,${PNG}`, system: { lumio: '0.6.7', os: 'macOS 15.1', nested: { no: 1 }, 'bad key': 'x' } },
  });
  assert.equal(full.status, 200);
  const saved = sql.prepare('SELECT * FROM feedback WHERE id = ?').get(full.data.id);
  assert.equal(saved.user_id, 'u1');
  assert.equal(saved.email, 'me@example.com');
  assert.equal(saved.url, 'https://example.com/a');
  assert.equal(saved.screenshot, `data:image/png;base64,${PNG}`);
  assert.deepEqual(JSON.parse(saved.system), { lumio: '0.6.7', os: 'macOS 15.1' }, 'only short plain values');
});

test('reports are checked: a description, a real screenshot, sane sizes, our own pages only', async () => {
  assert.equal((await call('/api/feedback', { method: 'POST', body: { description: ' ' } })).status, 400);
  assert.equal((await call('/api/feedback', { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await call('/api/feedback', { method: 'POST', body: { description: 'hello there', screenshot: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('/api/feedback', { method: 'POST', body: { description: 'hello there', screenshot: `data:image/svg+xml;base64,${PNG}` } })).status, 400);
  assert.equal((await call('/api/feedback', { method: 'POST', body: { description: 'x'.repeat(10), screenshot: `data:image/jpeg;base64,${'A'.repeat(1_500_000)}` } })).status, 413);
  const odd = await call('/api/feedback', { method: 'POST', body: { description: 'odd fields', email: 'not an email', url: 'file:///etc/passwd' } });
  assert.equal(odd.status, 200);
  const row = sql.prepare('SELECT email, url FROM feedback').get();
  assert.deepEqual({ ...row }, { email: null, url: null });
  // Another website can't post reports from someone's browser.
  assert.equal((await call('/api/feedback', { method: 'POST', origin: 'https://evil.example', body: { description: 'spam spam' } })).status, 403);
  // Long descriptions are cut, not refused.
  await call('/api/feedback', { method: 'POST', ip: '198.51.100.1', body: { description: 'y'.repeat(9000) } });
  assert.equal(sql.prepare("SELECT length(description) AS n FROM feedback WHERE description LIKE 'yyy%'").get().n, 5000);
});

test('a few reports an hour per sender', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/feedback', { method: 'POST', body: { description: `report ${i}` } })).status, 200);
  const sixth = await call('/api/feedback', { method: 'POST', body: { description: 'one more' } });
  assert.equal(sixth.status, 429);
  assert.match(sixth.data.error, /Try again in an hour/);
  // Someone else on another network isn't affected; signed-in people get more.
  assert.equal((await call('/api/feedback', { method: 'POST', ip: '198.51.100.2', body: { description: 'mine' } })).status, 200);
  const token = account('u2');
  for (let i = 0; i < 20; i++) assert.equal((await call('/api/feedback', { method: 'POST', token, body: { description: `signed ${i}` } })).status, 200);
  assert.equal((await call('/api/feedback', { method: 'POST', token, body: { description: 'too many' } })).status, 429);
});

test('only the owner reads reports, opens screenshots and deletes them', async () => {
  const user = account('u3');
  const owner = account('boss', { owner: true });
  const sent = await call('/api/feedback', { method: 'POST', token: user, body: { description: 'Look at this', screenshot: `data:image/png;base64,${PNG}`, system: { lumio: '0.6.7' } } });
  await call('/api/feedback', { method: 'POST', body: { description: 'Anonymous one' } });
  const id = sent.data.id;

  assert.equal((await call('/api/admin/feedback', { token: user })).status, 404);
  assert.equal((await call('/api/admin/feedback')).status, 401);
  assert.equal((await call(`/api/admin/feedback/${id}/screenshot`, { token: user })).status, 404);
  assert.equal((await call(`/api/admin/feedback/${id}`, { method: 'DELETE', token: user })).status, 404);

  const list = await call('/api/admin/feedback', { token: owner });
  assert.equal(list.status, 200);
  assert.equal(list.data.total, 2);
  const mine = list.data.reports.find((r) => r.id === id);
  assert.deepEqual({ ...mine, at: 0 }, { id, at: 0, description: 'Look at this', email: null, account: 'u3@example.com', url: null, system: { lumio: '0.6.7' }, screenshot: true });
  assert.ok(!JSON.stringify(list.data).includes(PNG), 'the list doesn’t carry screenshots');

  const shot = await call(`/api/admin/feedback/${id}/screenshot`, { token: owner });
  assert.equal(shot.status, 200);
  assert.equal(shot.type, 'image/png');
  assert.deepEqual(Buffer.from(shot.data), Buffer.from(PNG, 'base64'));

  assert.equal((await call(`/api/admin/feedback/${id}`, { method: 'DELETE', token: owner })).data.ok, true);
  assert.equal((await call('/api/admin/feedback', { token: owner })).data.total, 1);
});

test('reports older than 180 days are deleted', async () => {
  await call('/api/feedback', { method: 'POST', body: { description: 'old one' } });
  await call('/api/feedback', { method: 'POST', body: { description: 'new one' } });
  sql.prepare("UPDATE feedback SET created_at = ? WHERE description = 'old one'").run(Date.now() - (FEEDBACK_DAYS + 1) * 86400e3);
  await feedbackCleanup(env);
  assert.deepEqual(sql.prepare('SELECT description FROM feedback').all().map((r) => r.description), ['new one']);
  // The network address hash is only kept for the hourly limit.
  assert.match(sql.prepare('SELECT sender FROM feedback').get().sender, /^ip:/);
  await feedbackCleanup(env, Date.now() + 2 * 3600e3);
  assert.equal(sql.prepare('SELECT sender FROM feedback').get().sender, '');
});
