// Reading mode's article finder (main/reader.js: Mozilla's Readability) on
// real pages in headless Chrome: an article comes out clean, with absolute
// links and without the page's menus; the page itself isn't changed; and
// pages that aren't articles are recognized. Skipped without Google Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { EXTRACT, READERABLE_CHECK } = require('../main/reader.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const ARTICLE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'article.html'), 'utf8')
  .replace('<main>', '<nav class="menu"><a href="/">Home</a> <a href="/news">News</a> <a href="/sports">Sports</a></nav><main>')
  .replace('<h2>Keepers</h2>', '<h2>Keepers</h2><p><a href="/keepers/list">A list of keepers</a> and <img src="/img/keeper.jpg" alt="A keeper"> their stories.</p>');

let browser;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); });

async function load(body) {
  const page = await browser.newPage();
  await page.route('**/*', (r) => (r.request().resourceType() === 'document' ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }) : r.abort()));
  await page.goto('https://news.example/2026/lighthouses');
  return page;
}

test('finds the article, with absolute links and pictures, and leaves the page as it was', { skip }, async () => {
  const page = await load(ARTICLE);
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  assert.equal(await page.evaluate(READERABLE_CHECK), true);
  const a = await page.evaluate(EXTRACT);
  assert.equal(a.title, 'The Quiet History of Lighthouses');
  assert.equal(a.lang, 'en');
  assert.ok(a.length > 600, `length ${a.length}`);
  assert.match(a.content, /Pharos of Alexandria/);
  assert.match(a.content, /href="https:\/\/news\.example\/keepers\/list"/);
  assert.match(a.content, /src="https:\/\/news\.example\/img\/keeper\.jpg"/);
  assert.doesNotMatch(a.content, /Sports|<script|<style/);
  assert.equal(await page.evaluate(() => document.documentElement.outerHTML), before, 'the page isn’t changed');
  await page.close();
});

test('a page that isn’t an article is recognized', { skip }, async () => {
  const page = await load('<!doctype html><title>Shop</title><body><nav><a href="/">Home</a></nav><button>Add to cart</button><p>$40</p></body>');
  assert.equal(await page.evaluate(READERABLE_CHECK), false);
  const a = await page.evaluate(EXTRACT);
  assert.ok(!a || a.length < 200, 'nothing worth reading');
  await page.close();
});
