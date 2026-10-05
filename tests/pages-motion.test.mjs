// Motion on Lumio's own pages: lists change in place (focus survives, new
// rows rise in, removed rows fade and the rest slide up), dialogs animate in
// and out, Settings' side nav follows the scroll, and Customize Lumio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CHROME } from './shell-page.mjs';
import { startPagesServer, openInternal } from './pages-page.mjs';

const skip = CHROME ? false : 'Google Chrome is not installed';
let browser, server, base;
test.before(async () => {
  if (skip) return;
  ({ server, base } = await startPagesServer());
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); server?.close(); });

const now = Date.now();
const dl = (id, extra = {}) => ({ id, name: `${id}.zip`, url: `https://example.com/${id}.zip`, state: 'completed', total: 2e6, exists: true, time: now - 60e3, ...extra });

test('downloads: progress updates in place, keeping focus; new rows rise in; the bar moves with a transform', { skip }, async () => {
  const { page, errors } = await openInternal(browser, base, 'downloads', {
    answers: { 'page:downloads': [dl('a', { state: 'progressing', received: 1e6, total: 1e7 }), dl('b')] },
  });
  await page.waitForSelector('.dl[data-id="a"]');
  const row = await page.evaluateHandle(() => document.querySelector('.dl[data-id="a"]'));
  await page.focus('.dl[data-id="a"] [data-act="pause"]');
  // A second later: more of it, and a new download.
  await page.evaluate((list) => { window.__answers['page:downloads'] = list; }, [dl('c', { time: now }), dl('a', { state: 'progressing', received: 6e6, total: 1e7 }), dl('b')]);
  await page.waitForFunction(() => document.querySelector('.dl[data-id="c"]'), null, { timeout: 3000 });
  assert.equal(await page.evaluate((r) => r.isConnected && document.querySelector('.dl[data-id="a"]') === r, row), true, 'the row is the same element');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.act), 'pause', 'its button kept focus');
  assert.match(await page.textContent('.dl[data-id="a"] .sub'), /6\.0 MB of 10\.0 MB/);
  assert.equal(await page.$eval('.dl[data-id="c"]', (el) => el.classList.contains('enter') || el.getAnimations().length > 0), true, 'the new row rises in');
  await page.waitForFunction(() => !document.querySelector('.dl[data-id="a"] .bar i').getAnimations().length);
  const bar = await page.$eval('.dl[data-id="a"] .bar i', (el) => ({ t: getComputedStyle(el).transitionProperty, m: new DOMMatrix(getComputedStyle(el).transform).a }));
  assert.equal(bar.t, 'transform');
  assert.ok(Math.abs(bar.m - 0.6) < 0.25, `the bar is scaled, not resized (${bar.m})`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('history: a removed entry fades and the rows below slide up', { skip }, async () => {
  const hist = Array.from({ length: 6 }, (_, i) => ({ url: `https://site${i}.example/`, title: `Site ${i}`, time: now - i * 60e3 }));
  const { page, errors } = await openInternal(browser, base, 'history', { answers: { 'page:history': hist } });
  await page.waitForSelector('.item');
  const before = await page.$eval('.item:nth-of-type(3)', (el) => el.getBoundingClientRect().top);
  await page.hover('.item[data-k^="' + (now - 60e3) + '"]');
  await page.click('.item[data-k^="' + (now - 60e3) + '"] [data-act="remove"]');
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 5);
  const sliding = await page.$$eval('.item', (els) => els.filter((e) => e.getAnimations().some((a) => /translateY/.test(JSON.stringify(a.effect.getKeyframes())))).length);
  assert.ok(sliding >= 3, `the rows below slide up (${sliding})`);
  assert.ok(before > 0);
  assert.deepEqual(errors, []);
  await page.close();
});

const SETTINGS = {
  'page:settings': {
    account: { signedIn: false }, profile: { name: 'Test', color: '#7ee2a8', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
    memorySaver: true, memorySaverMinutes: 60, offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google',
    engines: [{ id: 'google', name: 'Google' }], approvalMode: 'ask', showBookmarksBar: false, appearance: 'system',
    ai: { reasoning: 'medium' }, version: '0.6.7', update: null, isDefault: false, importSources: [], sitePermissions: [],
  },
  'page:sync': { on: false, types: {}, requests: [] },
  'page:schedules': { signedIn: false, tasks: [] },
  'page:workflows': { workflows: [] },
  'page:site-tips': { sites: [] },
};

test('settings: the side nav’s highlight follows the scroll and slides; a click scrolls there', { skip }, async () => {
  const { page, errors } = await openInternal(browser, base, 'settings', { answers: SETTINGS, viewport: { width: 1100, height: 700 } });
  const on = () => page.$eval('.side a.on', (a) => a.getAttribute('href'));
  assert.equal(await on(), '#you');
  await page.$eval('#performance', (el) => window.scrollTo(0, el.offsetTop + 10));
  await page.waitForFunction(() => document.querySelector('.side a.on')?.getAttribute('href') === '#performance');
  assert.equal(await page.$eval('.side-ind', (el) => getComputedStyle(el).transitionProperty.includes('transform')), true, 'the highlight slides');
  assert.equal(await page.$eval('.side a.on', (a) => a.getAttribute('aria-current')), 'true');
  await page.click('.side a[href="#about"]');
  assert.equal(await on(), '#about', 'the clicked section at once');
  await page.waitForFunction(() => document.querySelector('#about').getBoundingClientRect().top < 400, null, { timeout: 3000 });
  assert.equal(await on(), '#about');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  assert.equal(await on(), '#about', 'the last section at the very bottom');
  assert.deepEqual(errors, []);
  await page.close();
});

const NEWTAB = { topSites: [{ url: 'https://github.com/', title: 'GitHub' }], bookmarks: [], engine: 'Google', aiReady: true, incognito: false, name: 'Test', chats: [{ id: 'c1', title: 'Trip to Rome', updatedAt: now - 3600e3 }] };

test('Customize Lumio: a sheet slides in from the right; theme, color, background and sections apply; Esc closes it', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await openInternal(browser, base, 'newtab', {
      colorScheme,
      answers: { 'page:newtab-data': NEWTAB, 'page:customize': { background: 'none', shortcuts: true, recent: true, image: null, appearance: 'system', theme: 'blue' } },
    });
    await page.evaluate(() => {
      let s = window.__answers['page:customize'];
      window.__answers['page:customize-set'] = (k, v) => {
        s = { ...s, [k === 'theme' ? 'theme' : k]: v };
        return s;
      };
    });
    await page.waitForSelector('#cz-open');
    await page.click('#cz-open');
    const moving = await page.$eval('#cz-sheet', (el) => el.getAnimations().map((a) => a.transitionProperty));
    assert.ok(moving.includes('transform'), `it slides in (${moving})`);
    await page.waitForFunction(() => !document.querySelector('#cz-sheet').getAnimations().length);
    assert.equal(await page.$eval('#cz-sheet', (el) => Math.round(el.getBoundingClientRect().right)), 1100 - 8, 'at the right edge');
    assert.equal(await page.evaluate(() => document.activeElement?.name), 'cz-appearance', 'focus goes into the sheet');
    assert.equal(await page.$eval('main', (m) => m.inert), true, 'the page behind is inert');
    await page.click('#cz-sheet label:has(> input[name="cz-bg"][value="aurora"])');
    await page.waitForFunction(() => document.body.dataset.bg === 'aurora');
    await page.click('#cz-sheet label:has(> input[name="cz-color"][value="green"])');
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--accent-dark') === '#7ee2a8');
    await page.click('#cz-sheet input[data-key="shortcuts"] + i');
    await page.waitForFunction(() => document.body.classList.contains('no-shortcuts'));
    assert.equal(await page.$eval('#sites', (el) => getComputedStyle(el).display), 'none');
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: `${process.env.LUMIO_SHOTS}/customize-${colorScheme}.png` });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#cz-sheet').hidden);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'cz-open', 'focus comes back to Customize');
    assert.equal(await page.$eval('main', (m) => m.inert), false);
    const calls = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'page:customize-set').map((c) => c.slice(1)));
    assert.deepEqual(calls, [['background', 'aurora'], ['theme', 'green'], ['shortcuts', false]]);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('Customize: no button in incognito', { skip }, async () => {
  const { page } = await openInternal(browser, base, 'newtab', { answers: { 'page:newtab-data': { ...NEWTAB, incognito: true }, 'page:customize': { background: 'none', shortcuts: true, recent: true } } });
  assert.equal(await page.$('#cz-open'), null);
  await page.close();
});
