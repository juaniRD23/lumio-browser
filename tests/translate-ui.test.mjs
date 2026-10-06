// The translate button (renderer/ui/translate.js) and its bubble
// (renderer/ui/overlay-translate.js) in headless Chrome, with a stand-in for
// the main process: when the button shows, the bubble opening from it, each
// state of the bubble, its choices, the keyboard, and light and dark.
// Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contrast } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const tabWith = (translate) => ({ id: 1, title: 'Le Monde', url: 'https://lemonde.example/article', loading: false, canGoBack: false, canGoForward: false, pinned: false, translate });
const INIT = {
  tabs: { activeId: 1, tabs: [tabWith({ lang: 'fr', status: 'offer', target: 'en' })] }, downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
const BUBBLE = {
  kind: 'translate', tabId: 1, lang: 'fr', target: 'en', status: 'offer', error: null, capped: false, signedIn: true, incognito: false, host: 'lemonde.example',
  canTranslate: true, always: false, never: false, neverSite: false, languages: ['en', 'es', 'fr', 'de', 'zh-TW'],
};

// One server per lumio:// host (the shell and the overlay), like the app serves them.
const servers = [];
const bases = {};
let browser;
before(async () => {
  if (!CHROME) return;
  for (const host of ['shell', 'overlay']) {
    const server = http.createServer((req, res) => {
      const file = resolveFile(new URL(`lumio://${host}${req.url}`), new Set([host]));
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
      res.end(fs.readFileSync(file));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    bases[host] = `http://127.0.0.1:${server.address().port}`;
  }
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); servers.forEach((s) => s.close()); });

// The shell or the overlay page, with a stand-in for the main process.
async function open(host, { colorScheme = 'light', answers = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: host === 'overlay' ? 380 : 1300, height: host === 'overlay' ? 420 : 800 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ init, ai, extra }) => {
    const handlers = {};
    window.__sent = [];
    window.__calls = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] }, ...extra };
    window.lumio = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, args[0]]); return structuredClone(answers[channel] ?? null); },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { init: INIT, ai: AI, extra: answers });
  await page.goto(`${bases[host]}/`);
  return { page, errors };
}
const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);

test('the button shows for a page in another language and opens the bubble from it', { skip }, async () => {
  const { page, errors } = await open('shell', { answers: { 'translate:bubble': BUBBLE } });
  await page.waitForSelector('#translate-btn:not([hidden])');
  assert.equal(await page.getAttribute('#translate-btn', 'aria-label'), 'Translate this page');
  await page.click('#translate-btn');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:show'));
  const [shown] = await sent(page, 'overlay:show');
  assert.equal(shown.payload.kind, 'translate');
  assert.equal(shown.payload.status, 'offer');
  const btn = await page.$eval('#translate-btn', (b) => b.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(shown.rect.y - (btn.bottom + 8)) < 2 && shown.rect.x + shown.rect.width > btn.left, 'hangs from the button');
  assert.equal(await page.getAttribute('#translate-btn', 'aria-expanded'), 'true');
  // Clicking it again closes it; Esc in the bubble gives the keyboard back to it.
  await page.click('#translate-btn');
  assert.deepEqual((await sent(page, 'overlay:hide')).at(-1), 'translate');
  await page.click('#translate-btn');
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'translate', refocus: true }));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'translate-btn');
  assert.equal(await page.getAttribute('#translate-btn', 'aria-expanded'), 'false');
  // Translated: lit; a page in your language: no button.
  await page.evaluate(() => window.__emit('tabs', { activeId: 1, tabs: [{ id: 1, title: 'Le Monde', url: 'https://lemonde.example/article', translate: { lang: 'fr', status: 'translated', target: 'en' } }] }));
  assert.equal(await page.$eval('#translate-btn', (b) => b.classList.contains('on')), true);
  await page.evaluate(() => window.__emit('tabs', { activeId: 1, tabs: [{ id: 1, title: 'News', url: 'https://news.example/', translate: { lang: 'en', status: null, target: 'en' } }] }));
  // (The address bar's buttons ease out of their slot: batch 3's motion.)
  assert.equal(await page.$eval('#translate-btn', (b) => b.hidden), true);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#translate-btn')).display === 'none');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the bubble opens by itself for a new page, but not while you type in the address bar', { skip }, async () => {
  const { page, errors } = await open('shell', { answers: { 'translate:bubble': BUBBLE } });
  await page.waitForSelector('#translate-btn:not([hidden])');
  await page.focus('#address');
  await page.evaluate(() => window.__emit('translate-prompt', { tabId: 1 }));
  await page.waitForTimeout(100);
  assert.equal((await sent(page, 'overlay:show')).length, 0);
  await page.evaluate(() => document.getElementById('address').blur());
  await page.evaluate(() => window.__emit('translate-prompt', { tabId: 1 }));
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:show'));
  // View › Translate Page… opens it with the keyboard in it.
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'translate' }));
  await page.evaluate(() => window.__emit('translate-prompt', { tabId: 1, force: true }));
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'translate:focus'));
  assert.equal((await sent(page, 'overlay:show')).at(-1).payload.focus, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the bubble: translate, the language choices, and the keyboard', { skip }, async () => {
  const { page, errors } = await open('overlay');
  const show = (p) => page.evaluate((p) => {
  // The overlay's steps (main/window.js): a new kind is shown, then comes in;
  // the same kind again is new content for it.
  if (window.__shownKind === p.kind) { window.__emit('overlay-data', p); return; }
  window.__shownKind = p.kind;
  window.__seq = (window.__seq || 0) + 1;
  window.__emit('overlay-data', { ...p, op: 'show', seq: window.__seq });
  window.__emit('overlay-data', { op: 'in', seq: window.__seq });
}, p);
  await show({ ...BUBBLE, focus: true });
  assert.equal(await page.textContent('.tb-title'), 'Translate this page?');
  assert.match(await page.textContent('.tb-langs'), /French→/);
  assert.equal(await page.$eval('.tb-langs select', (s) => s.selectedOptions[0].textContent), 'English');
  assert.ok(await page.$eval('.tb-langs select', (s) => [...s.options].some((o) => o.textContent === 'Traditional Chinese')));
  assert.deepEqual(await page.$$eval('.tb-check span', (els) => els.map((e) => e.textContent)), ['Always translate French', 'Never translate French', 'Never translate this site']);
  // The keyboard starts on Translate; arrows move between the controls.
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Translate');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Not now');
  await page.click('[data-act="translate"]');
  assert.deepEqual((await sent(page, 'translate:action')).at(-1), { action: 'translate', tabId: 1 });
  await page.click('.tb-check:has([data-act="always"])');
  assert.deepEqual((await sent(page, 'translate:action')).at(-1), { action: 'always', tabId: 1, value: true });
  await page.selectOption('.tb-langs select', 'es');
  assert.deepEqual((await sent(page, 'translate:action')).at(-1), { action: 'target', tabId: 1, value: 'es' });
  // While translating, then translated: it redraws without losing the keyboard.
  await show({ ...BUBBLE, status: 'translating' });
  assert.equal(await page.textContent('.tb-title'), 'Translating to English…');
  await page.focus('[data-act="original"]');
  await show({ ...BUBBLE, status: 'translated' });
  assert.equal(await page.textContent('.tb-title'), 'Translated to English');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'original');
  await page.click('[data-act="close"]');
  assert.deepEqual((await sent(page, 'overlay:pick')).at(-1), { kind: 'translate', refocus: false });
  // Esc: not now, and the keyboard goes back to the address bar's button.
  await show({ ...BUBBLE, focus: true });
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent(page, 'translate:refocus')).length, 1);
  assert.deepEqual((await sent(page, 'translate:action')).at(-1), { action: 'dismiss', tabId: 1, refocus: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('the bubble when signed out, on an error, and in incognito', { skip }, async () => {
  const { page, errors } = await open('overlay');
  const show = (p) => page.evaluate((p) => {
  // The overlay's steps (main/window.js): a new kind is shown, then comes in;
  // the same kind again is new content for it.
  if (window.__shownKind === p.kind) { window.__emit('overlay-data', p); return; }
  window.__shownKind = p.kind;
  window.__seq = (window.__seq || 0) + 1;
  window.__emit('overlay-data', { ...p, op: 'show', seq: window.__seq });
  window.__emit('overlay-data', { op: 'in', seq: window.__seq });
}, p);
  await show({ ...BUBBLE, signedIn: false });
  assert.equal(await page.textContent('.tb-title'), 'Sign in to translate');
  assert.equal(await page.$$eval('.tb-check', (els) => els.length), 0);
  await page.click('[data-act="sign-in"]');
  assert.equal((await sent(page, 'account:sign-in')).length, 1);
  await show({ ...BUBBLE, status: 'error', error: 'You’ve used your Lumio AI allowance on the Free plan for now.' });
  assert.match(await page.textContent('.tb-sub'), /allowance/);
  assert.equal(await page.textContent('[data-act="translate"]'), 'Try again');
  // Incognito: Always translate doesn't apply, and no site is remembered.
  await show({ ...BUBBLE, incognito: true });
  assert.deepEqual(await page.$$eval('.tb-check span', (els) => els.map((e) => e.textContent)), ['Never translate French']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the bubble is readable in light and dark', { skip }, async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors } = await open('overlay', { colorScheme: scheme });
    await page.evaluate((p) => {
  // The overlay's steps (main/window.js): a new kind is shown, then comes in;
  // the same kind again is new content for it.
  if (window.__shownKind === p.kind) { window.__emit('overlay-data', p); return; }
  window.__shownKind = p.kind;
  window.__seq = (window.__seq || 0) + 1;
  window.__emit('overlay-data', { ...p, op: 'show', seq: window.__seq });
  window.__emit('overlay-data', { op: 'in', seq: window.__seq });
}, BUBBLE);
    const c = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const paint = (...colors) => { ctx.clearRect(0, 0, 1, 1); for (const x of colors) { ctx.fillStyle = x; ctx.fillRect(0, 0, 1, 1); } return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      return { bg: paint(css('#card', 'backgroundColor')), title: paint(css('.tb-title', 'color')), check: paint(css('.tb-check', 'color')), note: paint(css('.tb-note', 'color')) };
    });
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `translate-bubble-${scheme}.png`) });
    for (const part of ['title', 'check', 'note']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${scheme}: ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});
