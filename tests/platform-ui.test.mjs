// The profile picker, the Task Manager, the account menu's profiles, the
// toolbar's performance buttons and Settings › Performance, in headless
// Chrome with a stand-in for the browser (like shell.test.mjs). Each runs in
// light and dark. Skipped when Google Chrome isn't installed.
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
const skip = !CHROME && 'Google Chrome not installed';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const UI = new Set(['shell', 'overlay', 'picker', 'taskmanager']);

// One server per lumio:// host, since the pages load /assets/… from their root.
const servers = [];
const base = {};
async function serve(host) {
  const hosts = UI.has(host) ? UI : PAGE_HOSTS;
  const server = http.createServer((req, res) => {
    const file = resolveFile(new URL(`lumio://${host}${req.url}`), hosts);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  base[host] = `http://127.0.0.1:${server.address().port}`;
}

let browser;
before(async () => {
  if (!CHROME) return;
  for (const host of ['picker', 'taskmanager', 'shell', 'overlay', 'settings']) await serve(host);
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); servers.forEach((s) => s.close()); });

// Opens a page with a stand-in browser: `answers` are what invoke() returns
// (or `fns`, functions run here in the test, for answers that depend on the
// call). Records window.__sent and window.__calls; window.__emit plays a
// message from the browser. `bridge` is window.lumio (UI) or window.lumioPage (pages).
async function open(host, answers, { colorScheme = 'dark', hash = '', bridge = 'lumio', ready, fns = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  for (const [channel, fn] of Object.entries(fns)) await page.exposeFunction(`__answer_${channel.replace(/\W/g, '_')}`, fn);
  await page.addInitScript(({ answers, bridge, exposed }) => {
    const handlers = {};
    window.__sent = [];
    window.__calls = [];
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    const answer = (channel, args) => (exposed.includes(channel) ? window[`__answer_${channel.replace(/\W/g, '_')}`](...args) : structuredClone(answers[channel] ?? null));
    window[bridge] = {
      invoke: async (channel, ...args) => { window.__calls.push([channel, ...args]); return answer(channel, args); },
      send: (channel, ...args) => window.__sent.push([channel, ...args]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { answers, bridge, exposed: Object.keys(fns) });
  const file = { shell: '/', overlay: '/', picker: '/', taskmanager: '/', settings: '/settings.html' }[host];
  await page.goto(`${base[host]}${file}${hash}`);
  if (ready) await page.waitForFunction(ready, null, { timeout: 10_000 });
  const sent = (channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map((s) => s.slice(1)), channel);
  return { page, errors, sent };
}

// The page's background and text are in the computer's appearance and readable.
async function checkColors(page, scheme, parts = ['body']) {
  const c = await readColors(page, { tokens: ['--text'], parts });
  for (const [part, rgb] of Object.entries(c.parts)) assert.ok(scheme === 'light' ? luminance(rgb) > 0.7 : luminance(rgb) < 0.05, `${part} is ${scheme} (rgb ${rgb})`);
  assert.ok(contrast(c.tokens['--text'], c.parts[parts[0]]) >= 4.5, 'text is readable');
}

const PROFILES = [
  { id: 'default', name: 'Juan', color: '#7ee2a8', theme: 'green', photo: null, email: 'juan@example.com', isDefault: true, open: true },
  { id: 'p0000beef', name: 'Work', color: '#b58cff', theme: 'purple', photo: null, email: null, isDefault: false, open: false },
];

for (const scheme of ['light', 'dark']) {
  test(`profile picker (${scheme}): open, menu, delete with confirmation, add, Guest`, { skip }, async () => {
    const { page, errors, sent } = await open('picker', { 'profiles:state': { profiles: PROFILES, showPicker: true, platform: 'darwin' } }, { colorScheme: scheme, ready: () => document.querySelectorAll('.card').length === 3 });
    await checkColors(page, scheme, ['body', '.card']);
    assert.match(await page.textContent('h1'), /Who’s using Lumio\?/);
    assert.deepEqual(await page.$$eval('.card .name', (els) => els.map((e) => e.textContent)), ['Juan', 'Work', 'Add']);
    assert.equal(await page.textContent('.card[data-id="p0000beef"] .email'), 'Not signed in');
    assert.equal(await page.isChecked('#show-picker'), true);

    // The keyboard moves between profiles; Enter opens one.
    assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'default', 'the first profile has focus');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'p0000beef');
    await page.keyboard.press('Enter');
    assert.deepEqual(await sent('profiles:open'), [['p0000beef']]);

    // The first profile can't be deleted: its menu only has Edit, and Delete does nothing.
    await page.hover('.card[data-id="default"]');
    await page.click('[data-more="default"]');
    assert.equal(await page.isVisible('#menu [data-act=delete]'), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#menu'), false);
    await page.focus('.card[data-id="default"]');
    await page.keyboard.press('Delete');
    assert.equal(await page.isVisible('#confirm'), false);

    // Deleting another asks first; Esc keeps it, Delete deletes it.
    await page.focus('.card[data-id="p0000beef"]');
    await page.keyboard.press('Delete');
    assert.equal(await page.isVisible('#confirm'), true);
    assert.equal(await page.textContent('#confirm-title'), 'Delete “Work”?');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-cancel', 'Cancel is the safe default');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#confirm'), false);
    assert.deepEqual(await sent('profiles:remove'), []);
    await page.click('[data-more="p0000beef"]', { force: true });
    await page.click('#menu [data-act=delete]');
    await page.click('#confirm-delete');
    assert.deepEqual(await sent('profiles:remove'), [['p0000beef']]);
    assert.equal(await page.$$eval('.card', (els) => els.length), 2);

    // Adding: a name and a color (the next free one, arrows change it), then Enter.
    await page.click('#add-card');
    assert.equal(await page.isVisible('#add-form'), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'add-name');
    await page.fill('#add-name', 'Side project');
    assert.equal(await page.textContent('#add-preview .avatar'), 'S');
    await page.focus('#add-colors [aria-checked="true"]');
    const first = await page.getAttribute('#add-colors [aria-checked="true"]', 'data-color');
    await page.keyboard.press('ArrowRight');
    const color = await page.getAttribute('#add-colors [aria-checked="true"]', 'data-color');
    assert.notEqual(color, first);
    await page.focus('#add-name');
    await page.keyboard.press('Enter');
    assert.deepEqual(await sent('profiles:add'), [[{ name: 'Side project', color }]]);

    await page.evaluate(() => window.__emit('profiles-changed', { profiles: [], showPicker: true }));
    await page.click('#add-cancel');
    await page.click('#guest');
    assert.equal((await sent('profiles:guest')).length, 1);
    await page.click('#show-picker');
    assert.deepEqual(await sent('profiles:show-picker'), [[false]]);
    await page.close();
    assert.deepEqual(errors, []);
  });

  test(`Task Manager (${scheme}): processes, sorting, choosing, End process`, { skip }, async () => {
    const MB = 1024 ** 2;
    const rows = [
      { pid: 10, kind: 'browser', title: 'Browser', others: [], favicon: null, memory: 300 * MB, cpu: 2.5, network: null, canEnd: false, canFocus: false },
      { pid: 22, kind: 'tab', title: 'Tab: Mail', others: ['Tab: Calendar'], favicon: null, memory: 520 * MB, cpu: 0.4, network: 2048, canEnd: true, canFocus: true },
      { pid: 31, kind: 'gpu', title: 'GPU process', others: [], favicon: null, memory: 120 * MB, cpu: 9.1, network: null, canEnd: false, canFocus: false },
    ];
    const { page, errors, sent } = await open('taskmanager', { 'taskmanager:list': rows }, { colorScheme: scheme, ready: () => document.querySelectorAll('#rows tr').length === 3 });
    await checkColors(page, scheme, ['body', '.wrap']);
    const order = () => page.$$eval('#rows tr', (trs) => trs.map((tr) => Number(tr.dataset.pid)));
    assert.deepEqual(await order(), [22, 10, 31], 'most memory first');
    assert.deepEqual(await page.$$eval('#row-22 td', (tds) => tds.map((td) => td.textContent.trim())), ['Tab: Mail+1', '520.0 MB', '0.4', '2.0 KB/s', '22']);
    assert.match(await page.textContent('#summary'), /3 processes · 940\.0 MB in all/);
    await page.click('th button[data-key=cpu]');
    assert.deepEqual(await order(), [31, 10, 22], 'CPU, busiest first');
    assert.equal(await page.getAttribute('th:nth-child(3)', 'aria-sort'), 'descending');
    await page.click('th button[data-key=title]');
    assert.deepEqual(await order(), [10, 31, 22], 'names A to Z');
    await page.click('th button[data-key=title]');
    assert.deepEqual(await order(), [22, 31, 10], 'and back');

    // Arrows choose a row; only pages can be ended.
    await page.focus('#rows');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getAttribute('#row-22', 'aria-selected'), 'true');
    assert.equal(await page.getAttribute('#rows', 'aria-activedescendant'), 'row-22');
    assert.equal(await page.isEnabled('#end'), true);
    await page.keyboard.press('Enter');
    assert.deepEqual(await sent('taskmanager:focus'), [[22]]);
    await page.click('#end');
    assert.deepEqual(await sent('taskmanager:end'), [[22]]);
    await page.focus('#rows');
    await page.keyboard.press('End');
    assert.equal(await page.getAttribute('#row-10', 'aria-selected'), 'true');
    assert.equal(await page.isEnabled('#end'), false, 'the browser itself can’t be ended');
    // It refreshes on its own and keeps the choice.
    const calls = await page.evaluate(() => window.__calls.length);
    await page.waitForFunction((n) => window.__calls.length > n, calls, { timeout: 3000 });
    assert.equal(await page.getAttribute('#row-10', 'aria-selected'), 'true');
    await page.close();
    assert.deepEqual(errors, []);
  });
}

const AI = { ready: true, lumio: { signedIn: true, plan: 'free' }, reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], mode: 'ask', running: false };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, title: 'Example', url: 'https://example.com/', favicon: null, loading: false }] },
  downloads: [], panel: { open: false, width: 380 }, ai: AI, bookmarks: { items: [], show: false },
  account: { signedIn: true, name: 'Juan', email: 'juan@example.com', plan: 'free' }, profile: { name: 'Juan', color: '#7ee2a8', theme: 'green' },
  incognito: false, guest: false, profiles: PROFILES.map((p) => ({ ...p, current: p.id === 'default' })), partition: 'persist:lumio',
  perf: { energySaver: false }, extensions: true, platform: 'darwin', version: '0.6.7', update: null,
};

test('the window: whose it is, the account menu’s profiles, and the performance buttons', { skip }, async () => {
  const answers = { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] }, 'perf:alert': null };
  const { page, errors, sent } = await open('shell', answers, { ready: () => document.getElementById('perf-btn') });
  assert.match(await page.title(), /^Example — Lumio Browser \(Juan\)$/, 'several profiles: the title says whose window it is');
  assert.equal(await page.getAttribute('#ext-actions', 'partition'), 'persist:lumio', 'this profile’s extension buttons');

  await page.click('#account-btn');
  const menu = (await sent('overlay:show')).at(-1)[0].payload;
  assert.equal(menu.kind, 'account');
  assert.deepEqual(menu.profiles.map((p) => [p.name, p.current]), [['Juan', true], ['Work', false]]);
  assert.equal(menu.guest, false);

  // A heavy background tab: the Performance issues button, and its popup.
  assert.equal(await page.isVisible('#perf-btn'), false);
  const alert = { tabs: [{ title: 'Video editor', host: 'edit.example', favicon: null, memory: 1.6 * 1024 ** 3, cpu: 4 }], count: 1, memory: 1.6 * 1024 ** 3 };
  await page.evaluate((a) => window.__emit('perf-alert', a), alert);
  assert.equal(await page.isVisible('#perf-btn'), true);
  assert.equal(await page.getAttribute('#perf-btn', 'title'), 'A background tab is using a lot of memory or power');
  await page.click('#perf-btn');
  const pop = (await sent('overlay:show')).at(-1)[0];
  assert.equal(pop.payload.kind, 'perf');
  assert.equal(pop.payload.focus, false, 'a mouse click leaves focus in the window');
  assert.equal(await page.getAttribute('#perf-btn', 'aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent('overlay:hide')).at(-1), ['perf']);
  await page.focus('#perf-btn');
  await page.keyboard.press('Enter');
  assert.equal((await sent('overlay:show')).at(-1)[0].payload.focus, true, 'from the keyboard, the popup takes focus');
  await page.evaluate(() => window.__emit('perf-alert', null));
  assert.equal(await page.isVisible('#perf-btn'), false);

  // Energy Saver: a leaf that opens Settings › Performance.
  assert.equal(await page.isVisible('#energy-btn'), false);
  await page.evaluate(() => window.__emit('perf-state', { energySaver: true }));
  await page.click('#energy-btn');
  assert.equal((await sent('perf:settings')).length, 1);

  // Profiles renamed elsewhere: the title follows.
  await page.evaluate(() => window.__emit('profiles-changed', [{ id: 'default', name: 'Home', current: true }, { id: 'p0000beef', name: 'Work' }]));
  assert.match(await page.title(), /\(Home\)$/);
  await page.close();
  assert.deepEqual(errors, []);
});

test('a Guest window says so, and its menu offers to close Guest', { skip }, async () => {
  const answers = { 'shell:init': { ...INIT, guest: true, account: { signedIn: false }, profile: { name: 'Guest' } }, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] } };
  const { page, errors, sent } = await open('shell', answers, { ready: () => document.getElementById('perf-btn') });
  assert.match(await page.title(), /Lumio Browser \(Guest\)$/);
  assert.equal(await page.$eval('#account-btn .avatar', (el) => el.classList.contains('guest')), true);
  await page.click('#account-btn');
  assert.equal((await sent('overlay:show')).at(-1)[0].payload.guest, true);
  await page.close();
  assert.deepEqual(errors, []);
});

for (const scheme of ['light', 'dark']) {
  test(`the account menu's profiles and the Performance issues popup (${scheme})`, { skip }, async () => {
    const { page, errors, sent } = await open('overlay', {}, { colorScheme: scheme });
    await page.evaluate((profiles) => window.__emit('overlay-data', { kind: 'account', account: { signedIn: true, name: 'Juan', email: 'juan@example.com' }, profile: { name: 'Juan', color: '#7ee2a8' }, profiles }), INIT.profiles);
    assert.match(await page.innerText('.acc-profiles'), /Other profiles\s+W?\s*Work/i);
    assert.equal(await page.$$eval('.acc-profile', (els) => els.length), 1, 'not the current one');
    await page.dispatchEvent('[data-acc="profile:p0000beef"]', 'mousedown');
    assert.deepEqual(await sent('profiles:open'), [['p0000beef']]);
    await page.dispatchEvent('[data-acc="profiles:add"]', 'mousedown');
    assert.deepEqual(await sent('profiles:manage'), [['add']]);
    await page.dispatchEvent('[data-acc="profiles:guest"]', 'mousedown');
    assert.equal((await sent('profiles:guest')).length, 1);

    // In a Guest window: Close Guest, and every profile to switch to.
    await page.evaluate((profiles) => window.__emit('overlay-data', { kind: 'account', guest: true, account: {}, profile: {}, profiles: profiles.map((p) => ({ ...p, current: false })) }), INIT.profiles);
    assert.match(await page.innerText('#card'), /Guest[\s\S]*Close Guest[\s\S]*Profiles[\s\S]*Juan[\s\S]*Work/i);
    await page.dispatchEvent('[data-acc="close-guest"]', 'mousedown');
    assert.equal((await sent('account:close-guest')).length, 1);

    const alert = { tabs: [{ title: 'Video editor', host: 'edit.example', favicon: null, memory: 1.6 * 1024 ** 3, cpu: 4 }, { title: 'Game', host: 'game.example', favicon: null, memory: 200 * 1024 ** 2, cpu: 88 }], count: 3, memory: 2e9 };
    await page.evaluate((a) => window.__emit('overlay-data', { kind: 'perf', alert: a, focus: true }), alert);
    await checkColors(page, scheme, ['#card']);
    assert.match(await page.innerText('#card'), /Performance issues[\s\S]*Video editor[\s\S]*1\.6 GB[\s\S]*Game[\s\S]*88% CPU[\s\S]*and 1 more/);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.pf), 'fix', 'Fix now has focus');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    assert.equal((await sent('perf:fix')).length, 1);
    await page.keyboard.press('Escape');
    assert.equal((await sent('perf:close')).length, 1);
    await page.click('[data-pf=dismiss]');
    assert.equal((await sent('perf:dismiss')).length, 1);
    await page.close();
    assert.deepEqual(errors, []);
  });
}

test('Settings › Performance: Memory Saver modes, sites kept active, Energy Saver, preloading', { skip }, async () => {
  const state = { memorySaver: true, mode: 'balanced', sites: ['youtube.com'], energySaver: true, energySaverWhen: 'low', saving: true, alerts: true, preload: 'standard' };
  // A stand-in for main/perf.js's set(): keeps what's set, cleans up sites.
  const { normalizeSite } = require('../main/perf.js');
  const live = structuredClone(state);
  const setPerf = (key, value) => {
    if (key === 'sites') live.sites = [...new Set(value.map(normalizeSite).filter(Boolean))];
    else live[key] = value;
    return live;
  };
  const pageAnswers = {
    'page:settings': { account: {}, profile: {}, engines: [], ai: {}, importSources: [], sitePermissions: [], platform: 'darwin', appearance: 'system', update: null },
    'page:sync': { on: false, status: 'off', types: {}, requests: [] },
    'page:sync-devices': { ok: true, devices: [] },
    'page:schedules': { tasks: [], signedIn: false },
    'page:workflows': { workflows: [] },
    'page:site-tips': { sites: [] },
    'page:mac-permissions': { accessibility: true, screen: true },
    'page:performance': state,
    'page:profiles': { count: 2, guest: false },
  };
  const { page, errors } = await open('settings', pageAnswers, { bridge: 'lumioPage', fns: { 'page:set-performance': setPerf }, ready: () => document.querySelector('#keep-list li') });
  const calls = (ch) => page.evaluate((c) => window.__calls.filter(([x]) => x === c).map((x) => x.slice(1)), ch);
  assert.equal(await page.isChecked('input[name=mem-mode][value=balanced]'), true);
  assert.equal(await page.isVisible('#energy-now'), true, 'On now while saving');
  assert.match(await page.textContent('#profiles-desc'), /2 profiles on this computer/);

  await page.click('input[name=mem-mode][value=maximum]');
  await page.fill('#keep-input', 'https://www.docs.example.org/x');
  await page.press('#keep-input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('#keep-list li').length === 2);
  assert.deepEqual(await page.$$eval('#keep-list li span', (els) => els.map((e) => e.textContent)), ['youtube.com', 'docs.example.org']);
  await page.fill('#keep-input', 'not a site');
  await page.press('#keep-input', 'Enter');
  await page.waitForFunction(() => document.getElementById('keep-err').textContent.length > 0);
  await page.click('[data-site="youtube.com"]');
  await page.waitForFunction(() => document.querySelectorAll('#keep-list li').length === 1);

  await page.click('#mem-saver + i'); // the switch
  assert.equal(await page.isDisabled('input[name=mem-mode][value=maximum]'), true, 'modes wait while Memory Saver is off');
  await page.click('input[name=energy-when][value=unplugged]');
  await page.click('input[name=preload][value=off]');
  await page.click('#open-task-manager');
  assert.deepEqual((await calls('page:set-performance')).map(([k]) => k), ['mode', 'sites', 'sites', 'sites', 'memorySaver', 'energySaverWhen', 'preload']);
  assert.equal((await calls('page:task-manager')).length, 1);
  await page.close();
  assert.deepEqual(errors, []);
});
