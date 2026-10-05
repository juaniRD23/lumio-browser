// The AI panel in headless Chrome: saved chats open without motion, a
// streaming reply is drawn a block at a time, the chat follows new words only
// while you're at the bottom, and screen readers hear each answer once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CHROME, INIT, startServer, openPage } from './shell-page.mjs';

const skip = CHROME ? false : 'Google Chrome is not installed';
let browser, server, base;
test.before(async () => {
  if (skip) return;
  ({ server, base } = await startServer());
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); server?.close(); });

const PANEL = { ...INIT, panel: { open: true, width: 380 } };
const long = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ${'words '.repeat(30)}`).join('\n\n');
const CHAT = {
  id: 'c1',
  display: [
    { kind: 'user', text: 'First question' },
    { kind: 'step', id: 's1', label: 'Reading the page', icon: 'page', status: 'ok' },
    { kind: 'ai', text: long(12) },
    { kind: 'note', text: 'A note' },
  ],
};
const emit = (page, ch, payload) => page.evaluate(([c, p]) => window.__emit(c, p), [ch, payload]);
const frames = (page, n = 2) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

test('a saved chat opens at once; only new messages move in', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: PANEL, answers: { 'ai:chat': CHAT } });
  await emit(page, 'ai-open-chat', { id: 'c1' });
  await page.waitForSelector('#messages .msg.ai');
  const moving = await page.$$eval('#messages *', (els) => els.filter((e) => e.getAnimations().some((a) => a.playState === 'running')).map((e) => e.className));
  assert.deepEqual(moving, [], 'nothing from the history animates');
  const atBottom = await page.$eval('#messages', (m) => m.scrollHeight - m.scrollTop - m.clientHeight < 2);
  assert.equal(atBottom, true, 'it opens at the latest message');
  await emit(page, 'ai-event', { type: 'user', chatId: 'c1', text: 'Next' });
  const fresh = await page.$eval('#messages > .msg.user:last-of-type', (el) => el.getAnimations().length);
  assert.equal(fresh, 1, 'the new message rises in');
  assert.deepEqual(errors, []);
  await page.close();
});

test('streaming: finished blocks are drawn once, the chat sticks to the bottom unless you scroll up, one announcement per answer', { skip }, async () => {
  const { page, errors } = await openPage(browser, base, { init: PANEL, answers: { 'ai:chat': CHAT } });
  await emit(page, 'ai-open-chat', { id: 'c1' });
  await page.waitForSelector('#messages .msg.ai');
  await emit(page, 'ai-event', { type: 'user', chatId: 'c1', text: 'Tell me more' });
  await emit(page, 'ai-event', { type: 'start', chatId: 'c1' });
  await emit(page, 'ai-event', { type: 'text', chatId: 'c1', delta: 'First block.\n\n```js\nconst a = 1;\n\nconst b = 2;\n' });
  await page.waitForFunction(() => document.querySelector('.msg.ai.streaming p'));
  const first = await page.evaluateHandle(() => document.querySelector('.msg.ai.streaming p'));
  // A blank line inside an open code fence doesn't end the block.
  await page.waitForFunction(() => document.querySelector('.msg.ai.streaming pre'));
  await emit(page, 'ai-event', { type: 'text', chatId: 'c1', delta: '```\n\nThird **block**' });
  await page.waitForFunction(() => document.querySelector('.msg.ai.streaming strong'));
  assert.equal(await page.evaluate((p) => p.isConnected && document.querySelector('.msg.ai.streaming p') === p, first), true, 'the first block was not drawn again');
  assert.equal(await page.$$eval('.msg.ai.streaming pre', (els) => els.length), 1, 'the code block is whole');
  // Following: at the bottom, new words keep it at the bottom.
  for (let i = 0; i < 8; i++) await emit(page, 'ai-event', { type: 'text', chatId: 'c1', delta: `\n\nMore ${i} ${'text '.repeat(40)}` });
  await page.waitForTimeout(250);
  assert.equal(await page.$eval('#messages', (m) => m.scrollHeight - m.scrollTop - m.clientHeight < 2), true, 'it follows');
  assert.equal(await page.$eval('#jump-latest', (b) => b.classList.contains('show')), false);
  // Scrolled up to read: it stays put and offers the way back.
  await page.$eval('#messages', (m) => { m.scrollTop = 0; });
  await frames(page);
  for (let i = 0; i < 4; i++) await emit(page, 'ai-event', { type: 'text', chatId: 'c1', delta: `\n\nLater ${i} ${'text '.repeat(40)}` });
  await page.waitForTimeout(250);
  assert.equal(await page.$eval('#messages', (m) => m.scrollTop), 0, 'it stays where you are reading');
  assert.equal(await page.$eval('#jump-latest', (b) => b.classList.contains('show') && getComputedStyle(b).visibility), 'visible');
  assert.equal(await page.textContent('#ai-announce'), '', 'nothing announced while it streams');
  await page.click('#jump-latest');
  assert.equal(await page.$eval('#messages', (m) => m.scrollHeight - m.scrollTop - m.clientHeight < 2), true, 'Jump to latest goes to the end');
  assert.equal(await page.$eval('#jump-latest', (b) => b.classList.contains('show')), false);
  await emit(page, 'ai-event', { type: 'text_end', chatId: 'c1' });
  await emit(page, 'ai-event', { type: 'done', chatId: 'c1' });
  await emit(page, 'ai-event', { type: 'end', chatId: 'c1' });
  await frames(page);
  assert.match(await page.textContent('#ai-announce'), /^Lumio: First block\. .*Third block/);
  assert.equal(await page.$eval('#messages', (m) => m.getAttribute('aria-live')), null, 'the chat itself is not read word by word');
  assert.equal(await page.$$eval('.msg.ai', (els) => els.at(-1).querySelectorAll('pre .copy').length), 1, 'the finished answer gets its copy button');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a step’s spinner turns into its result', { skip }, async () => {
  const { page } = await openPage(browser, base, { init: PANEL, answers: { 'ai:chat': { id: 'c1', display: [] } } });
  await emit(page, 'ai-open-chat', { id: 'c1' });
  await emit(page, 'ai-event', { type: 'user', chatId: 'c1', text: 'Do it' });
  await emit(page, 'ai-event', { type: 'start', chatId: 'c1' });
  await emit(page, 'ai-event', { type: 'step', chatId: 'c1', id: 's9', name: 'click', label: 'Clicking', icon: 'page' });
  assert.equal(await page.$$eval('.step[data-id="s9"] .spinner', (e) => e.length), 1);
  await emit(page, 'ai-event', { type: 'step_done', chatId: 'c1', id: 's9', status: 'ok' });
  const anims = await page.$eval('.step[data-id="s9"] .s-state', (el) => el.querySelector('svg').getAnimations({ subtree: true }).map((a) => a.animationName));
  assert.ok(anims.includes('state-in') && anims.includes('draw'), `the check pops in and draws: ${anims}`);
  await page.close();
  // Reduce Motion: it's there at once.
  const rm = await openPage(browser, base, { init: PANEL, reducedMotion: 'reduce', answers: { 'ai:chat': { id: 'c1', display: [] } } });
  await emit(rm.page, 'ai-open-chat', { id: 'c1' });
  await emit(rm.page, 'ai-event', { type: 'user', chatId: 'c1', text: 'Do it' });
  const dur = await rm.page.$eval('#messages > .msg.user', (el) => el.getAnimations()[0]?.effect.getTiming().duration ?? 0);
  assert.ok(dur <= 1, `instant under Reduce Motion (${dur} ms)`);
  await rm.page.close();
});
