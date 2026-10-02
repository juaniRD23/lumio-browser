// Smoke test for the window's UI (renderer/ui/shell.html and the AI panel):
// loads it in headless Chrome with a stand-in for the main process and fails
// on any error while it starts. A startup error breaks the whole window (and
// nearly every e2e test), so this catches it in seconds instead of a full
// e2e run. Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveFile } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

// What the main process answers while the window starts (see main.js shell:init).
const AI = { ready: true, lumio: { signedIn: true, plan: 'free', usage: { used: 0.38, fullAt: Date.now() + 864e5 } }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false, vision: true, macAvailable: true };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc', favicon: null, loading: false, canGoBack: false, canGoForward: false, pinned: false, pdf: false }] },
  downloads: [], panel: { open: true, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'Test Person', email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.3', update: null,
};

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://shell${req.url.split('?')[0]}`), new Set(['shell']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

test('the window and AI panel start without errors, and the composer works', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ init, ai }) => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] }, 'ai:set-mode': (m) => ({ ...ai, mode: m }) };
    window.lumio = {
      invoke: async (channel, ...args) => { const a = answers[channel]; return typeof a === 'function' ? a(...args) : a ?? null; },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { init: INIT, ai: AI });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.getElementById('mode-name')?.textContent === 'Ask', null, { timeout: 10_000 }).catch(() => {});
  assert.deepEqual(errors, [], 'no errors while starting');

  // Approvals: one button; its menu switches the mode.
  await page.click('#mode-btn');
  assert.equal(await page.isVisible('#mode-menu'), true);
  await page.click('#mode-menu [data-mode="auto"]');
  await page.waitForFunction(() => document.getElementById('mode-name').textContent === 'Auto');
  assert.equal(await page.isVisible('#mode-menu'), false);

  // An empty box offers voice mode where Send is; typing brings Send back.
  assert.equal(await page.isVisible('#voice-btn'), true);
  assert.equal(await page.isVisible('#send'), false);
  await page.fill('#prompt', 'hello');
  assert.equal(await page.isVisible('#send'), true);
  assert.equal(await page.isVisible('#voice-btn'), false);
  await page.fill('#prompt', '');

  // On a YouTube video, the panel offers a summary.
  assert.match(await page.textContent('#page-suggest'), /Summarize this video/);

  // The + menu has "Ask about my tabs", which sets the chip.
  await page.click('#plus-btn');
  await page.click('#add-tabs');
  assert.equal(await page.textContent('#context-chip span'), 'All open tabs');
  assert.deepEqual(errors, [], 'no errors while using it');
});
