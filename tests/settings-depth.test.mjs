// Settings depth: Languages (main/languages.js), System and Reset settings
// (main/system.js), and the search box at the top of Settings. The logic
// with stand-ins for Electron's session and app; the page in headless Chrome
// with a stand-in for the browser (like platform-ui.test.mjs), in light and
// dark. The headless part is skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { luminance, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const languages = require('../main/languages.js');
const system = require('../main/system.js');
const { Store, DEFAULT_SETTINGS } = require('../main/store.js');
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-settings-'));

// ---------------------------------------------------------------- languages
test('language tags are cleaned up, and Accept-Language lists each base language', () => {
  assert.equal(languages.cleanTag('es_ar'), 'es-AR');
  assert.equal(languages.cleanTag(' ZH-hant-tw '), 'zh-Hant-TW');
  assert.equal(languages.cleanTag('not a language'), null);
  assert.equal(languages.cleanTag(''), null);
  assert.deepEqual(languages.cleanList(['en-US', 'en_us', 'x y', 'fr']), ['en-US', 'fr'], 'no repeats, nothing broken');
  assert.equal(languages.cleanList(Array.from({ length: 40 }, (_, i) => `e${String.fromCharCode(97 + (i % 26))}${i >= 26 ? '-US' : ''}`)).length, 20, 'at most 20');
  assert.deepEqual(languages.cleanList('es'), []);
  assert.equal(languages.acceptLanguages(['es-AR', 'en-US']), 'es-AR,es,en-US,en');
  assert.equal(languages.acceptLanguages(['es-AR', 'en', 'es']), 'es-AR,en,es', 'a base already listed keeps its place');
});

const fakeApp = (preferred = ['es-MX', 'en-US']) => ({ getPreferredSystemLanguages: () => preferred, getLocale: () => 'en-US' });
function fakeSession() {
  const calls = [];
  return {
    calls,
    availableSpellCheckerLanguages: ['en-US', 'es', 'fr'],
    getUserAgent: () => 'UA',
    setUserAgent: (ua, accept) => calls.push(['ua', ua, accept]),
    setSpellCheckerEnabled: (on) => calls.push(['spell', on]),
    setSpellCheckerLanguages: (l) => calls.push(['spell-langs', l]),
    getSpellCheckerLanguages: () => ['en-US'],
  };
}

test('a profile’s sessions follow its languages and spell check, until the session ends', () => {
  const dir = tmp();
  const store = new Store(dir);
  const ses = fakeSession();
  assert.deepEqual(languages.preferred(store, fakeApp()), ['es-MX', 'en-US'], 'the computer’s until changed');
  const detach = languages.attach(ses, store, fakeApp());
  assert.deepEqual(ses.calls.find(([k]) => k === 'ua'), ['ua', 'UA', 'es-MX,es,en-US,en']);
  assert.deepEqual(ses.calls.find(([k]) => k === 'spell'), ['spell', true]);

  ses.calls.length = 0;
  store.setSetting('languages', ['fr-FR']);
  assert.deepEqual(ses.calls.find(([k]) => k === 'ua'), ['ua', 'UA', 'fr-FR,fr'], 'applies as soon as it changes');
  ses.calls.length = 0;
  store.setSetting('panelWidth', 400);
  assert.deepEqual(ses.calls, [], 'other settings don’t touch the session');
  store.setSetting('spellcheck', false);
  assert.deepEqual(ses.calls.find(([k]) => k === 'spell'), ['spell', false]);

  detach();
  ses.calls.length = 0;
  store.setSetting('languages', ['de']);
  assert.deepEqual(ses.calls, [], 'an ended (incognito) session isn’t touched again');
  store.settingsFile.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session that’s gone doesn’t break the settings', () => {
  const dir = tmp();
  const store = new Store(dir);
  const broken = { getUserAgent: () => { throw new Error('destroyed'); }, setSpellCheckerEnabled: () => { throw new Error('destroyed'); } };
  assert.doesNotThrow(() => languages.apply(broken, store, fakeApp()));
  store.settingsFile.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings › Languages: what the page reads and changes', async () => {
  const dir = tmp();
  const root = new Store(path.join(dir, 'root'));
  const store = new Store(path.join(dir, 'p'));
  const ses = fakeSession();
  const handlers = {};
  languages.register({ internalHandle: (ch, hosts, fn) => { assert.deepEqual(hosts, ['settings'], `${ch} is for Settings only`); handlers[ch] = fn; }, rootStore: root, app: fakeApp() });
  const ctx = { w: { profile: { store, session: ses } } };
  const st = handlers['page:languages'](ctx);
  assert.equal(st.ui.setting, 'system');
  assert.equal(st.custom, false);
  assert.ok(st.choices.includes('es-419'));

  assert.equal(handlers['page:set-ui-language'](ctx, 'es').ui.setting, 'es');
  assert.equal(root.settings.uiLanguage, 'es', 'Lumio’s language is app-wide');
  assert.equal(handlers['page:set-ui-language'](ctx, '<script>').ui.setting, 'system', 'anything else is System');

  assert.deepEqual(handlers['page:set-languages'](ctx, ['pt_br', 'bad tag', 'en']).languages, ['pt-BR', 'en']);
  assert.equal(handlers['page:set-languages'](ctx, null).custom, false, 'back to the computer’s');
  handlers['page:set-spellcheck'](ctx, { on: false, languages: ['fr', 'xx-NOPE'] });
  assert.equal(store.settings.spellcheck, false);
  assert.deepEqual(store.settings.spellcheckLanguages, ['fr'], 'only dictionaries the session has');
  root.settingsFile.flush(); store.settingsFile.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- system and reset
test('graphics acceleration and Lumio’s language are read before Electron starts', () => {
  const dir = tmp();
  assert.deepEqual(system.readEarly(dir), { uiLanguage: 'system', hardwareAcceleration: true }, 'first launch');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hardwareAcceleration: false, uiLanguage: 'es' }));
  assert.deepEqual(system.readEarly(dir), { uiLanguage: 'es', hardwareAcceleration: false });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken');
  assert.equal(system.readEarly(dir).hardwareAcceleration, true, 'a broken file keeps acceleration on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings › System: a change waits for a restart; the proxy settings open in the system', () => {
  const dir = tmp();
  const rootStore = new Store(dir);
  const relaunched = [];
  const app = { relaunch: (o) => relaunched.push(o), quit: () => relaunched.push('quit') };
  const sys = new system.System({ app, rootStore, started: { hardwareAcceleration: true }, argv: ['electron', '.', system.RESTARTED] });
  assert.equal(sys.restarted, true);
  assert.equal(sys.pageState().restart, false);
  assert.equal(sys.set('hardwareAcceleration', false).restart, true);
  assert.equal(rootStore.settings.hardwareAcceleration, false);
  assert.equal(sys.set('hardwareAcceleration', true).restart, false, 'back as it started: no restart needed');
  sys.set('appearance', 'dark');
  assert.equal(rootStore.settings.appearance, 'system', 'only its own setting');

  const opened = [];
  const shell = { openExternal: (u) => { opened.push(u); return Promise.resolve(); } };
  assert.equal(sys.openProxySettings(shell), !!system.PROXY_SETTINGS[process.platform]);
  assert.deepEqual(opened, system.PROXY_SETTINGS[process.platform] ? [system.PROXY_SETTINGS[process.platform]] : []);

  const env = process.env.LUMIO_TEST;
  delete process.env.LUMIO_TEST;
  try { assert.equal(sys.relaunch(), true); } finally { if (env !== undefined) process.env.LUMIO_TEST = env; }
  assert.deepEqual(relaunched[0].args.filter((a) => a === system.RESTARTED), [system.RESTARTED], 'marked once');
  assert.equal(relaunched[1], 'quit');
  rootStore.settingsFile.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Reset settings puts settings back and keeps bookmarks, history, passwords and the account', () => {
  const dir = tmp();
  const rootStore = new Store(path.join(dir, 'root'));
  const store = new Store(path.join(dir, 'p'));
  store.setSetting('searchEngine', 'bing');
  store.setSetting('startup', 'newtab');
  store.setSetting('showBookmarksBar', false);
  store.setSetting('languages', ['fr']);
  store.setSetting('spellcheck', false);
  store.setSetting('profile', { ...store.settings.profile, name: 'Work', theme: 'purple' });
  store.marks.add(store.marks.roots[0].id, null, { title: 'Mine', url: 'https://example.com' });
  store.historyFile.data.push({ url: 'https://example.com', title: 'x', time: 1 });
  store.secretsFile.data.lumioToken = 'kept';
  rootStore.setSetting('appearance', 'dark');
  rootStore.setSetting('hardwareAcceleration', false);
  rootStore.setSetting('uiLanguage', 'es');
  let cleared = 0;
  system.resetSettings({ store, permissions: { settings: { clear: () => cleared++ } } }, rootStore);

  assert.equal(store.settings.searchEngine, DEFAULT_SETTINGS.searchEngine);
  assert.equal(store.settings.startup, DEFAULT_SETTINGS.startup);
  assert.equal(store.settings.showBookmarksBar, true);
  assert.equal(store.settings.languages, undefined);
  assert.equal(store.settings.spellcheck, undefined);
  assert.equal(store.settings.profile.theme, DEFAULT_SETTINGS.profile.theme);
  assert.equal(store.settings.profile.name, 'Work', 'the profile’s name stays');
  assert.equal(cleared, 1, 'site permissions');
  assert.equal(rootStore.settings.appearance, 'system');
  assert.equal(rootStore.settings.hardwareAcceleration, true);
  assert.equal(rootStore.settings.uiLanguage, 'system');
  assert.deepEqual(store.bookmarks().map((b) => b.url), ['https://example.com']);
  assert.equal(store.historyFile.data.length, 1);
  assert.equal(store.secretsFile.data.lumioToken, 'kept');
  rootStore.flushAll(); store.flushAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Guest can’t change app-wide settings, restart or reset', async () => {
  const dir = tmp();
  const rootStore = new Store(path.join(dir, 'root'));
  const store = new Store(path.join(dir, 'g'));
  const handlers = {};
  const internalHandle = (ch, _hosts, fn) => { handlers[ch] = fn; };
  const sys = new system.System({ app: { relaunch() { throw new Error('no restart'); }, quit() {} }, rootStore, started: { hardwareAcceleration: true }, argv: [] });
  let resets = 0;
  sys.register({ internalHandle, shell: { openExternal: async () => {} }, onReset: () => resets++ });
  languages.register({ internalHandle, rootStore, app: fakeApp() });
  rootStore.setSetting('appearance', 'dark');
  const ctx = { w: { profile: { guest: true, store, session: fakeSession(), base: { store } } } };
  assert.equal(handlers['page:reset-settings'](ctx), false);
  assert.equal(resets, 0);
  assert.equal(rootStore.settings.appearance, 'dark', 'the owner’s settings stay');
  assert.equal(handlers['page:set-system'](ctx, 'hardwareAcceleration', false).hardwareAcceleration, true);
  assert.equal(await handlers['page:relaunch'](ctx), false);
  handlers['page:set-ui-language'](ctx, 'es');
  assert.equal(rootStore.settings.uiLanguage, undefined);
  rootStore.flushAll(); store.flushAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the page
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let server;
let base;
let browser;
before(async () => {
  if (!CHROME) return;
  server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://settings${req.url}`), PAGE_HOSTS);
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

const LANG_STATE = {
  ui: { setting: 'system', running: 'en', system: 'en', restart: false },
  languages: ['en-US', 'es-419'],
  custom: false,
  choices: ['de', 'en-US', 'es-419', 'fr'],
  spellcheck: { on: true, mac: false, available: ['en-US', 'es', 'fr'], languages: ['en-US'] },
};
const ANSWERS = {
  'page:settings': { account: {}, profile: {}, engines: [], ai: {}, importSources: [], sitePermissions: [], platform: 'darwin', appearance: 'system', update: null },
  'page:sync': { on: false, status: 'off', types: {}, requests: [] },
  'page:sync-devices': { ok: true, devices: [] },
  'page:schedules': { tasks: [], signedIn: false },
  'page:workflows': { workflows: [] },
  'page:site-tips': { sites: [] },
  'page:mac-permissions': { accessibility: true, screen: true },
  'page:performance': { memorySaver: true, mode: 'balanced', sites: [], energySaver: true, energySaverWhen: 'low', saving: false, alerts: true, preload: 'standard' },
  'page:profiles': { count: 1, guest: false },
  'page:system': { platform: 'darwin', hardwareAcceleration: true, restart: false, proxy: true },
  'page:reset-settings': true,
};

// Settings with a stand-in browser. Languages answers follow what's set,
// like main/languages.js; System's follow its switch.
async function openSettings(colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript(({ answers, lang }) => {
    let st = structuredClone(lang);
    let gpu = true;
    window.__calls = [];
    const live = {
      'page:languages': () => st,
      'page:set-languages': (list) => { st = { ...st, languages: list ?? ['en-US', 'es-419'], custom: list != null }; return st; },
      'page:set-ui-language': (v) => { st = { ...st, ui: { ...st.ui, setting: v, restart: v === 'es' } }; return st; },
      'page:set-spellcheck': ({ on, languages }) => { st = { ...st, spellcheck: { ...st.spellcheck, ...(on === undefined ? {} : { on }), ...(languages ? { languages } : {}) } }; return st; },
      'page:set-system': (_k, v) => { gpu = v; return { platform: 'darwin', hardwareAcceleration: gpu, restart: !gpu, proxy: true }; },
    };
    window.lumioPage = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return live[channel] ? structuredClone(live[channel](...args)) : structuredClone(answers[channel] ?? null); },
      send: () => {},
      on: () => () => {},
    };
  }, { answers: ANSWERS, lang: LANG_STATE });
  await page.goto(`${base}/settings.html`);
  await page.waitForFunction(() => document.querySelectorAll('#lang-list li').length === 2 && document.getElementById('sys-gpu').checked, null, { timeout: 10_000 });
  const calls = (ch) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map((x) => x.slice(1)), ch);
  return { page, errors, calls };
}
const shown = (page, sel) => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length).map((e) => e.id || e.textContent.trim()));

for (const scheme of ['light', 'dark']) {
  test(`Settings search (${scheme}): filters every section, marks the words, says when nothing matches`, { skip }, async () => {
    const { page, errors } = await openSettings(scheme);
    const c = await readColors(page, { tokens: ['--text'], parts: ['body'] });
    assert.ok(scheme === 'light' ? luminance(c.parts.body) > 0.7 : luminance(c.parts.body) < 0.05, `the page is ${scheme}`);

    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-search', '“/” jumps to the box');
    await page.keyboard.type('spell');
    await page.waitForFunction(() => document.querySelector('mark.search-hit'));
    assert.deepEqual(await shown(page, 'main.content > section'), ['languages'], 'only the section with a match');
    assert.match(await page.$$eval('mark.search-hit', (els) => els.map((e) => e.textContent).join(' ')), /spell/i);
    assert.equal(await page.isVisible('#ui-lang'), false, 'rows that don’t match hide');
    assert.equal(await page.isVisible('#spell-on + i'), true);
    assert.equal(await page.isVisible('.side a[href="#about"]'), false, 'the side list follows');
    fs.mkdirSync(path.join(ROOT, 'dist', 'review-shots'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'dist', 'review-shots', `settings-search-${scheme}.png`) });

    // Accents and word order don't matter.
    await page.fill('#settings-search', 'acceleration graphics');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('system')).display !== 'none' && getComputedStyle(document.getElementById('languages')).display === 'none');
    await page.fill('#settings-search', 'zzqqxx');
    await page.waitForFunction(() => !document.getElementById('settings-search-empty').hidden);
    assert.equal(await page.textContent('#settings-search-empty'), 'No search results found');
    assert.deepEqual(await shown(page, 'main.content > section'), []);

    // Esc clears it and every section comes back, unmarked.
    await page.focus('#settings-search');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('settings-search-empty').hidden);
    assert.equal(await page.inputValue('#settings-search'), '');
    assert.equal(await page.$$eval('mark.search-hit', (els) => els.length), 0);
    assert.ok((await shown(page, 'main.content > section')).length > 8);
    await page.close();
    assert.deepEqual(errors, []);
  });

  test(`Settings › Languages, System and Reset (${scheme})`, { skip }, async () => {
    const { page, errors, calls } = await openSettings(scheme);
    // Lumio's language: a restart button appears when it'd change.
    assert.deepEqual(await page.$$eval('#ui-lang option', (els) => els.map((e) => e.value)), ['system', 'en', 'es']);
    await page.selectOption('#ui-lang', 'es');
    await page.waitForFunction(() => !document.getElementById('ui-lang-restart').hidden);
    await page.click('#ui-lang-relaunch');

    // Preferred languages: move, add, remove, back to the computer's; the keyboard stays put.
    await page.click('#lang-list [data-tag="es-419"] [data-act="up"]');
    await page.waitForFunction(() => document.querySelector('#lang-list li').dataset.tag === 'es-419');
    assert.equal(await page.evaluate(() => document.activeElement.closest('li')?.dataset.tag), 'es-419', 'focus follows the row');
    await page.selectOption('#lang-add', 'fr');
    await page.waitForFunction(() => document.querySelectorAll('#lang-list li').length === 3);
    await page.click('#lang-list [data-tag="en-US"] [data-act="remove"]');
    await page.waitForFunction(() => document.querySelectorAll('#lang-list li').length === 2);
    assert.equal(await page.isVisible('#lang-system'), true);
    await page.click('#lang-system');
    await page.waitForFunction(() => document.getElementById('lang-system').hidden);
    assert.deepEqual(await calls('page:set-languages'), [[['es-419', 'en-US']], [['es-419', 'en-US', 'fr']], [['es-419', 'fr']], [null]]);

    // Spell check: the dictionaries that fit the languages; off hides them.
    assert.deepEqual(await page.$$eval('#spell-langs [data-spell]', (els) => els.map((e) => e.dataset.spell)), ['en-US', 'es']);
    await page.check('#spell-langs [data-spell="es"]');
    await page.click('#spell-on + i');
    await page.waitForFunction(() => document.getElementById('spell-langs').hidden);
    assert.deepEqual(await calls('page:set-spellcheck'), [[{ languages: ['en-US', 'es'] }], [{ on: false }]]);

    // System: acceleration asks for a restart; the proxy settings open.
    await page.click('#sys-gpu + i');
    await page.waitForFunction(() => !document.getElementById('sys-restart').hidden);
    await page.click('#sys-proxy');
    assert.deepEqual(await calls('page:set-system'), [['hardwareAcceleration', false]]);
    assert.equal((await calls('page:open-proxy-settings')).length, 1);
    assert.equal((await calls('page:relaunch')).length, 1);

    // Reset: asks first, lists what's reset and what stays; Esc and Cancel keep everything.
    await page.click('#reset-open');
    assert.equal(await page.isVisible('#reset-dialog'), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'reset-cancel', 'Cancel is the safe default');
    assert.match(await page.textContent('#reset-dialog .keep'), /bookmarks, history, saved passwords/);
    assert.ok((await page.$$eval('.reset-list li', (els) => els.length)) >= 5);
    await page.screenshot({ path: path.join(ROOT, 'dist', 'review-shots', `settings-reset-${scheme}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#reset-dialog', (d) => d.open), false, 'closed (it fades out: pages.css)');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'reset-open', 'focus comes back');
    await page.click('#reset-open');
    await Promise.all([page.waitForEvent('load'), page.click('#reset-go')]);
    await page.waitForFunction(() => /were reset/.test(document.getElementById('reset-status').textContent), null, { timeout: 10_000 });
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('the new sections’ styles only use theme colors', () => {
  for (const f of ['renderer/pages/settings-extra.css']) {
    const css = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i, `${f}: colors come from theme.css`);
  }
});
