// Store: history, bookmarks, downloads and multi-window sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Store } = require('../main/store.js');
const { fromChromeTime, toChromeTime } = require('../main/importer/chromium.js');
const { parseInput } = require('../main/omnibox.js');

const fresh = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-store-')), null);
const DAY = 86400000;

test('history keeps 90 days and dedupes quick repeats', () => {
  const s = fresh();
  s.importHistory([
    { url: 'https://old.example/', title: 'Old', time: Date.now() - 100 * DAY },
    { url: 'https://recent.example/', title: 'Recent', time: Date.now() - 2 * DAY },
  ]);
  assert.deepEqual(s.history().map((h) => h.url), ['https://recent.example/']);
  s.addVisit('https://a.example/', 'A');
  s.addVisit('https://a.example/', 'A again');
  assert.equal(s.history().filter((h) => h.url === 'https://a.example/').length, 1);
  assert.equal(s.history().at(-1).title, 'A again');
  s.addVisit('lumio://settings/', 'Settings');
  assert.ok(!s.history().some((h) => h.url.startsWith('lumio:')));
});

test('history deletes single visits, URLs, whole sites and time ranges', () => {
  const s = fresh();
  const now = Date.now();
  s.importHistory([
    { url: 'https://www.news.example/1', title: 'n1', time: now - 3 * DAY },
    { url: 'https://news.example/2', title: 'n2', time: now - 2 * DAY },
    { url: 'https://shop.example/', title: 's1', time: now - 2 * DAY },
    { url: 'https://shop.example/', title: 's2', time: now - 1000 },
    { url: 'https://blog.example/', title: 'b', time: now - 500 },
  ]);
  assert.equal(s.deleteHistory({ entries: [{ url: 'https://shop.example/', time: now - 1000 }] }), 1);
  assert.equal(s.history().filter((h) => h.url === 'https://shop.example/').length, 1);
  assert.equal(s.deleteHistory({ host: 'news.example' }), 2, 'www. and bare host both count');
  assert.equal(s.deleteHistory({ from: now - 3600000 }), 1);
  assert.deepEqual(s.history().map((h) => h.title), ['s1']);
  assert.equal(s.deleteHistory({ urls: ['https://shop.example/'] }), 1);
  assert.equal(s.history().length, 0);
});

test('importing history twice adds nothing new', () => {
  const s = fresh();
  const entries = [{ url: 'https://x.example/', title: 'x', time: Date.now() - DAY }];
  assert.equal(s.importHistory(entries), 1);
  assert.equal(s.importHistory(entries), 0);
});

test('favicons are remembered per site for new visits', () => {
  const s = fresh();
  s.addVisit('https://site.example/a', 'A');
  s.updateFavicon('https://site.example/a', 'https://site.example/icon.png');
  s.addVisit('https://site.example/b', 'B');
  assert.equal(s.history().at(-1).favicon, 'https://site.example/icon.png');
  s.updateFavicon('https://site.example/b', 'javascript:alert(1)');
  assert.equal(s.history().at(-1).favicon, 'https://site.example/icon.png', 'only http(s) or data: images');
});

test('bookmarks: toggle, edit, move, import', () => {
  const s = fresh();
  assert.equal(s.toggleBookmark('https://a.example/', 'A', 'https://a.example/f.ico'), true);
  s.toggleBookmark('https://b.example/', 'B');
  assert.equal(s.bookmarks()[0].favicon, 'https://a.example/f.ico');
  assert.equal(s.updateBookmark('https://b.example/', { title: 'Bee', url: 'https://bee.example/' }), true);
  assert.equal(s.updateBookmark('https://bee.example/', { url: 'javascript:alert(1)' }), true);
  assert.equal(s.bookmarks()[1].url, 'https://bee.example/', 'rejects non-web URLs');
  s.moveBookmark('https://bee.example/', 0);
  assert.deepEqual(s.bookmarks().map((b) => b.title), ['Bee', 'A']);
  assert.equal(s.importBookmarks([{ url: 'https://a.example/', title: 'dup' }, { url: 'https://c.example/', title: 'C' }, { url: 'ftp://x/', title: 'no' }]), 1);
  assert.equal(s.toggleBookmark('https://a.example/'), false);
  assert.equal(s.isBookmarked('https://a.example/'), false);
});

test('sessions: several windows, and the old single-window format', () => {
  const s = fresh();
  s.saveSession([{ tabs: [{ url: 'https://1.example/' }], active: 0 }, { tabs: [], active: 0 }, { tabs: [{ url: 'https://2.example/', pinned: true }], active: 0 }]);
  assert.equal(s.sessionWindows().length, 2, 'empty windows are skipped');
  s.sessionFile.data = { tabs: [{ url: 'https://legacy.example/' }], active: 0 };
  assert.deepEqual(s.sessionWindows(), [{ tabs: [{ url: 'https://legacy.example/' }], active: 0 }]);
});

test('download history keeps running downloads when cleared', () => {
  const s = fresh();
  s.saveDownload({ id: 'a', name: 'a.zip', state: 'completed', time: Date.now() - DAY });
  s.saveDownload({ id: 'b', name: 'b.zip', state: 'progressing', time: Date.now() });
  s.saveDownload({ id: 'a', name: 'a.zip', state: 'completed', time: Date.now() - DAY, received: 5 });
  assert.equal(s.downloads().length, 2);
  s.clearDownloads();
  assert.deepEqual(s.downloads().map((d) => d.id), ['b']);
});

test('Chrome timestamps and chrome:// addresses', () => {
  const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(fromChromeTime((BigInt(ms) + 11644473600000n) * 1000n), ms);
  assert.equal(fromChromeTime(toChromeTime(ms)), ms);
  assert.equal(parseInput('chrome://extensions').url, 'lumio://extensions/');
  assert.equal(parseInput('chrome://settings/#import').url, 'lumio://settings/#import');
  assert.equal(parseInput('about:history').url, 'lumio://history/');
  assert.equal(parseInput('chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html').url, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html');
  assert.equal(parseInput('chrome://flags').isSearch, true);
});
