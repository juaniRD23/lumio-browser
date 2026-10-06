// Reading mode (renderer/ui/reading-mode.js) in the window's UI, in headless
// Chrome with a stand-in for the main process: the address bar button opens
// the column, the article is sanitized and laid out, the text settings and
// themes work (readable in light and dark), and Read aloud asks Lumio's voice
// for whole sentences, highlights the one being read, pauses, skips and
// reports errors. Skipped when Google Chrome isn't installed.
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const URL_A = 'https://news.example/lighthouses';
const TAB = { id: 1, title: 'Lighthouses', url: URL_A, favicon: null, loading: false, canGoBack: false, canGoForward: false, pinned: false, pdf: false, readerable: true };
const INIT = {
  tabs: { activeId: 1, tabs: [TAB] }, downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
// What main/reader.js would find on the page: Readability's HTML, with things
// the view must never let through.
const ARTICLE = {
  ok: true, tabId: 1, url: URL_A, prefs: { font: 'sans', size: 17, spacing: 'normal', theme: 'auto', speed: 1 },
  article: {
    title: 'The Quiet History of Lighthouses', byline: 'By Ada Keeper', siteName: 'News Example', lang: 'en', dir: 'ltr', length: 900,
    content: `<div><p>Lighthouses have guided ships for <a href="https://news.example/pharos">more than two thousand years</a>. The Pharos stood over 100 metres tall.</p>
      <p onclick="window.__pwned = 1" id="panel" class="tab" style="color: red">Keepers trimmed wicks every night. <b>Many</b> stations were remote.</p>
      <script>window.__pwned = 2</script><iframe src="https://evil.example/"></iframe><form><input value="x"></form>
      <img src="https://img.example/a.png" onerror="window.__pwned = 3" alt="A lighthouse">
      <pre><code>const light = 1; // never read aloud</code></pre>
      <h2>Automation</h2><p>Today many towers are museums. The lights still shine as a backup.</p></div>`,
  },
};

let server;
let browser;
let base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://shell${req.url}`), new Set(['shell']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); server?.close(); });

// The window's UI with a stand-in main process. `answers` (channel -> value,
// or { fn } run in the page) replace what invoke() returns; window.__calls and
// window.__sent record everything.
async function openShell(answers = {}, { colorScheme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript(({ init, ai, extra }) => {
    const handlers = {};
    window.__sent = [];
    window.__calls = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] } };
    for (const [k, v] of Object.entries(extra)) answers[k] = v.fn ? new Function('...args', v.fn) : v.value;
    window.lumio = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, args[0]]); const a = answers[channel]; return typeof a === 'function' ? a(...args) : structuredClone(a ?? null); },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { init: INIT, ai: AI, extra: { 'reader:article': { value: ARTICLE }, ...answers } });
  await page.goto(`${base}/`);
  await page.waitForSelector('#reader-btn', { state: 'attached' });
  return { page, errors };
}
const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const calls = (page, channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map(([, p]) => p), channel);
const open = async (page) => {
  await page.click('#reader-btn');
  await page.waitForSelector('#reader:not(.closed) .rd-title');
};

test('the address bar button opens the article in its own column, sanitized, and Esc closes it', { skip }, async () => {
  const { page, errors } = await openShell();
  assert.equal(await page.isVisible('#reader-btn'), true, 'shown on a page that looks like an article');
  // The shell reports its page slot after its first layout, which can come late on a busy machine.
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'layout:slot'));
  const before = (await sent(page, 'layout:slot')).at(-1).width;
  await open(page);
  assert.deepEqual(await calls(page, 'reader:article'), [1]);
  assert.equal(await page.textContent('.rd-title'), 'The Quiet History of Lighthouses');
  assert.match(await page.textContent('.rd-site'), /News Example · \d+ min read/);
  assert.equal(await page.getAttribute('#reader-btn', 'aria-pressed'), 'true');
  // The page makes room for the column.
  await page.waitForFunction((w) => window.__sent.filter(([c]) => c === 'layout:slot').at(-1)[1].width < w - 250, before);
  // Nothing from the page runs or styles itself: no scripts, frames, forms, handlers, ids, classes or styles.
  const body = await page.$eval('.rd-body', (el) => el.innerHTML);
  assert.doesNotMatch(body, /<script|<iframe|<form|<input|onclick|onerror|id="panel"|class="tab"|style=/);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  // Links open in a new tab.
  await page.click('.rd-body a');
  assert.deepEqual(await sent(page, 'open-url'), ['https://news.example/pharos']);
  // Sentences: one across the link (same number on both pieces), none in code.
  const spans = await page.$$eval('.rd-body .rs', (els) => els.map((e) => [e.dataset.s, e.textContent]));
  const first = spans.filter(([s]) => s === spans[0][0]).map(([, t]) => t).join('');
  assert.equal(first, 'Lighthouses have guided ships for more than two thousand years. ');
  assert.equal(await page.$$eval('.rd-body pre .rs', (els) => els.length), 0);
  // Esc closes it and gives the keyboard back to the button.
  await page.focus('.rd-scroll');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#reader.closed', { state: 'attached' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'reader-btn');
  assert.deepEqual(errors, []);
  await page.close();
});

test('in incognito the article’s pictures are left out (the view’s session isn’t the incognito one)', { skip }, async () => {
  const { page, errors } = await openShell({ 'reader:article': { value: { ...ARTICLE, incognito: true } } });
  await open(page);
  assert.equal(await page.$$eval('.rd-body img, .rd-body picture, .rd-body source', (els) => els.length), 0);
  assert.match(await page.textContent('.rd-body'), /Keepers trimmed wicks/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('text settings: font, size, spacing and theme, by mouse and arrow keys, saved for next time', { skip }, async () => {
  const { page, errors } = await openShell();
  await open(page);
  await page.click('[data-rd="settings"]');
  assert.equal(await page.isVisible('#rd-settings'), true);
  // The selected font has focus; the arrow key picks the next one.
  assert.equal(await page.evaluate(() => document.activeElement.dataset.v), 'sans');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('[data-pref="font"] [data-v="serif"]', 'aria-checked'), 'true');
  assert.match(await page.$eval('.rd-article', (el) => getComputedStyle(el).fontFamily), /Iowan|Charter|Palatino|Georgia|serif/);
  await page.click('[data-rd="larger"]');
  await page.click('[data-rd="larger"]');
  assert.equal(await page.$eval('.rd-article', (el) => getComputedStyle(el).fontSize), '20px');
  await page.click('[data-pref="spacing"] [data-v="loose"]');
  assert.equal(await page.$eval('.rd-article', (el) => parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize)), 1.9);
  await page.click('[data-pref="theme"] [data-v="sepia"]');
  const saved = Object.assign({}, ...(await sent(page, 'reader:set-prefs')));
  assert.deepEqual(saved, { font: 'serif', size: 20, spacing: 'loose', theme: 'sepia' });
  // Esc closes the settings first, then the view.
  await page.focus('[data-pref="theme"] [data-v="sepia"]');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#rd-settings'), false);
  assert.equal(await page.isVisible('#reader .rd'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

// The view's colors as they end up on screen, for every theme.
const viewColors = (page) => page.evaluate(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const paint = (...colors) => { ctx.clearRect(0, 0, 1, 1); for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); } return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
  const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
  const bg = paint(css('body', 'backgroundColor'), css('.rd', 'backgroundColor'));
  return { bg, text: paint(css('.rd-title', 'color')), dim: paint(css('.rd-site', 'color')), link: paint(css('.rd-body a', 'color')) };
});

test('every theme is readable on a light and a dark computer', { skip }, async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors } = await openShell({}, { colorScheme: scheme });
    await open(page);
    await page.click('[data-rd="settings"]');
    const seen = {};
    for (const theme of ['auto', 'light', 'dark', 'sepia']) {
      await page.click(`[data-pref="theme"] [data-v="${theme}"]`);
      const c = await viewColors(page);
      seen[theme] = c.bg.join(',');
      for (const part of ['text', 'dim', 'link']) {
        const ratio = contrast(c[part], c.bg);
        assert.ok(ratio >= 4.5, `${scheme} computer, ${theme} theme: ${part} is ${ratio.toFixed(2)}:1`);
      }
    }
    // Auto follows the computer; Light and Dark don't.
    assert.equal(seen.auto, seen[scheme]);
    assert.notEqual(seen.light, seen.dark);
    assert.notEqual(seen.sepia, seen.light);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `reader-${scheme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// A WAV of `seconds` of silence, made in the page (what ai:voice-speak returns).
const wavFn = (seconds) => `const n = Math.round(8000 * ${seconds}); const b = new Uint8Array(44 + n * 2); const v = new DataView(b.buffer);
  const w = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);`;

test('Read aloud: whole sentences go to Lumio’s voice, the one being read is highlighted, and it pauses and skips', { skip }, async () => {
  const { page, errors } = await openShell({
    // The first piece waits until the test lets it go, so the highlight can be checked while it loads.
    'ai:voice-speak': { fn: `${wavFn(2)} const first = !window.__spoke; window.__spoke = true;
      return first ? new Promise((r) => { window.__release = () => r({ audio: b }); }) : { audio: b };` },
  });
  await open(page);
  await page.click('[data-rd="play"]');
  await page.waitForFunction(() => typeof window.__release === 'function');
  const [firstAsk] = await calls(page, 'ai:voice-speak');
  assert.match(firstAsk.text, /^The Quiet History of Lighthouses By Ada Keeper Lighthouses have guided ships/);
  assert.ok(firstAsk.text.length <= 600, 'a piece is a few sentences');
  assert.doesNotMatch(firstAsk.text, /min read|const light/);
  assert.equal(await page.$eval('.rs.on', (el) => el.textContent), 'The Quiet History of Lighthouses');
  assert.equal(await page.textContent('[data-rd="play"] .rd-pl'), 'Loading…');
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => document.querySelector('[data-rd="play"] .rd-pl').textContent === 'Pause');
  // Pause and resume.
  await page.click('[data-rd="play"]');
  assert.equal(await page.textContent('[data-rd="play"] .rd-pl'), 'Resume');
  await page.click('[data-rd="play"]');
  await page.waitForFunction(() => document.querySelector('[data-rd="play"] .rd-pl').textContent === 'Pause');
  // Next sentence: reading goes on from there.
  const asked = (await calls(page, 'ai:voice-speak')).length;
  const now = Number(await page.$eval('.rs.on', (el) => el.dataset.s));
  await page.click('[data-rd="next"]');
  await page.waitForFunction((n) => window.__calls.filter(([c]) => c === 'ai:voice-speak').length > n, asked);
  const marked = Number(await page.$eval('.rs.on', (el) => el.dataset.s));
  assert.equal(marked, now + 1);
  const spoken = (await calls(page, 'ai:voice-speak')).at(-1).text;
  const sentence = await page.$$eval(`.rs[data-s="${marked}"]`, (els) => els.map((e) => e.textContent).join('').trim());
  assert.ok(spoken.startsWith(sentence), `starts at the next sentence: ${spoken}`);
  // Speed is saved.
  await page.selectOption('.rd-speed', '1.5');
  assert.deepEqual((await sent(page, 'reader:set-prefs')).at(-1), { speed: 1.5 });
  // Closing the view stops reading.
  await page.click('[data-rd="close"]');
  assert.equal(await page.$$eval('.rs.on', (els) => els.length), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Read aloud explains what went wrong (signed out), and pages without an article say so', { skip }, async () => {
  const { page, errors } = await openShell({ 'ai:voice-speak': { value: { error: 'Sign in to Lumio first (account button, top right).' } } });
  await open(page);
  await page.click('[data-rd="play"]');
  await page.waitForFunction(() => /Sign in to Lumio/.test(document.querySelector('.rd-status').textContent));
  assert.equal(await page.textContent('[data-rd="play"] .rd-pl'), 'Read aloud');
  // Another tab, without an article: the view follows it and offers to try again.
  await page.evaluate(() => {
    window.__answer = { ok: false, tabId: 2, url: 'https://shop.example/', reason: 'Lumio couldn’t find an article on this page.' };
    window.lumio.invoke = ((orig) => async (c, ...a) => (c === 'reader:article' ? (window.__calls.push([c, a[0]]), window.__answer) : orig(c, ...a)))(window.lumio.invoke);
    window.__emit('tabs', { activeId: 2, tabs: [{ id: 2, title: 'Shop', url: 'https://shop.example/', readerable: false }] });
  });
  await page.waitForSelector('.rd-empty');
  assert.match(await page.textContent('.rd-empty'), /isn’t available for this page.*couldn’t find an article/);
  assert.equal(await page.isVisible('#reader-btn'), true, 'the button stays while the view is open');
  assert.equal(await page.isDisabled('[data-rd="play"]'), true);
  await page.click('[data-rd="again"]');
  await page.waitForFunction(() => window.__calls.filter(([c, id]) => c === 'reader:article' && id === 2).length >= 2);
  // Opened from the page's right-click menu (main sends reader-open).
  await page.click('[data-rd="close"]');
  await page.evaluate(() => window.__emit('reader-open', { tabId: 2 }));
  await page.waitForSelector('#reader:not(.closed)');
  assert.deepEqual(errors, []);
  await page.close();
});
