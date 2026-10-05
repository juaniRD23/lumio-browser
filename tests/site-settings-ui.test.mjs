// Site settings in the browser UI and pages, in headless Chrome with a
// stand-in for the browser: the permission chip (renderer/ui/
// permission-chip.js) and its bubble (overlay-site.js), the site info popup,
// Site settings and Third-party cookies (renderer/pages/site-settings.*) and
// Delete browsing data (clear-data.*), in light and dark, with the keyboard.
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
const { CATEGORIES, BY_ID, exceptionValues } = require('../main/site-settings.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

// What main/site-ipc.js answers.
const cats = CATEGORIES.map((c) => ({ ...c, value: c.default, count: c.id === 'geolocation' ? 2 : 0, exceptions: exceptionValues(c) }));
const ANSWERS = {
  'page:settings': { profile: { theme: 'blue' }, platform: 'darwin' },
  'page:site-settings': { categories: cats, recent: [{ origin: 'https://maps.example.com', time: Date.now(), settings: { geolocation: 'allow', sound: 'block' } }] },
  'page:site-category': { category: cats.find((c) => c.id === 'geolocation'), sites: [{ origin: 'https://maps.example.com', value: 'allow' }, { origin: 'https://ads.tracker.test', value: 'block' }] },
  'page:site-set': true,
  'page:site-set-default': true,
  'page:site-all': [
    { site: 'example.com', usage: 12_400_000, cookies: 14, settings: true, origins: [{ origin: 'https://www.example.com', usage: 12e6 }, { origin: 'https://mail.example.com', usage: 4e5 }] },
    { site: 'news.test', usage: 0, cookies: 3, settings: false, origins: [{ origin: 'https://news.test', usage: 0 }] },
  ],
  'page:site-details': {
    origin: 'https://www.example.com', site: 'example.com', host: 'www.example.com', usage: 12e6, cookies: 14, favicon: null,
    settings: cats.filter((c) => c.exceptions.length).map((c) => ({ id: c.id, label: c.label, kind: c.kind, value: c.id === 'javascript' ? 'block' : null, default: c.default, exceptions: c.exceptions, text: c.text })),
  },
  'page:clear-data-counts': { history: 132, downloads: 4, cookieSites: 58, cacheBytes: 84e6, passwords: 2, siteSettings: 3, chats: 5, closed: 7 },
  'page:clear-data': true,
};
const COOKIES = { ...ANSWERS, 'page:site-category': { category: cats.find((c) => c.id === 'thirdPartyCookies'), sites: [{ origin: 'https://shop.example.com', value: 'allow' }] } };

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  // /ui/<host>/… is the browser UI; anything else is lumio://settings/….
  server = http.createServer((req, res) => {
    let url;
    if (req.url.startsWith('/ui/')) { const [, , host, ...rest] = req.url.split('/'); url = new URL(`lumio://${host}/${rest.join('/')}`); }
    else url = new URL(`lumio://settings${req.url}`);
    const file = resolveFile(url, new Set([...PAGE_HOSTS, 'shell', 'overlay']));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

async function openPage(urlPath, { colorScheme = 'light', answers = ANSWERS } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((answers) => {
    window.__calls = [];
    // Leaving the page is recorded instead of done.
    history.back = () => window.__calls.push(['history.back']);
    window.lumioPage = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return structuredClone(answers[channel] ?? null); },
      on: () => {},
    };
  }, answers);
  await page.goto(base + urlPath);
  await page.waitForFunction(() => !document.getElementById('view')?.hasAttribute('aria-busy') || document.querySelector('.cd'));
  await page.waitForTimeout(100);
  return { page, errors, calls: (channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c), channel) };
}

const VIEWS = [['/content', 'Site settings'], ['/content/geolocation', 'Location'], ['/cookies', 'Third-party cookies'], ['/content/all', 'All sites'], ['/content/siteDetails?site=https%3A%2F%2Fwww.example.com', 'www.example.com'], ['/clearBrowserData', 'Delete browsing data']];

for (const scheme of ['light', 'dark']) {
  test(`site settings pages in ${scheme}: they load without errors, in ${scheme} colors, with readable text`, { skip }, async () => {
    for (const [url, title] of VIEWS) {
      const { page, errors } = await openPage(url, { colorScheme: scheme, answers: url === '/cookies' ? COOKIES : ANSWERS });
      assert.equal(await page.textContent('h1'), title, url);
      const c = await readColors(page, { tokens: ['--text', '--dim', '--label'], parts: ['body', '.card', '.cd'] });
      if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `site-settings${url.replace(/[/?=%]+/g, '-')}-${scheme}.png`), fullPage: true });
      await page.close();
      assert.deepEqual(errors, [], `${url}: no errors`);
      for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.7 : luminance(rgb) < 0.05, `${url} ${part} is ${scheme}`);
      for (const t of ['--text', '--dim', '--label']) assert.ok(contrast(c.tokens[t], c.parts.body) >= 4.5, `${url}: ${t} is readable`);
    }
  });
}

test('Site settings: groups open with the keyboard; rows lead to each setting', { skip }, async () => {
  const { page } = await openPage('/content');
  assert.equal(await page.isVisible('#more-more-permissions'), false);
  await page.focus('.expander');
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('#more-more-permissions'), true);
  assert.equal(await page.getAttribute('.expander', 'aria-expanded'), 'true');
  const links = await page.$$eval('a.row.link', (as) => as.map((a) => a.getAttribute('href')));
  assert.ok(links.includes('/content/all') && links.includes('/content/geolocation') && links.includes('/cookies') && links.includes('/content/javascript'));
  assert.match(await page.textContent('.card a[href^="/content/siteDetails"]'), /maps\.example\.com[\s\S]*Location allowed · Sound muted/);
  assert.match(await page.textContent('a[href="/content/geolocation"]'), /2 sites/);
  await page.close();
});

test('a category: the default, adding a site, changing and removing one', { skip }, async () => {
  const { page, calls } = await openPage('/content/geolocation');
  assert.deepEqual(await page.$$eval('input[name=default]', (rs) => rs.map((r) => [r.value, r.checked])), [['ask', true], ['block', false]]);
  await page.check('input[name=default][value=block]');
  assert.deepEqual((await calls('page:site-set-default')).at(-1), ['page:site-set-default', 'geolocation', 'block']);
  // Add to the blocked list, from the keyboard.
  await page.click('[data-list=block] [data-add]');
  assert.equal(await page.evaluate(() => document.activeElement.name), 'site');
  await page.keyboard.type('spy.example');
  await page.keyboard.press('Enter');
  assert.deepEqual((await calls('page:site-set')).at(-1), ['page:site-set', 'spy.example', 'geolocation', 'block']);
  // Move a site to the other list, then remove it.
  await page.selectOption('[data-list=allow] .site select', 'block');
  assert.deepEqual((await calls('page:site-set')).at(-1), ['page:site-set', 'https://maps.example.com', 'geolocation', 'block']);
  await page.click('[data-list=block] .site [data-remove]');
  assert.deepEqual((await calls('page:site-set')).at(-1), ['page:site-set', 'https://ads.tracker.test', 'geolocation', 'default']);
  // Esc closes the add form.
  await page.click('[data-list=allow] [data-add]');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('[data-list=allow] .add-form'), false);
  await page.close();
});

test('All sites: search, sort, and deleting a site after confirming', { skip }, async () => {
  const { page, calls } = await openPage('/content/all');
  assert.deepEqual(await page.$$eval('.site', (els) => els.map((e) => e.dataset.site)), ['example.com', 'news.test']);
  assert.match(await page.textContent('.site'), /12\.4 MB · 14 cookies · Own settings/);
  await page.fill('#filter', 'mail');
  assert.deepEqual(await page.$$eval('.site', (els) => els.map((e) => e.dataset.site)), ['example.com'], 'finds a site by its pages');
  await page.fill('#filter', '');
  await page.selectOption('#sort', 'name');
  await page.click('.site[data-site="news.test"] [data-delete]');
  assert.equal(await page.isVisible('#confirm'), true);
  await page.keyboard.press('Escape');
  assert.equal((await calls('page:site-delete')).length, 0, 'Esc cancels');
  await page.click('.site[data-site="news.test"] [data-delete]');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:site-delete'));
  assert.deepEqual((await calls('page:site-delete')).at(-1), ['page:site-delete', 'news.test', { permissions: true }]);
  await page.close();
});

test('a site’s page: its data and every setting', { skip }, async () => {
  const { page, calls } = await openPage('/content/siteDetails?site=https%3A%2F%2Fwww.example.com');
  assert.match(await page.textContent('#usage'), /12\.0 MB · 14 cookies/);
  assert.equal(await page.$eval('select[data-id=javascript]', (s) => s.value), 'block');
  assert.equal(await page.$eval('select[data-id=notifications] option[value=default]', (o) => o.textContent), 'Ask quietly (default)');
  assert.equal(await page.$eval('select[data-id=sound] option[value=block]', (o) => o.textContent), 'Mute');
  await page.selectOption('select[data-id=camera]', 'allow');
  assert.deepEqual((await calls('page:site-set')).at(-1), ['page:site-set', 'https://www.example.com', 'camera', 'allow']);
  await page.click('#reset');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:site-reset'));
  assert.equal(await page.$eval('select[data-id=javascript]', (s) => s.value), 'default');
  await page.close();
});

test('Delete browsing data: Basic and Advanced, counts for the time range, and deleting', { skip }, async () => {
  const { page, calls } = await openPage('/clearBrowserData');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-basic', 'the dialog starts on its tabs');
  assert.deepEqual(await page.$$eval('.cd-item b', (bs) => bs.map((b) => b.textContent)), ['Browsing history', 'Cookies and other site data', 'Cached images and files']);
  assert.match(await page.textContent('#note-cookies'), /From 58 sites/);
  assert.match(await page.textContent('#note-cache'), /Frees up 84\.0 MB · Always all time/);
  // Arrow keys switch tabs; Advanced has more, some only explained.
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('#tab-advanced', 'aria-selected'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-advanced');
  assert.equal(await page.isDisabled('input[value=autofill]'), true);
  assert.equal(await page.isChecked('input[value=passwords]'), false, 'passwords are never picked for you');
  await page.check('input[value=passwords]');
  await page.uncheck('input[value=cache]');
  await page.selectOption('#range', '900000');
  await page.waitForFunction(() => window.__calls.filter(([c]) => c === 'page:clear-data-counts').length >= 2);
  assert.deepEqual((await calls('page:clear-data-counts')).at(-1), ['page:clear-data-counts', 900000]);
  await page.click('#go');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:clear-data'));
  assert.deepEqual((await calls('page:clear-data')).at(-1), ['page:clear-data', { range: 900000, what: ['history', 'downloads', 'cookies', 'passwords'] }]);
  // Done: back to where it was opened from.
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'history.back'));
  // Opened again, the choices are remembered; Esc cancels.
  await page.goto(base + '/clearBrowserData');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:clear-data-counts'));
  assert.equal(await page.getAttribute('#tab-advanced', 'aria-selected'), 'true');
  assert.equal(await page.$eval('#range', (s) => s.value), '900000');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'history.back'));
  assert.equal((await calls('page:clear-data')).length, 0);
  await page.close();
});

// ---------------------------------------------------------------- browser UI
const cat = (id) => ({ id, prompt: BY_ID[id].prompt, chip: BY_ID[id].chip, blocked: BY_ID[id].blocked });
const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, reasoning: 'medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, wcId: 11, title: 'Maps', url: 'https://maps.example.com/' }, { id: 2, wcId: 12, title: 'News', url: 'https://news.example.com/' }] },
  downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false }, account: {}, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};
async function openUi(host, { colorScheme = 'light', answers = {} } = {}) {
  const page = await browser.newPage({ viewport: host === 'shell' ? { width: 1200, height: 700 } : { width: 380, height: 520 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((answers) => {
    const handlers = {};
    window.__sent = [];
    window.__emit = (c, p) => (handlers[c] || []).forEach((f) => f(p));
    window.lumio = { invoke: async (c) => answers[c] ?? null, send: (c, p) => window.__sent.push([c, p]), on: (c, f) => { (handlers[c] ||= []).push(f); return () => {}; } };
  }, answers);
  await page.goto(`${base}/ui/${host}/`);
  await page.waitForTimeout(300);
  const sent = (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
  return { page, errors, sent, emit: (c, p) => page.evaluate(([c2, p2]) => window.__emit(c2, p2), [c, p]) };
}

test('the permission chip: a question opens the bubble once; quiet and blocked ones only show the chip', { skip }, async () => {
  const { page, errors, sent, emit } = await openUi('shell', { answers: { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] } } });
  assert.equal(await page.isVisible('#perm-chip'), false);
  await emit('permission', { id: 1, wcId: 11, host: 'maps.example.com', quiet: false, once: true, cats: [cat('geolocation')] });
  assert.equal(await page.textContent('#perm-chip'), 'Use your location?');
  assert.match(await page.textContent('#perm-live'), /maps\.example\.com wants to know your location/);
  const shown = (await sent('overlay:show')).at(-1);
  assert.equal(shown.payload.kind, 'permission');
  assert.equal(shown.payload.mode, 'ask');
  assert.equal(shown.payload.focus, false, 'opened by itself: the page keeps the keyboard');
  // Clicking elsewhere leaves the question in the chip; clicking the chip brings it back, with focus.
  await page.mouse.click(600, 400);
  assert.equal((await sent('overlay:hide')).at(-1), 'permission');
  await page.click('#perm-chip');
  assert.equal((await sent('overlay:show')).at(-1).payload.focus, true);
  assert.equal((await sent('permission:focus-bubble')).length, 1);
  // Answered in the bubble: the chip goes.
  await emit('overlay-picked', { kind: 'permission', id: 1 });
  assert.equal(await page.isVisible('#perm-chip'), false);
  // Another tab's question waits for that tab.
  const before = (await sent('overlay:show')).length;
  await emit('permission', { id: 2, wcId: 12, host: 'news.example.com', quiet: true, once: false, cats: [cat('notifications')] });
  assert.equal(await page.isVisible('#perm-chip'), false);
  await emit('tabs', { ...INIT.tabs, activeId: 2 });
  assert.equal(await page.textContent('#perm-chip'), 'Notifications blocked');
  assert.match(await page.getAttribute('#perm-chip', 'class'), /quiet/);
  assert.equal((await sent('overlay:show')).length, before, 'quiet: no bubble by itself');
  await emit('permission-cancel', { id: 2 });
  // Something blocked on the page: a notice, cleared when the tab moves on.
  await emit('permission-blocked', { wcId: 12, cat: 'javascript', label: 'JavaScript blocked', note: 'This page was blocked from using JavaScript.', host: 'news.example.com' });
  assert.equal(await page.textContent('#perm-chip'), 'JavaScript blocked');
  await emit('permission-reset', { wcId: 12 });
  assert.equal(await page.isVisible('#perm-chip'), false);
  if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'perm-chip.png'), clip: { x: 0, y: 40, width: 800, height: 50 } });
  await page.close();
  assert.deepEqual(errors, []);
});

for (const scheme of ['light', 'dark']) {
  test(`the permission bubble in ${scheme}: three answers, arrow keys and Esc`, { skip }, async () => {
    const { page, errors, sent, emit } = await openUi('overlay', { colorScheme: scheme });
    await emit('overlay-data', { kind: 'permission', mode: 'ask', id: 5, wcId: 11, host: 'maps.example.com', once: true, focus: true, cats: [cat('camera'), cat('microphone')] });
    assert.deepEqual(await page.$$eval('.pb-btn', (bs) => bs.map((b) => b.textContent.trim())), ['Allow while visiting the site', 'Allow this time', 'Don’t allow']);
    assert.match(await page.textContent('.pb-t'), /maps\.example\.com wants to/);
    await page.waitForFunction(() => document.activeElement?.dataset.d === 'allow');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.d), 'once');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.d), 'block', 'wraps around');
    const c = await readColors(page, { tokens: ['--text'], parts: ['#card', '.pb-btn'] });
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `perm-bubble-${scheme}.png`) });
    for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.6 : luminance(rgb) < 0.06, `${part} is ${scheme}`);
    assert.ok(contrast(c.tokens['--text'], c.parts['.pb-btn']) >= 4.5);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('permission:respond')).at(-1), { id: 5, decision: 'once' });
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'permission', id: 5, keyboard: true });
    await page.keyboard.press('Escape');
    assert.deepEqual((await sent('permission:bubble-closed')).at(-1), { refocus: true });
    // A quiet request and blocked things.
    await emit('overlay-data', { kind: 'permission', mode: 'quiet', id: 6, wcId: 11, host: 'news.example.com', cats: [cat('notifications')] });
    assert.match(await page.textContent('.pb-note'), /news\.example\.com wants to show notifications/);
    await page.click('[data-d=allow]');
    assert.deepEqual((await sent('permission:respond')).at(-1), { id: 6, decision: 'allow' });
    await emit('overlay-data', { kind: 'permission', mode: 'blocked', wcId: 11, host: 'x.test', blocked: [{ cat: 'images', label: 'Images blocked', note: 'Images were blocked on this page.' }] });
    await page.click('[data-allow=images]');
    assert.deepEqual((await sent('permission:allow-blocked')).at(-1), { wcId: 11, cat: 'images' });
    await page.click('[data-manage]');
    assert.equal((await sent('permission:manage')).at(-1), 'images');
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('site info: each setting with its default, a reload note, cookies, reset', { skip }, async () => {
  const { page, errors, sent, emit } = await openUi('overlay');
  await emit('overlay-data', { kind: 'siteinfo', info: {
    host: 'maps.example.com', origin: 'https://maps.example.com', secure: true, cookies: 12, reload: false,
    permissions: [
      { permission: 'geolocation', label: 'Location', value: 'allow', default: 'ask', options: ['allow', 'block'] },
      { permission: 'notifications', label: 'Notifications', default: 'quiet', options: ['allow', 'block'] },
      { permission: 'javascript', label: 'JavaScript', default: 'allow', options: ['allow', 'block'], reload: true },
    ],
  } });
  assert.equal(await page.$eval('select[data-perm=geolocation]', (s) => s.value), 'allow');
  assert.equal(await page.$eval('select[data-perm=notifications] option[value=default]', (o) => o.textContent), 'Ask quietly (default)');
  assert.equal(await page.textContent('.si-data small'), '12 cookies');
  assert.equal(await page.isVisible('.si-reload'), false);
  await page.selectOption('select[data-perm=javascript]', 'block');
  assert.deepEqual((await sent('site:set-permission')).at(-1), { permission: 'javascript', value: 'block' });
  assert.equal(await page.isVisible('.si-reload'), true, 'JavaScript applies after a reload');
  await page.click('[data-si=reload]');
  assert.equal((await sent('tab:reload')).length, 1);
  await page.click('[data-si=reset]');
  assert.equal((await sent('site:reset-permissions')).length, 1);
  await page.close();
  assert.deepEqual(errors, []);
});
