// In headless Chrome with a stand-in for the browser: the "Press Esc to exit
// full screen" bubble (renderer/ui/notice.html), the credits page
// (renderer/pages/credits.html), Chromium's notices restyled for Lumio, and
// the legal links in Settings › About. What they show, the keyboard, light
// and dark. Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');
const { electronFile, chromiumCreditsHtml } = require('../main/credits.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

// The start of Chromium's notices file, cut after its first project.
function chromiumSample() {
  const file = electronFile('LICENSES.chromium.html');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(200_000);
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const first = text.indexOf('<div class="product">');
  const second = text.indexOf('<div class="product">', first + 10);
  return chromiumCreditsHtml(text.slice(0, second) + '</div>\n</body>\n</html>\n');
}

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  const sample = chromiumSample();
  server = http.createServer((req, res) => {
    // /ui/... is the notice view, /pages/... Lumio's pages; /assets/... is shared.
    const [, area, rest] = req.url.match(/^\/(ui|pages)(\/.*)$/) || [null, 'ui', req.url];
    const url = new URL(`lumio://${area === 'ui' ? 'notice' : 'credits'}${rest}`);
    let body;
    let type = 'text/html';
    if (url.pathname === '/chromium-sample.html') body = sample;
    else {
      const file = resolveFile(url, area === 'ui' ? new Set(['notice']) : PAGE_HOSTS);
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      body = fs.readFileSync(file);
      type = MIME[path.extname(file)] || 'application/octet-stream';
    }
    if (type === 'text/html' && url.searchParams.get('appearance') === 'dark') body = String(body).replace(/<html\b/i, '<html data-appearance="dark"');
    res.writeHead(200, { 'content-type': type, 'content-security-policy': CSP });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

async function open(url, { colorScheme = 'light', viewport = { width: 1000, height: 760 }, init } = {}) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  if (init) await page.addInitScript(init.fn, init.arg);
  await page.goto(base + url);
  return { page, errors };
}

// ---------------------------------------------------------------- the notice
// The notice view with a stand-in main process: __emit(data) shows it, __sent records what it says back.
const openNotice = async (opts = {}) => {
  const r = await open(`/ui/${opts.query || ''}`, {
    ...opts,
    viewport: { width: 640, height: 80 },
    init: {
      fn: () => {
        const handlers = {};
        window.__sent = [];
        window.__emit = (d) => (handlers['notice-data'] || []).forEach((fn) => fn(d));
        window.lumio = { send: (c, p) => window.__sent.push([c, p]), on: (c, fn) => { (handlers[c] ||= []).push(fn); return () => {}; }, invoke: async () => null };
      },
    },
  });
  await r.page.waitForFunction(() => typeof window.__emit === 'function' && document.readyState === 'complete');
  await r.page.waitForTimeout(50);
  return r;
};

test('the full-screen bubble: the site, "Press Esc to exit full screen", its size for the view, fading after four seconds', { skip }, async () => {
  const { page, errors } = await openNotice();
  assert.equal(await page.isVisible('#bubble'), false, 'nothing until a page goes full screen');
  await page.evaluate(() => window.__emit({ title: 'video.example is now full screen', action: 'exit full screen' }));
  assert.equal(await page.isVisible('#bubble'), true);
  assert.equal(await page.getAttribute('#bubble', 'role'), 'status', 'read out by screen readers');
  assert.equal((await page.textContent('#bubble')).replace(/\s+/g, ' ').trim(), 'video.example is now full screen Press Esc to exit full screen');
  assert.equal(await page.textContent('kbd'), 'Esc');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('n-action'), '::before').content), '"·"');
  // It tells main how big it is, so the view fits it.
  // (Its first report can come before the font loads; the last one must match.)
  await page.evaluate(() => document.fonts.ready);
  const box = await page.evaluate(() => { const r = document.getElementById('bubble').getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; });
  await page.waitForFunction((b) => { const s = window.__sent.at(-1); return s && s[1].width === b.width && s[1].height === b.height; }, box, { timeout: 2000 }).catch(() => {});
  const [channel, size] = await page.evaluate(() => window.__sent.at(-1));
  assert.equal(channel, 'notice:size');
  assert.deepEqual(size, box);
  assert.ok(box.width > 300 && box.height < 60, `one line (${box.width}×${box.height})`);
  const anim = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('bubble')); return [s.animationName, s.animationDelay]; });
  assert.deepEqual(anim, ['in, out', '0s, 4s']);

  // The cursor only: no site, no dot. Words from a page are only ever text.
  await page.evaluate(() => window.__emit({ title: '', action: 'show your cursor' }));
  assert.equal((await page.textContent('#bubble')).replace(/\s+/g, ' ').trim(), 'Press Esc to show your cursor');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('n-action'), '::before').content), 'none');
  await page.evaluate(() => window.__emit({ title: '<b>x</b>.example is now full screen', action: 'exit full screen' }));
  assert.equal(await page.$$eval('#bubble b', (els) => els.length), 0);
  await page.evaluate(() => window.__emit(null));
  assert.equal(await page.isVisible('#bubble'), false);
  assert.deepEqual(errors, []);
  await page.close();
});

for (const scheme of ['light', 'dark']) {
  test(`the full-screen bubble in ${scheme}: ${scheme} colors, readable words`, { skip }, async () => {
    const { page, errors } = await openNotice({ colorScheme: scheme });
    await page.evaluate(() => window.__emit({ title: 'video.example is now full screen', action: 'exit full screen' }));
    const c = await readColors(page, { tokens: ['--text-strong', '--text-soft'], parts: ['#bubble'] });
    const bg = c.parts['#bubble'];
    assert.ok(scheme === 'light' ? luminance(bg) > 0.8 : luminance(bg) < 0.05, `bubble is ${scheme} (rgb ${bg})`);
    for (const t of ['--text-strong', '--text-soft']) assert.ok(contrast(c.tokens[t], bg) >= 4.5, `${t}: ${contrast(c.tokens[t], bg).toFixed(2)}:1`);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `notice-${scheme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  });
}

// The view is only a little bigger than the bubble (it covers the page under
// it): a shadow reaching past its edge was cut off, a gray box on a light page.
test('the bubble’s shadow ends inside its view, on every side', { skip }, async () => {
  const { PAD } = require('../main/access-notice.js');
  const { page } = await openNotice();
  await page.evaluate(() => window.__emit({ title: 'video.example is now full screen', action: 'exit full screen' }));
  const { top, shadows } = await page.evaluate(() => {
    const b = document.getElementById('bubble');
    b.style.animation = 'none'; // where it rests, not where it slides in from
    const list = getComputedStyle(b).boxShadow.split(/,(?![^(]*\))/);
    return { top: b.getBoundingClientRect().top, shadows: list.map((s) => (s.match(/-?[\d.]+px/g) || []).map(parseFloat)) };
  });
  assert.equal(top, PAD.top, 'the bubble sits where main leaves room above it');
  for (const [x = 0, y = 0, blur = 0, spread = 0] of shadows) {
    const reach = blur + spread;
    assert.ok(reach - y <= PAD.top && reach + y <= PAD.bottom && reach + Math.abs(x) <= PAD.x, `shadow ${[x, y, blur, spread]} fits in ${JSON.stringify(PAD)}`);
  }
  await page.close();
});

test('an incognito window’s bubble is dark on a light computer', { skip }, async () => {
  const { page } = await openNotice({ query: '?appearance=dark' });
  await page.evaluate(() => window.__emit({ title: '', action: 'show your cursor' }));
  const c = await readColors(page, { parts: ['#bubble'] });
  assert.ok(luminance(c.parts['#bubble']) < 0.05);
  await page.close();
});

// ---------------------------------------------------------------- credits
const CREDITS = {
  version: '0.6.7', license: 'GPL-3.0-or-later', source: 'https://github.com/juaniRD23/lumio-browser', licenseText: 'GNU GENERAL PUBLIC LICENSE\nVersion 3',
  chromium: { version: '150.0.1', available: true },
  electron: { version: '43.7.7', license: 'MIT', url: 'https://www.electronjs.org/', text: 'Copyright (c) Electron contributors' },
  packages: [
    { name: 'debug', version: '4.4.3', license: 'MIT', url: 'https://github.com/debug-js/debug', text: 'The MIT License' },
    { name: '<img src=x onerror="window.hacked=1">', version: '1.0.0', license: 'MIT', url: '', text: '<b>not bold</b>' },
    { name: 'electron-chrome-web-store', version: '0.13.0', license: 'MIT', url: 'https://github.com/samuelmaddock/electron-browser-shell', text: '' },
  ],
  bundled: [{ name: 'PDF.js', license: 'Apache-2.0', url: 'https://mozilla.github.io/pdf.js/' }],
  terms: 'https://lumio.example/terms', privacy: 'https://lumio.example/privacy',
};
const openCredits = (opts = {}) => open(`/pages/credits.html${opts.query || ''}`, {
  ...opts,
  init: { fn: (answer) => { window.__calls = []; window.lumioPage = { invoke: async (c) => { window.__calls.push(c); return c === 'page:credits' ? answer : null; }, on() {} }; }, arg: CREDITS },
}).then(async (r) => { await r.page.waitForSelector('#packages > *'); return r; });

test('credits: the legal links, Lumio’s license, Chromium and Electron, every package and file, licenses that open from the keyboard', { skip }, async () => {
  const { page, errors } = await openCredits();
  assert.equal(await page.title(), 'Credits');
  assert.deepEqual(await page.$$eval('.links a', (els) => els.map((a) => [a.textContent, a.href, a.target, a.hidden])), [
    ['Terms of Service', 'https://lumio.example/terms', '_blank', false],
    ['Privacy Policy', 'https://lumio.example/privacy', '_blank', false],
    ['Source code', 'https://github.com/juaniRD23/lumio-browser', '_blank', false],
  ]);
  assert.equal(await page.textContent('#lumio .name'), 'Lumio Browser');
  assert.equal(await page.textContent('#lumio .lic'), 'GPL-3.0-or-later');
  assert.deepEqual(await page.$$eval('#engine > *', (els) => els.map((e) => e.querySelector('.name').textContent)), ['Chromium', 'Electron']);
  assert.equal(await page.getAttribute('#engine .plain a', 'href'), 'chromium.html', 'Chromium’s own list, in the same tab');
  assert.equal(await page.textContent('#engine .plain .lic'), 'BSD-3-Clause and others');
  assert.equal(await page.$$eval('#packages > details', (els) => els.length), 2, 'packages with a license text open to it');
  assert.equal(await page.$$eval('#packages > .plain a', (els) => els.map((a) => a.textContent).join()), 'Website', 'one without shows its website');
  assert.equal(await page.$$eval('#bundled > .plain', (els) => els.length), 1);
  // Names and texts from packages are only text.
  assert.equal(await page.$$eval('#packages img, #packages b', (els) => els.length), 0);
  assert.equal(await page.evaluate(() => window.hacked), undefined);

  // The keyboard: Tab to a package, Enter opens its license, which scrolls from the keyboard too.
  const first = page.locator('#packages summary').first();
  await first.focus();
  assert.equal(await page.isVisible('#packages details pre'), false);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.querySelector('#packages details').open), true);
  assert.equal(await page.textContent('#packages details pre'), 'The MIT License');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'PRE');
  await first.focus();
  await page.keyboard.press(' ');
  assert.equal(await page.evaluate(() => document.querySelector('#packages details').open), false, 'Space closes it');
  assert.deepEqual(errors, []);
  await page.close();
});

for (const scheme of ['light', 'dark']) {
  test(`credits in ${scheme}: ${scheme} cards, readable names, versions and licenses`, { skip }, async () => {
    const { page, errors } = await openCredits({ colorScheme: scheme });
    await page.evaluate(() => { document.querySelector('#packages details').open = true; });
    const c = await readColors(page, { tokens: ['--text', '--dim', '--label', '--accent'], parts: ['.card', 'pre'] });
    const card = c.parts['.card'];
    assert.ok(scheme === 'light' ? luminance(card) > 0.8 : luminance(card) < 0.05, `card is ${scheme} (rgb ${card})`);
    for (const t of ['--text', '--dim', '--label', '--accent']) assert.ok(contrast(c.tokens[t], card) >= 4.5, `${t} on a card: ${contrast(c.tokens[t], card).toFixed(2)}:1`);
    assert.ok(contrast(c.tokens['--dim'], c.parts.pre) >= 4.5, 'license text');
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `credits-${scheme}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('Chromium’s notices: no stylesheets the page can’t load, every license shown, in Lumio’s light and dark', { skip }, async () => {
  for (const scheme of ['light', 'dark']) {
    const { page, errors } = await open('/pages/chromium-sample.html', { colorScheme: scheme });
    assert.equal(await page.title(), 'Credits');
    assert.equal(await page.isVisible('.page-title'), true);
    assert.equal(await page.isVisible('.show'), false, 'chrome://credits’ show/hide toggles need its script');
    assert.equal(await page.isVisible('.product .license pre'), true);
    const c = await readColors(page, { tokens: ['--text', '--dim'], parts: ['body', '.license pre'] });
    assert.ok(scheme === 'light' ? luminance(c.parts.body) > 0.7 : luminance(c.parts.body) < 0.05, `${scheme} page`);
    assert.ok(contrast(c.tokens['--dim'], c.parts['.license pre']) >= 4.5);
    assert.deepEqual(errors, [], 'nothing blocked');
    await page.close();
  }
});

// ---------------------------------------------------------------- Settings › About
test('Settings › About links to the Terms, the Privacy Policy (on Lumio’s website) and the open-source licenses', { skip }, async () => {
  const { page, errors } = await open('/pages/settings.html#about', {
    init: {
      fn: () => {
        const answers = {
          'page:settings': { account: { signedIn: false }, profile: {}, platform: 'darwin', engines: [], ai: {}, version: '0.6.7', update: null, importSources: [], sitePermissions: [], legal: { terms: 'https://lumio.example/terms', privacy: 'https://lumio.example/privacy' } },
          'page:schedules': { tasks: [], signedIn: false },
          'page:sync': { on: false, types: {}, requests: [] },
        };
        window.lumioPage = { invoke: async (c) => answers[c] ?? null, on() {} };
      },
    },
  });
  await page.waitForFunction(() => document.getElementById('legal-privacy').href);
  assert.deepEqual(await page.$$eval('.legal a', (els) => els.map((a) => [a.textContent, a.getAttribute('href'), a.target])), [
    ['Terms of Service', 'https://lumio.example/terms', '_blank'],
    ['Privacy Policy', 'https://lumio.example/privacy', '_blank'],
    ['Open-source licenses', 'lumio://credits/', '_blank'],
  ]);
  assert.deepEqual(errors, []);
  await page.close();
});
