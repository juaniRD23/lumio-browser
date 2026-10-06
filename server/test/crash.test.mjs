// Crash reports (src/crashes.ts): Crashpad's minidump uploads and Lumio's own
// JSON reports go in without an account, scrubbed and rate-limited; the owner
// sees them grouped on /admin. D1 is simulated on node:sqlite, R2 in memory.
// Run: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { crashCleanup, readMinidump, scrub, scrubHosts, jsSignature, ipKey } from '../src/crashes.ts';

const SITE = 'https://lumio.test';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
let sql, env, r2;

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
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}
function bucket() {
  const store = new Map();
  return {
    store,
    async put(key, value) { store.set(key, new Uint8Array(value)); },
    async get(key) { const b = store.get(key); return b ? { body: new Blob([b]).stream() } : null; },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  };
}

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: d1(sql), FILES: (r2 = bucket()) };
});

// A minidump like Crashpad writes: an exception at `address`, and two modules
// whose names are full paths (which can hold the user's name).
function minidump({ code = 1, address = 0x1_0000_0000n + 0x2a3f10n, modules = [
  { base: 0x1_0000_0000n, size: 0x1000_0000, name: '/Applications/Lumio Browser.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework' },
  { base: 0x7ff8_0000_0000n, size: 0x10_0000, name: '/usr/lib/system/libsystem_kernel.dylib' },
] } = {}) {
  const names = modules.map((m) => Buffer.from(m.name, 'utf16le'));
  const excAt = 32 + 2 * 12;
  const modAt = excAt + 168;
  let nameAt = modAt + 4 + modules.length * 108;
  const buf = Buffer.alloc(nameAt + names.reduce((n, b) => n + 4 + b.length, 0));
  buf.writeUInt32LE(0x504d444d, 0); // MDMP
  buf.writeUInt32LE(0xa793, 4);
  buf.writeUInt32LE(2, 8);
  buf.writeUInt32LE(32, 12);
  buf.writeUInt32LE(6, 32); buf.writeUInt32LE(168, 36); buf.writeUInt32LE(excAt, 40);
  buf.writeUInt32LE(4, 44); buf.writeUInt32LE(4 + modules.length * 108, 48); buf.writeUInt32LE(modAt, 52);
  buf.writeUInt32LE(code, excAt + 8);
  buf.writeBigUInt64LE(address, excAt + 24);
  buf.writeUInt32LE(modules.length, modAt);
  modules.forEach((m, i) => {
    const at = modAt + 4 + i * 108;
    buf.writeBigUInt64LE(m.base, at);
    buf.writeUInt32LE(m.size, at + 8);
    buf.writeUInt32LE(nameAt, at + 20);
    buf.writeUInt32LE(names[i].length, nameAt);
    names[i].copy(buf, nameAt + 4);
    nameAt += 4 + names[i].length;
  });
  return buf;
}

const GUID = '5e1286fc-da97-479e-918b-6bfb0c3d1c72';
const FIELDS = { ver: '43.7.7', platform: 'darwin', process_type: 'renderer', guid: GUID, _version: '0.6.8', _productName: 'Lumio Browser', prod: 'Electron', _companyName: 'Lumio', version: '0.6.8', arch: 'arm64', channel: 'stable' };

// Crashpad's request: multipart/form-data, gzipped unless told otherwise.
function crashpadBody({ fields = FIELDS, dump = minidump(), gzip = true } = {}) {
  const b = '---------------------------crashpad' + crypto.randomBytes(8).toString('hex');
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (dump) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="upload_file_minidump"; filename="abc.dmp"\r\nContent-Type: application/octet-stream\r\n\r\n`), dump, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  const raw = Buffer.concat(parts);
  return { type: `multipart/form-data; boundary=${b}`, body: gzip ? zlib.gzipSync(raw) : raw, gzip };
}

function post(body, { type, gzip = false, ip = '203.0.113.7', headers = {} } = {}) {
  return worker.fetch(new Request(SITE + '/api/crash', {
    method: 'POST',
    headers: { 'content-type': type, 'cf-connecting-ip': ip, ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...headers },
    body,
  }), env, { waitUntil() {} });
}
const upload = (opts) => { const c = crashpadBody(opts); return post(c.body, { type: c.type, gzip: c.gzip, ip: opts?.ip }); };
const report = (data, opts = {}) => post(JSON.stringify(data), { type: 'application/json', ...opts });
const rows = () => sql.prepare('SELECT * FROM crashes ORDER BY created_at').all();

function owner(role = 'owner') {
  const token = crypto.randomBytes(32).toString('hex');
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  sql.prepare('INSERT INTO users (id, google_sub, email, created_at, role) VALUES (?, ?, ?, ?, ?)').run(id, 'g-' + id, `${id}@example.com`, Date.now(), role);
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), id, Date.now(), Date.now() + DAY);
  return (path) => worker.fetch(new Request(SITE + path, { headers: { authorization: `Bearer ${token}` } }), env, { waitUntil() {} });
}

// ---------------------------------------------------------------- Crashpad
test('a gzipped Crashpad upload is stored: the dump in R2, a row with what crashed and where, and the ID as plain text', async () => {
  const dump = minidump();
  const res = await upload({ dump });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const id = await res.text();
  assert.match(id, /^cr_[a-f0-9]{24}$/);
  const [row] = rows();
  assert.deepEqual({ ...row, created_at: 0, ip_hash: !!row.ip_hash }, {
    id, created_at: 0, version: '0.6.8', platform: 'darwin', arch: 'arm64', channel: 'stable', process_type: 'renderer',
    reason: 'EXC_BAD_ACCESS', has_dump: 1, signature: 'EXC_BAD_ACCESS in Electron Framework+0x2a3f10', message: null, stack: null, ip_hash: true, dump_bytes: dump.length,
  });
  const key = `crashes/${new Date(row.created_at).toISOString().slice(0, 10)}/${id}.dmp`;
  assert.deepEqual([...r2.store.keys()], [key]);
  assert.ok(Buffer.from(r2.store.get(key)).equals(dump), 'the dump is kept as sent (unzipped)');
  assert.ok(!JSON.stringify(row).includes(GUID), 'Crashpad’s install ID is never kept');
  assert.ok(!JSON.stringify(row).includes('203.0.113.7'), 'nor the IP');
});

test('an uncompressed upload from Windows: exception names, and only a module’s file name (never its folder)', async () => {
  const dump = minidump({ code: 0xc0000005, address: 0x7ff6_1000_0000n + 0x1234n, modules: [{ base: 0x7ff6_1000_0000n, size: 0x800_0000, name: 'C:\\Users\\sam\\AppData\\Local\\Programs\\Lumio\\Lumio Browser.exe' }] });
  const res = await upload({ dump, gzip: false, fields: { ...FIELDS, platform: 'win32', arch: 'x64', process_type: 'browser', channel: 'beta' } });
  assert.equal(res.status, 200);
  const [row] = rows();
  assert.equal(row.signature, 'ACCESS_VIOLATION in Lumio Browser.exe+0x1234');
  assert.deepEqual([row.platform, row.arch, row.channel, row.process_type, row.reason], ['win32', 'x64', 'beta', 'browser', 'ACCESS_VIOLATION']);
  assert.ok(!JSON.stringify(row).includes('sam'));
});

test('minidump reading copes with odd dumps: no exception, an address in no module, cut short', () => {
  assert.equal(readMinidump(new Uint8Array([1, 2, 3, 4])), null, 'not a minidump');
  assert.deepEqual(readMinidump(minidump({ address: 0x42n })), { code: 1, module: null, offset: null });
  const cut = minidump().subarray(0, 100);
  assert.deepEqual(readMinidump(cut), { code: 1, module: null, offset: null }, 'stops at the end instead of reading past it');
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x504d444d, 0);
  assert.deepEqual(readMinidump(header), { code: null, module: null, offset: null });
});

// The dump with Crashpad's own stream added: MinidumpCrashpadInfo (stream
// 0x43500001) holds a version, the report's ID and the install's client ID.
function withCrashpadInfo(dump, { reportId, clientId }) {
  const info = Buffer.alloc(52);
  info.writeUInt32LE(1, 0);
  reportId.copy(info, 4);
  clientId.copy(info, 20);
  const infoAt = dump.length;
  const dirAt = infoAt + info.length;
  const out = Buffer.concat([dump, info, Buffer.alloc(3 * 12)]);
  dump.copy(out, dirAt, 32, 32 + 2 * 12); // the dump's own two streams
  out.writeUInt32LE(0x43500001, dirAt + 24); out.writeUInt32LE(info.length, dirAt + 28); out.writeUInt32LE(infoAt, dirAt + 32);
  out.writeUInt32LE(3, 8);
  out.writeUInt32LE(dirAt, 12);
  return { out, infoAt };
}

test('the install’s ID that Crashpad writes into the dump is wiped before the dump is stored', async () => {
  const clientId = Buffer.from(GUID.replace(/-/g, ''), 'hex');
  const reportId = crypto.randomBytes(16);
  const { out: dump, infoAt } = withCrashpadInfo(minidump(), { reportId, clientId });
  const res = await upload({ dump });
  assert.equal(res.status, 200);
  const [row] = rows();
  assert.equal(row.signature, 'EXC_BAD_ACCESS in Electron Framework+0x2a3f10', 'still read the same');
  const stored = Buffer.from(r2.store.get([...r2.store.keys()][0]));
  assert.equal(stored.length, dump.length);
  assert.equal(stored.indexOf(clientId), -1, 'no install ID anywhere in it');
  assert.ok(stored.subarray(infoAt + 20, infoAt + 36).equals(Buffer.alloc(16)), 'zeroed in place');
  assert.ok(stored.subarray(infoAt + 4, infoAt + 20).equals(reportId), 'the report’s own ID stays');
  assert.ok(stored.subarray(0, infoAt).equals(dump.subarray(0, infoAt)), 'nothing else changes');
  assert.ok(stored.subarray(infoAt + 36).equals(dump.subarray(infoAt + 36)));
});

test('uploads that aren’t Lumio minidumps, are too big or come from a web page are refused', async () => {
  assert.equal((await upload({ dump: Buffer.from('MZ not a dump at all') })).status, 400, 'not a minidump');
  assert.equal((await upload({ dump: null })).status, 400, 'no minidump');
  assert.equal((await upload({ fields: { ...FIELDS, _productName: 'Other App' } })).status, 400, 'another app');
  const big = crashpadBody({ dump: crypto.randomBytes(5 * 1024 * 1024 + 10), gzip: false });
  assert.equal((await post(big.body, { type: big.type })).status, 413, 'over 5 MB as sent');
  // A small gzip that unzips to far more than any dump.
  const bomb = crashpadBody({ dump: Buffer.concat([minidump(), Buffer.alloc(40 * 1024 * 1024)]) });
  assert.ok(bomb.body.length < 1024 * 1024);
  assert.equal((await post(bomb.body, { type: bomb.type, gzip: true })).status, 400, 'too big once unzipped');
  assert.equal((await post('hello', { type: 'text/plain' })).status, 415);
  const page = crashpadBody();
  assert.equal((await post(page.body, { type: page.type, gzip: true, headers: { origin: 'https://evil.example' } })).status, 403, 'web pages can’t post crash reports');
  assert.equal(rows().length, 0);
  assert.equal(r2.store.size, 0);
});

// ---------------------------------------------------------------- Lumio's JSON reports
const META = { version: '0.6.8', platform: 'darwin', arch: 'arm64', channel: 'stable' };

test('a main-process JavaScript error: scrubbed again on the server, grouped by its first Lumio frame', async () => {
  const res = await report({
    ...META, type: 'js', process: 'browser', reason: 'uncaughtException', name: 'TypeError',
    message: 'Cannot read properties of undefined (reading \'id\') at https://bank.example/account?n=1 for sam@example.com in /Users/sam/Library/x.json',
    stack: 'TypeError: x\n    at update (main/tabs.js:183:7)\n    at C:\\Users\\sam\\thing.js:1:2\n    at node:internal/process/task_queues:95:5',
  });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const [row] = rows();
  assert.equal(row.id, id);
  assert.equal(row.signature, 'TypeError at main/tabs.js:183 in update');
  assert.equal(row.reason, 'uncaughtException');
  assert.equal(row.process_type, 'browser');
  assert.equal(row.has_dump, 0);
  assert.equal(row.message, 'TypeError: Cannot read properties of undefined (reading \'id\') at <url> for <email> in <path>');
  assert.equal(row.stack, 'TypeError: x\n    at update (main/tabs.js:183:7)\n    at <path>:1:2\n    at node:internal/process/task_queues:95:5');
});

test('a page or helper process that died: what kind, why and its exit code', async () => {
  assert.equal((await report({ ...META, type: 'gone', process: 'renderer', reason: 'crashed', exitCode: 11, where: 'ui' })).status, 200);
  assert.equal((await report({ ...META, type: 'gone', process: 'utility', name: 'Network Service', reason: 'oom', exitCode: -1 })).status, 200);
  assert.equal((await report({ ...META, type: 'gone', process: 'renderer', reason: 'killed', where: 'page' })).status, 200);
  assert.deepEqual(rows().map((r) => [r.signature, r.message]), [
    ['renderer [ui] gone: crashed', 'exit code 11'],
    ['utility (Network Service) gone: oom', 'exit code -1'],
    ['renderer gone: killed', null],
  ]);
});

test('JSON reports: unknown values are dropped, and broken ones are refused', async () => {
  assert.equal((await report({ type: 'gone', process: 'renderer', reason: 'crashed', version: 'https://x.example', platform: 'beos', arch: 'z80', channel: 'nightly', where: '/Users/sam' })).status, 200);
  assert.deepEqual(Object.values(sql.prepare('SELECT version, platform, arch, channel FROM crashes').get()), [null, null, null, null]);
  assert.equal((await report({ ...META, type: 'gone', process: 'renderer' })).status, 400, 'needs a reason');
  assert.equal((await report({ ...META, type: 'gone', process: 'renderer', reason: 'see https://x.example' })).status, 400, 'reasons are short words');
  assert.equal((await report({ ...META, type: 'mystery', reason: 'crashed' })).status, 400);
  assert.equal((await post('{nope', { type: 'application/json' })).status, 400);
  assert.equal((await post(JSON.stringify({ type: 'js', reason: 'x', stack: 'a'.repeat(70 * 1024) }), { type: 'application/json' })).status, 413);
});

test('scrub and signatures', () => {
  assert.equal(scrub('see lumio://settings/ and chrome-extension://abc/x.js', 200), 'see <url> and <url>');
  assert.equal(scrub('at main/ui/thing.js:1:2 and renderer/ui/shell.js:4:5', 200), 'at main/ui/thing.js:1:2 and renderer/ui/shell.js:4:5', 'Lumio’s own paths stay');
  assert.equal(scrub('open ~/Library/Application Support/Lumio Browser/x', 200), 'open <path>', 'folders with spaces in their names too');
  assert.equal(scrub("at C:\\Users\\Jo Smith\\app.js:1:2 and 'C:\\Users\\Jo Smith\\b.txt'", 200), "at <path>:1:2 and '<path>'");
  assert.equal(scrub('x'.repeat(50), 10), 'xxxxxxxxx…');
  assert.equal(scrubHosts('getaddrinfo ENOTFOUND mybank.example.com'), 'getaddrinfo ENOTFOUND <host>', 'hosts without a scheme');
  assert.equal(scrubHosts('connect ECONNREFUSED 10.0.0.5:443 and 2001:db8:0:0:1:0:0:1'), 'connect ECONNREFUSED <ip>:443 and <ip>');
  assert.equal(scrubHosts('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 failed'), 'Bearer <token> failed');
  assert.equal(scrubHosts('Cannot find module main/tabs.js at 12:30:45'), 'Cannot find module main/tabs.js at 12:30:45', 'Lumio’s files and times stay');
  assert.equal(jsSignature('Error', 'Error: x\n    at <path>:1:2'), 'Error', 'no Lumio frame');
  assert.equal(jsSignature('RangeError', 'RangeError: x\n    at async Promise.all (index 0)\n    at main/ai/run.js:10:3'), 'RangeError at main/ai/run.js:10');
});

// ---------------------------------------------------------------- limits
test('each IP gets 20 reports an hour; others aren’t affected', async () => {
  const gone = { ...META, type: 'gone', process: 'renderer', reason: 'crashed' };
  for (let i = 0; i < 20; i++) assert.equal((await report(gone)).status, 200);
  assert.equal((await report(gone)).status, 429);
  assert.equal((await upload({})).status, 429, 'dumps count too');
  assert.equal((await report(gone, { ip: '198.51.100.2' })).status, 200);
  sql.prepare('UPDATE crash_attempts SET created_at = created_at - ?').run(HOUR);
  assert.equal((await report(gone)).status, 200, 'an hour later');
});

test('refused reports count against the limit too, and an IPv6 /64 counts as one IP', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await report('not json')).status, 400);
  assert.equal((await report({ ...META, type: 'gone', process: 'renderer', reason: 'crashed' })).status, 429);
  const gone = { ...META, type: 'gone', process: 'renderer', reason: 'crashed' };
  for (let i = 0; i < 20; i++) assert.equal((await report(gone, { ip: `2001:db8:1:2::${(i + 1).toString(16)}` })).status, 200);
  assert.equal((await report(gone, { ip: '2001:db8:1:2:ffff:ffff:ffff:ffff' })).status, 429, 'same /64');
  assert.equal((await report(gone, { ip: '2001:db8:1:3::1' })).status, 200, 'another /64');
  assert.equal(await crashCleanup(env, Date.now() + DAY + 1000), 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM crash_attempts').get().n, 0, 'attempts are cleared after a day');
});

test('ipKey', () => {
  assert.equal(ipKey('198.51.100.7'), '198.51.100.7');
  assert.equal(ipKey('2001:DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey(null), 'unknown');
});

test('one IP keeps at most 5 dumps a day; past that the report is still counted', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await upload({})).status, 200);
  assert.equal((await upload({})).status, 200);
  assert.deepEqual(rows().map((r) => r.has_dump).sort(), [0, 1, 1, 1, 1, 1]);
  assert.equal(r2.store.size, 5);
  assert.equal((await upload({ ip: '198.51.100.9' })).status, 200);
  assert.equal(r2.store.size, 6, 'others aren’t affected');
});

test('past 1 GB of dumps a day from everyone, dumps aren’t kept', async () => {
  sql.prepare("INSERT INTO crashes (id, created_at, has_dump, signature, dump_bytes) VALUES ('cr_big', ?, 1, 'x', ?)").run(Date.now() - 1000, 1024 * 1024 * 1024 - 100);
  assert.equal((await upload({})).status, 200);
  assert.equal(r2.store.size, 0);
});

test('past 1000 dumps a day from everyone, reports are still counted but dumps aren’t kept', async () => {
  const insert = sql.prepare("INSERT INTO crashes (id, created_at, has_dump, signature) VALUES (?, ?, 1, 'x')");
  for (let i = 0; i < 1000; i++) insert.run(`cr_old${i}`, Date.now() - 1000);
  const res = await upload({});
  assert.equal(res.status, 200);
  const id = await res.text();
  assert.equal(sql.prepare('SELECT has_dump FROM crashes WHERE id = ?').get(id).has_dump, 0);
  assert.equal(r2.store.size, 0);
});

test('cleanup: IP hashes go after a day, reports and their dumps after 90 days', async () => {
  await upload({});
  await report({ ...META, type: 'gone', process: 'gpu-process', reason: 'crashed' });
  const [dumpRow] = rows();
  const now = Date.now();
  assert.equal(await crashCleanup(env, now), 0);
  assert.ok(rows().every((r) => r.ip_hash));
  assert.equal(await crashCleanup(env, now + DAY + 1000), 0);
  assert.ok(rows().every((r) => r.ip_hash === null), 'IP hashes cleared after a day');
  assert.equal(r2.store.size, 1);
  assert.equal(await crashCleanup(env, dumpRow.created_at + 91 * DAY), 2);
  assert.equal(rows().length, 0);
  assert.equal(r2.store.size, 0, 'the dump is deleted too');
});

// ---------------------------------------------------------------- the owner
test('the owner sees crashes grouped by version and signature, the latest ones, and can download a dump', async () => {
  await upload({});
  await upload({});
  await upload({ fields: { ...FIELDS, version: '0.6.7', _version: '0.6.7', platform: 'win32' }, dump: minidump({ code: 0xc0000005, address: 0x10n, modules: [] }) });
  await report({ ...META, type: 'js', process: 'browser', reason: 'unhandledRejection', name: 'Error', message: 'boom', stack: 'Error: boom\n    at run (main/ai/run.js:10:3)' });

  assert.equal((await worker.fetch(new Request(SITE + '/api/admin/crashes'), env, {})).status, 401);
  assert.equal((await owner('member')('/api/admin/crashes')).status, 404, 'only the owner');
  const get = owner();
  const res = await get('/api/admin/crashes');
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.deepEqual(d.totals, { reports: 4, last24h: 4, dumps: 3 });
  // Most reports first (the two with one each can tie on time, so they're compared sorted).
  const groups = d.groups.map((g) => [g.count, g.version, g.process, g.signature, g.platforms, g.dumps]);
  assert.deepEqual(groups[0], [2, '0.6.8', 'renderer', 'EXC_BAD_ACCESS in Electron Framework+0x2a3f10', ['darwin'], 2]);
  assert.deepEqual(groups.slice(1).sort((a, b) => a[3].localeCompare(b[3])), [
    [1, '0.6.7', 'renderer', 'ACCESS_VIOLATION in an unknown module', ['win32'], 1],
    [1, '0.6.8', 'browser', 'Error at main/ai/run.js:10 in run', ['darwin'], 0],
  ]);
  assert.equal(d.recent.length, 4);
  const js = d.recent.find((c) => c.reason === 'unhandledRejection');
  assert.equal(js.dump, null);
  assert.equal(js.stack, 'Error: boom\n    at run (main/ai/run.js:10:3)');
  const withDump = d.recent.find((c) => c.dump);
  assert.equal(withDump.dump, `/api/admin/crashes/${withDump.id}/dump`);

  const file = await get(withDump.dump);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), new RegExp(`attachment; filename="${withDump.id}\\.dmp"`));
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString(), 'MDMP');
  assert.equal((await owner('member')(withDump.dump)).status, 404);
  assert.equal((await get(`/api/admin/crashes/${js.id}/dump`)).status, 404, 'a JSON report has no dump');
});

test('the migration makes the same crashes table as schema.sql', () => {
  const table = (file) => /CREATE TABLE IF NOT EXISTS crashes[\s\S]*?crashes_ip[^\n]*/.exec(readFileSync(new URL(file, import.meta.url), 'utf8'))[0];
  assert.equal(table('../migrations/2026-10-05-crashes.sql'), table('../schema.sql'));
});

test('the owner can look back 1 to 90 days (30 unless asked)', async () => {
  const now = Date.now();
  const insert = sql.prepare("INSERT INTO crashes (id, created_at, version, process_type, has_dump, signature) VALUES (?, ?, '0.6.8', 'renderer', 0, ?)");
  insert.run('cr_' + '1'.repeat(24), now - HOUR, 'an hour ago');
  insert.run('cr_' + '2'.repeat(24), now - 3 * DAY, 'three days ago');
  insert.run('cr_' + '3'.repeat(24), now - 60 * DAY, 'two months ago');
  const get = owner();
  const look = async (query) => {
    const d = await (await get('/api/admin/crashes' + query)).json();
    return { days: d.days, reports: d.totals.reports, last24h: d.totals.last24h, seen: d.groups.map((g) => g.signature).sort(), recent: d.recent.length };
  };
  const all = ['an hour ago', 'three days ago', 'two months ago'];
  assert.deepEqual(await look(''), { days: 30, reports: 2, last24h: 1, seen: all.slice(0, 2), recent: 2 });
  assert.deepEqual(await look('?days=1'), { days: 1, reports: 1, last24h: 1, seen: all.slice(0, 1), recent: 1 });
  assert.deepEqual(await look('?days=90'), { days: 90, reports: 3, last24h: 1, seen: all, recent: 3 });
  assert.equal((await look('?days=365')).days, 90, 'never past what’s kept');
  assert.equal((await look('?days=-5')).days, 1);
  assert.equal((await look('?days=abc')).days, 30);
  assert.equal((await look('?days=0')).days, 30);
});

test('the cron trigger runs the cleanup, dumps included', async () => {
  const old = Date.now() - 91 * DAY;
  const id = 'cr_' + 'c'.repeat(24);
  sql.prepare("INSERT INTO crashes (id, created_at, has_dump, signature, ip_hash) VALUES (?, ?, 1, 'old', 'h1')").run(id, old);
  sql.prepare("INSERT INTO crashes (id, created_at, has_dump, signature, ip_hash) VALUES (?, ?, 0, 'last week', 'h2')").run('cr_' + 'd'.repeat(24), Date.now() - 7 * DAY);
  await r2.put(`crashes/${new Date(old).toISOString().slice(0, 10)}/${id}.dmp`, minidump());
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(rows().map((r) => [r.signature, r.ip_hash]), [['last week', null]]);
  assert.equal(r2.store.size, 0, 'the old dump is gone from R2');
});

test('a dump that isn’t there, or an address that isn’t a crash ID, is not found', async () => {
  const get = owner();
  assert.equal((await get(`/api/admin/crashes/cr_${'e'.repeat(24)}/dump`)).status, 404, 'no such report');
  assert.equal((await get('/api/admin/crashes/../users/dump')).status, 404);
  assert.equal((await get('/api/admin/crashes/cr_XYZ/dump')).status, 404);
  // A row says it has a dump but R2 lost it: still a clean 404.
  sql.prepare("INSERT INTO crashes (id, created_at, has_dump, signature) VALUES (?, ?, 1, 'x')").run('cr_' + 'f'.repeat(24), Date.now());
  assert.equal((await get(`/api/admin/crashes/cr_${'f'.repeat(24)}/dump`)).status, 404);
});
