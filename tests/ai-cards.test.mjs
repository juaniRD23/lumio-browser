// Card numbers never reach Lumio AI: the page snapshot it reads says a card
// field is filled without its digits, and its screenshots show dots there
// (the person sees the number again right after). In headless Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scripts = require('../main/ai/tools/page-scripts.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';

let browser;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); });

test('snapshots and screenshots for the AI keep card numbers and security codes out', { skip }, async () => {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <label>Name on card <input id="name" value="Sam Tester"></label>
    <label>Card number <input id="num" name="cardnumber" value="4242 4242 4242 4242"></label>
    <label>CVC <input id="cvc" autocomplete="cc-csc" value="737"></label>
    <label>Notes <input id="notes" value="5555555555554444"></label>
    <label>Order <input id="order" value="1234567890123"></label>
  </form>`);
  const run = (fn, arg) => page.evaluate(`(${fn.toString()})(${JSON.stringify(arg)})`);
  const snap = await run(scripts.snapshot, {});
  const text = JSON.stringify(snap);
  for (const secret of ['4242', '737', '5555555555554444']) assert.ok(!text.includes(secret), `${secret} isn't in the snapshot`);
  assert.match(text, /Card number\\" \(filled\)/);
  assert.match(text, /value=\\"Sam Tester\\"/, 'other fields still show their values');
  assert.match(text, /value=\\"1234567890123\\"/, 'a long number that isn’t a card still shows');
  // Screenshots: dots while Lumio captures, then back as they were.
  await page.$eval('#cvc', (el) => el.style.setProperty('-webkit-text-security', 'square')); // the page's own style comes back after
  assert.equal(await run(scripts.maskCards, { on: true }), 3, 'the card number, the security code, and the card number typed in Notes');
  const masked = await page.$$eval('input', (els) => els.map((e) => getComputedStyle(e).webkitTextSecurity));
  assert.deepEqual(masked, ['none', 'disc', 'disc', 'disc', 'none']);
  await run(scripts.maskCards, { on: false });
  assert.deepEqual(await page.$$eval('input', (els) => els.map((e) => e.style.cssText)), ['', '', '-webkit-text-security: square;', '', '']);
  await page.close();
});
