import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pageContext, allTabsContext, tabPdf, PRIVATE_PAGE } = require('../main/ai/tools/browser.js');

// A tab whose page answers Lumio's in-page scripts.
function tab(id, url, { text = '', video = null, asleep = false, pdf = false, title = `Tab ${id}` } = {}) {
  const wc = {
    getURL: () => url,
    getTitle: () => title,
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      const max = JSON.parse(code.slice(code.lastIndexOf('(') + 1, -1)).maxText ?? Infinity;
      if (code.startsWith('(async function youtube')) return video;
      return { title, url, text: text.slice(0, max), lines: [], meta: {} };
    },
  };
  return { id, title, favicon: null, pdf, discarded: asleep, view: asleep ? null : { webContents: wc } };
}
function tabSet(list) {
  return { tabs: list, active: list[0], displayUrl: (t) => (t.view ? t.view.webContents.getURL() : t.url) };
}

test('ask about my tabs reads every web tab and notes the ones it cannot', async () => {
  const sleeping = { ...tab(3, 'https://news.example/', { asleep: true }), url: 'https://news.example/' };
  const tabs = tabSet([
    tab(1, 'https://shop.example/a', { text: 'Shoes $40' }),
    tab(2, 'lumio://newtab'),
    sleeping,
    tab(4, 'https://docs.example/file.pdf', { pdf: true }),
  ]);
  const { tabs: read, skipped } = await allTabsContext(tabs);
  assert.equal(skipped, 0);
  assert.deepEqual(read.map((t) => t.tabId), [1, 3, 4], 'internal pages are left out');
  assert.equal(read[0].text, 'Shoes $40');
  assert.match(read[1].note, /asleep/);
  assert.match(read[2].note, /PDF/);
});

test('ask about my tabs splits the text budget between tabs', async () => {
  const long = 'x'.repeat(200_000);
  const tabs = tabSet(Array.from({ length: 6 }, (_, i) => tab(i + 1, `https://site${i}.example/`, { text: long })));
  const { tabs: read } = await allTabsContext(tabs);
  const total = read.reduce((n, t) => n + t.text.length, 0);
  assert.equal(read.length, 6);
  assert.ok(total <= 90_000, `total ${total}`);
  assert.ok(read.every((t) => t.text.length === 15_000));
});

test('a YouTube video is included with its transcript', async () => {
  const video = { id: 'abc', title: 'How bikes work', channel: 'Wheels', seconds: 125, description: 'All about gears.', transcript: '[0:01] Hi there\n[0:05] Gears!' };
  const tabs = tabSet([tab(1, 'https://www.youtube.com/watch?v=abc', { video, text: 'page chrome' })]);
  const page = await pageContext(tabs);
  assert.equal(page.video, true);
  assert.match(page.text, /YouTube video: How bikes work · by Wheels · 2:05 long/);
  assert.match(page.text, /Transcript:\n\[0:01\] Hi there/);
  assert.match(page.text, /Description:\nAll about gears\./);
});

test('a video without a transcript says so', async () => {
  const video = { id: 'abc', title: 'Silent film', channel: '', seconds: 0, description: '', transcript: '' };
  const page = await pageContext(tabSet([tab(1, 'https://www.youtube.com/watch?v=abc', { video })]));
  assert.match(page.text, /no transcript/);
});

test('tabPdf refuses tabs that are not PDFs', async () => {
  const got = await tabPdf(tabSet([tab(1, 'https://example.com/')]), null);
  assert.match(got.error, /isn’t showing a PDF/);
});

test('the AI keeps out of Lumio’s Settings, Extensions, Passwords, Version and Experiments pages', () => {
  for (const url of ['lumio://settings/', 'lumio://extensions/?id=abc', 'lumio://extensions/shortcuts', 'lumio://flags-lite/', 'LUMIO://passwords/', 'lumio://version/',
    'lumio://apps/', 'lumio://welcome/', 'lumio://downloads/', 'lumio://history/', 'lumio://bookmarks/']) { // (opening a flagged download, clearing or reading all history)
    assert.ok(PRIVATE_PAGE.test(url), url);
  }
  for (const url of ['lumio://newtab/', 'lumio://historyx/', 'lumio://settingsx/', 'https://example.com/lumio://settings']) {
    assert.ok(!PRIVATE_PAGE.test(url), url);
  }
});
