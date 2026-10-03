// web_search reads the search engine's results page out of sight: titles, real
// URLs (not the engine's redirect links) and snippets, plus answer boxes. The
// page script runs here on stand-in Google and Bing pages in headless Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scripts = require('../main/ai/tools/page-scripts.js');
const { formatResults, searchUrl, NAMES } = require('../main/ai/tools/web.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';

const GOOGLE = `<!doctype html><title>dario amodei net worth - Google Search</title><body>
<div id="rso">
  <div class="g"><div><a href="https://www.forbes.com/profile/dario-amodei/"><h3>Dario Amodei - Forbes</h3><cite>forbes.com › profile</cite></a></div>
    <div class="VwiC3b">Real-time net worth: Dario Amodei is worth $3.7B as of today. CEO and cofounder of Anthropic.</div></div>
  <div class="g"><div><a href="/url?q=https://en.wikipedia.org/wiki/Dario_Amodei&amp;sa=U"><h3>Dario Amodei - Wikipedia</h3></a></div>
    <div class="VwiC3b">Dario Amodei (born 1983) is an American AI researcher and entrepreneur.</div></div>
  <div class="g"><div><a href="https://www.google.com/search?q=dario+amodei+age"><h3>Dario Amodei age</h3></a></div></div>
</div>
<div id="rhs">Dario Amodei · CEO of Anthropic · Net worth: 3.7 billion USD (2026)</div></body>`;

const bingLink = (url) => `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(url).toString('base64url')}&ntb=1`;
const BING = `<!doctype html><title>Bing</title><body><ol id="b_results">
  <li class="b_algo"><h2><a href="${bingLink('https://www.businessinsider.com/elon-musk-net-worth')}">Elon Musk's net worth - Business Insider</a></h2><div class="b_caption"><p>Elon Musk is the richest person in the world, worth about $480 billion.</p></div></li>
  <li class="b_algo"><h2><a href="${bingLink('https://www.forbes.com/profile/elon-musk/')}">Elon Musk - Forbes</a></h2><div class="b_caption"><p>Founder of xAI, SpaceX and Tesla.</p></div></li>
</ol></body>`;

let browser;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); });

async function serpOf(url, html) {
  const page = await browser.newPage();
  await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  const out = await page.evaluate(`(${scripts.serp.toString()})({ max: 8 })`);
  await page.close();
  return out;
}

test('Google: results with real URLs and snippets, the knowledge panel, and no Google links', { skip }, async () => {
  const r = await serpOf('https://www.google.com/search?q=dario+amodei+net+worth', GOOGLE);
  assert.equal(r.engine, 'google.com');
  assert.deepEqual(r.results.map((x) => [x.title, x.url]), [
    ['Dario Amodei - Forbes', 'https://www.forbes.com/profile/dario-amodei/'],
    ['Dario Amodei - Wikipedia', 'https://en.wikipedia.org/wiki/Dario_Amodei'],
  ]);
  assert.match(r.results[0].snippet, /worth \$3\.7B/);
  assert.doesNotMatch(r.results[0].snippet, /born 1983/, 'only its own snippet');
  assert.match(r.side, /Net worth: 3\.7 billion/);
  const text = formatResults('dario amodei net worth', r);
  assert.match(text, /1\. Dario Amodei - Forbes\n {3}https:\/\/www\.forbes\.com\/profile\/dario-amodei\/\n {3}forbes\.com › profile Real-time net worth/);
  assert.match(text, /Side panel: Dario Amodei · CEO of Anthropic/);
});

test('Bing: its redirect links are turned back into the real addresses', { skip }, async () => {
  const r = await serpOf('https://www.bing.com/search?q=elon+musk+net+worth', BING);
  assert.deepEqual(r.results.map((x) => x.url), ['https://www.businessinsider.com/elon-musk-net-worth', 'https://www.forbes.com/profile/elon-musk/']);
  assert.match(r.results[0].snippet, /\$480 billion/);
});

test('a "confirm you’re a person" page is reported, not read as results', { skip }, async () => {
  const r = await serpOf('https://www.google.com/sorry/index?continue=x', '<p>Our systems have detected unusual traffic from your computer network.</p>');
  assert.equal(r.blocked, true);
});

test('searches use the person’s search engine; the tools are research-only', () => {
  assert.equal(searchUrl({ tabs: { searchTemplate: () => 'https://duckduckgo.com/?q=%s' } }, 'a & b'), 'https://duckduckgo.com/?q=a%20%26%20b');
  assert.equal(searchUrl({ tabs: {} }, 'x'), 'https://www.google.com/search?q=x');
  assert.deepEqual([...NAMES], ['web_search', 'read_url']);
});
