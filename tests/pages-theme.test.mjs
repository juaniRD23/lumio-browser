// Lumio's own pages (renderer/pages) in light and dark: each one loads in
// headless Chrome with a stand-in for the browser, without errors, on
// colors that match the computer's appearance; incognito pages stay dark.
// Skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

// What the browser answers the pages (see main.js page:…).
const now = Date.now();
const DAY = 864e5;
const ACCOUNT = { signedIn: true, name: 'Test Person', email: 't@lumio.test', plan: 'plus', planName: 'Plus', paid: true, usage: { windows: [{ id: 'weekly', limit: 100, remaining: 62, used: 38, fullAt: now + DAY }] } };
const ANSWERS = {
  'page:settings': {
    account: ACCOUNT, profile: { name: 'Test', color: '#7ee2a8', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
    memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
    engines: [{ id: 'google', name: 'Google' }, { id: 'bing', name: 'Bing' }], approvalMode: 'ask', showBookmarksBar: false, appearance: 'system',
    ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.3', update: null, isDefault: false,
    importSources: [{ id: 'chrome', name: 'Chrome', passwords: true }], sitePermissions: [{ origin: 'https://meet.google.com', perms: { media: true } }],
    legal: { terms: 'https://lumio.test/terms', privacy: 'https://lumio.test/privacy' },
  },
  'page:account': ACCOUNT,
  'page:billing': { ok: true, plan: 'plus', planName: 'Plus', subscription: { status: 'active', price: 20, periodEnd: now + 20 * DAY, card: { brand: 'visa', last4: '4242' } }, allPlans: [{ id: 'plus', name: 'Plus', price: 20 }], reasons: [] },
  'page:sync': { on: true, status: 'ready', lastSync: now - 60e3, siteUrl: 'https://lumio.test', deviceName: 'Mac', deviceId: 'd1', types: { bookmarks: true, passwords: false, history: true }, requests: [] },
  'page:sync-devices': { ok: true, devices: [{ id: 'd1', name: 'Mac', kind: 'laptop', lastSeen: now }] },
  'page:site-tips': { sites: [{ site: 'amazon.com', tips: [{ tip: 'Use the search box' }] }] },
  'page:schedules': { signedIn: true, tasks: [{ id: 's1', title: 'Morning news', when: 'Every day at 8:00', nextAt: now + 3600e3, prompt: 'Summarize the news' }] },
  'page:workflows': { workflows: [{ id: 'w1', title: 'Check prices', description: '', instructions: 'Check {item}', inputs: [{ name: 'item', label: 'Item' }], runs: 2 }] },
  'page:mac-permissions': { accessibility: true, screen: false },
  'page:newtab-data': { topSites: [{ url: 'https://github.com/', title: 'GitHub' }], bookmarks: [], engine: 'Google', aiReady: true, incognito: false, name: 'Test', chats: [{ id: 'c1', title: 'Trip to Rome', updatedAt: now - 3600e3 }] },
  'page:history': [{ url: 'https://github.com/', title: 'GitHub', time: now - 60e3 }, { url: 'https://example.com/a', title: 'Example page', time: now - DAY }],
  'page:other-tabs': [],
  'page:recently-closed': [],
  'page:downloads': [{ id: 'a', name: 'report.pdf', url: 'https://example.com/report.pdf', state: 'progressing', received: 4e6, total: 1e7, time: now }, { id: 'b', name: 'photo.png', url: 'https://example.com/p.png', state: 'completed', total: 2e6, exists: true, time: now - 60e3 }],
  'page:bookmarks': [{ url: 'https://example.com/', title: 'Example' }, { url: 'https://github.com/', title: 'GitHub' }],
  'page:bookmarks-bar': false,
  'page:credits': {
    version: '0.6.3', license: 'GPL-3.0-or-later', source: 'https://github.com/juaniRD23/lumio-browser', licenseText: 'GNU GENERAL PUBLIC LICENSE',
    chromium: { version: '150.0.0.0', available: true }, electron: { version: '43.7.7', license: 'MIT', url: 'https://www.electronjs.org/', text: 'MIT' },
    packages: [{ name: 'marked', version: '16.4.2', license: 'MIT', url: 'https://marked.js.org', text: 'MIT License' }],
    bundled: [{ name: 'PDF.js', license: 'Apache-2.0', url: 'https://mozilla.github.io/pdf.js/' }],
    terms: 'https://lumio.test/terms', privacy: 'https://lumio.test/privacy',
  },
};
const PAGES = ['settings', 'newtab', 'history', 'downloads', 'bookmarks', 'credits'];

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    // All the pages' files sit together in renderer/pages, so one host serves them all.
    const url = new URL(`lumio://newtab${req.url}`);
    const file = resolveFile(url, PAGE_HOSTS);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    // Incognito pages are served already dark (see main/protocol.js).
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

// Opens a page with a stand-in browser and waits until it has settled (it
// asked for nothing for a moment). window.__calls records what it asked for,
// and window.__emit(channel, payload) plays a message from the browser.
async function openPage(name, { colorScheme, query = '', answers = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); // no favicons from the internet
  await page.addInitScript((answers) => {
    const handlers = {};
    window.__calls = [];
    window.__last = performance.now();
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window.lumioPage = {
      invoke: async (channel, ...args) => {
        window.__calls.push([channel, ...args]);
        window.__last = performance.now();
        return structuredClone(answers[channel] ?? null); // a fresh copy each time, like IPC
      },
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); },
    };
  }, { ...ANSWERS, ...answers });
  await page.goto(`${base}/${name}.html${query}`);
  await page.waitForFunction(() => performance.now() - window.__last > 150);
  return { page, errors };
}

// Checked on each page: its background, its first card, box and field, and its text.
const PARTS = ['body', '.card', '.box', '.field'];

for (const scheme of ['light', 'dark']) {
  test(`pages in ${scheme}: they load without errors, in ${scheme} colors, with readable text`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    for (const name of PAGES) {
      const { page, errors } = await openPage(name, { colorScheme: scheme });
      const c = await readColors(page, { tokens: ['--text'], parts: PARTS });
      if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `page-${name}-${scheme}.png`) });
      await page.close();
      assert.deepEqual(errors, [], `${name}: no errors`);
      for (const [part, rgb] of Object.entries(c.parts)) {
        assert.ok(scheme === 'light' ? luminance(rgb) > 0.7 : luminance(rgb) < 0.05, `${name} ${part} is ${scheme} (rgb ${rgb})`);
      }
      const ratio = contrast(c.tokens['--text'], c.parts.body);
      assert.ok(ratio >= 4.5, `${name}: text on the page is ${ratio.toFixed(2)}:1`);
    }
  });
}

test('incognito pages stay dark on a light computer', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openPage('newtab', { colorScheme: 'light', query: '?appearance=dark', answers: { 'page:newtab-data': { ...ANSWERS['page:newtab-data'], incognito: true } } });
  const c = await readColors(page, { parts: PARTS });
  await page.close();
  assert.deepEqual(errors, []);
  for (const [part, rgb] of Object.entries(c.parts)) assert.ok(luminance(rgb) < 0.05, `incognito ${part} is dark (rgb ${rgb})`);
});

test('Settings › Theme shows the setting, follows changes from elsewhere, and saves a choice', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openPage('settings', { colorScheme: 'light' });
  const checked = () => page.$eval('input[name=appearance]:checked', (r) => r.value);
  assert.equal(await checked(), 'system');
  // The View menu or another device changed it.
  await page.evaluate(() => window.__emit('appearance', 'dark'));
  assert.equal(await checked(), 'dark');
  // Choosing Light asks the browser to save it.
  await page.click('input[name=appearance][value=light]');
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(([c, key]) => c === 'page:set-setting' && key === 'appearance').at(-1)), ['page:set-setting', 'appearance', 'light']);
  await page.close();
  assert.deepEqual(errors, []);
});

test('Settings: Home button, page zoom, zoom levels and the start pages', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const NAV = { showHome: false, homePage: '', defaultZoom: 100, presets: [50, 90, 100, 110, 125], zoomLevels: [{ host: 'news.example', percent: 125 }], startup: 'pages', startupPages: [{ url: 'https://a.example/', title: 'Alpha' }] };
  const { page, errors } = await openPage('settings', {
    colorScheme: 'light',
    answers: {
      'page:settings': { ...ANSWERS['page:settings'], startup: 'pages' },
      'page:nav-settings': NAV,
      'page:nav-set': { ...NAV, ok: true, showHome: true, homePage: 'https://portal.example/' },
      'page:zoom-remove': { ...NAV, zoomLevels: [] },
    },
  });
  const calls = (channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map((x) => x.slice(1)), channel);
  // Home button: off, and its choices hidden until it's on.
  assert.equal(await page.isChecked('#home-show'), false);
  assert.equal(await page.isVisible('#home-choice'), false);
  await page.click('#appearance .row:has(#home-show) .switch i');
  assert.deepEqual((await calls('page:nav-set')).at(-1), ['showHome', true]);
  assert.equal(await page.isVisible('#home-choice'), true);
  assert.match(await page.textContent('#home-desc'), /portal\.example/);
  await page.fill('#home-url', 'portal.example');
  await page.press('#home-url', 'Enter');
  assert.deepEqual((await calls('page:nav-set')).filter(([k]) => k === 'homePage'), [['homePage', 'portal.example']], 'saved once');
  // Page zoom: Chrome's levels.
  assert.deepEqual(await page.$$eval('#zoom-default option', (els) => els.map((o) => o.textContent)), ['50%', '90%', '100%', '110%', '125%']);
  await page.selectOption('#zoom-default', '110');
  assert.deepEqual((await calls('page:nav-set')).at(-1), ['defaultZoom', 110]);
  // Zoom levels: each zoomed site, with Remove.
  assert.match(await page.textContent('#zoom-list'), /news\.example\s*125%/);
  await page.click('[data-zoom-remove="news.example"]');
  assert.deepEqual((await calls('page:zoom-remove')).at(-1), ['news.example']);
  assert.match(await page.textContent('#zoom-list'), /keeps that level here/);
  // On startup › Open a specific page or set of pages: the list, Add, Edit, Remove, Use current pages.
  assert.equal(await page.isVisible('#startup-pages'), true);
  assert.match(await page.textContent('#startup-pages'), /Alpha[\s\S]*https:\/\/a\.example\//);
  await page.click('[data-sp-add]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-url', 'the new address box takes the keyboard');
  await page.fill('#sp-url', 'b.example');
  await page.press('#sp-url', 'Enter');
  assert.deepEqual((await calls('page:nav-set')).at(-1), ['startupPages', [{ url: 'https://a.example/', title: 'Alpha' }, { url: 'b.example', title: '' }]]);
  // Esc closes the address box and the keyboard goes back to "Add a new page".
  await page.click('[data-sp-add]');
  await page.press('#sp-url', 'Escape');
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-sp-add')), true);
  await page.click('[data-sp-remove="0"]');
  assert.deepEqual((await calls('page:nav-set')).at(-1), ['startupPages', []]);
  await page.click('[data-sp-current]');
  assert.equal((await calls('page:startup-current')).length, 1);
  // Choosing another startup hides the list.
  await page.click('input[name=startup][value=restore]');
  assert.equal(await page.isVisible('#startup-pages'), false);
  if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'settings-nav.png'), fullPage: true });
  await page.close();
  assert.deepEqual(errors, []);
});
