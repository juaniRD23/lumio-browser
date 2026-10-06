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

test('bookmarks: a tree of folders; the flat list from before folders becomes the Bookmarks bar', () => {
  // An older install: bookmarks.json is a flat list.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-store-'));
  const old = [
    { url: 'https://a.example/', title: 'A', time: 1000, favicon: 'https://a.example/f.ico' },
    { url: 'https://b.example/', title: 'B', time: 2000 },
  ];
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), JSON.stringify(old));
  const s = new Store(dir, null);
  assert.deepEqual(s.marks.root('bar').children.map(({ url, title, time, favicon }) => ({ url, title, time, ...(favicon ? { favicon } : {}) })), old);
  assert.deepEqual(s.bookmarks().map((b) => b.url), ['https://a.example/', 'https://b.example/']);
  assert.equal(s.isBookmarked('https://b.example/'), true);
  // Saved as the tree; the old file is left as it was.
  s.marks.addFolder('other', null, 'Work');
  s.bookmarksFile.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bookmarks.json'), 'utf8')).length, 2);
  const again = new Store(dir, null);
  assert.deepEqual(again.marks.root('other').children.map((f) => f.title), ['Work'], 'migrates only once');
  assert.equal(again.marks.root('bar').children.length, 2);
  // A flat import goes on the bar; one with folders keeps them.
  assert.equal(s.importBookmarks([{ url: 'https://a.example/', title: 'dup' }, { url: 'https://c.example/', title: 'C' }, { url: 'ftp://x/', title: 'no' }]), 1);
  assert.equal(s.importBookmarks({ other: [{ title: 'Recipes', children: [{ url: 'https://soup.example/', title: 'Soup' }] }] }), 1);
  assert.deepEqual(s.marks.root('other').children.map((f) => f.title), ['Work', 'Recipes']);
});

test('bookmarks bar: on by default, turned on once for older installs, then the person decides', () => {
  assert.equal(fresh().settings.showBookmarksBar, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-store-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ showBookmarksBar: false }));
  const s = new Store(dir, null);
  assert.equal(s.settings.showBookmarksBar, true, 'an older install gets the bar');
  s.setSetting('showBookmarksBar', false);
  s.settingsFile.flush();
  assert.equal(new Store(dir, null).settings.showBookmarksBar, false, 'turning it off sticks');
});

test('bookmarks learn their icon when the page is open', () => {
  const s = fresh();
  s.importBookmarks([{ url: 'https://youtube.com/', title: 'YouTube' }, { url: 'https://youtube.com/feed/library', title: 'Library' }, { url: 'https://news.example/', title: 'News' }]);
  let told = 0;
  s.onBookmarkIcons = () => told++;
  // youtube.com redirects to www.youtube.com: same site, so both YouTube bookmarks take the icon.
  s.updateFavicon('https://www.youtube.com/', 'https://www.youtube.com/favicon.ico');
  assert.deepEqual(s.bookmarks().map((b) => b.favicon || null), ['https://www.youtube.com/favicon.ico', 'https://www.youtube.com/favicon.ico', null]);
  assert.equal(told, 1);
  // The exact page's own icon wins over the site's; nothing changes, nobody is told.
  s.updateFavicon('https://youtube.com/feed/library', 'https://www.youtube.com/lib.png');
  assert.equal(s.bookmarks()[1].favicon, 'https://www.youtube.com/lib.png');
  assert.equal(s.bookmarks()[0].favicon, 'https://www.youtube.com/favicon.ico');
  s.updateFavicon('https://youtube.com/feed/library', 'https://www.youtube.com/lib.png');
  assert.equal(told, 2);
  // Icons in folders learn theirs too.
  const f = s.marks.addFolder('bar', null, 'News folder');
  s.marks.move([s.marks.byUrl('https://news.example/')[0].id], f.id, null);
  s.updateFavicon('https://news.example/', 'https://news.example/n.png');
  assert.equal(s.marks.get(f.id).children[0].favicon, 'https://news.example/n.png');
  assert.equal(told, 3);
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
  assert.equal(parseInput('chrome://flags').url, 'lumio://flags-lite/'); // Lumio's short list of experiments
  assert.equal(parseInput('chrome://gpu').isSearch, true);
});

test('a file that keeps changing is still written, at least every 2 s', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-store-wait-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = new Store(dir);
  const file = path.join(dir, 'session.json');
  const written = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).windows?.length : 0);
  // A change every 250 ms (a ticking title) would otherwise push the write back forever.
  for (let i = 1; i <= 12; i++) {
    store.saveSession(Array.from({ length: i }, () => ({ tabs: [{ url: 'https://a.example/' }] })));
    t.mock.timers.tick(250);
  }
  assert.ok(written() >= 8, `written while changes kept coming (${written()})`);
  t.mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});
