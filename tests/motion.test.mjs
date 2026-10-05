// Motion in the window's UI, in headless Chrome (see tests/shell-page.mjs):
// the tab strip (open, close, the frozen widths, drag and drop, pinning),
// tab hover cards, the page load line, bars that slide instead of jumping,
// toasts, the address bar's icons, and Reduce Motion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHROME, INIT, tab, startServer, openPage, slowMotion, sample } from './shell-page.mjs';
import { contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);

const skip = !CHROME && 'Google Chrome not installed';
let server, base, browser;
before(async () => {
  if (!CHROME) return;
  ({ server, base } = await startServer());
  browser = await require('playwright-core').chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

const withTabs = (tabs, activeId = tabs[0].id) => ({ ...INIT, tabs: { activeId, tabs } });
const emitTabs = (page, tabs, activeId) => page.evaluate(([t, a]) => window.__emit('tabs', { activeId: a, tabs: t }), [tabs, activeId]);
const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const widths = (page) => page.$$eval('#tabs > .tab:not(.closing)', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));

test('motion tokens: durations, curves and one Reduce Motion rule set', { skip }, async () => {
  const { page, errors } = await openPage(browser, base);
  const tokens = await page.evaluate(() => ['--dur-1', '--dur-3', '--dur-5', '--ease-out', '--ease-spring'].map((t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim()));
  assert.deepEqual(tokens.slice(0, 3), ['90ms', '200ms', '380ms']);
  assert.match(tokens[3], /^cubic-bezier/);
  assert.match(tokens[4], /^linear\(/);
  await page.close();
  assert.deepEqual(errors, []);

  const reduced = await openPage(browser, base, { reducedMotion: 'reduce', init: withTabs([tab(1, { loading: true })]) });
  const looks = await reduced.page.evaluate(() => {
    const s = (el) => getComputedStyle(el);
    return { tab: s(document.querySelector('.tab')).transitionDuration.split(',')[0], spinner: s(document.querySelector('.spinner')).animationIterationCount };
  });
  assert.equal(looks.tab, '0.001s', 'transitions finish at once');
  assert.equal(looks.spinner, 'infinite', 'spinners still turn');
  // A new tab is simply there, at its full width.
  await emitTabs(reduced.page, [tab(1), tab(2)], 2);
  assert.equal(await reduced.page.$$eval('.tab.entering, .tab.closing', (els) => els.length), 0);
  assert.deepEqual(await widths(reduced.page), [220, 220]);
  await reduced.page.close();
  assert.deepEqual(reduced.errors, []);
});

test('tabs: a new one grows in, a closed one folds away, neither on the first draw', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: withTabs([tab(1), tab(2)]) });
  assert.equal(await page.$$eval('.tab.entering, .tab[style]', (els) => els.length), 0, 'the first draw doesn’t animate');
  assert.equal(await page.$eval('.tab', (el) => el.title), '', 'the hover card replaces the tooltip');

  // Opening: its width runs up from nothing while the others keep their place.
  await slowMotion(page);
  const grow = sample(page, () => document.querySelector('#tabs > .tab:nth-child(3)')?.getBoundingClientRect().width ?? -1, 300);
  await emitTabs(page, [tab(1), tab(2), tab(3)], 3);
  const w = (await grow).filter((x) => x >= 0);
  assert.ok(w.some((x) => x > 1 && x < 200), `grows through in-between widths: ${w.join(',')}`);
  await page.waitForFunction(() => !document.querySelector('#tabs.sizing'));
  assert.deepEqual(await widths(page), [220, 220, 220]);
  assert.equal(await page.$$eval('.tab[style*="flex"]', (els) => els.length), 0, 'then back to the strip’s own layout');

  // Closing: the tab folds to nothing, then leaves.
  await emitTabs(page, [tab(1), tab(3)], 3);
  assert.equal(await page.$$eval('.tab.closing', (els) => els.length), 1, 'still there, folding');
  await page.waitForFunction(() => !document.querySelector('.tab.closing'));
  assert.deepEqual(await page.$$eval('#tabs > .tab .title', (els) => els.map((e) => e.textContent)), ['Page 1', 'Page 3']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('tabs: closing with the mouse keeps the others’ widths until the pointer leaves the strip', { skip }, async () => {
  const many = Array.from({ length: 12 }, (_, i) => tab(i + 1));
  const { page, errors } = await openPage(browser, base, { init: withTabs(many, 1) });
  const before = await widths(page);
  assert.ok(before[0] < 220, 'a full strip: tabs share the room');
  // Click the × of the third tab: main is asked to close it.
  const x = await page.$eval('#tabs > .tab:nth-child(3)', (el) => { const r = el.getBoundingClientRect(); return { x: r.right - 14, y: r.top + r.height / 2 }; });
  await page.mouse.move(x.x, x.y);
  await page.mouse.click(x.x, x.y);
  assert.deepEqual((await sent(page, 'tab:close')).at(-1), 3);
  await emitTabs(page, many.filter((t) => t.id !== 3), 1);
  await page.waitForFunction(() => !document.querySelector('.tab.closing'));
  const frozen = await widths(page);
  assert.ok(frozen.every((w) => Math.abs(w - before[0]) <= 1), `widths held: ${frozen.join(',')}`);
  // The next tab's × slid under the pointer.
  const under = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('.x') && document.elementFromPoint(px, py).closest('.tab').querySelector('.title').textContent, [x.x, x.y]);
  assert.equal(under, 'Page 4');
  // Leaving the strip lets them spread out again, smoothly.
  await page.mouse.move(600, 500);
  await page.waitForFunction((w) => document.querySelector('#tabs > .tab').getBoundingClientRect().width > w + 2 && !document.querySelector('#tabs.sizing'), before[0]);
  const after = await widths(page);
  assert.ok(after[0] > before[0], `wider again: ${after[0]} > ${before[0]}`);
  assert.equal(await page.$$eval('.tab[style*="flex"]', (els) => els.length), 0);
  // Middle-click closes too.
  const mid = await page.$eval('#tabs > .tab:nth-child(5)', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; });
  await page.mouse.click(mid.x, mid.y, { button: 'middle' });
  assert.equal((await sent(page, 'tab:close')).length, 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('tabs: dragging moves the tab at once and everything glides into place; pinned tabs stay first', { skip }, async () => {
  const tabs = [tab(1, { pinned: true }), tab(2), tab(3), tab(4)];
  const { page, errors } = await openPage(browser, base, { init: withTabs(tabs, 2) });
  const box = async (n) => page.$eval(`#tabs > .tab:nth-child(${n})`, (el) => el.getBoundingClientRect().toJSON());
  // Drop Page 2 a little past the middle of Page 3.
  const a = await box(2);
  const b = await box(3);
  const dx = b.x + b.width / 2 + 10 - (a.x + a.width / 2);
  await page.mouse.move(a.x + 30, a.y + 15);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + 30 + (dx * i) / 10, a.y + 15);
  assert.equal(await page.$$eval('.tab.dragging', (els) => els.length), 1, 'lifted');
  await page.mouse.up();
  assert.deepEqual((await sent(page, 'tab:move')).at(-1), { id: 2, index: 2 });
  const order = () => page.$$eval('#tabs > .tab .title', (els) => els.map((e) => e.textContent));
  assert.deepEqual(await order(), ['Page 1', 'Page 3', 'Page 2', 'Page 4'], 'in its new place before main answers');
  assert.equal(await page.$eval('#tabs > .tab:nth-child(3)', (el) => el.getAnimations().some((x) => x.id === 'slide')), true, 'landing');
  // A late update in the old order doesn't snap it back; main's answer changes nothing.
  await emitTabs(page, tabs, 2);
  assert.deepEqual(await order(), ['Page 1', 'Page 3', 'Page 2', 'Page 4']);
  await emitTabs(page, [tabs[0], tabs[2], tabs[1], tabs[3]], 2);
  assert.deepEqual(await order(), ['Page 1', 'Page 3', 'Page 2', 'Page 4']);
  // All the way to the end works too.
  const c = await box(3);
  const last = await box(4);
  await page.mouse.move(c.x + 30, c.y + 15);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + 30 + ((last.x + last.width - c.x) * i) / 10, c.y + 15);
  await page.mouse.up();
  assert.deepEqual((await sent(page, 'tab:move')).at(-1), { id: 2, index: 3 });
  await emitTabs(page, [tabs[0], tabs[2], tabs[3], tabs[1]], 2);
  assert.deepEqual(await order(), ['Page 1', 'Page 3', 'Page 4', 'Page 2']);
  // An unpinned tab can't go before a pinned one.
  const d = await box(2);
  const p = await box(1);
  await page.mouse.move(d.x + 30, d.y + 15);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(d.x + 30 - ((d.x - p.x + 40) * i) / 10, d.y + 15);
  await page.mouse.up();
  assert.equal((await sent(page, 'tab:move')).length, 2, 'no move past the pinned tab');
  // Pinning animates the tab to its small size.
  await slowMotion(page);
  const shrink = sample(page, () => document.querySelector('#tabs > .tab:nth-child(2)').getBoundingClientRect().width, 250);
  await emitTabs(page, [tabs[0], { ...tabs[2], pinned: true }, tabs[3], tabs[1]], 2);
  const w = await shrink;
  assert.ok(w.some((x) => x > 41 && x < 210), `shrinks through: ${w.join(',')}`);
  await page.waitForFunction(() => Math.round(document.querySelector('#tabs > .tab:nth-child(2)').getBoundingClientRect().width) === 40);
  // The right-click menu still opens.
  await page.click('#tabs > .tab:nth-child(3)', { button: 'right' });
  assert.equal((await sent(page, 'tab:context')).length, 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('tab hover cards: after a moment on a tab, at once on the next, and gone when the pointer leaves', { skip }, async () => {
  const tabs = [tab(1), tab(2, { title: 'Sleepy', sleeping: true, url: 'https://www.sleepy.example/a' }), tab(3)];
  const { page, errors } = await openPage(browser, base, { init: withTabs(tabs, 1) });
  const center = (n) => page.$eval(`#tabs > .tab:nth-child(${n})`, (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const cards = () => sent(page, 'tab:hovercard');
  await page.mouse.move(...await center(2));
  await page.waitForTimeout(250);
  assert.equal((await cards()).length, 0, 'waits a moment');
  await page.waitForFunction(() => window.__sent.some(([c]) => c === 'tab:hovercard'), null, { timeout: 2000 });
  const [first] = await cards();
  assert.equal(first.card.id, 2);
  assert.equal(first.card.site, 'sleepy.example');
  assert.equal(first.card.sleeping, true);
  assert.ok(first.rect.y >= 30 && first.rect.width > 240, 'a view under the strip, wide enough to slide in');
  // Next tab: no waiting, and the card moves over.
  await page.mouse.move(...await center(3));
  await page.waitForTimeout(150);
  const second = (await cards()).at(-1);
  assert.equal(second.card.id, 3);
  assert.ok(second.card.x > first.card.x);
  // Leaving the strip hides it; clicking a tab hides it at once.
  await page.mouse.move(640, 600);
  await page.waitForFunction(() => window.__sent.filter(([c]) => c === 'tab:hovercard').at(-1)[1].hide === true);
  // Back on the strip right away: no waiting again. A click hides it at once.
  await page.mouse.move(...await center(1));
  assert.equal((await cards()).at(-1).card?.id, 1);
  await page.mouse.down();
  await page.mouse.up();
  assert.equal((await cards()).at(-1).hide, true);
  assert.deepEqual((await sent(page, 'tab:activate')).at(-1), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('tab hover card in the overlay: title, site, sleeping, picture, and it glides between tabs', { skip }, async () => {
  for (const colorScheme of ['dark', 'light']) {
    const { page, errors } = await openPage(browser, base, { file: 'overlay.html', colorScheme, viewport: { width: 900, height: 320 } });
    const send = (p) => page.evaluate((x) => window.__emit('overlay-data', x), p);
    const show = (p) => send({ kind: 'hovercard', width: 900, height: 300, ...p });
    // Drawn first, then on screen (main/window.js showOverlay).
    await show({ op: 'show', seq: 1, id: 2, x: 30, title: 'Sleepy', site: 'sleepy.example', sleeping: true, shot: true, preview: null });
    const [ready] = await sent(page, 'overlay:ready');
    assert.equal(ready.seq, 1);
    assert.ok(ready.height > 100 && ready.height < 300, `as tall as the card: ${ready.height}`);
    await send({ op: 'in', seq: 1 });
    assert.match(await page.textContent('#card'), /Sleepy\s*sleepy\.example\s*Sleeping \(saved memory\)/);
    assert.equal(await page.$$eval('.hc-shot img', (els) => els.length), 0, 'a placeholder until the picture comes');
    const pic = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await show({ id: 2, x: 30, title: 'Sleepy', site: 'sleepy.example', sleeping: true, shot: true, preview: pic });
    assert.equal(await page.$eval('.hc-shot img', (el) => el.getAttribute('src')), pic);
    // Moving to another tab glides the card there.
    await slowMotion(page);
    const xs = sample(page, () => parseFloat(getComputedStyle(document.getElementById('card')).translate) || 0, 300);
    await show({ id: 3, x: 300, title: 'Page 3', site: 'site3.example', shot: false });
    const moved = await xs;
    assert.ok(moved.some((x) => x > 31 && x < 299), `glides: ${moved.map(Math.round).join(',')}`);
    await slowMotion(page, 1);
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('card')).translate) === 300);
    assert.ok((await sent(page, 'overlay:size')).length, 'a new card reports its height');
    // Text reads well on the card in both appearances.
    const c = await readColors(page, { tokens: ['--muted', '--text'], parts: ['#card'] });
    assert.ok(contrast(c.tokens['--muted'], c.parts['#card']) >= 4.5, `${colorScheme}: site name contrast`);
    // The pointer reaching the card's view means it left the tab: the card
    // vanishes at once, and the view goes once that's drawn.
    await page.mouse.move(400, 200);
    assert.equal(await page.$eval('#card', (el) => getComputedStyle(el).opacity), '0');
    await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'tab:hovercard' && p.now));
    assert.deepEqual((await sent(page, 'tab:hovercard')).at(-1), { hide: true, now: true });
    // Then another dropdown gets the plain card back.
    await send({ op: 'out', seq: 2, now: true });
    await send({ op: 'show', seq: 3, kind: 'suggest', items: [{ type: 'search', title: 'x' }], selected: 0, width: 600, height: 64 });
    assert.equal(await page.evaluate(() => document.body.dataset.kind), 'suggest');
    assert.equal(await page.$eval('#card', (el) => el.style.getPropertyValue('--x')), '');
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('page load progress: a line under the address that follows main’s steps, then fills and fades', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: withTabs([tab(1), tab(2)]) });
  const look = () => page.evaluate(() => {
    const o = document.getElementById('omnibox');
    return { on: o.classList.contains('loading'), p: Number(o.style.getPropertyValue('--load')), scale: new DOMMatrix(getComputedStyle(o, '::after').transform).a };
  });
  assert.equal((await look()).on, false);
  await emitTabs(page, [tab(1, { loading: true, progress: 0.1 }), tab(2)], 1);
  let l = await look();
  assert.equal(l.on, true);
  assert.ok(l.p > 0.1 && l.p < 0.35, `creeps toward the next step: ${l.p}`);
  await page.waitForTimeout(300);
  assert.ok((await look()).scale > 0.05, 'moving');
  await emitTabs(page, [tab(1, { loading: true, progress: 0.7 }), tab(2)], 1);
  assert.ok((await look()).p > 0.7);
  await emitTabs(page, [tab(1, { progress: 1 }), tab(2)], 1);
  assert.equal((await look()).p, 1, 'fills');
  await page.waitForFunction(() => !document.getElementById('omnibox').classList.contains('loading'));
  // Switching to a tab that's loading shows its line at once, where it is.
  await emitTabs(page, [tab(1), tab(2, { loading: true, progress: 0.35 })], 2);
  l = await look();
  assert.equal(l.on, true);
  assert.ok(Math.abs(l.scale - 0.35) < 0.05, `starts where that tab is: ${l.scale}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('bars slide instead of jumping: bookmarks, the permission bar (the page follows), downloads; find floats over the address', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: withTabs([tab(1), tab(2, { url: '' , title: 'New Tab' })]) });
  // The bookmarks bar, turned on: slides open.
  await slowMotion(page, 0.5);
  const bm = sample(page, () => document.getElementById('bookmarks-bar').getBoundingClientRect().height, 300);
  await page.evaluate(() => window.__emit('bookmarks', { show: true, items: [{ url: 'https://a.example/', title: 'Alpha' }] }));
  const hs = await bm;
  assert.ok(hs.some((h) => h > 1 && h < 31), `slides: ${hs.map(Math.round).join(',')}`);
  await page.waitForFunction(() => document.getElementById('bookmarks-bar').getBoundingClientRect().height === 32);
  // ...and shut. A tab switch shows or hides it at once.
  await page.evaluate(() => window.__emit('bookmarks', { show: false, items: [] }));
  await page.waitForFunction(() => document.getElementById('bookmarks-bar').hidden && getComputedStyle(document.getElementById('bookmarks-bar')).display === 'none');
  await emitTabs(page, [tab(1), tab(2, { url: '', title: 'New Tab' })], 2);
  assert.equal(await page.evaluate(() => document.getElementById('bookmarks-bar').getBoundingClientRect().height), 32, 'the new tab page shows it at once');
  await emitTabs(page, [tab(1), tab(2, { url: '', title: 'New Tab' })], 1);

  // A site asks for a permission: the bar slides in and the page follows it, frame by frame.
  await page.evaluate(() => { window.__sent.length = 0; });
  const perm = sample(page, () => document.getElementById('permbar').getBoundingClientRect().height, 300);
  await page.evaluate(() => window.__emit('permission', { id: 1, host: 'maps.example', label: 'know your location' }));
  const ph = await perm;
  assert.ok(ph.some((h) => h > 1 && h < 37), `slides: ${ph.map(Math.round).join(',')}`);
  const slots = new Set((await sent(page, 'layout:slot')).map((r) => Math.round(r.y)));
  assert.ok(slots.size >= 3, `the page moved smoothly: ${[...slots].join(',')}`);
  await page.click('#permbar [data-act="allow"]');
  assert.deepEqual((await sent(page, 'permission:respond')).at(-1), { id: 1, allow: true, remember: true });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('permbar')).display === 'none');

  // Find in page: over the end of the address bar, which keeps its size.
  const omni = await page.$eval('#omnibox', (el) => el.getBoundingClientRect().toJSON());
  await page.evaluate(() => window.__emit('find-open'));
  await page.waitForTimeout(300);
  const find = await page.$eval('#findbar', (el) => el.getBoundingClientRect().toJSON());
  assert.deepEqual(await page.$eval('#omnibox', (el) => el.getBoundingClientRect().toJSON()), omni, 'the address bar doesn’t shrink');
  assert.ok(Math.abs(find.top - omni.top) < 2 && find.right <= omni.right + 1 && find.right > omni.right - 30, 'anchored to its end');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'find-input');
  await page.keyboard.press('Escape');
  assert.deepEqual((await sent(page, 'find:stop')).length, 1);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('findbar')).display === 'none');

  // The first download opens the button's slot instead of shoving the toolbar.
  const dl = sample(page, () => document.getElementById('downloads').getBoundingClientRect().width, 300);
  await page.evaluate(() => window.__emit('downloads', { items: [{ id: 'a', name: 'f.zip', state: 'progressing', received: 1, total: 4 }], started: true }));
  const dw = await dl;
  assert.ok(dw.some((w) => w > 1 && w < 29), `opens: ${dw.map(Math.round).join(',')}`);
  await page.waitForFunction(() => Math.round(document.getElementById('downloads').getBoundingClientRect().width) === 30);
  assert.deepEqual(errors, []);
  await page.close();
});

test('toasts: a polite live region, newest in front, older ones wait their turn', { skip }, async () => {
  for (const colorScheme of ['dark', 'light']) {
    const { page, errors } = await openPage(browser, base, { colorScheme });
    assert.deepEqual(await page.$eval('#toast', (el) => [el.getAttribute('role'), el.getAttribute('aria-live'), el.hidden]), ['status', 'polite', false]);
    await page.evaluate(() => { window.__emit('toast', { text: 'Bookmarked' }); window.__emit('toast', { text: 'Link copied' }); window.__emit('toast', { text: 'Link copied' }); });
    const stack = () => page.$$eval('.toast:not(.out)', (els) => els.map((e) => [e.textContent, e.style.getPropertyValue('--depth')]));
    assert.deepEqual(await stack(), [['Link copied', '0'], ['Bookmarked', '1']], 'the same note twice is one');
    // It floats over the URL's end: the address field keeps its size.
    const [t, a] = await page.evaluate(() => [document.querySelector('.toast').getBoundingClientRect().right, document.getElementById('address').getBoundingClientRect().right]);
    assert.ok(Math.abs(t - a) < 2, 'just left of the icons');
    const c = await readColors(page, { tokens: [], parts: ['.toast'] });
    const fg = await page.$eval('.toast', (el) => getComputedStyle(el).color);
    const rgb = fg.match(/\d+/g).slice(0, 3).map(Number);
    assert.ok(contrast(rgb, c.parts['.toast']) >= 4.5, `${colorScheme}: readable (${contrast(rgb, c.parts['.toast']).toFixed(2)}:1)`);
    // The front one leaves after its time; then the next comes forward.
    await page.waitForFunction(() => document.querySelectorAll('.toast:not(.out)').length === 1, null, { timeout: 5000 });
    assert.deepEqual(await stack(), [['Bookmarked', '0']]);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('the address bar: icons open their own slot, the URL doesn’t move, and the star pops when bookmarked', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: withTabs([tab(1)]) });
  const left = await page.$eval('#address', (el) => el.getBoundingClientRect().left);
  await slowMotion(page, 0.5);
  const zoom = sample(page, () => document.getElementById('zoom-badge').getBoundingClientRect().width, 300);
  await page.evaluate(() => window.__emit('zoom', { level: 110, zoomed: true }));
  const zw = await zoom;
  assert.ok(zw.some((w) => w > 1 && w < 40), `opens: ${zw.map(Math.round).join(',')}`);
  await slowMotion(page, 1);
  assert.equal(await page.$eval('#address', (el) => el.getBoundingClientRect().left), left, 'the URL stays put');
  await emitTabs(page, [tab(1, { bookmarked: true })], 1);
  assert.equal(await page.$eval('#star', (el) => el.getAnimations().length > 0), true, 'the star pops');
  // Focus: the ring fades in on its own layer.
  await page.click('#address');
  assert.equal(await page.$eval('#omnibox', (el) => el.classList.contains('focused')), true);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('omnibox'), '::before').opacity === '1');
  assert.deepEqual(errors, []);
  await page.close();
});
