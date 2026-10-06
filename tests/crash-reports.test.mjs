// Opt-in crash reports (main/crash-reports.js): off unless the person turned
// them on; when on, Crashpad starts with only version/platform/arch/channel,
// and JSON reports of main-process errors and dead processes carry no web
// addresses, paths, quoted text or account. Then the switch in Settings and
// on the welcome screens, and the Crashes section of the owner's /admin page,
// in headless Chrome (skipped when Google Chrome isn't installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { luminance, contrast } from './colors.mjs';
const require = createRequire(import.meta.url);
const { createCrashReports, readSetting, cleanMessage, cleanStack, errorReport, channelOf } = require('../main/crash-reports.js');
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- main process
function profile(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-crash-'));
  if (settings != null) fs.writeFileSync(path.join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return dir;
}

// Stand-ins for Electron's app and crashReporter, the process and fetch.
function harness({ settings = { crashReports: true }, packaged = true, beta = false, fetchImpl, startThrows = false } = {}) {
  const userData = profile(settings);
  const app = Object.assign(new EventEmitter(), { isPackaged: packaged, getVersion: () => '0.6.8', getPath: (k) => (k === 'userData' ? userData : null) });
  const crashReporter = {
    started: null, upload: [],
    start(o) { if (startThrows) throw new Error('nope'); this.started = o; },
    setUploadToServer(v) { this.upload.push(v); },
  };
  const posts = [];
  const proc = new EventEmitter();
  const reports = createCrashReports({
    app, crashReporter, proc, base: 'https://lumio.test/', beta, platform: 'darwin', arch: 'arm64', root: '/Applications/Lumio Browser.app/Contents/Resources/app.asar',
    fetchImpl: fetchImpl || (async (url, opts) => { posts.push({ url, ...opts, json: JSON.parse(opts.body) }); return new Response('{}'); }),
  });
  const saved = {};
  const store = { setSetting: (k, v) => { saved[k] = v; } };
  return { app, crashReporter, proc, reports, posts, store, saved, userData };
}

test('the setting is read from settings.json before the app is ready, and only true turns it on', () => {
  assert.equal(readSetting(profile()), false, 'no settings yet');
  assert.equal(readSetting(profile({ crashReports: true })), true);
  assert.equal(readSetting(profile({ crashReports: 'yes' })), false);
  assert.equal(readSetting(profile('{broken')), false);
});

test('off by default: Crashpad never starts and nothing listens for errors', async () => {
  for (const settings of [null, {}, { crashReports: false }]) { // null: no settings file yet
    const h = harness({ settings });
    assert.equal(h.reports.start(), false);
    assert.equal(h.crashReporter.started, null);
    assert.equal(h.proc.listenerCount('uncaughtException'), 0);
    assert.equal(h.app.listenerCount('render-process-gone'), 0);
    assert.deepEqual(h.reports.state(), { on: false, active: false });
    assert.equal(await h.reports.send({ type: 'gone', process: 'renderer', reason: 'crashed' }), false);
    assert.equal(h.posts.length, 0);
  }
});

test('when on, Crashpad starts with the Lumio server and only version, platform, arch and channel', () => {
  const h = harness();
  assert.equal(h.reports.start(), true);
  assert.deepEqual(h.crashReporter.started, {
    submitURL: 'https://lumio.test/api/crash', productName: 'Lumio Browser', uploadToServer: true,
    globalExtra: { _companyName: 'Lumio', version: '0.6.8', platform: 'darwin', arch: 'arm64', channel: 'stable' },
  });
  assert.deepEqual(h.reports.state(), { on: true, active: true });
  const beta = harness({ beta: true });
  beta.reports.start();
  assert.equal(beta.crashReporter.started.globalExtra.channel, 'beta', 'Lumio Beta');
  const dev = harness({ packaged: false });
  dev.reports.start();
  assert.equal(dev.crashReporter.started.globalExtra.channel, 'dev', 'running from source');
  assert.deepEqual([channelOf({ beta: true, packaged: true }), channelOf({ beta: false, packaged: true }), channelOf({ beta: false, packaged: false })], ['beta', 'stable', 'dev']);
});

test('if Crashpad can’t start, the browser carries on without crash reports', () => {
  const h = harness({ startThrows: true });
  const error = console.error;
  console.error = () => {};
  try { assert.equal(h.reports.start(), false); } finally { console.error = error; }
  assert.deepEqual(h.reports.state(), { on: true, active: false });
  assert.equal(h.proc.listenerCount('uncaughtException'), 0);
});

test('a main-process error is sent with Lumio’s own file paths only: no addresses, emails, other paths or quoted text', async () => {
  const h = harness();
  h.reports.start();
  const err = new TypeError('Cannot read properties of undefined (reading \'title\') for "My Bank — Statement" at https://bank.example/acct?id=9 by sam@example.com in /Users/sam/Library/Application Support/Lumio Browser/x.json');
  err.stack = [
    `TypeError: ${err.message}`,
    '    at update (/Applications/Lumio Browser.app/Contents/Resources/app.asar/main/tabs.js:183:7)',
    '    at file:///Applications/Lumio%20Browser.app/Contents/Resources/app.asar/main/window.js:20:3',
    '    at /Users/sam/.npm/thing/index.js:1:2',
    '    at eval (eval at run (/Users/sam/x.js:1:1), <anonymous>:1:7)',
    '    at async Promise.all (index 0)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');
  h.proc.emit('uncaughtException', err);
  await tick();
  assert.equal(h.posts.length, 1);
  const p = h.posts[0];
  assert.equal(p.url, 'https://lumio.test/api/crash');
  assert.equal(p.method, 'POST');
  assert.equal(p.headers['Content-Type'], 'application/json');
  assert.ok(!('Cookie' in p.headers) && !('Authorization' in p.headers), 'never the account');
  assert.deepEqual(p.json, {
    version: '0.6.8', platform: 'darwin', arch: 'arm64', channel: 'stable', type: 'js', process: 'browser', reason: 'uncaughtException', name: 'TypeError',
    message: 'Cannot read properties of undefined (reading \'title\') for … at <url> by <email> in <path>',
    stack: [
      'TypeError: Cannot read properties of undefined (reading \'title\') for … at <url> by <email> in <path>',
      '    at update (main/tabs.js:183:7)',
      '    at main/window.js:20:3',
      '    at elsewhere:1:2',
      '    at eval (elsewhere:1:7)',
      '    at async Promise.all (index 0)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  });
  assert.doesNotMatch(p.body, /sam|bank|Statement|Users|Applications/);
});

test('rejections with things that aren’t errors say only what kind of value it was', async () => {
  const meta = { version: '1.0.0' };
  assert.deepEqual(errorReport({ secret: 'x' }, 'unhandledRejection', meta), { version: '1.0.0', type: 'js', process: 'browser', reason: 'unhandledRejection', name: 'NonError', message: 'an object value', stack: 'NonError: an object value' });
  assert.equal(errorReport(null, 'unhandledRejection', meta).message, 'a null value');
  assert.equal(errorReport('Fetch failed for "secret words" at https://x.example', 'unhandledRejection', meta).message, 'Fetch failed for … at <url>');
  assert.equal(cleanMessage("Unexpected token 'H', \"Hello my password is\"... is not valid JSON"), 'Unexpected token …, …... is not valid JSON');
  assert.equal(cleanMessage('x'.repeat(400)).length, 300);
  // Sites, IPs and tokens without a scheme (an uncaught fetch failure) go too.
  assert.equal(cleanMessage('getaddrinfo ENOTFOUND mybank.example.com'), 'getaddrinfo ENOTFOUND <host>');
  assert.equal(cleanMessage('net::ERR_CERT_AUTHORITY_INVALID at secret.example.org'), 'net::ERR_CERT_AUTHORITY_INVALID at <host>');
  assert.equal(cleanMessage('connect ECONNREFUSED 10.0.0.5:443 via 2001:db8:0:0:1:0:0:1'), 'connect ECONNREFUSED <ip>:443 via <ip>');
  assert.equal(cleanMessage('auth eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 refused'), 'auth <token> refused');
  assert.equal(cleanMessage('Cannot find module main/tabs.js'), 'Cannot find module main/tabs.js', 'Lumio’s own files stay');
});

test('stack paths on Windows, in any letter case, become app-relative too', () => {
  const root = 'C:\\Users\\Jo Smith\\AppData\\Local\\Programs\\Lumio Browser\\resources\\app.asar';
  assert.equal(cleanStack('Error: x\n    at go (c:\\users\\jo smith\\appdata\\local\\programs\\lumio browser\\resources\\app.asar\\main\\ai\\run.js:5:9)\n    at C:\\Users\\Jo Smith\\other.js:1:1', root),
    '    at go (main/ai/run.js:5:9)\n    at elsewhere:1:1');
  assert.equal(cleanStack('    at weird name with: colons (/x/y.js:1:1)', '/app'), '    at <fn> (elsewhere:1:1)');
});

test('pages and helper processes that die are reported by kind and reason, never by address; normal exits and quitting aren’t', async () => {
  const h = harness();
  h.reports.start();
  const wc = (url) => ({ getURL: () => url });
  h.app.emit('render-process-gone', {}, wc('https://bank.example/statement'), { reason: 'crashed', exitCode: 11 });
  h.app.emit('render-process-gone', {}, wc('lumio://shell/'), { reason: 'oom', exitCode: -1 });
  h.app.emit('render-process-gone', {}, wc('chrome-extension://abc/bg.html'), { reason: 'killed', exitCode: 9 });
  h.app.emit('render-process-gone', {}, wc('https://x.example'), { reason: 'clean-exit', exitCode: 0 });
  h.app.emit('render-process-gone', {}, { getURL() { throw new Error('destroyed'); } }, { reason: 'abnormal-exit', exitCode: 1 });
  h.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
  h.app.emit('child-process-gone', {}, { type: 'Utility', name: 'Network Service', serviceName: 'network.mojom.NetworkService', reason: 'crashed', exitCode: 5 });
  h.app.emit('child-process-gone', {}, { type: 'Utility', reason: 'memory-eviction', exitCode: 0 });
  h.app.emit('before-quit');
  h.app.emit('render-process-gone', {}, wc('https://x.example'), { reason: 'crashed', exitCode: 1 });
  await tick();
  const meta = { version: '0.6.8', platform: 'darwin', arch: 'arm64', channel: 'stable', type: 'gone' };
  assert.deepEqual(h.posts.map((p) => p.json), [
    { ...meta, process: 'renderer', where: 'page', reason: 'crashed', exitCode: 11 },
    { ...meta, process: 'renderer', where: 'ui', reason: 'oom', exitCode: -1 },
    { ...meta, process: 'renderer', where: 'extension', reason: 'killed', exitCode: 9 },
    { ...meta, process: 'renderer', where: 'page', reason: 'abnormal-exit', exitCode: 1 },
    { ...meta, process: 'gpu-process', reason: 'crashed', exitCode: 5 },
    { ...meta, process: 'utility', name: 'Network Service', reason: 'crashed', exitCode: 5 },
  ]);
  assert.doesNotMatch(h.posts.map((p) => p.body).join(), /bank|example|abc|shell/);
});

test('the same error is sent once per launch, at most 10 reports, and an offline send doesn’t throw', async () => {
  const h = harness();
  h.reports.start();
  const boom = () => { const e = new Error('boom'); e.stack = 'Error: boom\n    at a (/Applications/Lumio Browser.app/Contents/Resources/app.asar/main/a.js:1:1)'; return e; };
  h.proc.emit('uncaughtException', boom());
  h.proc.emit('uncaughtException', boom());
  await tick();
  assert.equal(h.posts.length, 1, 'once');
  for (let i = 0; i < 20; i++) h.app.emit('child-process-gone', {}, { type: 'Utility', name: `Service ${i}`, reason: 'crashed', exitCode: i });
  await tick();
  assert.equal(h.posts.length, 10, 'at most 10 a launch');

  // An error whose stack can't even be read doesn't make things worse.
  const odd = new Error('odd');
  Object.defineProperty(odd, 'stack', { get() { throw new Error('no stack'); } });
  assert.doesNotThrow(() => h.proc.emit('uncaughtException', odd));

  const offline = harness({ fetchImpl: async () => { throw new Error('offline'); } });
  offline.reports.start();
  assert.equal(await offline.reports.send({ type: 'gone', process: 'renderer', reason: 'crashed' }), false);
});

test('turning it off stops uploads at once; turning it on waits for the next launch', async () => {
  const h = harness();
  h.reports.start();
  assert.deepEqual(h.reports.setEnabled(h.store, false), { on: false, active: true });
  assert.deepEqual(h.crashReporter.upload, [false], 'Crashpad stops uploading');
  assert.equal(h.saved.crashReports, false);
  h.proc.emit('uncaughtException', new Error('after'));
  await tick();
  assert.equal(h.posts.length, 0, 'no more JSON reports either');
  assert.deepEqual(h.reports.setEnabled(h.store, true), { on: true, active: true });
  assert.deepEqual(h.crashReporter.upload, [false, true]);

  const off = harness({ settings: {} });
  off.reports.start();
  assert.deepEqual(off.reports.setEnabled(off.store, true), { on: true, active: false }, 'starts next launch');
  assert.deepEqual(off.crashReporter.upload, []);
  assert.equal(off.saved.crashReports, true);
  assert.equal(await off.reports.send({ type: 'gone', process: 'renderer', reason: 'crashed' }), false, 'nothing until then');
  assert.deepEqual(off.reports.setEnabled(off.store, 'yes'), { on: false, active: false }, 'only true turns it on');
});

test('main.js starts it before the app is ready and lets only Settings and the welcome screens change it', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  const setupAt = main.indexOf("require('./crash-reports').setup(app)");
  assert.ok(setupAt > 0 && setupAt < main.indexOf('app.whenReady()'));
  assert.match(main, /internalHandle\('page:set-crash-reports', \['settings', 'welcome'\]/);
});

// The welcome screens have the crash report switch, like Settings, so a page
// that talks the AI into it can't turn crash reports on for the person.
test('Lumio AI can’t open or operate the welcome screens or Settings, where the switch is', async () => {
  const { tools } = require('../main/ai/tools/browser.js');
  const tool = (name) => tools.find((t) => t.name === name);
  const created = [];
  const tabOn = (url) => ({ id: 1, url, view: { webContents: { getURL: () => url } } });
  const ctx = (url) => ({
    tabs: { searchTemplate: () => 'https://search.test/?q=%s', active: tabOn(url), activeId: 1, get: () => tabOn(url), ensureView() {}, activate() {}, navigate() {}, create: (u) => { created.push(u); throw new Error('opened'); } },
  });
  for (const url of ['lumio://welcome/', 'LUMIO://Welcome/#done', 'lumio://settings/#privacy']) {
    await assert.rejects(() => tool('navigate').run({ url }, ctx('https://example.com/')), /can't open its own Settings,.* welcome/, url);
    await assert.rejects(() => tool('open_tab').run({ url }, ctx('https://example.com/')), /can't open its own Settings,.* welcome/, url);
    for (const name of ['read_page', 'click', 'press_key']) {
      await assert.rejects(() => tool(name).run({ ref: 1, key: 'Space' }, ctx(url)), /can't read or operate its own Settings,.* welcome/, `${name} on ${url}`);
    }
  }
  assert.deepEqual(created, [], 'no tab was opened');
  // Other Lumio pages are still fine to open.
  await assert.rejects(() => tool('open_tab').run({ url: 'lumio://newtab/' }, ctx('https://example.com/')), /opened/);
});

test('the privacy page and the owner’s steps match what the app and server do', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const privacy = /<p><b>Crash reports<\/b>[\s\S]*?<\/p>/.exec(read('website/public/privacy.html'))?.[0];
  assert.ok(privacy, 'privacy.html has a Crash reports paragraph');
  assert.match(privacy, /off unless you turn them on \(Settings › Privacy, or the welcome screens\)/);
  assert.match(privacy, /bits of what was in Lumio’s memory/, 'it says what a minidump can hold');
  assert.match(privacy, /aren’t linked to your account/);
  // The same numbers the server keeps to.
  const server = read('server/src/crashes.ts');
  assert.match(privacy, /keep them for 90 days/);
  assert.match(server, /\nconst KEEP_DAYS = 90;/);
  assert.match(privacy, /IP address for one day only/);
  assert.match(server, /SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < \?1'\)\.bind\(now - DAY\)/);
  // The Settings and welcome text send people to where the switch is.
  assert.match(read('renderer/pages/welcome.html'), /You can change this anytime in Settings › Privacy\./);
  // docs/crash-reports.md: the one-time command names the migration that exists, and the bindings it says are already there are.
  const docs = read('docs/crash-reports.md');
  const cmd = /npx wrangler d1 execute lumio --remote --file (migrations\/[\w.-]+\.sql)/.exec(docs);
  assert.ok(cmd, 'the docs say how to create the table');
  assert.ok(read(`server/${cmd[1]}`).includes(cmd[0]), 'the migration file exists and its header has the same command');
  const wrangler = read('server/wrangler.jsonc');
  assert.match(docs, /existing `DB` and `FILES`/);
  assert.match(wrangler, /"binding": "DB", "database_name": "lumio"/);
  assert.match(wrangler, /"binding": "FILES"/);
  assert.match(wrangler, /"crons": \[/, 'a cron trigger runs the 90-day cleanup');
});

// ---------------------------------------------------------------- pages (headless Chrome)
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const now = Date.now();
const SETTINGS = {
  account: { signedIn: false }, profile: { name: 'Test', color: '#7ee2a8', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
  memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
  engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: false, appearance: 'system',
  ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.8', update: null, isDefault: false, importSources: [], sitePermissions: [],
};
const PAGE_ANSWERS = {
  'page:settings': SETTINGS,
  'page:schedules': { signedIn: false, tasks: [] },
  'page:sync': { on: false, status: 'off', types: {}, requests: [] },
  'page:sync-devices': { ok: true, devices: [] },
  'page:site-tips': { sites: [] },
  'page:workflows': { workflows: [] },
  'page:mac-permissions': { accessibility: true, screen: true },
  'page:welcome-state': { platform: 'win32', sources: [], account: { signedIn: false } },
  'page:crash-reports': { on: false, active: false },
};

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file;
    // The website (for /admin) under /site/, Lumio's own pages everywhere else.
    if (url.pathname.startsWith('/site/')) {
      const f = path.join(ROOT, 'website', 'public', url.pathname.slice(6));
      file = f.startsWith(path.join(ROOT, 'website', 'public')) ? f : null;
    } else file = resolveFile(new URL(`lumio://settings${url.pathname}`), PAGE_HOSTS);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('admin.html')) body = String(body).replace(/(href|src)="\/(?!\/)/g, '$1="/site/');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ...(url.pathname.startsWith('/site/') ? {} : { 'content-security-policy': CSP }) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

// A page with a stand-in browser: window.__calls records what it asked for;
// `answers` can be a function of the call to answer differently over time.
async function openPage(name, { colorScheme = 'light', answers = {}, reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme, reducedMotion });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript((answers) => {
    window.__calls = [];
    window.__crash = answers['page:crash-reports'];
    window.lumioPage = {
      invoke: async (channel, ...args) => {
        window.__calls.push([channel, ...args]);
        // Like main/crash-reports.js: on takes effect next launch.
        if (channel === 'page:set-crash-reports') { window.__crash = { on: args[0] === true, active: window.__crash.active }; return structuredClone(window.__crash); }
        if (channel === 'page:crash-reports') return structuredClone(window.__crash);
        return structuredClone(answers[channel] ?? null);
      },
      on: () => {},
    };
  }, { ...PAGE_ANSWERS, ...answers });
  await page.goto(`${base}/${name}.html`);
  await page.waitForFunction(() => window.__calls.some(([c]) => c === 'page:crash-reports'));
  await page.waitForTimeout(100);
  return { page, errors };
}
const crashCalls = (page) => page.evaluate(() => window.__calls.filter(([c]) => c === 'page:set-crash-reports').map(([, v]) => v));
const note = (page) => page.$eval('#crash-note', (n) => n.textContent);

for (const scheme of ['light', 'dark']) {
  test(`Settings › Privacy in ${scheme}: crash reports are off, say what they send, and turn on for the next launch`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    const { page, errors } = await openPage('settings', { colorScheme: scheme });
    assert.equal(await page.isChecked('#crash-reports'), false);
    const card = await page.$eval('#crash-reports', (box) => box.closest('section').id);
    assert.equal(card, 'privacy');
    assert.match(await page.$eval('#crash-desc', (d) => d.textContent), /Lumio version, your system and technical details[\s\S]*next time you open Lumio/);
    assert.equal(await page.$eval('#crash-reports', (b) => b.labels[0] ? b.getAttribute('aria-labelledby') : ''), 'crash-title');
    await page.click('#crash-title');
    assert.deepEqual(await crashCalls(page), [true]);
    assert.equal(await page.isChecked('#crash-reports'), true);
    assert.equal(await note(page), 'Starts the next time you open Lumio.');
    // Readable in this appearance: the note on the card.
    const [fg, bg] = await page.$eval('#crash-note', (n) => {
      const rgb = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      let el = n; let back = 'rgba(0, 0, 0, 0)';
      while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(back)) { back = getComputedStyle(el).backgroundColor; el = el.parentElement; }
      return [rgb(getComputedStyle(n).color), rgb(back)];
    });
    assert.ok(scheme === 'light' ? luminance(bg) > 0.7 : luminance(bg) < 0.05, `the card is ${scheme}`);
    assert.ok(contrast(fg, bg) >= 4.5, `the note reads at ${contrast(fg, bg).toFixed(2)}:1`);
    if (process.env.LUMIO_SHOTS) await (await page.$('#privacy')).screenshot({ path: path.join(process.env.LUMIO_SHOTS, `crash-settings-${scheme}.png`) });
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('Settings: the switch works from the keyboard, shows focus, and turning it off while running stops reports now', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors } = await openPage('settings', { answers: { 'page:crash-reports': { on: true, active: true } } });
  assert.equal(await page.isChecked('#crash-reports'), true);
  assert.equal(await note(page), '');
  await page.focus('#crash-reports');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab'); // keyboard focus, so :focus-visible applies
  assert.equal(await page.evaluate(() => document.activeElement.id), 'crash-reports');
  assert.equal(await page.$eval('#crash-reports + i', (i) => getComputedStyle(i).outlineStyle), 'solid', 'a visible focus ring');
  await page.keyboard.press('Space');
  assert.deepEqual(await crashCalls(page), [false]);
  assert.equal(await note(page), 'Off. Lumio won’t send any more reports.');
  await page.close();
  assert.deepEqual(errors, []);
});

for (const scheme of ['light', 'dark']) {
  test(`welcome in ${scheme}: the last screen offers crash reports once, off until turned on`, { skip: !CHROME && 'Google Chrome not installed' }, async () => {
    const { page, errors } = await openPage('welcome', { colorScheme: scheme });
    // Windows has no Keychain step: Welcome → Import → Done.
    await page.click('[data-step=hello] [data-next]');
    await page.click('#imp-skip');
    assert.equal(await page.evaluate(() => document.querySelector('.step:not([hidden])').dataset.step), 'done');
    const text = await page.$eval('[data-step=done]', (s) => s.innerText);
    assert.match(text, /Help improve Lumio\s*If Lumio crashes, send us a technical report so we can fix it\. You can change this anytime in Settings › Privacy\./);
    assert.equal(await page.isChecked('#crash-reports'), false);
    assert.ok(await page.$eval('#crash-reports + i', (i) => i.getBoundingClientRect().width > 30), 'the switch is drawn');
    await page.click('#crash-title');
    assert.deepEqual(await crashCalls(page), [true]);
    assert.equal(await note(page), 'Starts the next time you open Lumio.');
    if (process.env.LUMIO_SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `crash-welcome-${scheme}.png`) }); }
    await page.keyboard.press('Space'); // the switch has focus after the click: Space turns it back off
    assert.deepEqual(await crashCalls(page), [true, false]);
    assert.equal(await page.isChecked('#crash-reports'), false);
    await page.close();
    assert.deepEqual(errors, []);
  });
}

// The owner's /admin page with a stand-in server; `crashes()` answers
// /api/admin/crashes (a status number for an error) and is asked each time.
async function openAdmin(crashes) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const asked = { crashes: 0 };
  await page.route('**/api/admin/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.endsWith('/spend')) return r.fulfill({ json: { at: now, openrouter: null, lumio: { today: { total: 0, free: 0, paid: 0 }, week: { total: 0, free: 0, paid: 0 }, month: { total: 0, free: 0, paid: 0, byKind: { browser: 0, chat: 0, image: 0 }, calls: 0, checked: 0 } }, people: {}, monthlyRevenue: 0, freeCap: { usedToday: 0, cap: 10 } } });
    if (p.endsWith('/codes')) return r.fulfill({ json: { codes: [] } });
    if (p.endsWith('/crashes')) {
      asked.crashes++;
      const d = crashes();
      return typeof d === 'number' ? r.fulfill({ status: d, json: { error: 'Nope.' } }) : r.fulfill({ json: d });
    }
    return r.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${base}/site/admin.html`);
  return { page, errors, asked };
}

test('/admin › Crashes: groups and the latest reports, escaped, with dumps to download and details that open from the keyboard', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const crashes = {
    days: 30, totals: { reports: 3, last24h: 2, dumps: 1 },
    groups: [
      { version: '0.6.8', signature: 'EXC_BAD_ACCESS in Electron Framework+0x2a3f10', process: 'renderer', count: 2, dumps: 1, firstAt: now - 3600e3, lastAt: now, platforms: ['darwin'], channels: ['stable'] },
      { version: '0.6.8', signature: '<img src=x onerror=alert(1)> at main/a.js:1', process: 'browser', count: 1, dumps: 0, firstAt: now, lastAt: now, platforms: ['win32'], channels: ['beta'] },
    ],
    recent: [
      { id: 'cr_' + 'a'.repeat(24), at: now, version: '0.6.8', platform: 'darwin', arch: 'arm64', channel: 'stable', process: 'renderer', reason: 'EXC_BAD_ACCESS', signature: 'EXC_BAD_ACCESS in Electron Framework+0x2a3f10', message: null, stack: null, dump: `/api/admin/crashes/cr_${'a'.repeat(24)}/dump` },
      { id: 'cr_' + 'b'.repeat(24), at: now - 1000, version: '0.6.8', platform: 'win32', arch: 'x64', channel: 'beta', process: 'browser', reason: 'uncaughtException', signature: '<img src=x onerror=alert(1)> at main/a.js:1', message: 'Error: <b>boom</b>', stack: 'Error: boom\n    at a (main/a.js:1:1)', dump: null },
    ],
  };
  const { page, errors } = await openAdmin(() => crashes);
  await page.waitForSelector('#crashes:not([hidden]) .crash-table');
  assert.match(await page.$eval('#crash-sum', (s) => s.textContent), /^3 reports in the last 30 days, 2 in the last 24 hours, 1 with a minidump\./);
  assert.deepEqual(await page.$$eval('.crash-table tbody tr', (rows) => rows.map((r) => r.querySelector('td').textContent.trim())), ['2', '1']);
  assert.equal(await page.$('.crash-table img'), null, 'signatures are text, not HTML');
  assert.match(await page.$eval('.crash-table tbody tr:nth-child(2)', (r) => r.textContent), /<img src=x onerror=alert\(1\)> at main\/a\.js:1[\s\S]*Windows/);
  assert.equal(await page.$eval('.crash-item a[download]', (a) => a.getAttribute('href')), `/api/admin/crashes/cr_${'a'.repeat(24)}/dump`);
  if (process.env.LUMIO_SHOTS) await (await page.$('#crashes')).screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'crash-admin.png') });
  await page.focus('.crash-item:nth-child(2) summary');
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('.crash-item:nth-child(2)', (d) => d.open), true);
  assert.equal(await page.$eval('.crash-item:nth-child(2) pre', (p) => p.textContent), 'Error: boom\n    at a (main/a.js:1:1)');
  assert.equal(await page.$eval('.crash-item:nth-child(2) p', (p) => p.textContent), 'Error: <b>boom</b>');
  await page.close();
  assert.deepEqual(errors, []);
});

test('the crash report switches keep still for people who turn off motion', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const motion = (page) => page.$eval('#crash-reports + i', (i) => [getComputedStyle(i).transitionDuration, getComputedStyle(i, '::after').transitionDuration]);
  for (const name of ['settings', 'welcome']) {
    const moving = await openPage(name);
    assert.notDeepEqual(await motion(moving.page), ['0s', '0s'], `${name}: the switch slides normally`);
    await moving.page.close();
    const { page, errors } = await openPage(name, { reducedMotion: 'reduce' });
    // (Batch 3's reduced motion leaves at most a millisecond, so transitionend still fires.)
    const still = (d) => String(d).split(',').every((x) => parseFloat(x) <= 0.001);
    assert.ok((await motion(page)).every(still), `${name}: no sliding (${await motion(page)})`);
    // Every other switch on the page too.
    const all = await page.$$eval('.switch i', (list) => list.map((i) => [getComputedStyle(i).transitionDuration, getComputedStyle(i, '::after').transitionDuration]));
    assert.ok(all.length >= 1 && all.every((d) => d.every(still)), `${name}: ${all}`);
    await page.close();
    assert.deepEqual(errors, []);
  }
});

test('/admin › Crashes: says so when there are none, and Refresh shows new ones', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const empty = { days: 30, totals: { reports: 0, last24h: 0, dumps: 0 }, groups: [], recent: [] };
  // A report from an older client: no version, system or details.
  const one = {
    days: 30, totals: { reports: 1, last24h: 1, dumps: 0 },
    groups: [{ version: null, signature: 'process gone: killed', process: null, count: 1, dumps: 0, firstAt: now, lastAt: now, platforms: [], channels: [] }],
    recent: [{ id: 'cr_' + 'c'.repeat(24), at: now, version: null, platform: null, arch: null, channel: null, process: null, reason: 'killed', signature: 'process gone: killed', message: null, stack: null, dump: null }],
  };
  let answer = empty;
  const { page, errors, asked } = await openAdmin(() => answer);
  await page.waitForSelector('#crashes:not([hidden])');
  assert.equal(await page.$eval('#crash-sum', (s) => s.textContent), 'No crash reports in the last 30 days. Only people who turned on crash reports in Lumio Browser send them.');
  assert.equal(await page.$('.crash-table'), null);
  assert.equal(await page.$eval('#crash-latest-title', (h) => h.hidden), true);
  assert.equal(await page.$$eval('.crash-item', (l) => l.length), 0);
  assert.equal(asked.crashes, 1);

  answer = one;
  await page.click('#refresh');
  await page.waitForSelector('.crash-item');
  assert.equal(asked.crashes, 2, 'asked again once');
  assert.match(await page.$eval('#crash-sum', (s) => s.textContent), /^1 report in the last 30 days, 1 in the last 24 hours, 0 with a minidump\./);
  const [count, crash, version, where] = await page.$$eval('.crash-table tbody td', (tds) => tds.map((td) => td.innerText.trim()));
  assert.deepEqual([count, version, where], ['1', '—', '—'], 'no version or system: a dash');
  assert.match(crash, /^process gone: killed\s+unknown process$/);
  assert.equal(await page.$eval('#crash-latest-title', (h) => h.hidden), false);
  await page.focus('.crash-item summary');
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('.crash-item p', (p) => p.textContent), 'No more details.');
  assert.equal(await page.$('.crash-item a[download]'), null, 'no dump, no download link');
  await page.close();
  assert.deepEqual(errors, []);
});

test('/admin › Crashes: if crash reports can’t load, the section stays hidden and the rest of the page works', { skip: !CHROME && 'Google Chrome not installed' }, async () => {
  const { page, errors, asked } = await openAdmin(() => 500);
  await page.waitForSelector('#cards:not([hidden])');
  for (let i = 0; i < 40 && !asked.crashes; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(100); // admin.js has the answer
  assert.equal(asked.crashes, 1);
  assert.equal(await page.$eval('#crashes', (s) => s.hidden), true);
  assert.equal(await page.$eval('#note', (n) => n.hidden), false, 'the spend numbers still show');
  await page.close();
  assert.deepEqual(errors, []);
});
