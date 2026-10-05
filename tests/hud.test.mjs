// What's drawn over the page: the link status bubble and the swipe arrow
// (renderer/ui/hud.*, elide.mjs) and the zoom bubble (renderer/ui/overlay-zoom.js),
// in headless Chrome with a stand-in for the browser. The address
// shortening runs in Node. The Chrome parts are skipped without Google Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast } from './colors.mjs';
import { elideMiddle, elideUrl, displayUrl } from '../renderer/ui/elide.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const mono = (s) => [...s].length; // one pixel per character

test('long addresses lose their middle, never the site', () => {
  assert.equal(elideUrl('https://a.example/x', 100, mono), 'https://a.example/x', 'fits: unchanged');
  const url = 'https://www.example.com/articles/2026/10/a-very-long-story-about-browsers.html?ref=home';
  const short = elideUrl(url, 50, mono);
  assert.ok(mono(short) <= 50, short);
  assert.ok(short.startsWith('https://www.example.com/'), short);
  assert.ok(short.endsWith('ref=home'), 'keeps the end too');
  assert.match(short, /…/);
  // A site name too long for the room is shortened like the rest.
  const long = `https://${'sub.'.repeat(20)}example.com/page`;
  assert.ok(mono(elideUrl(long, 30, mono)) <= 30);
  // Emoji and accents are never cut in half.
  assert.ok(!/\uFFFD/.test(elideMiddle('😀'.repeat(40), 9, mono)));
  assert.equal(elideMiddle('abcdefghij', 5, mono), 'ab…ij');
});

test('the bubble shows readable addresses without hiding tricks', () => {
  assert.equal(displayUrl('https://example.com/caf%C3%A9?q=a%20b'), 'https://example.com/café?q=a%20b');
  // Escaped slashes and question marks stay escaped (decodeURI keeps them).
  assert.equal(displayUrl('https://example.com/a%2Fb%3Fc'), 'https://example.com/a%2Fb%3Fc');
  // Right-to-left and invisible marks would disguise the address.
  assert.equal(displayUrl('https://example.com/%E2%80%AEfdp.exe'), 'https://example.com/%E2%80%AEfdp.exe');
  assert.equal(displayUrl('https://example.com/a%E2%80%8Bb'), 'https://example.com/a%E2%80%8Bb');
  assert.equal(displayUrl('https://xn--80ak6aa92e.com/'), 'https://xn--80ak6aa92e.com/', 'punycode stays punycode');
  assert.equal(displayUrl('https://example.com/%E0%A4%A'), 'https://example.com/%E0%A4%A', 'broken escapes left alone');
});

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const url = new URL(`lumio://overlay${req.url}`);
    const file = resolveFile(url, new Set(['overlay']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html') && url.searchParams.get('appearance') === 'dark') body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// A UI page with a stand-in for the browser: window.__sent records what it
// sends, window.__emit(channel, payload) plays a message to it. Its clock is
// Playwright's, so page.clock.runFor(ms) moves time on (and a busy computer
// can't make the timing tests flaky).
async function open(file, { colorScheme = 'light', reducedMotion = 'no-preference', viewport = { width: 600, height: 120 } } = {}) {
  const page = await browser.newPage({ viewport, colorScheme, reducedMotion });
  await page.clock.install();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window.lumio = {
      invoke: async () => null,
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  });
  await page.goto(`${base}/${file}`);
  await page.evaluate(() => document.fonts.ready.then(() => true)); // not a timer: those are Playwright's now
  return { page, errors, sent: (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel) };
}

test('status bubble: appears after a moment, shortened to fit, moves aside and fades', { skip }, async () => {
  const { page, errors, sent } = await open('hud.html?kind=status', { viewport: { width: 1200, height: 120 } });
  const url = 'https://www.example.com/articles/2026/10/a-very-long-story-about-browsers-and-the-web.html?ref=home';
  // It says its size at once, so its view can be placed before it fades in.
  const visibleAtOnce = await page.evaluate((u) => { window.__emit('hud', { url: u, maxWidth: 260, expandedWidth: 1180, side: 'left' }); return document.body.classList.contains('on'); }, url);
  assert.equal(visibleAtOnce, false, 'not yet');
  const [size] = await sent('hud:size');
  assert.ok(size.width > 100 && size.width <= 260, `width ${size.width}`);
  assert.ok(size.height >= 24 && size.height < 40, `height ${size.height}`);
  await page.clock.runFor(60);
  assert.equal(await page.evaluate(() => document.body.classList.contains('on')), false, 'still not');
  await page.clock.runFor(40);
  assert.equal(await page.evaluate(() => document.body.classList.contains('on')), true, 'shown after 80 ms');
  const text = await page.textContent('#bubble .t');
  assert.ok(text.startsWith('https://www.example.com/') && text.includes('…'), text);
  // Light: dark words on a light bubble.
  const colors = await page.evaluate(() => {
    const b = getComputedStyle(document.getElementById('bubble'));
    return [b.color, b.backgroundColor];
  });
  const rgb = (c) => c.match(/\d+/g).slice(0, 3).map(Number);
  assert.ok(luminance(rgb(colors[1])) > 0.6 && contrast(rgb(colors[0]), rgb(colors[1])) >= 4.5, colors.join(' on '));
  // The pointer stays on the link: the whole address after a moment.
  await page.clock.runFor(1600);
  assert.equal(await page.evaluate(() => document.querySelector('#bubble .t').textContent.includes('…')), false);
  assert.ok((await sent('hud:size')).at(-1).width > size.width, 'wider');
  // The pointer near it: main moves it to the other corner.
  await page.evaluate(() => window.__emit('hud', { side: 'right' }));
  assert.equal(await page.evaluate(() => document.body.dataset.side), 'right');
  // Off the link: it fades, then says it's gone.
  await page.evaluate(() => window.__emit('hud', { url: '' }));
  await page.clock.runFor(200);
  assert.equal(await page.evaluate(() => document.body.classList.contains('on')), true, 'a moment, in case the pointer reaches another link');
  await page.clock.runFor(60);
  assert.equal(await page.evaluate(() => document.body.classList.contains('on')), false, 'fading');
  await page.clock.runFor(250);
  assert.deepEqual((await sent('hud:size')).at(-1), { width: 0, height: 0 }, 'gone: its view can hide');
  // Moving quickly over a link and away never shows it.
  const before = (await sent('hud:size')).length;
  await page.evaluate(() => { window.__emit('hud', { url: 'https://quick.example/', maxWidth: 260, expandedWidth: 580 }); window.__emit('hud', { url: '' }); });
  await page.clock.runFor(200);
  assert.equal(await page.evaluate(() => document.body.classList.contains('on')), false);
  assert.deepEqual((await sent('hud:size')).slice(before).at(-1), { width: 0, height: 0 });
  await page.close();
  assert.deepEqual(errors, []);
});

test('status bubble in dark, and the swipe arrow', { skip }, async () => {
  const dark = await open('hud.html?kind=status', { colorScheme: 'dark' });
  await dark.page.evaluate(() => window.__emit('hud', { url: 'https://example.com/', maxWidth: 300, expandedWidth: 580, side: 'left' }));
  await dark.page.clock.runFor(100);
  assert.equal(await dark.page.evaluate(() => document.body.classList.contains('on')), true);
  const [fg, bg] = await dark.page.evaluate(() => { const b = getComputedStyle(document.getElementById('bubble')); return [b.color, b.backgroundColor]; });
  const rgb = (c) => c.match(/\d+/g).slice(0, 3).map(Number);
  assert.ok(luminance(rgb(bg)) < 0.05 && contrast(rgb(fg), rgb(bg)) >= 4.5, `${fg} on ${bg}`);
  // Another tab: gone at once.
  await dark.page.evaluate(() => window.__emit('hud', { url: '', now: true }));
  assert.equal(await dark.page.evaluate(() => document.body.classList.contains('on')), false);
  assert.deepEqual(await dark.page.evaluate(() => window.__sent.at(-1)[1]), { width: 0, height: 0 });
  await dark.page.close();
  assert.deepEqual(dark.errors, []);

  const { page, errors, sent } = await open('hud.html?kind=swipe', { viewport: { width: 72, height: 72 } });
  await page.evaluate(() => window.__emit('hud', { swipe: { dir: 'back', progress: 0.4 } }));
  assert.deepEqual(await page.evaluate(() => [document.body.classList.contains('on'), document.body.classList.contains('ready'), document.body.style.getPropertyValue('--p')]), [true, false, '0.4']);
  await page.evaluate(() => window.__emit('hud', { swipe: { dir: 'forward', progress: 1 } }));
  assert.equal(await page.evaluate(() => document.body.classList.contains('ready')), true, 'far enough: filled');
  assert.equal(await page.evaluate(() => document.body.dataset.dir), 'forward');
  await page.evaluate(() => window.__emit('hud', { swipe: null, done: true }));
  assert.equal(await page.evaluate(() => document.body.classList.contains('on')), false);
  await page.clock.runFor(200);
  assert.equal((await sent('hud:size')).length, 1, 'only to say it’s gone (main sizes it)');
  await page.close();
  assert.deepEqual(errors, []);
});

test('reduced motion: the bubble shows and hides without fading', { skip }, async () => {
  const { page, errors } = await open('hud.html?kind=status', { reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('bubble')).transitionDuration), '0s');
  await page.close();
  assert.deepEqual(errors, []);
});

test('zoom bubble: the level, − + and Reset, closes by itself unless hovered, Esc gives the keyboard back', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors, sent } = await open('overlay.html', { colorScheme, viewport: { width: 274, height: 90 } });
    await page.evaluate(() => window.__emit('overlay-data', { kind: 'zoom', percent: 110, auto: true }));
    assert.equal(await page.textContent('.zoom-pct'), '110%');
    assert.deepEqual(await page.$$eval('.zoom-row button', (els) => els.map((b) => b.getAttribute('aria-label') || b.textContent)), ['Zoom out', 'Zoom in', 'Reset']);
    assert.ok((await sent('overlay:size')).length > 0, 'it measures itself');
    await page.click('[data-zoom="1"]');
    await page.click('[data-zoom="0"]');
    assert.deepEqual(await sent('tab:zoom'), [1, 0]);
    // The pointer is on it: it stays. It leaves: it closes after a moment.
    await page.hover('.zoom-pct');
    await page.clock.runFor(1700);
    assert.deepEqual(await sent('overlay:pick'), []);
    await page.mouse.move(1, 89);
    await page.evaluate(() => document.getElementById('card').dispatchEvent(new MouseEvent('mouseleave')));
    await page.clock.runFor(1400);
    assert.deepEqual(await sent('overlay:pick'), [], 'not yet');
    await page.clock.runFor(200);
    assert.deepEqual(await sent('overlay:pick'), [{ kind: 'zoom', refocus: false }], 'closed by itself after 1.5 s');
    // From the keyboard it doesn't close by itself; arrows move, Esc closes.
    await page.evaluate(() => window.__emit('overlay-data', { kind: 'zoom', percent: 125, auto: false, focus: true }));
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Zoom out');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Zoom in');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('tab:zoom')).at(-1), 1);
    // Re-shown at the new level, the keyboard stays on +.
    await page.evaluate(() => window.__emit('overlay-data', { kind: 'zoom', percent: 150, auto: false }));
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Zoom in');
    await page.keyboard.press('Escape');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'zoom', refocus: true });
    const [fg, bg] = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.zoom-pct')); return [c.color, getComputedStyle(document.getElementById('card')).backgroundColor]; });
    const rgb = (c) => c.match(/\d+/g).slice(0, 3).map(Number);
    assert.ok(contrast(rgb(fg), rgb(bg)) >= 4.5, `${colorScheme}: ${fg} on ${bg}`);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `zoom-bubble-${colorScheme}.png`) });
    await page.close();
    assert.deepEqual(errors, []);
  }
});
