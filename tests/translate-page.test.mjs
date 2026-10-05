// The in-page part of translation (main/translate-page.js), on a real page in
// headless Chrome: it hands out what's on screen in batches (a paragraph's
// pieces together), never code, inputs or "don't translate" text; swaps
// translations into the text itself so links and inputs stay as they were;
// follows scrolling and new content; and puts the original back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { translatePage, languageSample } = require('../main/translate-page.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Phares</title></head><body>
<nav><a href="/accueil">Accueil</a> <a href="/actualites">Actualités</a></nav>
<h1>L’histoire tranquille des phares</h1>
<p id="p1">Les phares guident les navires depuis <a id="l1" href="https://example.com/pharos">plus de deux mille ans</a>. Le phare d’Alexandrie mesurait plus de cent mètres.</p>
<p>Recherchez : <input id="q" value="phare" placeholder="Rechercher"> <button id="b">Envoyer</button></p>
<textarea id="t">Ne traduisez pas ceci</textarea>
<pre><code>const phare = 1;</code></pre>
<p translate="no">Marque Déposée</p>
<p class="notranslate">Lumière SA</p>
<div style="height: 3000px"></div>
<p id="far">Ce paragraphe est tout en bas de la page.</p>
</body></html>`;

let browser;
before(async () => {
  if (!CHROME) return;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); });

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
  await page.goto('https://phares.example/');
  const run = (cmd, arg = {}) => page.evaluate(`(${translatePage})(${JSON.stringify(cmd)}, ${JSON.stringify(arg)})`);
  // Answers a batch like the server would: every piece "translated".
  const translateBatch = async (batch) => run('apply', { results: batch.blocks.map((b) => ({ id: b.id, texts: b.texts.map((t) => `[EN] ${t}`) })) });
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
  return { page, run, translateBatch, frame };
}

test('the language sample skips code, inputs and text marked not to translate', { skip }, async () => {
  const { page } = await openPage();
  const s = await page.evaluate(`(${languageSample})()`);
  assert.equal(s.htmlLang, 'fr');
  assert.match(s.sample, /Les phares guident les navires/);
  assert.doesNotMatch(s.sample, /const phare|Ne traduisez|Marque Déposée|Lumière SA/);
  await page.close();
});

test('translates what’s on screen in place, keeping links and inputs, and puts the original back', { skip }, async () => {
  const { page, run, translateBatch, frame } = await openPage();
  const linkBefore = await page.$eval('#l1', (a) => { window.__link = a; return a.outerHTML; });
  await run('start', { maxPageChars: 100_000 });
  await frame();
  const batch = await run('collect', { maxChars: 3500 });
  const texts = batch.blocks.map((b) => b.texts);
  assert.deepEqual(texts, [
    ['Accueil', 'Actualités'],
    ['L’histoire tranquille des phares'],
    ['Les phares guident les navires depuis', 'plus de deux mille ans', '. Le phare d’Alexandrie mesurait plus de cent mètres.'],
    ['Recherchez :'],
    ['Envoyer'],
  ], 'a paragraph’s pieces together, in page order; nothing from code, inputs, “translate=no” or far below');
  await translateBatch(batch);
  // The text changed in place: same link element and address, same input, same spacing.
  assert.equal(await page.$eval('#p1', (p) => p.textContent), '[EN] Les phares guident les navires depuis [EN] plus de deux mille ans[EN] . Le phare d’Alexandrie mesurait plus de cent mètres.');
  assert.deepEqual(await page.$eval('#l1', (a) => [a === window.__link, a.getAttribute('href'), a.textContent]), [true, 'https://example.com/pharos', '[EN] plus de deux mille ans']);
  assert.deepEqual(await page.$eval('#q', (i) => [i.value, i.placeholder]), ['phare', 'Rechercher']);
  assert.equal(await page.$eval('#t', (t) => t.value), 'Ne traduisez pas ceci');
  assert.equal(await page.$eval('pre', (p) => p.textContent), 'const phare = 1;');
  assert.equal((await run('collect')).blocks.length, 0, 'nothing new until the page scrolls');

  // Scrolling brings the rest; new content is picked up too.
  await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); const p = document.createElement('p'); p.textContent = 'Un nouveau paragraphe arrive.'; document.body.append(p); });
  await frame();
  await frame();
  const more = await run('collect');
  assert.deepEqual(more.blocks.map((b) => b.texts), [['Ce paragraphe est tout en bas de la page.'], ['Un nouveau paragraphe arrive.']]);
  await translateBatch(more);
  assert.equal(await page.$eval('#far', (p) => p.textContent), '[EN] Ce paragraphe est tout en bas de la page.');

  // The page rewrites a translated piece: that piece is new text, sent again on its own.
  await page.evaluate(() => { document.getElementById('p1').firstChild.data = 'Texte changé par la page '; window.scrollTo(0, 0); });
  await frame();
  await frame();
  assert.deepEqual((await run('collect')).blocks.map((b) => b.texts), [['Texte changé par la page']]);

  // Show original: the page's own text, link untouched.
  await run('restore');
  assert.equal(await page.$eval('#l1', (a) => a.outerHTML), linkBefore);
  assert.equal(await page.$eval('h1', (h) => h.textContent), 'L’histoire tranquille des phares');
  assert.equal(await page.$eval('nav', (n) => n.textContent), 'Accueil Actualités');
  // Translate again: what was translated shows right away, without asking again.
  await run('start');
  assert.equal(await page.$eval('h1', (h) => h.textContent), '[EN] L’histoire tranquille des phares');
  // Another language: everything is asked for again.
  await run('reset');
  assert.equal(await page.$eval('h1', (h) => h.textContent), 'L’histoire tranquille des phares');
  await run('start');
  await frame();
  assert.ok((await run('collect')).blocks.some((b) => b.texts[0] === 'L’histoire tranquille des phares'));
  await page.close();
});

test('a batch stays small, a failed batch can be sent again, and a page has a limit', { skip }, async () => {
  const { page, run, frame } = await openPage();
  await run('start', { maxPageChars: 60 });
  await frame();
  const small = await run('collect', { maxChars: 50 });
  assert.deepEqual(small.blocks.map((b) => b.texts), [['Accueil', 'Actualités'], ['L’histoire tranquille des phares']]);
  // The server failed: the same text can go again.
  await run('release', { ids: small.blocks.map((b) => b.id) });
  const again = await run('collect', { maxChars: 50 });
  assert.deepEqual(again.blocks.map((b) => b.texts), small.blocks.map((b) => b.texts));
  // 60 characters for this page: the next batch stops there.
  const last = await run('collect', { maxChars: 4000 });
  assert.equal(last.capped, true);
  assert.equal((await run('collect')).blocks.length, 0);
  await page.close();
});
