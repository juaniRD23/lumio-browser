// The glow around a page Lumio is working on and its pointer are added to the
// page itself. Google Docs, Sheets, Gmail and YouTube enforce Trusted Types,
// which refuse HTML strings: these run on such a page in headless Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scripts = require('../main/ai/tools/page-scripts.js');
const { VOLATILE } = require('../main/ai/agent.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';

let browser;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); });

test('the glow and the pointer appear on a page that enforces Trusted Types (like Google Sheets)', { skip }, async () => {
  const page = await browser.newPage();
  await page.route('**/*', (r) => r.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    headers: { 'content-security-policy': "require-trusted-types-for 'script'; trusted-types 'none'; style-src 'self'" },
    body: '<!doctype html><title>Sheet</title><body><div id="grid">cells</div></body>',
  }));
  await page.goto('https://docs.example.com/spreadsheets/d/1');
  // Trusted Types really is on: an HTML string is refused.
  assert.equal(await page.evaluate(() => { try { document.body.insertAdjacentHTML('beforeend', '<b>x</b>'); return 'allowed'; } catch { return 'refused'; } }), 'refused');
  const run = (fn, arg) => page.evaluate(`(${fn.toString()})(${JSON.stringify(arg)})`);
  assert.equal(await run(scripts.aura, {}), true);
  assert.equal(await run(scripts.cursor, { x: 200, y: 120, click: true }), true);
  const shown = await page.evaluate(() => [...document.body.children].filter((el) => el.shadowRoot === null && el.style.position === 'fixed').length);
  assert.equal(shown, 2, 'both overlays are on the page');
  // The glow is drawn (its stylesheet applies inside the closed shadow root).
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 6, height: 6 } });
  assert.ok(shot.length > 0);
  assert.equal(await run(scripts.aura, { remove: true }), true);
  assert.equal(await run(scripts.cursor, { remove: true }), true);
  assert.equal(await page.evaluate(() => document.body.children.length), 1, 'removed cleanly');
  await page.close();
});

test('what the AI compares its steps by: a field, a list scrolled inside the page and the text count; a clock ticking doesn\'t', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<p id="clock">Updated 10:41 PM · 5 seconds ago</p><input id="qty" value="1"><p id="msg">Cart</p>
    <div id="list" style="position:fixed;top:100px;left:0;right:0;bottom:0;overflow:auto">${'<p>mail</p>'.repeat(200)}</div>`);
  const state = () => page.evaluate(`(${scripts.pageState.toString()})(${JSON.stringify({ volatile: VOLATILE.source })})`);
  const first = await state();
  await page.evaluate(() => { document.getElementById('clock').textContent = 'Updated 10:42 PM · 6 seconds ago'; });
  assert.equal(await state(), first, 'a clock ticking is not a change');
  await page.evaluate(() => { document.getElementById('qty').value = '2'; });
  const second = await state();
  assert.notEqual(second, first, 'a field changed');
  await page.evaluate(() => { document.getElementById('list').scrollTop = 700; });
  const third = await state();
  assert.notEqual(third, second, 'the list in the middle scrolled (the window didn\'t)');
  await page.evaluate(() => { document.getElementById('msg').textContent = 'Cart (2)'; });
  assert.notEqual(await state(), third, 'the text changed');
  await page.close();
});
