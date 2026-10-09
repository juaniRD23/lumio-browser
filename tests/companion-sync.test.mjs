// How the phone companion (website/public/companion.js) gets the account's
// Lumio Sync key, in headless Chrome, against a stand-in server that answers
// /api/sync* the way docs/sync-managed.md says: signed in is synced (Lumio
// keeps the key), an account whose key isn't on Lumio yet, its own
// passphrase and older servers (the computer approves the phone, as before),
// signing out, and a key that changes while the phone is open. This checks
// the page alone; tests/companion.test.mjs runs it with the real server and
// sync engine. Skipped without Google Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const C = require('../website/public/sync-crypto.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const PUBLIC = fileURLToPath(new URL('../website/public/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/companion': 'companion.html', '/account': 'account.html' };
const EMAIL = 'sam@example.com';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const check = async (raw) => (await C.deriveKeys(raw)).check;

// The stand-in account, as the server keeps it. held: the key Lumio keeps
// (managed), or null. legacy: an older server (no mode fields, no key routes).
let A;
function account(over = {}) {
  A = { signedIn: true, legacy: false, mode: 'managed', available: true, keyCheck: null, held: null, autoApprove: true, flip: null, limited: false, records: [], pairings: new Map(), calls: [], ...over };
}
account();

// A chat record sealed with a key, as Lumio Browser uploads it.
async function chat(raw, seq, title) {
  const keys = await C.deriveKeys(raw);
  const id = await C.recordId(keys, 'chats', `chat-${seq}`);
  return { seq, id, collection: 'chats', deleted: false, data: await C.seal(keys, 'chats', id, { r: { id: `chat-${seq}`, title, updatedAt: Date.now(), display: [{ kind: 'user', text: title }] } }) };
}

const fail = (status, code, error) => ({ status, body: { error, code } });
async function api(method, route, b, req) {
  if (route === '/api/account') return { body: A.signedIn ? { signedIn: true, email: EMAIL } : { signedIn: false } };
  if (!A.signedIn) return fail(401, 'sign_in_required', 'Sign in first.');
  const managedKey = !!A.held && A.keyCheck === await check(A.held);
  const key = route === '/api/sync/key' || route === '/api/sync/mode' || route === '/api/sync/reset';
  if (key && (A.legacy || method === 'GET')) return fail(404, 'not_found', 'Not found.');
  // The key routes take a cookie request only from this site, with the header.
  if (key && (req.headers.origin !== base || req.headers['x-lumio-sync'] !== '1' || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) return fail(403, 'forbidden', 'Not allowed.');
  const pair = /^\/api\/sync\/pair\/([\w-]+)$/.exec(route)?.[1];
  switch (`${method} ${pair ? '/api/sync/pair/:id' : route}`) {
    case 'POST /api/sync/devices': return { body: { ok: true } };
    case 'GET /api/sync': return { body: { keyCheck: A.keyCheck, since: A.keyCheck ? 1 : null, devices: [], usage: { items: A.records.length, bytes: 0 }, collections: ['chats', 'workflows', 'tabs'], ...(A.legacy ? {} : { mode: A.mode, managedKey, managedAvailable: A.available }) } };
    case 'POST /api/sync/key': {
      if (A.limited) return fail(429, 'rate_limited', 'Too many requests. Try again in a few minutes.');
      if (!A.available) return fail(503, 'sync_keys_unavailable', 'Lumio Sync can’t hand out keys right now. Try again later.');
      if (A.flip) { await A.flip(); A.flip = null; } // a computer switched modes just now
      if (A.mode === 'passphrase') return fail(409, 'passphrase_mode', 'This account encrypts sync with its own passphrase. Approve this device from another one, or use the recovery key.');
      if (managedKey) return { body: { status: 'ready', key: C.toB64(A.held), keyCheck: A.keyCheck, created: false } };
      if (A.keyCheck) return { body: { status: 'waiting', keyCheck: A.keyCheck } };
      A.held = C.newKey();
      A.keyCheck = await check(A.held);
      return { body: { status: 'ready', key: C.toB64(A.held), keyCheck: A.keyCheck, created: true } };
    }
    case 'PUT /api/sync/key': {
      if (typeof b.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b.key)) return fail(400, 'invalid_request', 'Invalid key.');
      if (A.mode === 'passphrase') return fail(409, 'passphrase_mode', 'This account encrypts sync with its own passphrase.');
      if (!A.keyCheck) return fail(409, 'sync_not_set_up', 'Set up sync first.');
      if (await check(C.fromB64(b.key)) !== A.keyCheck) return fail(409, 'key_mismatch', 'That key isn’t this account’s sync key.');
      A.held = C.fromB64(b.key);
      return { body: { ok: true, keyCheck: A.keyCheck } };
    }
    case 'POST /api/sync/pair': {
      const id = `p_${A.pairings.size + 1}`;
      A.pairings.set(id, { id, pubkey: b.pubkey, name: b.name, status: 'pending' });
      return { body: { id } };
    }
    case 'GET /api/sync/pair/:id': {
      const p = A.pairings.get(pair);
      if (!p) return fail(404, 'not_found', 'No such request.');
      // Managed, with the key on Lumio: the server approves the request itself.
      if (p.status === 'pending' && !A.legacy && A.mode === 'managed' && A.available && managedKey && A.autoApprove) p.answer = await C.wrapForDevice(A.held, p.pubkey);
      if (p.status === 'pending' && p.answer) { p.status = 'done'; return { body: { status: 'approved', ...p.answer } }; }
      return { body: { status: p.status } };
    }
    case 'GET /api/sync/changes': {
      const since = Number(new URL(req.url, base).searchParams.get('since')) || 0;
      const items = A.records.filter((r) => r.seq > since);
      return { body: { items, cursor: items.length ? items.at(-1).seq : since, more: false } };
    }
    case 'GET /api/companion/status': return { body: { computers: [{ id: 'mac-1', name: 'MacBook', online: true, lastSeen: Date.now(), status: null }] } };
    case 'GET /api/companion/messages': return { body: { messages: [], cursor: 0, watching: false } };
    // The account page.
    case 'GET /api/usage': return { body: { usage: { plan: 'free', planName: 'Free', windows: [] } } };
    case 'GET /api/billing/plans': return { body: { plans: [] } };
    case 'GET /api/connections': return { body: { apps: [] } };
    case 'POST /api/auth': A.signedIn = false; return { body: { ok: true } };
    default: return fail(404, 'not_found', 'Not found.');
  }
}

let server, base, browser;
before(async () => {
  if (!CHROME) return;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      for await (const c of req) raw += c;
      const b = raw ? JSON.parse(raw) : {};
      A.calls.push({ method: req.method, path: url.pathname, body: raw ? b : undefined, sync: req.headers['x-lumio-sync'], origin: req.headers.origin });
      const r = await api(req.method, url.pathname, b, req);
      res.writeHead(r.status || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(r.body));
      return;
    }
    const file = path.join(PUBLIC, PAGES[url.pathname] || url.pathname.slice(1));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
      return;
    }
    // Anywhere else (/, where signing out goes): a stand-in page on the same site.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Lumio</title><p>Home</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// What the phone keeps in IndexedDB ('lumio-companion', store 'kv').
function kv(entries) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('lumio-companion', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction('kv', entries ? 'readwrite' : 'readonly');
      const s = t.objectStore('kv');
      for (const [k, v] of Object.entries(entries || {})) s.put(v, k);
      const keys = s.getAllKeys();
      const values = s.getAll();
      t.oncomplete = () => { r.result.close(); resolve(Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]]))); };
    };
  });
}
const stored = (page) => page.evaluate(kv);

// A phone: a fresh browser (nothing leaves this machine), with what it kept
// from before, then the page. clock: timers the test can fast-forward.
async function phone(url = '/companion', { saved, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: IPHONE, serviceWorkers: 'block' });
  await ctx.route((u) => !u.href.startsWith(base), (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (saved) { await page.goto(`${base}/blank`); await page.evaluate(kv, saved); }
  if (clock) await page.clock.install();
  await page.goto(base + url);
  return { ctx, page, errors };
}
const running = (page) => page.waitForSelector('#nav:not([hidden])', { timeout: 10_000 });
const heading = (page, text) => page.waitForFunction((t) => document.querySelector('#app h1')?.textContent === t, text, { timeout: 10_000 });
const keyCalls = () => A.calls.filter((c) => c.path === '/api/sync/key').map((c) => [c.method, c.body]);
async function until(fn, what) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}

test('signed in is synced: the phone gets the account’s key from Lumio, with no code to compare', { skip, timeout: 30_000 }, async () => {
  account(); // a new account: no key anywhere yet
  const { ctx, page, errors } = await phone();
  await running(page);
  assert.equal(await page.$('.code'), null, 'nothing to approve');
  assert.deepEqual(keyCalls(), [['POST', {}]], 'the phone asked Lumio for the key');
  assert.ok(!A.calls.some((c) => c.path.startsWith('/api/sync/pair')), 'and asked no computer');
  for (const c of A.calls.filter((x) => x.path.startsWith('/api/sync') || x.path.startsWith('/api/companion'))) assert.equal(c.sync, '1', `${c.method} ${c.path} says X-Lumio-Sync`);
  assert.equal(A.calls.find((c) => c.path === '/api/sync/key').origin, base);
  const kept = await stored(page);
  assert.equal(kept[`syncKey:${EMAIL}`], C.toB64(A.held));
  assert.equal(kept.syncKeyOwner, EMAIL);
  assert.equal(kept.syncMode, 'managed');

  // Next time, the key it kept is the account's: nothing to fetch or upload,
  // and what the computers synced opens with it.
  A.records.push(await chat(A.held, 1, 'Trip to Lisbon'));
  A.calls = [];
  await page.reload();
  await running(page);
  await page.click('#nav [data-view="chats"]');
  await page.waitForSelector('[data-chat]');
  assert.match(await page.textContent('.list'), /Trip to Lisbon/);
  assert.deepEqual(keyCalls(), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an account from before: a phone that has the key gives Lumio a copy, and a phone waiting for it joins by itself', { skip, timeout: 40_000 }, async () => {
  const K = C.newKey();
  account({ keyCheck: await check(K), records: [await chat(K, 1, 'Trip to Lisbon')] }); // end-to-end encrypted until now: Lumio has no copy

  // A phone without the key: Finishing setup, with the code for older computers.
  const waiting = await phone();
  await heading(waiting.page, 'Finishing setup');
  assert.match(await waiting.page.textContent('#app'), /Open Lumio Browser on a computer that already syncs\. Once it has the latest version, your phone connects by itself\.\s*Using an older version\? Approve iPhone there\. It should show this code:/);
  const [request] = [...A.pairings.values()];
  assert.equal((await waiting.page.textContent('.code')).replace(/\s/g, ''), await C.pairCode(request.pubkey));
  assert.ok(await waiting.page.$('#rk'), 'the recovery key still works');
  assert.deepEqual(keyCalls(), [], 'nothing to ask Lumio for yet');

  // A phone that paired before has the key: it gives Lumio a copy (once) and runs.
  A.calls = [];
  const migrated = await phone('/companion', { saved: { [`syncKey:${EMAIL}`]: C.toB64(K), syncKeyOwner: EMAIL } });
  await running(migrated.page);
  await until(() => A.held, 'the upload');
  assert.deepEqual(keyCalls().filter(([method]) => method === 'PUT'), [['PUT', { key: C.toB64(K) }]]);
  assert.deepEqual(A.held, K);
  assert.equal(await migrated.page.$('.code'), null);

  // Now that Lumio has it, the waiting phone's request is approved by Lumio.
  await running(waiting.page);
  assert.equal(request.status, 'done', 'Lumio approved it');
  assert.equal((await stored(waiting.page))[`syncKey:${EMAIL}`], C.toB64(K));
  await waiting.page.click('#nav [data-view="chats"]');
  await waiting.page.waitForSelector('[data-chat]');
  assert.match(await waiting.page.textContent('.list'), /Trip to Lisbon/);
  assert.deepEqual([...waiting.errors, ...migrated.errors], []);
  await waiting.ctx.close();
  await migrated.ctx.close();

  // Without a request to approve, the phone asks Lumio again every 10 s.
  account({ keyCheck: await check(K), autoApprove: false });
  const later = await phone('/companion', { clock: true });
  await heading(later.page, 'Finishing setup');
  A.held = K;
  await later.page.clock.fastForward(10_000);
  await running(later.page);
  assert.deepEqual(keyCalls(), [['POST', {}]]);
  assert.equal((await stored(later.page))[`syncKey:${EMAIL}`], C.toB64(K));
  assert.deepEqual(later.errors, []);
  await later.ctx.close();
});

test('with its own passphrase, or an older server, the computer approves the phone as before and Lumio never has the key', { skip, timeout: 40_000 }, async () => {
  const K = C.newKey();
  const approve = async () => {
    await until(() => A.pairings.size, 'the request');
    const p = [...A.pairings.values()].at(-1);
    p.answer = await C.wrapForDevice(K, p.pubkey);
  };
  for (const [name, state] of [['passphrase', { mode: 'passphrase' }], ['older server', { legacy: true }], ['no master key', { available: false }]]) {
    account({ keyCheck: await check(K), records: [await chat(K, 1, 'Trip to Lisbon')], ...state });
    const { ctx, page, errors } = await phone();
    await heading(page, 'Connect your phone');
    assert.match(await page.textContent('#app'), /Lumio on your computer will ask to approve iPhone\. Approve it only if it shows this code:/, name);
    await approve();
    await running(page);
    assert.equal((await stored(page))[`syncKey:${EMAIL}`], C.toB64(K), name);
    assert.deepEqual(keyCalls(), [], `${name}: the key never comes from Lumio`);
    assert.deepEqual(errors, [], name);
    await ctx.close();
  }

  // Not set up anywhere, on an older server: turn on Sync on the computer first.
  account({ legacy: true });
  let { ctx, page } = await phone();
  await heading(page, 'Turn on Sync first');
  await ctx.close();

  // A computer turns on the passphrase just as the phone asks: Lumio says so, and the phone pairs.
  account({ flip: async () => { A.mode = 'passphrase'; A.keyCheck = await check(K); } });
  ({ ctx, page } = await phone());
  await heading(page, 'Connect your phone');
  assert.deepEqual(keyCalls(), [['POST', {}]]);
  await approve();
  await running(page);
  assert.equal((await stored(page)).syncMode, 'passphrase');
  await ctx.close();
});

test('signing out removes the key from the phone, unless the account uses its own passphrase', { skip, timeout: 40_000 }, async () => {
  const K = C.newKey();
  const saved = { [`syncKey:${EMAIL}`]: C.toB64(K), syncKeyOwner: EMAIL };

  // The session ends while the phone is open.
  for (const mode of ['managed', 'passphrase']) {
    account({ mode, keyCheck: await check(K), held: mode === 'managed' ? K : null });
    const { ctx, page, errors } = await phone('/companion', { saved });
    await running(page);
    A.signedIn = false;
    await page.waitForSelector('a.btn.primary[href^="/signin"]', { timeout: 10_000 });
    const kept = await stored(page);
    if (mode === 'managed') assert.deepEqual([kept[`syncKey:${EMAIL}`], kept.syncKeyOwner], [undefined, undefined], 'managed: the key is gone');
    else assert.deepEqual([kept[`syncKey:${EMAIL}`], kept.syncKeyOwner], [C.toB64(K), EMAIL], 'passphrase: the key stays, so signing in again needs no approval');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // Or it ended while the phone was closed: what Lumio last said decides (a
  // server that doesn't keep keys is the e2ee flow too: the key stays).
  for (const [why, syncMode, syncManaged, left] of [['managed', 'managed', true, undefined], ['passphrase', 'passphrase', false, C.toB64(K)], ['no keys on the server', 'managed', false, C.toB64(K)]]) {
    account({ signedIn: false });
    const { ctx, page } = await phone('/companion', { saved: { ...saved, syncMode, syncManaged } });
    await page.waitForSelector('a.btn.primary[href^="/signin"]');
    assert.equal((await stored(page))[`syncKey:${EMAIL}`], left, why);
    await ctx.close();
  }
  // The session ends while the phone is open, on a server that doesn't keep keys: the key stays.
  account({ available: false, keyCheck: await check(K) });
  {
    const { ctx, page } = await phone('/companion', { saved });
    await running(page);
    A.signedIn = false;
    await page.waitForSelector('a.btn.primary[href^="/signin"]', { timeout: 10_000 });
    assert.equal((await stored(page))[`syncKey:${EMAIL}`], C.toB64(K), 'no other copy may exist');
    await ctx.close();
  }

  // Sign out on the account page.
  for (const mode of ['managed', 'passphrase']) {
    account({ mode, keyCheck: await check(K), held: mode === 'managed' ? K : null });
    const { ctx, page, errors } = await phone('/account', { saved: { ...saved, 'syncKey:old@example.com': C.toB64(C.newKey()), device: 'phone-1' } });
    await page.waitForSelector('#page:not([hidden])');
    A.calls = [];
    await page.click('#sign-out');
    await page.waitForURL(`${base}/`);
    assert.deepEqual(A.calls.filter((c) => /^\/api\/(sync|auth)/.test(c.path)).map((c) => `${c.method} ${c.path}`), ['GET /api/sync', 'POST /api/auth']);
    const kept = await stored(page);
    if (mode === 'managed') assert.deepEqual(kept, { device: 'phone-1' }, 'every sync key is gone');
    else assert.equal(kept[`syncKey:${EMAIL}`], C.toB64(K));
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // A browser that never opened the phone page: nothing made, nothing to remove.
  account({ held: K, keyCheck: await check(K) });
  const { ctx, page } = await phone('/account');
  await page.waitForSelector('#page:not([hidden])');
  await page.click('#sign-out');
  await page.waitForURL(`${base}/`);
  assert.deepEqual((await page.evaluate(() => indexedDB.databases())).map((d) => d.name), []);
  await ctx.close();
});

test('a key that changes while the phone is open: Reset sync, then the passphrase, on a computer', { skip, timeout: 40_000 }, async () => {
  const K1 = C.newKey();
  account({ held: K1, keyCheck: await check(K1), records: [await chat(K1, 1, 'Trip to Lisbon')] });
  const { ctx, page, errors } = await phone('/companion', { clock: true });
  await running(page);
  await page.click('#nav [data-view="chats"]');
  await page.waitForSelector('[data-chat]');

  // Reset sync: a new key on Lumio, and the computers upload again with it.
  const K2 = C.newKey();
  Object.assign(A, { held: K2, keyCheck: await check(K2), records: [await chat(K2, 7, 'Garden plan')] });
  A.calls = [];
  await page.clock.fastForward(60_000);
  await page.waitForFunction(() => /Garden plan/.test(document.querySelector('.list')?.textContent || ''), null, { timeout: 10_000 });
  assert.doesNotMatch(await page.textContent('.list'), /Lisbon/, 'what was synced with the old key is gone');
  assert.deepEqual(keyCalls(), [['POST', {}]]);
  assert.equal((await stored(page))[`syncKey:${EMAIL}`], C.toB64(K2));

  // The passphrase: Lumio's copy is gone, and a computer approves the phone again.
  const K3 = C.newKey();
  Object.assign(A, { mode: 'passphrase', held: null, keyCheck: await check(K3), records: [] });
  await page.clock.fastForward(60_000);
  await heading(page, 'Connect your phone');
  assert.equal(await page.isHidden('#nav'), true);
  const kept = await stored(page);
  assert.deepEqual([kept[`syncKey:${EMAIL}`], kept.syncMode], [undefined, 'passphrase']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the account’s own passphrase isn’t turned off by the server’s word alone: the phone keeps its key, and asks nobody', { skip, timeout: 40_000 }, async () => {
  const K = C.newKey();
  const X = C.newKey();
  const saved = { [`syncKey:${EMAIL}`]: C.toB64(K), syncKeyOwner: EMAIL, syncMode: 'passphrase', syncPassphraseCheck: await check(K) };
  // Someone with the session made the account managed with a key of theirs.
  account({ mode: 'managed', keyCheck: await check(X), held: X });
  const { ctx, page, errors } = await phone('/companion', { saved });
  await heading(page, 'Sync is paused');
  const kept = await stored(page);
  assert.deepEqual([kept[`syncKey:${EMAIL}`], kept.syncMode, kept.syncManaged], [C.toB64(K), 'passphrase', false], 'its own key, kept');
  assert.deepEqual(keyCalls(), [], 'never handed to Lumio, and Lumio’s key never asked for');
  assert.ok(!A.calls.some((c) => c.path === '/api/sync/pair'), 'nobody asked to approve it (Lumio would answer with its key)');
  // The person chooses the key Lumio keeps.
  await page.click('#use-lumio');
  await running(page);
  assert.equal((await stored(page))[`syncKey:${EMAIL}`], C.toB64(X));
  assert.deepEqual(errors, []);
  await ctx.close();

  // Turned off in Lumio Browser, which has the key: Lumio hands back this phone's key, and it just follows.
  account({ mode: 'managed', keyCheck: await check(K), held: K });
  const two = await phone('/companion', { saved });
  await running(two.page);
  assert.deepEqual(keyCalls(), [['POST', {}]], 'checked once');
  assert.deepEqual([(await stored(two.page)).syncMode, (await stored(two.page)).syncManaged], ['managed', true]);
  await two.ctx.close();
});

test('“too many requests” from Lumio’s key route: the phone waits as long as Lumio says before asking again', { skip, timeout: 40_000 }, async () => {
  const K = C.newKey();
  account({ keyCheck: await check(K), held: null, autoApprove: false }); // waiting for a computer to give Lumio the key
  const { ctx, page, errors } = await phone('/companion', { clock: true });
  await heading(page, 'Finishing setup');
  Object.assign(A, { held: K, limited: true });
  await page.clock.fastForward(10_000);
  await until(() => keyCalls().length === 1, 'a key read');
  for (let i = 0; i < 6; i++) await page.clock.fastForward(60_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(keyCalls().length, 1, 'not again for ten minutes');
  A.limited = false;
  await page.clock.fastForward(5 * 60_000);
  await running(page);
  assert.equal(keyCalls().length, 2);
  assert.equal((await stored(page))[`syncKey:${EMAIL}`], C.toB64(K));
  assert.deepEqual(errors, []);
  await ctx.close();
});
