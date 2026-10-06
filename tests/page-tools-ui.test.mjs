// The page tools' UI in headless Chrome, with a stand-in for the main
// process: the Share button and media button in the window
// (renderer/ui/share.js, media.js), their popovers and the Install app
// dialog in the overlay (overlay-share.js, overlay-media.js), the QR code,
// the screenshot view (screenshot.html), an installed app's title bar
// (app-window.html) and lumio://apps; the keyboard, light and dark.
// Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contrast } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const SHOTS = process.env.LUMIO_SHOTS;

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'medium', name: 'Medium' }], mode: 'ask', running: false };
const tab = (url, extra = {}) => ({ id: 1, title: 'A story', url, loading: false, canGoBack: false, canGoForward: false, pinned: false, ...extra });
const INIT = {
  tabs: { activeId: 1, tabs: [tab('https://news.example/story')] }, downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, email: 't@lumio.test', plan: 'free' }, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
const DEVICES = [{ id: 'pc', name: 'Office PC', platform: 'windows', lastSeen: Date.now() - 5 * 60_000 }, { id: 'air', name: 'MacBook Air', platform: 'mac', lastSeen: Date.now() }];
const SHARE = {
  kind: 'share', tabId: 1, view: 'main', url: 'https://news.example/story', title: 'A story', host: 'news.example', favicon: null, web: null,
  devices: DEVICES, native: true, page: { screenshot: true, save: true, apps: true },
};
const MEDIA = [
  { tabId: 1, windowId: 1, title: 'Song', artist: 'Band', host: 'music.example', favicon: null, artwork: null, playing: true, canPrev: false, canNext: true, duration: 245, time: 61, canSeek: true, pip: false, canPip: false, current: true },
  { tabId: 2, windowId: 1, title: 'A video', artist: '', host: 'video.example', favicon: null, artwork: null, playing: false, canPrev: false, canNext: false, duration: null, time: null, canSeek: false, pip: true, canPip: true, current: false },
];
const APPS = [
  { id: 'a1', name: 'Example Mail', url: 'https://mail.example/', host: 'mail.example', window: true, created: Date.UTC(2026, 8, 1), icon: null, launcher: true },
  { id: 'a2', name: 'Docs', url: 'https://docs.example/d/1', host: 'docs.example', window: false, created: Date.UTC(2026, 8, 2), icon: null, launcher: false },
];

// One server per lumio:// host, like the app serves them.
const servers = [];
const bases = {};
let browser;
before(async () => {
  if (!CHROME) return;
  for (const host of ['shell', 'overlay', 'apps']) {
    const server = http.createServer((req, res) => {
      const file = resolveFile(new URL(`lumio://${host}${req.url}`), host === 'apps' ? PAGE_HOSTS : new Set([host]));
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

// A page with a stand-in main process: window.__sent and __calls record what
// it sent and asked; window.__emit(channel, payload) plays a message from main.
async function open(host, { file = '', colorScheme = 'light', answers = {}, viewport, reducedMotion } = {}) {
  const sizes = { shell: { width: 1300, height: 800 }, overlay: { width: 380, height: 560 }, apps: { width: 1000, height: 700 } };
  const page = await browser.newPage({ viewport: viewport || sizes[host], colorScheme, reducedMotion });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ init, ai, extra }) => {
    const handlers = {};
    window.__sent = [];
    window.__calls = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answers = { 'shell:init': init, 'ai:state': ai, 'ai:chats': [], 'ai:connections': { apps: [] }, ...extra };
    const bridge = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return structuredClone(answers[channel] ?? null); },
      send: (channel, payload) => window.__sent.push([channel, payload]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
    window.lumio = bridge;
    window.lumioPage = bridge; // lumio://apps
  }, { init: INIT, ai: AI, extra: answers });
  await page.goto(`${bases[host]}/${file}`);
  return { page, errors };
}
const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const calls = (page, channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map(([, ...a]) => a), channel);
const show = (page, payload) => page.evaluate((p) => {
  // The overlay's steps (main/window.js): a new kind is shown, then comes in;
  // the same kind again is new content for it.
  if (window.__shownKind === p.kind) { window.__emit('overlay-data', p); return; }
  window.__shownKind = p.kind;
  window.__seq = (window.__seq || 0) + 1;
  window.__emit('overlay-data', { ...p, op: 'show', seq: window.__seq });
  window.__emit('overlay-data', { op: 'in', seq: window.__seq });
}, payload);
// Colors as they end up on screen: [r, g, b] for each selector's text, and the card behind.
const colorsOf = (page, parts, behind = '#card') => page.evaluate(({ parts, behind }) => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const paint = (...cs) => { ctx.clearRect(0, 0, 1, 1); for (const c of cs) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); } return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
  const layers = (el) => { const out = []; for (; el; el = el.parentElement) out.unshift(getComputedStyle(el).backgroundColor); return out; };
  const out = { bg: paint(getComputedStyle(document.body).backgroundColor, ...layers(document.querySelector(behind))) };
  for (const p of parts) out[p] = paint(getComputedStyle(document.querySelector(p)).color);
  return out;
}, { parts, behind });

// ---------------------------------------------------------------- the window's buttons
test('the Share button: web pages only, opens the popover from it, and websites can open it', { skip }, async () => {
  const { page, errors } = await open('shell', { answers: { 'share:info': SHARE, 'media:state': { count: 0, playing: false } } });
  await page.waitForSelector('#share-btn:not([hidden])');
  assert.equal(await page.getAttribute('#share-btn', 'aria-label'), 'Share this page');
  await page.click('#share-btn');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:show'));
  const [info] = await calls(page, 'share:info');
  assert.equal(info[0].tabId, 1);
  assert.ok(Number.isFinite(info[0].anchor.x), 'where the Mac share sheet appears');
  const [shown] = await sent(page, 'overlay:show');
  assert.equal(shown.payload.kind, 'share');
  assert.equal(shown.payload.focus, false);
  const btn = await page.$eval('#share-btn', (b) => b.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(shown.rect.y - (btn.bottom + 8)) < 2 && shown.rect.x + shown.rect.width > btn.left, 'hangs from the button');
  assert.equal(await page.getAttribute('#share-btn', 'aria-expanded'), 'true');
  await page.click('#share-btn');
  assert.deepEqual((await sent(page, 'overlay:hide')).at(-1), 'share');
  // From a menu or a website's Share button: the keyboard goes to the popover; Esc gives it back.
  await page.evaluate(() => window.__emit('share-open', { tabId: 1, view: 'qr' }));
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'share:focus'));
  assert.equal((await sent(page, 'overlay:show')).at(-1).payload.focus, true);
  assert.equal((await calls(page, 'share:info')).at(-1)[0].view, 'qr');
  await page.evaluate(() => window.__emit('overlay-picked', { kind: 'share', refocus: true }));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'share-btn');
  // Lumio's own pages have nothing to share.
  await page.evaluate(() => window.__emit('tabs', { activeId: 2, tabs: [{ id: 2, title: 'New Tab', url: '', internal: true }] }));
  // (The address bar's buttons ease out of their slot: batch 3's motion.)
  assert.equal(await page.$eval('#share-btn', (b) => b.hidden), true);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#share-btn')).display === 'none');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the media button shows while something can be controlled, with moving bars while it plays', { skip }, async () => {
  const { page, errors } = await open('shell', { answers: { 'media:state': { count: 0, playing: false }, 'media:list': MEDIA } });
  await page.waitForTimeout(100);
  assert.equal(await page.isVisible('#media-btn'), false);
  await page.evaluate(() => window.__emit('media', { count: 2, playing: true }));
  assert.equal(await page.isVisible('#media-btn'), true);
  assert.equal(await page.$eval('#media-btn', (b) => b.classList.contains('playing')), true);
  assert.equal(await page.$eval('#media-btn .eq i', (i) => getComputedStyle(i).animationName), 'eq');
  await page.click('#media-btn');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:show' && p.payload.kind === 'media'));
  const shown = (await sent(page, 'overlay:show')).at(-1);
  assert.deepEqual(shown.payload.items.map((i) => i.title), ['Song', 'A video']);
  assert.equal(await page.getAttribute('#media-btn', 'aria-expanded'), 'true');
  // Esc closes it; nothing left to control closes it and hides the button.
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent(page, 'overlay:hide')).at(-1), 'media');
  await page.click('#media-btn');
  await page.evaluate(() => window.__emit('media', { count: 0, playing: false }));
  assert.equal(await page.isVisible('#media-btn'), false);
  assert.deepEqual((await sent(page, 'overlay:hide')).at(-1), 'media');
  assert.deepEqual(errors, []);
  await page.close();
  // Reduced motion: the bars stand still.
  const still = await open('shell', { reducedMotion: 'reduce', answers: { 'media:state': { count: 1, playing: true } } });
  await still.page.waitForSelector('#media-btn.playing');
  assert.equal(await still.page.$eval('#media-btn .eq i', (i) => getComputedStyle(i).animationName), 'none');
  await still.page.close();
});

// ---------------------------------------------------------------- the Share popover
test('the Share popover: its choices, the keyboard, and what each one asks for', { skip }, async () => {
  const { page, errors } = await open('overlay');
  await show(page, { ...SHARE, focus: true });
  const rows = await page.$$eval('.sh-list .sh-row .t', (els) => els.map((e) => e.textContent));
  assert.deepEqual(rows, ['Copy link', 'QR code', 'Send to your devices', 'Screenshot', 'Save page as…', 'Install page as app…', 'Create shortcut…', 'More…']);
  assert.equal(await page.textContent('.sh-title'), 'A story');
  assert.equal(await page.textContent('.sh-url'), 'news.example/story');
  assert.equal(await page.getAttribute('.sh', 'role'), 'dialog');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Copy link');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Send to your devices');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.deepEqual((await sent(page, 'share:action')).at(-1), { tabId: 1, url: 'https://news.example/story', title: 'A story', action: 'copy' });
  await page.click('text=Install page as app…');
  assert.equal((await sent(page, 'share:action')).at(-1).action, 'install');
  // Send to your devices: the person's other computers.
  await page.click('text=Send to your devices');
  assert.deepEqual(await page.$$eval('.dev b', (els) => els.map((e) => e.textContent)), ['Office PC', 'MacBook Air']);
  assert.deepEqual(await page.$$eval('.dev small', (els) => els.map((e) => e.textContent)), ['Active 5 min ago', 'Active now']);
  await page.click('text=MacBook Air');
  assert.deepEqual((await sent(page, 'share:action')).at(-1), { tabId: 1, url: 'https://news.example/story', title: 'A story', action: 'send', deviceId: 'air' });
  // Esc goes back, then closes and gives the keyboard back to the window.
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('.sh-list .sh-row >> text=Copy link'), true);
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent(page, 'overlay:pick')).at(-1), { kind: 'share', refocus: true });
  assert.equal((await sent(page, 'share:refocus')).length, 1);
  // Without Lumio Sync or on Windows: no Send, no More….
  await show(page, { ...SHARE, devices: null, native: false });
  assert.deepEqual(await page.$$eval('.sh-list .sh-row .t', (els) => els.map((e) => e.textContent)), ['Copy link', 'QR code', 'Screenshot', 'Save page as…', 'Install page as app…', 'Create shortcut…']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a website’s share: what it asks for, and just Copy and the system’s share sheet', { skip }, async () => {
  const { page, errors } = await open('overlay');
  await show(page, { ...SHARE, title: 'Read this', url: 'https://news.example/next', page: null, web: { title: 'Read this', text: 'So good', url: 'https://news.example/next', host: 'news.example' } });
  assert.match(await page.textContent('.sh-web'), /^news\.example wants to share/);
  assert.equal(await page.textContent('.sh-web q'), 'So good');
  assert.deepEqual(await page.$$eval('.sh-list .sh-row .t', (els) => els.map((e) => e.textContent)), ['Copy link', 'QR code', 'Send to your devices', 'More…']);
  // Text only.
  await show(page, { ...SHARE, title: 'Quote', url: '', host: '', page: null, devices: null, web: { title: 'Quote', text: 'To be', url: '', host: 'news.example' } });
  assert.deepEqual(await page.$$eval('.sh-list .sh-row .t', (els) => els.map((e) => e.textContent)), ['Copy text', 'More…']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the QR code: made here, scannable modules around Lumio’s mark, Copy and Download', { skip }, async () => {
  const { page, errors } = await open('overlay');
  await show(page, { ...SHARE, view: 'qr', focus: true });
  assert.equal(await page.getAttribute('canvas.qr', 'aria-label'), 'QR code for news.example/story');
  // Every module outside the mark is drawn where the encoder put it, on a white quiet zone.
  const check = await page.evaluate(async () => {
    const { qrMatrix } = await import('/assets/qr.js');
    const c = document.querySelector('canvas.qr');
    const m = qrMatrix('https://news.example/story', { ecc: 'Q' });
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const n = m.size + 8;
    const k = c.width / n;
    const dark = (x, y) => px[(Math.floor((y + 4.5) * k) * c.width + Math.floor((x + 4.5) * k)) * 4] < 128;
    const box = Math.round(m.size * 0.22) / 2 + 0.5;
    let wrong = 0;
    let covered = 0;
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        if (Math.abs(x - (m.size - 1) / 2) < box && Math.abs(y - (m.size - 1) / 2) < box) { covered++; continue; }
        if (dark(x, y) !== m.modules[y][x]) wrong++;
      }
    }
    return { wrong, covered, total: m.size * m.size, ecc: m.ecc, width: c.width, height: c.height, quiet: px[0] === 255 && px[1] === 255 && px[2] === 255 };
  });
  assert.equal(check.wrong, 0);
  assert.ok(['Q', 'H'].includes(check.ecc), 'enough error correction for the mark');
  assert.ok(check.covered / check.total < 0.08, `the mark covers ${(100 * check.covered / check.total).toFixed(1)}% of the modules`);
  assert.equal(check.width, check.height);
  assert.ok(check.width >= 400);
  assert.ok(check.quiet);
  // Copy and Download send the picture itself, as a PNG.
  await page.click('[data-act="qr-copy"]');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'share:action' && p.action === 'qr-copy'));
  const copy = await page.evaluate(() => { const p = window.__sent.find(([c, x]) => c === 'share:action' && x.action === 'qr-copy')[1]; return { sig: [...p.png.slice(1, 4)].map((b) => String.fromCharCode(b)).join(''), size: p.png.length, name: p.name }; });
  assert.equal(copy.sig, 'PNG');
  assert.ok(copy.size > 500);
  assert.equal(copy.name, 'QR code news.example');
  await page.click('[data-act="qr-save"]');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'share:action' && p.action === 'qr-save'));
  // A link too long for a QR code says so.
  await show(page, { ...SHARE, view: 'qr', url: `https://long.example/${'x'.repeat(3000)}` });
  assert.equal(await page.isVisible('.qr-err'), true);
  assert.equal(await page.isDisabled('[data-act="qr-copy"]'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Install app and Create shortcut: name, icon, Enter and Esc', { skip }, async () => {
  const { page, errors } = await open('overlay');
  await show(page, { kind: 'install', token: 't1', shortcut: false, name: 'Example Mail', host: 'mail.example', platform: 'darwin', icon: null });
  assert.equal(await page.textContent('.ins-title'), 'Install app?');
  assert.match(await page.textContent('.ins-note'), /own window, without tabs\. Lumio adds it to Applications › Lumio Apps/);
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['ins-name', 0, 12]);
  // No icon from the site: a letter tile.
  assert.equal(await page.$eval('canvas.ins-icon', (c) => c.width), 128);
  await page.keyboard.type('My Mail');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'apps:install'));
  const sentInstall = await page.evaluate(() => { const p = window.__sent.find(([c]) => c === 'apps:install')[1]; return { ...p, iconPng: p.iconPng && p.iconPng.length > 100 }; });
  assert.deepEqual(sentInstall, { token: 't1', name: 'My Mail', window: true, iconPng: true });
  // Create shortcut: Open as window is a choice; Esc closes it.
  await show(page, { kind: 'install', token: 't2', shortcut: true, name: 'Inbox', host: 'mail.example', platform: 'linux', icon: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(await page.textContent('.ins-title'), 'Create shortcut?');
  assert.match(await page.textContent('.ins-note'), /It opens this page\. Find it later in Lumio’s Apps page\./);
  assert.equal(await page.isChecked('#ins-window'), true);
  await page.click('#ins-window');
  await page.click('[data-act="install"]');
  assert.deepEqual(await page.evaluate(() => window.__sent.filter(([c]) => c === 'apps:install').at(-1)[1]), { token: 't2', name: 'Inbox', window: false, iconPng: null });
  await page.focus('#ins-name');
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent(page, 'overlay:pick')).at(-1), { kind: 'install', refocus: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('the media popover: what’s playing, its controls, seeking and Go to tab', { skip }, async () => {
  const { page, errors } = await open('overlay', { answers: { 'media:list': MEDIA, 'media:action': true } });
  await show(page, { kind: 'media', items: MEDIA, focus: true });
  assert.deepEqual(await page.$$eval('.mh-meta b', (els) => els.map((e) => e.textContent)), ['Song', 'A video']);
  assert.deepEqual(await page.$$eval('.mh-meta span', (els) => els.map((e) => e.textContent)), ['Band · music.example', 'video.example']);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Pause', 'the keyboard starts on Play/Pause');
  const first = '[data-tab="1"]';
  assert.equal(await page.isDisabled(`${first} [data-act="prev"]`), true);
  assert.equal(await page.isDisabled(`${first} [data-act="next"]`), false);
  assert.equal(await page.getAttribute(`${first} input[type=range]`, 'aria-valuetext'), '1:01 of 4:05');
  assert.equal(await page.isVisible(`${first} [data-act="pip"]`), false, 'audio: no Picture in picture');
  assert.equal(await page.getAttribute('[data-tab="2"] [data-act="pip"]', 'aria-pressed'), 'true');
  assert.equal(await page.textContent(`${first} .mh-go`), 'This tab ');
  await page.click(`${first} .mh-play`);
  assert.deepEqual((await calls(page, 'media:action')).at(-1), [{ tabId: 1, action: 'pause' }]);
  await page.click('[data-tab="2"] .mh-go');
  assert.deepEqual((await calls(page, 'media:action')).at(-1), [{ tabId: 2, action: 'goto' }]);
  // Seeking: dragging shows the time, letting go seeks.
  await page.$eval(`${first} input[type=range]`, (r) => { r.value = '120'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await page.textContent(`${first} [data-time]`), '2:00');
  assert.deepEqual((await calls(page, 'media:action')).at(-1), [{ tabId: 1, action: 'seek', value: 120 }]);
  // It keeps itself up to date while open, keeping the keyboard where it was.
  await page.focus('[data-tab="2"] [data-act="pip"]');
  const before = (await calls(page, 'media:list')).length;
  await page.waitForFunction((n) => window.__calls.filter(([c]) => c === 'media:list').length > n, before, { timeout: 3000 });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-tab]')?.dataset.tab + ':' + document.activeElement.dataset.act), '2:pip');
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent(page, 'overlay:pick')).at(-1), { kind: 'media', refocus: true });
  // Nothing left.
  await show(page, { kind: 'media', items: [] });
  assert.equal(await page.textContent('.mh-empty'), 'Nothing is playing.');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the popovers are readable in light and dark', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open('overlay', { colorScheme });
    await show(page, SHARE);
    let c = await colorsOf(page, ['.sh-title', '.sh-url', '.sh-row .t']);
    for (const part of ['.sh-title', '.sh-url', '.sh-row .t']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${colorScheme}: share ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `share-${colorScheme}.png`) });
    await show(page, { kind: 'media', items: MEDIA });
    c = await colorsOf(page, ['.mh-meta b', '.mh-meta span', '.mh-t'], '.mh-item');
    for (const part of ['.mh-meta b', '.mh-meta span', '.mh-t']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${colorScheme}: media ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `media-${colorScheme}.png`) });
    await show(page, { kind: 'install', token: 't', shortcut: true, name: 'Mail', host: 'mail.example', platform: 'darwin', icon: null });
    c = await colorsOf(page, ['.ins-title', '.ins-host', '.ins-note']);
    for (const part of ['.ins-title', '.ins-host', '.ins-note']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${colorScheme}: install ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// ---------------------------------------------------------------- the screenshot view
// A picture of a "page", sent like main/screenshot.js sends it.
const sendShot = (page) => page.evaluate(async () => {
  const c = new OffscreenCanvas(760, 500);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 760, 500);
  x.fillStyle = '#336699';
  x.fillRect(100, 100, 300, 200);
  const blob = await c.convertToBlob({ type: 'image/png' });
  window.__emit('shot-data', { png: new Uint8Array(await blob.arrayBuffer()), width: 760, height: 500, scale: 1, title: 'A page', host: 'news.example' });
});
const shotSize = async (page, channel) => page.evaluate(async (ch) => {
  const png = window.__calls.filter(([c]) => c === ch).at(-1)[1];
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  return [bmp.width, bmp.height];
}, channel);

test('Screenshot: drag over an area, then mark it up; it’s copied right away', { skip }, async () => {
  const { page, errors } = await open('overlay', { file: 'screenshot.html', viewport: { width: 760, height: 500 }, answers: { 'shot:copy': true, 'shot:save': { ok: true } } });
  await sendShot(page);
  await page.waitForSelector('#pick:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'visible');
  assert.equal(await page.title(), 'Screenshot of news.example');
  // A click isn't a drag; a drag picks the area.
  await page.mouse.click(300, 300);
  assert.equal(await page.isVisible('#edit'), false);
  await page.mouse.move(100, 120);
  await page.mouse.down();
  await page.mouse.move(250, 200, { steps: 4 });
  await page.mouse.move(300, 270, { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'shot:copy'));
  assert.deepEqual(await shotSize(page, 'shot:copy'), [200, 150]);
  assert.equal(await page.textContent('#status'), 'Copied to the clipboard');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'copy');
  // Tools are a radio group: arrows move, the keys P H A T pick.
  assert.equal(await page.getAttribute('[data-tool="pen"]', 'aria-checked'), 'true');
  await page.focus('[data-tool="pen"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('[data-tool="marker"]', 'aria-checked'), 'true');
  await page.keyboard.press('p');
  assert.equal(await page.getAttribute('[data-tool="pen"]', 'aria-checked'), 'true');
  // The pen draws in red; undo takes it back.
  const pixel = () => page.evaluate(() => { const c = document.getElementById('canvas'); const r = c.getBoundingClientRect(); const k = c.width / r.width; return [...c.getContext('2d').getImageData(Math.round(60 * k), Math.round(20 * k), 1, 1).data.slice(0, 3)]; });
  const box = await page.$eval('#canvas', (c) => c.getBoundingClientRect().toJSON());
  const blank = await pixel();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 20, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await pixel(), [255, 59, 48]);
  assert.equal(await page.isDisabled('[data-act="undo"]'), false);
  await page.keyboard.press('Meta+z');
  assert.deepEqual(await pixel(), blank);
  // Text: typed where you click, put in the picture with Enter.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 30, box.y + 80);
  await page.waitForSelector('textarea.text-box');
  await page.keyboard.type('Look');
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('textarea.text-box'), false);
  assert.equal(await page.isDisabled('[data-act="undo"]'), false);
  // Copy, Download and Ask Lumio send the marked-up picture.
  await page.click('[data-act="save"]');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'shot:save'));
  assert.equal(await page.textContent('#status'), 'Saved');
  await page.click('[data-act="ask"]');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'shot:ask'));
  await page.keyboard.press('Escape');
  assert.equal((await sent(page, 'shot:close')).length, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Screenshot: the visible area, and the whole page (cut when it’s very long)', { skip }, async () => {
  const full = { png: null, width: 760, height: 1500, scale: 1, clipped: true };
  const { page, errors } = await open('overlay', { file: 'screenshot.html', viewport: { width: 760, height: 500 }, answers: { 'shot:copy': true, 'shot:full': full } });
  await sendShot(page);
  await page.waitForSelector('#pick:not([hidden])');
  await page.keyboard.press('Enter'); // the visible area
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'shot:copy'));
  assert.deepEqual(await shotSize(page, 'shot:copy'), [760, 500]);
  // Full page: the picture main makes.
  await sendShot(page);
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(760, 1500);
    c.getContext('2d').fillRect(0, 0, 10, 10);
    window.__fullPng = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const invoke = window.lumio.invoke;
    window.lumio.invoke = async (ch, ...a) => (ch === 'shot:full' ? { png: window.__fullPng, width: 760, height: 1500, scale: 1, clipped: true } : invoke(ch, ...a));
  });
  await page.click('[data-act="full"]');
  await page.waitForSelector('#edit:not([hidden])');
  await page.waitForFunction(() => window.__calls.filter(([c]) => c === 'shot:copy').length === 2);
  assert.deepEqual(await shotSize(page, 'shot:copy'), [760, 1500]);
  assert.match(await page.textContent('#status'), /very long, so the picture stops partway down/);
  // Full page failing says why and stays on the picker.
  await sendShot(page);
  await page.evaluate(() => { window.lumio.invoke = async () => ({ error: 'Couldn’t capture the whole page. Close Developer Tools and try again, or take the visible part.' }); });
  await page.click('[data-act="full"]');
  await page.waitForFunction(() => /Close Developer Tools/.test(document.getElementById('hint').textContent));
  assert.equal(await page.isVisible('#pick'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the screenshot view is readable in light and dark', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open('overlay', { file: 'screenshot.html', colorScheme, viewport: { width: 760, height: 500 }, answers: { 'shot:copy': true } });
    await sendShot(page);
    await page.waitForSelector('#pick:not([hidden])');
    let c = await colorsOf(page, ['.hint', '.pick-bar .pill'], '.pick-bar');
    for (const part of ['.hint', '.pick-bar .pill']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${colorScheme}: ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#edit:not([hidden])');
    c = await colorsOf(page, ['#status', '.edit-bar .pill'], '.edit-bar');
    for (const part of ['#status', '.edit-bar .pill']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${colorScheme}: ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `screenshot-editor-${colorScheme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// ---------------------------------------------------------------- an installed app's window and lumio://apps
const APP_STATE = { name: 'Example Mail', title: 'Inbox', url: 'https://mail.example/inbox', host: 'mail.example', outside: false, secure: true, canGoBack: false, canGoForward: false, loading: false, icon: null, platform: 'darwin' };

test('an app’s title bar: back, reload, its title, and the way back after leaving its site', { skip }, async () => {
  const { page, errors } = await open('overlay', { file: 'app-window.html', viewport: { width: 900, height: 38 }, answers: { 'apps:state': APP_STATE } });
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Inbox');
  assert.equal(await page.title(), 'Example Mail');
  assert.equal(await page.isDisabled('[data-act="back"]'), true);
  assert.equal(await page.isVisible('#away'), false);
  assert.equal(await page.$eval('.lights', (e) => e.getBoundingClientRect().width), 70, 'room for the traffic lights');
  await page.click('[data-act="reload"]');
  assert.equal((await sent(page, 'apps:nav')).at(-1).action, 'reload');
  // Loading: Reload becomes Stop. Another site: where you are, and Back to app.
  await page.evaluate((s) => window.__emit('app-state', { ...s, loading: true, canGoBack: true, outside: true, secure: false, host: 'login.other.example', title: 'Sign in' }), APP_STATE);
  assert.equal(await page.getAttribute('[data-act="reload"]', 'aria-label'), 'Stop');
  await page.click('[data-act="reload"]');
  assert.equal((await sent(page, 'apps:nav')).at(-1).action, 'stop');
  assert.equal(await page.isVisible('#away'), true);
  assert.equal(await page.textContent('.away-host span'), 'login.other.example');
  assert.equal(await page.$eval('.away-host', (e) => e.classList.contains('insecure')), true);
  await page.click('text=Back to app');
  assert.equal((await sent(page, 'apps:nav')).at(-1).action, 'home');
  await page.click('[data-act="back"]');
  await page.click('[data-act="menu"]');
  const menu = (await sent(page, 'apps:nav')).at(-1);
  assert.equal(menu.action, 'menu');
  assert.ok(Number.isFinite(menu.x) && Number.isFinite(menu.y), 'the menu opens under its button');
  assert.deepEqual(errors, []);
  await page.close();
});

// A site in an app window gets "Save password?" like a tab (main/apps.js):
// the key in the title bar, and the same bubble, drawn by the app window's overlay.
test('an app’s title bar: "Save password?" after signing in, the key that brings it back, and toasts, in light and dark', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open('overlay', { file: 'app-window.html', colorScheme, viewport: { width: 900, height: 38 }, answers: { 'apps:state': APP_STATE } });
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Inbox');
    assert.equal(await page.isVisible('#pw-key'), false);
    const prompt = { id: 4, tabId: 1, host: 'mail.example', username: 'sam', action: 'save', length: 9 };
    await page.evaluate((p) => window.__emit('passwords-prompt', p), prompt);
    assert.equal(await page.isVisible('#pw-key'), true);
    assert.equal(await page.getAttribute('#pw-key', 'aria-label'), 'Save password');
    await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:show' && p.payload.kind === 'pwsave'));
    const shown = (await sent(page, 'overlay:show')).at(-1);
    assert.deepEqual(shown.payload.prompt, prompt);
    const key = await page.$eval('#pw-key', (e) => e.getBoundingClientRect().toJSON());
    assert.ok(shown.rect.y >= key.bottom && shown.rect.x + shown.rect.width <= key.right + 24, 'under the key');
    // The key closes it and brings it back; a click elsewhere on the bar closes it.
    await page.click('#pw-key');
    assert.deepEqual((await sent(page, 'overlay:hide')).at(-1), 'pwsave');
    await page.focus('#pw-key');
    await page.keyboard.press('Enter');
    assert.equal((await sent(page, 'overlay:show')).length, 2, 'from the keyboard too');
    await page.click('#title');
    assert.equal((await sent(page, 'overlay:hide')).length, 2);
    // Answered in the bubble: the key goes.
    await page.evaluate(() => window.__emit('overlay-picked', { kind: 'pwsave' }));
    assert.equal(await page.isVisible('#pw-key'), false);
    // "Password saved", for a moment, readable.
    await page.evaluate(() => window.__emit('toast', { text: 'Password saved' }));
    assert.equal(await page.textContent('#toast'), 'Password saved');
    assert.equal(await page.getAttribute('#toast', 'role'), 'status');
    const c = await colorsOf(page, ['#toast'], '#toast');
    assert.ok(contrast(c['#toast'], c.bg) >= 4.5, `${colorScheme}: toast ${contrast(c['#toast'], c.bg).toFixed(2)}:1`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `app-window-saved-${colorScheme}.png`) });
    await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 4000 });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('lumio://apps lists installed apps, with Open, Show in Finder and Remove', { skip }, async () => {
  const { page, errors } = await open('apps', { answers: { 'page:apps': APPS, 'page:app-remove': true } });
  await page.waitForSelector('.app');
  assert.deepEqual(await page.$$eval('.app .name', (els) => els.map((e) => e.textContent)), ['Example Mail', 'Docs']);
  assert.match(await page.textContent('.app[data-id="a1"] .sub'), /^mail\.example · Opens in its own window · Added /);
  assert.match(await page.textContent('.app[data-id="a2"] .sub'), /Opens in a tab/);
  assert.equal(await page.isVisible('.app[data-id="a1"] [data-act="reveal"]'), /Mac/.test(await page.evaluate(() => navigator.platform)));
  assert.equal(await page.isVisible('.app[data-id="a2"] [data-act="reveal"]'), false, 'no launcher to show');
  await page.click('.app[data-id="a1"] [data-act="open"]');
  assert.deepEqual((await calls(page, 'page:app-open')).at(-1), ['a1']);
  // Remove: it's gone from the list, and the page says so.
  await page.evaluate((rest) => {
    const invoke = window.lumioPage.invoke;
    window.lumioPage.invoke = async (c, ...a) => (c === 'page:apps' ? rest : invoke(c, ...a));
  }, APPS.slice(1));
  await page.click('.app[data-id="a1"] [data-act="remove"]');
  await page.waitForFunction(() => document.querySelectorAll('.app').length === 1);
  assert.equal(await page.textContent('#msg'), 'Example Mail was removed.');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove Docs', 'the keyboard stays in the list');
  assert.deepEqual(errors, []);
  await page.close();
  // No apps yet; light and dark.
  for (const colorScheme of ['light', 'dark']) {
    const empty = await open('apps', { colorScheme, answers: { 'page:apps': [] } });
    await empty.page.waitForSelector('.hero-empty');
    assert.match(await empty.page.textContent('.hero-empty'), /No apps yet/);
    const listed = await open('apps', { colorScheme, answers: { 'page:apps': APPS } });
    await listed.page.waitForSelector('.app');
    const c = await colorsOf(listed.page, ['.app .name', '.app .sub', '#how'], '.app');
    for (const part of ['.app .name', '.app .sub']) assert.ok(contrast(c[part], c.bg) >= 4.5, `${colorScheme}: ${part} ${contrast(c[part], c.bg).toFixed(2)}:1`);
    if (SHOTS) await listed.page.screenshot({ path: path.join(SHOTS, `apps-${colorScheme}.png`) });
    assert.deepEqual([...empty.errors, ...listed.errors], []);
    await empty.page.close();
    await listed.page.close();
  }
});
