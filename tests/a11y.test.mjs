// Keyboard and accessibility: the tab strip as one Tab stop with arrow keys,
// F6 round the window's parts, focus rings and hover-only controls for the
// keyboard, Reduce Motion (the system's and Lumio's own), and Settings ›
// Accessibility reaching every surface (main/accessibility.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { CHROME, INIT, tab, startServer, openPage } from './shell-page.mjs';
import { startPagesServer, openInternal } from './pages-page.mjs';
const require = createRequire(import.meta.url);
const accessibility = require('../main/accessibility.js');
const { registerPagesProtocol, setPageAttributes } = require('../main/protocol.js');
const theme = require('../main/theme.js');
const { Store } = require('../main/store.js');

const skip = CHROME ? false : 'Google Chrome is not installed';
let browser, server, base, pages;
test.before(async () => {
  if (skip) return;
  ({ server, base } = await startServer());
  pages = await startPagesServer();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); server?.close(); pages?.server.close(); });

const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const emit = (page, ch, payload) => page.evaluate(([c, p]) => window.__emit(c, p), [ch, payload]);
const THREE = { ...INIT, tabs: { activeId: 2, tabs: [tab(1), tab(2), tab(3)] }, bookmarks: { items: [{ url: 'https://a.example/', title: 'A' }], show: true }, panel: { open: true, width: 380 } };
const active = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el?.classList.contains('tab') ? `tab:${el.querySelector('.title').textContent}` : el?.id || el?.className || el?.tagName;
});

test('tab strip: one Tab stop, arrows, Home/End, Enter switches, Delete closes; a visible ring and the × for the keyboard', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: THREE });
  const stops = () => page.$$eval('.tab', (els) => els.map((e) => e.tabIndex));
  assert.deepEqual(await stops(), [-1, 0, -1], 'only the selected tab takes Tab');
  assert.deepEqual(await page.$$eval('.tab button', (els) => [...new Set(els.map((b) => b.tabIndex))]), [-1], 'its buttons stay out of the Tab order');
  await page.focus('#sb-open');
  await page.keyboard.press('Tab');
  assert.equal(await active(page), 'tab:Page 2', 'Tab lands on the selected tab');
  const ring = await page.$eval('.tab:focus', (el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el.querySelector('.x')).opacity]);
  assert.deepEqual(ring, ['solid', '1'], 'a focus ring, and its × shows');
  await page.keyboard.press('ArrowRight');
  assert.equal(await active(page), 'tab:Page 3');
  assert.deepEqual(await stops(), [-1, -1, 0], 'the Tab stop follows focus');
  assert.equal(await page.$eval('.tab:focus .x', (x) => getComputedStyle(x).opacity), '1', 'a background tab’s × shows while it has focus');
  await page.keyboard.press('ArrowRight');
  assert.equal(await active(page), 'tab:Page 1', 'wraps around');
  await page.keyboard.press('End');
  assert.equal(await active(page), 'tab:Page 3');
  await page.keyboard.press('Home');
  assert.equal(await active(page), 'tab:Page 1');
  await page.keyboard.press('Enter');
  assert.deepEqual((await sent(page, 'tab:activate')).at(-1), 1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press(' ');
  assert.deepEqual((await sent(page, 'tab:activate')).at(-1), 2);
  await page.keyboard.press('Delete');
  assert.deepEqual((await sent(page, 'tab:close')).at(-1), 2);
  await page.keyboard.press('Tab');
  assert.notEqual(await active(page), 'tab:Page 1', 'Tab leaves the strip');
  assert.deepEqual(errors, []);
  await page.close();
});

test('F6 and Shift+F6 go round the toolbar, bookmarks bar, page, AI panel and sidebar', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: THREE });
  await page.evaluate(() => document.activeElement?.blur());
  await emit(page, 'focus-pane', { dir: 1 });
  assert.equal(await active(page), 'address', 'the toolbar first');
  assert.equal(await page.$eval('#address', (a) => a.selectionStart === 0 && a.selectionEnd === a.value.length), true, 'with the address selected');
  await emit(page, 'focus-pane', { dir: 1 });
  assert.match(await active(page), /bm-item/, 'then the bookmarks bar');
  await emit(page, 'focus-pane', { dir: 1 });
  assert.equal((await sent(page, 'tab:focus-page')).length, 1, 'then the page');
  await emit(page, 'focus-pane', { dir: 1, fromPage: true });
  assert.equal(await active(page), 'prompt', 'then the AI panel');
  await emit(page, 'focus-pane', { dir: 1 });
  assert.equal(await active(page), 'address', 'the sidebar is closed, so round to the toolbar');
  await emit(page, 'focus-pane', { dir: -1 });
  assert.equal(await active(page), 'prompt', 'Shift+F6 goes back');
  await emit(page, 'focus-pane', { dir: -1 });
  assert.equal((await sent(page, 'tab:focus-page')).length, 2);
  // From the address bar, the tab strip counts as the toolbar too.
  await page.focus('.tab[tabindex="0"]');
  await emit(page, 'focus-pane', { dir: 1 });
  assert.match(await active(page), /bm-item/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Reduce Motion: from the system or from Settings, tabs and the chat appear without moving', { skip }, async () => {
  for (const how of ['system', 'setting']) {
    const { page } = await openPage(browser, base, { init: { ...THREE, panel: { open: true, width: 380 } }, reducedMotion: how === 'system' ? 'reduce' : 'no-preference' });
    if (how === 'setting') await emit(page, 'ui-prefs', { reduceMotion: true });
    await emit(page, 'tabs', { activeId: 4, tabs: [tab(1), tab(2), tab(3), tab(4)] });
    const longest = await page.evaluate(() => Math.max(0, ...document.getAnimations().filter((a) => !a.effect?.target?.classList?.contains('spinner')).map((a) => {
      const t = a.effect.getComputedTiming();
      return (t.activeDuration || 0) + (t.delay || 0);
    })));
    assert.ok(longest <= 2, `${how}: nothing moves for longer than a frame (${longest} ms)`);
    const scripted = await page.evaluate(async () => (await import('./motion.js')).reduced());
    assert.equal(scripted, true, `${how}: scripts skip their animations too`);
    await page.close();
  }
});

test('Settings › Accessibility: the switches save, apply at once, and follow changes from elsewhere; focus rings and larger text', { skip }, async () => {
  const SETTINGS = {
    'page:settings': { account: { signedIn: false }, profile: { name: '', color: '#86b7ff', theme: 'blue' }, startup: 'newtab', platform: 'darwin', searchEngine: 'google', engines: [], approvalMode: 'ask', appearance: 'system', ai: {}, version: '0.6.7', importSources: [], sitePermissions: [] },
    'page:sync': { on: false, types: {}, requests: [] }, 'page:schedules': { tasks: [] }, 'page:workflows': { workflows: [] }, 'page:site-tips': { sites: [] },
    'page:accessibility': { focusRing: false, reduceMotion: false, largerText: false },
  };
  const { page, errors } = await openInternal(browser, pages.base, 'settings', { answers: SETTINGS });
  await page.evaluate(() => {
    let p = window.__answers['page:accessibility'];
    window.__answers['page:accessibility-set'] = (k, v) => { p = { ...p, [k]: v }; return p; };
  });
  assert.equal(await page.$$eval('[data-a11y]', (els) => els.length), 3);
  const size = () => page.$eval('body', (b) => getComputedStyle(b).zoom);
  assert.equal(await size(), '1');
  await page.click('#accessibility label:has([data-a11y="largerText"])');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-large-text'));
  assert.equal(await size(), '1.15', 'the page grows');
  await page.click('#accessibility label:has([data-a11y="focusRing"])');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-focus-ring'));
  await page.focus('.side a[href="#sync"]');
  assert.equal(await page.$eval('.side a[href="#sync"]', (a) => getComputedStyle(a).outlineStyle), 'solid', 'a ring around what has focus');
  // Changed from another window: the switches follow.
  await emit(page, 'ui-prefs', { focusRing: false, reduceMotion: true, largerText: false });
  assert.deepEqual(await page.$$eval('[data-a11y]', (els) => els.map((e) => e.checked)), [false, true, false]);
  assert.deepEqual(await page.evaluate(() => ['data-focus-ring', 'data-reduce-motion', 'data-large-text'].map((a) => document.documentElement.hasAttribute(a))), [false, true, false]);
  assert.deepEqual((await page.evaluate(() => window.__calls.filter((c) => c[0] === 'page:accessibility-set').map((c) => c.slice(1)))), [['largerText', true], ['focusRing', true]]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('controls that only show on hover also show for the keyboard; the window and menus grow their text', { skip }, async () => {
  const now = Date.now();
  const { page } = await openInternal(browser, pages.base, 'history', { answers: { 'page:history': [{ url: 'https://a.example/', title: 'A', time: now }] } });
  await page.focus('.item a.title');
  assert.deepEqual(await page.$eval('.item', (el) => [getComputedStyle(el.querySelector('.acts')).opacity, getComputedStyle(el.querySelector('input')).opacity]), ['1', '1']);
  await page.close();
  const shell = await openPage(browser, base, { init: THREE });
  const before = await shell.page.$eval('.tab .title', (t) => parseFloat(getComputedStyle(t).fontSize));
  await emit(shell.page, 'ui-prefs', { largerText: true });
  const after = await shell.page.$eval('.tab .title', (t) => parseFloat(getComputedStyle(t).fontSize));
  assert.ok(after > before * 1.1, `tab titles grow (${before} → ${after})`);
  await shell.page.close();
});

test('main: the choices are checked, stamped on every page as it’s served, and reach the appearance listeners', async () => {
  assert.deepEqual(accessibility.prefs({ accessibility: { focusRing: 1, reduceMotion: true, nope: true } }), { focusRing: false, reduceMotion: true, largerText: false });
  assert.equal(accessibility.htmlAttrs({ focusRing: true, reduceMotion: false, largerText: true }), ' data-focus-ring="" data-large-text=""');
  let handler;
  registerPagesProtocol({ protocol: { handle: (_s, fn) => { handler = fn; } } });
  setPageAttributes(() => ' data-reduce-motion=""');
  const html = await (await handler(new Request('lumio://newtab/'))).text();
  assert.match(html, /<html data-reduce-motion="" lang="en">/);
  const css = await (await handler(new Request('lumio://newtab/newtab.css'))).text();
  assert.doesNotMatch(css, /data-reduce-motion=""/, 'only HTML is changed');
  setPageAttributes(() => '');
  // Settings › Accessibility changes reach main/theme.js listeners (which
  // send them to the window, overlay and pages).
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-a11y-')), null);
  const nt = new EventEmitter();
  nt.themeSource = 'system';
  nt.shouldUseDarkColors = true;
  theme.init({ store, nativeTheme: nt });
  let calls = 0;
  const stop = theme.onChange(() => { calls++; });
  store.setSetting('accessibility', { largerText: true });
  assert.equal(calls, 1);
  assert.deepEqual(theme.uiPrefs(), { focusRing: false, reduceMotion: false, largerText: true });
  store.setSetting('accessibility', { largerText: true });
  assert.equal(calls, 1, 'no change, no broadcast');
  stop();
});
