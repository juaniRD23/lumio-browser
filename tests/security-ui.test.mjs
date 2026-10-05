// Privacy and security in the browser UI and pages, in headless Chrome with a
// stand-in for the browser: Settings › Security and Tracking protection
// (renderer/pages/security.*), the warning pages (interstitial.*), Safety
// check (settings-safety.js), Check passwords (passwords.js), the device and
// certificate choosers (renderer/ui/overlay-security.*), risky downloads and
// the screen sharing picker (overlay.js), and the sharing bar with the tabs'
// recording dot (capture-bar.*), in light and dark, with the keyboard.
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
const { PROVIDERS } = require('../main/secure-dns.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
// LUMIO_SHOTS=dist/review-shots saves a picture of each screen.
const shot = (page, name, opts = {}) => process.env.LUMIO_SHOTS && page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `${name}.png`), ...opts });

const now = Date.now();
const DAY = 864e5;
// What main/security.js answers (pageState, safetyState, Password Checkup).
const SECURITY = {
  safeBrowsing: 'standard', httpsFirst: false, secureDns: { on: true, provider: 'os', custom: '' }, doNotTrack: false, gpc: true, webrtcProtect: true, autoRevoke: true, lookalikes: true,
  providers: PROVIDERS.map(({ id, name }) => ({ id, name })), lists: { ready: true, updated: now - 5 * 60e3, count: 812345 }, certManager: true, platform: 'darwin', trackers: 'block', trackerSites: 2,
};
const ENTRIES = [
  { id: 'p1', origin: 'https://bank.example.com', site: 'bank.example.com', username: 'ana', weak: false, reused: false, lastUsed: now - DAY },
  { id: 'p2', origin: 'https://mail.example.com', site: 'mail.example.com', username: 'ana@mail', weak: false, reused: true, lastUsed: null },
  { id: 'p3', origin: 'https://shop.test', site: 'shop.test', username: 'ana', weak: true, reused: true, lastUsed: null },
];
const UNCHECKED = { checked: 0, total: 3, compromised: 0, unchecked: 3, reused: 2, weak: 1, flags: { p1: null, p2: null, p3: null } };
const CHECKED = { checked: now, total: 3, compromised: 1, unchecked: 0, reused: 2, weak: 1, flags: { p1: true, p2: false, p3: false } };
const UNUSED = [{ origin: 'https://old.example.com', host: 'old.example.com', cats: ['Location', 'Camera'] }];
const SAFETY = { last: null, unused: UNUSED, autoRevoke: true, safeBrowsing: 'off' };
const LAST = {
  time: now, update: { status: 'available', current: '0.6.7', latest: '0.6.8', error: null },
  passwords: { checked: now, total: 3, compromised: 1, unchecked: 0, reused: 2, weak: 1 }, safeBrowsing: 'off', extensions: { on: 2, unpacked: ['Dev helper'] },
};
const ACCOUNT = { signedIn: true, name: 'Test Person', email: 't@lumio.test', plan: 'plus', planName: 'Plus', paid: true, usage: { windows: [{ id: 'weekly', limit: 100, remaining: 62, used: 38, fullAt: now + DAY }] } };
const ANSWERS = {
  'page:settings': {
    account: ACCOUNT, profile: { name: 'Test', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
    memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
    engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: false, appearance: 'system',
    ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.7', update: null, isDefault: false, importSources: [], sitePermissions: [],
  },
  'page:account': ACCOUNT,
  'page:billing': { ok: false },
  'page:sync': { on: false, status: 'off', types: {}, requests: [] },
  'page:sync-devices': { ok: true, devices: [] },
  'page:schedules': { signedIn: true, tasks: [] },
  'page:workflows': { workflows: [] },
  'page:site-tips': { sites: [] },
  'page:mac-permissions': { accessibility: true, screen: true },
  'page:security': SECURITY,
  'page:security-set': SECURITY,
  'page:site-set-default': true,
  'page:secure-dns-test': { ok: false, error: 'This doesn’t look like a secure DNS provider.' },
  'page:manage-certificates': { ok: false, error: 'Your computer’s certificate manager isn’t available.' },
  'page:safety-state': SAFETY,
  'page:safety-check': { ...SAFETY, last: LAST },
  'page:unused-undo': { ...SAFETY, last: LAST, unused: [] },
  'page:passwords': { available: true, entries: ENTRIES, passkeys: [], never: [], offer: true, autofill: true, unlocked: false, platform: 'darwin' },
  'page:password-checkup': UNCHECKED,
  'page:password-checkup-run': CHECKED,
  'page:interstitial': { type: 'unsafe', threat: 'phishing', url: 'https://evil.example/login', host: 'evil.example', suggested: null, canGoBack: true },
  'page:interstitial-act': true,
};
const WARNINGS = {
  unsafe: ANSWERS['page:interstitial'],
  malware: { type: 'unsafe', threat: 'malware', url: 'http://bad.example/', host: 'bad.example', canGoBack: false },
  https: { type: 'https', url: 'http://plain.example/', host: 'plain.example', canGoBack: true },
  lookalike: { type: 'lookalike', url: 'https://paypa1.test/', host: 'paypa1.test', suggested: 'paypal.com', canGoBack: true },
  form: { type: 'form', url: 'http://forms.example/post', host: 'forms.example', canGoBack: true },
};

let server, browser, base;
before(async () => {
  if (!CHROME) return;
  // /ui/<host>/… is lumio://<host>/…; anything else is lumio://settings/….
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
  if (process.env.LUMIO_SHOTS) fs.mkdirSync(process.env.LUMIO_SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); });

// A page with a stand-in browser, once it has settled (asked for nothing for a
// moment). window.__answers can be changed while it runs.
async function openPage(urlPath, { colorScheme = 'light', answers = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); // no favicons from the internet
  await page.addInitScript((answers) => {
    window.__calls = [];
    window.__answers = answers;
    window.__last = performance.now();
    window.lumioPage = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); window.__last = performance.now(); return structuredClone(window.__answers[channel] ?? null); },
      on: () => {},
    };
  }, { ...ANSWERS, ...answers });
  await page.goto(base + urlPath);
  await settle(page);
  return { page, errors, calls: (channel) => page.evaluate((c) => window.__calls.filter(([x]) => x === c), channel) };
}
const settle = (page) => page.waitForFunction(() => performance.now() - window.__last > 150);
const focused = (page) => page.evaluate(() => document.activeElement?.dataset.act || document.activeElement?.dataset.key || document.activeElement?.id || document.activeElement?.tagName);

// Light pages are light and dark ones dark, with readable text.
function assertScheme(scheme, c, where, tokens = ['--text', '--dim', '--label']) {
  for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.7 : luminance(rgb) < 0.05, `${where} ${part} is ${scheme} (rgb ${rgb})`);
  for (const t of tokens) assert.ok(contrast(c.tokens[t], c.parts.body) >= 4.5, `${where}: ${t} is readable (${contrast(c.tokens[t], c.parts.body).toFixed(2)}:1)`);
}

// ---------------------------------------------------------------- pages
for (const scheme of ['light', 'dark']) {
  test(`security pages in ${scheme}: Security, Tracking protection, Safety check and Check passwords load without errors, readable`, { skip }, async () => {
    for (const [url, title] of [['/security', 'Security'], ['/trackingProtection', 'Tracking protection']]) {
      const { page, errors } = await openPage(url, { colorScheme: scheme });
      assert.equal(await page.textContent('h1'), title);
      const c = await readColors(page, { tokens: ['--text', '--dim', '--label', '--danger-text'], parts: ['body', '.card'] });
      await shot(page, `security${url.replace('/', '-')}-${scheme}`, { fullPage: true });
      await page.close();
      assert.deepEqual(errors, [], `${url}: no errors`);
      assertScheme(scheme, c, url, ['--text', '--dim', '--label', '--danger-text']);
    }
    // Safety check, with its results.
    const { page, errors } = await openPage('/', { colorScheme: scheme });
    await page.click('#safety-card [data-act=check]');
    await page.waitForSelector('.sc-item');
    await settle(page);
    const c = await readColors(page, { tokens: ['--text', '--dim', '--danger-text'], parts: ['body', '#safety-card'] });
    await shot(page, `safety-check-${scheme}`, { clip: await page.$eval('#safety', (el) => { el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 800) }; }) });
    await page.close();
    assert.deepEqual(errors, [], 'settings: no errors');
    assertScheme(scheme, c, 'safety check', ['--text', '--dim', '--danger-text']);
    // Password Checkup, after checking.
    const pw = await openPage('/ui/passwords/', { colorScheme: scheme });
    await pw.page.click('[data-check]');
    await pw.page.waitForSelector('.flag');
    await pw.page.click('.pw-item[data-id=p1]');
    const cp = await readColors(pw.page, { tokens: ['--text', '--danger-strong-text', '--warn-text'], parts: ['body', '.card'] });
    await shot(pw.page, `password-checkup-${scheme}`);
    await pw.page.close();
    assert.deepEqual(pw.errors, [], 'passwords: no errors');
    assertScheme(scheme, cp, 'passwords', ['--text', '--danger-strong-text', '--warn-text']);
  });

  test(`warning pages in ${scheme}: each kind loads without errors; a dangerous site is red, the others follow the theme`, { skip }, async () => {
    for (const [name, info] of Object.entries(WARNINGS)) {
      const { page, errors } = await openPage('/ui/interstitial/', { colorScheme: scheme, answers: { 'page:interstitial': info } });
      const alarm = info.type === 'unsafe';
      assert.equal(await page.evaluate(() => document.body.classList.contains('alarm')), alarm, name);
      assert.equal(await page.getAttribute('#warn', 'aria-busy'), null, `${name}: done loading`);
      const c = await readColors(page, { tokens: ['--text', '--dim', '--alarm-text', '--alarm-dim', '--alarm-btn-text', '--alarm-btn-bg'], parts: ['body'] });
      await shot(page, `interstitial-${name}-${scheme}`);
      await page.close();
      assert.deepEqual(errors, [], `${name}: no errors`);
      if (alarm) {
        assert.ok(luminance(c.parts.body) < 0.2, `${name}: a red page`);
        for (const t of ['--alarm-text', '--alarm-dim']) assert.ok(contrast(c.tokens[t], c.parts.body) >= 4.5, `${name}: ${t} is readable`);
        assert.ok(contrast(c.tokens['--alarm-btn-text'], c.tokens['--alarm-btn-bg']) >= 4.5, `${name}: the safe button is readable`);
      } else assertScheme(scheme, c, name, ['--text', '--dim']);
    }
  });
}

test('Security: Safe Browsing with arrow keys, Always use secure connections, secure DNS and certificates', { skip }, async () => {
  const { page, calls } = await openPage('/security');
  const last = async (c) => (await calls(c)).at(-1);
  assert.match(await page.textContent('#lists'), /Lists updated 5 minutes ago · 812,345 sites/);
  assert.equal(await page.getAttribute('.modes', 'role'), 'radiogroup');
  assert.equal(await page.getAttribute('.modes', 'aria-label'), 'Safe Browsing');
  assert.deepEqual(await page.$$eval('input[data-key]', (is) => is.map((i) => i.getAttribute('aria-label'))), ['Always use secure connections', 'Use secure DNS']);
  // Safe Browsing: an arrow key picks No protection.
  await page.focus('input[name=sb][value=standard]');
  await page.keyboard.press('ArrowDown');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { safeBrowsing: 'off' }]);
  await page.keyboard.press('ArrowUp');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { safeBrowsing: 'standard' }]);
  // HTTPS-First from the keyboard: Tab to its switch and Space.
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'httpsFirst');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.closest('.switch-row')).outlineStyle), 'solid', 'the row shows the focus');
  await page.keyboard.press('Space');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { httpsFirst: true }]);
  // Secure DNS: off hides the provider; a provider; a custom one that's checked first.
  assert.equal(await page.isVisible('#dns-provider'), true);
  await page.click('label:has(input[data-key=dnsOn])');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { secureDns: { on: false } }]);
  assert.equal(await page.isVisible('#dns-provider'), false);
  await page.click('label:has(input[data-key=dnsOn])');
  await settle(page);
  assert.equal(await page.textContent('label[for=dns-provider]'), 'Provider');
  await page.selectOption('#dns-provider', 'cloudflare');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { secureDns: { on: true, provider: 'cloudflare' } }]);
  assert.equal(await page.textContent('#dns-msg'), 'Saved.');
  const before = (await calls('page:security-set')).length;
  await page.selectOption('#dns-provider', 'custom');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Custom secure DNS address');
  assert.equal((await calls('page:security-set')).length, before, 'nothing saved until the address is checked');
  await page.keyboard.type('https://bad.example/');
  await page.keyboard.press('Enter');
  await settle(page);
  assert.deepEqual(await last('page:secure-dns-test'), ['page:secure-dns-test', 'https://bad.example/']);
  assert.match(await page.textContent('#dns-msg'), /doesn’t look like a secure DNS provider/);
  assert.match(await page.getAttribute('#dns-msg', 'class'), /err/);
  assert.equal((await calls('page:security-set')).length, before);
  await page.evaluate(() => { window.__answers['page:secure-dns-test'] = { ok: true }; });
  await page.fill('#dns-custom input', 'https://dns.example/dns-query');
  await page.click('#dns-custom button');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { secureDns: { on: true, provider: 'custom', custom: 'https://dns.example/dns-query' } }]);
  assert.match(await page.textContent('#dns-msg'), /^Saved\./);
  // Manage certificates; when it can't open, it says why.
  await page.click('#certs');
  await settle(page);
  assert.equal((await calls('page:manage-certificates')).length, 1);
  assert.equal(await page.isVisible('#cert-msg'), true);
  assert.match(await page.textContent('#cert-msg'), /certificate manager isn’t available/);
  await page.close();
});

test('Tracking protection: each switch saves its setting; ads and trackers is a site setting', { skip }, async () => {
  const { page, calls } = await openPage('/trackingProtection');
  const last = async (c) => (await calls(c)).at(-1);
  assert.deepEqual(await page.$$eval('input[data-key]', (is) => is.map((i) => [i.dataset.key, i.checked, i.getAttribute('aria-label')])), [
    ['trackers', true, 'Block ads and trackers'],
    ['gpc', true, 'Send Global Privacy Control'],
    ['doNotTrack', false, 'Send a “Do Not Track” request'],
    ['webrtcProtect', true, 'Protect your local network address'],
  ]);
  assert.match(await page.textContent('a[href="/content/trackers"]'), /2 sites/);
  await page.click('label:has(input[data-key=trackers])');
  await settle(page);
  assert.deepEqual(await last('page:site-set-default'), ['page:site-set-default', 'trackers', 'allow']);
  // From the keyboard: Tab past the sites link to Global Privacy Control.
  await page.focus('input[data-key=trackers]');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '/content/trackers');
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'gpc');
  await page.keyboard.press('Space');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { gpc: false }]);
  await page.click('label:has(input[data-key=doNotTrack])');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { doNotTrack: true }]);
  await page.click('label:has(input[data-key=webrtcProtect])');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { webrtcProtect: false }]);
  assert.equal((await calls('page:security-set')).length, 3);
  await page.close();
});

test('a dangerous site: Back to safety has the keyboard; visiting it anyway is only in Details', { skip }, async () => {
  const { page, calls } = await openPage('/ui/interstitial/');
  assert.equal(await page.textContent('h1'), 'Dangerous site');
  assert.equal(await page.title(), 'Dangerous site');
  assert.match(await page.textContent('#lead'), /evil\.example might trick you/);
  assert.equal(await page.getAttribute('#warn', 'aria-labelledby'), 'title');
  assert.equal(await focused(page), 'back', 'the safe choice starts focused');
  assert.equal(await page.isVisible('[data-act=proceed]'), false, 'no way in without opening Details');
  // Shift+Tab to Details, Enter opens them.
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focused(page), 'details');
  assert.equal(await page.getAttribute('[data-act=details]', 'aria-controls'), 'details');
  await page.keyboard.press('Enter');
  assert.equal(await page.getAttribute('[data-act=details]', 'aria-expanded'), 'true');
  assert.equal(await page.textContent('[data-act=details]'), 'Hide details');
  assert.match(await page.textContent('#details'), /public list of sites that steal personal information/);
  // Tab: Back to safety, then the link.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'visit this unsafe site');
  await shot(page, 'interstitial-unsafe-details-light');
  await page.keyboard.press('Enter');
  await settle(page);
  assert.deepEqual(await calls('page:interstitial-act'), [['page:interstitial-act', 'proceed']]);
  // Back to safety.
  await page.click('[data-act=back]');
  await settle(page);
  assert.deepEqual((await calls('page:interstitial-act')).at(-1), ['page:interstitial-act', 'back']);
  // Details close again.
  await page.click('[data-act=details]');
  assert.equal(await page.isVisible('#details'), false);
  await page.close();
});

test('the other warnings: their words and what each button asks', { skip }, async () => {
  const run = async (info, act) => {
    const { page, calls } = await openPage('/ui/interstitial/', { answers: { 'page:interstitial': info } });
    const words = { title: await page.textContent('h1'), buttons: await page.$$eval('#acts button', (bs) => bs.map((b) => [b.textContent, b.dataset.act, b.classList.contains('primary')])), lead: await page.textContent('#lead'), more: await page.isVisible('#more') && await page.textContent('#more'), focus: await focused(page) };
    if (act) { await page.click(`#acts [data-act=${act}]`); await settle(page); words.sent = (await calls('page:interstitial-act')).map(([, a]) => a); }
    await page.close();
    return words;
  };
  const malware = await run(WARNINGS.malware);
  assert.match(malware.lead, /Attackers on bad\.example might try to install dangerous programs/);

  const https = await run(WARNINGS.https, 'proceed');
  assert.equal(https.title, 'Connection is not secure');
  assert.deepEqual(https.buttons, [['Continue to site', 'proceed', false], ['Go back', 'back', true]]);
  assert.equal(https.focus, 'back');
  assert.match(https.more, /Always use secure connections is on in Settings › Security/);
  assert.deepEqual(https.sent, ['proceed']);
  assert.deepEqual((await run(WARNINGS.https, 'back')).sent, ['back']);

  const look = await run(WARNINGS.lookalike, 'suggested');
  assert.equal(look.title, 'Did you mean paypal.com?');
  assert.deepEqual(look.buttons, [['Ignore', 'proceed', false], ['Go to paypal.com', 'suggested', true]]);
  assert.match(look.more, /paypa1\.test isn’t paypal\.com/);
  assert.equal(look.focus, 'suggested');
  assert.deepEqual(look.sent, ['suggested']);
  assert.deepEqual((await run(WARNINGS.lookalike, 'proceed')).sent, ['proceed']);

  const form = await run(WARNINGS.form, 'proceed');
  assert.equal(form.title, 'The information you’re about to submit is not secure');
  assert.deepEqual(form.buttons, [['Send anyway', 'proceed', false], ['Go back', 'back', true]]);
  assert.match(form.lead, /sends your information to forms\.example/);
  assert.deepEqual(form.sent, ['proceed']);

  // The browser restarted and forgot the warning: only Go back.
  const gone = await run(null);
  assert.deepEqual(gone.buttons, [['Go back', 'back', true]]);
  assert.match(gone.lead, /can’t show this warning anymore/);
});

test('Safety check: runs from the keyboard and shows each result; Turn on, Allow again and the switch', { skip }, async () => {
  const { page, calls } = await openPage('/');
  const last = async (c) => (await calls(c)).at(-1);
  // Before a check: the button, removed permissions, and what Security is set to.
  assert.equal(await page.textContent('#safety-card [data-act=check]'), 'Check now');
  assert.match(await page.textContent('.sc-site'), /old\.example\.com[\s\S]*Location, Camera/);
  assert.match(await page.textContent('#security-desc'), /^Standard protection$/);
  assert.equal(await page.textContent('#tracking-desc'), 'Ads and trackers blocked · Global Privacy Control on');
  assert.equal(await page.getAttribute('#safety-status', 'aria-live'), 'polite');
  await page.focus('#safety-card [data-act=check]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sc-item');
  await settle(page);
  assert.equal((await calls('page:safety-check')).length, 1);
  assert.equal(await focused(page), 'check', 'focus stays on the button');
  assert.equal(await page.textContent('#safety-card [data-act=check]'), 'Check again');
  assert.equal(await page.textContent('#safety-status'), 'Checked just now');
  const results = await page.$$eval('.sc-item', (els) => els.map((e) => [e.classList[2], e.querySelector('.title').textContent]));
  assert.deepEqual(results, [
    ['warn', 'An update is available: Lumio Browser 0.6.8'],
    ['bad', '1 compromised password'],
    ['bad', 'Safe Browsing is off'],
    ['warn', '1 extension not from the Chrome Web Store'],
  ]);
  assert.equal(await page.getAttribute('.sc-item.bad a.btn', 'href'), 'lumio://passwords/');
  assert.match(await page.textContent('.sc-item.bad .desc'), /Change it now: it appeared in a data breach/);
  await page.click('[data-act=update]');
  assert.equal((await calls('page:update-now')).length, 1);
  await page.click('[data-act=sb-on]');
  await settle(page);
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { safeBrowsing: 'standard' }]);
  assert.equal(await page.$$eval('.sc-item .title', (ts) => ts[2].textContent), 'Safe Browsing is on');
  await page.click('[data-undo="https://old.example.com"]');
  await settle(page);
  assert.deepEqual(await last('page:unused-undo'), ['page:unused-undo', 'https://old.example.com']);
  assert.equal(await page.$$eval('.sc-site', (els) => els.length), 0);
  assert.equal(await page.getAttribute('#auto-revoke', 'aria-label'), 'Remove permissions from unused sites');
  await page.click('.sc-toggle');
  assert.deepEqual(await last('page:security-set'), ['page:security-set', { autoRevoke: false }]);
  await page.close();
});

test('Check passwords: counts, the Compromised flag on each entry, and the filters', { skip }, async () => {
  const { page, calls } = await openPage('/ui/passwords/');
  const flags = () => page.$$eval('.pw-item', (els) => els.map((e) => [e.dataset.id, [...e.querySelectorAll('.flag')].map((f) => f.textContent)]));
  assert.match(await page.textContent('.checkup-status'), /Not checked for data breaches yet/);
  assert.deepEqual(await page.$$eval('#checkup [data-filter]', (bs) => bs.map((b) => b.textContent)), ['2 reused', '1 weak']);
  assert.deepEqual(await flags(), [['p1', []], ['p2', ['Reused']], ['p3', ['Reused', 'Weak']]]);
  // Check from the keyboard.
  await page.focus('[data-check]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-filter=compromised]');
  await settle(page);
  assert.equal((await calls('page:password-checkup-run')).length, 1);
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-check')), true, 'focus stays on Check passwords');
  assert.deepEqual(await page.$$eval('#checkup [data-filter]', (bs) => bs.map((b) => b.textContent)), ['1 compromised', '2 reused', '1 weak', 'Show all']);
  assert.match(await page.textContent('.checkup-status'), /^Checked /);
  assert.deepEqual(await flags(), [['p1', ['Compromised']]], 'shows the compromised ones first');
  await page.click('.pw-item[data-id=p1]');
  assert.match(await page.textContent('#detail'), /This password appeared in a data breach/);
  assert.equal(await page.getAttribute('#detail a[href$="change-password"]', 'href'), 'https://bank.example.com/.well-known/change-password');
  await page.click('[data-filter=""]');
  assert.deepEqual(await flags(), [['p1', ['Compromised']], ['p2', ['Reused']], ['p3', ['Reused', 'Weak']]]);
  await page.click('[data-filter=weak]');
  assert.deepEqual(await flags(), [['p3', ['Reused', 'Weak']]]);
  // When the check fails, it says so.
  await page.evaluate(() => { window.__answers['page:password-checkup-run'] = { ...window.__answers['page:password-checkup-run'], error: 'Couldn’t check your passwords. Check your internet connection and try again.' }; });
  await page.click('[data-check]');
  await settle(page);
  assert.match(await page.textContent('.checkup-status'), /Couldn’t check your passwords/);
  await page.close();
});

// ---------------------------------------------------------------- browser UI
const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, reasoning: 'medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false };
const TABS = { activeId: 1, tabs: [{ id: 1, wcId: 11, title: 'Meeting', url: 'https://meet.example.com/abc' }, { id: 2, wcId: 12, title: 'Docs', url: 'https://docs.example.com/' }] };
const INIT = { tabs: TABS, downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false }, account: {}, profile: {}, incognito: false, extensions: false, platform: 'darwin', version: '0.6.7', update: null };
async function openUi(host, { colorScheme = 'light', answers = {} } = {}) {
  const page = await browser.newPage({ viewport: host === 'shell' ? { width: 1200, height: 700 } : { width: 400, height: 560 }, colorScheme });
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
const DEVICE = { kind: 'device', focus: true, device: { id: 3, kind: 'usb', host: 'flash.example.com', what: 'a USB device', scanning: false, items: [{ id: 'u1', name: 'Arduino Uno', sub: 'Arduino LLC' }, { id: 'u2', name: 'Security Key', sub: 'Yubico' }] } };
const CERT = { kind: 'clientcert', focus: true, cert: { id: 9, host: 'intranet.example.com', items: [
  { index: 0, subject: 'Ana Perez', issuer: 'Example Corp CA', subjectLines: ['Ana Perez', 'Example Corp'], issuerLines: ['Example Corp CA'], validStart: now - 100 * DAY, validExpiry: now + 265 * DAY, serial: '01AB', fingerprint: 'sha256/abc=' },
  { index: 1, subject: 'Ana (personal)', issuer: 'Other CA', subjectLines: [], issuerLines: [], validStart: now - DAY, validExpiry: now + DAY, serial: '02CD', fingerprint: 'sha256/def=' },
] } };
const activeOption = (page) => page.evaluate(() => document.activeElement?.closest('[aria-activedescendant]')?.getAttribute('aria-activedescendant'));

for (const scheme of ['light', 'dark']) {
  test(`the device chooser in ${scheme}: arrow keys pick, Enter connects, Esc and Cancel send none`, { skip }, async () => {
    const { page, errors, sent, emit } = await openUi('overlay', { colorScheme: scheme });
    await emit('overlay-data', DEVICE);
    assert.match(await page.textContent('.sc-t'), /flash\.example\.com wants to connect to a USB device/);
    assert.equal(await page.getAttribute('.sc', 'role'), 'dialog');
    assert.equal(await page.getAttribute('.sc-list', 'role'), 'listbox');
    assert.equal(await page.getAttribute('.sc-list', 'aria-labelledby'), 'sc-t');
    await page.waitForFunction(() => document.activeElement?.classList.contains('sc-list'));
    assert.equal(await page.isDisabled('[data-act=ok]'), true, 'nothing chosen yet');
    await page.keyboard.press('Enter');
    assert.equal((await sent('security:choose')).length, 0, 'Enter with nothing chosen does nothing');
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeOption(page), 'sc-o-u1');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeOption(page), 'sc-o-u2', 'stops at the end');
    assert.equal(await page.getAttribute('#sc-o-u2', 'aria-selected'), 'true');
    assert.equal(await page.isDisabled('[data-act=ok]'), false);
    const c = await readColors(page, { tokens: ['--text', '--muted'], parts: ['#card', '.sc-list'] });
    await shot(page, `device-chooser-${scheme}`);
    for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.6 : luminance(rgb) < 0.06, `${part} is ${scheme}`);
    for (const t of ['--text', '--muted']) assert.ok(contrast(c.tokens[t], c.parts['.sc-list']) >= 4.5, `${t} is readable`);
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('security:choose')).at(-1), { kind: 'device', id: 3, value: 'u2' });
    // Again: Esc, then Cancel, then Connect with the mouse.
    await emit('overlay-data', { ...DEVICE, device: { ...DEVICE.device, id: 4 } });
    await page.waitForFunction(() => document.activeElement?.classList.contains('sc-list'));
    await page.keyboard.press('Escape');
    assert.deepEqual((await sent('security:choose')).at(-1), { kind: 'device', id: 4, value: null });
    await emit('overlay-data', { ...DEVICE, device: { ...DEVICE.device, id: 5 } });
    await page.click('[data-act=cancel]');
    assert.deepEqual((await sent('security:choose')).at(-1), { kind: 'device', id: 5, value: null });
    await emit('overlay-data', { ...DEVICE, device: { ...DEVICE.device, id: 6 } });
    await page.click('#sc-o-u1');
    await page.click('[data-act=ok]');
    assert.deepEqual((await sent('security:choose')).at(-1), { kind: 'device', id: 6, value: 'u1' });
    // The chosen device goes away while the list is open; Bluetooth looks for devices.
    await emit('overlay-data', { ...DEVICE, device: { ...DEVICE.device, id: 7 } });
    await page.click('#sc-o-u2');
    await emit('overlay-data', { ...DEVICE, device: { ...DEVICE.device, id: 7, items: [DEVICE.device.items[0]] } });
    assert.equal(await page.isDisabled('[data-act=ok]'), true);
    await emit('overlay-data', { kind: 'device', device: { id: 8, kind: 'bluetooth', host: 'fit.example', what: 'a Bluetooth device', scanning: true, items: [] } });
    assert.equal(await page.textContent('.sc-empty'), 'Looking for devices…');
    await page.close();
    assert.deepEqual(errors, []);
  });

  test(`the certificate chooser in ${scheme}: the first is chosen, details open, End and Enter answer`, { skip }, async () => {
    const { page, errors, sent, emit } = await openUi('overlay', { colorScheme: scheme });
    await emit('overlay-data', CERT);
    assert.match(await page.textContent('.sc-t'), /intranet\.example\.com wants you to sign in with a certificate/);
    await page.waitForFunction(() => document.activeElement?.classList.contains('sc-list'));
    assert.equal(await activeOption(page), 'sc-o-0');
    assert.match(await page.textContent('#sc-o-0 small'), /Issued by Example Corp CA · Valid until/);
    assert.equal(await page.isVisible('#sc-details'), false);
    await page.click('[data-act=details]');
    assert.equal(await page.getAttribute('[data-act=details]', 'aria-expanded'), 'true');
    assert.equal(await page.getAttribute('[data-act=details]', 'aria-controls'), 'sc-details');
    assert.equal(await focused(page), 'details', 'focus stays on the button');
    assert.match(await page.textContent('#sc-details'), /Issued toAna Perez, Example Corp[\s\S]*Serial number01AB[\s\S]*Fingerprintsha256\/abc=/);
    const c = await readColors(page, { tokens: ['--text', '--muted'], parts: ['#card', '.sc-details'] });
    await shot(page, `cert-chooser-${scheme}`);
    for (const t of ['--text', '--muted']) assert.ok(contrast(c.tokens[t], c.parts['.sc-details']) >= 4.5, `${t} is readable on the details`);
    await page.focus('.sc-list');
    await page.keyboard.press('End');
    assert.equal(await activeOption(page), 'sc-o-1');
    assert.match(await page.textContent('#sc-details'), /Issued toAna \(personal\)/, 'details follow the choice');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('security:choose')).at(-1), { kind: 'clientcert', id: 9, value: 1 });
    await emit('overlay-data', { ...CERT, cert: { ...CERT.cert, id: 10 } });
    await page.click('[data-act=cancel]');
    assert.deepEqual((await sent('security:choose')).at(-1), { kind: 'clientcert', id: 10, value: null });
    await page.close();
    assert.deepEqual(errors, []);
  });

  test(`risky downloads and the screen sharing picker in ${scheme}: Keep, Discard, a tab with its sound`, { skip }, async () => {
    const { page, errors, sent, emit } = await openUi('overlay', { colorScheme: scheme });
    await emit('overlay-data', { kind: 'downloads', items: [
      { id: 'd1', name: 'invoice.pdf.exe', state: 'progressing', received: 1e5, total: 2e5, danger: { kind: 'deceptive', title: 'This file’s name is misleading', detail: 'It says it’s a document but it’s a program.' } },
      { id: 'd2', name: 'photo.png', state: 'completed', total: 2e6 },
    ] });
    assert.equal(await page.getAttribute('.dl.danger', 'role'), 'group');
    assert.equal(await page.getAttribute('.dl.danger', 'aria-label'), 'This file’s name is misleading: invoice.pdf.exe');
    assert.deepEqual(await page.$$eval('.dl.danger button', (bs) => bs.map((b) => b.textContent)), ['Discard', 'Keep']);
    const c = await readColors(page, { tokens: ['--text', '--dim', '--danger-text', '--on-danger', '--danger-fill'], parts: ['#card', '.dl.danger'] });
    await shot(page, `download-danger-${scheme}`);
    for (const t of ['--text', '--dim', '--danger-text']) assert.ok(contrast(c.tokens[t], c.parts['.dl.danger']) >= 4.5, `${t} is readable on a risky download`);
    assert.ok(contrast(c.tokens['--on-danger'], c.tokens['--danger-fill']) >= 4.5, 'Discard is readable');
    await page.click('[data-act=keep]');
    assert.deepEqual((await sent('download:action')).at(-1), { id: 'd1', action: 'keep' });
    await page.click('[data-act=discard]');
    assert.deepEqual((await sent('download:action')).at(-1), { id: 'd1', action: 'discard' });
    const clicks = (await sent('download:action')).length;
    await page.focus('[data-act=keep]');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('download:action')).slice(clicks), [{ id: 'd1', action: 'keep' }], 'the keyboard works too, once');
    assert.equal((await sent('overlay:pick')).length, 0, 'the bubble stays open');

    // Screen sharing: a tab, a screen or a window.
    await emit('overlay-data', { kind: 'screenshare', share: { id: 4, host: 'meet.example.com', audio: true, screensOff: false,
      tabs: [{ id: 'web-contents-media-stream://12:1', name: 'Docs', url: 'https://docs.example.com/', favicon: null }],
      sources: [{ id: 'screen:1:0', name: 'Entire screen', screen: true, thumb: '' }, { id: 'window:2:0', name: 'Notes', screen: false, thumb: '' }] } });
    assert.match(await page.textContent('.pk-head'), /meet\.example\.com wants to see your screen/);
    assert.deepEqual(await page.$$eval('.ss-label', (ls) => ls.map((l) => l.textContent)), ['Tab', 'Entire screen', 'Window']);
    assert.match(await page.textContent('.ss-tab'), /Docs[\s\S]*docs\.example\.com/);
    assert.equal(await page.isDisabled('[data-ss=share]'), true);
    assert.equal(await page.isVisible('.ss-audio'), false);
    await page.click('[data-src="screen:1:0"]');
    assert.equal(await page.isVisible('.ss-audio'), false, 'a screen’s sound isn’t offered');
    await page.click('.ss-tab');
    assert.equal(await page.isVisible('.ss-audio'), true, 'a tab’s sound is');
    assert.match(await page.getAttribute('.ss-tab', 'class'), /\bon\b/);
    const s = await readColors(page, { tokens: ['--text', '--muted', '--dim'], parts: ['#card'] });
    await shot(page, `screenshare-${scheme}`);
    for (const t of ['--text', '--muted', '--dim']) assert.ok(contrast(s.tokens[t], s.parts['#card']) >= 4.5, `${t} is readable in the picker`);
    await page.click('#ss-audio');
    assert.equal(await page.isChecked('#ss-audio'), false);
    await page.click('[data-ss=share]');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'screenshare', id: 4, source: 'web-contents-media-stream://12:1', audio: false });
    // With the keyboard: Enter on a window, then on Share; Esc cancels.
    await page.focus('[data-src="window:2:0"]');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('.ss-audio'), false);
    await page.focus('[data-ss=share]');
    await page.keyboard.press('Enter');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'screenshare', id: 4, source: 'window:2:0', audio: false });
    await page.keyboard.press('Escape');
    assert.deepEqual((await sent('overlay:pick')).at(-1), { kind: 'screenshare', id: 4, source: null });
    await page.close();
    assert.deepEqual(errors, []);
  });

  test(`the sharing bar and the recording dot in ${scheme}: Stop sharing sends capture:stop`, { skip }, async () => {
    const { page, errors, sent, emit } = await openUi('shell', { colorScheme: scheme, answers: { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] } } });
    assert.equal(await page.isVisible('#capture-bar'), false);
    await emit('tabs', { ...TABS, tabs: [{ ...TABS.tabs[0], capture: { camera: true, microphone: true, sharedTo: null, screen: 'tab:Docs' } }, { ...TABS.tabs[1], capture: { sharedTo: 'meet.example.com' } }] });
    assert.equal(await page.isVisible('#capture-bar'), true);
    assert.equal(await page.getAttribute('#capture-bar', 'role'), 'status');
    assert.equal(await page.textContent('#capture-bar .cb-t'), 'Sharing “Docs” with meet.example.com');
    const dots = await page.$$eval('.tab .rec-dot', (els) => els.map((e) => [e.hidden, e.getAttribute('role'), e.getAttribute('aria-label')]));
    assert.deepEqual(dots, [[false, 'img', 'Using your camera and microphone · Sharing another tab'], [false, 'img', 'Being shared with meet.example.com']]);
    const c = await readColors(page, { tokens: ['--text', '--on-danger', '--danger-fill'], parts: ['#capture-bar'] });
    await shot(page, `capture-bar-${scheme}`, { clip: { x: 0, y: 0, width: 1200, height: 140 } });
    assert.ok(contrast(c.tokens['--text'], c.parts['#capture-bar']) >= 4.5, 'the bar’s words are readable');
    assert.ok(contrast(c.tokens['--on-danger'], c.tokens['--danger-fill']) >= 4.5, 'Stop sharing is readable');
    // Stop sharing, from the keyboard.
    await page.focus('#capture-bar .cb-stop');
    await page.keyboard.press('Enter');
    assert.deepEqual(await sent('capture:stop'), [11]);
    assert.equal(await page.isDisabled('#capture-bar .cb-stop'), true, 'until the capture really ends');
    // The other tab is being shared; then nothing is.
    await emit('tabs', { activeId: 2, tabs: [{ ...TABS.tabs[0] }, { ...TABS.tabs[1], capture: { sharedTo: 'meet.example.com' } }] });
    assert.equal(await page.textContent('#capture-bar .cb-t'), 'Sharing this tab with meet.example.com');
    await page.click('#capture-bar .cb-stop');
    assert.deepEqual((await sent('capture:stop')).at(-1), 12);
    await emit('tabs', { activeId: 2, tabs: TABS.tabs });
    assert.equal(await page.isVisible('#capture-bar'), false);
    assert.deepEqual(await page.$$eval('.tab .rec-dot', (els) => els.map((e) => e.hidden)), [true, true]);
    // The same sharing again (back to that tab): the bar is drawn again, not left empty.
    await emit('tabs', { activeId: 2, tabs: [{ ...TABS.tabs[0] }, { ...TABS.tabs[1], capture: { sharedTo: 'meet.example.com' } }] });
    assert.equal(await page.textContent('#capture-bar .cb-t'), 'Sharing this tab with meet.example.com');
    await page.close();
    assert.deepEqual(errors, []);
  });
}
