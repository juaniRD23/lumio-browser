// The phone companion end to end: the real web app (website/public/
// companion.*) in headless Chrome as the phone, a computer running the real
// sync engine and companion bridge with stand-in windows, and the real server
// code (in-memory D1) between them. Skipped without Google Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import worker from '../server/src/index.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../main/store.js');
const { Workflows } = require('../main/workflows.js');
const { ChatStore } = require('../main/ai/chats.js');
const { SyncEngine } = require('../main/sync/engine.js');
const { CompanionBridge } = require('../main/sync/companion.js');
const adapters = require('../main/sync/adapters.js');

const SHOTS = process.env.LUMIO_SHOTS;
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(450); await page.screenshot({ path: path.join(SHOTS, `phone-${name}.png`) }); } };
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const PUBLIC = new URL('../website/public/', import.meta.url).pathname;
const TOKEN = crypto.randomBytes(32).toString('hex');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

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

let env, server, base, browser;
before(async () => {
  if (!CHROME) return;
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  sql.prepare("INSERT INTO users (id, google_sub, email, name, plan, created_at) VALUES ('u1', 'g1', 'sam@example.com', 'Sam', 'free', 0)").run();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(crypto.createHash('sha256').update(TOKEN).digest('hex'), 'u1', Date.now() + 864e5);
  env = { DB: d1(sql) };
  // One origin for the web app and its API, like the real site.
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
      let body = '';
      for await (const c of req) body += c;
      const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const file = path.join(PUBLIC, url.pathname === '/companion' ? 'companion.html' : url.pathname.slice(1));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// A computer: real sync engine and bridge; its windows are stand-ins that
// record what the phone asked for.
function computer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-companion-'));
  const store = new Store(dir, { isEncryptionAvailable: () => false });
  const chats = new ChatStore(store.chatsFile);
  const workflows = new Workflows(dir);
  const account = {
    base,
    token: () => TOKEN,
    state: () => ({ signedIn: true, email: 'sam@example.com' }),
    fetch: (url, opts = {}) => fetch(url, { method: opts.method, headers: opts.headers, body: opts.body }),
  };
  const sync = new SyncEngine({ dir, store, account });
  sync.deviceName = 'MacBook';
  sync.addAdapters([adapters.chats(chats), adapters.workflows(workflows), adapters.tabs({ deviceId: sync.deviceId, deviceName: 'MacBook', platform: 'mac', windows: () => [{ tabs: [{ url: 'https://news.example/', title: 'Morning news' }] }], remote: sync.remoteTabs })]);
  const did = [];
  const win = {
    incognito: false,
    win: { isDestroyed: () => false, isFocused: () => false },
    ai: {
      chatStore: chats,
      run: null,
      isRunning: () => !!win.ai.run,
      send: async (opts) => { did.push(['send', opts]); return { ok: true, chatId: opts.chatId || 'chat-new' }; },
      steer: (opts) => { did.push(['steer', opts]); return { ok: true }; },
      approve: (id, decision) => did.push(['approve', id, decision]),
      stop: () => did.push(['stop']),
    },
  };
  const bridge = new CompanionBridge({ sync, windows: () => [win], pickWindow: () => win, openChat: () => {} });
  return { store, chats, workflows, sync, bridge, win, did };
}

test('the phone pairs with the computer, sees its chats and work, approves a step and sends a task', { skip: !CHROME && 'Google Chrome not installed', timeout: 60_000 }, async () => {
  const mac = computer();
  mac.chats.add({ id: 'chat-1', title: 'Trip to Lisbon', createdAt: 1, updatedAt: Date.now(), messages: [{ role: 'user', content: 'Plan it' }], display: [{ kind: 'user', text: 'Plan a trip to Lisbon' }, { kind: 'ai', text: 'Day 1: **Alfama**' }] });
  mac.chats.save();
  mac.workflows.add({ title: 'Price check', instructions: 'Check the price of {item}.' });
  await mac.sync.tick();
  assert.equal(mac.sync.status, 'ready', mac.sync.error);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1' });
  await ctx.addCookies([{ name: 'lumio_session', value: TOKEN, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/companion`);

  // Pairing: the phone shows a code; the computer sees the same one and approves.
  await page.waitForSelector('.code');
  await shot(page, '1-pair');
  const code = (await page.textContent('.code')).replace(/\s/g, '');
  await mac.sync.tick();
  const [req] = mac.sync.state().requests;
  assert.deepEqual([req.name, req.code], ['iPhone', code]);
  await mac.sync.answer(req.id, true);
  await page.waitForSelector('#nav:not([hidden])', { timeout: 10_000 });
  await mac.bridge.poll(); // the computer starts listening (older commands are skipped)

  // Chats and workflows synced from the computer.
  await page.click('#nav [data-view="chats"]');
  await page.waitForSelector('[data-chat]');
  assert.match(await page.textContent('.list'), /Trip to Lisbon/);
  await shot(page, '2-chats');
  await page.click('[data-chat]');
  await shot(page, '3-chat');
  assert.match(await page.innerHTML('.msg.ai'), /<strong>Alfama<\/strong>/);
  await page.click('#nav [data-view="workflows"]');
  assert.match(await page.textContent('#app'), /Price check/);
  await shot(page, '5-workflows');
  await page.click('#nav [data-view="tabs"]');
  assert.match(await page.textContent('#app'), /MacBook[\s\S]*Morning news/);

  // Now: the computer is working and waiting for an OK.
  mac.bridge.onEmit(mac.win, 'ai-event', { chatId: 'chat-1', type: 'start' });
  mac.bridge.onEmit(mac.win, 'ai-event', { chatId: 'chat-1', type: 'step', label: 'Reading lisbon.example' });
  mac.bridge.onEmit(mac.win, 'ai-event', { chatId: 'chat-1', type: 'approval', id: 'call_9', label: 'Click “Book”', detail: 'Click “Book” on lisbon.example', risk: 'browser' });
  await mac.bridge.postStatus();
  await page.click('#nav [data-view="now"]');
  await page.waitForSelector('.approval', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot(page, '4-now-approval');
  assert.match(await page.textContent('.live'), /Trip to Lisbon[\s\S]*Reading lisbon\.example[\s\S]*Click “Book”/);
  await page.click('.approval [data-decide="once"]');
  await page.waitForTimeout(300);
  await mac.bridge.poll();
  assert.deepEqual(mac.did.find(([k]) => k === 'approve'), ['approve', 'call_9', 'once']);

  // While it works, what you type joins the task.
  mac.win.ai.run = { chatId: 'chat-1' };
  await page.fill('#ask', 'use the cheaper hotel');
  await page.click('#ask-go');
  await page.waitForTimeout(300);
  await mac.bridge.poll();
  assert.deepEqual(mac.did.find(([k]) => k === 'steer'), ['steer', { chatId: 'chat-1', text: 'use the cheaper hotel' }]);

  // Idle: a new task starts on the computer.
  mac.win.ai.run = null;
  mac.bridge.onEmit(mac.win, 'ai-event', { chatId: 'chat-1', type: 'end' });
  await mac.bridge.postStatus();
  await page.waitForFunction(() => !document.querySelector('.live.working'), null, { timeout: 10_000 });
  await page.fill('#ask', 'what is on my calendar today?');
  await page.click('#ask-go');
  await page.waitForTimeout(300);
  await mac.bridge.poll();
  const sent = mac.did.find(([k, o]) => k === 'send' && o.text);
  assert.equal(sent[1].text, 'what is on my calendar today?');
  assert.equal(sent[1].includePage, false);

  // Nothing readable on the server.
  const rows = await env.DB.prepare('SELECT data FROM companion_messages').all();
  assert.ok(rows.results.length >= 3);
  assert.ok(rows.results.every((r) => !Buffer.from(r.data, 'base64').toString('latin1').includes('calendar')));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('inside the Lumio app, sign-in and notifications are handed to the app', { skip: !CHROME && 'Google Chrome not installed', timeout: 30_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__toApp = []; window.ReactNativeWebView = { postMessage: (m) => window.__toApp.push(JSON.parse(m)) }; });
  await page.goto(`${base}/companion`); // signed out
  await page.click('#app-sign-in');
  assert.deepEqual(await page.evaluate(() => window.__toApp), [{ type: 'sign-in' }], 'the app signs in (not the page: Google blocks web views)');
  await ctx.close();
});
