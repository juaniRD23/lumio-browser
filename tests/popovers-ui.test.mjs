// Menus and popovers in headless Chrome (see tests/shell-page.mjs): every
// dropdown comes in from its button each time it opens and leaves before
// main takes its view off (main/window.js showOverlay, tested in
// tests/popovers.test.mjs), omnibox suggestions, the ⋮ menu drawn by the
// overlay, and the window's side of both.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHROME, INIT, startServer, openPage, slowMotion, sample } from './shell-page.mjs';
import { contrast, readColors } from './colors.mjs';
const require = createRequire(import.meta.url);
const { buildBrowserMenu, menuModel } = require('../main/menu.js');

const skip = !CHROME && 'Google Chrome not installed';
let server, base, browser;
before(async () => {
  if (!CHROME) return;
  ({ server, base } = await startServer());
  browser = await require('playwright-core').chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); server?.close(); });

const sent = (page, channel) => page.evaluate((c) => window.__sent.filter(([x]) => x === c).map(([, p]) => p), channel);
const send = (page, payload) => page.evaluate((p) => window.__emit('overlay-data', p), payload);
const opacity = (page, sel = '#card') => page.$eval(sel, (el) => Number(getComputedStyle(el).opacity));
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('every dropdown comes in from its button each time, leaves first, and never shows the last one', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { file: 'overlay.html', viewport: { width: 400, height: 500 } });
  const account = { kind: 'account', account: { signedIn: true, name: 'Ana', email: 'ana@lumio.test', planName: 'Pro' }, profile: {}, width: 344, height: 420, origin: { x: 310, y: -20 } };
  await send(page, { ...account, op: 'show', seq: 1, wait: false });
  // Drawn, unseen, and measured for main.
  assert.match(await page.textContent('#card'), /Ana/);
  assert.equal(await opacity(page), 0);
  const [ready] = await sent(page, 'overlay:ready');
  assert.equal(ready.seq, 1);
  // As tall as what's in it (with room for its shadow), not the height it was given.
  const natural = await page.$eval('#card', (el) => { el.style.height = 'auto'; const h = el.offsetHeight; el.style.height = ''; return h + 24; });
  assert.ok(Math.abs(ready.height - natural) <= 1 && ready.height !== 420, `as tall as the menu: ${ready.height} (${natural})`);
  // It grows from the account button: the origin is that point, from the card's corner.
  assert.equal(await page.$eval('#card', (el) => el.style.transformOrigin), '298px -22px');
  await slowMotion(page);
  const frames = sample(page, () => { const s = getComputedStyle(document.getElementById('card')); return [Number(s.opacity), new DOMMatrix(s.transform).a]; }, 300);
  await send(page, { op: 'in', seq: 1 });
  const seen = await frames;
  assert.ok(seen.some(([o, k]) => o > 0.05 && o < 0.95 && k > 0.95 && k < 1), `fades in and scales up from .96: ${JSON.stringify(seen.slice(0, 6))}`);
  await slowMotion(page, 1);
  await page.waitForFunction(() => !document.getElementById('card').getAnimations().length);
  assert.equal(await opacity(page), 1);

  // Closing: the exit plays, then it tells main the empty frame is drawn.
  await send(page, { op: 'out', seq: 2 });
  assert.ok(await page.$eval('#card', (el) => el.getAnimations().length === 1), 'an exit');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:gone' && p.seq === 2));
  assert.equal(await opacity(page), 0);

  // Every opening comes in again (the page isn't reloaded between them).
  await send(page, { ...account, op: 'show', seq: 3 });
  await send(page, { op: 'in', seq: 3 });
  assert.equal(await page.$eval('#card', (el) => el.getAnimations().length), 1);

  // Another one while this one leaves: the exit is cut short (no overlay:gone
  // for it), the new one is drawn unseen, and it's ready once the cleared
  // frame is on screen.
  await send(page, { op: 'out', seq: 4 });
  await send(page, { kind: 'downloads', items: [], op: 'show', seq: 5, wait: true, width: 384, height: 200 });
  assert.equal(await opacity(page), 0);
  assert.match(await page.textContent('#card'), /Downloads/);
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:ready' && p.seq === 5));
  assert.equal((await sent(page, 'overlay:ready')).at(-1).height, null, 'downloads keeps the size it’s given');
  await send(page, { op: 'in', seq: 5 });
  await page.waitForTimeout(250);
  assert.ok(!(await sent(page, 'overlay:gone')).some((p) => p.seq === 4));
  // New content for what's showing changes it in place, without coming in again
  // (after its entrance has finished, which takes longer on a busy machine).
  await page.waitForFunction(() => !document.getElementById('card').getAnimations().length);
  await send(page, { kind: 'downloads', items: [{ id: 'd1', name: 'file.zip', state: 'completed', total: 2048 }], width: 384, height: 200 });
  assert.match(await page.textContent('#card'), /file\.zip/);
  assert.equal(await page.$eval('#card', (el) => el.getAnimations().length), 0);
  assert.equal(await opacity(page), 1);
  // New content while it waits for that empty frame doesn't hurry it on screen.
  await send(page, { op: 'out', seq: 6 });
  const readies = () => page.evaluate(() => window.__sent.filter(([c]) => c === 'overlay:ready').length);
  const before = await readies();
  const early = await page.evaluate((a) => {
    window.__emit('overlay-data', { ...a, op: 'show', seq: 7, wait: true });
    window.__emit('overlay-data', { ...a, account: { ...a.account, name: 'Ana B' } });
    return window.__sent.filter(([c]) => c === 'overlay:ready').length;
  }, account);
  assert.equal(early, before, 'not before the empty frame');
  await page.waitForFunction((n) => window.__sent.filter(([c]) => c === 'overlay:ready').length > n, before);
  await page.waitForTimeout(50);
  assert.equal(await readies(), before + 1, 'once');
  assert.equal((await sent(page, 'overlay:ready')).at(-1).seq, 7);
  assert.match(await page.textContent('#card'), /Ana B/);
  assert.deepEqual(errors, []);
  await page.close();

  // Reduce Motion: in and out at once.
  const still = await openPage(browser, base, { file: 'overlay.html', reducedMotion: 'reduce', viewport: { width: 400, height: 500 } });
  await send(still.page, { ...account, op: 'show', seq: 1 });
  // (Reduce Motion leaves 1 ms CSS transitions, theme.css: no script animations, though.)
  const scripted = (p) => p.$eval('#card', (el) => el.getAnimations().filter((a) => a.constructor === Animation).length);
  await send(still.page, { op: 'in', seq: 1 });
  assert.equal(await scripted(still.page), 0);
  await still.page.waitForFunction(() => getComputedStyle(document.getElementById('card')).opacity === '1');
  await send(still.page, { op: 'out', seq: 2 });
  assert.equal(await scripted(still.page), 0);
  await still.page.waitForFunction(() => getComputedStyle(document.getElementById('card')).opacity === '0');
  await still.page.waitForFunction(() => window.__sent.some(([c]) => c === 'overlay:gone'));
  assert.deepEqual(still.errors, []);
  await still.page.close();
});

test('omnibox suggestions: site icons, what you typed in bold, kinds, a quick reveal, one highlight', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { file: 'overlay.html', viewport: { width: 640, height: 300 } });
  const items = [
    { type: 'search', title: 'git hub', url: 'https://search.example/?q=git+hub' },
    { type: 'history', title: 'GitHub: where the world builds', url: 'https://github.com/', favicon: PIXEL },
    { type: 'bookmark', title: 'Hub of git tips', url: 'https://tips.example/git' },
    { type: 'bookmark', title: 'Broken icon', url: 'https://broken.example/', favicon: 'https://127.0.0.1:1/nope.ico' },
    { type: 'ai', title: 'git hub' },
  ];
  const suggest = { kind: 'suggest', items, selected: 0, query: 'git hub', width: 640, height: items.length * 38 + 38 };
  await send(page, { ...suggest, op: 'show', seq: 1 });
  await send(page, { op: 'in', seq: 1 });
  const rows = await page.$$eval('.row', (els) => els.map((el) => ({ kind: el.classList[1], lead: el.querySelector('.ic img') ? 'img' : el.querySelector('.ic svg') ? 'svg' : '', html: el.querySelector('.t').innerHTML, url: el.querySelector('.u')?.innerHTML || '', tag: !!el.querySelector('.tag svg'), text: el.textContent })));
  assert.equal(rows[1].lead, 'img', 'the site’s icon');
  assert.ok(rows[1].tag, 'and a clock: it’s from your history');
  assert.equal(rows[2].lead, 'svg', 'no icon saved: a star for a bookmark');
  assert.match(rows[1].html, /^<b>Git<\/b><b>Hub<\/b>: where the world builds$/);
  assert.equal(rows[1].url, '<b>git</b><b>hub</b>.com');
  assert.match(rows[2].html, /<b>Hub<\/b> of <b>git<\/b> tips/);
  assert.doesNotMatch(rows[0].html, /<b>/, 'a search is just what you typed');
  assert.match(rows[0].text, /Search$/);
  assert.match(rows[4].text, /Ask Lumio$/);
  await page.waitForFunction(() => !document.querySelector('.row:nth-of-type(5) .ic img'));
  assert.equal(await page.$$eval('.row .ic img', (els) => els.length), 1, 'an icon that won’t load gives way');
  // The rows come in one after another, all within 120 ms.
  await send(page, { op: 'out', seq: 2, now: true });
  await send(page, { ...suggest, op: 'show', seq: 3 });
  await send(page, { op: 'in', seq: 3 });
  const reveal = await page.$$eval('.row', (els) => els.map((el) => el.getAnimations()[0]?.effect.getComputedTiming()).map((t) => t && [t.delay, t.duration]));
  assert.ok(reveal.every(Boolean), 'every row');
  assert.ok(reveal[1][0] > reveal[0][0] && reveal.at(-1)[0] > reveal[1][0], `one after another: ${JSON.stringify(reveal)}`);
  assert.ok(reveal.every(([d, t]) => d + t <= 120), `within 120 ms: ${JSON.stringify(reveal)}`);

  // One highlight, which glides to the row the arrow keys pick.
  const pillY = () => page.$eval('.sel-pill', (el) => new DOMMatrix(getComputedStyle(el).transform).f);
  const rowY = (i) => page.$eval(`.row[data-i="${i}"]`, (el) => el.offsetTop);
  await page.waitForFunction(() => !document.querySelector('.row').getAnimations().length);
  assert.equal(await pillY(), await rowY(0));
  await page.$eval('.sel-pill', (el) => { el.dataset.same = '1'; });
  await slowMotion(page);
  const ys = sample(page, () => new DOMMatrix(getComputedStyle(document.querySelector('.sel-pill')).transform).f, 250);
  await send(page, { ...suggest, selected: 2 });
  const glide = await ys;
  const [from, to] = [await rowY(0), await rowY(2)];
  assert.ok(glide.some((y) => y > from + 2 && y < to - 2), `glides: ${glide.map(Math.round).join(',')}`);
  await slowMotion(page, 1);
  assert.equal(await page.$eval('.sel-pill', (el) => el.dataset.same), '1', 'the rows weren’t drawn again');
  assert.equal(await page.$$eval('.row[aria-selected=true]', (els) => els.map((el) => el.dataset.i).join()), '2');
  // The pointer moving onto a row selects it there and in the address bar.
  const box = await page.$eval('.row[data-i="3"]', (el) => { const r = el.getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]; });
  await page.mouse.move(box[0] - 20, box[1] - 10);
  await page.mouse.move(...box, { steps: 3 });
  assert.equal((await sent(page, 'overlay:hover')).at(-1), 3);
  await page.waitForFunction((y) => new DOMMatrix(getComputedStyle(document.querySelector('.sel-pill')).transform).f === y, await rowY(3));
  assert.equal(await page.$$eval('.row[aria-selected=true]', (els) => els.length), 1, 'never two highlights');
  assert.deepEqual(errors, []);
  await page.close();
});

// The real ⋮ menu (main/menu.js), with commands that do nothing.
function menuItems(state = {}) {
  const cmd = new Proxy({ isDev: false }, { get: (t, k) => (k in t ? t[k] : () => {}) });
  return menuModel(buildBrowserMenu(cmd, {
    zoom: 100,
    recentlyClosed: [{ label: 'News', index: 0, favicon: PIXEL }],
    bookmarks: [{ url: 'https://a.example/', title: 'A bookmark' }],
    open() {},
    edit() {},
    ...state,
  }), { mac: true }).items;
}

test('the ⋮ menu: under its button, shortcuts, keyboard, submenus that slide out, live zoom, readable in light and dark', { skip }, async () => {
  for (const colorScheme of ['dark', 'light']) {
    const { page, errors } = await openPage(browser, base, { file: 'overlay.html', colorScheme, viewport: { width: 1200, height: 700 } });
    const items = menuItems();
    const id = (label) => items.find((i) => i.label === label)?.id;
    await send(page, { kind: 'menu', items, at: { right: 1190, top: 78 }, origin: { x: 1175, y: 60 }, width: 1200, height: 700, op: 'show', seq: 1 });
    assert.equal((await sent(page, 'overlay:ready'))[0].height, null, 'it covers the window');
    await send(page, { op: 'in', seq: 1 });
    // (Where it's laid out: while it comes in, it's scaled toward ⋮.)
    const panel = await page.$eval('.mpanel', (el) => ({ right: el.offsetLeft + el.offsetWidth, top: el.offsetTop, origin: el.style.transformOrigin, moving: el.getAnimations().length }));
    assert.deepEqual([Math.round(panel.right), Math.round(panel.top)], [1190, 78], 'its corner under ⋮');
    assert.equal(panel.moving, 1, 'it comes in');
    assert.match(panel.origin, /^\d+px -18px$/, 'from the button above it');
    assert.match(await page.textContent('.mi[data-i="0"]'), /New tab\s*⌘T/);
    assert.match(await page.textContent('.mpanel'), new RegExp(String.raw`Zoom\s*100%[\s\S]*Edit\s*Cut\s*Copy\s*Paste[\s\S]*Settings\s*${process.platform === 'darwin' ? '⌘' : '⌃'},`));

    // Keyboard (the window sends its keys while the menu is open).
    const key = (k) => send(page, { op: 'key', key: k });
    const selected = () => page.$eval('.mpanel:last-of-type .mi.sel, .mpanel:last-of-type .mrow button.sel', (el) => el.closest('[data-i]').textContent.trim().split(/\s{2,}|⌘|⇧|⌃/)[0].trim()).catch(() => '');
    await key('ArrowDown');
    assert.equal(await selected(), 'New tab');
    // The panel in use holds the keyboard (when this view has it) and names
    // the selected row, so screen readers follow the highlight.
    const follows = () => page.evaluate(() => {
      const p = document.activeElement;
      const sel = p.querySelector(':scope > .sel, :scope > .mrow button.sel');
      return p === document.querySelector('.mpanel:last-of-type') && !!sel && p.getAttribute('aria-activedescendant') === sel.id;
    });
    assert.equal(await follows(), true);
    await slowMotion(page);
    const hlY = sample(page, () => new DOMMatrix(getComputedStyle(document.querySelector('.mpanel .hl')).transform).f, 200);
    await key('ArrowDown');
    const ys = await hlY;
    assert.ok(new Set(ys.map(Math.round)).size > 2, `the highlight glides: ${ys.map(Math.round).join(',')}`);
    await slowMotion(page, 1);
    assert.equal(await selected(), 'New window');
    await key('s');
    assert.equal(await selected(), 'Save page as…');
    await key('s');
    assert.equal(await selected(), 'Save and share', 'the same letter again: the next one');
    await key('s');
    assert.equal(await selected(), 'Settings');
    await key('Enter');
    assert.deepEqual((await sent(page, 'overlay:menu')).at(-1), { id: id('Settings') });
    // Typing starts over after another key, from the row that's selected.
    await key('h');
    assert.equal(await selected(), 'Help');
    await key('h');
    assert.equal(await selected(), 'History');
    // A submenu slides out beside its row; Left goes back.
    await key('ArrowRight');
    assert.equal(await page.$$eval('.mpanel', (els) => els.length), 2);
    const sub = await page.$eval('.mpanel:last-of-type', (el) => ({ right: el.offsetLeft + el.offsetWidth, moving: el.getAnimations().length, text: el.textContent }));
    const main = await page.$eval('.mpanel', (el) => el.offsetLeft);
    assert.ok(sub.right <= main + 8, 'to the left: ⋮ is at the right edge');
    assert.equal(sub.moving, 1, 'it slides out');
    assert.match(sub.text, /History[\s\S]*Recently closed[\s\S]*News\s*⇧⌘T/);
    assert.equal(await selected(), 'History', 'its first row');
    assert.equal(await follows(), true, 'the submenu has the keyboard');
    assert.equal(await page.$eval('.mi.open', (el) => el.getAttribute('aria-expanded')), 'true');
    await key('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('.mpanel').length === 1);
    assert.equal(await selected(), 'History');
    assert.equal(await follows(), true, 'and back');
    // The zoom row: its buttons, and the number follows the page.
    const zoom = items.find((i) => i.type === 'zoom');
    await page.click('.mrow button[aria-label="Zoom in"]');
    assert.deepEqual((await sent(page, 'overlay:menu')).at(-1), { id: zoom.in });
    await send(page, { op: 'zoom', level: 110 });
    assert.equal(await page.textContent('.zoom-val'), '110%');
    // The pointer: a row with a submenu opens it after a moment, and moving into it keeps it.
    const center = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    const marks = items.findIndex((i) => i.label === 'Bookmarks and lists');
    await page.mouse.move(...await center(`.mi[data-i="${marks}"]`), { steps: 2 });
    await page.waitForFunction(() => document.querySelectorAll('.mpanel').length === 2);
    assert.match(await page.textContent('.mpanel:last-of-type'), /Bookmark this tab[\s\S]*Show bookmarks bar[\s\S]*A bookmark/);
    await page.mouse.move(...await center('.mpanel:last-of-type .mi[data-i="0"]'), { steps: 4 });
    await page.waitForTimeout(350);
    assert.equal(await page.$$eval('.mpanel', (els) => els.length), 2, 'still open');
    await key('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.mpanel').length === 1);
    await key('Escape');
    assert.deepEqual((await sent(page, 'overlay:menu')).at(-1), { close: true });
    // A click outside it closes it too.
    await page.mouse.click(200, 400);
    assert.deepEqual((await sent(page, 'overlay:menu')).at(-1), { close: true });
    // With the keyboard here (after a click in it), so do Tab and shortcuts
    // (a lone modifier doesn't).
    for (const k of ['Tab', 'Meta+t', 'Shift']) {
      const before = (await sent(page, 'overlay:menu')).length;
      await page.keyboard.press(k);
      assert.deepEqual((await sent(page, 'overlay:menu')).slice(before), k === 'Shift' ? [] : [{ close: true }], k);
    }
    // Readable in both appearances.
    const c = await readColors(page, { tokens: ['--text', '--muted'], parts: ['.mpanel'] });
    assert.ok(contrast(c.tokens['--text'], c.parts['.mpanel']) >= 7, `${colorScheme}: labels`);
    assert.ok(contrast(c.tokens['--muted'], c.parts['.mpanel']) >= 4.5, `${colorScheme}: shortcuts`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('the window: ⋮ on every platform opens the menu and sends it keys; popovers say where they grow from', { skip }, async () => {
  const answers = { 'omnibox:suggest': [{ type: 'search', title: 'git', url: 'https://s.example/?q=git' }, { type: 'history', title: 'GitHub', url: 'https://github.com/' }, { type: 'ai', title: 'git' }] };
  const { page, errors } = await openPage(browser, base, { init: { ...INIT, platform: 'darwin' }, answers });
  const btn = await page.$('#menu-btn');
  assert.equal(await btn.isVisible(), true, 'on the Mac too');
  const r = await btn.boundingBox();
  // The address bar keeps the keyboard (and what you typed) while the menu is open.
  await page.click('#address');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); // it selects what's there first
  await page.keyboard.type('hello');
  await btn.click();
  const [open] = await sent(page, 'app:menu');
  assert.deepEqual(open.anchor, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  assert.deepEqual(open.at, { right: Math.round(r.x + r.width), top: Math.round(r.y + r.height + 4) });
  assert.equal(open.keyboard, false);
  assert.equal(open.edit, true, 'Cut, Copy and Paste act on the address bar');
  assert.equal(await page.$eval('#menu-btn', (el) => el.getAttribute('aria-expanded')), 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('n');
  assert.deepEqual(await sent(page, 'overlay:key'), ['ArrowDown', 'n']);
  assert.equal(await page.inputValue('#address'), 'hello', 'the keys went to the menu');
  // Main closed it (a choice, a click outside it).
  await page.evaluate(() => window.__emit('overlay-state', { kind: 'menu', closed: true }));
  assert.equal(await page.$eval('#menu-btn', (el) => el.getAttribute('aria-expanded')), 'false');
  await page.keyboard.press('ArrowDown');
  assert.equal((await sent(page, 'overlay:key')).length, 2, 'keys stay here once it’s closed');
  // A shortcut closes it (and does what it does).
  await btn.click();
  await page.keyboard.press('Meta+l');
  assert.equal((await sent(page, 'overlay:hide')).at(-1), 'menu');
  assert.equal(await page.$eval('#menu-btn', (el) => el.getAttribute('aria-expanded')), 'false');
  assert.equal((await sent(page, 'overlay:key')).length, 2);
  // From the keyboard: its first row is ready. Tab closes it; so does resizing the window.
  await page.focus('#menu-btn');
  await page.keyboard.press('Enter');
  assert.equal((await sent(page, 'app:menu')).at(-1).keyboard, true);
  await page.keyboard.press('Tab');
  assert.equal((await sent(page, 'overlay:hide')).at(-1), 'menu');
  await page.focus('#menu-btn');
  await page.keyboard.press('Enter');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForFunction(() => window.__sent.filter(([c, k]) => c === 'overlay:hide' && k === 'menu').length === 3);

  // Popovers grow from their buttons.
  await page.click('#account-btn');
  const acc = (await sent(page, 'overlay:show')).at(-1).payload;
  const a = await page.$eval('#account-btn', (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  assert.equal(acc.kind, 'account');
  assert.deepEqual(acc.anchor, a);
  await page.evaluate(() => window.__emit('overlay-state', { kind: 'account', closed: true }));
  assert.equal(await page.$eval('#account-btn', (el) => el.classList.contains('open')), false);

  // Suggestions carry what you typed; the pointer's row is the one Enter opens.
  await page.fill('#address', '');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  await page.type('#address', 'git');
  await page.waitForFunction(() => window.__sent.some(([c, p]) => c === 'overlay:show' && p.payload.kind === 'suggest' && p.payload.query === 'git'));
  await page.evaluate(() => window.__emit('overlay-state', { kind: 'suggest', hover: 1 }));
  await page.keyboard.press('Enter');
  assert.equal((await sent(page, 'omnibox:open')).at(-1).url, 'https://github.com/');
  assert.deepEqual(errors, []);
  await page.close();
});
